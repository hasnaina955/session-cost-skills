#!/usr/bin/env node
// Token usage and Cline-recorded cost for local Cline sessions.
// See ../references/storage.md for ledger semantics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fetchClineAccount, resolveClineCredential, summarizeClineAccount } from './lib/cline-account.mjs';
import { writeDashboard } from './lib/dashboard.mjs';
import {
  SCHEMA_VERSION,
  addUsage,
  classifyBilling,
  combineMetrics,
  coverage,
  emptyMetrics,
  num,
  resolveSession,
  usageSummary,
} from './lib/session-cost-core.mjs';
import { collectSessionIds, createSessionGraph, selectTopLevelCandidates } from './lib/session-graph.mjs';
import { REPORT_CONTRACT_VERSION, withNormalizedContract } from './lib/report-contract.mjs';
import { formatVersionBanner, versionBanner } from './lib/skill-version.mjs';
import { CliUsageError, parseCliArgs } from './lib/cli-args.mjs';
import { describeStorageError } from './lib/error-boundaries.mjs';
import { renderExplanation } from './lib/explain.mjs';
import { renderRankingText as renderRanking, renderRollupText as renderRollup } from './lib/rollup.mjs';
import { renderCsv } from './lib/csv.mjs';
import { evaluateBudget } from './lib/budget.mjs';
import { counterfactualCost, renderCounterfactualText } from './lib/counterfactual.mjs';
import { createLiveSurface, nextInterval, renderLiveFrame } from './lib/live-view.mjs';
import { detectConfiguredProvider } from './lib/provider-driver.mjs';
import { discoverModels, doctorReport, explainModelMatch, renderDiagnostics } from './lib/provider-diagnostics.mjs';
import { importConfig, initConfig, loadEffectiveConfig, publicConfigResult, readConfigFile } from './lib/config.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(SCRIPT_DIR, '..', '..', '..');
const DEFAULT_OPTIONS = Object.freeze({
  session: null,
  mode: 'current',
  list: 0,
  json: false,
  includeChildren: false,
  includeChildrenExplicit: false,
  dataDir: null,
  configPath: null,
  from: null,
  to: null,
  provider: null,
  model: null,
  account: false,
  accountUserId: null,
  accountDays: 45,
  dashboard: false,
  out: null,
  sessionConfigPath: null,
  configAction: null,
  configImportPath: null,
  diagnostic: null,
});

function parseArgs(argv) {
  let options;
  try {
    options = parseCliArgs(argv, { runtimeId: 'cline', defaults: DEFAULT_OPTIONS });
  } catch (error) {
    if (error instanceof CliUsageError) die(error.message);
    throw error;
  }
  options.includeChildrenExplicit = options.includeChildren === true;
  if (options.help) { help(); process.exit(0); }
  if (options.version) { console.log(formatVersionBanner(versionBanner('cline'))); process.exit(0); }
  return options;
}

const opts = parseArgs(process.argv.slice(2));
// Capture points for --watch: in quiet mode the CLI suppresses printing and records the
// report so the live loop can render it, instead of spawning the CLI once per tick.
let lastReport = null;
let quiet = false;

let effectiveConfiguration = null;

const CONTRACT_RUNTIME = Object.freeze({
  id: 'cline',
  costBasis: 'runtime-recorded',
  storageSource: 'data/db/sessions.db and session message records',
  inputTokenMeaning: 'includes-cache',
  reasoningIncludedInOutput: 'not-reported',
  provenanceKind: 'runtime-ledger',
  provenanceSource: 'Cline sessions.db/messages',
  rateSources: [],
});

function normalizeClineReport(report, selection = null) {
  return withNormalizedContract(report, { runtime: CONTRACT_RUNTIME, selection });
}


