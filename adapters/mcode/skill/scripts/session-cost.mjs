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
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { writeDashboard } from './lib/dashboard.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RATES_PATH = path.resolve(__dirname, '..', 'references', 'provider-rates.json');
const PER_MILLION = 1_000_000;
// A session whose most recent call is this recent is treated as still running, so the report
// can say the totals are a snapshot rather than a final figure.
const LIVE_WINDOW_MS = 5 * 60 * 1000;
const RATE_SCHEMA_VERSION = 2;
const RATE_COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
const RATE_COMPONENT_LABELS = Object.freeze({
  input: 'fresh input',
  output: 'output',
  cacheRead: 'cache read',
  cacheWrite: 'cache write',
});
const RATE_PARSER_VERSION = 'commandcode-rsc-v2';
const STEPFUN_PARSER_VERSION = 'stepfun-markdown-v2';
const DEFAULT_REQUIRED_RATE_COMPONENTS = Object.freeze(['input', 'output', 'cacheRead']);

// ---------------------------------------------------------------- arguments

function parseArgs(argv) {
  const opts = {
    session: null, mode: 'current', list: 0, json: false, includeChildren: false, includeChildrenExplicit: false,
    refreshRates: false, dataDir: null, from: null, to: null, provider: null, model: null, configPath: null, rates: false,
    dashboard: false, out: null,
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
    else if (a === '--dashboard') opts.dashboard = true;
    else if (a === '--out') opts.out = argv[++i];
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
  --dashboard             write a self-contained HTML dashboard
  --out <path>            dashboard output path
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

const hasOwn = (value, key) => Object.prototype.hasOwnProperty.call(value ?? {}, key);

function isRateNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function toRateNumber(value) {
  if (isRateNumber(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (isRateNumber(parsed)) return parsed;
  }
  return null;
}

function isoTimestamp(value) {
  if (value === null || value === undefined || value === '') return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function stableJson(value) {
  if (value === undefined) return 'null';
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function fingerprint(value) {
  return createHash('sha256').update(stableJson(value)).digest('hex');
}

function componentValue(container, component) {
  if (!container || typeof container !== 'object') return null;
  const candidates = [];
  if (hasOwn(container, component)) candidates.push(container[component]);
  if (container.rates && hasOwn(container.rates, component)) candidates.push(container.rates[component]);
  if (container.components && hasOwn(container.components, component)) candidates.push(container.components[component]);
  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && hasOwn(candidate, 'value')) return toRateNumber(candidate.value);
    return toRateNumber(candidate);
  }
  return null;
}

function rateComponents(rate) {
  return Object.fromEntries(RATE_COMPONENTS.map((component) => [component, componentValue(rate, component)]));
}

function componentCompleteness(rate) {
  const components = rateComponents(rate);
  return Object.fromEntries(RATE_COMPONENTS.map((component) => [component, components[component] === null ? 'missing' : 'published']));
}

function missingRateComponents(rate, required = DEFAULT_REQUIRED_RATE_COMPONENTS) {
  const components = rateComponents(rate);
  return required.filter((component) => components[component] === null);
}

function contextTiersForRate(rate) {
  return Array.isArray(rate?.contextTiers) ? rate.contextTiers : [];
}

function timeBandsForRate(rate) {
  return rate?.timeOfDay && typeof rate.timeOfDay === 'object' ? rate.timeOfDay : null;
}

function validateRateComponents(rate, required, label, errors, warnings = []) {
  const components = rateComponents(rate);
  for (const component of required) {
    if (components[component] === null) errors.push(`${label}.${component} is missing or not a finite non-negative number`);
  }
  for (const component of RATE_COMPONENTS) {
    if (components[component] === null && !required.includes(component)) {
      warnings.push(`${label}.${component} is not published; it will remain unknown, never zero`);
    }
  }
  return components;
}

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

function decodeNextFlightPayload(html) {
  // The Next.js RSC flight payload carries the model catalog as embedded JSON. Decode the
  // individual string chunks first; parsing the HTML as JSON would lose the flight framing.
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)].map((match) => {
    try { return JSON.parse('"' + match[1] + '"'); } catch { return match[1]; }
  });
  const payload = chunks.join('');
  if (!payload) throw new Error('could not read the rate payload from the docs page');
  return payload;
}

function jsonArrayAfterKey(payload, key) {
  const expression = new RegExp(`"${key}"\\s*:\\s*\\[`, 'g');
  for (const match of payload.matchAll(expression)) {
    const start = payload.indexOf('[', match.index);
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < payload.length; index += 1) {
      const character = payload[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '[') depth += 1;
      else if (character === ']' && --depth === 0) {
        try {
          const parsed = JSON.parse(payload.slice(start, index + 1));
          if (Array.isArray(parsed)) return parsed;
        } catch {
          // Keep looking: RSC text can contain a non-JSON array with the same key.
        }
        break;
      }
    }
  }
  return null;
}

function rawAmount(...values) {
  return values.find((value) => value !== undefined) ?? null;
}

function firstPublishedRate(...values) {
  for (const value of values) {
    const number = toRateNumber(value);
    if (number !== null) return number;
  }
  return null;
}

function normalizeRateTier(tier) {
  const sourceRates = tier?.rates && typeof tier.rates === 'object' ? tier.rates : tier ?? {};
  const maxContext = tier?.maxContext ?? tier?.maxContextTokens ?? null;
  return {
    label: tier?.label ?? null,
    context: tier?.context ?? null,
    maxContext: maxContext === null || maxContext === undefined ? null : Number(maxContext),
    input: firstPublishedRate(tier?.inputCost, tier?.input, sourceRates.inputCost, sourceRates.input),
    output: firstPublishedRate(tier?.outputCost, tier?.output, sourceRates.outputCost, sourceRates.output),
    cacheRead: firstPublishedRate(tier?.cacheReadCost, tier?.cacheRead, sourceRates.cacheReadCost, sourceRates.cacheRead),
    cacheWrite: firstPublishedRate(tier?.cacheWriteCost, tier?.cacheWrite, sourceRates.cacheWriteCost, sourceRates.cacheWrite),
    rawComponents: {
      input: rawAmount(tier?.inputCost, tier?.input, sourceRates.inputCost, sourceRates.input),
      output: rawAmount(tier?.outputCost, tier?.output, sourceRates.outputCost, sourceRates.output),
      cacheRead: rawAmount(tier?.cacheReadCost, tier?.cacheRead, sourceRates.cacheReadCost, sourceRates.cacheRead),
      cacheWrite: rawAmount(tier?.cacheWriteCost, tier?.cacheWrite, sourceRates.cacheWriteCost, sourceRates.cacheWrite),
    },
    ...(tier?.listRates && typeof tier.listRates === 'object' ? { listRates: normalizeRateTier(tier.listRates) } : {}),
  };
}

function normalizeTimeBand(band) {
  if (!band || typeof band !== 'object') return null;
  return {
    input: firstPublishedRate(band.inputCost, band.input),
    output: firstPublishedRate(band.outputCost, band.output),
    cacheRead: firstPublishedRate(band.cacheReadCost, band.cacheRead),
    cacheWrite: firstPublishedRate(band.cacheWriteCost, band.cacheWrite),
    rawComponents: {
      input: rawAmount(band.inputCost, band.input),
      output: rawAmount(band.outputCost, band.output),
      cacheRead: rawAmount(band.cacheReadCost, band.cacheRead),
      cacheWrite: rawAmount(band.cacheWriteCost, band.cacheWrite),
    },
  };
}

function normalizePromotion(deal, sourceFetchedAt) {
  if (!deal || typeof deal !== 'object') return null;
  const listRates = deal.listRates && typeof deal.listRates === 'object' ? normalizeRateTier(deal.listRates) : null;
  return {
    id: deal.id ?? null,
    discountPercent: toRateNumber(deal.discountPercent),
    starts: isoTimestamp(deal.starts),
    ends: isoTimestamp(deal.expires ?? deal.ends ?? deal.effectiveThrough),
    free: deal.free === true,
    listRates,
    observedAt: sourceFetchedAt,
    note: typeof deal.note === 'string' ? deal.note : null,
  };
}

