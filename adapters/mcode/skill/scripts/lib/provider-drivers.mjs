import {
  BUILTIN_PROVIDER_MANIFESTS,
  createProviderRegistry,
  defineProviderDriver,
  resolveDriverModel,
} from './provider-driver.mjs';
import { RATES_SOURCE, refreshRateTable, resolveRate } from './rates.mjs';

export function createMCodeProviderRegistry(table, { profiles = [], models = [] } = {}) {
  const definitions = [];
  for (const base of BUILTIN_PROVIDER_MANIFESTS) {
    const matchingModels = models.filter((mapping) => base.match.providerIds.includes(mapping.provider));
    const aliases = Object.fromEntries(matchingModels.map((mapping) => [mapping.runtimeModel, mapping.rateModel]));
    definitions.push({
      manifest: { ...base, modelAliases: { ...base.modelAliases, ...aliases } },
      handlers: {
        detect: () => true,
        listModels: () => Object.entries(table?.providers?.[base.id]?.models ?? {}).map(([id, model]) => ({ id, name: model.name, provider: base.id })),
        fetchRates: (context = {}) => refreshRateTable(context),
        resolveRate: (context) => resolveRate(table, base.id, context.model, context),
      },
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
      handlers: {
        detect: () => true,
        listModels: () => Object.entries(table?.providers?.[profile.driverId]?.models ?? {}).map(([id, model]) => ({ id, name: model.name, provider: profile.driverId })),
        fetchRates: (context = {}) => refreshRateTable(context),
        resolveRate: (context) => resolveRate(table, profile.driverId, context.model, context),
      },
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
