import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export const RATE_PARSER_VERSION = 2;
export const REQUIRED_RATE_COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);
export const RATES_SOURCE = Object.freeze({
  commandcode: 'https://commandcode.ai/docs/resources/pricing-limits',
  stepfun: 'https://platform.stepfun.ai/docs/en/guides/pricing/details.md',
});

const DEFAULT_FREE_MODELS = [
  'poolside/laguna-s-2.1-free',
  'inclusionai/ling-3.0-flash-sante:free',
  'laguna-s-2.1',
  'ling-3.0-flash-sante',
];

export class RateTableValidationError extends Error {
  constructor(coverage) {
    super(rateTableErrorMessage(coverage));
    this.name = 'RateTableValidationError';
    this.coverage = coverage;
  }
}

function rateTableErrorMessage(coverage) {
  const issues = coverage.issues ?? [];
  const details = issues.length ? issues.slice(0, 8).join('; ') : 'unknown validation failure';
  const suffix = issues.length > 8 ? `; and ${issues.length - 8} more issue(s)` : '';
  return `rate table validation failed: ${details}${suffix}`;
}

function isRateAmount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function normalizeRateAmount(value) {
  if (value === null || value === undefined || value === '') return null;
  const amount = Number(value);
  return isRateAmount(amount) ? amount : null;
}

function modelComponentCoverage(models) {
  const components = {};
  for (const component of REQUIRED_RATE_COMPONENTS) {
    const incomplete = [];
    for (const [id, model] of Object.entries(models ?? {})) {
      if (!isRateAmount(model?.[component])) incomplete.push(id);
    }
    components[component] = {
      complete: incomplete.length === 0,
      completeModels: Object.keys(models ?? {}).length - incomplete.length,
      incompleteModels: incomplete,
    };
  }
  return components;
}

function isCompleteRateCard(model) {
  if (!model || REQUIRED_RATE_COMPONENTS.some((component) => !isRateAmount(model[component]))) return false;
  if (!model.cacheWriteSource || model.contextTiers) return false;
  if (!model.timeOfDay) return true;
  return ['peak', 'offPeak'].every((band) => (
    model.timeOfDay[band]
    && REQUIRED_RATE_COMPONENTS.every((component) => isRateAmount(model.timeOfDay[band][component]))
    && Boolean(model.timeOfDay[band].cacheWriteSource)
  ));
}

function inspectProvider(providerKey, provider) {
  const issues = [];
  const models = provider?.models ?? {};
  const modelIds = Object.keys(models);
  if (!modelIds.length) issues.push(`${providerKey} contains no models`);

  const normalizedIds = new Map();
  for (const id of modelIds) {
    const model = models[id];
    const normalized = normalizeModelId(id);
    if (!id.trim()) issues.push(`${providerKey} contains an empty model id`);
    if (normalizedIds.has(normalized)) {
      issues.push(`${providerKey} has duplicate normalized model id ${id} (${normalizedIds.get(normalized)})`);
    } else {
      normalizedIds.set(normalized, id);
    }
    if (!model?.name || !model?.provider || !model?.category) {
      issues.push(`${providerKey}/${id} is missing descriptive metadata`);
    }
    for (const component of REQUIRED_RATE_COMPONENTS) {
      if (!isRateAmount(model?.[component])) {
        issues.push(`${providerKey}/${id} missing ${component}`);
      }
    }
    if (!model?.cacheWriteSource) issues.push(`${providerKey}/${id} missing cacheWriteSource`);

    if (model?.contextTiers) issues.push(`${providerKey}/${id} has unsupported contextTiers`);
    if (model?.timeOfDay) {
      for (const band of ['peak', 'offPeak']) {
        const card = model.timeOfDay[band];
        if (!card) {
          issues.push(`${providerKey}/${id} missing ${band} band`);
          continue;
        }
        for (const component of REQUIRED_RATE_COMPONENTS) {
          if (!isRateAmount(card[component])) issues.push(`${providerKey}/${id} ${band} missing ${component}`);
        }
        if (!card.cacheWriteSource) issues.push(`${providerKey}/${id} ${band} missing cacheWriteSource`);
      }
    }
  }

  const excluded = Array.isArray(provider?.excludedModelIds) ? provider.excludedModelIds : [];
  if (new Set(excluded).size !== excluded.length) issues.push(`${providerKey} contains duplicate excluded model ids`);
  if (excluded.some((id) => Object.hasOwn(models, id))) {
    issues.push(`${providerKey} excludes model ids that are also published`);
  }

  return {
    source: provider?.source ?? null,
    fetchedAt: provider?.fetchedAt ?? null,
    models: modelIds.length,
    completeModels: modelIds.filter((id) => isCompleteRateCard(models[id])).length,
    timeBandModels: modelIds.filter((id) => Boolean(models[id]?.timeOfDay)).length,
    contextTierModels: modelIds.filter((id) => Boolean(models[id]?.contextTiers)).length,
    excludedModels: excluded,
    components: modelComponentCoverage(models),
    issues,
    complete: issues.length === 0,
  };
}