function normalizeCommandCodeModel(raw, rich, sourceFetchedAt) {
  const richFirstTier = Array.isArray(rich?.tiers) ? rich.tiers[0] : null;
  const rawContextTiers = Array.isArray(raw.contextTiers) ? raw.contextTiers.map(normalizeRateTier) : [];
  const rawFirstTier = rawContextTiers[0] ?? null;
  const base = {
    name: raw.name ?? rich?.name ?? raw.id,
    provider: raw.provider ?? rich?.provider ?? null,
    category: raw.category ?? rich?.category ?? null,
    input: hasOwn(raw, 'inputCost') ? toRateNumber(raw.inputCost) : firstPublishedRate(rawFirstTier?.input, richFirstTier?.rates?.input, richFirstTier?.input),
    output: hasOwn(raw, 'outputCost') ? toRateNumber(raw.outputCost) : firstPublishedRate(rawFirstTier?.output, richFirstTier?.rates?.output, richFirstTier?.output),
    cacheRead: hasOwn(raw, 'cacheReadCost') ? toRateNumber(raw.cacheReadCost) : firstPublishedRate(rawFirstTier?.cacheRead, richFirstTier?.rates?.cacheRead, richFirstTier?.cacheRead),
    // An omitted cacheWriteCost is null, never zero. Only a source field (or an explicit
    // documented policy) may turn it into a numeric rate.
    cacheWrite: hasOwn(raw, 'cacheWriteCost')
      ? toRateNumber(raw.cacheWriteCost)
      : firstPublishedRate(rawFirstTier?.cacheWrite, richFirstTier?.rates?.cacheWrite, richFirstTier?.cacheWrite),
    rawComponents: {
      input: rawAmount(raw.inputCost, rawFirstTier?.rawComponents?.input, richFirstTier?.rates?.input, richFirstTier?.input),
      output: rawAmount(raw.outputCost, rawFirstTier?.rawComponents?.output, richFirstTier?.rates?.output, richFirstTier?.output),
      cacheRead: rawAmount(raw.cacheReadCost, rawFirstTier?.rawComponents?.cacheRead, richFirstTier?.rates?.cacheRead, richFirstTier?.cacheRead),
      cacheWrite: hasOwn(raw, 'cacheWriteCost') ? raw.cacheWriteCost : rawAmount(rawFirstTier?.rawComponents?.cacheWrite, richFirstTier?.rates?.cacheWrite, richFirstTier?.cacheWrite),
    },
  };
  const richContextTiers = Array.isArray(rich?.tiers) ? rich.tiers.map(normalizeRateTier) : [];
  const hasPublishedContextBands = rawContextTiers.length > 1 || rawContextTiers.some((tier) => tier.maxContext !== null || tier.context !== null) || richContextTiers.length > 1 || richContextTiers.some((tier) => tier.maxContext !== null || tier.context !== null);
  const contextTiers = hasPublishedContextBands ? (rawContextTiers.length ? rawContextTiers : richContextTiers) : [];
  const rawTime = raw.timeOfDay ?? rich?.timeOfDay;
  const timeOfDay = rawTime && typeof rawTime === 'object' ? {
    effective: isoTimestamp(rawTime.effective),
    peak: normalizeTimeBand(rawTime.peak),
    offPeak: normalizeTimeBand(rawTime.offPeak),
    peakHoursPerDay: rawTime.peakHoursPerDay ?? null,
    offPeakHoursPerDay: rawTime.offPeakHoursPerDay ?? null,
    windows: rawTime.windows ?? null,
    rule: rawTime.rule ?? null,
  } : null;
  const rawDeal = raw.deal ?? rich?.deal;
  const promotion = normalizePromotion(rawDeal, sourceFetchedAt);
  if (promotion && !promotion.listRates && richFirstTier?.listRates && typeof richFirstTier.listRates === 'object') {
    promotion.listRates = normalizeRateTier(richFirstTier.listRates);
  }
  const effectiveFrom = isoTimestamp(rawTime?.effective ?? rich?.priceChangeNote?.effective);
  const model = {
    ...base,
    currency: 'USD',
    unit: 'per 1M tokens',
    source: RATES_SOURCE.commandcode,
    sourceVersion: RATE_PARSER_VERSION,
    fetchedAt: sourceFetchedAt,
    effectiveFrom,
    effectiveThrough: null,
    ...(timeOfDay ? { timeOfDay } : {}),
    ...(contextTiers.length ? { contextTiers } : {}),
    ...(promotion ? { promotions: [promotion] } : {}),
    // The source explicitly describes open-source prices as provider means. Preserve that
    // caveat instead of presenting the estimate as a per-request invoice amount.
    sourceNote: rich?.note ?? rich?.tip ?? (raw.category === 'opensource' ? 'CommandCode states open-source prices are provider means; actual upstream cost may vary.' : null),
  };
  model.requiredComponents = [...DEFAULT_REQUIRED_RATE_COMPONENTS];
  for (const [component, sourceField] of Object.entries({ input: 'inputCost', output: 'outputCost', cacheRead: 'cacheReadCost', cacheWrite: 'cacheWriteCost' })) {
    if (hasOwn(raw, sourceField) && raw[sourceField] !== null && toRateNumber(raw[sourceField]) === null && !model.requiredComponents.includes(component)) model.requiredComponents.push(component);
  }
  if (model.cacheWrite !== null || contextTiers.some((tier) => tier.cacheWrite !== null) || [timeOfDay?.peak?.cacheWrite, timeOfDay?.offPeak?.cacheWrite].some((value) => value !== null && value !== undefined)) {
    model.requiredComponents.push('cacheWrite');
  }
  model.componentCompleteness = componentCompleteness(model);
  model.rateCardFingerprint = fingerprint({ model: { ...model, rateCards: undefined } });
  return model;
}

function parseCommandCodePayload(html, sourceFetchedAt = new Date().toISOString()) {
  const payload = decodeNextFlightPayload(html);
  const primaryRows = jsonArrayAfterKey(payload, 'models');
  if (!primaryRows?.length) throw new Error('rate payload contained no structured models array');
  const richRows = jsonArrayAfterKey(payload, 'rows') ?? [];
  const primaryById = new Map();
  for (const row of primaryRows) {
    if (!row || typeof row !== 'object' || !row.id) continue;
    if (primaryById.has(row.id)) throw new Error(`duplicate CommandCode model id in rate payload: ${row.id}`);
    primaryById.set(row.id, row);
  }
  const richById = new Map();
  for (const row of richRows) {
    if (row && typeof row === 'object' && row.id) {
      if (richById.has(row.id)) throw new Error(`duplicate CommandCode model id in rich rate payload: ${row.id}`);
      richById.set(row.id, row);
    }
  }
  const models = {};
  for (const [id, raw] of primaryById) {
    models[id] = normalizeCommandCodeModel(raw, richById.get(id), sourceFetchedAt);
  }
  if (Object.keys(models).length === 0) throw new Error('rate payload contained no models');
  return {
    models,
    source: RATES_SOURCE.commandcode,
    parserVersion: RATE_PARSER_VERSION,
    sourceVersion: 'commandcode-docs-rsc',
    fetchedAt: sourceFetchedAt,
    fingerprint: fingerprint(models),
  };
}

async function extractCommandCodeRates(html = null) {
  const source = html ?? await fetchText(RATES_SOURCE.commandcode);
  return parseCommandCodePayload(source).models;
}

function normalizeStepFunModel(id, input, output, cacheRead, sourceFetchedAt) {
  const cacheWrite = id === 'step-5-preview' ? input : null;
  const model = {
    name: id,
    provider: 'stepfun',
    category: 'stepfun-docs',
    input,
    output,
    cacheRead,
    // The StepFun page explicitly includes cache writes in the cache-miss input price for
    // step-5-preview. Other rows do not publish a write component; null is intentional.
    cacheWrite,
    rawComponents: { input, output, cacheRead, cacheWrite },
    ...(cacheWrite !== null ? { cacheWriteNote: 'billed at the input rate' } : {}),
    currency: 'USD',
    unit: 'per 1M tokens',
    source: RATES_SOURCE.stepfun,
    sourceVersion: STEPFUN_PARSER_VERSION,
    fetchedAt: sourceFetchedAt,
    effectiveFrom: null,
    effectiveThrough: null,
  };
  model.requiredComponents = [...DEFAULT_REQUIRED_RATE_COMPONENTS];
  if (cacheWrite !== null) model.requiredComponents.push('cacheWrite');
  model.componentCompleteness = componentCompleteness(model);
  model.rateCardFingerprint = fingerprint({ model });
  return model;
}

