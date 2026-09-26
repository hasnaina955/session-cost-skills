#!/usr/bin/env node
// Token usage and provider-rate cost of an OpenCode session.
//
// Usage:
//   node session-cost.mjs                      # the current/active session
//   node session-cost.mjs --session ses_xxx    # a specific session
//   node session-cost.mjs --session ses_xxx --include-children
//   node session-cost.mjs --list 10            # recent sessions with cost
//   node session-cost.mjs --json               # machine-readable output
//
// ## Where the numbers come from
//
// The ledger is read by ./lib/opencode-ledger.mjs, which owns the 1.x/2.x/aggregate
// precedence rule. This file consumes `readUsageRecords` as given and never re-derives which
// store a session's usage came from, because that decision is measured, not guessed. It does
// propagate `source`, so a report can say that a session was priced from a session aggregate
// and therefore carries no per-model split, instead of implying per-call precision it does not
// have.
//
// ## Cost basis
//
// `provider-rate-estimate`, priced through the shared provider-driver registry. OpenCode runs
// against whatever provider the user configured, so unlike the MCode adapter this one ships no
// rate table: rates come from the user's own provider profile. A model with a rate card is
// priced from it, a genuinely free model is genuinely $0, and a model with no card reports
// token counts with the cost unavailable. A missing rate is never rendered as a number.

import path from 'node:path';
import { writeDashboard } from './lib/dashboard.mjs';
import {
  defaultDataDir,
  ledgerPath,
  readLedger,
  USAGE_SOURCE_SESSION_AGGREGATE,
} from './lib/opencode-ledger.mjs';
import {
  REQUIRED_RATE_COMPONENTS,
  createOpenCodeProviderRegistry,
  profileRateRecords,
  resolveWithProviderDriver,
} from './lib/opencode-provider-drivers.mjs';
import { discoverModels, doctorReport, explainModelMatch, renderDiagnostics } from './lib/provider-diagnostics.mjs';
import { importConfig, initConfig, loadEffectiveConfig, publicConfigResult, readConfigFile } from './lib/config.mjs';
import { collectSessionIds, createSessionGraph, selectTopLevelCandidates } from './lib/session-graph.mjs';
import { REPORT_CONTRACT_VERSION, withNormalizedContract } from './lib/report-contract.mjs';
import { formatVersionBanner, versionBanner } from './lib/skill-version.mjs';
import { CliUsageError, parseCliArgs } from './lib/cli-args.mjs';
import { describeStorageError } from './lib/error-boundaries.mjs';
import { renderExplanation } from './lib/explain.mjs';
import { renderCsv } from './lib/csv.mjs';
import { evaluateBudget } from './lib/budget.mjs';
import { createLiveSurface, nextInterval, renderLiveFrame } from './lib/live-view.mjs';

const RUNTIME_ID = 'opencode';
const PER_MILLION = 1_000_000;
const CONTRACT_RUNTIME = Object.freeze({
  id: RUNTIME_ID,
  costBasis: 'provider-rate-estimate',
  storageSource: '.local/share/opencode/opencode.db session, message, and session_message tables',
  inputTokenMeaning: 'excludes-cache',
  reasoningIncludedInOutput: false,
  provenanceKind: 'provider-rate-estimate',
  provenanceSource: 'OpenCode runtime ledger plus provider rate cards from the session-cost config',
  rateSources: [],
});
// A session whose most recent call is this recent is treated as still running, so the report
// can say the totals are a snapshot rather than a final figure.
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const REQUIRED_COMPONENTS = REQUIRED_RATE_COMPONENTS;

const DEFAULT_OPTIONS = Object.freeze({
  session: null,
  mode: 'current',
  list: 0,
  json: false,
  includeChildren: false,
  includeChildrenExplicit: false,
  dataDir: null,
  from: null,
  to: null,
  provider: null,
  model: null,
  configPath: null,
  dashboard: false,
  out: null,
  sessionConfigPath: null,
  configAction: null,
  configImportPath: null,
  diagnostic: null,
});

let opts = { ...DEFAULT_OPTIONS };
let effectiveConfiguration = null;
let lastReport = null;
let quiet = false;

function parseArgs(argv) {
  let options;
  try {
    options = parseCliArgs(argv, { runtimeId: RUNTIME_ID, defaults: DEFAULT_OPTIONS });
  } catch (error) {
    // Parsing runs at module top level, before the main error handler exists, so a usage
    // error must exit directly rather than throwing a CostError nobody catches.
    if (error instanceof CliUsageError) {
      console.error(`session-cost: ${error.message}`);
      process.exit(2);
    }
    throw error;
  }
  options.includeChildrenExplicit = options.includeChildren === true;
  if (options.help) { printHelp(); process.exit(0); }
  if (options.version) { console.log(formatVersionBanner(versionBanner(RUNTIME_ID))); process.exit(0); }
  return options;
}

function printHelp() {
  console.log(`session-cost — token usage and provider-rate cost of an OpenCode session

  --session <ses_...>   session id (default: the current/active session)
  --last                latest session that is not currently active
  --today               sessions started today (UTC)
  --compare             compare the latest two sessions
  --from <YYYY-MM-DD>   include sessions on/after this UTC date
  --to <YYYY-MM-DD>     include sessions on/before this UTC date
  --provider <name>     filter sessions by provider id substring
  --model <name>        filter sessions by model substring
  --include-children    also bill sub-agent sessions parented to the target
  --list [n]            list the n most recent sessions with their cost (default 10)
  --explain             show the arithmetic behind the reported cost
  --csv                 emit CSV, one row per session
  --budget <amount>     warn and exit non-zero when a session passes this amount
  --dashboard           write a self-contained HTML dashboard
  --out <path>          dashboard output path
  --watch               repaint a live view until Ctrl-C (foreground only)
  --watch-interval <ms> idle poll interval (default 3000; active is 500)
  --json                emit JSON instead of the text summary
  --config <path>       load standing-summary settings
  --session-config <p>  load provider/session configuration
  --init-config         create a safe project config template
  --validate-config     validate and print effective configuration
  --export-config       print the effective configuration
  --import-config <p>   validate and import a config file
  --data-dir <path>     OpenCode data dir (default: the user home directory)
  --version             print the installed skill, report-contract, and Node versions
  doctor | --doctor     inspect config and provider drivers
  providers | --providers   list configured/built-in provider drivers
  models discover       list configured models and aliases
  config explain        explain provider/model matching

Cost is estimated from provider rate cards in your session-cost config. A model with no
applicable card is reported with its token counts and an unavailable cost, never as $0.`);
}

// Thrown instead of process.exit(): exiting while handles are still open trips a libuv
// assertion on Windows. The top-level catch sets the exit code instead.
class CostError extends Error {}