export function inspectRateTable(table) {
  const issues = [];
  if (table?._meta?.parserVersion !== RATE_PARSER_VERSION) {
    issues.push(`parserVersion must be ${RATE_PARSER_VERSION}`);
  }
  if (JSON.stringify(table?._meta?.sourceParserVersion) !== JSON.stringify({ commandcode: 2, stepfun: 1 })) {
    issues.push('sourceParserVersion does not match the bundled source parsers');
  }
  if (table?._meta?.currency !== 'USD') issues.push('currency must be USD');
  if (table?._meta?.unit !== 'per 1M tokens') issues.push('unit must be per 1M tokens');
  if (!Array.isArray(table?.freeModels)) issues.push('freeModels must be an array');
  if (!table?.aliases || typeof table.aliases !== 'object' || Array.isArray(table.aliases)) {
    issues.push('aliases must be an object');
  }

  const providers = {};
  for (const providerKey of Object.keys(RATES_SOURCE)) {
    const provider = table?.providers?.[providerKey];
    if (!provider) {
      issues.push(`missing provider ${providerKey}`);
      providers[providerKey] = {
        source: null,
        fetchedAt: null,
        models: 0,
        completeModels: 0,
        timeBandModels: 0,
        contextTierModels: 0,
        excludedModels: [],
        components: modelComponentCoverage({}),
        issues: [`missing provider ${providerKey}`],
        complete: false,
      };
      continue;
    }
    const inspection = inspectProvider(providerKey, provider);
    providers[providerKey] = inspection;
    issues.push(...inspection.issues);
    if (provider.source !== RATES_SOURCE[providerKey]) {
      issues.push(`${providerKey} source does not match the configured parser source`);
    }
    if (!provider.fetchedAt || !Number.isFinite(Date.parse(provider.fetchedAt))) {
      issues.push(`${providerKey} fetchedAt is not an ISO timestamp`);
    }
    const sourceCoverage = table?._meta?.sourceCoverage?.[providerKey];
    if (!sourceCoverage) {
      issues.push(`${providerKey} sourceCoverage is missing`);
    } else if (
      !Number.isInteger(sourceCoverage.sourceModels)
      || !Number.isInteger(sourceCoverage.publishedModels)
      || !Number.isInteger(sourceCoverage.excludedModels)
      || sourceCoverage.publishedModels !== inspection.models
      || sourceCoverage.excludedModels !== inspection.excludedModels.length
      || sourceCoverage.sourceModels !== sourceCoverage.publishedModels + sourceCoverage.excludedModels
    ) {
      issues.push(`${providerKey} sourceCoverage does not match the published and excluded model counts`);
    }
  }

  return {
    parserVersion: table?._meta?.parserVersion ?? null,
    currency: table?._meta?.currency ?? null,
    unit: table?._meta?.unit ?? null,
    providers,
    sourceCoverage: table?._meta?.sourceCoverage ?? null,
    issues,
    complete: issues.length === 0,
  };
}

export function validateRateTable(table) {
  const coverage = inspectRateTable(table);
  if (!coverage.complete) throw new RateTableValidationError(coverage);
  return table;
}

export function normalizeProvider(provider) {
  return String(provider ?? '')
    .toLowerCase()
    .replace(/^custom_provider:/, '')
    .replace(/^custom:/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeModelId(id) {
  return String(id)
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replace(/[^a-z0-9]/g, '');
}

export function resolveRate(table, provider, providerModelId) {
  const providerKey = normalizeProvider(provider);
  const entry = table.providers?.[providerKey];
  if (!entry) return { key: null, rate: null, free: false, providerKey };

  const normalized = normalizeModelId(providerModelId);
  const alias = table.aliases?.[`${providerKey}/${providerModelId}`] ?? table.aliases?.[providerModelId];
  const key = alias ?? Object.keys(entry.models).find((candidate) => normalizeModelId(candidate) === normalized);
  if (key && isCompleteRateCard(entry.models[key])) {
    return { key, rate: entry.models[key], free: false, providerKey };
  }

  const isFree = (table.freeModels ?? []).some((model) => normalizeModelId(model) === normalized);
  if (isFree) {
    return {
      key: providerModelId,
      rate: { name: providerModelId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteSource: 'free-model' },
      free: true,
      providerKey,
    };
  }
  return { key: null, rate: null, free: false, providerKey };
}

export function ratesForBand(rate, band = 'flat') {
  const pick = (component) => {
    const value = band === 'flat'
      ? rate?.[component]
      : rate?.timeOfDay?.[band]?.[component] ?? rate?.[component];
    if (!isRateAmount(value)) throw new Error(`rate component ${component} is missing for ${band} band`);
    return value;
  };
  return Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [component, pick(component)]));
}