async function extractStepFunRates(markdown = null) {
  // StepFun publishes markdown directly, so the token-billed models parse cleanly.
  const md = markdown ?? await fetchText(RATES_SOURCE.stepfun);
  const models = {};
  const money = (cell) => {
    const hit = String(cell).match(/\\\$([0-9]+(?:\.[0-9]+)?)/);
    return hit ? Number(hit[1]) : null;
  };
  const fetchedAt = new Date().toISOString();

  // Only rows billed per 1M tokens are relevant; speech/image rows use other units.
  for (const line of md.split(/\r?\n/)) {
    const m = line.match(/^\|\s*`([^`]+)`\s*\|\s*1M tokens\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!m) continue;
    const [, id, missCell, hitCell, outCell] = m;
    const input = money(missCell);
    const cacheRead = money(hitCell);
    const output = money(outCell);
    if (input === null || cacheRead === null || output === null) continue;
    models[id] = normalizeStepFunModel(id, input, output, cacheRead, fetchedAt);
  }
  if (!('step-5-preview' in models)) throw new Error('step-5-preview row not found in the StepFun pricing page');
  return models;
}

function rateCardComponents(rate) {
  return Object.fromEntries(RATE_COMPONENTS.map((component) => {
    const value = componentValue(rate, component);
    const raw = rate?.rawComponents?.[component] ?? value;
    return [component, { component, tokenComponent: component, value, raw, status: value === null ? 'missing' : 'published' }];
  }));
}

function makeRateCard(modelKey, model, providerKey, source, options = {}) {
  const values = options.values ?? model;
  const card = {
    rateCardVersion: 1,
    rateRecordVersion: 1,
    provider: providerKey,
    model: modelKey,
    currency: model.currency ?? 'USD',
    unit: model.unit ?? 'per 1M tokens',
    effectiveFrom: options.effectiveFrom ?? model.effectiveFrom ?? source.fetchedAt ?? null,
    effectiveThrough: options.effectiveThrough ?? model.effectiveThrough ?? null,
    effectiveDateSource: options.effectiveDateSource ?? (model.effectiveFrom ? 'source' : 'fetch-observation'),
    contextMaxTokens: options.contextMaxTokens ?? null,
    timeBand: options.timeBand ?? 'flat',
    promotionId: options.promotionId ?? null,
    promotionState: options.promotionState ?? null,
    sourceUrl: source.source ?? source.url ?? RATES_SOURCE[providerKey] ?? null,
    sourceVersion: source.parserVersion ?? source.sourceVersion ?? model.sourceVersion ?? null,
    components: rateCardComponents(values),
    source: {
      url: source.source ?? source.url ?? RATES_SOURCE[providerKey] ?? null,
      version: source.parserVersion ?? source.sourceVersion ?? model.sourceVersion ?? null,
      fetchedAt: source.fetchedAt ?? model.fetchedAt ?? null,
    },
  };
  card.rateCardFingerprint = fingerprint(card);
  return card;
}

function addRateCards(models, providerKey, source) {
  for (const [modelKey, model] of Object.entries(models)) {
    const contextVariants = [{ maxContext: null, values: model }, ...contextTiersForRate(model).map((tier) => ({ maxContext: tier.maxContext, values: tier }))];
    const currentPromotion = model.promotions?.[0] ?? null;
    const promotionOptions = currentPromotion ? { promotionId: currentPromotion.id, promotionState: 'active-at-fetch' } : {};
    const cards = [];
    for (const contextVariant of contextVariants) {
      const timeOfDay = timeBandsForRate(model);
      if (timeOfDay) {
        for (const band of ['peak', 'offPeak']) {
          cards.push(makeRateCard(modelKey, model, providerKey, source, {
            ...promotionOptions,
            values: timeOfDay[band] ?? model,
            contextMaxTokens: contextVariant.maxContext,
            timeBand: band,
            effectiveFrom: timeOfDay.effective ?? currentPromotion?.starts ?? model.effectiveFrom ?? source.fetchedAt,
            effectiveThrough: currentPromotion?.ends ?? model.effectiveThrough ?? null,
            effectiveDateSource: timeOfDay.effective || currentPromotion?.starts || model.effectiveFrom ? 'source' : 'fetch-observation',
          }));
        }
      } else {
        cards.push(makeRateCard(modelKey, model, providerKey, source, {
          ...promotionOptions,
          values: contextVariant.values,
          contextMaxTokens: contextVariant.maxContext,
          effectiveFrom: currentPromotion?.starts ?? model.effectiveFrom ?? source.fetchedAt,
          effectiveThrough: currentPromotion?.ends ?? model.effectiveThrough ?? null,
          effectiveDateSource: currentPromotion?.starts || model.effectiveFrom ? 'source' : 'fetch-observation',
        }));
      }
    }
    for (const promotion of model.promotions ?? []) {
      if (!promotion.listRates) continue;
      cards.push(makeRateCard(modelKey, model, providerKey, source, {
        values: promotion.listRates,
        effectiveFrom: promotion.starts,
        effectiveThrough: promotion.ends,
        promotionId: promotion.id,
        promotionState: 'list',
        effectiveDateSource: promotion.starts || promotion.ends ? 'source' : 'fetch-observation',
      }));
    }
    const uniqueCards = [...new Map(cards.map((card) => [card.rateCardFingerprint, card])).values()];
    model.rateCards = uniqueCards;
    model.rateCardFingerprint = fingerprint(uniqueCards);
    model.componentCompleteness = componentCompleteness(model);
  }
  return models;
}

function validateRateModel(modelKey, model, errors, warnings) {
  const required = Array.isArray(model?.requiredComponents) && model.requiredComponents.length
    ? model.requiredComponents
    : [...RATE_COMPONENTS];
  if (!model || typeof model !== 'object') {
    errors.push(`${modelKey}: model entry is not an object`);
    return;
  }
  if (model.id !== undefined && model.id !== modelKey) errors.push(`${modelKey}: model id does not match its key`);
  validateRateComponents(model, required, modelKey, errors, warnings);
  let previousContext = -1;
  for (const [index, tier] of contextTiersForRate(model).entries()) {
    if (!tier || typeof tier !== 'object') {
      errors.push(`${modelKey}.contextTiers[${index}] is not an object`);
      continue;
    }
    if (tier.maxContext !== null && (!Number.isFinite(Number(tier.maxContext)) || Number(tier.maxContext) < 0)) {
      errors.push(`${modelKey}.contextTiers[${index}].maxContext is invalid`);
    } else if (tier.maxContext !== null && Number(tier.maxContext) <= previousContext) {
      errors.push(`${modelKey}.contextTiers thresholds must increase`);
    }
    if (tier.maxContext !== null) previousContext = Number(tier.maxContext);
    validateRateComponents(tier, required, `${modelKey}.contextTiers[${index}]`, errors, warnings);
  }
  const timeOfDay = timeBandsForRate(model);
  if (timeOfDay) {
    if (timeOfDay.effective !== null && timeOfDay.effective !== undefined && timeOfDay.effective !== '' && (!isoTimestamp(timeOfDay.effective))) errors.push(`${modelKey}.timeOfDay.effective is invalid`);
    for (const band of ['peak', 'offPeak']) {
      if (!timeOfDay[band]) errors.push(`${modelKey}.timeOfDay.${band} is missing`);
      else validateRateComponents(timeOfDay[band], required, `${modelKey}.timeOfDay.${band}`, errors, warnings);
    }
  }
  for (const [index, promotion] of (model.promotions ?? []).entries()) {
    if (!promotion || typeof promotion !== 'object') {
      errors.push(`${modelKey}.promotions[${index}] is not an object`);
      continue;
    }
    for (const dateField of ['starts', 'ends']) {
      if (promotion[dateField] !== null && promotion[dateField] !== undefined && !isoTimestamp(promotion[dateField])) errors.push(`${modelKey}.promotions[${index}].${dateField} is invalid`);
    }
    if (promotion.starts && promotion.ends && Date.parse(promotion.starts) > Date.parse(promotion.ends)) errors.push(`${modelKey}.promotions[${index}] ends before it starts`);
    if (promotion?.listRates) validateRateComponents(promotion.listRates, [...DEFAULT_REQUIRED_RATE_COMPONENTS], `${modelKey}.promotions[${index}].listRates`, errors, warnings);
  }
}

function validateRateTable(table, { requireComplete = false, requireParserVersion = false } = {}) {
  const errors = [];
  const warnings = [];
  if (!table || typeof table !== 'object') return { valid: false, errors: ['rate table is not an object'], warnings, coverage: null };
  if (!table.providers || typeof table.providers !== 'object') errors.push('rate table has no providers object');
  const coverage = { providers: 0, models: 0, completeModels: 0, incompleteModels: 0, requiredIncompleteModels: 0, components: Object.fromEntries(RATE_COMPONENTS.map((component) => [component, { complete: 0, missing: 0 }])) };
  for (const [providerKey, provider] of Object.entries(table.providers ?? {})) {
    coverage.providers += 1;
    if (!provider || typeof provider !== 'object' || !provider.models || typeof provider.models !== 'object') {
      errors.push(`${providerKey}: provider has no models object`);
      continue;
    }
    if (requireParserVersion && ![RATE_PARSER_VERSION, STEPFUN_PARSER_VERSION].includes(provider.parserVersion)) {
      errors.push(`${providerKey}: missing or unsupported parser version ${provider.parserVersion ?? '(missing)'}`);
    }
    for (const [modelKey, model] of Object.entries(provider.models)) {
      coverage.models += 1;
      const before = errors.length;
      validateRateModel(modelKey, model, errors, warnings);
      const required = Array.isArray(model?.requiredComponents) ? model.requiredComponents : RATE_COMPONENTS;
      const allMissing = missingRateComponents(model, RATE_COMPONENTS);
      const requiredMissing = missingRateComponents(model, required);
      const complete = errors.length === before && allMissing.length === 0;
      const requiredComplete = errors.length === before && requiredMissing.length === 0;
      if (complete) coverage.completeModels += 1;
      else coverage.incompleteModels += 1;
      if (!requiredComplete) coverage.requiredIncompleteModels += 1;
      const completeness = componentCompleteness(model);
      for (const component of RATE_COMPONENTS) {
        if (completeness[component] === 'published') coverage.components[component].complete += 1;
        else coverage.components[component].missing += 1;
      }
    }
  }
  if (requireComplete && coverage.incompleteModels > 0) errors.push(`rate table has ${coverage.incompleteModels} incomplete model(s)`);
  return { valid: errors.length === 0, errors, warnings, coverage };
}

function assertValidRateTable(table, options = {}) {
  const result = validateRateTable(table, options);
  if (!result.valid) throw new Error(`rate validation failed: ${result.errors.join('; ')}`);
  return result;
}

function atomicWriteFile(filePath, contents) {
  const absolute = path.resolve(filePath);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  const temporary = path.join(path.dirname(absolute), `.${path.basename(absolute)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, contents, 'utf8');
    try { fs.fsyncSync(descriptor); } catch { /* Some Windows filesystems do not support fsync. */ }
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, absolute);
  } finally {
    if (descriptor !== undefined) {
      try { fs.closeSync(descriptor); } catch { /* best effort cleanup */ }
    }
    if (fs.existsSync(temporary)) {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort cleanup */ }
    }
  }
  return absolute;
}

function atomicWriteJson(filePath, value) {
  return atomicWriteFile(filePath, JSON.stringify(value, null, 2) + '\n');
}

function readRateTable(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); } catch { return null; }
}

async function refreshRates({ ratesPath = RATES_PATH, fetchers = {}, now = new Date().toISOString(), throwOnFailure = false } = {}) {
  const previous = readRateTable(ratesPath);
  const sources = {
    commandcode: { fetch: fetchers.commandcode ?? extractCommandCodeRates, parserVersion: RATE_PARSER_VERSION },
    stepfun: { fetch: fetchers.stepfun ?? extractStepFunRates, parserVersion: STEPFUN_PARSER_VERSION },
  };
  const providers = {};
  const failures = [];
  for (const [providerKey, definition] of Object.entries(sources)) {
    try {
      const fetched = await definition.fetch();
      const fetchedModels = fetched?.models ?? fetched;
      const models = Array.isArray(fetchedModels)
        ? Object.fromEntries(fetchedModels.map((model) => {
          if (!model?.id) throw new Error('source returned a model without an id');
          if (fetchedModels.filter((candidate) => candidate?.id === model.id).length > 1) throw new Error(`duplicate model id in refreshed source: ${model.id}`);
          return [model.id, model];
        }))
        : fetchedModels;
      if (!models || typeof models !== 'object' || !Object.keys(models).length) throw new Error('source returned no models');
      const source = {
        source: RATES_SOURCE[providerKey],
        parserVersion: fetched?.parserVersion ?? definition.parserVersion,
        sourceVersion: fetched?.sourceVersion ?? definition.parserVersion,
        fetchedAt: fetched?.fetchedAt ?? now,
      };
      addRateCards(models, providerKey, source);
      source.fingerprint = fingerprint(models);
      const candidate = { [providerKey]: { ...source, models } };
      assertValidRateTable({ providers: candidate }, { requireParserVersion: true });
      providers[providerKey] = candidate[providerKey];
      console.error(`session-cost: refreshed ${Object.keys(models).length} ${providerKey} model rates`);
    } catch (error) {
      failures.push(`${providerKey}: ${error.message}`);
      console.error(`session-cost: ${providerKey} refresh FAILED (${error.message})`);
    }
  }
  if (failures.length) {
    if (previous) {
      const previousValidation = validateRateTable(previous, { requireParserVersion: true });
      if (previousValidation.valid) {
        console.error(`session-cost: rate refresh rejected (${failures.join('; ')}); kept the previous valid table`);
        if (throwOnFailure) throw new CostError(`rate refresh rejected: ${failures.join('; ')}`);
        return previous;
      }
    }
    throw new CostError(`rate refresh rejected: ${failures.join('; ')}`);
  }

  const table = {
    _meta: {
      schemaVersion: RATE_SCHEMA_VERSION,
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt: now,
      rateParserVersion: RATE_PARSER_VERSION,
      missingRateValue: null,
      componentCompletenessRule: 'input/output/cacheRead are required for a usable base rate; cacheWrite remains null when the source does not publish it',
      contextFallback: 'when call context is unavailable, use the highest published context tier and mark the result approximate',
      cacheWriteNote: 'Missing/null cache-write values are unknown, not zero. StepFun step-5-preview is the explicit input-rate exception.',
      peakWindows: {
        peakHoursPerDay: 7,
        offPeakHoursPerDay: 17,
        windows: '01-04 & 06-10 UTC, Mon-Fri',
        rule: 'peak when UTC weekday is Mon-Fri and 1 <= utcHour < 4 or 6 <= utcHour < 10',
        note: 'CommandCode source metadata; StepFun is flat.',
      },
    },
    providers,
    freeModels: previous?.freeModels ?? ['poolside/laguna-s-2.1-free', 'inclusionai/ling-3.0-flash-sante:free', 'laguna-s-2.1', 'ling-3.0-flash-sante'],
    aliases: previous?.aliases ?? {},
  };
  table._meta.rateCardFingerprint = fingerprint(providers);
  atomicWriteJson(ratesPath, table);
  console.error(`session-cost: wrote validated rate table -> ${ratesPath}`);
  return table;
}

