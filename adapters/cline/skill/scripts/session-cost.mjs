#!/usr/bin/env node
// Token usage and Cline-recorded cost for local Cline sessions.
// See ../references/storage.md for ledger semantics.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fetchClineAccount, summarizeClineAccount } from './lib/cline-account.mjs';
import {
  SCHEMA_VERSION,
  addUsage,
  classifyBilling,
  combineMetrics,
  coverage,
  descendantIds,
  emptyMetrics,
  num,
  resolveSession,
  usageSummary,
} from './lib/session-cost-core.mjs';

const SCRIPT_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_DATA_DIR = path.resolve(SCRIPT_DIR, '..', '..', '..');
const opts = {
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
};

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--session') opts.session = process.argv[++i];
  else if (arg === '--account') opts.account = true;
  else if (arg === '--account-user-id') opts.accountUserId = process.argv[++i];
  else if (arg === '--last') opts.mode = 'last';
  else if (arg === '--today') opts.mode = 'today';
  else if (arg === '--compare') opts.mode = 'compare';
  else if (arg === '--from') opts.from = process.argv[++i];
  else if (arg === '--to') opts.to = process.argv[++i];
  else if (arg === '--provider') opts.provider = process.argv[++i];
  else if (arg === '--model') opts.model = process.argv[++i];
  else if (arg === '--config') opts.configPath = process.argv[++i];
  else if (arg === '--list') opts.list = Number(process.argv[++i] ?? 10);
  else if (arg === '--include-children') { opts.includeChildren = true; opts.includeChildrenExplicit = true; }
  else if (arg === '--json') opts.json = true;
  else if (arg === '--data-dir') opts.dataDir = process.argv[++i];
  else if (arg === '--help' || arg === '-h') { help(); process.exit(0); }
  else die(`unknown argument: ${arg}`);
}

function help() {
  console.log(`session-cost — token usage and Cline-recorded cost

  --session <id>       session id (default: auto-detect current Cline session)
  --account            fetch read-only Cline account balance/plan/usage summary
  --account-user-id    optional account id override (must match authenticated profile)
  --last               report the latest completed session
  --today              report sessions started today (UTC)
  --compare            compare the latest two sessions
  --from <YYYY-MM-DD>  include sessions on/after this UTC date
  --to <YYYY-MM-DD>    include sessions on/before this UTC date
  --provider <name>    filter sessions by provider
  --model <name>       filter sessions by model substring
  --config <path>      load standing-summary settings
  --include-children  include all descendant subagent sessions
  --list [n]           list the n most recent sessions (default 10)
  --json              emit schema-versioned JSON
  --data-dir <path>    Cline data directory (default: %USERPROFILE%\\.cline)`);
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

function fromAggregate(metadata, row) {
  const usage = metadata.aggregateUsage ?? metadata.usage ?? {};
  const result = { ...emptyMetrics(), source: 'aggregate', storedTotalCost: metadata.totalCost };
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) result[field] = num(usage[field]);
  result.lastTs = Date.parse(row.updated_at ?? row.started_at ?? '') || Date.parse(row.ended_at ?? '') || 0;
  const provider = row.provider ?? 'unknown';
  const model = row.model ?? 'unknown';
  const group = { provider, model, ...emptyMetrics() };
  for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) group[field] = result[field];
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
    result = fromAggregate(metadata, row);
    source = result.inputTokens || result.outputTokens ? 'aggregate' : 'none';
  }
  return { ...result, source, title: metadata.title ?? row.prompt ?? '', storedTotalCost: metadata.totalCost };
}

