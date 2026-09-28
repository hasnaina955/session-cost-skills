// The MCode runtime adapter: CommandCode and StepFun rate accounting for MiniMax Code sessions.
// Ledger and rate semantics are documented in ../../references/ledger-internals.md.
//
// This module was the MCode entry point until WP-2.2 moved the orchestration into the shared
// kernel. Everything below is runtime-specific on purpose - where the ledger lives, what a call
// record means, how a session becomes a priced report, and how that report is rendered - because
// those are the places where being wrong produces a plausible number rather than an error.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { KernelError } from './kernel.mjs';
import { COST_BASIS } from './runtime-adapter.mjs';
import { writeDashboard } from './dashboard.mjs';
import { now as nowMs, isoNow, utcDay } from './clock.mjs';
import { createTimeline } from './timeline.mjs';
import { bar, compositionBar } from './term-bars.mjs';
import { observeSchema, checkSchema, describeDrift } from './schema-drift.mjs';
import {
  bandForTimestamp,
  calculateTokenCost,
  inspectRateTable,
  normalizeProvider,
  readRateTable as readValidatedRateTable,
  ratesForBand as resolveBandRates,
  refreshRateTable as refreshRateCatalog,
} from './rates.mjs';
import { createMCodeProviderRegistry, profileRateRecords, resolveWithProviderDriver } from './provider-drivers.mjs';
import { discoverModels, doctorReport, explainModelMatch, renderDiagnostics } from './provider-diagnostics.mjs';
import { importConfig, initConfig, loadEffectiveConfig, publicConfigResult, readConfigFile } from './config.mjs';
import { collectSessionIds, createSessionGraph, selectTopLevelCandidates } from './session-graph.mjs';
import { REPORT_CONTRACT_VERSION, withNormalizedContract } from './report-contract.mjs';
import { formatVersionBanner, versionBanner } from './skill-version.mjs';
import { describeStorageError } from './error-boundaries.mjs';
import { renderExplanation } from './explain.mjs';
import { renderRankingText as renderRanking, renderRollupText as renderRollup } from './rollup.mjs';
import { renderCsv } from './csv.mjs';
import { evaluateBudget } from './budget.mjs';
import { counterfactualCost, renderCounterfactualText } from './counterfactual.mjs';
import { createLiveSurface, nextInterval, renderLiveFrame } from './live-view.mjs';
import { buildProviderProfile, renderSetupText } from './setup.mjs';
import { compareToBaseline, renderInsightsText } from './insights.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_PATH = process.env.SESSION_COST_RATES_PATH
  ? path.resolve(process.env.SESSION_COST_RATES_PATH)
  : path.resolve(__dirname, '..', '..', 'references', 'provider-rates.json');
const PER_MILLION = 1_000_000;
const CONTRACT_RUNTIME = Object.freeze({
  id: 'mcode',
  costBasis: 'provider-rate-estimate',
  storageSource: 'v2/sqlite/runtime-state.sqlite and session message logs',
  inputTokenMeaning: 'excludes-cache',
  reasoningIncludedInOutput: true,
  provenanceKind: 'provider-rate-estimate',
  provenanceSource: 'MCode runtime ledger plus mirrored provider rate tables',
  rateSources: [],
});
// A session whose most recent call is this recent is treated as still running, so the report
// can say the totals are a snapshot rather than a final figure.
const LIVE_WINDOW_MS = 5 * 60 * 1000;


const DEFAULT_OPTIONS = Object.freeze({
  session: null,
  mode: 'current',
  list: 0,
  json: false,
  includeChildren: false,
  includeChildrenExplicit: false,
  refreshRates: false,
  rates: false,
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

/**
 * The option defaults, the help text, and the version banner.
 *
 * These used to be reached through parseArgs/printHelp, which the kernel replaced: the kernel parses
 * argv and answers --help and --version on the runtime's behalf, so the adapter supplies the
 * material and the kernel decides when it is shown. The help text is returned as one string and
 * split by the kernel, which keeps the rendered output byte-identical to the old console.log call.
 */
const HELP_TEXT = `session-cost — token usage and provider-rate cost of a MiniMax Code session

  --session <mvs_...>     session id (default: current/latest session)
  --last                  latest completed session
  --today                 sessions started today (UTC)
  --compare               compare the latest two sessions
  --from <YYYY-MM-DD>     include sessions on/after this UTC date
  --to <YYYY-MM-DD>       include sessions on/before this UTC date
  --provider <name>       filter sessions by provider key
  --model <name>          filter sessions by model substring
  --rates                 show mirrored rate-table coverage and freshness
  --dashboard             write a self-contained HTML dashboard
  --out <path>            dashboard output path
  --include-children      also bill sub-agent sessions parented to the target
  --list [n]              list the n most recent sessions with their cost (default 10)
  --rollup <when>         with --list, total spend per day or per week
  --top <n>               with --list, rank sessions by cost, most expensive first
  --explain               show the arithmetic behind the reported cost
  --csv                   emit CSV, one row per session
  --budget <amount>       warn and exit non-zero when a session passes this amount
  --counterfactual <m>     estimate what this session would cost on model <m>
  --setup                  guided custom-provider setup; prints a paste-ready config
  --insights               compare this session to your own history; no forecasting
  --watch                  repaint a live view until Ctrl-C (foreground only)
  --watch-interval <ms>    idle poll interval (default 3000; active is 500)
  --json                  emit JSON instead of the markdown summary
  --config <path>         load standing-summary settings
  --session-config <path> load provider/session configuration
  --init-config           create a safe project config template
  --validate-config       validate and print effective configuration
  --export-config         print the effective configuration
  --import-config <path>  validate and import a config file
  --refresh-rates         atomically re-fetch and validate CommandCode and StepFun rates
  --data-dir <path>       MiniMax data dir (default: derived from this script's location)
  --version              print the installed skill, report-contract, and Node versions
  doctor | --doctor        inspect config, providers, and rate coverage
  providers | --providers  list configured/built-in provider drivers
  models discover | --models-discover  list provider models and aliases
  config explain | --config-explain   explain provider/model matching`;

// The kernel's KernelError replaces the CostError this file used to define. Both mean "a condition
// the tool understood": exit 2 with one readable line, never a stack. The kernel owns that
// translation now, so the adapter only has to raise it.
function fail(msg) {
  throw new KernelError(msg);
}

// ---------------------------------------------------------------- rates
//
// The table is keyed by provider, then model. Matching on model id alone is not safe once more
// than one provider is mirrored: the same id can exist at two providers at different prices.

async function refreshRates() {
  try {
    const table = await refreshRateCatalog({ ratesPath: RATES_PATH });
    const counts = Object.entries(table.providers ?? {})
      .map(([key, entry]) => `${key}=${Object.keys(entry.models ?? {}).length}`)
      .join(', ');
    console.error(`session-cost: wrote validated rate table (${counts}) -> ${RATES_PATH}`);
    return table;
  } catch (error) {
    fail(error.message);
  }
}

function loadRates() {
  try {
    return readValidatedRateTable(RATES_PATH);
  } catch (error) {
    fail(error.message);
  }
}

const UNPRICED_ZERO_RATE = Object.freeze({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  cacheWriteSource: 'unpriced-call-excluded',
});

// ---------------------------------------------------------------- billing

function emptyAggregate() {
  return {
    calls: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0,
    bands: { peak: 0, offPeak: 0, flat: 0 },
    rateBandsUsed: {},
    firstTs: null, lastTs: null,
  };
}

function accumulate(agg, row, rate, bandOverride) {
  const band = bandOverride ?? bandForTimestamp(row.ts, rate);
  const r = resolveBandRates(rate, band);
  const costs = calculateTokenCost(row, rate, band);
  const input = Number(row.input_tokens) || 0;
  const output = Number(row.output_tokens) || 0;
  const cacheRead = Number(row.cache_read_tokens) || 0;
  const cacheWrite = Number(row.cache_write_tokens) || 0;

  agg.calls += 1;
  agg.inputTokens += input;
  agg.outputTokens += output;
  agg.reasoningTokens += Number(row.reasoning_tokens) || 0;
  agg.cacheReadTokens += cacheRead;
  agg.cacheWriteTokens += cacheWrite;
  agg.costInput += costs.input;
  agg.costOutput += costs.output;
  agg.costCacheRead += costs.cacheRead;
  agg.costCacheWrite += costs.cacheWrite;
  agg.bands[band] = (agg.bands[band] ?? 0) + 1;
  agg.rateBandsUsed[band] = r;
  const ts = Number(row.ts);
  if (agg.firstTs === null || ts < agg.firstTs) agg.firstTs = ts;
  if (agg.lastTs === null || ts > agg.lastTs) agg.lastTs = ts;
  return agg;
}

function finalize(agg) {
  const promptTokens = agg.inputTokens + agg.cacheReadTokens + agg.cacheWriteTokens;
  const totalTokens = promptTokens + agg.outputTokens;
  const totalCost = agg.costInput + agg.costOutput + agg.costCacheRead + agg.costCacheWrite;
  return {
    ...agg,
    promptTokens,
    totalTokens,
    totalCost,
    cacheRate: promptTokens > 0 ? agg.cacheReadTokens / promptTokens : 0,
    blendedInputUsdPerM: promptTokens > 0 ? ((agg.costCacheRead + agg.costInput) / promptTokens) * PER_MILLION : 0,
    allInUsdPerM: totalTokens > 0 ? (totalCost / totalTokens) * PER_MILLION : 0,
  };
}

// ---------------------------------------------------------------- ledger

// The columns this adapter reads, declared once so a runtime that renames one fails loudly
// instead of aggregating `undefined` as zero. Derived from the SELECTs and row accesses below;
// a new column read here must be added here too, which is the point.
const REQUIRED_MCODE_SCHEMA = {
  local_runtime_sessions: [
    'session_id', 'agent_name', 'title', 'parent_session_id', 'history_relative_dir',
  ],
  local_runtime_token_usage: [
    'session_id', 'agent_name', 'turn_id', 'ts',
    'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens',
  ],
};

async function openLedger(dataDir) {
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  if (!fs.existsSync(dbPath)) fail(`ledger not found at ${dbPath}`);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    fail(`this script needs the built-in node:sqlite module (Node 22.15+); running ${process.version}`);
  }
  // A truncated, locked, or non-SQLite file throws from the driver. node:sqlite opens
  // lazily, so probe the schema inside the guard: surface a readable condition naming
  // the ledger, never a raw driver stack trace quoting the install path.
  try {
    const handle = new DatabaseSync(dbPath, { readOnly: true });
    handle.prepare('SELECT session_id FROM local_runtime_token_usage LIMIT 1').all();
    // A renamed column does not throw; the aggregate would read it as zero. Fail by name.
    const verdict = checkSchema(observeSchema(handle, Object.keys(REQUIRED_MCODE_SCHEMA)), REQUIRED_MCODE_SCHEMA);
    const drift = describeDrift(verdict, { runtimeId: 'MiniMax Code' });
    if (drift) fail(drift);
    return handle;
  } catch (error) {
    fail(`MCode ledger could not be read (${path.basename(dbPath)}): ${describeStorageError(error)}`);
  }
}

function sessionMeta(db, sessionId) {
  return db.prepare('SELECT session_id, agent_name, title, parent_session_id, history_relative_dir FROM local_runtime_sessions WHERE session_id = ?').get(sessionId) ?? null;
}

function resolveProviderModel(dataDir, meta) {
  if (!meta?.history_relative_dir) return { provider: null, model: null, source: null };
  const p = path.join(dataDir, 'v2', 'sessions', meta.history_relative_dir, 'llm-call.json');
  if (!fs.existsSync(p)) return { provider: null, model: null, source: null };
  try {
    const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { provider: cfg.provider ?? null, model: cfg.model ?? null, source: p };
  } catch {
    return { provider: null, model: null, source: p };
  }
}

// The ledger records no model per call, and its ts is the *request* time while the persisted
// assistant message is stamped at *completion* (request_duration_ms later). So per-call models
// come from assistant messages keyed by their own timestamp, and nearby unmatched calls inherit
// the nearest recorded call's model. `inferred` calls are counted and disclosed in the report.
function loadCallModels(dataDir, meta) {
  const byTs = new Map();
  if (!meta?.history_relative_dir) return { byTs, tsSorted: [] };
  const p = path.join(dataDir, 'v2', 'sessions', meta.history_relative_dir, 'messages.jsonl');
  if (!fs.existsSync(p)) return { byTs, tsSorted: [] };

  for (const line of fs.readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let parsed;
    try { parsed = JSON.parse(line); } catch { continue; }
    const m = parsed.message;
    if (!m || m.role !== 'assistant' || !m.usage || !m.model) continue;   // older schema rows carry no model
    const ts = Number(m.timestamp);
    if (!Number.isFinite(ts)) continue;
    byTs.set(ts, { model: m.model, provider: m.provider ?? null });
  }
  return { byTs, tsSorted: [...byTs.keys()].sort((a, b) => a - b) };
}

function nearestCallModel(index, ts) {
  const arr = index.tsSorted;
  if (!arr.length) return null;
  let lo = 0;
  let hi = arr.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid] < ts) lo = mid + 1;
    else hi = mid;
  }
  const candidates = [arr[lo], arr[lo - 1]].filter((x) => x !== undefined);
  let best = null;
  let bestDistance = Infinity;
  for (const c of candidates) {
    const d = Math.abs(c - ts);
    if (d < bestDistance) { bestDistance = d; best = c; }
  }
  return index.byTs.get(best) ?? null;
}