function loadRates(ratesPath = RATES_PATH) {
  if (!fs.existsSync(ratesPath)) fail(`rate table missing at ${ratesPath} — run with --refresh-rates`);
  let table;
  try { table = JSON.parse(fs.readFileSync(ratesPath, 'utf8')); } catch (error) { fail(`invalid rate table JSON at ${ratesPath}: ${error.message}`); }
  const validation = validateRateTable(table, { requireParserVersion: true });
  if (!validation.valid) fail(`invalid rate table at ${ratesPath}: ${validation.errors.join('; ')}`);
  return table;
}

// Rate lookup is provider-first: the model id is only matched inside that provider's table.
function resolveRate(table, provider, providerModelId) {
  const pkey = normalizeProvider(provider);
  const entry = table.providers?.[pkey];
  if (!entry) return { key: null, rate: null, free: false, providerKey: pkey, source: null, sourceVersion: null, fetchedAt: null };

  const normalized = normalizeModelId(providerModelId);
  const alias = table.aliases?.[`${pkey}/${providerModelId}`] ?? table.aliases?.[providerModelId];
  const key = alias ?? Object.keys(entry.models).find((k) => normalizeModelId(k) === normalized);
  if (key && entry.models[key]) {
    return {
      key,
      rate: entry.models[key],
      free: false,
      providerKey: pkey,
      source: entry.source ?? null,
      sourceVersion: entry.parserVersion ?? entry.sourceVersion ?? null,
      fetchedAt: entry.fetchedAt ?? null,
    };
  }

  const isFree = (table.freeModels ?? []).some((f) => normalizeModelId(f) === normalized);
  if (isFree) {
    return {
      key: providerModelId,
      // This is an explicit free-tier policy, not a fallback for a missing published field.
      rate: { name: providerModelId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, free: true, componentCompleteness: Object.fromEntries(RATE_COMPONENTS.map((component) => [component, 'published'])) },
      free: true,
      providerKey: pkey,
      source: entry.source ?? null,
      sourceVersion: entry.parserVersion ?? entry.sourceVersion ?? null,
      fetchedAt: entry.fetchedAt ?? null,
    };
  }
  return { key: null, rate: null, free: false, providerKey: pkey, source: entry.source ?? null, sourceVersion: entry.parserVersion ?? entry.sourceVersion ?? null, fetchedAt: entry.fetchedAt ?? null };
}

// ---------------------------------------------------------------- billing

function finiteToken(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function rowContextTokens(row) {
  for (const key of ['context_tokens', 'contextTokens', 'prompt_context_tokens']) {
    const value = finiteToken(row?.[key]);
    if (value !== null) return value;
  }
  return null;
}

function chooseContextTier(rate, contextTokens) {
  const tiers = contextTiersForRate(rate);
  if (!tiers.length) return { tier: null, exact: true, contextMaxTokens: null, label: null, reason: null };
  if (contextTokens !== null) {
    const selected = tiers.find((tier) => tier.maxContext === null || Number(tier.maxContext) >= contextTokens);
    if (selected) return { tier: selected, exact: true, contextMaxTokens: selected.maxContext ?? null, label: selected.label ?? selected.context ?? null, reason: null };
    return { tier: tiers[tiers.length - 1], exact: false, contextMaxTokens: tiers[tiers.length - 1].maxContext ?? null, label: tiers[tiers.length - 1].label ?? tiers[tiers.length - 1].context ?? null, reason: 'call context exceeds the published context tiers' };
  }
  // Context is part of the price, not a cosmetic label. Without it, take the maximum published
  // rate independently for every component. This is a conservative upper bound even when the
  // source's most expensive tier differs by component.
  const conservative = Object.fromEntries(RATE_COMPONENTS.map((component) => {
    const values = tiers.map((tier) => componentValue(tier, component)).filter((value) => value !== null);
    return [component, values.length ? Math.max(...values) : null];
  }));
  conservative.maxContext = null;
  return { tier: conservative, exact: false, contextMaxTokens: null, label: 'conservative-max', reason: 'call context unavailable; highest published rate for each component used' };
}

function promotionStatusAt(promotion, timestamp, fetchedAt) {
  if (!promotion) return 'none';
  const ts = finiteToken(timestamp);
  const startsValue = promotion.starts ?? promotion.effectiveFrom;
  const endsValue = promotion.ends ?? promotion.effectiveThrough;
  const starts = startsValue ? Date.parse(startsValue) : null;
  const ends = endsValue ? Date.parse(endsValue) : null;
  if (ts !== null && starts !== null && ts < starts) return 'not-yet-active';
  if (ts !== null && ends !== null && ts > ends) return 'expired';
  if (starts !== null && ends !== null && ts !== null && ts >= starts && ts <= ends) return 'active';
  if (!starts && !ends) return fetchedAt && ts !== null && ts >= Date.parse(fetchedAt) ? 'active-at-fetch' : 'unknown-window';
  return 'unknown-window';
}

function rateCardForSelection(rate, band, contextMaxTokens, promotionId, promotionState, timestamp) {
  const cards = Array.isArray(rate?.rateCards) ? rate.rateCards : [];
  if (!cards.length) return null;
  const ts = finiteToken(timestamp);
  const wantsList = promotionState === 'expired' || promotionState === 'not-yet-active';
  const applicable = (card) => {
    if (card.timeBand !== band || (card.contextMaxTokens ?? null) !== (contextMaxTokens ?? null) || (card.promotionId ?? null) !== (promotionId ?? null)) return false;
    if (wantsList && card.promotionState !== 'list') return false;
    if (wantsList && card.promotionState === 'list') return true;
    // Fetch-observation cards are usable as a disclosed fallback. Source-dated cards are
    // strict historical records and must not be used outside their effective interval.
    if (ts === null || card.effectiveDateSource === 'fetch-observation') return true;
    const from = card.effectiveFrom ? Date.parse(card.effectiveFrom) : null;
    const through = card.effectiveThrough ? Date.parse(card.effectiveThrough) : null;
    return (from === null || ts >= from) && (through === null || ts <= through);
  };
  const matches = cards.filter(applicable);
  if (matches.length) {
    return matches.sort((a, b) => {
      const aFrom = a.effectiveFrom ? Date.parse(a.effectiveFrom) : -Infinity;
      const bFrom = b.effectiveFrom ? Date.parse(b.effectiveFrom) : -Infinity;
      return bFrom - aFrom;
    })[0];
  }
  return null;
}

function rateSelectionForCall(rate, row, rateInfo = {}) {
  if (!rate) {
    return {
      rates: Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null])),
      band: 'unknown',
      contextMaxTokens: null,
      contextBand: null,
      exact: false,
      coverage: 'unknown',
      missingComponents: [...RATE_COMPONENTS],
      warnings: ['no matching provider/model rate'],
      rateCard: null,
      rateCardFingerprint: null,
    };
  }
  const timestamp = finiteToken(row?.ts);
  const contextTokens = rowContextTokens(row);
  const context = chooseContextTier(rate, contextTokens);
  let band = bandForTimestamp(row?.ts, rate);
  let values = context.tier ?? rate;
  let promotion = null;
  let promotionState = 'none';
  for (const candidate of rate.promotions ?? []) {
    const state = promotionStatusAt(candidate, timestamp, rateInfo.fetchedAt ?? rateInfo.sourceFetchedAt ?? rate.fetchedAt);
    if (state !== 'none' && !promotion) {
      promotion = candidate;
      promotionState = state;
      if (state === 'active' || state === 'active-at-fetch') break;
    }
  }
  const usingListRates = Boolean(promotion && (promotionState === 'expired' || promotionState === 'not-yet-active') && promotion.listRates);
  if (usingListRates) values = promotion.listRates;
  if (promotion && (promotionState === 'not-yet-active' || promotionState === 'expired') && !promotion.listRates) {
    values = Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null]));
  }
  if (band === 'unavailable') values = Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null]));
  if (band !== 'flat' && band !== 'unavailable' && !(promotion && !usingListRates && (promotionState === 'not-yet-active' || promotionState === 'expired'))) {
    const bandRates = rate.timeOfDay?.[band];
    if (context.tier && bandRates && !usingListRates) {
      const combined = rateComponents(context.tier);
      for (const component of RATE_COMPONENTS) {
        const bandValue = componentValue(bandRates, component);
        combined[component] = combined[component] === null || bandValue === null
          ? null
          : Math.max(combined[component], bandValue);
      }
      values = combined;
    } else {
      values = bandRates ?? values;
    }
  }
  const card = rateCardForSelection(rate, band, context.contextMaxTokens, promotion?.id ?? null, promotionState, timestamp);
  const hasSourceDatedCards = Array.isArray(rate.rateCards) && rate.rateCards.some((candidate) => candidate.effectiveDateSource !== 'fetch-observation' && (candidate.effectiveFrom || candidate.effectiveThrough));
  if (card && context.exact && !(context.tier && band !== 'flat')) values = card;
  else if (!card && hasSourceDatedCards) values = Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null]));
  const rates = rateComponents(values);
  const promotionStart = promotion?.starts ?? promotion?.effectiveFrom ?? null;
  let effectiveFrom = rate.effectiveFrom ?? (card?.effectiveDateSource === 'source' ? card.effectiveFrom : null) ?? null;
  if (promotionState === 'active' && promotionStart) effectiveFrom = promotionStart;
  else if (promotionState === 'active-at-fetch') effectiveFrom = rateInfo.fetchedAt ?? rate.fetchedAt ?? null;
  else if (promotionState === 'not-yet-active' || promotionState === 'expired') effectiveFrom = null;
  const effectiveMs = effectiveFrom ? Date.parse(effectiveFrom) : null;
  const effectiveUnavailable = timestamp !== null && effectiveMs !== null && timestamp < effectiveMs;
  if (effectiveUnavailable) {
    for (const component of RATE_COMPONENTS) rates[component] = null;
  }
  const missingComponents = RATE_COMPONENTS.filter((component) => rates[component] === null);
  const warnings = [];
  if (!context.exact && context.reason) warnings.push(context.reason);
  if (promotionState === 'active-at-fetch' || promotionState === 'unknown-window') warnings.push('promotion window is not fully effective-dated');
  if (effectiveUnavailable) warnings.push(`call predates the known rate effective date ${effectiveFrom}`);
  if (!card && hasSourceDatedCards) warnings.push('no rate card is effective for this call timestamp');
  if (!effectiveFrom && !effectiveUnavailable && !rate.free) warnings.push('rate effective date is not published; using the observed rate snapshot as an estimate');
  if (typeof rate.sourceNote === 'string' && rate.sourceNote) warnings.push('provider source describes this as a mean/estimate; actual upstream cost may vary');
  if (missingComponents.length) warnings.push(`missing rate component(s): ${missingComponents.join(', ')}`);
  const exact = (rate.free === true) || (context.exact && !effectiveUnavailable && Boolean(effectiveFrom) && missingComponents.length === 0 && promotionState !== 'active-at-fetch' && promotionState !== 'unknown-window' && !rate.sourceNote);
  return {
    rates,
    band,
    contextMaxTokens: context.contextMaxTokens,
    contextBand: context.label ?? null,
    exact,
    coverage: missingComponents.length ? 'partial' : 'complete',
    missingComponents,
    warnings,
    promotionId: promotion?.id ?? null,
    promotionState,
    rateCard: card,
    rateCardFingerprint: card?.rateCardFingerprint ?? rate.rateCardFingerprint ?? null,
    effectiveFrom: promotionState === 'not-yet-active' || promotionState === 'expired' ? null : (card?.effectiveFrom ?? effectiveFrom),
    effectiveThrough: promotionState === 'not-yet-active' || promotionState === 'expired' ? null : (card?.effectiveThrough ?? null),
    effectiveDateSource: promotionState === 'not-yet-active' || promotionState === 'expired' ? 'promotion-boundary' : (card?.effectiveDateSource ?? (effectiveFrom ? 'source' : null)),
    source: rateInfo.source ?? rate.source ?? null,
    sourceVersion: rateInfo.sourceVersion ?? rate.sourceVersion ?? null,
  };
}