function fail(message) {
  throw new CostError(message);
}

// ---------------------------------------------------------------- billing

function emptyAggregate() {
  return {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costInput: 0,
    costOutput: 0,
    costCacheRead: 0,
    costCacheWrite: 0,
    pricedCalls: 0,
    recordedCostUsd: 0,
    callsWithRecordedCost: 0,
    unpricedReasons: new Set(),
    firstTs: null,
    lastTs: null,
  };
}

// A priced call contributes its four component costs. An unpriced call still contributes its
// tokens — they are measured facts — but contributes no cost, and the aggregate remembers why
// so the report can say the total is incomplete rather than silently small.
function accumulate(agg, record, priced) {
  agg.calls += 1;
  agg.inputTokens += record.input_tokens;
  agg.outputTokens += record.output_tokens;
  agg.reasoningTokens += record.reasoning_tokens;
  agg.cacheReadTokens += record.cache_read_tokens;
  agg.cacheWriteTokens += record.cache_write_tokens;
  agg.recordedCostUsd += record.cost_usd;
  if (record.cost_usd > 0) agg.callsWithRecordedCost += 1;
  if (priced.rate) {
    agg.pricedCalls += 1;
    agg.costInput += (record.input_tokens / PER_MILLION) * priced.rate.input;
    agg.costOutput += (record.output_tokens / PER_MILLION) * priced.rate.output;
    agg.costCacheRead += (record.cache_read_tokens / PER_MILLION) * priced.rate.cacheRead;
    agg.costCacheWrite += (record.cache_write_tokens / PER_MILLION) * priced.rate.cacheWrite;
  } else {
    agg.unpricedReasons.add(priced.reason ?? 'no applicable rate');
  }
  const ts = Number(record.ts);
  if (Number.isFinite(ts)) {
    if (agg.firstTs === null || ts < agg.firstTs) agg.firstTs = ts;
    if (agg.lastTs === null || ts > agg.lastTs) agg.lastTs = ts;
  }
  return agg;
}

function finalize(agg) {
  const promptTokens = agg.inputTokens + agg.cacheReadTokens + agg.cacheWriteTokens;
  const totalTokens = promptTokens + agg.outputTokens;
  const totalCost = agg.costInput + agg.costOutput + agg.costCacheRead + agg.costCacheWrite;
  return {
    ...agg,
    unpricedReasons: [...agg.unpricedReasons],
    promptTokens,
    totalTokens,
    totalCost,
    unpricedCalls: agg.calls - agg.pricedCalls,
    rateKnown: agg.calls === agg.pricedCalls,
    cacheRate: promptTokens > 0 ? agg.cacheReadTokens / promptTokens : 0,
    allInUsdPerM: totalTokens > 0 ? (totalCost / totalTokens) * PER_MILLION : 0,
  };
}

// ---------------------------------------------------------------- ledger

async function loadLedgerContext() {
  const dataDir = path.resolve(opts.dataDir ?? defaultDataDir());
  let ledger;
  try {
    ledger = await readLedger(dataDir);
  } catch (error) {
    if (/not found at|is not an OpenCode ledger/.test(error.message)) fail(error.message);
    fail(`OpenCode ledger could not be read (${path.basename(ledgerPath(dataDir))}): ${describeStorageError(error)}`);
  }
  return {
    dataDir,
    file: ledger.file,
    sessions: ledger.sessions,
    usage: ledger.usage,
    coverage: ledger.coverage,
    graph: createSessionGraph(ledger.graphRows, { idKey: 'id', parentKey: 'parent_id' }),
  };
}

function sessionMeta(sessionsById, sessionId) {
  return sessionsById.get(sessionId) ?? null;
}

function usageRecordsFor(ctx, sessionIds) {
  const wanted = new Set(sessionIds);
  return ctx.usage.filter((record) => wanted.has(record.sessionId));
}

/**
 * Build the per-model rate view for one call, or the explicit "unavailable" view when the
 * call cannot be priced. Nothing here ever substitutes zero for a missing rate.
 */
function priceRecord(registry, record) {
  if (!record.model) {
    return {
      rate: null,
      coverage: 'unavailable',
      missingComponents: ['input', 'output', 'cacheRead', 'cacheWrite'],
      providerDriver: null,
      resolvedModel: null,
      providerKey: record.provider ?? '',
      reason: 'the ledger records no model for this call',
    };
  }
  const contextTokens = record.input_tokens + record.output_tokens
    + record.cache_read_tokens + record.cache_write_tokens;
  return resolveWithProviderDriver(registry, {
    provider: record.provider,
    model: record.model,
    at: record.ts,
    contextTokens,
  });
}

