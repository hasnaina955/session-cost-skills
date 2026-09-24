#!/usr/bin/env node
// Deterministic session cost accounting for MiniMax Code sessions running on the
// CommandCode provider. See ../references/ledger-internals.md for ledger semantics.
//
// Usage:
//   node session-cost.mjs                      # latest session in the ledger
//   node session-cost.mjs --session mvs_xxx    # a specific session
//   node session-cost.mjs --session mvs_xxx --include-children
//   node session-cost.mjs --list 10            # recent sessions with cost
//   node session-cost.mjs --json               # machine-readable output
//   node session-cost.mjs --refresh-rates      # re-fetch the CommandCode rate table

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_PATH = path.resolve(__dirname, '..', 'references', 'provider-rates.json');
const PER_MILLION = 1_000_000;
// A session whose most recent call is this recent is treated as still running, so the report
// can say the totals are a snapshot rather than a final figure.
const LIVE_WINDOW_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    session: null, mode: 'current', list: 0, json: false, includeChildren: false, includeChildrenExplicit: false,
    refreshRates: false, dataDir: null, from: null, to: null, provider: null, model: null, configPath: null, rates: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') opts.session = argv[++i];
    else if (a === '--last') opts.mode = 'last';
    else if (a === '--today') opts.mode = 'today';
    else if (a === '--compare') opts.mode = 'compare';
    else if (a === '--from') opts.from = argv[++i];
    else if (a === '--to') opts.to = argv[++i];
    else if (a === '--provider') opts.provider = argv[++i];
    else if (a === '--model') opts.model = argv[++i];
    else if (a === '--config') opts.configPath = argv[++i];
    else if (a === '--rates') opts.rates = true;
    else if (a === '--list') opts.list = Number(argv[++i] ?? 10);
    else if (a === '--json') opts.json = true;
    else if (a === '--include-children') { opts.includeChildren = true; opts.includeChildrenExplicit = true; }
    else if (a === '--refresh-rates') opts.refreshRates = true;
    else if (a === '--data-dir') opts.dataDir = argv[++i];
    else if (a === '--help' || a === '-h') { printHelp(); process.exit(0); }
    else fail(`unknown argument: ${a}`);
  }
  return opts;
}

function printHelp() {
  console.log(`session-cost — token usage and CommandCode cost of a MiniMax Code session

  --session <mvs_...>     session id (default: current/latest session)
  --last                  latest completed session
  --today                 sessions started today (UTC)
  --compare               compare the latest two sessions
  --from <YYYY-MM-DD>     include sessions on/after this UTC date
  --to <YYYY-MM-DD>       include sessions on/before this UTC date
  --provider <name>       filter sessions by provider key
  --model <name>          filter sessions by model substring
  --rates                 show mirrored rate-table coverage and freshness
  --include-children      also bill sub-agent sessions parented to the target
  --list [n]              list the n most recent sessions with their cost (default 10)
  --json                  emit JSON instead of the markdown summary
  --config <path>         load standing-summary settings
  --refresh-rates         re-fetch the CommandCode rate table into references/
  --data-dir <path>       MiniMax data dir (default: derived from this script's location)`);
}

// Thrown instead of process.exit(): exiting while undici/fetch handles are still open
// trips a libuv assertion on Windows. The top-level catch sets the exit code instead.
class CostError extends Error {}

function fail(msg) {
  throw new CostError(msg);
}

// ---------------------------------------------------------------- rates

// ---------------------------------------------------------------- rates
//
// The table is keyed by provider, then model. Matching on model id alone is not safe once more
// than one provider is mirrored: the same id can exist at two providers at different prices.

const RATES_SOURCE = {
  commandcode: 'https://commandcode.ai/docs/resources/pricing-limits',
  stepfun: 'https://platform.stepfun.ai/docs/en/guides/pricing/details.md',
};

