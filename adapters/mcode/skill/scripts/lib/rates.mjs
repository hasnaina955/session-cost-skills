import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';

export const RATE_PARSER_VERSION = 3;
export const SOURCE_PARSER_VERSION = Object.freeze({ commandcode: 3, stepfun: 2 });
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
  if (!model.cacheWriteSource) return false;
  if (!model.timeOfDay) return true;
  return ['peak', 'offPeak'].every((band) => (
    model.timeOfDay[band]
    && REQUIRED_RATE_COMPONENTS.every((component) => isRateAmount(model.timeOfDay[band][component]))
    && Boolean(model.timeOfDay[band].cacheWriteSource)
  ));
}

const RATE_COMPONENT_SOURCE_KEYS = Object.freeze({
  input: 'inputCost',
  output: 'outputCost',
  cacheRead: 'cacheReadCost',
  cacheWrite: 'cacheWriteCost',
});

function fingerprintRateRecord(record) {
  const payload = {
    schemaVersion: record.schemaVersion,
    id: record.id,
    provider: record.provider,
    model: record.model,
    component: record.component,
    sourceAmount: record.sourceAmount,
    amount: record.amount,
    currency: record.currency,
    unit: record.unit,
    effectiveFrom: record.effectiveFrom,
    context: record.context,
    timeBand: record.timeBand,
    source: record.source,
  };
  return `sha256:${createHash('sha256').update(JSON.stringify(payload)).digest('hex')}`;
}

function makeRateRecord({
  providerKey,
  modelKey,
  component,
  sourceAmount,
  amount,
  effectiveFrom,
  effectiveThrough = null,
  context,
  timeBand,
  source,
}) {
  const contextToken = context.maxTokens === null ? 'unbounded' : context.maxTokens;
  const id = [providerKey, modelKey, component, effectiveFrom, timeBand, context.minTokens, contextToken].join('|');
  const record = {
    schemaVersion: 1,
    id,
    provider: providerKey,
    model: modelKey,
    component,
    sourceAmount: String(sourceAmount),
    amount,
    currency: 'USD',
    unit: 'per_1m_tokens',
    effectiveFrom,
    effectiveThrough,
    context,
    timeBand,
    source,
  };
  return { ...record, fingerprint: fingerprintRateRecord(record) };
}

export function bandForTimestamp(timestamp, rate) {
  if (!rate?.timeOfDay) return 'flat';
  const date = new Date(Number(timestamp));
  const day = date.getUTCDay();
  const hour = date.getUTCHours();
  const isWeekday = day >= 1 && day <= 5;
  const inWindow = (hour >= 1 && hour < 4) || (hour >= 6 && hour < 10);
  return isWeekday && inWindow ? 'peak' : 'offPeak';
}

function normalizedTimestamp(value, fallback = null) {
  if (!value || !Number.isFinite(Date.parse(value))) return fallback;
  return new Date(value).toISOString();
}

function modelContexts(model) {
  if (!model.contextTiers?.length) {
    return [{
      context: { minTokens: 0, maxTokens: null },
      components: Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [component, model[component]])),
      sourceAmounts: model.sourceAmounts ?? Object.fromEntries(
        REQUIRED_RATE_COMPONENTS.map((component) => [component, String(model[component])]),
      ),
      effectiveFrom: normalizedTimestamp(model.effective),
      effectiveThrough: normalizedTimestamp(model.endsWhen),
    }];
  }

  let minTokens = 0;
  let inferredEffectiveFrom = null;
  return model.contextTiers.map((tier) => {
    const maxTokens = Number.isInteger(tier.maxContext) ? tier.maxContext : null;
    const context = { minTokens, maxTokens };
    minTokens = maxTokens === null ? minTokens : maxTokens + 1;
    const components = {};
    const sourceAmounts = {};
    for (const component of REQUIRED_RATE_COMPONENTS) {
      const sourceKey = RATE_COMPONENT_SOURCE_KEYS[component];
      const explicit = Object.hasOwn(tier, sourceKey);
      const safeNoCharge = component === 'cacheWrite' && model.cacheWriteSource?.endsWith('no-charge');
      components[component] = explicit
        ? normalizeRateAmount(tier[sourceKey])
        : safeNoCharge ? 0 : null;
      sourceAmounts[component] = explicit ? tier[sourceKey] : safeNoCharge ? '—' : null;
    }
    const effectiveFrom = normalizedTimestamp(tier.effective, inferredEffectiveFrom);
    const effectiveThrough = normalizedTimestamp(tier.endsWhen);
    inferredEffectiveFrom = effectiveThrough;
    return {
      context,
      components,
      sourceAmounts,
      effectiveFrom,
      effectiveThrough,
    };
  });
}

