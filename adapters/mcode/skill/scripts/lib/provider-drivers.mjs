import { createHash } from 'node:crypto';
import {
  BUILTIN_PROVIDER_MANIFESTS,
  createProviderRegistry,
  defineProviderDriver,
  resolveDriverModel,
} from './provider-driver.mjs';
import { RATES_SOURCE, REQUIRED_RATE_COMPONENTS, bandForTimestamp, makeRateRecord, refreshRateTable, resolveRate } from './rates.mjs';
import { PROTOCOL_ADAPTERS } from './protocol-adapters.mjs';

export function profileRateRecords(profile) {
  const imported = (profile.importedRateRecords ?? []).map((record) => ({
    schemaVersion: 1,
    unit: 'per_1m_tokens',
    effectiveThrough: null,
    ...record,
    id: record.id ?? `${profile.id}|${record.model}|${record.component}`,
  }));
  const manual = (profile.rateCards ?? []).flatMap((card) => {
    for (const component of REQUIRED_RATE_COMPONENTS) {
      if (!Number.isFinite(card[component]) || card[component] < 0) {
        throw new Error(`provider profile ${profile.id} rate card for ${card.model} is missing ${component}`);
      }
    }
    return REQUIRED_RATE_COMPONENTS.map((component) => makeRateRecord({
    providerKey: profile.id,
    modelKey: card.model,
    component,
    sourceAmount: String(card[component]),
    amount: card[component],
    effectiveFrom: card.effectiveFrom,
    effectiveThrough: card.effectiveThrough ?? null,
    context: card.context ?? { minTokens: 0, maxTokens: null },
    timeBand: card.timeBand ?? 'flat',
    currency: card.currency ?? profile.currency ?? 'USD',
    source: {
      kind: profile.rateSource?.kind ?? 'manual',
      url: profile.rateSource?.url ?? null,
      parserVersion: 1,
      fetchedAt: card.effectiveFrom,
    },
  }));
  });
  return [...imported, ...manual];
}

// Resolve which band a provider profile's rate records belong to.
//
// The previous version called bandForTimestamp(context.at, { timeOfDay: {} }) when a
// profile had no flat record. That applied CommandCode/StepFun's peak calendar to an
// arbitrary OpenAI- or Anthropic-compatible provider, and because the timestamp was an
// ISO string it always resolved to offPeak. The result was a plausible-looking number
// that silently under-reported cost, which is the one failure this tool must not have.
//
// A band is only resolved when the profile's own records justify it. Otherwise the
// profile is reported unpriced rather than guessed.
function resolveProfileTimeBand(records, profile, at) {
  const knownBands = new Set(records.map((record) => record.timeBand));
  if (knownBands.has('flat')) return { timeBand: 'flat' };
  if (knownBands.size <= 1) return { timeBand: [...knownBands][0] ?? 'flat' };
  const timeOfDay = profile?.timeOfDay ?? null;
  if (!timeOfDay || Object.keys(timeOfDay).length === 0) {
    return {
      timeBand: null,
      reason: 'provider profile declares peak and off-peak rate records but no time-of-day policy, so the band cannot be determined',
    };
  }
  return { timeBand: bandForTimestamp(at, { timeOfDay }) };
}

function resolveProfileRate(profile, context) {
  const records = profileRateRecords(profile).filter((record) => record.model === context.model);
  const { timeBand, reason: bandReason } = resolveProfileTimeBand(records, profile, context.at);
  if (timeBand === null) {
    return {
      key: context.model,
      rate: null,
      free: false,
      coverage: 'unavailable',
      missingComponents: [...REQUIRED_RATE_COMPONENTS],
      timeBand: null,
      contextTokens: Math.max(0, Number(context.contextTokens) || 0),
      reason: bandReason,
    };
  }
  const timestamp = typeof context.at === 'string' ? Date.parse(context.at) : Number(context.at ?? Date.now());
  const contextTokens = Math.max(0, Number(context.contextTokens) || 0);
  const applies = (record) => {
    const through = record.effectiveThrough ? Date.parse(record.effectiveThrough) : Infinity;
    return timestamp >= Date.parse(record.effectiveFrom)
      && timestamp < through
      && record.timeBand === timeBand
      && contextTokens >= (record.context?.minTokens ?? 0)
      && (record.context?.maxTokens === null || record.context?.maxTokens === undefined || contextTokens <= record.context.maxTokens);
  };
  const selected = [];
  const missingComponents = [];
  for (const component of REQUIRED_RATE_COMPONENTS) {
    const matches = records.filter((record) => record.component === component && applies(record))
      .sort((left, right) => right.effectiveFrom.localeCompare(left.effectiveFrom));
    if (!matches.length) missingComponents.push(component);
    else selected.push(matches[0]);
  }
  if (missingComponents.length) {
    return {
      key: context.model,
      rate: null,
      free: false,
      coverage: selected.length ? 'partial' : 'unavailable',
      missingComponents,
      timeBand,
      contextTokens,
    };
  }
  const rate = Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [
    component,
    selected.find((record) => record.component === component).amount,
  ]));
  return {
    key: context.model,
    rate: {
      ...rate,
      name: context.model,
      currency: selected[0].currency ?? profile.currency ?? 'USD',
      region: profile.region ?? null,
      endpointEnv: profile.baseUrlEnv ?? profile.endpointEnv ?? null,
      credentialEnv: profile.credentialEnv ?? null,
      rateRecords: selected,
      effectiveFrom: selected[0].effectiveFrom,
      effectiveThrough: selected[0].effectiveThrough,
      sourceUrls: [...new Set(selected.map((record) => record.source?.url).filter(Boolean))],
      fingerprint: `sha256:${createHash('sha256').update(selected.map((record) => record.fingerprint).sort().join('\n')).digest('hex')}`,
    },
    free: false,
    coverage: 'complete',
    missingComponents: [],
    timeBand,
    contextTokens,
  };
}