function help() {
  console.log(`session-cost — token usage and Cline-recorded cost

  --session <id>       session id (default: auto-detect current Cline session)
  --account            fetch read-only Cline account balance/plan/usage summary
  --account-user-id    optional account id override (must match authenticated profile)
  --account-days <n>   recent-history window for account stats (default 45)
  --dashboard            write a self-contained HTML dashboard
  --out <path>           dashboard output path
  --last               report the latest completed session
  --today              report sessions started today (UTC)
  --compare            compare the latest two sessions
  --from <YYYY-MM-DD>  include sessions on/after this UTC date
  --to <YYYY-MM-DD>    include sessions on/before this UTC date
  --provider <name>    filter sessions by provider
  --model <name>       filter sessions by model substring
  --config <path>      load standing-summary settings
  --session-config <path> load provider/session configuration
  --init-config        create a safe project config template
  --validate-config    validate and print effective configuration
  --export-config      print the effective configuration
  --import-config <path> validate and import a config file
  --include-children  include all descendant subagent sessions
  --list [n]           list the n most recent sessions (default 10)
  --rollup <when>      with --list, total spend per day or per week
  --top <n>            with --list, rank sessions by cost, most expensive first
  --explain            show the arithmetic behind the reported cost
  --csv                emit CSV, one row per session
  --budget <amount>    warn and exit non-zero when a session passes this amount
  --counterfactual <m> estimate what this session would cost on model <m>
  --watch              repaint a live view until Ctrl-C (foreground only)
  --watch-interval <ms> idle poll interval (default 3000; active is 500)
  --json              emit schema-versioned JSON
  --data-dir <path>    Cline data directory (default: %USERPROFILE%\\.cline)
  --version           print the installed skill, report-contract, and Node versions
  doctor | --doctor       inspect config, providers, and detected coverage
  providers | --providers list configured/built-in provider drivers
  models discover | --models-discover   list configured model mappings
  config explain | --config-explain    explain provider/model resolution`);
}
function handleConfigAction(configuration) {
  if (!opts.configAction) return false;
  const target = path.resolve(opts.sessionConfigPath ?? configuration.paths.project);
  let actionResult = null;
  if (opts.configAction === 'init') actionResult = initConfig(target);
  else if (opts.configAction === 'import') {
    if (!opts.configImportPath) die('--import-config requires a path');
    actionResult = importConfig(path.resolve(opts.configImportPath), target);
  } else if (opts.configAction === 'validate') {
    const loaded = readConfigFile(target);
    if (!loaded) die(`config not found: ${target}`);
    actionResult = { path: target, config: loaded.config };
  } else if (opts.configAction === 'export') actionResult = { path: target, config: configuration.config };
  console.log(JSON.stringify({
    schemaVersion: 1,
    action: opts.configAction,
    result: actionResult,
    configuration: { ...publicConfigResult(configuration), config: actionResult?.config ?? configuration.config },
  }, null, 2));
  return true;
}

function runDiagnostic(configuration) {
  let report;
  let status = 0;
  const knownModels = Object.fromEntries((configuration?.config?.providers ?? []).map((provider) => [provider.id, [
    ...new Set([
      ...(provider.rateCards ?? []).map((card) => card.model),
      ...(provider.importedRateRecords ?? []).map((record) => record.model),
    ]),
  ]]));
  const allKnownModels = [...new Set(Object.values(knownModels).flat())];
  if (opts.diagnostic === 'providers') {
    report = { action: 'providers', providers: doctorReport({ configuration, runtimeId: 'cline' }).providers };
  } else if (opts.diagnostic === 'models') {
    report = { action: 'models', models: discoverModels({ configuration, runtimeId: 'cline', providerId: opts.provider, knownModels }) };
  } else {
    const explanation = opts.provider || opts.model
      ? explainModelMatch({ runtimeId: 'cline', providerId: opts.provider, modelId: opts.model, configuration, knownModelIds: allKnownModels, rateRecords: [] })
      : null;
    report = { action: opts.diagnostic, ...doctorReport({ configuration, runtimeId: 'cline', providerId: opts.provider, modelId: opts.model }), explanation };
    if (explanation?.status === 'unknown' || explanation?.status === 'ambiguous') status = 2;
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderDiagnostics(report));
  return status;
}

