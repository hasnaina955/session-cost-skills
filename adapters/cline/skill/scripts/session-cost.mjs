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
  descendantIds,
  duplicateSuppressedSessionIds,
  emptyMetrics,
  isActiveSessionStatus,
  normalizeSessionStatus,
  num,
  resolveSession,
  topLevelRows,
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
  accountDays: 45,
  dashboard: false,
  out: null,
};

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i];
  if (arg === '--session') {
    opts.session = process.argv[++i];
    if (!opts.session) die('--session requires an id');
  } else if (arg === '--account') opts.account = true;
  else if (arg === '--account-user-id') opts.accountUserId = process.argv[++i];
  else if (arg === '--account-days') opts.accountDays = Number(process.argv[++i]);
  else if (arg === '--dashboard') opts.dashboard = true;
  else if (arg === '--out') opts.out = process.argv[++i];
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
  --account-days <n>   exact UTC history window in days (default 45)
  --dashboard          write a self-contained HTML dashboard
  --out <path>         dashboard output path
  --last               report the latest completed session
  --today              report sessions started today (UTC)
  --compare            compare the latest two sessions
  --from <YYYY-MM-DD>  include sessions on/after this UTC date
  --to <YYYY-MM-DD>    include sessions on/before this UTC date
  --provider <name>    filter sessions by provider
  --model <name>       filter sessions by model substring
  --config <path>      load standing-summary settings
  --include-children  include all descendant subagent sessions
  --list [n]           list the n most recent task roots (default 10)
  --json              emit schema-versioned JSON
  --data-dir <path>    Cline data directory (default: %USERPROFILE%\\.cline)`);
}
function die(message) { console.error(`session-cost: ${message}`); process.exit(2); }
function integer(value) { return Math.round(num(value)).toLocaleString('en-US'); }
function usd(value) { return `$${num(value).toFixed(6)}`; }
function unknownUsd() { return 'not provided'; }
function millions(value) { return `${(num(value) / 1_000_000).toFixed(4)} M`; }
function clip(value, length = 52) { const s = String(value ?? ''); return s.length <= length ? s : `${s.slice(0, length - 1)}…`; }
function safeJson(value) { if (value && typeof value === 'object') return value; try { return JSON.parse(value || '{}'); } catch { return {}; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function replacer(_key, value) { return value instanceof Map ? Object.fromEntries(value) : value; }
function finiteNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}
function timestamp(value) {
  const parsed = typeof value === 'number' ? value : Date.parse(value ?? '');
  return Number.isFinite(parsed) ? parsed : null;
}
function unique(values) { return [...new Set(values.filter((value) => value !== null && value !== undefined))]; }

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
        if (event?.event === 'task.tool_used') {
          const id = event.properties?.ulid ?? event.properties?.sessionId ?? event.properties?.session_id;
          if (id) return String(id);
        }
      } catch { /* Ignore partial/corrupt log lines. */ }
    }
  } catch { /* Logs are an optional discovery signal. */ }
  return null;
}

const TOKEN_FIELDS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];
function objectValue(value) { return value && typeof value === 'object' && !Array.isArray(value) ? value : null; }
function hasUsageShape(value) {
  return Boolean(value && (
    TOKEN_FIELDS.some((field) => finiteNumber(value[field]) !== null)
    || ['totalCost', 'calls', 'callCount', 'referenceCost', 'referenceCostUsd'].some((field) => finiteNumber(value[field]) !== null)
  ));
}
function usageForScope(metadata, scope) {
  const aggregate = objectValue(metadata.aggregateUsage ?? metadata.aggregatedUsage);
  const root = objectValue(metadata.usage ?? metadata.rootUsage);
  if (scope === 'end-to-end') return aggregate;
  if (scope === 'end-to-end-root') return hasUsageShape(aggregate) ? aggregate : root;
  return root;
}
function aggregateCostForScope(metadata, scope, usage) {
  const candidates = scope === 'end-to-end' || scope === 'end-to-end-root'
    ? [usage?.totalCost, metadata.aggregatedAgentsCost, metadata.aggregateUsage?.totalCost, scope === 'end-to-end-root' ? metadata.usage?.totalCost : null, metadata.totalCost]
    : [usage?.totalCost, usage && !metadata.aggregateUsage && !metadata.aggregatedUsage ? metadata.totalCost : null];
  for (const candidate of candidates) {
    const parsed = finiteNumber(candidate);
    if (parsed !== null) return { value: parsed, source: candidate === usage?.totalCost ? `${scope}-usage.totalCost` : candidate === metadata.aggregatedAgentsCost ? 'metadata.aggregatedAgentsCost' : candidate === metadata.aggregateUsage?.totalCost ? 'metadata.aggregateUsage.totalCost' : 'metadata.totalCost' };
  }
  return { value: null, source: null };
}
function hasAggregateEvidence(usage, cost) {
  if (cost !== null) return true;
  return Boolean(usage && (
    TOKEN_FIELDS.some((field) => finiteNumber(usage[field]) !== null)
    || ['totalCost', 'calls', 'callCount', 'referenceCost', 'referenceCostUsd'].some((field) => finiteNumber(usage[field]) !== null)
  ));
}

function fromAggregate(metadata, row, scope = 'session') {
  const usage = usageForScope(metadata, scope) ?? {};
  const costInfo = aggregateCostForScope(metadata, scope, usage);
  const callCount = finiteNumber(usage.calls ?? usage.callCount);
  const callsKnown = callCount !== null;
  const result = {
    ...emptyMetrics(),
    source: 'aggregate',
    aggregateScope: scope,
    calls: callsKnown ? callCount : null,
    callsKnown,
    callCountKnown: callsKnown,
    pricedCalls: callsKnown && costInfo.value !== null ? callCount : null,
    unpricedCalls: callsKnown && costInfo.value === null ? callCount : null,
    cost: costInfo.value ?? 0,
    referenceCost: finiteNumber(usage.referenceCostUsd ?? usage.referenceCost) ?? 0,
    aggregateCostUsd: costInfo.value,
    costSource: costInfo.source,
    ledgerStatus: 'aggregate',
    knownZeroCall: callsKnown && callCount === 0,
    hasAggregate: hasAggregateEvidence(usage, costInfo.value),
  };
  for (const field of TOKEN_FIELDS) result[field] = num(usage[field]);
  result.lastTs = timestamp(row.updated_at ?? row.started_at ?? '') ?? timestamp(row.ended_at ?? '') ?? 0;
  const provider = row.provider ?? 'unknown';
  const model = row.model ?? 'unknown';
  const group = { provider, model, ...result, models: undefined };
  delete group.models;
  result.models.set(`${provider}|${model}`, group);
  return result;
}

function rowMetrics(row, { scope = 'session' } = {}) {
  const metadata = objectValue(safeJson(row.metadata_json)) ?? {};
  let result = emptyMetrics();
  let source = 'none';
  let messageLedgerPresent = false;
  let malformedAssistantMetrics = false;
  let messageCount = 0;
  if (row.messages_path && fs.existsSync(row.messages_path)) {
    const data = readJson(row.messages_path);
    const messages = Array.isArray(data?.messages) ? data.messages : null;
    if (messages) {
      messageLedgerPresent = true;
      messageCount = messages.length;
      for (const message of messages) {
        if (message.role !== 'assistant') continue;
        if (message.metrics === null || message.metrics === undefined) continue;
        if (typeof message.metrics !== 'object' || Array.isArray(message.metrics)) {
          malformedAssistantMetrics = true;
          continue;
        }
        addUsage(result, { ...message.metrics, ts: message.ts }, message.modelInfo);
      }
    }
  }
  if (result.calls) {
    source = 'messages';
    result.ledgerStatus = 'messages';
    result.costSource = 'messages';
    result.knownZeroCall = false;
  } else {
    const aggregate = fromAggregate(metadata, row, scope);
    if (aggregate.hasAggregate) {
      result = aggregate;
      source = 'aggregate';
    } else {
      const usableMessageLedger = messageLedgerPresent && !malformedAssistantMetrics;
      result.ledgerStatus = usableMessageLedger ? 'messages' : 'unavailable';
      result.knownZeroCall = usableMessageLedger;
      result.callsKnown = usableMessageLedger;
      result.callCountKnown = usableMessageLedger;
      source = 'none';
    }
  }

  const scopeUsage = usageForScope(metadata, scope);
  const costInfo = aggregateCostForScope(metadata, scope, scopeUsage);
  result.aggregateScope = scope;
  result.aggregateCostUsd = costInfo.value;
  result.costSource = source === 'aggregate' ? costInfo.source : (result.costSource ?? null);
  result.aggregateIgnored = scope !== 'end-to-end' && !usageForScope(metadata, scope) && Boolean(metadata.aggregateUsage ?? metadata.aggregatedUsage);
  result.title = metadata.title ?? row.prompt ?? '';
  result.storedTotalCost = finiteNumber(metadata.totalCost);
  result.storedAggregateCost = finiteNumber(metadata.aggregatedAgentsCost);
  result.messageLedgerPresent = messageLedgerPresent;
  result.malformedAssistantMetrics = malformedAssistantMetrics;
  result.messageCount = messageCount;
  result.source = source;
  return result;
}

function isUnavailable(metrics) {
  return metrics?.ledgerStatus === 'unavailable' || (metrics?.callsKnown === false || metrics?.callCountKnown === false) && !metrics?.hasAggregate && !metrics?.inputTokens && !metrics?.outputTokens;
}
function isKnownZero(metrics) {
  return metrics?.knownZeroCall === true || metrics?.callsKnown === true && Number(metrics?.calls) === 0 && metrics?.ledgerStatus === 'messages';
}
function callCountText(metrics) {
  return metrics?.callsKnown === false || metrics?.callCountKnown === false ? 'unknown' : integer(metrics?.calls);
}
function costState(metrics) {
  if (metrics?.callsKnown === false || metrics?.callCountKnown === false) return { label: metrics?.cost ? usd(metrics.cost) : 'not recorded', note: 'aggregate call count unavailable' };
  if (!metrics?.calls) return { label: isKnownZero(metrics) ? usd(0) : 'unavailable', note: isKnownZero(metrics) ? 'no calls' : 'ledger unavailable' };
  if (metrics.unpricedCalls === 0) return { label: usd(metrics.cost), note: metrics.aggregateCostUsd !== null ? 'complete (aggregate cost)' : 'complete' };
  if (metrics.pricedCalls === 0) return { label: 'not recorded', note: `0/${metrics.calls} calls have cost` };
  return { label: usd(metrics.cost), note: `partial; ${metrics.unpricedCalls}/${metrics.calls} calls lack cost` };
}

function applyAggregateCost(total, rootMetrics, metadata = null, endToEnd = false) {
  const aggregateCost = endToEnd && metadata
    ? aggregateCostForScope(metadata, 'end-to-end', usageForScope(metadata, 'end-to-end')).value
    : finiteNumber(rootMetrics?.aggregateCostUsd);
  if (aggregateCost === null) return;
  const incompleteLocalCost = total.callsKnown === false || total.callCountKnown === false || (total.unpricedCalls !== null && total.unpricedCalls > 0);
  const canPromote = total.cost === 0 || incompleteLocalCost;
  if (!canPromote) return;
  total.cost = aggregateCost;
  total.aggregateCostUsd = aggregateCost;
  total.costSource = endToEnd ? aggregateCostForScope(metadata, 'end-to-end', usageForScope(metadata, 'end-to-end')).source : rootMetrics.costSource ?? 'aggregate';
  if (total.callsKnown && total.callCountKnown !== false && total.unpricedCalls !== null && total.unpricedCalls === total.calls) {
    total.pricedCalls = total.calls;
    total.unpricedCalls = 0;
  }
}

function reportStatus(row) {
  const status = normalizeSessionStatus(row.status);
  const active = isActiveSessionStatus(status);
  return {
    capturedAt: new Date().toISOString(),
    status,
    active,
    state: active ? 'snapshot' : 'final',
    lastLedgerActivityAt: row.updated_at ?? row.ended_at ?? row.started_at ?? null,
  };
}

function freshness(report) {
  if (!report.snapshot.active) return 'final';
  const time = report.total.lastTs || timestamp(report.session.startedAt);
  return Number.isFinite(time) ? `snapshot ${new Date(time).toISOString()}` : 'snapshot';
}

function rowForReport(item, role, rootId, rootScope = 'root-only', all = []) {
  const itemScope = item.session_id === rootId
    ? rootScope
    : descendantIds(all, item.session_id).size > 1 ? 'session' : 'end-to-end-root';
  return {
    row: {
      sessionId: item.session_id,
      parentSessionId: item.parent_session_id ?? null,
      isSubagent: Number(item.is_subagent) === 1 || Boolean(item.parent_session_id),
      status: normalizeSessionStatus(item.status),
      startedAt: item.started_at,
      endedAt: item.ended_at,
    },
    role,
    rootSessionId: rootId,
    metrics: rowMetrics(item, { scope: itemScope }),
  };
}

function reportForRoots(rootRows, all, includeChildren, selectionOverride = {}) {
  const roots = [...new Map(rootRows.filter(Boolean).map((row) => [row.session_id, row])).values()];
  if (!roots.length) throw new Error('no session roots selected');
  const allById = new Map(all.map((row) => [row.session_id, row]));
  const includedIds = [];
  const includedSet = new Set();
  const childIds = [];
  const excludedIds = [];
  const excludedAncestorIds = [];
  const missingChildIds = [];
  const sessions = [];
  const total = emptyMetrics();
  const aggregateFallbacks = [];
  let totalSource = includeChildren ? 'selected-session-ledgers' : 'messages';

  for (const root of roots) {
    const ancestorSeen = new Set();
    let ancestorId = root.parent_session_id;
    while (ancestorId && !ancestorSeen.has(ancestorId)) {
      ancestorSeen.add(ancestorId);
      if (!roots.some((candidate) => candidate.session_id === ancestorId)) excludedAncestorIds.push(ancestorId);
      ancestorId = allById.get(ancestorId)?.parent_session_id ?? null;
    }
    const descendants = descendantIds(all, root.session_id);
    const hasDescendants = descendants.size > 1;
    const rootScope = hasDescendants ? (root.parent_session_id ? 'session' : 'root-only') : 'end-to-end-root';
    const ids = includeChildren ? descendants : new Set([root.session_id]);
    for (const id of descendants) if (id !== root.session_id) childIds.push(id);
    for (const id of ids) {
      if (includedSet.has(id)) continue;
      includedSet.add(id);
      includedIds.push(id);
      const item = allById.get(id);
      if (!item) continue;
      const role = id === root.session_id ? 'target' : 'child';
      sessions.push(rowForReport(item, role, root.session_id, rootScope, all));
    }
    for (const id of descendants) {
      if (id !== root.session_id && !ids.has(id)) excludedIds.push(id);
    }

    const rootSessions = sessions.filter((item) => item.rootSessionId === root.session_id);
    const missing = includeChildren
      ? rootSessions.filter((item) => item.row.sessionId !== root.session_id && isUnavailable(item.metrics))
      : [];
    for (const item of missing) missingChildIds.push(item.row.sessionId);
    const metadata = objectValue(safeJson(root.metadata_json)) ?? {};
    const aggregate = includeChildren && (missing.length || rootSessions.some((item) => isUnavailable(item.metrics)))
      ? fromAggregate(metadata, root, 'end-to-end')
      : null;
    const unavailableIncluded = rootSessions.filter((item) => isUnavailable(item.metrics));
    if (aggregate?.hasAggregate && (missing.length || unavailableIncluded.length)) {
      combineMetrics(total, aggregate);
      totalSource = 'aggregate-with-missing-children';
      aggregateFallbacks.push({
        rootSessionId: root.session_id,
        scope: 'end-to-end',
        source: aggregate.source,
        costSource: aggregate.costSource,
        costUsd: aggregate.aggregateCostUsd,
        tokenSource: 'metadata.aggregateUsage',
      });
    } else {
      const contribution = emptyMetrics();
      for (const item of rootSessions) combineMetrics(contribution, item.metrics);
      if (includeChildren) applyAggregateCost(contribution, rootSessions[0]?.metrics, metadata, true);
      combineMetrics(total, contribution);
      if (rootSessions.length && rootSessions.every((item) => item.metrics.source === 'aggregate')) totalSource = 'aggregate-session';
      else if (rootSessions.some((item) => item.metrics.source === 'aggregate')) totalSource = 'message-and-aggregate';
    }
  }

  includedIds.splice(0, includedIds.length, ...unique(includedIds));
  const childSessionIds = unique(childIds);
  const includedChildSessionIds = childSessionIds.filter((id) => includedSet.has(id));
  const excludedChildSessionIds = childSessionIds.filter((id) => !includedSet.has(id));
  const excludedSessionIds = unique(excludedIds);
  const excludedAncestorSessionIds = unique(excludedAncestorIds);
  const missingChildSessionIds = unique(missingChildIds);
  const selection = {
    method: selectionOverride.method ?? (roots.length === 1 ? 'single' : 'aggregate'),
    requestedId: selectionOverride.requestedId ?? null,
    known: selectionOverride.known ?? null,
    candidateSessionIds: unique(selectionOverride.candidateSessionIds ?? roots.map((row) => row.session_id)),
    rootSessionIds: roots.map((row) => row.session_id),
    includedSessionIds: includedIds,
    globalIncludedSessionIds: includedIds,
    includedChildSessionIds,
    excludedChildSessionIds,
    excludedSessionIds,
    excludedAncestorSessionIds,
    duplicateSuppressedSessionIds: unique(selectionOverride.duplicateSuppressedSessionIds ?? []),
    ambiguousCandidates: unique(selectionOverride.ambiguousCandidates ?? []),
    warning: selectionOverride.warning ?? null,
    warnings: selectionOverride.warning ? [selectionOverride.warning] : [],
    policy: 'select top-level task candidates, then attach descendants recursively',
    descendantDatePolicy: 'descendants follow their selected root even when started on another UTC date',
    includedChildren: Boolean(includeChildren),
  };
  const firstRoot = roots[0];
  const firstRootScope = descendantIds(all, firstRoot.session_id).size > 1 ? (firstRoot.parent_session_id ? 'session' : 'root-only') : 'end-to-end-root';
  const active = sessions.some((item) => isActiveSessionStatus(item.row.status));
  const rootMetrics = sessions.find((item) => item.row.sessionId === firstRoot.session_id)?.metrics ?? rowMetrics(firstRoot, { scope: firstRootScope });
  const billing = classifyBilling(total);
  const report = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    snapshot: roots.length === 1
      ? reportStatus(firstRoot)
      : { capturedAt: new Date().toISOString(), status: 'aggregate', active, state: active ? 'snapshot' : 'final' },
    session: {
      id: roots.length === 1 ? firstRoot.session_id : null,
      title: rootMetrics.title ?? (roots.length === 1 ? '' : 'Filtered aggregate'),
      status: roots.length === 1 ? normalizeSessionStatus(firstRoot.status) : 'aggregate',
      startedAt: roots.map((row) => row.started_at).filter(Boolean).sort()[0] ?? null,
      endedAt: roots.map((row) => row.ended_at).filter(Boolean).sort().at(-1) ?? null,
    },
    selection,
    usage: usageSummary(total),
    billing,
    costBasis: billing.costBasis,
    includedSessionIds: includedIds,
    globalIncludedSessionIds: includedIds,
    rootSessionIds: roots.map((row) => row.session_id),
    childSessionIds,
    includedChildSessionIds,
    excludedChildSessionIds,
    excludedSessionIds,
    excludedAncestorSessionIds,
    duplicateSuppressedSessionIds: selection.duplicateSuppressedSessionIds,
    missingChildSessionIds,
    aggregateFallbacks,
    sessions,
    total,
    totalSource,
    totalScope: aggregateFallbacks.length ? 'selected tasks; aggregate fallback is end-to-end per affected root' : 'selected sessions only',
    includedChildren: Boolean(includeChildren),
    ledger: {
      unavailableSessionIds: sessions.filter((item) => isUnavailable(item.metrics)).map((item) => item.row.sessionId),
      knownZeroCallSessionIds: sessions.filter((item) => isKnownZero(item.metrics)).map((item) => item.row.sessionId),
      malformedSessionIds: sessions.filter((item) => item.metrics.malformedAssistantMetrics).map((item) => item.row.sessionId),
      aggregateSource: sessions.filter((item) => item.metrics.source === 'aggregate').map((item) => item.row.sessionId),
    },
  };
  if (selection.warning) report.snapshot.warning = selection.warning;
  report.warnings = unique([
    ...(selection.warning ? [selection.warning] : []),
    ...(missingChildSessionIds.length ? [`${missingChildSessionIds.length} descendant ledger(s) unavailable; aggregate fallback may be used.`] : []),
    ...(report.ledger.unavailableSessionIds.length ? [`Ledger unavailable for: ${report.ledger.unavailableSessionIds.join(', ')}`] : []),
    ...(report.ledger.malformedSessionIds.length ? [`Malformed assistant metrics in: ${report.ledger.malformedSessionIds.join(', ')}`] : []),
  ]);
  return report;
}

function reportFor(row, all, includeChildren, selectionOverride = {}) {
  return reportForRoots([row], all, includeChildren, selectionOverride);
}

function selectionLines(selection) {
  if (!selection) return [];
  const lines = [`Selection: ${selection.method}`];
  if (selection.requestedId) lines.push(`Requested session: ${selection.requestedId}`);
  if (selection.known === true) lines.push('Session identity: known database row');
  if (selection.known === false) lines.push('Session identity: unknown');
  if (selection.candidateSessionIds?.length) lines.push(`Matching candidates: ${selection.candidateSessionIds.join(', ')}`);
  if (selection.rootSessionIds?.length) lines.push(`Task roots: ${selection.rootSessionIds.join(', ')}`);
  if (selection.includedSessionIds?.length) lines.push(`Included sessions (${selection.includedSessionIds.length}): ${selection.includedSessionIds.join(', ')}`);
  if (selection.excludedSessionIds?.length) lines.push(`Excluded descendants (${selection.excludedSessionIds.length}): ${selection.excludedSessionIds.join(', ')}`);
  if (selection.excludedAncestorSessionIds?.length) lines.push(`Excluded ancestors (${selection.excludedAncestorSessionIds.length}): ${selection.excludedAncestorSessionIds.join(', ')}`);
  if (selection.duplicateSuppressedSessionIds?.length) lines.push(`Duplicate-suppressed candidates (${selection.duplicateSuppressedSessionIds.length}): ${selection.duplicateSuppressedSessionIds.join(', ')}`);
  if (selection.ambiguousCandidates?.length) lines.push(`Ambiguous candidates: ${selection.ambiguousCandidates.join(', ')}`);
  if (selection.warning) lines.push(`Selection warning: ${selection.warning}`);
  return lines;
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
    ...selectionLines(report.selection),
    `Calls: ${callCountText(t)} across ${t.models.size} model(s)`,
    `Billing: ${billing.label} — ${billing.evidence}`,
    `Billing mode: ${billing.billingMode}`,
    `Recorded cost: ${cost.label} (${cost.note})`,
    `Actual charge: ${billing.actualChargeUsd === null || billing.actualChargeUsd === undefined ? 'not separately provided' : usd(billing.actualChargeUsd)}`,
    `Reference cost: ${billing.referenceCostUsd === null || billing.referenceCostUsd === undefined ? usd(0) : usd(billing.referenceCostUsd)}`,
    `Cost coverage: ${billing.coverage}`,
    '',
    'Token totals:',
    `  Total: ${integer(u.totalTokens)} (${millions(u.totalTokens)})`,
    `  Input: ${integer(u.inputTokens)} (${millions(u.inputTokens)}, includes cache)`,
    `  Fresh input: ${integer(u.freshInputTokens)} (${millions(u.freshInputTokens)})`,
    `  Cached read: ${integer(u.cacheReadTokens)} (${millions(u.cacheReadTokens)})`,
    `  Cache write: ${integer(u.cacheWriteTokens)} (${millions(u.cacheWriteTokens)})`,
    `  Output: ${integer(u.outputTokens)} (${millions(u.outputTokens)})`,
    `Cache-hit rate: ${(u.cacheHitRate * 100).toFixed(1)}%`,
    '',
    'By model:',
  ];
  for (const model of [...t.models.values()].sort((a, b) => num(b.calls) - num(a.calls))) {
    const state = costState(model);
    lines.push(`  ${model.provider}/${model.model}: ${callCountText(model)} calls, ${millions(num(model.inputTokens) + num(model.outputTokens))} tokens, ${state.label}`);
  }
  if (report.includedChildren) {
    lines.push('', `Included subagent sessions: ${childRows.length}`);
    for (const item of childRows) lines.push(`  + ${item.row.sessionId} — ${clip(item.metrics.title || 'untitled', 55)}`);
    if (report.aggregateFallbacks.length) {
      const fallbackReason = report.missingChildSessionIds.length
        ? `${report.missingChildSessionIds.length} child session(s) have no readable local call ledger`
        : 'one or more selected session ledgers are unavailable';
      lines.push(`Aggregate fallback: ${fallbackReason}; affected root totals use its end-to-end aggregateUsage.`);
    }
  } else if (report.childSessionIds.length) {
    lines.push('', `Excluded subagent sessions: ${report.childSessionIds.length}`, ...report.childSessionIds.map((id) => `  - ${id}`), 'Use --include-children for an end-to-end task total.');
  }
  if (report.ledger.unavailableSessionIds.length) lines.push(`Ledger unavailable for: ${report.ledger.unavailableSessionIds.join(', ')}`);
  if (report.ledger.malformedSessionIds.length) lines.push(`Malformed assistant metrics: ${report.ledger.malformedSessionIds.join(', ')}`);
  if (report.ledger.knownZeroCallSessionIds.length) lines.push(`Known zero-call sessions: ${report.ledger.knownZeroCallSessionIds.join(', ')}`);
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
    const started = timestamp(row.started_at);
    if (started === null) return false;
    if (from !== null && started < from) return false;
    if (to !== null && started > to) return false;
    if (opts.provider && String(row.provider ?? '').toLowerCase() !== opts.provider.toLowerCase()) return false;
    if (opts.model && !String(row.model ?? '').toLowerCase().includes(opts.model.toLowerCase())) return false;
    return true;
  });
}
function selectionPlan(all, kind) {
  let candidates = filterRows(all);
  if (kind === 'today' || opts.mode === 'today') {
    const today = new Date().toISOString().slice(0, 10);
    candidates = candidates.filter((row) => new Date(timestamp(row.started_at)).toISOString().slice(0, 10) === today);
  }
  if (kind === 'last' || opts.mode === 'last') {
    candidates = candidates.filter((row) => !isActiveSessionStatus(row.status));
  }
  const roots = topLevelRows(all, candidates).sort((a, b) => (timestamp(b.started_at) ?? 0) - (timestamp(a.started_at) ?? 0));
  const suppressed = duplicateSuppressedSessionIds(all, candidates);
  return { candidates, roots, duplicateSuppressedSessionIds: suppressed };
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
    `Included sessions: ${older.includedSessionIds.length} / ${newer.includedSessionIds.length}`,
    ...(older.duplicateSuppressedSessionIds.length || newer.duplicateSuppressedSessionIds.length ? [`Duplicate-suppressed candidates: ${unique([...older.duplicateSuppressedSessionIds, ...newer.duplicateSuppressedSessionIds]).join(', ')}`] : []),
    ...(older.selection?.warning ? [`Older selection warning: ${older.selection.warning}`] : []),
    ...(newer.selection?.warning ? [`Newer selection warning: ${newer.selection.warning}`] : []),
  ].join('\n');
}
function renderAggregate(report) {
  if (report.session.id) return render(report);
  return [
    'Session Cost — Filtered aggregate',
    ...selectionLines(report.selection),
    `Task roots: ${report.rootSessionIds.length}`,
    `Included sessions: ${report.includedSessionIds.length}`,
    `Calls: ${callCountText(report.total)} across ${report.total.models.size} model(s)`,
    `Billing: ${report.billing.label} — ${report.billing.evidence}`,
    `Billing mode: ${report.billing.billingMode}`,
    `Recorded cost: ${costState(report.total).label}`,
    `Actual charge: ${report.billing.actualChargeUsd === null || report.billing.actualChargeUsd === undefined ? 'not separately provided' : usd(report.billing.actualChargeUsd)}`,
    `Total tokens: ${integer(report.usage.totalTokens)} (${millions(report.usage.totalTokens)})`,
    `Fresh input: ${integer(report.usage.freshInputTokens)} (${millions(report.usage.freshInputTokens)})`,
    `Cached read: ${integer(report.usage.cacheReadTokens)} (${millions(report.usage.cacheReadTokens)})`,
    `Output: ${integer(report.usage.outputTokens)} (${millions(report.usage.outputTokens)})`,
    `Cache-hit rate: ${(report.usage.cacheHitRate * 100).toFixed(1)}%`,
    ...(report.excludedSessionIds.length ? [`Excluded descendants: ${report.excludedSessionIds.join(', ')}`] : []),
    ...(report.duplicateSuppressedSessionIds.length ? [`Duplicate-suppressed candidates: ${report.duplicateSuppressedSessionIds.join(', ')}`] : []),
  ].join('\n');
}

function accountCredential(dataDir) {
  const credential = resolveClineCredential({ dataDir, environment: process.env });
  if (!credential) die('--account requires CLINE_API_KEY or a valid cline/cline-pass auth entry in data/settings/providers.json (run: cline auth --provider cline)');
  return credential;
}
function renderPeriod(period) {
  return `${usd(period.referenceCostUsd)} reference · ${usd(period.creditsUsedUsd)} credits · ${integer(period.requests)} requests · ${integer(period.totalTokens)} tokens${period.complete === false ? ' · incomplete' : period.complete === null ? ' · completeness unknown' : ''}`;
}
function renderAccount(summary) {
  const plan = summary.plan;
  const limits = summary.usageLimits ?? [];
  const lines = [
    'Cline Account Summary',
    `Account: ${summary.userId}`,
    `History window (UTC): ${summary.windowStart ?? 'unbounded'} → ${summary.windowEnd ?? 'unbounded'}${summary.windowDays === null ? '' : ` (${summary.windowDays} days)`}`,
    `History completeness: ${summary.history.complete ? 'complete' : 'incomplete'}; exact window: ${summary.window.exact ? 'yes' : 'no'}`,
    `Requests: ${integer(summary.requests)} (ClinePass ${integer(summary.clinePassRequests)}, usage-billing ${integer(summary.usageBillingRequests)}, free ${integer(summary.freeRequests)})`,
    `Plan: ${plan ? `${plan.name} (${plan.active ? 'active' : 'inactive'})` : 'none'}`,
    `Balance: ${usd(summary.billingTotals.balanceUsd)}`,
    `Reference cost: ${usd(summary.billingTotals.referenceCostUsd)} (ClinePass ${usd(summary.billingTotals.clinePassReferenceCostUsd)})`,
    `Reference cost coverage: ${summary.billingTotals.referenceCostCoverage}`,
    `Credits used: ${usd(summary.billingTotals.creditsUsedUsd)}`,
    `Actual charge: ${unknownUsd()} (the usage API does not provide a settlement/charge field)`,
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
  for (const week of summary.periods.weekly.slice(0, 4)) lines.push(`  ${week.from}–${week.to}: ${renderPeriod(week)}`);
  lines.push('', 'Recent months:');
  for (const month of summary.periods.monthly.slice(0, 6)) lines.push(`  ${month.from}–${month.to}: ${renderPeriod(month)}`);
  return lines.join('\n');
}
async function runAccount(dataDir) {
  const credential = accountCredential(dataDir);
  const days = Number.isInteger(opts.accountDays) && opts.accountDays > 0 ? opts.accountDays : null;
  if (days === null) die('--account-days must be a positive integer');
  const windowEndMs = Date.now();
  const windowStartMs = windowEndMs - days * 24 * 60 * 60 * 1000;
  const account = await fetchClineAccount({
    apiKey: credential.apiKey,
    userId: opts.accountUserId || credential.userId || null,
    windowStart: new Date(windowStartMs).toISOString(),
    windowEnd: new Date(windowEndMs).toISOString(),
  });
  const summary = summarizeClineAccount(account, new Date(windowEndMs));
  summary.historyDays = days;
  const output = {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: new Date().toISOString(),
    account: summary,
    live: true,
    credentialSource: credential.source,
    credentialExpiresAt: credential.expiresAt ?? null,
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

function emitCurrentReport(report) {
  if (opts.dashboard) {
    const dataDir = path.resolve(opts.dataDir ?? DEFAULT_DATA_DIR);
    const outputPath = writeDashboard(report, {
      outPath: opts.out ?? path.join(dataDir, 'data', 'reports', 'session-cost', 'session-dashboard.html'),
      title: 'Cline Session Cost Dashboard',
    });
    if (opts.json) console.log(JSON.stringify({ schemaVersion: SCHEMA_VERSION, dashboardPath: outputPath, report }, replacer, 2));
    else console.log(`Dashboard written: ${outputPath}`);
  } else if (opts.json) console.log(JSON.stringify(report, replacer, 2));
  else console.log(render(report));
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
    const all = db.prepare('SELECT * FROM sessions ORDER BY started_at, session_id').all();
    if (!all.length) {
      if (opts.session !== null) die(`unknown session id: ${opts.session}`);
      die('Cline session database contains no sessions');
    }
    loadConfig(dataDir);
    if (opts.list !== 0 && (!Number.isInteger(opts.list) || opts.list <= 0)) die('--list requires a positive integer');

    if (opts.session !== null) {
      const selection = resolveSession(all, { explicitId: opts.session });
      if (selection.error) {
        const candidates = selection.ambiguousCandidates?.length ? `; candidates: ${selection.ambiguousCandidates.join(', ')}` : '';
        die(`${selection.error}${candidates}`);
      }
      if (!selection.row) die('no Cline session found');
      const report = reportFor(selection.row, all, opts.includeChildren, selection);
      report.selection = {
        ...report.selection,
        method: selection.method,
        requestedId: selection.requestedId,
        ambiguousCandidates: selection.ambiguousCandidates ?? [],
        warning: selection.warning ?? null,
      };
      if (selection.warning) report.snapshot.warning = selection.warning;
      emitCurrentReport(report);
    } else if (opts.list > 0) {
      const plan = selectionPlan(all, 'list');
      const limit = Number.isInteger(opts.list) && opts.list > 0 ? opts.list : 10;
      const roots = plan.roots.slice(0, limit);
      const reports = roots.map((row) => reportFor(row, all, opts.includeChildren, {
        method: 'list',
        requestedId: null,
        candidateSessionIds: plan.candidates.map((row) => row.session_id),
        duplicateSuppressedSessionIds: plan.duplicateSuppressedSessionIds,
        ambiguousCandidates: [],
      }));
      const output = {
        schemaVersion: SCHEMA_VERSION,
        generatedAt: new Date().toISOString(),
        selection: {
          method: 'list',
          candidateSessionIds: plan.candidates.map((row) => row.session_id),
          rootSessionIds: roots.map((row) => row.session_id),
          includedSessionIds: unique(reports.flatMap((report) => report.includedSessionIds)),
          globalIncludedSessionIds: unique(reports.flatMap((report) => report.includedSessionIds)),
          duplicateSuppressedSessionIds: plan.duplicateSuppressedSessionIds,
          policy: 'select top-level task candidates, then attach descendants recursively',
        },
        sessions: reports,
      };
      if (opts.json) console.log(JSON.stringify(output, replacer, 2));
      else {
        console.log(`Task roots: ${output.selection.rootSessionIds.length}; included sessions: ${output.selection.includedSessionIds.length}`);
        if (output.selection.duplicateSuppressedSessionIds.length) console.log(`Duplicate-suppressed candidates: ${output.selection.duplicateSuppressedSessionIds.join(', ')}`);
        for (const report of reports) {
          const suffix = report.selection.warning ? ` [warning: ${report.selection.warning}]` : '';
          const billing = report.billing;
          console.log(`${report.session.id}  ${billing.label.padEnd(12)}  ${millions(report.usage.totalTokens).padStart(10)}  ${callCountText(report.total).padStart(7)} calls${report.excludedSessionIds.length ? `  excluded:${report.excludedSessionIds.length}` : ''}${suffix}  ${clip(report.session.title, 48)}`);
          if (report.excludedSessionIds.length) console.log(`  excluded descendants: ${report.excludedSessionIds.join(', ')}`);
        }
      }
    } else if (opts.mode === 'compare') {
      const plan = selectionPlan(all, 'compare');
      const roots = plan.roots.slice(0, 2);
      if (roots.length < 2) die('--compare requires at least two matching task sessions');
      const reports = roots.map((row) => reportFor(row, all, opts.includeChildren, {
        method: 'compare',
        requestedId: null,
        candidateSessionIds: plan.candidates.map((row) => row.session_id),
        duplicateSuppressedSessionIds: plan.duplicateSuppressedSessionIds,
        ambiguousCandidates: [],
      }));
      const output = { schemaVersion: SCHEMA_VERSION, generatedAt: new Date().toISOString(), selection: { method: 'compare', candidateSessionIds: plan.candidates.map((row) => row.session_id), rootSessionIds: roots.map((row) => row.session_id), duplicateSuppressedSessionIds: plan.duplicateSuppressedSessionIds }, comparison: { older: reports[1], newer: reports[0] } };
      if (opts.json) console.log(JSON.stringify(output, replacer, 2));
      else console.log(renderCompare(reports[1], reports[0]));
    } else if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
      const kind = opts.mode === 'last' ? 'last' : opts.mode === 'today' ? 'today' : 'filtered';
      const plan = selectionPlan(all, kind);
      if (!plan.roots.length) die('no sessions match the requested filters');
      const label = kind === 'today' ? 'today' : kind === 'last' ? 'last' : 'filtered-range';
      const report = reportForRoots(plan.roots, all, opts.includeChildren, {
        method: label,
        requestedId: null,
        candidateSessionIds: plan.candidates.map((row) => row.session_id),
        duplicateSuppressedSessionIds: plan.duplicateSuppressedSessionIds,
        ambiguousCandidates: [],
      });
      if (opts.json) console.log(JSON.stringify(report, replacer, 2));
      else console.log(renderAggregate(report));
    } else {
      const selection = resolveSession(all, {
        explicitId: null,
        environment: process.env,
        ancestorPids: ancestorPids(),
        logSessionId: logSessionId(dataDir),
      });
      if (selection.error) {
        const candidates = selection.ambiguousCandidates?.length ? `; candidates: ${selection.ambiguousCandidates.join(', ')}` : '';
        die(`${selection.error}${candidates}`);
      }
      if (!selection.row) die('no Cline session found');
      const report = reportFor(selection.row, all, opts.includeChildren, selection);
      report.selection = {
        ...report.selection,
        method: selection.method,
        requestedId: selection.requestedId,
        ambiguousCandidates: selection.ambiguousCandidates ?? [],
        warning: selection.warning ?? null,
      };
      if (selection.warning) report.snapshot.warning = selection.warning;
      emitCurrentReport(report);
    }
  } finally {
    db.close();
  }
}