// Published window: "01-04 & 06-10 UTC, Mon-Fri" — peak on those UTC hours on weekdays.
function bandForTimestamp(ts, rate) {
  if (!rate?.timeOfDay) return 'flat';
  const timestamp = finiteToken(ts);
  const effective = rate.timeOfDay.effective;
  if (timestamp !== null && effective && timestamp < Date.parse(effective)) return 'unavailable';
  if (timestamp === null) return 'flat';
  const d = new Date(timestamp);
  const day = d.getUTCDay();
  const hour = d.getUTCHours();
  const isWeekday = day >= 1 && day <= 5;
  const inWindow = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return isWeekday && inWindow ? 'peak' : 'offPeak';
}

function ratesForBand(rate, band, contextTier = null) {
  if (!rate) return Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null]));
  let source = rate;
  if (band !== 'flat' && band !== 'unavailable') {
    source = rate.timeOfDay?.[band] ?? null;
    if (!source) return Object.fromEntries(RATE_COMPONENTS.map((component) => [component, null]));
  } else if (contextTier) {
    source = contextTier;
  }
  // Do not use nullish coalescing here. A missing published component is unknown, not free.
  return Object.fromEntries(RATE_COMPONENTS.map((component) => [component, componentValue(source, component)]));
}

function emptyAggregate() {
  return {
    calls: 0,
    inputTokens: 0, outputTokens: 0, reasoningTokens: 0,
    cacheReadTokens: 0, cacheWriteTokens: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0,
    costComponentCompleteness: { input: 'complete', output: 'complete', cacheRead: 'complete', cacheWrite: 'complete' },
    pricedCalls: 0, partialCalls: 0, unknownCalls: 0, estimatedCalls: 0,
    tokenMissingCalls: 0, missingTokenComponents: {},
    missingRateComponents: {}, pricingWarnings: [],
    bands: { peak: 0, offPeak: 0, flat: 0 },
    rateBandsUsed: {},
    recordedCostUsd: 0, recordedCostKnownCalls: 0, recordedCostMissingCalls: 0, recordedCostZeroCalls: 0,
    firstTs: null, lastTs: null,
  };
}

function addWarning(agg, warning) {
  if (warning && !agg.pricingWarnings.includes(warning)) agg.pricingWarnings.push(warning);
}

function readRecordedCost(row) {
  if (!hasOwn(row, 'cost_usd') || row.cost_usd === null || row.cost_usd === undefined || row.cost_usd === '') return { known: false, value: null };
  const value = Number(row.cost_usd);
  return Number.isFinite(value) ? { known: true, value } : { known: false, value: null };
}

function accumulateRecordedCost(agg, row) {
  const recorded = readRecordedCost(row);
  if (recorded.known) {
    agg.recordedCostUsd += recorded.value;
    agg.recordedCostKnownCalls += 1;
    if (recorded.value === 0) agg.recordedCostZeroCalls += 1;
  } else {
    agg.recordedCostMissingCalls += 1;
  }
  return agg;
}

function accumulate(agg, row, rate, pricing = null) {
  const selection = pricing && typeof pricing === 'object' && !Array.isArray(pricing)
    ? pricing
    : { band: typeof pricing === 'string' ? pricing : bandForTimestamp(row?.ts, rate), rates: ratesForBand(rate, typeof pricing === 'string' ? pricing : bandForTimestamp(row?.ts, rate)) };
  const band = selection.band ?? 'unknown';
  const r = selection.rates ?? ratesForBand(rate, band);
  const tokenValues = {
    input: finiteToken(row?.input_tokens),
    output: finiteToken(row?.output_tokens),
    cacheRead: finiteToken(row?.cache_read_tokens),
    cacheWrite: finiteToken(row?.cache_write_tokens),
  };
  const missingTokenComponents = Object.entries(tokenValues).filter(([, value]) => value === null).map(([key]) => key);
  const input = tokenValues.input ?? 0;
  const output = tokenValues.output ?? 0;
  const cacheRead = tokenValues.cacheRead ?? 0;
  const cacheWrite = tokenValues.cacheWrite ?? 0;
  const missingUsedComponents = RATE_COMPONENTS.filter((component) => tokenValues[component] > 0 && r[component] === null);
  const ratePresent = Boolean(rate);
  const completeCall = ratePresent && missingUsedComponents.length === 0 && missingTokenComponents.length === 0;

  agg.calls += 1;
  agg.inputTokens += input;
  agg.outputTokens += output;
  agg.reasoningTokens += finiteToken(row?.reasoning_tokens) ?? 0;
  agg.cacheReadTokens += cacheRead;
  agg.cacheWriteTokens += cacheWrite;
  for (const [component, value] of Object.entries({ input, output, cacheRead, cacheWrite })) {
    if (r[component] !== null && r[component] !== undefined) {
      const cost = (value / PER_MILLION) * r[component];
      if (component === 'input') agg.costInput += cost;
      else if (component === 'output') agg.costOutput += cost;
      else if (component === 'cacheRead') agg.costCacheRead += cost;
      else if (component === 'cacheWrite') agg.costCacheWrite += cost;
    }
  }
  agg.bands[band] = (agg.bands[band] ?? 0) + 1;
  agg.rateBandsUsed[band] = r;
  if (completeCall) {
    agg.pricedCalls += 1;
    if (selection.exact === false) agg.estimatedCalls += 1;
  } else if (ratePresent) agg.partialCalls += 1;
  else agg.unknownCalls += 1;
  if (missingTokenComponents.length) {
    agg.tokenMissingCalls += 1;
    for (const component of missingTokenComponents) agg.missingTokenComponents[component] = (agg.missingTokenComponents[component] ?? 0) + 1;
  }
  for (const component of missingUsedComponents) {
    agg.missingRateComponents[component] = (agg.missingRateComponents[component] ?? 0) + 1;
    agg.costComponentCompleteness[component] = ratePresent ? 'partial' : 'unknown';
  }
  for (const warning of selection.warnings ?? []) addWarning(agg, warning);
  accumulateRecordedCost(agg, row);
  const ts = finiteToken(row?.ts);
  if (ts !== null && (agg.firstTs === null || ts < agg.firstTs)) agg.firstTs = ts;
  if (ts !== null && (agg.lastTs === null || ts > agg.lastTs)) agg.lastTs = ts;
  return agg;
}

