import {
  BUILTIN_PROVIDER_MANIFESTS,
  createProviderRegistry,
  defineProviderDriver,
  resolveDriverModel,
} from './provider-driver.mjs';
import { RATES_SOURCE, refreshRateTable, resolveRate } from './rates.mjs';

export function createMCodeProviderRegistry(table) {
  const definitions = BUILTIN_PROVIDER_MANIFESTS.map((manifest) => defineProviderDriver({
    manifest,
    handlers: {
      detect: () => true,
      listModels: () => Object.entries(table?.providers?.[manifest.id]?.models ?? {}).map(([id, model]) => ({
        id,
        name: model.name,
        provider: manifest.id,
      })),
      fetchRates: (context = {}) => refreshRateTable(context),
      resolveRate: (context) => resolveRate(table, manifest.id, context.model, context),
    },
  }));
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