function buildSessionReport(ctx, registry, sessionId, includeChildren) {
  const graph = ctx.graph;
  const childIds = [...graph.descendants(sessionId, false)];
  const includedIds = collectSessionIds([sessionId], graph, { includeChildren });
  const ids = [...includedIds];
  const excludedSessionIds = [...graph.descendants(sessionId)].filter((id) => !includedIds.has(id));
  const records = usageRecordsFor(ctx, ids).sort((left, right) => Number(left.ts) - Number(right.ts));

  const total = emptyAggregate();
  const perModel = new Map();
  const perSession = {};
  const sourcesSeen = new Map();

  for (const record of records) {
    const priced = priceRecord(registry, record);
    accumulate(total, record, priced);

    const pkey = String(priced.providerKey ?? record.provider ?? '');
    const key = `${pkey}::${record.model ?? '(unknown)'}`;
    if (!perModel.has(key)) {
      perModel.set(key, {
        ...emptyAggregate(),
        modelId: record.model ?? '(unknown)',
        provider: record.provider ?? null,
        providerKey: pkey,
        resolvedModel: priced.resolvedModel ?? null,
        rateSource: priced.rate ? 'config-profile' : null,
        rateProfileId: priced.rate?.profileId ?? null,
        rateAmounts: priced.rate
          ? { input: priced.rate.input, output: priced.rate.output, cacheRead: priced.rate.cacheRead, cacheWrite: priced.rate.cacheWrite }
          : null,
        rateCurrency: priced.rate?.currency ?? null,
        rateIsFree: priced.rate ? priced.rate.input === 0 && priced.rate.output === 0 && priced.rate.cacheRead === 0 && priced.rate.cacheWrite === 0 : false,
        providerDriver: priced.providerDriver ?? null,
        rateFingerprints: new Set(),
        effectiveFrom: null,
      });
    }
    const entry = perModel.get(key);
    accumulate(entry, record, priced);
    if (priced.rate) {
      for (const fingerprint of priced.rate.rateRecords.map((r) => r.fingerprint)) entry.rateFingerprints.add(fingerprint);
      entry.effectiveFrom = [entry.effectiveFrom, priced.rate.effectiveFrom].filter(Boolean).sort()[0] ?? null;
    }

    if (!perSession[record.sessionId]) perSession[record.sessionId] = emptyAggregate();
    accumulate(perSession[record.sessionId], record, priced);
    sourcesSeen.set(record.source, (sourcesSeen.get(record.source) ?? 0) + 1);
  }

  const sessions = ids.map((id) => {
    const fin = finalize(perSession[id] ?? emptyAggregate());
    const meta = sessionMeta(ctx.sessionsById, id);
    return {
      row: {
        sessionId: id,
        parentSessionId: meta?.parent_id ?? null,
        status: 'completed',
        startedAt: Number.isFinite(fin.firstTs) ? new Date(fin.firstTs).toISOString() : null,
        endedAt: Number.isFinite(fin.lastTs) ? new Date(fin.lastTs).toISOString() : null,
      },
      metrics: {
        inputTokens: fin.inputTokens,
        outputTokens: fin.outputTokens,
        cacheReadTokens: fin.cacheReadTokens,
        cacheWriteTokens: fin.cacheWriteTokens,
        totalTokens: fin.totalTokens,
        calls: fin.calls,
        pricedCalls: fin.pricedCalls,
        unpricedCalls: fin.unpricedCalls,
        cost: fin.rateKnown ? fin.totalCost : null,
        title: meta?.title ?? null,
        source: 'runtime-ledger',
        lastTs: fin.lastTs,
      },
    };
  });

  const models = [...perModel.values()].map((entry) => {
    const fin = finalize(entry);
    return {
      ...fin,
      rateKnown: fin.rateKnown,
      rateCoverage: fin.calls === 0 ? 'no-calls' : fin.rateKnown ? 'complete' : 'unavailable',
      missingRateComponents: fin.rateKnown ? [] : [...REQUIRED_COMPONENTS],
      rateFingerprints: [...entry.rateFingerprints],
      effectiveThrough: null,
    };
  });

  const fin = finalize(total);
  const lastTs = fin.lastTs;
  const snapshotAt = Date.now();
  const meta = sessionMeta(ctx.sessionsById, sessionId);
  // The ledger also records OpenCode's own per-call cost. It is reported as a cross-check
  // only: it is null unless at least one call actually carries one, so an unpriced model can
  // never appear as a recorded $0.00.
  const recordedCost = {
    calls: fin.calls,
    callsWithRecordedCost: fin.callsWithRecordedCost,
    amountUsd: fin.callsWithRecordedCost > 0 ? Number(fin.recordedCostUsd.toFixed(10)) : null,
    basis: 'opencode-per-call-cost',
  };
  const sources = Object.fromEntries(sourcesSeen);
  const aggregateOnly = (sourcesSeen.get(USAGE_SOURCE_SESSION_AGGREGATE) ?? 0) > 0;

  const warnings = [];
  if (aggregateOnly) {
    warnings.push(`some or all usage came from the ${USAGE_SOURCE_SESSION_AGGREGATE} fallback, which carries no per-model split`);
  }
  for (const reason of fin.unpricedReasons) warnings.push(reason);
  if (excludedSessionIds.length) {
    warnings.push(`${excludedSessionIds.length} descendant session(s) were excluded`);
  }

  return {
    sessionId,
    title: meta?.title ?? null,
    agentName: meta?.agent ?? null,
    runtimeVersion: meta?.version ?? null,
    ledgerSchema: meta?.schema ?? null,
    includeChildren,
    rootSessionIds: [sessionId],
    billedSessions: ids,
    includedSessionIds: ids,
    excludedSessionIds,
    duplicateSuppressedSessionIds: [],
    childSessions: childIds,
    childSessionsBilled: includeChildren ? childIds : [],
    perSession: Object.fromEntries(ids.map((id) => {
      const sub = finalize(perSession[id] ?? emptyAggregate());
      return [id, {
        role: id === sessionId ? 'target' : 'child',
        billed: true,
        calls: sub.calls,
        totalTokens: sub.totalTokens,
        cacheRate: sub.cacheRate,
        // Null, not zero, whenever a call in the session had no applicable rate.
        totalCost: sub.rateKnown ? sub.totalCost : null,
        rateKnown: sub.rateKnown,
      }];
    })),
    sessions,
    models,
    multiModel: models.length > 1,
    multiProvider: new Set(models.map((model) => model.providerKey).filter(Boolean)).size > 1,
    providerDrivers: [...new Map(models.filter((m) => m.providerDriver).map((m) => [m.providerDriver.id, m.providerDriver])).values()],
    usageSources: sources,
    usageFromSessionAggregate: aggregateOnly,
    recordedCost,
    rateCoverage: { calls: fin.calls, pricedCalls: fin.pricedCalls, unpricedCalls: fin.unpricedCalls },
    // Provenance names where each rate came from, which for this adapter is a configured
    // provider profile rather than a mirrored table.
    rateSources: [...new Set(models.map((model) => model.rateProfileId).filter(Boolean).map((id) => `config-profile:${id}`))],
    configuration: effectiveConfiguration,
    snapshotAt,
    ledgerLastCallAt: lastTs,
    sessionActive: lastTs !== null && snapshotAt - lastTs < LIVE_WINDOW_MS,
    sourceCoverage: ctx.coverage,
    warnings,
    rateKnown: fin.rateKnown,
    currency: (() => {
      const currencies = [...new Set(models.map((m) => m.rateCurrency).filter(Boolean))];
      return currencies.length === 1 ? currencies[0] : null;
    })(),
    ...fin,
  };
}

function costForSession(ctx, registry, sessionId) {
  return buildSessionReport(ctx, registry, sessionId, opts.includeChildren);
}

function enhanceReport(report, selection = null) {
  const enhanced = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: {
      active: Boolean(report.sessionActive),
      capturedAt: new Date(Number(report.snapshotAt) || Date.now()).toISOString(),
      state: report.sessionActive ? 'snapshot' : 'final',
      lastLedgerActivityAt: Number.isFinite(Number(report.ledgerLastCallAt)) ? new Date(Number(report.ledgerLastCallAt)).toISOString() : null,
    },
    selection,
    usage: {
      totalTokens: report.totalTokens,
      inputTokens: report.inputTokens,
      // `input_tokens` already excludes cache reads, so fresh and cached tokens are never
      // conflated into one rate.
      freshInputTokens: report.inputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      outputTokens: report.outputTokens,
      cacheHitRate: report.cacheRate,
    },
    billing: {
      classification: report.rateKnown ? 'rate-estimated' : 'cost-unavailable',
      currency: report.currency ?? 'USD',
      recordedCostUsd: null,
      estimatedCostUsd: report.rateKnown ? report.totalCost : null,
      rateKnown: report.rateKnown,
    },
    warnings: report.warnings,
    ...report,
  };
  return withNormalizedContract(enhanced, {
    runtime: { ...CONTRACT_RUNTIME, rateSources: report.rateSources },
    selection,
  });
}