function rateCardsForModel(providerKey, modelKey, model, refreshedAt, sourceUrl, parserVersion) {
  if (model.contextTiers && model.timeOfDay) {
    throw new Error(`${providerKey}/${modelKey} combines context tiers and time bands`);
  }
  if (model.timeOfDay && (!model.timeOfDay.peak || !model.timeOfDay.offPeak)) {
    throw new Error(`${providerKey}/${modelKey} is missing a peak or offPeak band`);
  }
  const contexts = modelContexts(model);
  const bands = model.timeOfDay ? ['peak', 'offPeak'] : ['flat'];
  const source = { url: sourceUrl, parserVersion, fetchedAt: refreshedAt };
  const records = [];
  for (const band of bands) {
    for (const card of contexts) {
      const bandModel = band === 'flat' ? model : model.timeOfDay?.[band];
      if (!bandModel) continue;
      const effectiveFrom = card.effectiveFrom ?? bandModel.effectiveFrom ?? model.timeOfDay?.effective ?? refreshedAt;
      const components = band === 'flat'
        ? card.components
        : Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [component, bandModel[component]]));
      const sourceAmounts = band === 'flat'
        ? card.sourceAmounts
        : Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [component, bandModel.sourceAmounts?.[component] ?? null]));
      for (const component of REQUIRED_RATE_COMPONENTS) {
        const amount = components[component];
        const sourceAmount = sourceAmounts[component];
        if (!isRateAmount(amount) || sourceAmount === null || sourceAmount === undefined) {
          throw new Error(`${providerKey}/${modelKey} has incomplete ${band} context rate for ${component}`);
        }
        records.push(makeRateRecord({
          providerKey,
          modelKey,
          component,
          sourceAmount,
          amount,
          effectiveFrom,
          effectiveThrough: card.effectiveThrough,
          context: card.context,
          timeBand: band,
          source,
        }));
      }
    }
  }
  return records;
}

export function buildRateRecords(providerKey, models, { refreshedAt, sourceUrl = RATES_SOURCE[providerKey] }) {
  const parserVersion = SOURCE_PARSER_VERSION[providerKey];
  return Object.entries(models).flatMap(([modelKey, model]) => (
    rateCardsForModel(providerKey, modelKey, model, refreshedAt, sourceUrl, parserVersion)
  ));
}

export function prepareProviderRates(providerKey, parsedModels, { refreshedAt, sourceUrl = RATES_SOURCE[providerKey] } = {}) {
  const models = {};
  const rateRecords = [];
  const excludedModelIds = [];
  const excludedModelReasons = {};
  for (const [modelKey, model] of Object.entries(parsedModels)) {
    try {
      const records = rateCardsForModel(
        providerKey,
        modelKey,
        model,
        refreshedAt,
        sourceUrl,
        SOURCE_PARSER_VERSION[providerKey],
      );
      models[modelKey] = model;
      rateRecords.push(...records);
    } catch (error) {
      excludedModelIds.push(modelKey);
      excludedModelReasons[modelKey] = error.message;
    }
  }
  return { models, rateRecords, excludedModelIds, excludedModelReasons };
}