// Children are always resolved so the report can state whether sub-agent spend is missing;
// --include-children only decides whether they are folded into the totals.
function loadSessionGraph(db) {
  return createSessionGraph(db.prepare('SELECT session_id, parent_session_id FROM local_runtime_sessions').all());
}

function buildPricer(db, dataDir, table, providerRegistry, sessionId) {
  const meta = sessionMeta(db, sessionId);
  const { provider, model } = resolveProviderModel(dataDir, meta);
  const rateCache = new Map();
  return {
    sessionId,
    meta,
    provider,
    defaultModel: model,
    callIndex: loadCallModels(dataDir, meta),
    // Rate lookup is provider-aware, so the cache key is provider + model.
    rateFor(providerId, modelId, { at, contextTokens }) {
      const cacheKey = `${normalizeProvider(providerId)}::${modelId}::${Math.floor(Number(at) / 3_600_000)}::${contextTokens}`;
      if (!rateCache.has(cacheKey)) {
        rateCache.set(cacheKey, resolveWithProviderDriver(providerRegistry, { provider: providerId, model: modelId, at, contextTokens }));
      }
      return rateCache.get(cacheKey);
    },
  };
}

// Each call is priced against the provider it actually ran on, not the session's last provider.
function modelForRow(pricer, row) {
  const ts = Number(row.ts);
  const exact = pricer.callIndex.byTs.get(ts);
  if (exact) return { modelId: exact.model, provider: exact.provider ?? pricer.provider, inferred: false };
  const near = nearestCallModel(pricer.callIndex, ts);
  if (near) return { modelId: near.model, provider: near.provider ?? pricer.provider, inferred: true };
  return { modelId: pricer.defaultModel, provider: pricer.provider, inferred: true };
}