// ---------------------------------------------------------------- rendering

const M = (tokens) => (tokens / PER_MILLION).toFixed(4);
const USD = (value) => `$${value.toFixed(6)}`;
const stamp = (ts) => (ts === null || ts === undefined || !Number.isFinite(Number(ts)) ? 'n/a' : `${new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 16)} UTC`);

// Renders a pipe table with per-column alignment so the numbers stay scannable in a
// terminal and still paste cleanly into markdown. `aligns` is 'l' or 'r' per column.
function renderTable(headers, rows, aligns) {
  const cell = (row, index) => (row[index] === undefined || row[index] === null ? '' : String(row[index]));
  const align = aligns && aligns.length === headers.length ? aligns : headers.map(() => 'l');
  const widths = headers.map((_, index) => Math.max(String(headers[index]).length, ...rows.map((row) => cell(row, index).length)));
  const pad = (value, index) => (align[index] === 'r' ? String(value).padStart(widths[index]) : String(value).padEnd(widths[index]));
  const line = (cells) => `| ${cells.map((c, i) => pad(c, i)).join(' | ')} |`;
  const out = [line(headers), `| ${widths.map((w) => '-'.repeat(w)).join(' | ')} |`];
  for (const row of rows) out.push(line(headers.map((_, index) => cell(row, index))));
  return out;
}

const fmtRate = (value) => {
  let text = Number(value).toFixed(6).replace(/0+$/, '');
  if (text.endsWith('.')) text += '00';
  else if (!text.includes('.')) text += '.00';
  return text;
};

/**
 * The single place a cost is rendered.
 *
 * `rateKnown === false` means no applicable rate exists, and that must read as "unknown", not
 * as a dollar amount. The other two states are real numbers: a priced total, and a priced total
 * of zero for a genuinely free model.
 */
function costLabel(report) {
  if (report.calls === 0) return '$0.000000 (no calls)';
  if (!report.rateKnown) return 'cost unavailable';
  return `${USD(report.totalCost)}${report.models.some((m) => m.rateIsFree) ? ' (free model)' : ''}`;
}

function renderText(report, selection = null) {
  const out = [];
  const billedChildren = report.childSessionsBilled.length;
  const unbilledChildren = report.childSessions.length - billedChildren;
  const unpricedModels = report.models.filter((model) => !model.rateKnown);
  const anyPriced = report.models.some((model) => model.rateKnown);
  const modelLabel = report.multiModel
    ? `${report.models.length} models`
    : (report.models[0]?.modelId ?? 'unknown model');
  const providerLabel = report.multiProvider
    ? `${[...new Set(report.models.map((m) => m.providerKey).filter(Boolean))].join(' + ')}`
    : (report.models[0]?.providerKey || report.models[0]?.provider || 'provider unknown');

  out.push(`Session cost — ${report.sessionId}`);
  out.push(`${report.agentName ?? 'unknown agent'} · ${report.runtimeVersion ?? 'unknown version'} · ${modelLabel} · ${providerLabel}${billedChildren ? ` · includes ${billedChildren} sub-agent session(s)` : ''}`);
  if (report.title) out.push(`Task: ${report.title}`);
  out.push(`Window: ${stamp(report.firstTs)} → ${stamp(report.lastTs)} · ${report.calls} LLM call(s)`);
  out.push(`Snapshot: ${stamp(report.snapshotAt)}${report.sessionActive ? ' — session is still active, these totals will grow' : ' (session idle)'}`);
  if (selection?.method) out.push(`Selection: ${selection.method}${selection.requestedId ? ` (${selection.requestedId})` : ''}`);
  if (selection?.warning) out.push(`Selection warning: ${selection.warning}`);
  if (selection?.candidateIds?.length) out.push(`Selection candidates: ${selection.candidateIds.join(', ')}`);
  out.push('');

  // Never print $0.000000 as a headline: with no applicable rate for any model that reads as
  // "this session was free" when the truth is "the cost is unknown".
  if (anyPriced) {
    out.push(`TOTAL COST ${costLabel(report)} for ${M(report.totalTokens)} M tokens — ${USD(report.allInUsdPerM)}/M all-in${report.rateKnown ? '' : ' (priced calls only)'}`);
  } else {
    out.push(`COST UNAVAILABLE — ${M(report.totalTokens)} M tokens were measured, but no model in this session has an applicable rate.`);
    out.push('Token counts below are exact; the cost is unknown, not zero (see "Rates actually billed").');
  }
  out.push('');

  const effective = (cost, tokens) => (tokens > 0 && cost > 0 ? `$${((cost / tokens) * PER_MILLION).toFixed(4)}` : '—');
  const share = (tokens) => (report.promptTokens > 0 ? `${((tokens / report.promptTokens) * 100).toFixed(1)}%` : '—');
  const money = (value) => (anyPriced ? USD(value) : '—');

  out.push('What was used, and what it cost');
  out.push(...renderTable(
    ['Token type', 'Tokens (M)', 'Share of prompt', 'Rate $/M', 'Cost'],
    [
      ['Fresh input (uncached)', M(report.inputTokens), share(report.inputTokens), report.rateKnown ? effective(report.costInput, report.inputTokens) : '—', money(report.costInput)],
      ['Cached prompt read', M(report.cacheReadTokens), share(report.cacheReadTokens), report.rateKnown ? effective(report.costCacheRead, report.cacheReadTokens) : '—', money(report.costCacheRead)],
      ['Cache write', M(report.cacheWriteTokens), share(report.cacheWriteTokens), report.rateKnown ? effective(report.costCacheWrite, report.cacheWriteTokens) : '—', money(report.costCacheWrite)],
      ['Output', M(report.outputTokens), '—', report.rateKnown ? effective(report.costOutput, report.outputTokens) : '—', money(report.costOutput)],
      ['Total', M(report.totalTokens), '—', '—', anyPriced ? USD(report.totalCost) : '—'],
    ],
    ['l', 'r', 'r', 'r', 'r'],
  ));
  out.push(`Cache rate ${(report.cacheRate * 100).toFixed(1)}% of prompt.`);
  if (report.reasoningTokens) {
    out.push(`(Reasoning ${M(report.reasoningTokens)} M is reported separately and is never added to the output row.)`);
  }

  out.push('');
  out.push('Rates actually billed');
  for (const model of report.models) {
    const who = report.multiProvider ? `${model.providerKey} · ` : '';
    if (!model.rateKnown) {
      out.push(`  ${who}${model.modelId} — no applicable rate for ${model.calls} call(s), ${M(model.totalTokens)} M tokens; cost unavailable, not zero`);
      for (const reason of model.unpricedReasons) out.push(`    ${reason}`);
      continue;
    }
    out.push(`  ${who}${model.modelId} — $${fmtRate(model.rateAmounts.input)} in / $${fmtRate(model.rateAmounts.output)} out / $${fmtRate(model.rateAmounts.cacheRead)} cache read / $${fmtRate(model.rateAmounts.cacheWrite)} cache write per 1M`);
    out.push(`    ${model.calls} call(s), ${M(model.totalTokens)} M tokens, ${USD(model.totalCost)}${model.rateIsFree ? ' — every rate component is 0, so this model is genuinely free' : ''}`);
    if (model.rateProfileId) out.push(`    rate source: config profile "${model.rateProfileId}" (${model.rateCurrency})`);
    if (model.effectiveFrom) out.push(`    effective from: ${model.effectiveFrom}`);
    if (model.providerDriver) out.push(`    driver: ${model.providerDriver.id}@${model.providerDriver.version} (${model.providerDriver.fingerprint})`);
    if (model.rateFingerprints.length) out.push(`    rate fingerprints: ${model.rateFingerprints.slice(0, 4).join(', ')}${model.rateFingerprints.length > 4 ? ', ...' : ''}`);
  }
  if (report.rateKnown) {
    out.push(`  priced calls ${report.pricedCalls} of ${report.calls}`);
  } else {
    out.push(`  ! ${report.unpricedCalls} of ${report.calls} call(s) are unpriced and are NOT in the total above.`);
  }

  if (report.usageFromSessionAggregate) {
    out.push('');
    out.push(`Note: this session's usage came from the ${USAGE_SOURCE_SESSION_AGGREGATE} fallback, because neither`);
    out.push('message store held per-call rows for it. Those figures are exact totals but there is no');
    out.push('per-model split behind them, so this report does not claim per-call precision.');
  }
  if (report.recordedCost.amountUsd !== null) {
    out.push(`Runtime cross-check: OpenCode recorded $${report.recordedCost.amountUsd.toFixed(6)} across ${report.recordedCost.callsWithRecordedCost} of ${report.recordedCost.calls} call(s).`);
  }
  if (unbilledChildren > 0) {
    out.push('');
    out.push(`Note: ${unbilledChildren} sub-agent session(s) below this one are NOT included. Add --include-children for the end-to-end task total.`);
  }
  if (report.duplicateSuppressedSessionIds?.length) {
    out.push(`Duplicate-suppressed child selections: ${report.duplicateSuppressedSessionIds.join(', ')}`);
  }

  if (report.multiModel) {
    out.push('');
    out.push('By model');
    out.push(...renderTable(
      ['Provider', 'Model', 'Calls', 'Tokens (M)', 'Cache rate', 'Cost'],
      report.models.map((model) => [
        model.providerKey || '—',
        model.modelId,
        String(model.calls),
        M(model.totalTokens),
        `${(model.cacheRate * 100).toFixed(1)}%`,
        model.rateKnown ? USD(model.totalCost) : 'unavailable',
      ]),
      ['l', 'l', 'r', 'r', 'r', 'r'],
    ));
  }
  if (report.billedSessions.length > 1) {
    out.push('');
    out.push('By session');
    out.push(...renderTable(
      ['Session', 'Role', 'Calls', 'Tokens (M)', 'Cache rate', 'Cost'],
      report.billedSessions.map((id) => {
        const entry = report.perSession[id];
        return [
          id,
          entry.role,
          String(entry.calls),
          M(entry.totalTokens),
          `${(entry.cacheRate * 100).toFixed(1)}%`,
          // Null becomes "unavailable" here, never $0.00.
          entry.rateKnown ? USD(entry.totalCost) : 'unavailable',
        ];
      }),
      ['l', 'l', 'r', 'r', 'r', 'r'],
    ));
  }
  if (!anyPriced) {
    out.push('');
    out.push('No rate source is configured for these models. Add a provider profile with rate cards to your');
    out.push('session-cost config (see --init-config and --doctor) and the cost will be estimated instead.');
  }
  return out.join('\n');
}