function normalizeProvider(p) {
  // Runtime ids look like "custom_provider:commandcode"; the table keys are the short name.
  return String(p ?? '')
    .toLowerCase()
    .replace(/^custom_provider:/, '')
    .replace(/^custom:/, '')
    .replace(/[^a-z0-9]/g, '');
}

function normalizeModelId(id) {
  return String(id)
    .toLowerCase()
    .replace(/^[^/]*\//, '')      // drop vendor/ prefix
    .replace(/[^a-z0-9]/g, '');   // drop -, ., :, _ etc.
}

async function fetchText(url) {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' } });
  if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}`);
  return res.text();
}

async function extractCommandCodeRates() {
  const html = await fetchText(RATES_SOURCE.commandcode);

  // The Next.js RSC flight payload carries the model catalog as embedded JSON.
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((m) => {
    try { return JSON.parse('"' + m[1] + '"'); } catch { return m[1]; }
  });
  const payload = chunks.join('');
  if (!payload) throw new Error('could not read the rate payload from the docs page');

  const models = {};
  const re = /\{"id":"([^"]+)","name":"([^"]+)","category":"([^"]*)","provider":"([^"]*)"([^]*?)"planBudgetUsd"/g;
  let m;
  while ((m = re.exec(payload)) !== null) {
    const [, id, name, category, provider, rest] = m;
    const num = (key) => {
      const hit = rest.match(new RegExp('"' + key + '":([0-9.]+)'));
      return hit ? Number(hit[1]) : null;
    };
    const band = (label) => {
      const hit = rest.match(new RegExp('"' + label + '":\\{"inputCost":([0-9.]+),"outputCost":([0-9.]+),"cacheReadCost":([0-9.]+)\\}'));
      return hit ? { input: +hit[1], output: +hit[2], cacheRead: +hit[3] } : null;
    };
    const peak = band('peak');
    const offPeak = band('offPeak');
    const entry = { name, provider, category, input: num('inputCost'), output: num('outputCost'), cacheRead: num('cacheReadCost') };
    if (peak || offPeak) {
      entry.timeOfDay = { peak, offPeak };
      const win = rest.match(/"windows":"([^"]*)"/);
      if (win) entry.timeOfDay.windows = win[1];
    }
    models[id] = entry;
  }
  if (Object.keys(models).length === 0) throw new Error('rate payload contained no models');
  return models;
}

async function extractStepFunRates() {
  // StepFun publishes markdown directly, so the token-billed models parse cleanly.
  const md = await fetchText(RATES_SOURCE.stepfun);
  const models = {};
  const money = (cell) => {
    const hit = String(cell).match(/\\\$([0-9]+(?:\.[0-9]+)?)/);
    return hit ? Number(hit[1]) : null;
  };

  // Only rows billed per 1M tokens are relevant; speech/image rows use other units.
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*1M tokens\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const [, id, missCell, hitCell, outCell] = m;
    const input = money(missCell);
    const cacheRead = money(hitCell);
    const output = money(outCell);
    if (input === null || cacheRead === null || output === null) continue;
    models[id] = {
      name: id,
      provider: 'stepfun',
      category: 'stepfun-docs',
      input,
      output,
      cacheRead,
      // StepFun: "For step-5-preview, the cache-miss input price includes writing new content
      // to the cache." So cache writes bill at the input rate for that model. The docs do not
      // state this for the others, so they keep 0 rather than being guessed at.
      ...(id === 'step-5-preview' ? { cacheWrite: input, cacheWriteNote: 'billed at the input rate' } : {}),
    };
  }
  if (!('step-5-preview' in models)) throw new Error('step-5-preview row not found in the StepFun pricing page');
  return models;
}

async function refreshRates() {
  const previous = fs.existsSync(RATES_PATH) ? JSON.parse(fs.readFileSync(RATES_PATH, 'utf8')) : null;
  const now = new Date().toISOString();

  const sources = {
    commandcode: { fetch: extractCommandCodeRates, note: 'CommandCode publishes no cache-write rate; cache writes bill at 0.' },
    stepfun: { fetch: extractStepFunRates, note: 'StepFun bills cache writes at the input rate for step-5-preview.' },
  };

  const providers = {};
  for (const [key, { fetch: fn }] of Object.entries(sources)) {
    try {
      const models = await fn();
      providers[key] = { source: RATES_SOURCE[key], fetchedAt: now, models };
      console.error(`session-cost: refreshed ${Object.keys(models).length} ${key} model rates`);
    } catch (err) {
      // Keep the previously mirrored rates rather than dropping the provider on a network blip.
      if (previous?.providers?.[key]) {
        providers[key] = previous.providers[key];
        console.error(`session-cost: ${key} refresh FAILED (${err.message}); kept rates from ${previous.providers[key].fetchedAt}`);
      } else {
        console.error(`session-cost: ${key} refresh FAILED (${err.message}) and no cached rates exist`);
      }
    }
  }
  if (!Object.keys(providers).length) throw new Error('no rate sources could be refreshed');

  const table = {
    _meta: {
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt: now,
      cacheWriteNote: 'Per-provider: CommandCode charges no separate cache-write rate (bills 0); StepFun bills cache writes at the input rate for step-5-preview.',
      peakWindows: {
        peakHoursPerDay: 7,
        offPeakHoursPerDay: 17,
        windows: '01-04 & 06-10 UTC, Mon-Fri',
        rule: 'peak when UTC weekday is Mon-Fri and 1 <= utcHour < 4 or 6 <= utcHour < 10',
        note: 'CommandCode only; StepFun publishes a single flat rate per model.',
      },
    },
    providers,
    // Model ids that bill at $0 on these providers.
    freeModels: ['poolside/laguna-s-2.1-free', 'inclusionai/ling-3.0-flash-sante:free', 'laguna-s-2.1', 'ling-3.0-flash-sante'],
    // Explicit overrides for ids the normalizer cannot resolve on its own.
    aliases: previous?.aliases ?? {},
  };

  fs.mkdirSync(path.dirname(RATES_PATH), { recursive: true });
  fs.writeFileSync(RATES_PATH, JSON.stringify(table, null, 2) + '\n', 'utf8');
  console.error(`session-cost: wrote rate table -> ${RATES_PATH}`);
  return table;
}

function loadRates() {
  if (!fs.existsSync(RATES_PATH)) fail(`rate table missing at ${RATES_PATH} — run with --refresh-rates`);
  return JSON.parse(fs.readFileSync(RATES_PATH, 'utf8'));
}

// Rate lookup is provider-first: the model id is only matched inside that provider's table.
function resolveRate(table, provider, providerModelId) {
  const pkey = normalizeProvider(provider);
  const entry = table.providers?.[pkey];
  if (!entry) return { key: null, rate: null, free: false, providerKey: pkey };

  const normalized = normalizeModelId(providerModelId);
  const alias = table.aliases?.[`${pkey}/${providerModelId}`] ?? table.aliases?.[providerModelId];
  const key = alias ?? Object.keys(entry.models).find((k) => normalizeModelId(k) === normalized);
  if (key && entry.models[key]) return { key, rate: entry.models[key], free: false, providerKey: pkey };

  const isFree = (table.freeModels ?? []).some((f) => normalizeModelId(f) === normalized);
  if (isFree) return { key: providerModelId, rate: { name: providerModelId, input: 0, output: 0, cacheRead: 0 }, free: true, providerKey: pkey };
  return { key: null, rate: null, free: false, providerKey: pkey };
}

// ---------------------------------------------------------------- billing

// Published window: "01-04 & 06-10 UTC, Mon-Fri" — peak on those UTC hours on weekdays.
function bandForTimestamp(ts, rate) {
  if (!rate?.timeOfDay) return 'flat';
  const d = new Date(Number(ts));
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const isWeekday = day >= 1 && day <= 5;
  const inWindow = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return isWeekday && inWindow ? 'peak' : 'offPeak';
}

function ratesForBand(rate, band) {
  if (band === 'flat') {
    return { input: rate.input ?? 0, output: rate.output ?? 0, cacheRead: rate.cacheRead ?? 0, cacheWrite: rate.cacheWrite ?? 0 };
  }
  const bandRates = rate.timeOfDay?.[band] ?? {};
  const pick = (k) => bandRates[k] ?? rate[k] ?? 0;
  return { input: pick('input'), output: pick('output'), cacheRead: pick('cacheRead'), cacheWrite: bandRates.cacheWrite ?? rate.cacheWrite ?? 0 };
}

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
  const r = ratesForBand(rate, band);
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
  agg.costInput += (input / PER_MILLION) * r.input;
  agg.costOutput += (output / PER_MILLION) * r.output;
  agg.costCacheRead += (cacheRead / PER_MILLION) * r.cacheRead;
  agg.costCacheWrite += (cacheWrite / PER_MILLION) * r.cacheWrite;
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

async function openLedger(dataDir) {
  const dbPath = path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  if (!fs.existsSync(dbPath)) fail(`ledger not found at ${dbPath}`);

  let DatabaseSync;
  try {
    ({ DatabaseSync } = await import('node:sqlite'));
  } catch {
    fail(`this script needs the built-in node:sqlite module (Node 22.5+); running ${process.version}`);
  }
  return new DatabaseSync(dbPath, { readOnly: true });
}

function latestSessionId(db) {
  const row = db.prepare('SELECT session_id FROM local_runtime_token_usage ORDER BY ts DESC LIMIT 1').get();
  if (!row) fail('the token-usage ledger is empty — no session has made an LLM call yet');
  return row.session_id;
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
function childSessionIds(db, sessionId) {
  return db.prepare('SELECT session_id FROM local_runtime_sessions WHERE parent_session_id = ?').all(sessionId).map((r) => r.session_id);
}

function buildPricer(db, dataDir, table, sessionId) {
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
    rateFor(providerId, modelId) {
      const cacheKey = `${normalizeProvider(providerId)}::${modelId}`;
      if (!rateCache.has(cacheKey)) rateCache.set(cacheKey, resolveRate(table, providerId, modelId));
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

function buildReport(db, dataDir, table, sessionId, includeChildren) {
  const childIds = childSessionIds(db, sessionId);
  const ids = includeChildren ? [sessionId, ...childIds] : [sessionId];
  const pricers = new Map(ids.map((id) => [id, buildPricer(db, dataDir, table, id)]));
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
    const rateInfo = modelId ? pricer.rateFor(provider, modelId) : { key: null, rate: null, free: false, providerKey: normalizeProvider(provider) };
    return { modelId, provider, inferred, rateInfo, rate: rateInfo.rate ?? null };
  };

  for (const row of rows) {
    const pricer = pricers.get(row.session_id);
    const { modelId, provider, inferred, rateInfo, rate } = priceRow(pricer, row);
    if (inferred) inferredRows += 1;

    accumulate(agg, row, rate ?? { input: 0, output: 0, cacheRead: 0 });

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
        inferredCalls: 0,
        ...emptyAggregate(),
      });
    }
    const entry = perModel.get(key);
    if (inferred) entry.inferredCalls += 1;
    accumulate(entry, row, rate ?? { input: 0, output: 0, cacheRead: 0 });

    if (pkey) providersSeen.set(pkey, true);
  }

  const perSession = {};
  for (const id of ids) {
    const sub = emptyAggregate();
    for (const row of rows.filter((r) => r.session_id === id)) {
      const { rate } = priceRow(pricers.get(id), row);
      accumulate(sub, row, rate ?? { input: 0, output: 0, cacheRead: 0 });
    }
    const fin = finalize(sub);
    perSession[id] = { role: id === sessionId ? 'target' : 'child', billed: true, calls: fin.calls, totalTokens: fin.totalTokens, cacheRate: fin.cacheRate, totalCost: fin.totalCost };
  }
  for (const id of includeChildren ? [] : childIds) {
    perSession[id] = { role: 'child', billed: false, calls: null, totalTokens: null, cacheRate: null, totalCost: null };
  }

  const models = [...perModel.values()].map((m) => ({ ...finalize(m), modelId: m.modelId, provider: m.provider, providerKey: m.providerKey, rateKey: m.rateKey, rateKnown: m.rateKnown, rateIsFree: m.rateIsFree, inferredCalls: m.inferredCalls }));
  const lastTs = rows.length ? Number(rows[rows.length - 1].ts) : null;
  const snapshotAt = Date.now();

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
    isCommandCode: Boolean(target.provider && /commandcode/i.test(target.provider)),
    includeChildren,
    billedSessions: ids,
    childSessions: childIds,
    childSessionsBilled: includeChildren ? childIds : [],
    perSession,
    models,
    multiModel: models.length > 1,
    multiProvider: providersUsed.filter((p) => p.mirrored).length > 1,
    providersUsed,
    inferredModelRows: inferredRows,
    snapshotAt,
    ledgerLastCallAt: lastTs,
    sessionActive: lastTs !== null && snapshotAt - lastTs < LIVE_WINDOW_MS,
    ratesRefreshedAt: table._meta?.refreshedAt ?? null,
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

function renderText(rep) {
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
  L.push('');
  // Never print $0.000000 as a headline: with no rate for any model that reads as "this session
  // was free" when the truth is "the cost is unknown".
  if (anyPriced) {
    L.push(`TOTAL COST ${USD(rep.totalCost)} for ${M(rep.totalTokens)} M tokens — ${USD(rep.allInUsdPerM)}/M all-in${hasUnpriced ? ' (priced calls only)' : ''}`);
  } else {
    L.push(`COST UNAVAILABLE — ${M(rep.totalTokens)} M tokens, but none of the models in this session`);
    L.push('are in the CommandCode rate table, so no cost can be computed (see "Rates actually billed").');
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
  if (rep.reasoningTokens) {
    L.push(`(Reasoning ${M(rep.reasoningTokens)} M is inside the output row, never added twice.)`);
  }

  L.push('');
  L.push('Rates actually billed');
  for (const m of rep.models) {
    const who = rep.multiProvider ? `${m.providerKey} · ` : '';
    if (!m.rateKnown) {
      L.push(`  ${who}${m.modelId} — not in the ${m.providerKey ?? 'provider'} rate table: ${m.calls} call(s), ${M(m.totalTokens)} M tokens, unpriced`);
      continue;
    }
    const bands = Object.entries(m.rateBandsUsed)
      .map(([band, r]) => `${band === 'flat' ? 'flat' : band} $${fmtRate(r.input)} in / $${fmtRate(r.cacheRead)} cache read / $${fmtRate(r.output)} out${r.cacheWrite ? ` / $${fmtRate(r.cacheWrite)} cache write` : ''}`)
      .join(', ');
    L.push(`  ${who}${m.modelId} — ${bands} per 1M  (${m.calls} call(s), ${USD(m.totalCost)})`);
  }
  L.push(`  band split: ${rep.bands.offPeak ?? 0} off-peak · ${rep.bands.peak ?? 0} peak · ${rep.bands.flat ?? 0} flat`);
  if (hasUnpriced && anyPriced) {
    L.push(`  ! ${unpricedCalls} call(s) / ${M(unpricedTokens)} M tokens are unpriced and are NOT in the total above.`);
  }

  if (unbilledChildren > 0) {
    L.push('');
    L.push(`Note: ${unbilledChildren} sub-agent session(s) below this one are NOT included. Add --include-children for the end-to-end task total.`);
  }
  if (rep.inferredModelRows > 0) {
    L.push(`Note: the model was inferred for ${rep.inferredModelRows} of ${rep.calls} call(s) from the nearest recorded call — the ledger does not store a model per call.`);
  }

  // Only when the session genuinely spans models, since that is the only reason to break it out.
  if (rep.multiModel) {
    L.push('');
    L.push('By model');
    L.push(...renderTable(
      ['Provider', 'Model', 'Calls', 'Tokens (M)', 'Cache rate', 'Cost'],
      rep.models.map((m) => [m.providerKey ?? '—', m.modelId, String(m.calls), M(m.totalTokens), `${(m.cacheRate * 100).toFixed(1)}%`, m.rateKnown ? USD(m.totalCost) : 'unpriced']),
      ['l', 'l', 'r', 'r', 'r', 'r'],
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
  return db.prepare('SELECT session_id, MIN(ts) AS first_ts, MAX(ts) AS last_ts, COUNT(*) AS calls FROM local_runtime_token_usage GROUP BY session_id ORDER BY last_ts DESC').all();
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
  const snapshotAt = Number(report.snapshotAt) || Date.now();
  const ledgerLastCallAt = Number(report.ledgerLastCallAt);
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    snapshot: {
      active: Boolean(report.sessionActive),
      capturedAt: new Date(snapshotAt).toISOString(),
      lastLedgerActivityAt: Number.isFinite(ledgerLastCallAt) ? new Date(ledgerLastCallAt).toISOString() : null,
    },
    selection,
    usage: {
      totalTokens: report.totalTokens,
      inputTokens: report.inputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      outputTokens: report.outputTokens,
      cacheHitRate: report.cacheRate,
    },
    billing: {
      classification: report.rateKnown ? 'rate-priced' : 'cost-unavailable',
      recordedCostUsd: report.rateKnown ? report.totalCost : null,
      rateKnown: report.rateKnown,
      ratesRefreshedAt: report.ratesRefreshedAt,
    },
    ...report,
  };
}
function aggregateMcReports(reports) {
  const total = {
    calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, totalCost: 0, totalTokens: 0,
    promptTokens: 0, bands: { peak: 0, offPeak: 0, flat: 0 }, models: new Map(), sessions: [],
  };
  for (const report of reports) {
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'totalCost', 'totalTokens', 'promptTokens']) total[field] += Number(report[field]) || 0;
    for (const band of ['peak', 'offPeak', 'flat']) total.bands[band] += Number(report.bands?.[band]) || 0;
    total.sessions.push(report.sessionId);
    for (const model of report.models) {
      const key = `${model.providerKey}::${model.modelId}`;
      const existing = total.models.get(key) ?? { ...model, calls: 0, totalTokens: 0, totalCost: 0 };
      existing.calls += model.calls;
      existing.totalTokens += model.totalTokens;
      existing.totalCost += model.totalCost;
      total.models.set(key, existing);
    }
  }
  total.cacheRate = total.promptTokens > 0 ? total.cacheReadTokens / total.promptTokens : 0;
  return { ...total, models: [...total.models.values()], rateKnown: reports.every((report) => report.rateKnown) };
}
function renderAggregateMc(report, label) {
  return [
    `MCode session cost — ${label}`,
    `Sessions: ${report.sessions.length}`,
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
  const lines = ['MCode rate coverage', `Refreshed: ${table._meta?.refreshedAt ?? 'unknown'}`];
  for (const [key, entry] of Object.entries(table.providers ?? {})) {
    lines.push(`${key}: ${Object.keys(entry.models ?? {}).length} model(s), source ${entry.source ?? 'unknown'}, fetched ${entry.fetchedAt ?? 'unknown'}`);
  }
  lines.push(`Free models: ${(table.freeModels ?? []).join(', ') || 'none'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

const opts = parseArgs(process.argv.slice(2));
// <dataDir>/skills/session-cost/scripts/ -> three levels up is <dataDir>.
const dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.resolve(__dirname, '..', '..', '..');

function costForSession(db, dataDir, table, sessionId) {
  return buildReport(db, dataDir, table, sessionId, opts.includeChildren);
}

async function main() {
  if (opts.refreshRates) await refreshRates();

  const table = loadRates();

  if (opts.rates) {
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      rates: {
        refreshedAt: table._meta?.refreshedAt ?? null,
        providers: Object.fromEntries(Object.entries(table.providers ?? {}).map(([key, entry]) => [key, { models: Object.keys(entry.models ?? {}).length, source: entry.source ?? null, fetchedAt: entry.fetchedAt ?? null }])),
        freeModels: table.freeModels ?? [],
      },
    };
    if (opts.json) console.log(JSON.stringify(output, null, 2));
    else console.log(renderRates(table));
    return 0;
  }

  const db = await openLedger(dataDir);

  try {
    loadConfig(dataDir);
    const allRows = sessionRows(db);
    const candidates = allRows.filter((row) => matchesFilters(db, dataDir, row));

    if (opts.list > 0) {
      const recent = candidates.slice(0, opts.list);
      const out = recent.map((r) => {
        const rep = costForSession(db, dataDir, table, r.session_id);
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
          partial: priced > 0 && unpricedCalls > 0,
          lastTs: Number(r.last_ts),
        };
      });

      if (opts.json) {
        console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), sessions: out }, null, 2));
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
      }
      return 0;
    }

    if (opts.mode === 'compare') {
      const reports = candidates.slice(0, 2).map((row) => costForSession(db, dataDir, table, row.session_id));
      if (reports.length < 2) fail('--compare requires at least two matching sessions');
      if (opts.json) {
        console.log(JSON.stringify({
          schemaVersion: 1,
          generatedAt: new Date().toISOString(),
          comparison: { older: enhanceReport(reports[1]), newer: enhanceReport(reports[0]) },
        }, null, 2));
      } else {
        console.log(renderCompareMc(reports[1], reports[0]));
      }
      return reports.every((report) => report.rateKnown) ? 0 : 2;
    }

    if (opts.mode === 'last' || opts.mode === 'today' || opts.from || opts.to || opts.provider || opts.model) {
      let rows = candidates;
      if (opts.mode === 'last') rows = rows.filter((row) => Date.now() - Number(row.last_ts) >= LIVE_WINDOW_MS).slice(0, 1);
      if (opts.mode === 'today') {
        const today = new Date().toISOString().slice(0, 10);
        rows = rows.filter((row) => new Date(Number(row.first_ts)).toISOString().slice(0, 10) === today);
      }
      if (!rows.length) fail('no sessions match the requested filters');
      const reports = rows.slice(0, 200).map((row) => costForSession(db, dataDir, table, row.session_id));
      if (reports.length === 1) {
        if (opts.json) console.log(JSON.stringify(enhanceReport(reports[0], { method: opts.mode, requestedId: null, candidates: reports.map((r) => r.sessionId) }), null, 2));
        else console.log(renderText(reports[0]));
      } else {
        const aggregate = aggregateMcReports(reports);
        if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, generatedAt: new Date().toISOString(), selection: { method: opts.mode, sessions: reports.map((r) => r.sessionId) }, ...enhanceReport(aggregate), models: aggregate.models }, null, 2));
        else console.log(renderAggregateMc(aggregate, opts.mode === 'today' ? 'today' : 'filtered range'));
      }
      return reports.every((report) => report.rateKnown) ? 0 : 2;
    }

    const sessionId = opts.session ?? candidates[0]?.session_id ?? latestSessionId(db);
    const report = costForSession(db, dataDir, table, sessionId);
    const selection = { method: opts.session ? 'explicit' : 'latest-ledger-activity', requestedId: opts.session ?? null, candidates: candidates.slice(0, 5).map((row) => row.session_id) };

    if (opts.json) console.log(JSON.stringify(enhanceReport(report, selection), null, 2));
    else console.log(renderText(report));

    return report.rateKnown ? 0 : 2;
  } finally {
    db.close();
  }
}

try {
  process.exitCode = await main();
} catch (err) {
  if (err instanceof CostError) {
    console.error(`session-cost: ${err.message}`);
    process.exitCode = 2;
  } else {
    console.error(`session-cost: unexpected failure: ${err.stack ?? err.message}`);
    process.exitCode = 1;
  }
}