function mergeRateRecords(previousRecords, incomingRecords) {
  const merged = (previousRecords ?? []).map((record) => ({ ...record }));
  const byId = new Map(merged.map((record) => [record.id, record]));
  const slot = (record) => [
    record.model,
    record.component,
    record.timeBand,
    record.context.minTokens,
    record.context.maxTokens,
  ].join('|');

  for (const incoming of incomingRecords) {
    const existing = byId.get(incoming.id);
    if (existing) {
      const unchanged = existing.amount === incoming.amount
        && existing.sourceAmount === incoming.sourceAmount
        && existing.effectiveFrom === incoming.effectiveFrom;
      if (!unchanged) throw new Error(`rate record ${incoming.id} changed without a new effective date`);
      continue;
    }

    const incomingFrom = Date.parse(incoming.effectiveFrom);
    for (const previous of merged) {
      if (slot(previous) !== slot(incoming)) continue;
      const previousFrom = Date.parse(previous.effectiveFrom);
      const previousThrough = previous.effectiveThrough ? Date.parse(previous.effectiveThrough) : Infinity;
      if (incomingFrom < previousFrom) throw new Error(`rate record ${incoming.id} starts before an existing record`);
      if (incomingFrom < previousThrough) {
        if (incomingFrom === previousFrom) throw new Error(`rate record ${incoming.id} overlaps an existing record`);
        previous.effectiveThrough = incoming.effectiveFrom;
      }
    }
    merged.push(incoming);
    byId.set(incoming.id, incoming);
  }
  return merged.sort((left, right) => (
    left.model.localeCompare(right.model)
    || left.effectiveFrom.localeCompare(right.effectiveFrom)
    || left.component.localeCompare(right.component)
  ));
}

function inspectRateRecord(record, providerKey, index) {
  const issues = [];
  const location = `${providerKey}.rateRecords[${index}]`;
  if (record?.schemaVersion !== 1) issues.push(`${location} schemaVersion must be 1`);
  if (!record?.id) issues.push(`${location} is missing id`);
  if (record?.provider !== providerKey) issues.push(`${location} provider does not match ${providerKey}`);
  if (!record?.model) issues.push(`${location} is missing model`);
  if (!REQUIRED_RATE_COMPONENTS.includes(record?.component)) issues.push(`${location} component is unsupported`);
  if (record?.sourceAmount === '' || record?.sourceAmount === null || record?.sourceAmount === undefined) {
    issues.push(`${location} is missing sourceAmount`);
  }
  if (!isRateAmount(record?.amount)) issues.push(`${location} amount must be nonnegative`);
  if (record?.currency !== 'USD') issues.push(`${location} currency must be USD`);
  if (record?.unit !== 'per_1m_tokens') issues.push(`${location} unit must be per_1m_tokens`);
  if (!Number.isFinite(Date.parse(record?.effectiveFrom))) issues.push(`${location} effectiveFrom is invalid`);
  if (record?.effectiveThrough !== null && !Number.isFinite(Date.parse(record?.effectiveThrough))) {
    issues.push(`${location} effectiveThrough is invalid`);
  }
  if (record?.effectiveThrough && Date.parse(record.effectiveThrough) <= Date.parse(record.effectiveFrom)) {
    issues.push(`${location} effectiveThrough must follow effectiveFrom`);
  }
  if (!Number.isInteger(record?.context?.minTokens) || record.context.minTokens < 0) {
    issues.push(`${location} context.minTokens is invalid`);
  }
  if (record?.context?.maxTokens !== null && (!Number.isInteger(record.context.maxTokens) || record.context.maxTokens < record.context.minTokens)) {
    issues.push(`${location} context.maxTokens is invalid`);
  }
  if (!['flat', 'peak', 'offPeak'].includes(record?.timeBand)) issues.push(`${location} timeBand is unsupported`);
  if (record?.source?.url !== RATES_SOURCE[providerKey]) issues.push(`${location} source URL is unsupported`);
  if (record?.source?.parserVersion !== SOURCE_PARSER_VERSION[providerKey]) issues.push(`${location} source parserVersion is unsupported`);
  if (!Number.isFinite(Date.parse(record?.source?.fetchedAt))) issues.push(`${location} source.fetchedAt is invalid`);
  if (record?.fingerprint !== fingerprintRateRecord(record)) issues.push(`${location} fingerprint does not match`);
  return issues;
}