// ---------------------------------------------------------------- selection

function parseDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) fail(`invalid date ${value}; expected YYYY-MM-DD`);
  const parsed = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  if (!Number.isFinite(parsed)) fail(`invalid date ${value}; expected YYYY-MM-DD`);
  return parsed;
}

/**
 * Session selection is explicit. An unknown id, an empty ledger, and an ambiguous "current"
 * session each fail with a message and a non-zero exit; none of them falls back to a different
 * session, because reporting another session's cost as if it were the requested one is the one
 * failure that cannot be detected from the output.
 */
function resolveOpenCodeSession(ctx, { explicitId, environment = process.env } = {}) {
  const runtimeId = environment.OPENCODE_SESSION_ID || environment.OPENCODE_THREAD_ID || null;
  const requestedId = explicitId ?? runtimeId;
  if (requestedId) {
    if (!ctx.graph.byId.has(requestedId)) {
      return {
        sessionId: null,
        method: explicitId ? 'explicit' : 'environment',
        requestedId,
        candidateIds: [],
        error: `unknown OpenCode session id: ${requestedId}`,
      };
    }
    return { sessionId: requestedId, method: explicitId ? 'explicit' : 'environment', requestedId, candidateIds: [requestedId] };
  }

  if (ctx.sessions.length === 0) {
    return { sessionId: null, method: 'empty-ledger', requestedId: null, candidateIds: [], error: 'the OpenCode ledger contains no sessions' };
  }

  const lastTsById = new Map();
  for (const record of ctx.usage) {
    const ts = Number(record.ts);
    lastTsById.set(record.sessionId, Math.max(lastTsById.get(record.sessionId) ?? 0, Number.isFinite(ts) ? ts : 0));
  }
  const rows = [...ctx.graph.byId.values()].map((node) => ({
    id: node.id,
    parentId: node.parentId,
    lastTs: lastTsById.get(node.id) ?? Number(sessionMeta(ctx.sessionsById, node.id)?.time_updated ?? 0),
  }));
  const roots = rows
    .filter((row) => !row.parentId)
    .sort((left, right) => right.lastTs - left.lastTs);
  const active = rows.filter((row) => row.lastTs > 0 && Date.now() - row.lastTs < LIVE_WINDOW_MS);
  const activeRoots = active.filter((row) => !row.parentId);

  if (activeRoots.length === 1) {
    return { sessionId: activeRoots[0].id, method: 'unique-active-root', requestedId: null, candidateIds: [activeRoots[0].id] };
  }
  if (activeRoots.length > 1) {
    return {
      sessionId: null,
      method: 'ambiguous-active-root',
      requestedId: null,
      candidateIds: activeRoots.map((row) => row.id),
      error: `multiple active OpenCode root sessions exist (${activeRoots.map((row) => row.id).join(', ')}); pass --session to select one`,
    };
  }
  const fallbackId = roots[0]?.id ?? rows.sort((left, right) => right.lastTs - left.lastTs)[0]?.id ?? null;
  return {
    sessionId: fallbackId,
    method: 'latest-root-fallback',
    requestedId: null,
    candidateIds: (roots[0] ? [roots[0].id] : []),
    warning: 'no active root session was discoverable; selected the most recent root session',
  };
}