export function calculateTokenCost(tokens, rate, band = 'flat') {
  const components = ratesForBand(rate, band);
  const count = (camel, snake) => Number(tokens[camel] ?? tokens[snake]) || 0;
  return {
    input: count('inputTokens', 'input_tokens') / 1_000_000 * components.input,
    output: count('outputTokens', 'output_tokens') / 1_000_000 * components.output,
    cacheRead: count('cacheReadTokens', 'cache_read_tokens') / 1_000_000 * components.cacheRead,
    cacheWrite: count('cacheWriteTokens', 'cache_write_tokens') / 1_000_000 * components.cacheWrite,
  };
}

function commandCodeFlightPayload(html) {
  const chunks = [...html.matchAll(/self\.__next_f\.push\(\[1,"((?:[^"\\]|\\.)*)"\]\)/g)]
    .map((match) => {
      try {
        return JSON.parse('"' + match[1] + '"');
      } catch {
        return match[1];
      }
    });
  return chunks.join('');
}

function commandCodeModelObjects(payload) {
  const models = [];
  const marker = '{"id":';
  let cursor = 0;
  while ((cursor = payload.indexOf(marker, cursor)) !== -1) {
    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;
    for (let index = cursor; index < payload.length; index += 1) {
      const char = payload[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (char === '\\') escaped = true;
        else if (char === '"') inString = false;
        continue;
      }
      if (char === '"') {
        inString = true;
        continue;
      }
      if (char === '{') depth += 1;
      else if (char === '}') {
        depth -= 1;
        if (depth === 0) {
          end = index + 1;
          break;
        }
      }
    }
    if (end === -1) throw new Error('CommandCode rate payload contains an unterminated model object');
    let candidate;
    try {
      candidate = JSON.parse(payload.slice(cursor, end));
    } catch {
      cursor += marker.length;
      continue;
    }
    cursor = end;
    if (
      candidate
      && typeof candidate === 'object'
      && Object.hasOwn(candidate, 'inputCost')
      && Object.hasOwn(candidate, 'outputCost')
      && Object.hasOwn(candidate, 'cacheReadCost')
      && candidate.name
      && candidate.provider
      && candidate.category
    ) {
      models.push(candidate);
    }
  }
  return models;
}

function matchingDivEnd(source, start) {
  const tags = /<\/?div\b[^>]*>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (const match of source.matchAll(tags)) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 0) return match.index + match[0].length;
    } else {
      depth += 1;
    }
  }
  throw new Error('CommandCode pricing HTML contains an unterminated row');
}

function directDivChildren(elementHtml) {
  const tags = /<\/?div\b[^>]*>/g;
  const children = [];
  let depth = 0;
  let childStart = null;
  for (const match of elementHtml.matchAll(tags)) {
    if (match[0].startsWith('</')) {
      depth -= 1;
      if (depth === 1 && childStart !== null) {
        children.push(elementHtml.slice(childStart, match.index));
        childStart = null;
      }
    } else {
      if (depth === 1) childStart = match.index;
      depth += 1;
    }
  }
  return children;
}

function decodeHtmlText(value) {
  return value
    .replace(/<[^>]*>/g, '')
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(Number.parseInt(code, 16)))
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

function parseRenderedAmount(value) {
  const text = decodeHtmlText(value);
  if (text === '—' || text === '-') return { amount: 0, explicit: true, rendered: 'no-charge' };
  const match = text.replaceAll(',', '').match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
  return match ? { amount: Number(match[1]), explicit: true, rendered: 'rate' } : { amount: null, explicit: false, rendered: null };
}