function buildReport(db, dataDir, table, providerRegistry, graph, sessionId, includeChildren) {
  const childIds = [...graph.descendants(sessionId, false)];
  const includedIds = collectSessionIds([sessionId], graph, { includeChildren });
  const ids = [...includedIds];
  const excludedSessionIds = [...graph.descendants(sessionId)].filter((id) => !includedIds.has(id));
  const pricers = new Map(ids.map((id) => [id, buildPricer(db, dataDir, table, providerRegistry, id)]));
  const target = pricers.get(sessionId);

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`SELECT session_id, agent_name, turn_id, ts, input_tokens, output_tokens, reasoning_tokens, cache_read_tokens, cache_write_tokens FROM local_runtime_token_usage WHERE session_id IN (${placeholders}) ORDER BY ts ASC`).all(...ids);

  const agg = emptyAggregate();
  // Keyed by provider + model: the same model id at two providers must stay separate.
  const perModel = new Map();
  const providersSeen = new Map();
  let inferredRows = 0;

  const priceRow = (pricer, row) => {
    const { modelId, provider, inferred } = modelForRow(pricer, row);
    const contextTokens = ['input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens']
      .reduce((sum, field) => sum + (Number(row[field]) || 0), 0);
    const rateInfo = modelId
      ? pricer.rateFor(provider, modelId, { at: row.ts, contextTokens })
      : {
          key: null,
          rate: null,
          free: false,
          providerKey: normalizeProvider(provider),
          coverage: 'unavailable',
          missingComponents: ['input', 'output', 'cacheRead', 'cacheWrite'],
        };
    return { modelId, provider, inferred, rateInfo, rate: rateInfo.rate ?? null, contextTokens };
  };

  // Emitted for machine-readable output only. A text report has nowhere to put 2,000 events, and
  // adding them there would change every golden file for no reader. This is not a user-facing
  // flag on purpose: a flag only MCode honoured would be a footgun, and `--json` is already the
  // contract for "give me the data".
  const timeline = (opts.json || opts.dashboard) ? createTimeline() : null;

  for (const row of rows) {
    const pricer = pricers.get(row.session_id);
    const { modelId, provider, inferred, rateInfo, rate, contextTokens } = priceRow(pricer, row);
    if (inferred) inferredRows += 1;

    // UNPRICED_ZERO_RATE prices an unknown model at zero, so `rate` being absent is the signal
    // that this call has no cost. The timeline must say null there rather than the zero the
    // accumulator is using to keep the arithmetic total.
    const isPriced = rate != null;
    accumulate(agg, row, rate ?? UNPRICED_ZERO_RATE);
    if (timeline) {
      const costs = isPriced ? calculateTokenCost(row, rate, bandForTimestamp(row.ts, rate)) : null;
      timeline.add({
        t: row.ts,
        sessionId: row.session_id,
        model: modelId ?? null,
        provider: normalizeProvider(provider),
        input: Number(row.input_tokens) || 0,
        output: Number(row.output_tokens) || 0,
        cacheRead: Number(row.cache_read_tokens) || 0,
        cacheWrite: Number(row.cache_write_tokens) || 0,
        costUsd: costs ? (costs.input + costs.output + costs.cacheRead + costs.cacheWrite) : null,
      });
    }

    const pkey = normalizeProvider(provider);
    const key = `${pkey}::${modelId ?? '(unknown)'}`;
    if (!perModel.has(key)) {
      // accumulate() owns the counters; only the identity fields are added on top.
      perModel.set(key, {
        modelId: modelId ?? '(unknown)',
        provider,
        providerKey: pkey,
        rateKey: rateInfo.key,
        rateKnown: Boolean(rate),
        rateIsFree: rateInfo.free,
        rateCurrency: rate?.currency ?? null,
        rateRegion: rate?.region ?? null,
        endpointEnv: rate?.endpointEnv ?? null,
        credentialEnv: rate?.credentialEnv ?? null,
        providerDriver: rateInfo.providerDriver ?? null,
        resolvedModel: rateInfo.resolvedModel ?? modelId,
        rateCoverage: rateInfo.coverage,
        missingRateComponents: new Set(rateInfo.missingComponents ?? []),
        rateRecords: new Map(),
        contextMinTokens: contextTokens,
        contextMaxTokens: contextTokens,
        inferredCalls: 0,
        ...emptyAggregate(),
      });
    }
    const entry = perModel.get(key);
    if (inferred) entry.inferredCalls += 1;
    for (const component of rateInfo.missingComponents ?? []) entry.missingRateComponents.add(component);
    for (const record of rateInfo.rate?.rateRecords ?? []) entry.rateRecords.set(record.id, record);
    entry.contextMinTokens = Math.min(entry.contextMinTokens, contextTokens);
    entry.contextMaxTokens = Math.max(entry.contextMaxTokens, contextTokens);
    if (rate) entry.rateCoverage = 'complete';
    accumulate(entry, row, rate ?? UNPRICED_ZERO_RATE);

    if (pkey) providersSeen.set(pkey, true);
  }

  const perSession = {};
  for (const id of ids) {
    const sub = emptyAggregate();
    for (const row of rows.filter((r) => r.session_id === id)) {
      const { rate } = priceRow(pricers.get(id), row);
      accumulate(sub, row, rate ?? UNPRICED_ZERO_RATE);
    }
    const fin = finalize(sub);
    perSession[id] = { role: id === sessionId ? 'target' : 'child', billed: true, calls: fin.calls, totalTokens: fin.totalTokens, cacheRate: fin.cacheRate, totalCost: fin.totalCost };
  }
  for (const id of excludedSessionIds) {
    perSession[id] = { role: 'child', billed: false, calls: null, totalTokens: null, cacheRate: null, totalCost: null };
  }

  // Parent links and titles, read once, for the session array below.
  const parentById = new Map();
  const titles = new Map();
  try {
    for (const record of db.prepare('SELECT session_id, parent_session_id, title FROM local_runtime_sessions').all()) {
      parentById.set(record.session_id, record.parent_session_id ?? null);
      titles.set(record.session_id, record.title ?? null);
    }
  } catch {
    // A ledger without these columns still reports; the rows just carry null parents.
  }

  // The same per-session array Cline emits, so the shared rollup, cost-centre, and
  // insights modules work on both adapters. Without it they correctly reported
  // "unknown" here, which was honest but left three shipped features half-available.
  // Cost stays null when any call in the session was unpriced, matching the rule that
  // unknown cost is never folded into a total as zero.
  const sessions = ids.map((id) => {
    const sub = emptyAggregate();
    let unpricedCalls = 0;
    let firstTs = null;
    let lastTs = null;
    for (const row of rows.filter((r) => r.session_id === id)) {
      const priced = priceRow(pricers.get(id), row);
      accumulate(sub, row, priced.rate ?? UNPRICED_ZERO_RATE);
      unpricedCalls += priced.missing?.length ? 1 : 0;
      const ts = Number(row.ts);
      if (Number.isFinite(ts)) {
        if (firstTs === null || ts < firstTs) firstTs = ts;
        if (lastTs === null || ts > lastTs) lastTs = ts;
      }
    }
    const fin = finalize(sub);
    return {
      row: {
        sessionId: id,
        parentSessionId: parentById.get(id) ?? null,
        status: 'completed',
        startedAt: firstTs === null ? null : new Date(firstTs).toISOString(),
        endedAt: lastTs === null ? null : new Date(lastTs).toISOString(),
      },
      metrics: {
        inputTokens: fin.inputTokens,
        outputTokens: fin.outputTokens,
        cacheReadTokens: fin.cacheReadTokens,
        cacheWriteTokens: fin.cacheWriteTokens,
        totalTokens: fin.totalTokens,
        calls: fin.calls,
        pricedCalls: fin.calls - unpricedCalls,
        unpricedCalls,
        cost: unpricedCalls > 0 ? null : fin.totalCost,
        title: titles.get(id) ?? null,
        source: 'runtime-ledger',
        lastTs,
      },
    };
  });

  const models = [...perModel.values()].map((model) => {
    const rateRecords = [...model.rateRecords.values()];
    const missingRateComponents = [...model.missingRateComponents].sort();
    const rateKnown = model.calls > 0 && model.rateKnown && missingRateComponents.length === 0;
    const rateCoverage = model.calls === 0
      ? 'no-calls'
      : rateKnown ? 'complete' : rateRecords.length ? 'partial' : 'unavailable';
    return {
      ...finalize(model),
      modelId: model.modelId,
      provider: model.provider,
      providerKey: model.providerKey,
      rateKey: model.rateKey,
      rateKnown,
      rateCoverage,
      missingRateComponents,
      rateIsFree: model.rateIsFree,
      inferredCalls: model.inferredCalls,
      context: { minTokens: model.contextMinTokens, maxTokens: model.contextMaxTokens },
      effectiveFrom: rateRecords.map((record) => record.effectiveFrom).sort()[0] ?? null,
      effectiveThrough: rateRecords.every((record) => record.effectiveThrough)
        ? rateRecords.map((record) => record.effectiveThrough).sort().at(-1) ?? null
        : null,
      rateRecords,
      rateFingerprints: rateRecords.map((record) => record.fingerprint),
    };
  });
  const lastTs = rows.length ? Number(rows[rows.length - 1].ts) : null;
  const snapshotAt = nowMs();

  const providerDrivers = [...new Map(models
    .filter((model) => model.providerDriver)
    .map((model) => [model.providerDriver.id, model.providerDriver])).values()];
  const rateProvenance = [...new Map(models.flatMap((model) => model.rateRecords.map((record) => [record.fingerprint, {
    provider: record.provider,
    model: record.model,
    component: record.component,
    effectiveFrom: record.effectiveFrom,
    effectiveThrough: record.effectiveThrough,
    context: record.context,
    timeBand: record.timeBand,
    source: record.source,
    fingerprint: record.fingerprint,
  }]))).values()];

  const currencies = [...new Set(models.map((model) => model.rateCurrency).filter(Boolean))];
  const currency = currencies.length === 1 ? currencies[0] : null;

  // Per-provider mirror provenance, since a multi-provider session draws on several tables.
  const providersUsed = [...providersSeen].map(([pkey]) => {
    const entry = table.providers?.[pkey];
    return { providerKey: pkey, source: entry?.source ?? null, fetchedAt: entry?.fetchedAt ?? null, mirrored: Boolean(entry) };
  });

  return {
    sessionId,
    title: target.meta?.title ?? null,
    agentName: target.meta?.agent_name ?? null,
    provider: target.provider,
    model: target.defaultModel,
    rateKnown: models.every((m) => m.rateKnown),
    currency,
    isCommandCode: Boolean(target.provider && /commandcode/i.test(target.provider)),
    includeChildren,
    rootSessionIds: [sessionId],
    billedSessions: ids,
    includedSessionIds: ids,
    excludedSessionIds,
    duplicateSuppressedSessionIds: [],
    childSessions: childIds,
    childSessionsBilled: includeChildren ? childIds : [],
    perSession,
    sessions,
    models,
    multiModel: models.length > 1,
    multiProvider: providersUsed.filter((p) => p.mirrored).length > 1,
    providersUsed,
    inferredModelRows: inferredRows,
    snapshotAt,
    // Only present when the timeline was requested; a report that does not need it does not
    // carry 2,000 events through a JSON round trip.
    ...(timeline ? timeline.finalize() : {}),
    ledgerLastCallAt: lastTs,
    sessionActive: lastTs !== null && snapshotAt - lastTs < LIVE_WINDOW_MS,
    ratesRefreshedAt: table._meta?.refreshedAt ?? null,
    configuration: effectiveConfiguration,
    rateCoverage: inspectRateTable(table),
    providerDrivers,
    rateProvenance,
    ...finalize(agg),
  };
}

// ---------------------------------------------------------------- rendering