function filterSessions(ctx) {
  const from = opts.from ? parseDate(opts.from) : null;
  const to = opts.to ? parseDate(opts.to, true) : null;
  const matches = (sessionId) => {
    const records = ctx.usage.filter((record) => record.sessionId === sessionId);
    const meta = sessionMeta(ctx.sessionsById, sessionId);
    const firstTs = Number(records[0]?.createdTs ?? meta?.time_created ?? 0);
    if (from !== null && firstTs < from) return false;
    if (to !== null && firstTs > to) return false;
    if (opts.provider || opts.model) {
      const providers = records.map((record) => String(record.provider ?? '').toLowerCase());
      const models = records.map((record) => String(record.model ?? '').toLowerCase());
      if (opts.provider && !providers.some((value) => value.includes(opts.provider.toLowerCase()))) return false;
      if (opts.model && !models.some((value) => value.includes(opts.model.toLowerCase()))) return false;
    }
    return true;
  };
  return ctx.sessions.map((session) => session.id).filter(matches);
}

function aggregateReports(reports, { label, duplicateSuppressedSessionIds = [] }) {
  const total = emptyAggregate();
  const perModel = new Map();
  const sources = {};
  for (const report of reports) {
    if (Number.isFinite(Number(report.firstTs))) {
      total.firstTs = total.firstTs === null ? Number(report.firstTs) : Math.min(total.firstTs, Number(report.firstTs));
    }
    if (Number.isFinite(Number(report.lastTs))) {
      total.lastTs = total.lastTs === null ? Number(report.lastTs) : Math.max(total.lastTs, Number(report.lastTs));
    }
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'pricedCalls', 'recordedCostUsd', 'callsWithRecordedCost']) {
      total[field] += Number(report[field]) || 0;
    }
    for (const reason of report.unpricedReasons) total.unpricedReasons.add(reason);
    for (const [source, count] of Object.entries(report.usageSources ?? {})) sources[source] = (sources[source] ?? 0) + count;
    for (const model of report.models) {
      const key = `${model.providerKey}::${model.modelId}`;
      const existing = perModel.get(key) ?? { ...emptyAggregate(), modelId: model.modelId, provider: model.provider, providerKey: model.providerKey, resolvedModel: model.resolvedModel, rateSource: model.rateSource, rateProfileId: model.rateProfileId, rateAmounts: model.rateAmounts, rateCurrency: model.rateCurrency, rateIsFree: model.rateIsFree, providerDriver: model.providerDriver, rateFingerprints: new Set(), effectiveFrom: null };
      for (const field of ['calls', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'pricedCalls', 'recordedCostUsd', 'callsWithRecordedCost']) existing[field] += Number(model[field]) || 0;
      for (const fingerprint of model.rateFingerprints) existing.rateFingerprints.add(fingerprint);
      for (const reason of model.unpricedReasons) existing.unpricedReasons.add(reason);
      perModel.set(key, existing);
    }
  }
  const fin = finalize(total);
  const models = [...perModel.values()].map((entry) => {
    const model = finalize(entry);
    return { ...model, rateKnown: model.rateKnown, rateCoverage: model.calls === 0 ? 'no-calls' : model.rateKnown ? 'complete' : 'unavailable', missingRateComponents: model.rateKnown ? [] : [...REQUIRED_COMPONENTS], rateFingerprints: [...entry.rateFingerprints], effectiveThrough: null };
  });
  const currencies = [...new Set(models.map((model) => model.rateCurrency).filter(Boolean))];
  return {
    ...fin,
    label,
    sessionId: null,
    title: null,
    agentName: null,
    models,
    multiModel: models.length > 1,
    multiProvider: new Set(models.map((model) => model.providerKey).filter(Boolean)).size > 1,
    providerDrivers: [...new Map(models.filter((model) => model.providerDriver).map((model) => [model.providerDriver.id, model.providerDriver])).values()],
    rateSources: [...new Set(models.map((model) => model.rateProfileId).filter(Boolean).map((id) => `config-profile:${id}`))],
    usageSources: sources,
    usageFromSessionAggregate: Boolean(sources[USAGE_SOURCE_SESSION_AGGREGATE]),
    recordedCost: {
      calls: fin.calls,
      callsWithRecordedCost: fin.callsWithRecordedCost,
      amountUsd: fin.callsWithRecordedCost > 0 ? Number(fin.recordedCostUsd.toFixed(10)) : null,
      basis: 'opencode-per-call-cost',
    },
    rateCoverage: { calls: fin.calls, pricedCalls: fin.pricedCalls, unpricedCalls: fin.unpricedCalls },
    configuration: effectiveConfiguration,
    rateKnown: reports.every((report) => report.rateKnown),
    currency: currencies.length === 1 ? currencies[0] : null,
    rootSessionIds: reports.flatMap((report) => report.rootSessionIds),
    includedSessionIds: [...new Set(reports.flatMap((report) => report.includedSessionIds))],
    excludedSessionIds: [...new Set(reports.flatMap((report) => report.excludedSessionIds))],
    duplicateSuppressedSessionIds,
    childSessions: [],
    childSessionsBilled: [],
    perSession: {},
    sessions: reports.flatMap((report) => report.sessions),
    snapshotAt: Date.now(),
    ledgerLastCallAt: fin.lastTs,
    sessionActive: reports.some((report) => report.sessionActive),
    warnings: [...new Set(reports.flatMap((report) => report.warnings))],
  };
}

function renderAggregate(report, label) {
  const out = [`${label} — ${report.rootSessionIds.length} session(s)`, ''];
  out.push(`TOTAL COST ${costLabel(report)} for ${M(report.totalTokens)} M tokens across ${report.calls} LLM call(s)`);
  out.push(`Cache rate ${(report.cacheRate * 100).toFixed(1)}% of prompt · ${report.pricedCalls} of ${report.calls} call(s) priced`);
  out.push('');
  out.push(...renderTable(
    ['Provider', 'Model', 'Calls', 'Tokens (M)', 'Cost'],
    report.models.map((model) => [model.providerKey || '—', model.modelId, String(model.calls), M(model.totalTokens), model.rateKnown ? USD(model.totalCost) : 'unavailable']),
    ['l', 'l', 'r', 'r', 'r'],
  ));
  for (const warning of report.warnings) out.push(`! ${warning}`);
  return out.join('\n');
}