function costState(metrics) {
  if (!metrics.calls) return { label: usd(0), note: 'no calls' };
  if (metrics.unpricedCalls === 0) return { label: usd(metrics.cost), note: 'complete' };
  if (metrics.pricedCalls === 0) return { label: 'not recorded', note: `0/${metrics.calls} calls have cost` };
  return { label: usd(metrics.cost), note: `partial; ${metrics.unpricedCalls}/${metrics.calls} calls lack cost` };
}
function reportFor(row, all, includeChildren) {
  const ids = includeChildren ? descendantIds(all, row.session_id) : new Set([row.session_id]);
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
  const total = emptyMetrics();
  for (const session of sessions) combineMetrics(total, session.metrics);

  // Some older Cline subagent rows have no message file and no usage aggregate. In that case the
  // root session's aggregateUsage is Cline's authoritative end-to-end total, so use it rather than
  // silently under-reporting. Per-model rows remain the call-level detail that is locally present.
  const missingChildren = sessions.filter((item) => !item.metrics.calls && item.row.sessionId !== row.session_id);
  let totalSource = 'messages';
  if (includeChildren && missingChildren.length) {
    const metadata = safeJson(row.metadata_json);
    const aggregate = metadata.aggregateUsage;
    if (aggregate) {
      for (const field of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']) total[field] = num(aggregate[field]);
      if (Number.isFinite(Number(metadata.totalCost))) {
        total.cost = Number(metadata.totalCost);
        total.pricedCalls = total.calls;
        total.unpricedCalls = 0;
      }
      totalSource = 'aggregate-with-missing-children';
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshot: reportStatus(row),
    session: {
      id: row.session_id,
      title: rowMetrics(row).title,
      status: row.status,
      startedAt: row.started_at,
      endedAt: row.ended_at,
    },
    selection: null,
    usage: usageSummary(total),
    billing: classifyBilling(total),
    includedSessionIds: chosen.map((item) => item.session_id),
    childSessionIds: chosen.filter((item) => item.session_id !== row.session_id).map((item) => item.session_id),
    missingChildSessionIds: missingChildren.map((item) => item.row.sessionId),
    sessions,
    total,
    totalSource,
    includedChildren: includeChildren,
  };
}
function reportStatus(row) {
  return {
    capturedAt: new Date().toISOString(),
    active: row.status === 'running',
    state: row.status === 'running' ? 'snapshot' : 'final',
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
  } else if (report.childSessionIds.length) {
    lines.push('', `Excluded subagent sessions: ${report.childSessionIds.length}`, ...report.childSessionIds.map((id) => `  - ${id}`), 'Use --include-children for an end-to-end task total.');
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
function aggregateReports(reports, label) {
  const total = emptyMetrics();
  const sessions = reports.flatMap((report) => report.sessions);
  for (const report of reports) combineMetrics(total, report.total);
  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshot: { capturedAt: new Date().toISOString(), active: reports.some((report) => report.snapshot.active), state: 'aggregate' },
    session: { id: null, title: label, status: 'aggregate', startedAt: reports.at(-1)?.session.startedAt ?? null, endedAt: reports[0]?.session.endedAt ?? null },
    selection: { method: label, requestedId: null, ambiguousCandidates: [], warning: null },
    usage: usageSummary(total),
    billing: classifyBilling(total),
    includedSessionIds: reports.flatMap((report) => report.includedSessionIds),
    childSessionIds: reports.flatMap((report) => report.childSessionIds),
    missingChildSessionIds: reports.flatMap((report) => report.missingChildSessionIds),
    sessions,
    total,
    totalSource: 'filtered-session-reports',
    includedChildren: opts.includeChildren,
  };
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
    `Billing: ${report.billing.label}`,
    `Total tokens: ${integer(report.usage.totalTokens)} (${millions(report.usage.totalTokens)})`,
    `Fresh input: ${integer(report.usage.freshInputTokens)} (${millions(report.usage.freshInputTokens)})`,
    `Cached read: ${integer(report.usage.cacheReadTokens)} (${millions(report.usage.cacheReadTokens)})`,
    `Output: ${integer(report.usage.outputTokens)} (${millions(report.usage.outputTokens)})`,
    `Cache-hit rate: ${(report.usage.cacheHitRate * 100).toFixed(1)}%`,
  ].join('\n');
}

function accountApiKey(dataDir) {
  if (process.env.CLINE_API_KEY) return process.env.CLINE_API_KEY;
  const secretsPath = path.join(dataDir, 'data', 'secrets.json');
  const secrets = readJson(secretsPath);
  if (secrets?.apiKey) return secrets.apiKey;
  die('--account requires CLINE_API_KEY or an authenticated Cline apiKey in data/secrets.json');
}
function accountUserId() {
  return opts.accountUserId || process.env.CLINE_USER_ID || null;
}
function renderAccount(summary) {
  const plan = summary.plan;
  const limits = summary.usageLimits ?? [];
  return [
    'Cline Account Summary',
    `Account: ${summary.userId}`,
    `Requests: ${integer(summary.requests)}`,
    `Plan: ${plan ? `${plan.name} (${plan.active ? 'active' : 'inactive'})` : 'none'}`,
    `Balance: ${usd(summary.billingTotals.balanceUsd)}`,
    `Reference cost: ${usd(summary.billingTotals.referenceCostUsd)}`,
    `Credits used: ${usd(summary.billingTotals.creditsUsedUsd)}`,
    `Total tokens: ${integer(summary.tokenTotals.totalTokens)} (${millions(summary.tokenTotals.totalTokens)})`,
    `ClinePass requests: ${integer(summary.clinePassRequests)}`,
    `Usage limits: ${limits.length ? limits.map((limit) => `${limit.type}=${limit.percentUsed}%`).join(', ') : 'none reported'}`,
  ].join('\n');
}
async function runAccount(dataDir) {
  const account = await fetchClineAccount({ apiKey: accountApiKey(dataDir), userId: accountUserId() });
  const summary = summarizeClineAccount(account);
  const output = { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), account: summary };
  if (opts.json) console.log(JSON.stringify(output, replacer, 2));
  else console.log(renderAccount(summary));
}

const dataDir = path.resolve(opts.dataDir ?? DEFAULT_DATA_DIR);
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
const db = new DatabaseSync(dbPath, { readOnly: true });
try {
  const all = db.prepare('SELECT * FROM sessions').all();
  if (!all.length) die('Cline session database contains no sessions');
  const config = loadConfig(dataDir);
  const candidates = filterRows(all);

  if (opts.list > 0) {
    const recent = candidates
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, opts.list)
      .map((row) => reportFor(row, all, opts.includeChildren));
    if (opts.json) {
      console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), sessions: recent }, replacer, 2));
    } else {
      for (const report of recent) {
        const billing = report.billing;
        console.log(`${report.session.id}  ${billing.label.padEnd(12)}  ${millions(report.usage.totalTokens).padStart(10)}  ${String(report.total.calls).padStart(4)} calls  ${clip(report.session.title, 48)}`);
      }
    }
  } else if (opts.mode === 'compare') {
    const reports = candidates
      .sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at))
      .slice(0, 2)
      .map((row) => reportFor(row, all, opts.includeChildren));
    if (reports.length < 2) die('--compare requires at least two matching sessions');
    const output = { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), comparison: { older: reports[1], newer: reports[0] } };
    if (opts.json) console.log(JSON.stringify(output, replacer, 2));
    else console.log(renderCompare(reports[1], reports[0]));
  } else if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
    let rows = candidates;
    if (opts.mode === 'last') rows = rows.filter((row) => row.status !== 'running').sort((a, b) => Date.parse(b.started_at) - Date.parse(a.started_at)).slice(0, 1);
    if (opts.mode === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      rows = rows.filter((row) => String(row.started_at).slice(0, 10) === today);
    }
    if (!rows.length) die('no sessions match the requested filters');
    const reports = rows.sort((a, b) => Date.parse(a.started_at) - Date.parse(b.started_at)).map((row) => reportFor(row, all, opts.includeChildren));
    const report = reports.length === 1 ? reports[0] : aggregateReports(reports, opts.mode === 'today' ? 'today' : 'filtered-range');
    if (opts.json) console.log(JSON.stringify(report, replacer, 2));
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
    const report = reportFor(selection.row, all, opts.includeChildren);
    report.selection = {
      method: selection.method,
      requestedId: selection.requestedId,
      ambiguousCandidates: selection.ambiguousCandidates,
      warning: selection.warning ?? null,
    };
    if (selection.warning) report.snapshot.warning = selection.warning;
    if (opts.json) console.log(JSON.stringify(report, replacer, 2));
    else console.log(render(report));
  }
} finally {
  db.close();
}
}