const M = (tokens) => (tokens / PER_MILLION).toFixed(4);
const USD = (v) => `$${v.toFixed(6)}`;
const stamp = (ts) => (ts === null ? 'n/a' : new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

// Renders a pipe table with per-column alignment so the numbers stay scannable in a
// terminal and still paste cleanly into markdown. `aligns` is 'l' or 'r' per column.
function renderTable(headers, rows, aligns) {
  const cols = headers.length;
  const cell = (r, i) => (r[i] === undefined || r[i] === null ? '' : String(r[i]));
  const align = aligns && aligns.length === cols ? aligns : headers.map(() => 'l');

  const widths = headers.map((_, i) =>
    Math.max(String(headers[i]).length, ...rows.map((r) => cell(r, i).length)));

  const pad = (s, i) => (align[i] === 'r' ? String(s).padStart(widths[i]) : String(s).padEnd(widths[i]));
  const line = (cells) => '| ' + cells.map((c, i) => pad(c, i)).join(' | ') + ' |';

  const out = [line(headers), '| ' + widths.map((w) => '-'.repeat(w)).join(' | ') + ' |'];
  for (const r of rows) out.push(line(headers.map((_, i) => cell(r, i))));
  return out;
}

// One table is the whole point: token count, the rate it was billed at, and what it cost, on the
// same row. Splitting those across tables forces the reader to join rows mentally.
// Rates span $0.003 to $2.70, so a fixed 2-decimal format would round the CommandCode cache-read
// rate to $0.00 and destroy the number that matters most. Keep at least 2 decimals, drop the rest.
const fmtRate = (v) => {
  let s = Number(v).toFixed(4).replace(/0+$/, '');
  if (s.endsWith('.')) s += '00';
  else if (!s.includes('.')) s += '.00';
  else if (s.split('.')[1].length < 2) s += '0';
  return s;
};

function renderText(rep, selection = null) {
  const L = [];
  const billedChildren = rep.childSessionsBilled.length;
  const unbilledChildren = rep.childSessions.length - billedChildren;
  const unpricedModels = rep.models.filter((m) => !m.rateKnown);
  const unpricedTokens = unpricedModels.reduce((n, m) => n + m.totalTokens, 0);
  const unpricedCalls = unpricedModels.reduce((n, m) => n + m.calls, 0);
  const hasUnpriced = unpricedModels.length > 0;
  const anyPriced = rep.models.some((m) => m.rateKnown);
  const rateLabel = rep.multiModel
    ? `${rep.models.length} models`
    : (rep.models[0]?.rateKey ?? rep.model ?? 'unknown model');
  const providerLabel = rep.multiProvider
    ? `${rep.providersUsed.filter((p) => p.mirrored).map((p) => p.providerKey).join(' + ')}`
    : (rep.provider ?? 'provider unknown');

  L.push(`Session cost — ${rep.sessionId}`);
  L.push(`${rep.agentName ?? 'unknown agent'} · ${rateLabel} · ${providerLabel}${billedChildren ? ` · includes ${billedChildren} sub-agent session(s)` : ''}`);
  if (rep.title) L.push(`Task: ${rep.title}`);
  L.push(`Window: ${stamp(rep.firstTs)} → ${stamp(rep.lastTs)} · ${rep.calls} LLM call(s)`);
  L.push(`Snapshot: ${stamp(rep.snapshotAt)}${rep.sessionActive ? ' — session is still active, these totals will grow' : ' (session idle)'}`);
  if (selection?.method) L.push(`Selection: ${selection.method}${selection.requestedId ? ` (${selection.requestedId})` : ''}`);
  if (selection?.warning) L.push(`Selection warning: ${selection.warning}`);
  if (selection?.candidateIds?.length) L.push(`Selection candidates: ${selection.candidateIds.join(', ')}`);
  L.push('');
  // Never print $0.000000 as a headline: with no rate for any model that reads as "this session
  // was free" when the truth is "the cost is unknown".
  if (anyPriced) {
    L.push(`TOTAL COST ${USD(rep.totalCost)} for ${M(rep.totalTokens)} M tokens — ${USD(rep.allInUsdPerM)}/M all-in${hasUnpriced ? ' (priced calls only)' : ''}`);
  } else {
    L.push(`COST UNAVAILABLE — ${M(rep.totalTokens)} M tokens, but none of the models in this session`);
    L.push('are in the mirrored rate tables, so no cost can be computed (see "Rates actually billed").');
  }
  L.push('');

  // Effective rate = what was actually billed per million of that token type. It blends bands and
  // models automatically, so it is the honest number rather than a sticker price.
  const eff = (cost, tokens) => (tokens > 0 && cost > 0 ? `$${((cost / tokens) * PER_MILLION).toFixed(4)}` : '—');
  const share = (t) => (rep.promptTokens > 0 ? `${((t / rep.promptTokens) * 100).toFixed(1)}%` : '—');
  const money = (v) => (anyPriced ? USD(v) : '—');

  L.push('What was used, and what it cost');
  L.push(...renderTable(
    ['Token type', 'Tokens (M)', 'Share of prompt', 'Rate $/M', 'Cost'],
    [
      ['Fresh input (uncached)', M(rep.inputTokens), share(rep.inputTokens), hasUnpriced ? '—' : eff(rep.costInput, rep.inputTokens), money(rep.costInput)],
      ['Cached prompt read', M(rep.cacheReadTokens), share(rep.cacheReadTokens), hasUnpriced ? '—' : eff(rep.costCacheRead, rep.cacheReadTokens), money(rep.costCacheRead)],
      ['Cache write', M(rep.cacheWriteTokens), share(rep.cacheWriteTokens), hasUnpriced ? '—' : eff(rep.costCacheWrite, rep.cacheWriteTokens), money(rep.costCacheWrite)],
      ['Output', M(rep.outputTokens), '—', hasUnpriced ? '—' : eff(rep.costOutput, rep.outputTokens), money(rep.costOutput)],
      ['Total', M(rep.totalTokens), '—', '—', anyPriced ? USD(rep.totalCost) : '—'],
    ],
    ['l', 'r', 'r', 'r', 'r'],
  ));

  // The one insight that matters in agent sessions: most prompt is cache, priced far below fresh.
  // Only claimed when every call was priced — otherwise the effective rates are diluted by
  // unpriced tokens and the ratio would understate the real discount.
  if (!hasUnpriced && rep.cacheReadTokens > 0 && rep.costCacheRead > 0 && rep.costInput > 0) {
    const ratio = (rep.costInput / rep.inputTokens) / (rep.costCacheRead / rep.cacheReadTokens);
    if (ratio >= 2) {
      const n = Math.round(ratio);
      const suffix = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] ?? 'th';
      L.push(`Cache rate ${(rep.cacheRate * 100).toFixed(1)}% of prompt — cached prompt was billed at 1/${n}${suffix} the fresh rate,`);
      L.push(`which is why the all-in ${USD(rep.allInUsdPerM)}/M sits far below the sticker input rate.`);
    }
  } else if (rep.cacheRate > 0) {
    L.push(`Cache rate ${(rep.cacheRate * 100).toFixed(1)}% of prompt.`);
  }

  // Where the tokens went, in one line. Each segment is a distinct glyph as well as a distinct
  // position, so the bar reads without colour, and every figure is repeated in the legend.
  const mix = compositionBar([
    { label: 'fresh input', value: rep.inputTokens },
    { label: 'cached read', value: rep.cacheReadTokens },
    { label: 'cache write', value: rep.cacheWriteTokens },
    { label: 'output', value: rep.outputTokens },
  ], { width: 28 });
  if (mix.bar.trim() !== '') {
    L.push('');
    L.push(`  ${mix.bar}  ${mix.legend}`);
  }
  if (rep.reasoningTokens) {
    L.push(`(Reasoning ${M(rep.reasoningTokens)} M is inside the output row, never added twice.)`);
  }

  L.push('');
  L.push('Rates actually billed');
  for (const m of rep.models) {
    const who = rep.multiProvider ? `${m.providerKey} · ` : '';
    if (!m.rateKnown) {
      const missing = m.missingRateComponents?.length ? `; missing ${m.missingRateComponents.join(', ')}` : '';
      L.push(`  ${who}${m.modelId} — no complete effective rate for ${m.calls} call(s), ${M(m.totalTokens)} M tokens${missing}`);
      continue;
    }
    const bands = Object.entries(m.rateBandsUsed)
      .map(([band, r]) => `${band === 'flat' ? 'flat' : band} $${fmtRate(r.input)} in / $${fmtRate(r.cacheRead)} cache read / $${fmtRate(r.output)} out${r.cacheWrite ? ` / $${fmtRate(r.cacheWrite)} cache write` : ''}`)
      .join(', ');
    L.push(`  ${who}${m.modelId} — ${bands} per 1M  (${m.calls} call(s), ${USD(m.totalCost)})`);
    if (m.providerDriver) L.push(`    driver: ${m.providerDriver.id}@${m.providerDriver.version} (${m.providerDriver.fingerprint})`);
    const effectiveCards = [...new Set((m.rateRecords ?? []).map((record) => (
      `${record.effectiveFrom}..${record.effectiveThrough ?? 'open'} ${record.timeBand} context ${record.context.minTokens}-${record.context.maxTokens ?? 'unbounded'}`
    )))];
    if (effectiveCards.length) L.push(`    effective cards: ${effectiveCards.join('; ')}`);
    if (m.rateFingerprints?.length) L.push(`    rate fingerprints: ${m.rateFingerprints.slice(0, 4).join(', ')}${m.rateFingerprints.length > 4 ? ', ...' : ''}`);
  }
  L.push(`  band split: ${rep.bands.offPeak ?? 0} off-peak · ${rep.bands.peak ?? 0} peak · ${rep.bands.flat ?? 0} flat`);
  if (hasUnpriced && anyPriced) {
    L.push(`  ! ${unpricedCalls} call(s) / ${M(unpricedTokens)} M tokens are unpriced and are NOT in the total above.`);
  }

  if (unbilledChildren > 0) {
    L.push('');
    L.push(`Note: ${unbilledChildren} sub-agent session(s) below this one are NOT included. Add --include-children for the end-to-end task total.`);
  }
  if (rep.duplicateSuppressedSessionIds?.length) {
    L.push(`Duplicate-suppressed child selections: ${rep.duplicateSuppressedSessionIds.join(', ')}`);
  }
  if (rep.inferredModelRows > 0) {
    L.push(`Note: the model was inferred for ${rep.inferredModelRows} of ${rep.calls} call(s) from the nearest recorded call — the ledger does not store a model per call.`);
  }

  // Only when the session genuinely spans models, since that is the only reason to break it out.
  if (rep.multiModel) {
    L.push('');
    L.push('By model');
    // A bar answers "which of these dominates?" at a glance, which is the question a cost report
    // is usually asked. The cost figure stays in its own column: the bar is decoration, never the
    // only copy of a value, and an unpriced model is marked rather than drawn as an empty bar.
    const modelMax = Math.max(...rep.models.map((m) => (m.rateKnown ? Number(m.totalCost) || 0 : 0)), 0);
    L.push(...renderTable(
      ['Provider', 'Model', 'Calls', 'Tokens (M)', 'Cache rate', 'Share', 'Cost'],
      rep.models.map((m) => [
        m.providerKey ?? '—',
        m.modelId,
        String(m.calls),
        M(m.totalTokens),
        `${(m.cacheRate * 100).toFixed(1)}%`,
        m.rateKnown ? bar(m.totalCost, modelMax, { width: 12 }) : 'unpriced',
        m.rateKnown ? USD(m.totalCost) : 'unpriced',
      ]),
      ['l', 'l', 'r', 'r', 'r', 'l', 'r'],
    ));
  }
  if (rep.billedSessions.length > 1) {
    L.push('');
    L.push('By session');
    L.push(...renderTable(
      ['Session', 'Role', 'Calls', 'Tokens (M)', 'Cache rate', 'Cost'],
      rep.billedSessions.map((id) => {
        const s = rep.perSession[id];
        return [id, s.role, String(s.calls), M(s.totalTokens), `${(s.cacheRate * 100).toFixed(1)}%`, USD(s.totalCost)];
      }),
      ['l', 'l', 'r', 'r', 'r', 'r'],
    ));
  }
  L.push('');
  for (const p of rep.providersUsed) {
    if (!p.mirrored) {
      L.push(`Provider "${p.providerKey}" has no mirrored rate table, so its calls could not be priced.`);
      continue;
    }
    L.push(`Rates for ${p.providerKey} mirrored ${p.fetchedAt ?? 'unknown'} from ${p.source}`);
  }
  return L.join('\n');
}