function commandCodeDisplayedRates(html) {
  const rows = new Map();
  for (const match of html.matchAll(/<div\b[^>]*\brole="row"[^>]*>/g)) {
    const rowHtml = html.slice(match.index, matchingDivEnd(html, match.index));
    const cells = directDivChildren(rowHtml).map(decodeHtmlText);
    if (cells.length < 6 || cells[1] !== '1M') continue;
    const name = cells[0];
    if (rows.has(name)) throw new Error(`CommandCode pricing HTML has duplicate rendered model name ${name}`);
    rows.set(name, {
      input: parseRenderedAmount(cells[2]),
      output: parseRenderedAmount(cells[3]),
      cacheRead: parseRenderedAmount(cells[4]),
      cacheWrite: parseRenderedAmount(cells[5]),
    });
  }
  return rows;
}


function renderedFallback(rendered, component) {
  return rendered?.[component]?.explicit ? rendered[component].amount : null;
}

function normalizedBand(rawBand, fallbackCacheWrite, fallbackSource) {
  if (!rawBand) return null;
  const hasCacheWrite = Object.hasOwn(rawBand, 'cacheWriteCost');
  const cacheWrite = hasCacheWrite ? normalizeRateAmount(rawBand.cacheWriteCost) : fallbackCacheWrite;
  return {
    input: normalizeRateAmount(rawBand.inputCost),
    output: normalizeRateAmount(rawBand.outputCost),
    cacheRead: normalizeRateAmount(rawBand.cacheReadCost),
    cacheWrite,
    cacheWriteSource: hasCacheWrite
      ? (cacheWrite === null ? null : 'commandcode-model')
      : fallbackSource,
  };
}

export function parseCommandCodeRates(html) {
  const payload = commandCodeFlightPayload(html);
  if (!payload) throw new Error('could not read the CommandCode rate payload');
  const displayed = commandCodeDisplayedRates(html);
  const models = {};

  for (const raw of commandCodeModelObjects(payload)) {
    if (Object.hasOwn(models, raw.id)) {
      throw new Error(`CommandCode rate payload has duplicate model id ${raw.id}`);
    }
    const rendered = displayed.get(raw.name);
    const input = normalizeRateAmount(raw.inputCost) ?? renderedFallback(rendered, 'input');
    const output = normalizeRateAmount(raw.outputCost) ?? renderedFallback(rendered, 'output');
    const cacheRead = normalizeRateAmount(raw.cacheReadCost) ?? renderedFallback(rendered, 'cacheRead');
    const rawHasCacheWrite = Object.hasOwn(raw, 'cacheWriteCost');
    const rawCacheWrite = normalizeRateAmount(raw.cacheWriteCost);
    const renderedCacheWrite = renderedFallback(rendered, 'cacheWrite');
    const cacheWrite = rawHasCacheWrite ? rawCacheWrite : renderedCacheWrite;
    const cacheWriteSource = rawHasCacheWrite
      ? (rawCacheWrite === null ? null : 'commandcode-model')
      : (rendered?.cacheWrite?.explicit ? `commandcode-${rendered.cacheWrite.rendered}` : null);

    const entry = {
      name: raw.name,
      provider: raw.provider,
      category: raw.category,
      input,
      output,
      cacheRead,
      cacheWrite,
      cacheWriteSource,
    };
    if (raw.timeOfDay) {
      entry.timeOfDay = {
        peak: normalizedBand(raw.timeOfDay.peak, cacheWrite, cacheWriteSource),
        offPeak: normalizedBand(raw.timeOfDay.offPeak, cacheWrite, cacheWriteSource),
        windows: raw.timeOfDay.windows ?? null,
        effective: raw.timeOfDay.effective ?? null,
      };
    }
    if (raw.contextTiers) entry.contextTiers = raw.contextTiers;
    models[raw.id] = entry;
  }

  if (!Object.keys(models).length) throw new Error('CommandCode rate payload contained no models');
  return models;
}