function renderCompare(older, newer) {
  const row = (label, olderValue, newerValue) => {
    const delta = typeof olderValue === 'number' && typeof newerValue === 'number' ? newerValue - olderValue : null;
    return [label, olderValue, newerValue, delta === null ? '—' : `${delta > 0 ? '+' : ''}${delta}`];
  };
  return [
    'Session comparison (older vs newer)',
    '',
    ...renderTable(
      ['Metric', 'Older', 'Newer', 'Delta'],
      [
        row('Session', older.sessionId, newer.sessionId),
        row('Calls', older.calls, newer.calls),
        row('Tokens (M)', M(older.totalTokens), M(newer.totalTokens)),
        row('Cache rate', `${(older.cacheRate * 100).toFixed(1)}%`, `${(newer.cacheRate * 100).toFixed(1)}%`),
        // A cost that is unknown on either side reads as "unavailable" on both columns and
        // no delta, rather than a difference between a number and a zero.
        row('Cost', older.rateKnown ? USD(older.totalCost) : 'unavailable', newer.rateKnown ? USD(newer.totalCost) : 'unavailable'),
      ],
      ['l', 'r', 'r', 'r'],
    ),
  ].join('\n');
}

// ---------------------------------------------------------------- config and diagnostics

function handleConfigAction(configuration) {
  if (!opts.configAction) return false;
  const target = path.resolve(opts.sessionConfigPath ?? configuration.paths.project);
  let actionResult = null;
  if (opts.configAction === 'init') actionResult = initConfig(target);
  else if (opts.configAction === 'import') {
    if (!opts.configImportPath) fail('--import-config requires a path');
    actionResult = importConfig(path.resolve(opts.configImportPath), target);
  } else if (opts.configAction === 'validate') {
    const loaded = readConfigFile(target);
    if (!loaded) fail(`config not found: ${target}`);
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
  // The diagnostics module reads the *config* (providers/models) alongside the layer sources,
  // not the loaded-configuration wrapper, so a configured profile is visible to it. Passing
  // the wrapper would make `doctor` list only the built-in drivers and report a configured
  // provider as unknown.
  const diagnosticConfiguration = {
    ...configuration.config,
    sources: configuration.sources,
    profileSources: configuration.profileSources,
  };
  const knownModels = {};
  const allRecords = [];
  for (const provider of configuration.config.providers ?? []) {
    const records = profileRateRecords(provider);
    knownModels[provider.id] = [...new Set(records.map((record) => record.model))];
    allRecords.push(...records);
  }
  const allKnownModels = [...new Set(Object.values(knownModels).flat())];
  const diagnosticModels = opts.provider && knownModels[opts.provider] ? knownModels[opts.provider] : allKnownModels;
  let report;
  let status = 0;
  if (opts.diagnostic === 'providers') {
    report = { action: 'providers', providers: doctorReport({ configuration: diagnosticConfiguration, runtimeId: RUNTIME_ID }).providers };
  } else if (opts.diagnostic === 'models') {
    report = { action: 'models', models: discoverModels({ configuration: diagnosticConfiguration, runtimeId: RUNTIME_ID, providerId: opts.provider, knownModels }) };
  } else {
    const explanation = opts.provider || opts.model
      ? explainModelMatch({ runtimeId: RUNTIME_ID, providerId: opts.provider, modelId: opts.model, configuration: diagnosticConfiguration, knownModelIds: diagnosticModels, rateRecords: allRecords })
      : null;
    report = { action: opts.diagnostic, ...doctorReport({ configuration: diagnosticConfiguration, runtimeId: RUNTIME_ID, providerId: opts.provider, modelId: opts.model, knownModelIds: diagnosticModels, rateRecords: allRecords }), explanation };
    if (explanation?.status === 'unknown' || explanation?.status === 'ambiguous') status = 2;
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderDiagnostics(report));
  return status;
}

// ---------------------------------------------------------------- main

async function main() {
  effectiveConfiguration = loadEffectiveConfig({
    configPath: opts.sessionConfigPath,
    cli: {
      provider: opts.provider,
      model: opts.model,
      includeChildren: opts.includeChildrenExplicit ? opts.includeChildren : undefined,
    },
  });
  if (handleConfigAction(effectiveConfiguration)) return 0;
  if (opts.diagnostic) return runDiagnostic(effectiveConfiguration);
  if (!opts.provider && effectiveConfiguration.config.runtimeDefaults.provider) opts.provider = effectiveConfiguration.config.runtimeDefaults.provider;
  if (!opts.model && effectiveConfiguration.config.runtimeDefaults.model) opts.model = effectiveConfiguration.config.runtimeDefaults.model;
  if (!opts.includeChildrenExplicit && effectiveConfiguration.config.runtimeDefaults.includeChildren === true) opts.includeChildren = true;

  const registry = createOpenCodeProviderRegistry({
    profiles: effectiveConfiguration.config.providers,
    models: effectiveConfiguration.config.models,
  });

  const ctx = await loadLedgerContext();
  ctx.sessionsById = new Map(ctx.sessions.map((session) => [session.id, session]));
  const candidates = filterSessions(ctx);

  if (opts.list > 0) {
    const topLevel = selectTopLevelCandidates(candidates, ctx.graph);
    const recent = topLevel.includedRootIds.slice(0, opts.list);
    const reports = recent.map((sessionId) => costForSession(ctx, registry, sessionId));
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        contractVersion: REPORT_CONTRACT_VERSION,
        runtime: RUNTIME_ID,
        kind: 'report-list',
        generatedAt: new Date().toISOString(),
        sessions: reports.map((report) => enhanceReport(report, { method: 'list', requestedId: null, candidateIds: recent })),
        duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds,
      }, null, 2));
    } else if (!reports.length) {
      console.log('no sessions match the requested filters');
    } else {
      const clip = (text, max) => (text.length <= max ? text : `${text.slice(0, max - 1)}…`);
      console.log('recent sessions (newest first)\n');
      console.log(renderTable(
        ['Session', 'Cost', 'Cache', 'Tokens (M)', 'Calls', 'Model', 'Task'],
        reports.map((report) => [
          report.sessionId,
          costLabel(report),
          `${(report.cacheRate * 100).toFixed(1)}%`,
          M(report.totalTokens),
          String(report.calls),
          report.models.length > 1 ? `${report.models[0].modelId} +${report.models.length - 1} more` : (report.models[0]?.modelId ?? '?'),
          clip(report.title ?? '', 44),
        ]),
        ['l', 'r', 'r', 'r', 'r', 'l', 'l'],
      ).join('\n'));
      if (topLevel.duplicateSuppressedSessionIds.length) {
        console.log(`Duplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}`);
      }
    }
    return 0;
  }

  if (opts.mode === 'compare') {
    const topLevel = selectTopLevelCandidates(candidates, ctx.graph);
    const recent = topLevel.includedRootIds.slice(0, 2);
    if (recent.length < 2) fail('--compare requires at least two matching sessions');
    const reports = recent.map((sessionId) => costForSession(ctx, registry, sessionId));
    if (opts.json) {
      console.log(JSON.stringify({
        schemaVersion: 1,
        contractVersion: REPORT_CONTRACT_VERSION,
        runtime: RUNTIME_ID,
        kind: 'report-comparison',
        generatedAt: new Date().toISOString(),
        comparison: {
          older: enhanceReport(reports[1], { method: 'compare', requestedId: null, candidateIds: recent }),
          newer: enhanceReport(reports[0], { method: 'compare', requestedId: null, candidateIds: recent }),
        },
        duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds,
      }, null, 2));
    } else {
      console.log(renderCompare(reports[1], reports[0]));
      if (topLevel.duplicateSuppressedSessionIds.length) {
        console.log(`Duplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}`);
      }
    }
    return reports.every((report) => report.rateKnown) ? 0 : 2;
  }

  if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
    let ids = candidates;
    if (opts.mode === 'last') {
      const active = new Set(ctx.usage.filter((record) => Date.now() - Number(record.ts) < LIVE_WINDOW_MS).map((record) => record.sessionId));
      ids = ids.filter((id) => !active.has(id));
    }
    if (opts.mode === 'today') {
      const today = new Date().toISOString().slice(0, 10);
      ids = ids.filter((id) => {
        const meta = sessionMeta(ctx.sessionsById, id);
        const firstTs = Number(ctx.usage.find((record) => record.sessionId === id)?.createdTs ?? meta?.time_created ?? 0);
        return Number.isFinite(firstTs) && new Date(firstTs).toISOString().slice(0, 10) === today;
      });
    }
    if (!ids.length) fail('no sessions match the requested filters');
    const topLevel = selectTopLevelCandidates(ids, ctx.graph);
    const reports = topLevel.includedRootIds.slice(0, 200)
      .map((sessionId) => costForSession(ctx, registry, sessionId));
    if (reports.length === 1) {
      if (opts.json) console.log(JSON.stringify(enhanceReport(reports[0], { method: opts.mode, requestedId: null, candidateIds: topLevel.includedRootIds }), null, 2));
      else console.log(renderText(reports[0]));
    } else {
      const aggregate = aggregateReports(reports, { label: opts.mode === 'today' ? 'sessions started today' : 'filtered range', duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds });
      if (opts.json) {
        console.log(JSON.stringify(enhanceReport(aggregate, { method: opts.mode, requestedId: null, candidateIds: topLevel.includedRootIds }), null, 2));
      } else {
        console.log(renderAggregate(aggregate, aggregate.label));
      }
    }
    return reports.every((report) => report.rateKnown) ? 0 : 2;
  }

  const resolved = resolveOpenCodeSession(ctx, { explicitId: opts.session });
  if (resolved.error) fail(resolved.error);
  if (!resolved.sessionId) fail('the OpenCode ledger contains no known sessions');
  const report = costForSession(ctx, registry, resolved.sessionId);
  const selection = {
    method: resolved.method,
    requestedId: resolved.requestedId,
    candidateIds: resolved.candidateIds,
    warning: resolved.warning,
  };

  if (opts.dashboard) {
    const outputPath = writeDashboard(enhanceReport(report, selection), {
      outPath: opts.out ?? path.join(ctx.dataDir, 'reports', 'session-cost', 'session-dashboard.html'),
      title: 'OpenCode Session Cost Dashboard',
    });
    if (opts.json) {
      console.log(JSON.stringify({ schemaVersion: 1, contractVersion: REPORT_CONTRACT_VERSION, runtime: RUNTIME_ID, kind: 'dashboard', generatedAt: new Date().toISOString(), dashboardPath: outputPath, report: enhanceReport(report, selection) }, null, 2));
    } else {
      console.log(`Dashboard written: ${outputPath}`);
    }
  } else if (opts.csv) {
    if (!quiet) console.log(renderCsv(enhanceReport(report, selection)));
  } else if (opts.json) {
    if (!quiet) console.log(JSON.stringify(enhanceReport(report, selection), null, 2));
  } else if (opts.explain) {
    if (!quiet) console.log(renderExplanation(enhanceReport(report, selection)));
  } else if (!quiet) {
    console.log(renderText(report, selection));
  }
  lastReport = enhanceReport(report, selection);

  if (opts.budget != null) {
    const verdict = evaluateBudget({
      amountUsd: report.rateKnown ? report.totalCost : null,
      budget: opts.budget,
      // A session that did not fully price is reported as unknown rather than guessed either way.
      coverage: report.rateKnown ? 'complete' : 'unknown',
      basis: 'provider-rate-estimate',
      sessionId: report.sessionId ?? null,
    });
    console.error(verdict.message);
    return verdict.exitCode;
  }
  return report.rateKnown ? 0 : 2;
}