function finalize(agg) {
  const promptTokens = agg.inputTokens + agg.cacheReadTokens + agg.cacheWriteTokens;
  const totalTokens = promptTokens + agg.outputTokens;
  const totalCost = agg.costInput + agg.costOutput + agg.costCacheRead + agg.costCacheWrite;
  const pricingCoverage = agg.calls === 0 ? 'no-calls' : agg.unknownCalls > 0 ? (agg.pricedCalls > 0 ? 'partial' : 'unknown') : (agg.partialCalls > 0 ? 'partial' : 'complete');
  const pricingExact = pricingCoverage === 'no-calls' || (pricingCoverage === 'complete' && agg.estimatedCalls === 0 && agg.tokenMissingCalls === 0 && Object.keys(agg.missingRateComponents).length === 0);
  const recordedCostComplete = agg.recordedCostMissingCalls === 0;
  const finalized = {
    ...agg,
    promptTokens,
    totalTokens,
    totalCost: pricingCoverage === 'unknown' ? null : totalCost,
    pricingCoverage,
    pricingExact,
    rateCalculatedCostUsd: agg.calls === 0 ? 0 : (pricingCoverage === 'complete' && agg.pricedCalls > 0) ? totalCost : null,
    apiEquivalentCostUsd: pricingCoverage === 'complete' || pricingCoverage === 'no-calls' ? (agg.calls === 0 ? 0 : agg.pricedCalls > 0 ? totalCost : null) : null,
    partialRateCalculatedCostUsd: agg.pricedCalls > 0 || agg.partialCalls > 0 ? totalCost : null,
    recordedCostUsd: agg.calls === 0 ? 0 : recordedCostComplete ? agg.recordedCostUsd : null,
    partialRecordedCostUsd: agg.recordedCostUsd,
    recordedCostCoverage: agg.calls === 0 ? 'no-calls' : recordedCostComplete ? 'complete' : 'partial',
    recordedCostSource: 'local_runtime_token_usage.cost_usd',
    cacheRate: promptTokens > 0 ? agg.cacheReadTokens / promptTokens : 0,
    blendedInputUsdPerM: Object.keys(agg.missingRateComponents).length ? null : (promptTokens > 0 ? ((agg.costCacheRead + agg.costInput) / promptTokens) * PER_MILLION : 0),
    allInUsdPerM: pricingCoverage === 'unknown' ? null : (totalTokens > 0 ? (totalCost / totalTokens) * PER_MILLION : 0),
  };
  const costFieldByComponent = { input: 'costInput', output: 'costOutput', cacheRead: 'costCacheRead', cacheWrite: 'costCacheWrite' };
  const tokenFieldByComponent = { input: 'inputTokens', output: 'outputTokens', cacheRead: 'cacheReadTokens', cacheWrite: 'cacheWriteTokens' };
  for (const component of RATE_COMPONENTS) {
    if (agg.missingRateComponents[component] > 0 && agg[tokenFieldByComponent[component]] > 0) finalized[costFieldByComponent[component]] = null;
  }
  return finalized;
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

function ledgerUsageSelect(db) {
  let available = new Set();
  try {
    available = new Set(db.prepare('PRAGMA table_info(local_runtime_token_usage)').all().map((column) => String(column.name).toLowerCase()));
  } catch {
    // Older test/runtime ledgers may not expose PRAGMA metadata; the required columns below
    // still provide a useful error if the table is incompatible.
  }
  const columns = ['session_id', 'agent_name', 'turn_id', 'ts', 'input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens', 'cost_usd', 'context_tokens'];
  const select = columns.map((column) => available.has(column) ? column : `NULL AS ${column}`).join(', ');
  return `SELECT ${select} FROM local_runtime_token_usage`;
}

function buildReport(db, dataDir, table, sessionId, includeChildren) {
  const childIds = childSessionIds(db, sessionId);
  const ids = includeChildren ? [sessionId, ...childIds] : [sessionId];
  const pricers = new Map(ids.map((id) => [id, buildPricer(db, dataDir, table, id)]));
  const target = pricers.get(sessionId);

  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`${ledgerUsageSelect(db)} WHERE session_id IN (${placeholders}) ORDER BY ts ASC`).all(...ids);

  const agg = emptyAggregate();
  // Keyed by provider + model: the same model id at two providers must stay separate.
  const perModel = new Map();
  const providersSeen = new Map();
  let inferredRows = 0;

  const priceRow = (pricer, row) => {
    const { modelId, provider, inferred } = modelForRow(pricer, row);
    const rateInfo = modelId ? pricer.rateFor(provider, modelId) : { key: null, rate: null, free: false, providerKey: normalizeProvider(provider), source: null, sourceVersion: null, fetchedAt: null };
    const rate = rateInfo.rate ?? null;
    return { modelId, provider, inferred, rateInfo, rate, pricing: rateSelectionForCall(rate, row, rateInfo) };
  };

  for (const row of rows) {
    const pricer = pricers.get(row.session_id);
    const { modelId, provider, inferred, rateInfo, rate, pricing } = priceRow(pricer, row);
    if (inferred) inferredRows += 1;

    accumulate(agg, row, rate, pricing);

    const pkey = normalizeProvider(provider);
    const key = `${pkey}::${modelId ?? '(unknown)'}`;
    if (!perModel.has(key)) {
      // accumulate() owns the counters; only the identity and rate provenance fields are added here.
      perModel.set(key, {
        modelId: modelId ?? '(unknown)',
        provider,
        providerKey: pkey,
        rateKey: rateInfo.key,
        rateKnown: Boolean(rate),
        rateIsFree: rateInfo.free,
        rateSource: rateInfo.source ?? rate?.source ?? null,
        rateSourceVersion: rateInfo.sourceVersion ?? rate?.sourceVersion ?? null,
        rateFetchedAt: rateInfo.fetchedAt ?? rate?.fetchedAt ?? null,
        rateSourceNote: rate?.sourceNote ?? null,
        rateCardFingerprint: rate?.rateCardFingerprint ?? null,
        rateCardFingerprints: [],
        selectedComponentCompleteness: null,
        rateEffectiveDates: [],
        componentCompleteness: rate ? componentCompleteness(rate) : Object.fromEntries(RATE_COMPONENTS.map((component) => [component, 'unavailable'])),
        inferredCalls: 0,
        ...emptyAggregate(),
      });
    }
    const entry = perModel.get(key);
    if (inferred) entry.inferredCalls += 1;
    if (rate && !entry.rateCardFingerprint) entry.rateCardFingerprint = rate.rateCardFingerprint ?? null;
    if (pricing?.rateCardFingerprint && !entry.rateCardFingerprints.includes(pricing.rateCardFingerprint)) entry.rateCardFingerprints.push(pricing.rateCardFingerprint);
    if (pricing) {
      entry.selectedComponentCompleteness = Object.fromEntries(RATE_COMPONENTS.map((component) => [component, pricing.rates?.[component] === null || pricing.rates?.[component] === undefined ? 'missing' : 'published']));
      if (pricing.effectiveFrom || pricing.effectiveThrough) entry.rateEffectiveDates.push({ from: pricing.effectiveFrom ?? null, through: pricing.effectiveThrough ?? null, band: pricing.band, contextMaxTokens: pricing.contextMaxTokens ?? null, contextBand: pricing.contextBand ?? null, promotionId: pricing.promotionId ?? null });
    }
    accumulate(entry, row, rate, pricing);

    if (pkey) providersSeen.set(pkey, true);
  }

  const perSession = {};
  for (const id of ids) {
    const sub = emptyAggregate();
    for (const row of rows.filter((r) => r.session_id === id)) {
      const { rate, pricing } = priceRow(pricers.get(id), row);
      accumulate(sub, row, rate, pricing);
    }
    const fin = finalize(sub);
    perSession[id] = {
      role: id === sessionId ? 'target' : 'child',
      billed: true,
      calls: fin.calls,
      totalTokens: fin.totalTokens,
      cacheRate: fin.cacheRate,
      totalCost: fin.totalCost,
      rateCalculatedCostUsd: fin.rateCalculatedCostUsd,
      partialRateCalculatedCostUsd: fin.partialRateCalculatedCostUsd,
      apiEquivalentCostUsd: fin.pricingCoverage === 'complete' ? fin.rateCalculatedCostUsd : null,
      recordedCostUsd: fin.recordedCostUsd,
      pricingCoverage: fin.pricingCoverage,
      pricingExact: fin.pricingExact,
    };
  }
  for (const id of includeChildren ? [] : childIds) {
    perSession[id] = { role: 'child', billed: false, calls: null, totalTokens: null, cacheRate: null, totalCost: null, rateCalculatedCostUsd: null, partialRateCalculatedCostUsd: null, apiEquivalentCostUsd: null, recordedCostUsd: null, pricingCoverage: 'not-billed', pricingExact: false };
  }

  const models = [...perModel.values()].map((m) => {
    const fin = finalize(m);
    return {
      ...fin,
      modelId: m.modelId,
      provider: m.provider,
      providerKey: m.providerKey,
      rateKey: m.rateKey,
      rateKnown: m.rateKnown,
      rateIsFree: m.rateIsFree,
      rateSource: m.rateSource,
      rateSourceVersion: m.rateSourceVersion,
      rateFetchedAt: m.rateFetchedAt,
      rateSourceNote: m.rateSourceNote,
      rateCardFingerprint: m.rateCardFingerprint,
      rateCardFingerprints: m.rateCardFingerprints,
      rateEffectiveDates: m.rateEffectiveDates,
      componentCompleteness: m.componentCompleteness,
      selectedComponentCompleteness: m.selectedComponentCompleteness,
      inferredCalls: m.inferredCalls,
    };
  });
  const lastTs = rows.length ? finiteToken(rows[rows.length - 1].ts) : null;
  const snapshotAt = Date.now();

  // Per-provider mirror provenance, since a multi-provider session draws on several tables.
  const providersUsed = [...providersSeen].map(([pkey]) => {
    const entry = table.providers?.[pkey];
    return {
      providerKey: pkey,
      source: entry?.source ?? null,
      sourceVersion: entry?.parserVersion ?? entry?.sourceVersion ?? null,
      fetchedAt: entry?.fetchedAt ?? null,
      fingerprint: entry?.fingerprint ?? null,
      mirrored: Boolean(entry),
      componentCompleteness: entry ? validateRateTable({ providers: { [pkey]: entry } }).coverage?.components ?? null : null,
    };
  });

  const finalAggregate = finalize(agg);
  const rateKnown = models.length === 0 || models.every((m) => m.rateKnown);
  const pricingComplete = models.length === 0 || models.every((m) => m.pricingCoverage === 'complete' || m.pricingCoverage === 'no-calls');
  const pricingExact = models.length === 0 || models.every((m) => m.pricingExact);

  return {
    sessionId,
    title: target.meta?.title ?? null,
    agentName: target.meta?.agent_name ?? null,
    provider: target.provider,
    model: target.defaultModel,
    rateKnown,
    pricingComplete,
    pricingExact,
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
    ...finalAggregate,
  };
}

// ---------------------------------------------------------------- rendering