function handlersFor(base, profile = null, table) {
  const protocol = PROTOCOL_ADAPTERS[base.id];
  const profileModels = profile ? [...new Set(profileRateRecords(profile).map((record) => record.model))] : [];
  const hasProfileRates = Boolean(profile?.rateCards?.length || profile?.importedRateRecords?.length);
  return {
    detect: () => true,
    listModels: () => profile
      ? profileModels.map((id) => ({ id, name: id, provider: profile.id }))
      : Object.entries(table?.providers?.[base.id]?.models ?? {}).map(([id, model]) => ({ id, name: model.name, provider: base.id })),
    ...(protocol ? {
      normalizeUsage: protocol.normalizeUsage,
      parseStream: protocol.parseStream,
    } : {}),
    ...(base.operations.includes('fetchRates') ? { fetchRates: (context = {}) => refreshRateTable(context) } : {}),
    resolveRate: (context) => profile && hasProfileRates
      ? resolveProfileRate(profile, context)
      : resolveRate(table, base.id, context.model, context),
  };
}

export function createMCodeProviderRegistry(table, { profiles = [], models = [] } = {}) {
  const definitions = [];
  for (const base of BUILTIN_PROVIDER_MANIFESTS) {
    const matchingModels = models.filter((mapping) => base.match.providerIds.includes(mapping.provider));
    const aliases = Object.fromEntries(matchingModels.map((mapping) => [mapping.runtimeModel, mapping.rateModel]));
    definitions.push({
      manifest: { ...base, modelAliases: { ...base.modelAliases, ...aliases } },
      handlers: handlersFor(base, null, table),
    });
  }
  for (const profile of profiles) {
    const base = BUILTIN_PROVIDER_MANIFESTS.find((candidate) => candidate.id === profile.driverId);
    if (!base) throw new Error(`provider profile ${profile.id} references unsupported driver ${profile.driverId}`);
    const matchingModels = models.filter((mapping) => profile.match.providerIds.includes(mapping.provider));
    const aliases = Object.fromEntries(matchingModels.map((mapping) => [mapping.runtimeModel, mapping.rateModel]));
    definitions.push({
      manifest: {
        ...base,
        id: profile.id,
        version: `${base.version}+profile`,
        match: profile.match,
        modelAliases: { ...base.modelAliases, ...aliases },
      },
      handlers: handlersFor(base, profile, table),
    });
  }
  return createProviderRegistry(definitions, { runtimeId: 'mcode' });
}

export function resolveWithProviderDriver(registry, context) {
  const driver = registry.resolve(context.provider);
  if (!driver) {
    return {
      key: null,
      rate: null,
      free: false,
      providerKey: '',
      coverage: 'unavailable',
      missingComponents: ['input', 'output', 'cacheRead', 'cacheWrite'],
      providerDriver: null,
      resolvedModel: context.model,
    };
  }
  const model = resolveDriverModel(driver, context.model);
  const result = driver.handlers.resolveRate({ ...context, provider: driver.manifest.id, model });
  return {
    ...result,
    providerDriver: driver.manifest,
    resolvedModel: model,
  };
}

export function providerDriverSources() {
  return Object.fromEntries(BUILTIN_PROVIDER_MANIFESTS.map((driver) => [driver.id, RATES_SOURCE[driver.id] ?? driver.source.url]));
}