// ---------------------------------------------------------------- shared CLI helpers

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function parseDate(value, endOfDay = false) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value ?? '')) fail(`invalid date ${value}; expected YYYY-MM-DD`);
  const [year, month, day] = value.split('-').map(Number);
  const parsed = Date.parse(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00.000'}Z`);
  const check = new Date(Date.UTC(year, month - 1, day));
  if (!Number.isFinite(parsed) || check.getUTCFullYear() !== year || check.getUTCMonth() !== month - 1 || check.getUTCDate() !== day) fail(`invalid calendar date ${value}`);
  return parsed;
}
function loadConfig(dataDir) {
  const configPath = path.resolve(opts.configPath ?? path.join(dataDir, 'session-cost.json'));
  const values = readJsonFile(configPath) ?? {};
  if (!opts.includeChildrenExplicit && values.includeChildren === true) opts.includeChildren = true;
  return { path: configPath, values };
}
function sessionRows(db) {
  // A schema that parses but lacks the expected tables must fail, not read as zero
  // sessions: an empty successful report would be indistinguishable from real data.
  try {
    return db.prepare('SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS calls FROM local_runtime_token_usage GROUP BY session_id ORDER BY last_ts DESC').all();
  } catch (error) {
    fail(`MCode ledger schema is unreadable: ${describeStorageError(error)}`);
  }
}
function resolveMCodeSession(db, rows, graph, { explicitId, environment = process.env } = {}) {
  const runtimeId = environment.MCODE_SESSION_ID
    || environment.MINIMAX_SESSION_ID
    || environment.MCODE_THREAD_ID
    || null;
  const requestedId = explicitId ?? runtimeId;
  if (requestedId) {
    if (!graph.byId.has(requestedId)) {
      return {
        row: null,
        method: explicitId ? 'explicit' : 'environment',
        requestedId,
        candidateIds: [],
        error: `unknown MCode session id: ${requestedId}`,
      };
    }
    return {
      row: sessionMeta(db, requestedId),
      method: explicitId ? 'explicit' : 'environment',
      requestedId,
      candidateIds: [requestedId],
    };
  }

  const roots = rows
    .filter((row) => !graph.byId.get(row.session_id)?.parentId)
    .sort((left, right) => Number(right.last_ts) - Number(left.last_ts));
  const active = roots.filter((row) => nowMs() - Number(row.last_ts) < LIVE_WINDOW_MS);
  if (active.length === 1) {
    return { row: active[0], method: 'unique-active-root', requestedId: null, candidateIds: [active[0].session_id] };
  }
  if (active.length > 1) {
    return {
      row: null,
      method: 'ambiguous-active-root',
      requestedId: null,
      candidateIds: active.map((row) => row.session_id),
      error: `multiple active MCode root sessions exist (${active.map((row) => row.session_id).join(', ')}); pass --session to select one`,
    };
  }
  const knownSessions = [...graph.byId.keys()];
  const fallbackId = roots[0]?.session_id ?? knownSessions.at(-1) ?? null;
  return {
    row: fallbackId ? sessionMeta(db, fallbackId) : null,
    method: roots.length ? 'latest-root-fallback' : fallbackId ? 'latest-known-zero-call' : 'empty-ledger',
    requestedId: null,
    candidateIds: (roots.length ? roots.slice(0, 2).map((row) => row.session_id) : knownSessions.slice(-2)),
    warning: roots.length
      ? 'no active root session was discoverable; selected the latest root session'
      : fallbackId ? 'no token-usage rows were available; selected the latest known zero-call session' : null,
  };
}