const M = (tokens) => (Number(tokens || 0) / PER_MILLION).toFixed(4);
const USD = (v) => (v === null || v === undefined || !Number.isFinite(Number(v)) ? '—' : `$${Number(v).toFixed(6)}`);
const stamp = (ts) => (ts === null || ts === undefined ? 'n/a' : new Date(Number(ts)).toISOString().replace('T', ' ').slice(0, 16) + ' UTC');

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
  if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
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
  const unpricedModels = rep.models.filter((m) => m.pricingCoverage === 'unknown' || m.pricingCoverage === 'partial');
  const unpricedTokens = unpricedModels.reduce((n, m) => n + m.totalTokens, 0);
  const unpricedCalls = unpricedModels.reduce((n, m) => n + m.calls, 0);
  const hasUnpriced = unpricedModels.length > 0;
  const anyPriced = rep.models.some((m) => m.rateKnown) && rep.partialRateCalculatedCostUsd !== null;
  const exactPricing = rep.pricingExact === true;
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
    const displayRate = rep.rateCalculatedCostUsd ?? rep.partialRateCalculatedCostUsd;
    const label = rep.pricingCoverage === 'partial' ? 'PARTIAL RATE ESTIMATE' : exactPricing ? 'RATE-CALCULATED COST' : 'RATE ESTIMATE';
    const qualifier = rep.pricingCoverage === 'partial' ? ' (known components only)' : exactPricing ? '' : ' (not an invoice; context/promotion/provider variance may apply)';
    L.push(`${label} ${USD(displayRate)} for ${M(rep.totalTokens)} M tokens — ${USD(rep.allInUsdPerM)}/M all-in${qualifier}`);
  } else {
    L.push(`COST UNAVAILABLE — ${M(rep.totalTokens)} M tokens, but no complete rate-covered components are available for this session`);
    L.push('The rate table is missing, partial, or not effective for these calls (see "Rates actually billed").');
  }
  L.push('');

  // Effective rate = what was actually billed per million of that token type. It blends bands and
  // models automatically, so it is the honest number rather than a sticker price.
  const eff = (cost, tokens) => (tokens > 0 && cost > 0 ? `$${((cost / tokens) * PER_MILLION).toFixed(4)}` : '—');
  const share = (t) => (rep.promptTokens > 0 ? `${((t / rep.promptTokens) * 100).toFixed(1)}%` : '—');
  const missingSelectedComponent = (component) => rep.models.some((model) => {
    const completeness = model.selectedComponentCompleteness ?? model.componentCompleteness ?? {};
    const tokens = { input: model.inputTokens, output: model.outputTokens, cacheRead: model.cacheReadTokens, cacheWrite: model.cacheWriteTokens }[component] ?? 0;
    return tokens > 0 && completeness[component] !== 'published';
  });
  const costCell = (component, value) => (missingSelectedComponent(component) ? '—' : anyPriced ? USD(value) : '—');

  L.push('What was used, and what it cost');
  L.push(...renderTable(
    ['Token type', 'Tokens (M)', 'Share of prompt', 'Rate $/M', 'Cost'],
    [
      ['Fresh input (uncached)', M(rep.inputTokens), share(rep.inputTokens), hasUnpriced ? '—' : eff(rep.costInput, rep.inputTokens), costCell('input', rep.costInput)],
      ['Cached prompt read', M(rep.cacheReadTokens), share(rep.cacheReadTokens), hasUnpriced ? '—' : eff(rep.costCacheRead, rep.cacheReadTokens), costCell('cacheRead', rep.costCacheRead)],
      ['Cache write', M(rep.cacheWriteTokens), share(rep.cacheWriteTokens), hasUnpriced ? '—' : eff(rep.costCacheWrite, rep.cacheWriteTokens), costCell('cacheWrite', rep.costCacheWrite)],
      ['Output', M(rep.outputTokens), '—', hasUnpriced ? '—' : eff(rep.costOutput, rep.outputTokens), costCell('output', rep.costOutput)],
      ['Total', M(rep.totalTokens), '—', '—', anyPriced ? USD(rep.totalCost) : '—'],
    ],
    ['l', 'r', 'r', 'r', 'r'],
  ));
  L.push(`Recorded ledger cost: ${rep.recordedCostUsd === null ? 'unavailable' : USD(rep.recordedCostUsd)} · rate/API-equivalent estimate: ${rep.apiEquivalentCostUsd === null ? 'unavailable (partial/unknown pricing)' : USD(rep.apiEquivalentCostUsd)}`);

  // The one insight that matters in agent sessions: most prompt is cache, priced far below fresh.
  // Only claimed when every call was priced — otherwise the effective rates are diluted by
  // unpriced tokens and the ratio would understate the real discount.
  if (rep.pricingExact && !hasUnpriced && rep.cacheReadTokens > 0 && rep.costCacheRead > 0 && rep.costInput > 0) {
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
    if (!m.rateKnown || m.pricingCoverage === 'unknown') {
      L.push(`  ${who}${m.modelId} — no usable rate for ${m.calls} call(s), ${M(m.totalTokens)} M tokens`);
      continue;
    }
    const bands = Object.entries(m.rateBandsUsed)
      .map(([band, r]) => `${band === 'flat' ? 'flat' : band} $${fmtRate(r.input)} in / $${fmtRate(r.cacheRead)} cache read / $${fmtRate(r.output)} out${r.cacheWrite !== null && r.cacheWrite !== undefined ? ` / $${fmtRate(r.cacheWrite)} cache write` : ' / cache write —'}`)
      .join(', ');
    const status = m.pricingCoverage === 'partial' ? 'partial rate coverage' : m.pricingExact ? 'exact' : 'estimate';
    L.push(`  ${who}${m.modelId} — ${bands} per 1M  (${m.calls} call(s), ${status}, ${USD(m.totalCost)})`);
  }
  L.push(`  band split: ${rep.bands.offPeak ?? 0} off-peak · ${rep.bands.peak ?? 0} peak · ${rep.bands.flat ?? 0} flat${rep.bands.unavailable ? ` · ${rep.bands.unavailable} unavailable` : ''}`);
  if (hasUnpriced && anyPriced) {
    L.push(`  ! ${unpricedCalls} call(s) / ${M(unpricedTokens)} M tokens have unknown or partial rate coverage and are NOT a complete total.`);
  }
  if (rep.pricingWarnings?.length) {
    for (const warning of rep.pricingWarnings) L.push(`  ! ${warning}`);
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
    L.push(`Rates for ${p.providerKey} mirrored ${p.fetchedAt ?? 'unknown'} from ${p.source}${p.sourceVersion ? ` (parser ${p.sourceVersion})` : ''}`);
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
function billingForReport(report) {
  const calls = Number(report.calls) || 0;
  const coverage = report.pricingCoverage ?? (report.rateKnown ? 'complete' : 'unknown');
  const rateValue = hasOwn(report, 'rateCalculatedCostUsd')
    ? report.rateCalculatedCostUsd
    : (report.pricedCalls > 0 ? report.totalCost : calls === 0 ? 0 : null);
  const apiValue = coverage === 'complete' || coverage === 'no-calls' ? rateValue : null;
  const recordedValue = report.recordedCostUsd ?? null;
  const classification = calls === 0
    ? 'no-calls'
    : coverage === 'unknown'
      ? 'cost-unavailable'
      : coverage === 'partial'
        ? 'partial-rate-estimate'
        : report.pricingExact
          ? 'rate-calculated'
          : 'rate-estimated';
  return {
    classification,
    costBasis: 'provider-rate-card',
    rateSchemaVersion: RATE_SCHEMA_VERSION,
    rateCalculatedCostUsd: rateValue,
    apiEquivalentCostUsd: apiValue,
    calculatedCostUsd: rateValue,
    partialRateCalculatedCostUsd: report.partialRateCalculatedCostUsd ?? null,
    recordedCostUsd: recordedValue,
    partialRecordedCostUsd: report.partialRecordedCostUsd ?? null,
    recordedCostSource: report.recordedCostSource ?? 'local_runtime_token_usage.cost_usd',
    recordedCostCoverage: report.recordedCostCoverage ?? (calls === 0 ? 'no-calls' : 'unavailable'),
    rateKnown: Boolean(report.rateKnown),
    pricingCoverage: coverage,
    coverage,
    pricingExact: Boolean(report.pricingExact),
    estimateOnly: calls > 0 && !report.pricingExact,
    estimated: calls > 0 && !report.pricingExact,
    ratesRefreshedAt: report.ratesRefreshedAt ?? null,
    rateCardFingerprints: [...new Set((report.models ?? []).flatMap((model) => [model.rateCardFingerprint, ...(model.rateCardFingerprints ?? [])]).filter(Boolean))],
    rateComponentCompleteness: Object.fromEntries(RATE_COMPONENTS.map((component) => [component, {
      complete: (report.models ?? []).filter((model) => (model.selectedComponentCompleteness ?? model.componentCompleteness)?.[component] === 'published').length,
      missing: (report.models ?? []).filter((model) => model.rateKnown && (model.selectedComponentCompleteness ?? model.componentCompleteness)?.[component] !== 'published').length,
      unavailable: (report.models ?? []).filter((model) => !model.rateKnown).length,
    }])),
    missingRateComponents: report.missingRateComponents ?? {},
    recordedCostComponentCoverage: {
      knownCalls: report.recordedCostKnownCalls ?? 0,
      missingCalls: report.recordedCostMissingCalls ?? 0,
      zeroCalls: report.recordedCostZeroCalls ?? 0,
    },
  };
}

function enhanceReport(report, selection = null) {
  const snapshotAt = Number(report.snapshotAt) || Date.now();
  const ledgerLastCallAt = Number(report.ledgerLastCallAt);
  const billing = billingForReport(report);
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
    costBasis: {
      rateCalculated: 'public provider rate-card estimate; not a recorded charge',
      apiEquivalent: 'same token arithmetic, API-equivalent reference only',
      recorded: billing.recordedCostSource,
    },
    billing,
    ...report,
  };
}
function aggregateMcReports(reports) {
  const total = {
    calls: 0, inputTokens: 0, outputTokens: 0, reasoningTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0,
    costInput: 0, costOutput: 0, costCacheRead: 0, costCacheWrite: 0, totalCost: 0, totalTokens: 0,
    promptTokens: 0, pricedCalls: 0, partialCalls: 0, unknownCalls: 0, estimatedCalls: 0,
    partialRateCalculatedCostUsd: 0,
    tokenMissingCalls: 0, missingRateComponents: {}, pricingWarnings: [],
    bands: { peak: 0, offPeak: 0, flat: 0 }, models: new Map(), sessions: [],
    recordedCostUsd: 0, partialRecordedCostUsd: 0, recordedCostKnownCalls: 0, recordedCostMissingCalls: 0, recordedCostZeroCalls: 0,
  };
  let recordedComplete = true;
  for (const report of reports) {
    for (const field of ['calls', 'inputTokens', 'outputTokens', 'reasoningTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costInput', 'costOutput', 'costCacheRead', 'costCacheWrite', 'totalCost', 'totalTokens', 'promptTokens', 'pricedCalls', 'partialCalls', 'unknownCalls', 'estimatedCalls', 'tokenMissingCalls', 'recordedCostKnownCalls', 'recordedCostMissingCalls', 'recordedCostZeroCalls']) total[field] += Number(report[field]) || 0;
    total.partialRateCalculatedCostUsd += Number(report.partialRateCalculatedCostUsd ?? 0) || 0;
    for (const band of ['peak', 'offPeak', 'flat']) total.bands[band] += Number(report.bands?.[band]) || 0;
    for (const [component, count] of Object.entries(report.missingRateComponents ?? {})) total.missingRateComponents[component] = (total.missingRateComponents[component] ?? 0) + count;
    for (const warning of report.pricingWarnings ?? []) if (!total.pricingWarnings.includes(warning)) total.pricingWarnings.push(warning);
    const knownRecorded = report.recordedCostUsd !== null && report.recordedCostUsd !== undefined;
    if (knownRecorded) total.recordedCostUsd += Number(report.recordedCostUsd) || 0;
    else recordedComplete = false;
    total.partialRecordedCostUsd += Number(report.partialRecordedCostUsd ?? report.recordedCostUsd ?? 0) || 0;
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
  total.pricingCoverage = total.calls === 0 ? 'no-calls' : total.unknownCalls > 0 ? (total.pricedCalls > 0 ? 'partial' : 'unknown') : (total.partialCalls > 0 ? 'partial' : 'complete');
  total.pricingExact = total.pricingCoverage === 'no-calls' || (total.pricingCoverage === 'complete' && total.estimatedCalls === 0 && total.tokenMissingCalls === 0 && Object.keys(total.missingRateComponents).length === 0);
  if (total.pricingCoverage === 'unknown') total.totalCost = null;
  total.rateKnown = reports.every((report) => report.rateKnown);
  const allRateComplete = reports.every((report) => report.pricingCoverage === 'complete' || report.pricingCoverage === 'no-calls');
  total.rateCalculatedCostUsd = total.calls === 0 ? 0 : (allRateComplete && total.pricedCalls > 0) ? total.totalCost : null;
  total.apiEquivalentCostUsd = total.pricingCoverage === 'complete' || total.pricingCoverage === 'no-calls' ? total.rateCalculatedCostUsd : null;
  total.recordedCostCoverage = total.calls === 0 ? 'no-calls' : recordedComplete ? 'complete' : 'partial';
  total.recordedCostUsd = total.calls === 0 ? 0 : recordedComplete ? total.recordedCostUsd : null;
  total.recordedCostSource = 'local_runtime_token_usage.cost_usd';
  return { ...total, models: [...total.models.values()], rateKnown: total.rateKnown, pricingComplete: total.pricingCoverage === 'complete', pricingExact: total.pricingExact };
}
function renderAggregateMc(report, label) {
  const costValue = report.rateCalculatedCostUsd ?? report.partialRateCalculatedCostUsd;
  const cost = report.pricingCoverage === 'unknown' ? 'unavailable (unpriced calls present)' : report.pricingCoverage === 'partial' ? `partial estimate ${USD(costValue)}` : report.pricingExact ? USD(report.rateCalculatedCostUsd) : `estimated ${USD(report.rateCalculatedCostUsd)}`;
  return [
    `MCode session cost — ${label}`,
    `Sessions: ${report.sessions.length}`,
    `Calls: ${report.calls}`,
    `Total tokens: ${M(report.totalTokens)} M`,
    `Fresh input: ${M(report.inputTokens)} M`,
    `Cached read: ${M(report.cacheReadTokens)} M`,
    `Output: ${M(report.outputTokens)} M`,
    `Cache rate: ${(report.cacheRate * 100).toFixed(1)}%`,
    `Rate/API-equivalent cost: ${cost}`,
    `Recorded ledger cost: ${report.recordedCostUsd === null ? 'unavailable' : USD(report.recordedCostUsd)}`,
  ].join('\n');
}
function renderCompareMc(older, newer) {
  const delta = newer.totalTokens - older.totalTokens;
  const costLabel = (report) => report.pricingCoverage === 'unknown' ? 'unavailable' : report.pricingCoverage === 'partial' ? `partial ${USD(report.partialRateCalculatedCostUsd)}` : report.pricingExact ? USD(report.rateCalculatedCostUsd) : `estimated ${USD(report.rateCalculatedCostUsd)}`;
  return [
    'MCode session cost — comparison',
    `Older: ${older.sessionId} (${stamp(older.ledgerLastCallAt)})`,
    `Newer: ${newer.sessionId} (${stamp(newer.ledgerLastCallAt)})`,
    `Tokens: ${M(older.totalTokens)} M → ${M(newer.totalTokens)} M (${delta >= 0 ? '+' : ''}${M(delta)} M)`,
    `Cache rate: ${(older.cacheRate * 100).toFixed(1)}% → ${(newer.cacheRate * 100).toFixed(1)}%`,
    `Rate/API-equivalent cost: ${costLabel(older)} → ${costLabel(newer)}`,
    `Recorded ledger cost: ${older.recordedCostUsd === null ? 'unavailable' : USD(older.recordedCostUsd)} → ${newer.recordedCostUsd === null ? 'unavailable' : USD(newer.recordedCostUsd)}`,
  ].join('\n');
}
function renderRates(table) {
  const lines = ['MCode rate coverage', `Refreshed: ${table._meta?.refreshedAt ?? 'unknown'}`, `Schema: ${table._meta?.schemaVersion ?? 'legacy'}`];
  for (const [key, entry] of Object.entries(table.providers ?? {})) {
    const validation = validateRateTable({ providers: { [key]: entry } });
    const coverage = validation.coverage;
    const missing = Object.entries(coverage?.components ?? {}).filter(([, value]) => value.missing > 0).map(([component, value]) => `${component}=${value.missing}`).join(', ');
    lines.push(`${key}: ${Object.keys(entry.models ?? {}).length} model(s), source ${entry.source ?? 'unknown'}, fetched ${entry.fetchedAt ?? 'unknown'}, parser ${entry.parserVersion ?? 'legacy'}`);
    lines.push(`  component completeness: ${coverage?.completeModels ?? 0} complete / ${coverage?.incompleteModels ?? 0} incomplete${missing ? ` (missing ${missing})` : ''}`);
  }
  lines.push(`Free models: ${(table.freeModels ?? []).join(', ') || 'none'}`);
  return lines.join('\n');
}

// ---------------------------------------------------------------- main

let opts = null;
// <dataDir>/skills/session-cost/scripts/ -> three levels up is <dataDir>.
let dataDir = null;

function costForSession(db, dataDir, table, sessionId) {
  return buildReport(db, dataDir, table, sessionId, opts.includeChildren);
}

async function main() {
  if (opts.refreshRates) await refreshRates({ throwOnFailure: true });

  const table = loadRates();

  if (opts.rates) {
    const output = {
      schemaVersion: 1,
      generatedAt: new Date().toISOString(),
      rates: {
        rateSchemaVersion: table._meta?.schemaVersion ?? null,
        refreshedAt: table._meta?.refreshedAt ?? null,
        providers: Object.fromEntries(Object.entries(table.providers ?? {}).map(([key, entry]) => {
          const validation = validateRateTable({ providers: { [key]: entry } });
          return [key, {
            models: Object.keys(entry.models ?? {}).length,
            source: entry.source ?? null,
            sourceVersion: entry.parserVersion ?? entry.sourceVersion ?? null,
            fetchedAt: entry.fetchedAt ?? null,
            fingerprint: entry.fingerprint ?? null,
            componentCompleteness: validation.coverage?.components ?? null,
            incompleteModels: validation.coverage?.incompleteModels ?? null,
            requiredIncompleteModels: validation.coverage?.requiredIncompleteModels ?? null,
          }];
        })),
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

  const db = await openLedger(dataDir);

  try {
    loadConfig(dataDir);
    const allRows = sessionRows(db);
    const candidates = allRows.filter((row) => matchesFilters(db, dataDir, row));

    if (opts.list > 0) {
      const recent = candidates.slice(0, opts.list);
      const out = recent.map((r) => {
        const rep = costForSession(db, dataDir, table, r.session_id);
        const priced = rep.models.reduce((n, model) => n + (model.pricedCalls ?? 0), 0);
        const unpricedCalls = rep.calls - priced;
        const costValue = rep.rateCalculatedCostUsd;
        const displayCost = costValue ?? rep.partialRateCalculatedCostUsd;
        const costLabel = priced === 0 ? (rep.partialRateCalculatedCostUsd === null ? 'rate unknown' : `partial ${USD(rep.partialRateCalculatedCostUsd)}*`) : `${rep.pricingExact ? '' : 'est. '}${USD(displayCost)}${unpricedCalls ? '*' : ''}`;
        return {
          sessionId: r.session_id,
          title: rep.title,
          models: rep.models.map((m) => m.modelId),
          calls: rep.calls,
          totalTokens: rep.totalTokens,
          cacheRate: rep.cacheRate,
          costLabel,
          rateCalculatedCostUsd: costValue,
          partialRateCalculatedCostUsd: rep.partialRateCalculatedCostUsd ?? null,
          apiEquivalentCostUsd: rep.apiEquivalentCostUsd ?? null,
          recordedCostUsd: rep.recordedCostUsd ?? null,
          recordedCostCoverage: rep.recordedCostCoverage ?? null,
          pricingCoverage: rep.pricingCoverage,
          pricingExact: rep.pricingExact,
          partial: rep.pricingCoverage !== 'complete',
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
          console.log('\n* partial/unknown: the rate/API-equivalent value is not a complete session cost; see pricing coverage in JSON.');
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
      return reports.every((report) => report.pricingCoverage === 'complete' || report.pricingCoverage === 'no-calls') ? 0 : 2;
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
      return reports.every((report) => report.pricingCoverage === 'complete' || report.pricingCoverage === 'no-calls') ? 0 : 2;
    }

    const sessionId = opts.session ?? candidates[0]?.session_id ?? latestSessionId(db);
    const report = costForSession(db, dataDir, table, sessionId);
    const selection = { method: opts.session ? 'explicit' : 'latest-ledger-activity', requestedId: opts.session ?? null, candidates: candidates.slice(0, 5).map((row) => row.session_id) };

    if (opts.dashboard) {
      const outputPath = writeDashboard(enhanceReport(report, selection), { outPath: opts.out ?? path.join(dataDir, 'reports', 'session-cost', 'session-dashboard.html'), title: 'MCode Session Cost Dashboard' });
      if (opts.json) console.log(JSON.stringify({ schemaVersion: 1, dashboardPath: outputPath, report: enhanceReport(report, selection) }, null, 2));
      else console.log(`Dashboard written: ${outputPath}`);
    } else if (opts.json) console.log(JSON.stringify(enhanceReport(report, selection), null, 2));
    else console.log(renderText(report));

    return report.pricingCoverage === 'complete' || report.pricingCoverage === 'no-calls' ? 0 : 2;
  } finally {
    db.close();
  }
}

async function runCli() {
  opts = parseArgs(process.argv.slice(2));
  dataDir = opts.dataDir ? path.resolve(opts.dataDir) : path.resolve(__dirname, '..', '..', '..');
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
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (isMain) await runCli();

export {
  RATE_COMPONENTS,
  RATE_SCHEMA_VERSION,
  accumulate,
  addRateCards,
  atomicWriteJson,
  billingForReport,
  buildReport,
  componentCompleteness,
  decodeNextFlightPayload,
  emptyAggregate,
  enhanceReport,
  extractCommandCodeRates,
  extractStepFunRates,
  finalize,
  jsonArrayAfterKey,
  loadRates,
  parseCommandCodePayload,
  rateComponents,
  rateSelectionForCall,
  ratesForBand,
  refreshRates,
  resolveRate,
  validateRateModel,
  validateRateTable,
};