export function validateRateRecord(record) {
  if (!record?.provider || !RATES_SOURCE[record.provider]) throw new Error('rate record provider is unsupported');
  const issues = inspectRateRecord(record, record.provider, 0);
  if (issues.length) throw new Error(`invalid rate record: ${issues.join('; ')}`);
  return record;
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

  const rateRecords = Array.isArray(provider?.rateRecords) ? provider.rateRecords : [];
  if (!rateRecords.length) issues.push(`${providerKey} contains no effective rate records`);
  const recordIds = new Set();
  const fingerprints = new Set();
  const groups = new Map();
  for (const [index, record] of rateRecords.entries()) {
    issues.push(...inspectRateRecord(record, providerKey, index));
    if (recordIds.has(record.id)) issues.push(`${providerKey} has duplicate rate record id ${record.id}`);
    recordIds.add(record.id);
    if (fingerprints.has(record.fingerprint)) issues.push(`${providerKey} has duplicate rate fingerprint ${record.fingerprint}`);
    fingerprints.add(record.fingerprint);
    const groupKey = [
      record.model,
      record.timeBand,
      record.context.minTokens,
      record.context.maxTokens,
      record.effectiveFrom,
      record.effectiveThrough,
    ].join('|');
    const group = groups.get(groupKey) ?? new Set();
    group.add(record.component);
    groups.set(groupKey, group);
  }
  for (const [groupKey, components] of groups) {
    const missing = REQUIRED_RATE_COMPONENTS.filter((component) => !components.has(component));
    if (missing.length) issues.push(`${providerKey} rate group ${groupKey} is missing ${missing.join(', ')}`);
  }
  const timelines = new Map();
  for (const record of rateRecords) {
    const key = [record.model, record.component, record.timeBand, record.context.minTokens, record.context.maxTokens].join('|');
    const timeline = timelines.get(key) ?? [];
    timeline.push(record);
    timelines.set(key, timeline);
  }
  for (const [key, timeline] of timelines) {
    timeline.sort((left, right) => left.effectiveFrom.localeCompare(right.effectiveFrom));
    for (let index = 1; index < timeline.length; index += 1) {
      const previous = timeline[index - 1];
      const current = timeline[index];
      const previousThrough = previous.effectiveThrough ? Date.parse(previous.effectiveThrough) : Infinity;
      if (Date.parse(current.effectiveFrom) < previousThrough) {
        issues.push(`${providerKey} rate timeline ${key} has overlapping effective intervals`);
      }
    }
  }
  for (const id of modelIds) {
    if (!rateRecords.some((record) => record.model === id)) issues.push(`${providerKey}/${id} has no effective rate records`);
  }

  return {
    source: provider?.source ?? null,
    fetchedAt: provider?.fetchedAt ?? null,
    models: modelIds.length,
    completeModels: modelIds.filter((id) => isCompleteRateCard(models[id])).length,
    timeBandModels: modelIds.filter((id) => Boolean(models[id]?.timeOfDay)).length,
    contextTierModels: modelIds.filter((id) => Boolean(models[id]?.contextTiers)).length,
    excludedModels: excluded,
    rateRecords: rateRecords.length,
    effectiveFrom: rateRecords.reduce((earliest, record) => (
      !earliest || record.effectiveFrom < earliest ? record.effectiveFrom : earliest
    ), null),
    effectiveThrough: rateRecords.some((record) => record.effectiveThrough === null)
      ? null
      : rateRecords.map((record) => record.effectiveThrough).sort().at(-1) ?? null,
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
  if (JSON.stringify(table?._meta?.sourceParserVersion) !== JSON.stringify(SOURCE_PARSER_VERSION)) {
    issues.push('sourceParserVersion does not match the bundled source parsers');
  }
  if (table?._meta?.currency !== 'USD') issues.push('currency must be USD');
  if (table?._meta?.unit !== 'per 1M tokens') issues.push('unit must be per 1M tokens');
  if (!Array.isArray(table?._meta?.history)) issues.push('history must be an array');
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
        rateRecords: 0,
        effectiveFrom: null,
        effectiveThrough: null,
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

function rateRecordApplies(record, { timestamp, contextTokens, timeBand }) {
  const effectiveFrom = Date.parse(record.effectiveFrom);
  const effectiveThrough = record.effectiveThrough ? Date.parse(record.effectiveThrough) : Infinity;
  return timestamp >= effectiveFrom
    && timestamp < effectiveThrough
    && record.timeBand === timeBand
    && contextTokens >= record.context.minTokens
    && (record.context.maxTokens === null || contextTokens <= record.context.maxTokens);
}

export function resolveRate(table, provider, providerModelId, {
  at = Date.now(),
  contextTokens = 0,
  band = null,
} = {}) {
  const providerKey = normalizeProvider(provider);
  const entry = table.providers?.[providerKey];
  if (!entry) return { key: null, rate: null, free: false, providerKey, coverage: 'unavailable', missingComponents: [...REQUIRED_RATE_COMPONENTS] };

  const normalized = normalizeModelId(providerModelId);
  const alias = table.aliases?.[`${providerKey}/${providerModelId}`] ?? table.aliases?.[providerModelId];
  const key = alias ?? Object.keys(entry.models).find((candidate) => normalizeModelId(candidate) === normalized);
  const model = key ? entry.models[key] : null;
  if (key && model) {
    const timestamp = typeof at === 'string' ? Date.parse(at) : Number(at);
    const context = Math.max(0, Number(contextTokens) || 0);
    const timeBand = band ?? bandForTimestamp(timestamp, model);
    const selected = [];
    const missingComponents = [];
    for (const component of REQUIRED_RATE_COMPONENTS) {
      const matches = (entry.rateRecords ?? [])
        .filter((record) => record.model === key && record.component === component)
        .filter((record) => rateRecordApplies(record, { timestamp, contextTokens: context, timeBand }))
        .sort((left, right) => Date.parse(right.effectiveFrom) - Date.parse(left.effectiveFrom));
      if (!matches.length) missingComponents.push(component);
      else selected.push(matches[0]);
    }
    if (!missingComponents.length) {
      const rate = Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [
        component,
        selected.find((record) => record.component === component).amount,
      ]));
      return {
        key,
        rate: {
          ...rate,
          name: model.name,
          rateRecords: selected,
          effectiveFrom: selected[0].effectiveFrom,
          effectiveThrough: selected[0].effectiveThrough,
          sourceUrls: [...new Set(selected.map((record) => record.source.url))],
          fingerprint: `sha256:${createHash('sha256').update(selected.map((record) => record.fingerprint).sort().join('\n')).digest('hex')}`,
        },
        free: false,
        providerKey,
        coverage: 'complete',
        missingComponents: [],
        timeBand,
        contextTokens: context,
      };
    }
    return {
      key,
      rate: null,
      free: false,
      providerKey,
      coverage: selected.length ? 'partial' : 'unavailable',
      missingComponents,
      timeBand,
      contextTokens: context,
    };
  }

  const isFree = (table.freeModels ?? []).some((modelId) => normalizeModelId(modelId) === normalized);
  if (isFree) {
    return {
      key: providerModelId,
      rate: { name: providerModelId, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cacheWriteSource: 'free-model' },
      free: true,
      providerKey,
      coverage: 'complete',
      missingComponents: [],
    };
  }
  return { key: null, rate: null, free: false, providerKey, coverage: 'unavailable', missingComponents: [...REQUIRED_RATE_COMPONENTS] };
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
  if (text === '—' || text === '-') return { amount: 0, explicit: true, rendered: 'no-charge', sourceAmount: text };
  const match = text.replaceAll(',', '').match(/^\$\s*([0-9]+(?:\.[0-9]+)?)$/);
  return match
    ? { amount: Number(match[1]), explicit: true, rendered: 'rate', sourceAmount: text }
    : { amount: null, explicit: false, rendered: null, sourceAmount: null };
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
    sourceAmounts: {
      input: Object.hasOwn(rawBand, 'inputCost') ? rawBand.inputCost : null,
      output: Object.hasOwn(rawBand, 'outputCost') ? rawBand.outputCost : null,
      cacheRead: Object.hasOwn(rawBand, 'cacheReadCost') ? rawBand.cacheReadCost : null,
      cacheWrite: hasCacheWrite ? rawBand.cacheWriteCost : fallbackSource?.endsWith('no-charge') ? '—' : null,
    },
    effectiveFrom: normalizedTimestamp(rawBand.effective),
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
      sourceAmounts: {
        input: Object.hasOwn(raw, 'inputCost') ? raw.inputCost : rendered?.input?.sourceAmount ?? null,
        output: Object.hasOwn(raw, 'outputCost') ? raw.outputCost : rendered?.output?.sourceAmount ?? null,
        cacheRead: Object.hasOwn(raw, 'cacheReadCost') ? raw.cacheReadCost : rendered?.cacheRead?.sourceAmount ?? null,
        cacheWrite: rawHasCacheWrite ? raw.cacheWriteCost : rendered?.cacheWrite?.sourceAmount ?? null,
      },
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
    if (raw.effective) entry.effective = raw.effective;
    if (raw.endsWhen) entry.endsWhen = raw.endsWhen;
    models[raw.id] = entry;
  }

  if (!Object.keys(models).length) throw new Error('CommandCode rate payload contained no models');
  return models;
}