function matchesFilters(db, dataDir, row) {
  const from = opts.from ? parseDate(opts.from) : null;
  const to = opts.to ? parseDate(opts.to, true) : null;
  if (from !== null && Number(row.first_ts) < from) return false;
  if (to !== null && Number(row.first_ts) > to) return false;
  if (!opts.provider && !opts.model) return true;
  const meta = sessionMeta(db, row.session_id);
  const resolved = resolveProviderModel(dataDir, meta);
  if (opts.provider && !String(resolved.provider ?? '').toLowerCase().includes(opts.provider.toLowerCase())) return false;
  if (opts.model && !String(resolved.model ?? '').toLowerCase().includes(opts.model.toLowerCase())) return false;
  return true;
}
function enhanceReport(report, selection = null) {
  const snapshotAt = Number(report.snapshotAt) || nowMs();
  const ledgerLastCallAt = Number(report.ledgerLastCallAt);
  const enhanced = {
    schemaVersion: 1,
    generatedAt: isoNow(),
    snapshot: {
      active: Boolean(report.sessionActive),
      capturedAt: new Date(snapshotAt).toISOString(),
      state: report.sessionActive ? 'snapshot' : 'final',
      lastLedgerActivityAt: Number.isFinite(ledgerLastCallAt) ? new Date(ledgerLastCallAt).toISOString() : null,
    },
    selection,
    usage: {
      totalTokens: report.totalTokens,
      inputTokens: report.inputTokens,
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
      ratesRefreshedAt: report.ratesRefreshedAt,
    },
    ...report,
  };
  return withNormalizedContract(enhanced, {
    runtime: {
      ...CONTRACT_RUNTIME,
      rateSources: (report.providersUsed ?? []).map((provider) => provider.source).filter(Boolean),
    },
    selection,
  });
}
function aggregateMcReports(reports, duplicateSuppressedSessionIds = []) {
  const total = {
    calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, totalCost: 0, totalTokens: 0,
    promptTokens: 0, bands: { peak: 0, offPeak: 0, flat: 0 }, models: new Map(), sessions: [], providerDrivers: new Map(), rateProvenance: new Map(),
  };
  for (const report of reports) {
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'totalCost', 'totalTokens', 'promptTokens']) total[field] += Number(report[field]) || 0;
    for (const band of ['peak', 'offPeak', 'flat']) total.bands[band] += Number(report.bands?.[band]) || 0;
    total.sessions.push(report.sessionId);
    for (const driver of report.providerDrivers ?? []) total.providerDrivers.set(driver.id, driver);
    for (const record of report.rateProvenance ?? []) total.rateProvenance.set(record.fingerprint, record);
    for (const model of report.models) {
      const key = `${model.providerKey}::${model.modelId}`;
      const existing = total.models.get(key) ?? {
        ...model,
        calls: 0,
        totalTokens: 0,
        totalCost: 0,
        missingRateComponents: new Set(),
        rateRecords: new Map(),
        context: { minTokens: Number.POSITIVE_INFINITY, maxTokens: 0 },
      };
      existing.calls += model.calls;
      existing.totalTokens += model.totalTokens;
      existing.totalCost += model.totalCost;
      existing.rateKnown = existing.rateKnown && model.rateKnown;
      for (const component of model.missingRateComponents ?? []) existing.missingRateComponents.add(component);
      for (const record of model.rateRecords ?? []) existing.rateRecords.set(record.id, record);
      existing.context.minTokens = Math.min(existing.context.minTokens, model.context?.minTokens ?? 0);
      existing.context.maxTokens = Math.max(existing.context.maxTokens, model.context?.maxTokens ?? 0);
      total.models.set(key, existing);
    }
  }
  total.cacheRate = total.promptTokens > 0 ? total.cacheReadTokens / total.promptTokens : 0;
  const unique = (values) => [...new Set(values)];
  const aggregatedModels = [...total.models.values()].map((model) => {
    const rateRecords = [...model.rateRecords.values()];
    const missingRateComponents = [...model.missingRateComponents].sort();
    const rateKnown = model.calls > 0 && model.rateKnown && missingRateComponents.length === 0;
    return {
      ...model,
      rateKnown,
      rateCoverage: model.calls === 0 ? 'no-calls' : rateKnown ? 'complete' : rateRecords.length ? 'partial' : 'unavailable',
      missingRateComponents,
      rateRecords,
      rateFingerprints: rateRecords.map((record) => record.fingerprint),
    };
  });
  const aggregateCurrencies = [...new Set(aggregatedModels.map((model) => model.rateCurrency).filter(Boolean))];
  return {
    ...total,
    currency: aggregateCurrencies.length === 1 ? aggregateCurrencies[0] : null,
    models: aggregatedModels,
    rateKnown: reports.every((report) => report.rateKnown),
    providerDrivers: [...total.providerDrivers.values()],
    rateProvenance: [...total.rateProvenance.values()],
    rootSessionIds: reports.map((report) => report.sessionId),
    includedSessionIds: unique(reports.flatMap((report) => report.includedSessionIds)),
    excludedSessionIds: unique(reports.flatMap((report) => report.excludedSessionIds)),
    duplicateSuppressedSessionIds: unique([
      ...duplicateSuppressedSessionIds,
      ...reports.flatMap((report) => report.duplicateSuppressedSessionIds),
    ]),
  };
}
function renderAggregateMc(report, label) {
  return [
    `MCode session cost — ${label}`,
    `Sessions: ${report.sessions.length}`,
    `Included IDs: ${report.includedSessionIds.length}`,
    `Excluded descendants: ${report.excludedSessionIds.length}`,
    `Duplicate-suppressed selections: ${report.duplicateSuppressedSessionIds.length}`,
    `Calls: ${report.calls}`,
    `Total tokens: ${M(report.totalTokens)} M`,
    `Fresh input: ${M(report.inputTokens)} M`,
    `Cached read: ${M(report.cacheReadTokens)} M`,
    `Output: ${M(report.outputTokens)} M`,
    `Cache rate: ${(report.cacheRate * 100).toFixed(1)}%`,
    report.rateKnown ? `Total cost: ${USD(report.totalCost)}` : 'Total cost: unavailable (unpriced calls present)',
  ].join('\n');
}
function renderCompareMc(older, newer) {
  const delta = newer.totalTokens - older.totalTokens;
  return [
    'MCode session cost — comparison',
    `Older: ${older.sessionId} (${stamp(older.ledgerLastCallAt)})`,
    `Newer: ${newer.sessionId} (${stamp(newer.ledgerLastCallAt)})`,
    `Tokens: ${M(older.totalTokens)} M → ${M(newer.totalTokens)} M (${delta >= 0 ? '+' : ''}${M(delta)} M)`,
    `Cache rate: ${(older.cacheRate * 100).toFixed(1)}% → ${(newer.cacheRate * 100).toFixed(1)}%`,
    `Cost: ${older.rateKnown ? USD(older.totalCost) : 'unavailable'} → ${newer.rateKnown ? USD(newer.totalCost) : 'unavailable'}`,
  ].join('\n');
}
function renderRates(table) {
  const coverage = inspectRateTable(table);
  const lines = [
    'MCode rate coverage',
    `Parser: v${coverage.parserVersion ?? 'unknown'}`,
    `Refreshed: ${table._meta?.refreshedAt ?? 'unknown'}`,
    `Published table complete: ${coverage.complete ? 'yes' : 'no'}`,
  ];
  for (const [key, entry] of Object.entries(coverage.providers ?? {})) {
    const components = Object.entries(entry.components ?? {})
      .map(([name, value]) => `${name} ${value.complete ? 'complete' : `${value.completeModels}/${entry.models}`}`)
      .join(', ');
    lines.push(`${key}: ${entry.completeModels}/${entry.models} complete model(s); ${components}`);
    lines.push(`  ${entry.rateRecords} effective rate record(s) from ${entry.effectiveFrom ?? 'unknown'}`);
    if (entry.excludedModels?.length) lines.push(`  source excluded ${entry.excludedModels.length} incomplete model(s): ${entry.excludedModels.slice(0, 8).join(', ')}${entry.excludedModels.length > 8 ? ', ...' : ''}`);
    lines.push(`  source ${entry.source ?? 'unknown'}, fetched ${entry.fetchedAt ?? 'unknown'}`);
  }
  if (!coverage.complete) lines.push(`Issues: ${coverage.issues.join('; ')}`);
  lines.push(`Free models: ${(table.freeModels ?? []).join(', ') || 'none'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- per-run state
//
// These were module-level constants when this file was the entry point: `opts` came from parsing
// process.argv at import time, and `dataDir` was derived from it once. The kernel parses instead,
// so both now arrive through the run context. They stay as plain `let` bindings rather than
// anything cleverer, because the functions below read them by name and a proxy over a string would
// quietly break every path.join(dataDir, ...). Every read still resolves at call time, so the
// code below is unchanged.
//
// beginRun resets all of it, because --watch calls main() once per poll inside one process and a
// poll must not inherit the previous poll's report, quiet flag, or budget verdict.

let opts = DEFAULT_OPTIONS;
let dataDir = null;
let budgetExitCode = 0;
let effectiveConfiguration = null;
let lastReport = null;
let quiet = false;
// The run context the kernel hands to every step. Preflight stashes the rate table and provider
// registry here so the report step reads them instead of loading the table a second time.
let runContext = {};

/** Install the options the kernel parsed, and clear everything a previous run left behind. */
function beginRun(context) {
  opts = { ...context.opts };
  // <dataDir>/skills/session-cost/scripts/lib/ -> four levels up is <dataDir>. This module used to
  // sit beside the entry point, so the count grew by one when it moved into lib/ to be the adapter.
  dataDir = opts.dataDir
    ? path.resolve(opts.dataDir)
    : path.resolve(__dirname, '..', '..', '..', '..');
  budgetExitCode = 0;
  effectiveConfiguration = null;
  lastReport = null;
  quiet = false;
}

function costForSession(db, dataDir, table, providerRegistry, graph, sessionId) {
  return buildReport(db, dataDir, table, providerRegistry, graph, sessionId, opts.includeChildren);
}

function handleConfigAction(configuration) {
  if (!opts.configAction) return false;
  const target = path.resolve(opts.sessionConfigPath ?? configuration.paths.project);
  let actionResult = null;
  if (opts.configAction === 'init') actionResult = initConfig(target);
  else if (opts.configAction === 'import') {
    if (!opts.configImportPath) fail('--import-config requires a path');
    actionResult = importConfig(path.resolve(opts.configImportPath), target);
  }
  else if (opts.configAction === 'validate') {
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

// Guided setup, matching the Cline adapter. READ-ONLY by design: it prints a paste-ready
// config rather than writing one, so no value can reach a file through this path.
function runSetup(configuration) {
  const target = path.resolve(opts.sessionConfigPath ?? configuration.paths.project);
  const existing = configuration.config.providers ?? [];
  const result = buildProviderProfile({
    id: opts.provider ?? existing[0]?.id ?? '',
    driverId: existing[0]?.driverId ?? 'openai-compatible',
    baseUrlEnv: existing[0]?.baseUrlEnv ?? '',
    endpointEnv: existing[0]?.endpointEnv ?? '',
    credentialEnv: existing[0]?.credentialEnv ?? '',
    region: existing[0]?.region ?? '',
    currency: existing[0]?.currency ?? 'USD',
    runtimes: existing[0]?.match?.runtimes ?? ['mcode'],
    rateCards: existing[0]?.rateCards ?? [],
  });
  console.log(renderSetupText({ result, configPath: target, runtimeId: 'mcode' }));
  if (result.ok) {
    console.log('');
    console.log('  Paste this into the providers array of ' + path.basename(target) + ':');
    console.log(JSON.stringify({ providers: [result.profile] }, null, 2).split('\n').map((line) => '  ' + line).join('\n'));
  }
  return result.ok ? 0 : 2;
}

async function runDiagnostic(configuration) {
  const table = loadRates();
  // The storage block reports which ledger layout this run read. It is best-effort: `doctor`
  // must still work when the ledger is absent or unreadable, because that is exactly when
  // someone runs it. A hard failure is raised by the report path, not here.
  let storage = null;
  try {
    const handle = await openLedger(dataDir);
    try {
      storage = checkSchema(observeSchema(handle, Object.keys(REQUIRED_MCODE_SCHEMA)), REQUIRED_MCODE_SCHEMA);
    } finally {
      handle.close();
    }
  } catch { /* doctor still reports configuration and providers without a ledger */ }
  const knownModels = Object.fromEntries(Object.entries(table.providers ?? {}).map(([id, provider]) => [id, Object.keys(provider.models ?? {})]));
  const configuredRecords = (configuration.config.providers ?? []).flatMap(profileRateRecords);
  for (const provider of configuration.config.providers ?? []) {
    knownModels[provider.id] = [...new Set(profileRateRecords(provider).map((record) => record.model))];
  }
  const allRecords = [
    ...Object.values(table.providers ?? {}).flatMap((provider) => provider.rateRecords ?? []),
    ...configuredRecords,
  ];
  const allKnownModels = [...new Set(Object.values(knownModels).flat())];
  const diagnosticModels = opts.provider && knownModels[opts.provider] ? knownModels[opts.provider] : allKnownModels;
  let report;
  let status = 0;
  if (opts.diagnostic === 'providers') {
    report = { action: 'providers', providers: doctorReport({ configuration, runtimeId: 'mcode' }).providers };
  } else if (opts.diagnostic === 'models') {
    report = { action: 'models', models: discoverModels({ configuration, runtimeId: 'mcode', providerId: opts.provider, knownModels }) };
  } else {
    const explanation = opts.provider || opts.model
      ? explainModelMatch({ runtimeId: 'mcode', providerId: opts.provider, modelId: opts.model, configuration, knownModelIds: diagnosticModels, rateRecords: allRecords })
      : null;
    report = { action: opts.diagnostic, ...doctorReport({ configuration, runtimeId: 'mcode', providerId: opts.provider, modelId: opts.model, knownModelIds: diagnosticModels, rateRecords: allRecords, storage }), explanation };
    if (explanation?.status === 'unknown' || explanation?.status === 'ambiguous') status = 2;
  }
  console.log(opts.json ? JSON.stringify(report, null, 2) : renderDiagnostics(report));
  return status;
}

// The steps, split out of what used to be the top of main(). Each one is named and ordered by the
// kernel; the bodies are the same statements in the same sequence, so a report cannot change because
// of where a line now lives.

// Load the effective configuration: the CLI flags, then the project file, then the user file, with
// the runtime's own defaults applied by loadEffectiveConfig.
function loadRunConfig(context) {
  effectiveConfiguration = loadEffectiveConfig({
    configPath: opts.sessionConfigPath,
    cli: {
      provider: opts.provider,
      model: opts.model,
      includeChildren: opts.includeChildrenExplicit ? opts.includeChildren : undefined,
    },
  });
  context.effectiveConfiguration = effectiveConfiguration;
  return effectiveConfiguration;
}

// --init-config, --validate-config, --export-config, --import-config. An exit code here means the
// run is over: there is no session to report afterwards.
function runConfigAction(context) {
  if (handleConfigAction(context.effectiveConfiguration)) return 0;
  return undefined;
}

// Fold the standing runtime defaults into the options. A flag on the command line always wins, which
// is why each assignment is guarded and includeChildren is guarded by includeChildrenExplicit.
function applyRuntimeDefaults(configuration) {
  if (!opts.provider && configuration.config.runtimeDefaults.provider) opts.provider = configuration.config.runtimeDefaults.provider;
  if (!opts.model && configuration.config.runtimeDefaults.model) opts.model = configuration.config.runtimeDefaults.model;
  if (!opts.includeChildrenExplicit && configuration.config.runtimeDefaults.includeChildren === true) opts.includeChildren = true;
  return undefined;
}

// --refresh-rates and --rates, plus loading the rate table and provider registry every report needs.
// The results are stashed on the run context so main() does not load the table a second time.
async function runPreflight(configuration) {
  if (opts.refreshRates) await refreshRates();
  const table = loadRates();
  const providerRegistry = createMCodeProviderRegistry(table, {
    profiles: configuration.config.providers,
    models: configuration.config.models,
  });
  runContext.table = table;
  runContext.providerRegistry = providerRegistry;

  if (!opts.rates) return undefined;

  const output = {
    schemaVersion: 1,
    generatedAt: isoNow(),
    configuration: publicConfigResult(configuration),
    rates: {
      refreshedAt: table._meta?.refreshedAt ?? null,
      providers: Object.fromEntries(Object.entries(table.providers ?? {}).map(([key, entry]) => [key, { models: Object.keys(entry.models ?? {}).length, source: entry.source ?? null, fetchedAt: entry.fetchedAt ?? null }])),
      coverage: inspectRateTable(table),
      freeModels: table.freeModels ?? [],
    },
  };
  if (opts.dashboard) {
    const outputPath = writeDashboard(output, { outPath: opts.out ?? path.join(dataDir, 'reports', 'session-cost', 'rates-dashboard.html'), title: 'MCode Rate Coverage Dashboard' });
    if (opts.json) console.log(JSON.stringify({ ...output, dashboardPath: outputPath }, null, 2));
    else console.log(`Dashboard written: ${outputPath}`);
  } else if (opts.json) console.log(JSON.stringify(output, null, 2));
  else console.log(renderRates(table));
  return 0;
}

async function main(context) {
  const { table, providerRegistry } = context;

  const db = await openLedger(dataDir);

  try {
    loadConfig(dataDir);
    const allRows = sessionRows(db);
    const candidates = allRows.filter((row) => matchesFilters(db, dataDir, row));
    const graph = loadSessionGraph(db);
    const rowsById = new Map(allRows.map((row) => [row.session_id, row]));

    if (opts.list > 0) {
      const topLevel = selectTopLevelCandidates(candidates.map((row) => row.session_id), graph);
      const recent = topLevel.includedRootIds.slice(0, opts.list);
      const reports = recent.map((sessionId) => costForSession(db, dataDir, table, providerRegistry, graph, sessionId));
      const out = reports.map((rep, index) => {
        const r = rowsById.get(recent[index]);
        const priced = rep.models.filter((m) => m.rateKnown).length;
        const unpricedCalls = rep.models.filter((m) => !m.rateKnown).reduce((n, m) => n + m.calls, 0);
        return {
          sessionId: r.session_id,
          title: rep.title,
          models: rep.models.map((m) => m.modelId),
          calls: rep.calls,
          totalTokens: rep.totalTokens,
          cacheRate: rep.cacheRate,
          costLabel: priced > 0 ? `${USD(rep.totalCost)}${unpricedCalls ? '*' : ''}` : 'rate unknown',
          includedSessionIds: rep.includedSessionIds,
          excludedSessionIds: rep.excludedSessionIds,
          duplicateSuppressedSessionIds: rep.duplicateSuppressedSessionIds,
          partial: priced > 0 && unpricedCalls > 0,
          lastTs: Number(r.last_ts),
        };
      });

      if (opts.json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          contractVersion: REPORT_CONTRACT_VERSION,
          runtime: 'mcode',
          kind: 'report-list',
          generatedAt: isoNow(),
          sessions: reports.map((report) => enhanceReport(report, {
            method: 'list',
            requestedId: null,
            candidateIds: recent,
          })),
          duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds,
        }, null, 2));
      } else if (opts.rollup) {
        // MCode reports carry no per-session rows yet, so this reports the gap rather
        // than a confident $0.00. See the note inside the renderer.
        console.log(renderRollup(reports, opts.rollup, { basis: 'provider-rate-estimate' }));
      } else if (opts.top) {
        console.log(renderRanking(reports, opts.top));
      } else {
        const clip = (s, n) => (s.length <= n ? s : s.slice(0, n - 1) + '…');
        console.log('recent sessions (newest first)\n');
        console.log(renderTable(
          ['Session', 'Cost', 'Cache', 'Tokens (M)', 'Calls', 'Model', 'Task'],
          out.map((r) => [
            r.sessionId,
            r.costLabel,
            `${(r.cacheRate * 100).toFixed(1)}%`,
            M(r.totalTokens),
            String(r.calls),
            r.models.length > 1 ? `${r.models[0]} +${r.models.length - 1} more` : (r.models[0] ?? '?'),
            clip(r.title ?? '', 44),
          ]),
          ['l', 'r', 'r', 'r', 'r', 'l', 'l'],
        ).join('\n'));
        if (out.some((r) => r.partial)) {
          console.log('\n* partial: priced calls only — that session also has unpriced calls (see the per-session report).');
        }
        if (topLevel.duplicateSuppressedSessionIds.length) {
          console.log(`Duplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}`);
        }
      }
      return 0;
    }

    if (opts.mode === 'compare') {
      const topLevel = selectTopLevelCandidates(candidates.map((row) => row.session_id), graph);
      const reports = topLevel.includedRootIds.slice(0, 2)
        .map((sessionId) => costForSession(db, dataDir, table, providerRegistry, graph, sessionId));
      if (reports.length < 2) fail('--compare requires at least two matching sessions');
      if (opts.json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          contractVersion: REPORT_CONTRACT_VERSION,
          runtime: 'mcode',
          kind: 'report-comparison',
          generatedAt: isoNow(),
          comparison: {
            older: enhanceReport(reports[1], { method: 'compare', requestedId: null, candidateIds: topLevel.includedRootIds }),
            newer: enhanceReport(reports[0], { method: 'compare', requestedId: null, candidateIds: topLevel.includedRootIds }),
          },
          duplicateSuppressedSessionIds: topLevel.duplicateSuppressedSessionIds,
        }, null, 2));
      } else {
        console.log(renderCompareMc(reports[1], reports[0]));
        if (topLevel.duplicateSuppressedSessionIds.length) {
          console.log(`Duplicate-suppressed child selections: ${topLevel.duplicateSuppressedSessionIds.join(', ')}`);
        }
      }
      return reports.every((report) => report.rateKnown) ? 0 : 2;
    }

    if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
      let rows = candidates;
      if (opts.mode === 'last') rows = rows.filter((row) => nowMs() - Number(row.last_ts) >= LIVE_WINDOW_MS).slice(0, 1);
      if (opts.mode === 'today') {
        const today = utcDay();
        rows = rows.filter((row) => new Date(Number(row.first_ts)).toISOString().slice(0, 10) === today);
      }
      if (!rows.length) fail('no sessions match the requested filters');
      const topLevel = selectTopLevelCandidates(rows.map((row) => row.session_id), graph);
      const reports = topLevel.includedRootIds.slice(0, 200)
        .map((sessionId) => costForSession(db, dataDir, table, providerRegistry, graph, sessionId));
      if (reports.length === 1) {
        reports[0].duplicateSuppressedSessionIds = topLevel.duplicateSuppressedSessionIds;
        if (opts.json) console.log(JSON.stringify(enhanceReport(reports[0], { method: opts.mode, requestedId: null, candidates: reports.map((r) => r.sessionId) }), null, 2));
        else console.log(renderText(reports[0]));
      } else {
        const aggregate = aggregateMcReports(reports, topLevel.duplicateSuppressedSessionIds);
        if (opts.json) console.log(JSON.stringify({
          schemaVersion: 1,
          contractVersion: REPORT_CONTRACT_VERSION,
          runtime: 'mcode',
          kind: 'report',
          ...enhanceReport(aggregate, {
            method: opts.mode,
            requestedId: null,
            candidateIds: topLevel.includedRootIds,
          }),
          models: aggregate.models,
        }, null, 2));
        else console.log(renderAggregateMc(aggregate, opts.mode === 'today' ? 'today' : 'filtered range'));
      }
      return reports.every((report) => report.rateKnown) ? 0 : 2;
    }

    const resolved = resolveMCodeSession(db, allRows, graph, { explicitId: opts.session });
    if (resolved.error) fail(resolved.error);
    if (!resolved.row) fail('MCode ledger contains no known sessions');
    const sessionId = resolved.row.session_id;
    const report = costForSession(db, dataDir, table, providerRegistry, graph, sessionId);
    const selection = {
      method: resolved.method,
      requestedId: resolved.requestedId,
      candidateIds: resolved.candidateIds,
      warning: resolved.warning,
    };

    if (opts.dashboard) {
      const outputPath = writeDashboard(enhanceReport(report, selection), { outPath: opts.out ?? path.join(dataDir, 'reports', 'session-cost', 'session-dashboard.html'), title: 'MCode Session Cost Dashboard' });
      if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, contractVersion: REPORT_CONTRACT_VERSION, runtime: 'mcode', kind: 'dashboard', generatedAt: isoNow(), dashboardPath: outputPath, report: enhanceReport(report, selection) }, null, 2));
      else console.log(`Dashboard written: ${outputPath}`);
    } else if (opts.insights) {
      // Measured history only. Insights never forecasts and never replaces the report.
      const rows = (report.sessions ?? []).map((entry) => ({
        row: { sessionId: entry.row?.sessionId, startedAt: entry.row?.startedAt },
        metrics: entry.metrics,
      }));
      console.log(renderText(report, selection));
      if (rows.length) {
        console.log('');
        console.log(renderInsightsText(compareToBaseline(rows[0], rows)));
      } else {
        console.log('');
        console.log('Insights need per-session history, which this report does not carry.');
      }
    } else if (opts.counterfactual) {
      // Opt-in only, and strictly after the normal report. The reported cost is untouched.
      const enhanced = enhanceReport(report, selection);
      const table = readValidatedRateTable(RATES_PATH);
      const records = Object.values(table.providers ?? {}).flatMap((provider) => provider.rateRecords ?? [])
        .filter((record) => record.model === opts.counterfactual);
      console.log(renderText(report, selection));
      console.log('');
      console.log(renderCounterfactualText(enhanced, counterfactualCost(enhanced, {
        model: opts.counterfactual,
        rateRecords: records,
        contextTokens: report.totalTokens ?? null,
        at: report.lastTs ?? null,
      })));
    } else if (opts.csv) {
      if (!quiet) console.log(renderCsv(enhanceReport(report, selection)));
    }
    else if (opts.json) { if (!quiet) console.log(JSON.stringify(enhanceReport(report, selection), null, 2)); }
    else if (opts.explain) { if (!quiet) console.log(renderExplanation(enhanceReport(report, selection))); }
    else if (!quiet) console.log(renderText(report, selection));
    lastReport = enhanceReport(report, selection);

    if (opts.budget != null) {
      const verdict = evaluateBudget({
        amountUsd: report.totalCost ?? null,
        budget: opts.budget,
        // The internal report carries rateKnown, not a coverage status. A session that
        // did not fully price is reported as unknown rather than guessed either way.
        coverage: report.rateKnown ? 'complete' : 'unknown',
        basis: 'provider-rate-estimate',
        sessionId: report.sessionId ?? null,
      });
      console.error(verdict.message);
      budgetExitCode = verdict.exitCode;
    }

    return Math.max(report.rateKnown ? 0 : 2, budgetExitCode);
  } finally {
    db.close();
  }
}

// The live view. Foreground only: no daemon, no background process, no orphan to clean up.
// Each poll re-queries the same ledger in-process. A transient read failure keeps the last
// good frame and marks it stale rather than ending the watch, because a ledger being written
// mid-poll is normal and is not a reason to stop watching.
async function watchSession() {
  const surface = createLiveSurface(process.stdout);
  quiet = true;
  let previous = null;
  // Motion state. The frame counter and the cost history are the view's only memory; both are
  // derived from the report the loop already produces, so the animation cannot invent a figure.
  // The cost history is bounded because a long-running watch would otherwise grow it without
  // limit, and the frame only ever renders the last dozen samples anyway.
  let frameIndex = 0;
  const history = [];
  const motion = {
    color: surface.interactive,
    width: process.stdout.columns,
    budgetUsd: typeof opts.budget === 'number' ? opts.budget : null,
  };
  try {
    for (;;) {
      let staleReason = null;
      try {
        await main();
      } catch (error) {
        staleReason = error instanceof Error ? error.message : String(error);
      }
      if (lastReport) {
        const current = lastReport.billing?.amountUsd ?? null;
        if (typeof current === 'number') {
          history.push(current);
          if (history.length > 24) history.shift();
        }
        surface.draw(renderLiveFrame(lastReport, {
          previous,
          stale: false,
          history: [...history],
          frameIndex,
          ...motion,
        }));
        previous = current;
      } else {
        surface.draw(renderLiveFrame(null, { previous, stale: true, staleReason: staleReason ?? 'no report yet', frameIndex, ...motion }));
      }
      frameIndex += 1;
      await new Promise((resolve) => setTimeout(
        resolve,
        nextInterval(lastReport, { activeMs: 500, idleMs: opts.watchInterval ?? 3000 }),
      ));
    }
  } finally {
    surface.leave();
  }
}

/**
 * The runtime adapter, as the kernel drives it.
 *
 * The step hooks map one-to-one onto what main() used to do in order: the effective configuration is
 * loaded first, a config action or --setup or a diagnostic short-circuits with an exit code, the
 * runtime defaults are folded into the options, --rates and --refresh-rates are preflight, and
 * everything else is the report itself. The kernel owns that order; the adapter only says what each
 * step means for MiniMax Code.
 */
const mcodeAdapter = {
  id: 'mcode',
  displayName: 'MiniMax Code',
  costBasis: COST_BASIS.ESTIMATED,
  defaults: DEFAULT_OPTIONS,
  versionBanner: () => formatVersionBanner(versionBanner('mcode')),
  helpLines: () => [HELP_TEXT],

  defaultDataDir: () => path.resolve(__dirname, '..', '..', '..', '..'),
  open: async (options) => openLedger(options?.dataDir ?? dataDir),
  close: (handle) => handle.close(),
  listSessions: () => [],
  resolveCurrent: () => ({ sessionId: null, method: 'unique-active', requestedId: null, candidateIds: [] }),
  buildReport: () => ({}),
  aggregate: (reports) => aggregateMcReports(reports),

  loadConfig: (context) => {
    beginRun(context);
    runContext = context;
    loadRunConfig(context);
  },
  // These four steps are the same work main() used to do inline, in the same order. They are named
  // as separate hooks because the kernel owns the order, and because an adapter that has no setup
  // wizard or no diagnostics simply omits them rather than branching inside main().
  configAction: (context) => runConfigAction(context),
  setup: (context) => (opts.setup ? runSetup(context.effectiveConfiguration) : undefined),
  diagnostic: async (context) => (opts.diagnostic ? await runDiagnostic(context.effectiveConfiguration) : undefined),
  applyDefaults: (context) => applyRuntimeDefaults(context.effectiveConfiguration),
  preflight: async (context) => runPreflight(context.effectiveConfiguration),
  run: (context) => (context.opts.watch ? watchSession() : main(context)),
};

export default mcodeAdapter;