function stepFunMoney(cell) {
  const match = String(cell).match(/\\?\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? normalizeRateAmount(match[1]) : null;
}

export function parseStepFunRates(markdown) {
  const models = {};
  let lineNumber = 0;
  for (const line of markdown.split(/\r?\n/)) {
    lineNumber += 1;
    const match = line.match(/^\|\s*`([^`]+)`\s*\|\s*1M tokens\s*\|([^|]*)\|([^|]*)\|([^|]*)\|/);
    if (!match) continue;
    const [, id, missCell, hitCell, outputCell] = match;
    if (Object.hasOwn(models, id)) throw new Error(`StepFun rate payload has duplicate model id ${id}`);

    const input = stepFunMoney(missCell);
    const cacheRead = stepFunMoney(hitCell);
    const output = stepFunMoney(outputCell);
    if (input === null || cacheRead === null || output === null) {
      throw new Error(`StepFun token-billed model ${id} has an incomplete rate row at line ${lineNumber}`);
    }
    const documentedCacheWrite = id === 'step-5-preview';
    models[id] = {
      name: id,
      provider: 'stepfun',
      category: 'stepfun-docs',
      input,
      output,
      cacheRead,
      cacheWrite: documentedCacheWrite ? input : null,
      cacheWriteSource: documentedCacheWrite ? 'stepfun-cache-miss-policy' : null,
      ...(documentedCacheWrite ? { cacheWriteNote: 'billed at the input rate' } : {}),
    };
  }

  if (!Object.hasOwn(models, 'step-5-preview')) {
    throw new Error('step-5-preview row not found in the StepFun pricing page');
  }
  return models;
}

export async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' },
  });
  if (!response.ok) throw new Error(`${url} returned HTTP ${response.status}`);
  return response.text();
}

function buildRateTable(previous, providers, refreshedAt) {
  return {
    _meta: {
      parserVersion: RATE_PARSER_VERSION,
      sourceParserVersion: { commandcode: 2, stepfun: 1 },
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt,
      sourceCoverage: Object.fromEntries(Object.entries(providers).map(([key, entry]) => [key, {
        sourceModels: Object.keys(entry.models ?? {}).length,
        publishedModels: Object.keys(entry.models ?? {}).length,
        excludedModels: 0,
      }])),
      cacheWriteNote: 'CommandCode no-charge rows require an explicit rendered dash; StepFun publishes only the documented step-5-preview cache-write rate, and all other incomplete cards are rejected.',
      peakWindows: {
        peakHoursPerDay: 7,
        offPeakHoursPerDay: 17,
        windows: '01-04 & 06-10 UTC, Mon-Fri',
        rule: 'peak when UTC weekday is Mon-Fri and 1 <= utcHour < 4 or 6 <= utcHour < 10',
        note: 'CommandCode only; StepFun publishes a single flat rate per model.',
      },
    },
    providers,
    freeModels: previous?.freeModels ?? [...DEFAULT_FREE_MODELS],
    aliases: previous?.aliases ?? {},
  };
}

export function readRateTable(ratesPath) {
  if (!fs.existsSync(ratesPath)) throw new Error(`rate table missing at ${ratesPath} - run with --refresh-rates`);
  let table;
  try {
    table = JSON.parse(fs.readFileSync(ratesPath, 'utf8'));
  } catch (error) {
    throw new Error(`could not parse rate table at ${ratesPath}: ${error.message}`);
  }
  return validateRateTable(table);
}

function writeJsonAtomically(targetPath, value) {
  const target = path.resolve(targetPath);
  const directory = path.dirname(target);
  fs.mkdirSync(directory, { recursive: true });
  const temporary = path.join(directory, `.${path.basename(target)}.${process.pid}.${randomUUID()}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, 'wx', 0o600);
    fs.writeFileSync(descriptor, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.fsyncSync(descriptor);
    fs.closeSync(descriptor);
    descriptor = undefined;
    fs.renameSync(temporary, target);
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
    fs.rmSync(temporary, { force: true });
  }
}

export async function refreshRateTable({
  ratesPath,
  fetchImpl = fetchText,
  refreshedAt = new Date().toISOString(),
} = {}) {
  if (!ratesPath) throw new Error('ratesPath is required');
  if (!Number.isFinite(Date.parse(refreshedAt))) throw new Error('refreshedAt must be an ISO timestamp');

  const previous = fs.existsSync(ratesPath) ? readRateTable(ratesPath) : null;
  const providers = {};
  const failures = [];
  for (const [providerKey, source] of Object.entries(RATES_SOURCE)) {
    try {
      const sourceText = await fetchImpl(source, providerKey);
      const models = providerKey === 'commandcode'
        ? parseCommandCodeRates(sourceText)
        : parseStepFunRates(sourceText);
      providers[providerKey] = { source, fetchedAt: refreshedAt, models };
    } catch (error) {
      failures.push(`${providerKey}: ${error.message}`);
    }
  }
  if (failures.length) {
    throw new Error(`rate refresh failed; existing table was preserved: ${failures.join('; ')}`);
  }

  const table = validateRateTable(buildRateTable(previous, providers, refreshedAt));
  writeJsonAtomically(ratesPath, table);
  return table;
}