function die(message) { console.error(`session-cost: ${message}`); process.exit(2); }
function integer(value) { return Math.round(num(value)).toLocaleString('en-US'); }
function usd(value) { return `$${num(value).toFixed(6)}`; }
function millions(value) { return `${(num(value) / 1_000_000).toFixed(4)} M`; }
function clip(value, length = 52) { const s = String(value ?? ''); return s.length <= length ? s : `${s.slice(0, length - 1)}…`; }
function safeJson(value) { try { return JSON.parse(value || '{}'); } catch { return {}; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function replacer(_key, value) { return value instanceof Map ? Object.fromEntries(value) : value; }
function ancestorPids() {
  const platform = process.platform;
  const command = platform === 'win32'
    ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$pidValue=$PID; $out=@(); for($i=0;$i -lt 16 -and $pidValue;$i++){ $p=Get-CimInstance Win32_Process -Filter "ProcessId=$pidValue" -ErrorAction SilentlyContinue; if(-not $p){break}; $out += [int]$p.ProcessId; $out += [int]$p.ParentProcessId; $pidValue=$p.ParentProcessId }; $out | ConvertTo-Json -Compress`]]
    : ['sh', ['-c', `p=$$; for i in $(seq 1 16); do [ -z "$p" ] && break; cat /proc/$p/stat 2>/dev/null | awk '{print $1" "$4}'; p=$(cat /proc/$p/stat 2>/dev/null | awk '{print $4}'); [ "$p" = "1" ] && break; done`]];
  try {
    const output = execFileSync(command[0], command[1], { encoding: 'utf8', windowsHide: true, timeout: 3000 });
    return output.match(/\d+/g)?.map(Number) ?? [];
  } catch { return []; }
}
function logSessionId(dataDir) {
  const logPath = path.join(dataDir, 'data', 'logs', 'cline.log');
  try {
    const lines = fs.readFileSync(logPath, 'utf8').split(/\r?\n/).filter(Boolean).slice(-1000);
    for (let index = lines.length - 1; index >= 0; index--) {
      try {
        const event = JSON.parse(lines[index]);
        if (event?.event === 'task.tool_used' && event.properties?.ulid) return event.properties.ulid;
      } catch { /* Ignore partial/corrupt log lines. */ }
    }
  } catch { /* Logs are an optional discovery signal. */ }
  return null;
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function fromAggregate(metadata, row) {
  const usage = metadata.aggregateUsage ?? metadata.usage ?? null;
  const storedTotalCost = finiteOrNull(metadata.totalCost);
  const hasUsage = usage && typeof usage === 'object';
  if (!hasUsage && storedTotalCost === null) return null;

  const result = {
    ...emptyMetrics(),
    callCountKnown: false,
    source: 'aggregate',
    storedTotalCost,
    cost: storedTotalCost ?? 0,
  };
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) {
    result[field] = finiteOrNull(usage?.[field]) ?? 0;
  }
  result.lastTs = Date.parse(row.updated_at ?? row.started_at ?? '') || Date.parse(row.ended_at ?? '') || 0;
  const provider = row.provider ?? 'unknown';
  const model = row.model ?? 'unknown';
  const group = {
    provider,
    model,
    ...emptyMetrics(),
    callCountKnown: false,
    inputTokens: result.inputTokens,
    outputTokens: result.outputTokens,
    cacheReadTokens: result.cacheReadTokens,
    cacheWriteTokens: result.cacheWriteTokens,
  };
  result.models.set(`${provider}|${model}`, group);
  return result;
}
function rowMetrics(row) {
  const metadata = safeJson(row.metadata_json);
  let result = emptyMetrics();
  let source = 'messages';
  if (row.messages_path && fs.existsSync(row.messages_path)) {
    const data = readJson(row.messages_path);
    for (const message of data?.messages ?? []) {
      if (message.role === 'assistant' && message.metrics) {
        addUsage(result, { ...message.metrics, ts: message.ts }, message.modelInfo);
      }
    }
  }
  if (!result.calls) {
    const aggregate = fromAggregate(metadata, row);
    if (aggregate) return { ...aggregate, title: metadata.title ?? row.prompt ?? '' };
    return { ...result, source: 'none', title: metadata.title ?? row.prompt ?? '' };
  }
  return { ...result, source, title: metadata.title ?? row.prompt ?? '', storedTotalCost: finiteOrNull(metadata.totalCost) };
}

function costState(metrics) {
  if (metrics.callCountKnown === false) return { label: metrics.cost > 0 ? usd(metrics.cost) : 'not recorded', note: 'aggregate call count unavailable' };
  if (!metrics.calls) return { label: usd(0), note: 'no calls' };
  if (metrics.unpricedCalls === 0) return { label: usd(metrics.cost), note: 'complete' };
  if (metrics.pricedCalls === 0) return { label: 'not recorded', note: `0/${metrics.calls} calls have cost` };
  return { label: usd(metrics.cost), note: `partial; ${metrics.unpricedCalls}/${metrics.calls} calls lack cost` };
}
function reportFor(row, all, graph, includeChildren, selection = null) {
  const ids = collectSessionIds([row.session_id], graph, { includeChildren });
  const descendants = graph.descendants(row.session_id);
  const excludedSessionIds = [...descendants].filter((id) => !ids.has(id));
  const chosen = all.filter((item) => ids.has(item.session_id));
  const sessions = chosen.map((item) => ({
    row: {
      sessionId: item.session_id,
      parentSessionId: item.parent_session_id,
      status: item.status,
      startedAt: item.started_at,
      endedAt: item.ended_at,
    },
    metrics: rowMetrics(item),
  }));
  const missingChildren = sessions.filter((item) => (
    !item.metrics.calls
    && item.row.sessionId !== row.session_id
    && item.metrics.callCountKnown !== false
  ));
  const rootMetrics = sessions[0]?.metrics ?? emptyMetrics();
  const total = emptyMetrics();
  const warnings = [];
  let totalSource;
  let usageScope;
  let aggregateFallback = null;

  if (rootMetrics.callCountKnown === false) {
    combineMetrics(total, rootMetrics);
    totalSource = 'root-aggregate';
    usageScope = 'end-to-end';
    aggregateFallback = {
      used: true,
      source: 'metadata.aggregateUsage',
      callCountKnown: false,
      storedTotalCostUsd: finiteOrNull(rootMetrics.storedTotalCost),
    };
    if (excludedSessionIds.length) {
      warnings.push('Aggregate usage already includes descendant sessions even though descendants are excluded from this selection.');
    }
  } else {
    for (const session of sessions) combineMetrics(total, session.metrics);
    usageScope = includeChildren ? 'included-sessions' : 'root-only';
    totalSource = 'messages';
    if (includeChildren && missingChildren.length) {
      total.callCountKnown = false;
      totalSource = 'partial-messages';
      warnings.push(`${missingChildren.length} descendant session(s) have no reconstructable usage; totals are incomplete.`);
    }
  }

  return normalizeClineReport({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshot: reportStatus(row),
    session: {
      id: row.session_id,
      title: rootMetrics.title,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    },
    providerDriver: detectConfiguredProvider(row.provider, effectiveConfiguration?.config, 'cline'),
    configuration: effectiveConfiguration,
    selection: null,
    usage: usageSummary(total),
    billing: classifyBilling(total),
    includedSessionIds: chosen.map((item) => item.session_id),
    excludedSessionIds,
    duplicateSuppressedSessionIds: [],
    childSessionIds: chosen.filter((item) => item.session_id !== row.session_id).map((item) => item.session_id),
    missingChildSessionIds: missingChildren.map((item) => item.row.sessionId),
    sessions,
    total,
    totalSource,
    usageScope,
    rootCallCountKnown: rootMetrics.callCountKnown !== false,
    aggregateFallback,
    warnings,
    provenance: {
      kind: aggregateFallback ? 'runtime-aggregate' : 'runtime-ledger',
      source: aggregateFallback ? 'Cline metadata.aggregateUsage' : 'Cline session messages',
      callCountKnown: total.callCountKnown !== false,
      rateSources: [],
    },
    includedChildren: includeChildren,
  }, selection);
}
function reportStatus(row) {
  const active = ['idle', 'running', 'pending'].includes(String(row.status ?? '').toLowerCase());
  return {
    capturedAt: new Date().toISOString(),
    active,
    state: active ? 'snapshot' : 'final',
    lastLedgerActivityAt: row.updated_at ?? row.ended_at ?? row.started_at ?? null,
  };
}
function freshness(report) {
  if (!report.snapshot.active) return 'final';
  const time = report.total.lastTs || Date.parse(report.session.startedAt);
  return Number.isFinite(time) ? `snapshot ${new Date(time).toISOString()}` : 'snapshot';
}
function render(report) {
  const t = report.total;
  const u = report.usage;
  const billing = report.billing;
  const cost = costState(t);
  const childRows = report.sessions.filter((item) => item.row.sessionId !== report.session.id);
  const lines = [
    'Session Cost — Cline',
    `Session: ${report.session.id}`,
    `Title: ${clip(report.session.title || '(untitled)', 80)}`,
    `Status: ${report.session.status} (${freshness(report)})`,
    `Usage scope: ${report.usageScope ?? 'included sessions'}`,
    ...(report.warnings ?? []).map((warning) => `Warning: ${warning}`),
    ...(report.providerDriver ? [`Provider driver: ${report.providerDriver.id}@${report.providerDriver.version} (${report.providerDriver.fingerprint})`] : []),
    ...(report.selection?.method ? [`Selection: ${report.selection.method}${report.selection.requestedId ? ` (${report.selection.requestedId})` : ''}`] : []),
    ...(report.selection?.warning ? [`Selection warning: ${report.selection.warning}`] : []),
    ...(report.selection?.candidateIds?.length ? [`Selection candidates: ${report.selection.candidateIds.join(', ')}`] : []),
    `Calls: ${integer(t.calls)} across ${t.models.size} model(s)`,
    `Billing: ${billing.label} — ${billing.evidence}`,
    '',
    'Token totals:',
    `  Total: ${integer(u.totalTokens)} (${millions(u.totalTokens)})`,
    `  Input: ${integer(u.inputTokens)} (${millions(u.inputTokens)}, includes cache)`,
    `  Fresh input: ${integer(u.freshInputTokens)} (${millions(u.freshInputTokens)})`,
    `  Cached read: ${integer(u.cacheReadTokens)} (${millions(u.cacheReadTokens)})`,
    `  Cache write: ${integer(u.cacheWriteTokens)} (${millions(u.cacheWriteTokens)})`,
    `  Output: ${integer(u.outputTokens)} (${millions(u.outputTokens)})`,
    `Cache-hit rate: ${(u.cacheHitRate * 100).toFixed(1)}%`,
    `Recorded cost: ${cost.label} (${cost.note})`,
    `Cost coverage: ${billing.coverage}`,
    '',
    'By model:',
  ];
  for (const model of [...t.models.values()].sort((a, b) => b.calls - a.calls)) {
    const state = costState(model);
    lines.push(`  ${model.provider}/${model.model}: ${integer(model.calls)} calls, ${millions(model.inputTokens + model.outputTokens)} tokens, ${state.label}`);
  }
  if (report.includedChildren) {
    lines.push('', `Included subagent sessions: ${childRows.length}`);
    for (const item of childRows) lines.push(`  + ${item.row.sessionId} — ${clip(item.metrics.title || 'untitled', 55)}`);
    if (report.missingChildSessionIds.length) {
      lines.push(`Aggregate fallback: ${report.missingChildSessionIds.length} child session(s) have no local call ledger; headline totals use the root's Cline aggregateUsage.`);
    }
  } else if (report.excludedSessionIds.length) {
    lines.push('', `Excluded subagent sessions: ${report.excludedSessionIds.length}`, ...report.excludedSessionIds.map((id) => `  - ${id}`), 'Use --include-children for an end-to-end task total.');
  }
  if (report.duplicateSuppressedSessionIds.length) {
    lines.push('', `Duplicate-suppressed session selections: ${report.duplicateSuppressedSessionIds.join(', ')}`);
  }
  return lines.join('\n');
}

function parseDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) die(`invalid date ${value}; expected YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(parsed) || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) {
    die(`invalid calendar date ${value}; expected YYYY-MM-DD`);
  }
  return parsed;
}
function loadConfig(dataDir) {
  const configPath = path.resolve(opts.configPath ?? path.join(dataDir, 'session-cost.json'));
  if (!fs.existsSync(configPath)) return { path: configPath, values: {} };
  const values = readJson(configPath);
  if (!values || typeof values !== 'object') die(`invalid config JSON: ${configPath}`);
  if (!opts.includeChildrenExplicit && values.includeChildren === true) opts.includeChildren = true;
  return { path: configPath, values };
}
function filterRows(rows) {
  const from = opts.from ? parseDate(opts.from) : null;
  const to = opts.to ? parseDate(opts.to, true) : null;
  return rows.filter((row) => {
    const started = Date.parse(row.started_at);
    if (from !== null && started < from) return false;
    if (to !== null && started > to) return false;
    if (opts.provider && String(row.provider ?? '').toLowerCase() !== opts.provider.toLowerCase()) return false;
    if (opts.model && !String(row.model ?? '').toLowerCase().includes(opts.model.toLowerCase())) return false;
    return true;
  });
}
function selectedRows(all) {
  const filtered = filterRows(all);
  if (opts.mode === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    return filtered.filter((row) => String(row.started_at).slice(0, 10) === today);
  }
  if (opts.session) return all.filter((row) => row.session_id === opts.session);
  if (opts.mode === 'last') {
    return [...filtered].filter((row) => row.status !== 'running').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, 1);
  }
  return [];
}
function aggregateReports(reports, label, duplicateSuppressedSessionIds = []) {
  const total = emptyMetrics();
  const sessions = reports.flatMap((report) => report.sessions);
  for (const report of reports) combineMetrics(total, report.total);
  const unique = (values) => [...new Set(values)];
  const providerDrivers = [...new Map(reports.flatMap((report) => report.providerDriver ? [[report.providerDriver.id, report.providerDriver]] : [])).values()];
  return normalizeClineReport({
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshot: { capturedAt: new Date().toISOString(), active: reports.some((report) => report.snapshot.active), state: 'aggregate' },
    session: { id: null, title: label, status: 'aggregate', startedAt: reports.at(-1)?.session.startedAt ?? null, endedAt: reports[0]?.session.endedAt ?? null },
    providerDrivers,
    configuration: effectiveConfiguration,
    selection: { method: label, requestedId: null, ambiguousCandidates: [], warning: null },
    usage: usageSummary(total),
    billing: classifyBilling(total),
    rootSessionIds: reports.map((report) => report.session.id),
    includedSessionIds: unique(reports.flatMap((report) => report.includedSessionIds)),
    excludedSessionIds: unique(reports.flatMap((report) => report.excludedSessionIds)),
    duplicateSuppressedSessionIds: unique([
      ...duplicateSuppressedSessionIds,
      ...reports.flatMap((report) => report.duplicateSuppressedSessionIds),
    ]),
    childSessionIds: unique(reports.flatMap((report) => report.childSessionIds)),
    missingChildSessionIds: reports.flatMap((report) => report.missingChildSessionIds),
    sessions,
    total,
    totalSource: 'filtered-session-reports',
    includedChildren: opts.includeChildren,
  }, {
    method: label,
    requestedId: null,
    candidateIds: reports.map((report) => report.session.id),
  });
}
function renderCompare(older, newer) {
  const delta = newer.usage.totalTokens - older.usage.totalTokens;
  const percent = older.usage.totalTokens ? `${(delta / older.usage.totalTokens * 100).toFixed(1)}%` : 'n/a';
  return [
    'Session Cost — Comparison',
    `Older: ${older.session.id} (${older.session.startedAt ?? 'unknown'})`,
    `Newer: ${newer.session.id} (${newer.session.startedAt ?? 'unknown'})`,
    `Tokens: ${integer(older.usage.totalTokens)} → ${integer(newer.usage.totalTokens)} (${delta >= 0 ? '+' : ''}${integer(delta)}, ${percent})`,
    `Cache hit: ${(older.usage.cacheHitRate * 100).toFixed(1)}% → ${(newer.usage.cacheHitRate * 100).toFixed(1)}%`,
    `Billing: ${older.billing.label} → ${newer.billing.label}`,
  ].join('\n');
}
function renderAggregate(report) {
  if (report.session.id) return render(report);
  return [
    'Session Cost — Filtered aggregate',
    `Sessions: ${report.includedSessionIds.length}`,
    `Roots: ${report.rootSessionIds.length}`,
    `Excluded descendants: ${report.excludedSessionIds.length}`,
    `Duplicate-suppressed selections: ${report.duplicateSuppressedSessionIds.length}`,
    `Billing: ${report.billing.label}`,
    `Total tokens: ${integer(report.usage.totalTokens)} (${millions(report.usage.totalTokens)})`,
    `Fresh input: ${integer(report.usage.freshInputTokens)} (${millions(report.usage.freshInputTokens)})`,
    `Cached read: ${integer(report.usage.cacheReadTokens)} (${millions(report.usage.cacheReadTokens)})`,
    `Output: ${integer(report.usage.outputTokens)} (${millions(report.usage.outputTokens)})`,
    `Cache-hit rate: ${(report.usage.cacheHitRate * 100).toFixed(1)}%`,
  ].join('\n');
}

function accountCredential(dataDir) {
  const credential = resolveClineCredential({ dataDir, environment: process.env });
  if (!credential) die('--account requires CLINE_API_KEY or a valid cline/cline-pass auth entry in data/settings/providers.json (run: cline auth --provider cline)');
  return credential;
}
function renderPeriod(period) {
  const coverage = period.coverage ? ` · ${period.coverage}${period.complete ? '' : ' window'}` : '';
  return `${usd(period.referenceCostUsd)} reference · ${usd(period.creditsUsedUsd)} credits · ${integer(period.requests)} requests · ${integer(period.totalTokens)} tokens${coverage}`;
}
function renderAccount(summary) {
  const plan = summary.plan;
  const limits = summary.usageLimits ?? [];
  const lines = [
    'Cline Account Summary',
    `Account: ${summary.userId}`,
    `History window (UTC): ${summary.window?.start ?? 'unbounded'} -> ${summary.window?.end ?? 'unknown'}`,
    `Requests: ${integer(summary.requests)} (${integer(summary.fetchedRows)} fetched, ${integer(summary.excludedRows)} outside window, ${integer(summary.pages)} pages)`,
    `Plan: ${plan ? `${plan.name} (${plan.active ? 'active' : 'inactive'})` : 'none'}`,
    `Balance: ${usd(summary.billingTotals.balanceUsd)}`,
    `Reference cost: ${usd(summary.billingTotals.referenceCostUsd)}`,
    `Credits used: ${usd(summary.billingTotals.creditsUsedUsd)}`,
    `Total tokens: ${integer(summary.tokenTotals.totalTokens)} (${millions(summary.tokenTotals.totalTokens)})`,
    `ClinePass requests: ${integer(summary.clinePassRequests)}`,
    `Usage limits: ${limits.length ? limits.map((limit) => `${limit.type}=${limit.percentUsed}%${limit.resetsAt ? ` (resets ${limit.resetsAt})` : ''}`).join(', ') : 'none reported'}`,
    '',
    'Period costs:',
    `  Today: ${renderPeriod(summary.periods.today)}`,
    `  Last 7 days: ${renderPeriod(summary.periods.last7Days)}`,
    `  Current month: ${renderPeriod(summary.periods.currentMonth)}`,
    '',
    'Recent days:',
  ];
  for (const day of summary.periods.daily.slice(0, 7)) lines.push(`  ${day.from}: ${renderPeriod(day)}`);
  lines.push('', 'Recent weeks:');
  for (const week of summary.periods.weekly.slice(0, 4)) lines.push(`  ${week.from}: ${renderPeriod(week)}`);
  lines.push('', 'Recent months:');
  for (const month of summary.periods.monthly.slice(0, 6)) lines.push(`  ${month.from}: ${renderPeriod(month)}`);
  return lines.join('\n');
}
async function runAccount(dataDir) {
  const credential = accountCredential(dataDir);
  const days = Number.isFinite(opts.accountDays) && opts.accountDays > 0 ? Math.floor(opts.accountDays) : 45;
  const now = Date.now();
  const since = now - days * 24 * 60 * 60 * 1000;
  const account = await fetchClineAccount({ apiKey: credential.apiKey, userId: opts.accountUserId || credential.userId || null, since, now });
  const summary = summarizeClineAccount(account, new Date(now));
  summary.historyDays = days;
  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    account: summary,
    live: true,
    credentialSource: credential.source,
    credentialExpiresAt: credential.expiresAt ?? null,
    configuration: publicConfigResult(effectiveConfiguration),
  };
  if (opts.dashboard) {
    const outputPath = writeDashboard(output, {
      outPath: opts.out ?? path.join(dataDir, 'data', 'reports', 'session-cost', 'account-dashboard.html'),
      title: 'Cline Account Usage Dashboard',
    });
    if (opts.json) console.log(JSON.stringify({ ...output, dashboardPath: outputPath }, replacer, 2));
    else console.log(`Dashboard written: ${outputPath}`);
  } else if (opts.json) console.log(JSON.stringify(output, replacer, 2));
  else console.log(renderAccount(summary));
}

// Wrapped, not re-indented, so the diff stays small. Kept re-callable so --watch can
// re-query the same ledger in-process on each poll rather than spawning the CLI per tick.
async function runOnce() {
const dataDir = path.resolve(opts.dataDir ?? DEFAULT_DATA_DIR);
try {
  effectiveConfiguration = loadEffectiveConfig({
    configPath: opts.sessionConfigPath,
    cli: {
      provider: opts.provider,
      model: opts.model,
      includeChildren: opts.includeChildrenExplicit ? opts.includeChildren : undefined,
    },
  });
  if (handleConfigAction(effectiveConfiguration)) process.exit(0);
  if (opts.diagnostic) process.exit(runDiagnostic(effectiveConfiguration));
  if (!opts.provider && effectiveConfiguration.config.runtimeDefaults.provider) opts.provider = effectiveConfiguration.config.runtimeDefaults.provider;
  if (!opts.model && effectiveConfiguration.config.runtimeDefaults.model) opts.model = effectiveConfiguration.config.runtimeDefaults.model;
  if (!opts.includeChildrenExplicit && effectiveConfiguration.config.runtimeDefaults.includeChildren === true) opts.includeChildren = true;
} catch (error) {
  die(error.message);
}
if (opts.account) {
  try {
    await runAccount(dataDir);
  } catch (error) {
    console.error(`session-cost: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
} else {
const dbPath = path.join(dataDir, 'data', 'db', 'sessions.db');
if (!fs.existsSync(dbPath)) die(`Cline session database not found: ${dbPath}`);
// A truncated, locked, or non-SQLite file throws from the driver. Report it as a
// readable condition naming the file, not as an uncaught stack trace quoting the
// full local path, and never as an empty successful report.
let db;
try {
  db = new DatabaseSync(dbPath, { readOnly: true });
  // node:sqlite opens lazily, so a truncated or non-SQLite file only fails on the
  // first statement. Probe the schema here, inside the guard, so the user gets one
  // readable line instead of an uncaught driver stack trace quoting the install path.
  db.prepare('SELECT session_id FROM sessions LIMIT 1').all();
} catch (error) {
  die(`Cline session database could not be read (${path.basename(dbPath)}): ${describeStorageError(error)}`);
}
try {
  // A database that parses but has no `sessions` table must fail rather than read as
  // an empty ledger, which would be indistinguishable from a real "no sessions" result.
  const all = db.prepare('SELECT * FROM sessions').all();
  if (!all.length) die('Cline session database contains no sessions');
  const config = loadConfig(dataDir);
  const candidates = filterRows(all);
  const graph = createSessionGraph(all);
  const rowsById = new Map(all.map((row) => [row.session_id, row]));

  if (opts.list > 0) {
    const topLevel = selectTopLevelCandidates(candidates.map((row) => row.session_id), graph);
    const recent = topLevel.includedRootIds
      .sort((a, b) => Date.parse(rowsById.get(b).started_at) - Date.parse(rowsById.get(a).started_at))
      .slice(0, opts.list)
      .map((id) => reportFor(rowsById.get(id), all, graph, opts.includeChildren, {
        method: 'list',
        requestedId: null,
        candidateIds: topLevel.includedRootIds,
      }));
    if (opts.json) {
      console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, contractVersion: REPORT_CONTRACT_VERSION, runtime: 'cline', kind: 'report-list', generatedAt: new Date().toISOString(), sessions: recent, duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds }, replacer, 2));
    } else if (opts.rollup) {
      console.log(renderRollup(recent, opts.rollup));
    } else if (opts.top) {
      console.log(renderRanking(recent, opts.top));
    } else {
      for (const report of recent) {
        const billing = report.billing;
        console.log(`${report.session.id}  ${billing.label.padEnd(12)}  ${millions(report.usage.totalTokens).padStart(10)}  ${String(report.total.calls).padStart(4)} calls  ${clip(report.session.title, 48)}`);
      }
      if (topLevel.duplicateSuppressedSessionIds.length) {
        console.log(`\nDuplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}`);
      }
    }
  } else if (opts.mode === 'compare') {
    const topLevel = selectTopLevelCandidates(candidates.map((row) => row.session_id), graph);
    const reports = topLevel.includedRootIds
      .sort((a, b) => Date.parse(rowsById.get(b).started_at) - Date.parse(rowsById.get(a).started_at))
      .slice(0, 2)
      .map((id) => reportFor(rowsById.get(id), all, graph, opts.includeChildren, {
        method: 'compare',
        requestedId: null,
        candidateIds: topLevel.includedRootIds,
      }));
    if (reports.length < 2) die('--compare requires at least two matching sessions');
    const output = { schemaVersion: SCHEMA_VERSION, contractVersion: REPORT_CONTRACT_VERSION, runtime: 'cline', kind: 'report-comparison', generatedAt: new Date().toISOString(), comparison: { older: reports[1], newer: reports[0] }, duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds };
    if (opts.json) console.log(JSON.stringify(output, replacer, 2));
    else console.log(`${renderCompare(reports[1], reports[0])}${topLevel.duplicateSuppressedSessionIds.length ? `\nDuplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}` : ''}`);
  } else if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
    let rows = candidates;
    if (opts.mode === 'last') rows = rows.filter((row) => row.status !== 'running').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, 1);
    if (opts.mode === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter((row) => String(row.started_at).slice(0, 10) === today);
    }
    if (!rows.length) die('no sessions match the requested filters');
    const topLevel = selectTopLevelCandidates(rows.map((row) => row.session_id), graph);
    const reports = topLevel.includedRootIds
      .sort((a, b) => Date.parse(rowsById.get(a).started_at) - Date.parse(rowsById.get(b).started_at))
      .map((id) => reportFor(rowsById.get(id), all, graph, opts.includeChildren, {
        method: opts.mode,
        requestedId: null,
        candidateIds: topLevel.includedRootIds,
      }));
    let report;
    if (reports.length === 1) {
      reports[0].duplicateSuppressedSessionIds = topLevel.duplicateSuppressedSessionIds;
      report = normalizeClineReport(reports[0], {
        method: opts.mode,
        requestedId: null,
        candidateIds: topLevel.includedRootIds,
      });
    } else {
      report = aggregateReports(reports, opts.mode === 'today' ? 'today' : 'filtered-range', topLevel.duplicateSuppressedSessionIds);
    }
    if (opts.json) console.log(JSON.stringify(report, replacer, 2));
    else if (opts.explain) console.log(renderExplanation(report));
    else console.log(renderAggregate(report));
  } else {
    const selection = resolveSession(all, {
      explicitId: opts.session,
      environment: process.env,
      ancestorPids: ancestorPids(),
      logSessionId: logSessionId(dataDir),
    });
    if (selection.error) die(selection.error);
    if (!selection.row) die('no Cline session found');
    let report = reportFor(selection.row, all, graph, opts.includeChildren);
    const selectionMetadata = {
      method: selection.method,
      requestedId: selection.requestedId,
      candidateIds: selection.ambiguousCandidates,
      warning: selection.warning ?? null,
    };
    if (selection.warning) report.snapshot.warning = selection.warning;
    report = normalizeClineReport(report, selectionMetadata);
    if (opts.dashboard) {
      const outputPath = writeDashboard(report, {
        outPath: opts.out ?? path.join(dataDir, 'data', 'reports', 'session-cost', 'session-dashboard.html'),
        title: 'Cline Session Cost Dashboard',
      });
      if (opts.json) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, contractVersion: REPORT_CONTRACT_VERSION, runtime: 'cline', kind: 'dashboard', generatedAt: new Date().toISOString(), dashboardPath: outputPath, report }, replacer, 2));
      else console.log(`Dashboard written: ${outputPath}`);
    } else if (opts.csv) { if (!quiet) console.log(renderCsv(report)); }
    else if (opts.json) { if (!quiet) console.log(JSON.stringify(report, replacer, 2)); }
    else if (opts.explain) { if (!quiet) console.log(renderExplanation(report)); }
    else if (!quiet) console.log(render(report));
    lastReport = report;
    // A budget gates the exit code, never the report itself.
    if (opts.budget != null) {
      const verdict = evaluateBudget({
        amountUsd: report.billing?.amountUsd ?? null,
        budget: opts.budget,
        coverage: report.billing?.coverage ?? 'unknown',
        basis: report.billing?.basis,
        sessionId: report.session?.id ?? null,
      });
      console.error(verdict.message);
      if (verdict.exitCode) process.exitCode = verdict.exitCode;
    }
  }
} finally {
  db.close();
}
}
}

// The live view. Foreground only: no daemon, no background process, no orphan to clean up.
// Both ledgers are WAL, verified on a real Windows install, so a poll never needs a
// busy-timeout fallback. A transient read failure keeps the last good frame marked
// STALE rather than ending the watch.
if (opts.watch) {
  const surface = createLiveSurface(process.stdout);
  quiet = true;
  let previous = null;
  const stop = () => { surface.leave(); process.exit(0); };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  for (;;) {
    let staleReason = null;
    try {
      await runOnce();
    } catch (error) {
      staleReason = error instanceof Error ? error.message : String(error);
    }
    if (lastReport) {
      surface.draw(renderLiveFrame(lastReport, { previous, stale: false }));
      previous = lastReport.billing?.amountUsd ?? null;
    } else {
      surface.draw(renderLiveFrame(null, { previous, stale: true, staleReason: staleReason ?? 'no report yet' }));
    }
    await new Promise((resolve) => setTimeout(
      resolve,
      nextInterval(lastReport, { activeMs: 500, idleMs: opts.watchInterval ?? 3000 }),
    ));
  }
} else {
  await runOnce();
}