// The live view. Foreground only: no daemon, no background process, no orphan to clean up.
// A transient read failure keeps the last good frame and marks it stale rather than ending the
// watch, because a ledger being written mid-poll is normal.
async function watchSession() {
  const surface = createLiveSurface(process.stdout);
  quiet = true;
  let previous = null;
  try {
    for (;;) {
      let staleReason = null;
      try {
        await main();
      } catch (error) {
        staleReason = error instanceof Error ? error.message : String(error);
      }
      if (lastReport) {
        surface.draw(renderLiveFrame(lastReport, { previous, stale: false }));
        previous = lastReport.billing?.amountUsd ?? null;
      } else {
        surface.draw(renderLiveFrame(null, { previous, stale: true, staleReason: staleReason ?? 'no report yet' }));
      }
      await new Promise((resolve) => setTimeout(resolve, nextInterval(lastReport, { activeMs: 500, idleMs: opts.watchInterval ?? 3000 })));
    }
  } finally {
    surface.leave();
  }
}

opts = parseArgs(process.argv.slice(2));

try {
  process.exitCode = opts.watch ? await watchSession() : await main();
} catch (error) {
  if (error instanceof CostError) {
    console.error(`session-cost: ${error.message}`);
    process.exitCode = 2;
  } else {
    // A stack trace names local source paths and can quote a payload fragment. Report what
    // went wrong and keep the detail available behind an explicit opt-in.
    console.error(`session-cost: unexpected failure: ${error?.message ?? String(error)}`);
    if (process.env.SESSION_COST_DEBUG) console.error(error?.stack ?? '');
    process.exitCode = 1;
  }
}