function stepFunMoney(cell) {
  const match = String(cell).match(/\\?\$([0-9]+(?:\.[0-9]+)?)/);
  return match ? normalizeRateAmount(match[1]) : null;
}

function stepFunSourceAmount(cell) {
  return String(cell).match(/\\?\$[0-9]+(?:\.[0-9]+)?/)?.[0].replace('\\', '') ?? null;
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
      sourceAmounts: {
        input: stepFunSourceAmount(missCell),
        output: stepFunSourceAmount(outputCell),
        cacheRead: stepFunSourceAmount(hitCell),
        cacheWrite: documentedCacheWrite ? stepFunSourceAmount(missCell) : null,
      },
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

function buildRateTable(previous, preparedProviders, refreshedAt) {
  const providers = {};
  for (const [providerKey, prepared] of Object.entries(preparedProviders)) {
    providers[providerKey] = {
      source: RATES_SOURCE[providerKey],
      fetchedAt: refreshedAt,
      models: prepared.models,
      excludedModelIds: prepared.excludedModelIds,
      excludedModelReasons: prepared.excludedModelReasons,
      rateRecords: mergeRateRecords(previous?.providers?.[providerKey]?.rateRecords, prepared.rateRecords),
    };
  }
  const history = [
    ...(previous?._meta?.history ?? []).filter((entry) => entry.versionId !== refreshedAt),
    {
      versionId: refreshedAt,
      parserVersion: RATE_PARSER_VERSION,
      providers: Object.fromEntries(Object.entries(providers).map(([key, entry]) => [key, {
        models: Object.keys(entry.models).length,
        excludedModels: entry.excludedModelIds.length,
        rateRecords: entry.rateRecords.length,
      }])),
    },
  ];
  return {
    _meta: {
      parserVersion: RATE_PARSER_VERSION,
      sourceParserVersion: { ...SOURCE_PARSER_VERSION },
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt,
      history,
      sourceCoverage: Object.fromEntries(Object.entries(providers).map(([key, entry]) => [key, {
        sourceModels: Object.keys(entry.models).length + entry.excludedModelIds.length,
        publishedModels: Object.keys(entry.models).length,
        excludedModels: entry.excludedModelIds.length,
      }])),
      cacheWriteNote: 'Every published component has an explicit source value, effective interval, context range, time band, and fingerprint. Missing values remain unknown.',
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

export function createRateTable(preparedProviders, { refreshedAt = new Date().toISOString() } = {}) {
  if (!Number.isFinite(Date.parse(refreshedAt))) throw new Error('refreshedAt must be an ISO timestamp');
  return validateRateTable(buildRateTable(null, preparedProviders, refreshedAt));
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
      const parsedModels = providerKey === 'commandcode'
        ? parseCommandCodeRates(sourceText)
        : parseStepFunRates(sourceText);
      const prepared = prepareProviderRates(providerKey, parsedModels, { refreshedAt });
      if (!Object.keys(prepared.models).length) {
        const reason = Object.values(prepared.excludedModelReasons)[0] ?? 'no complete source cards';
        throw new Error(`${providerKey} has no complete models: ${reason}`);
      }
      providers[providerKey] = prepared;
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
