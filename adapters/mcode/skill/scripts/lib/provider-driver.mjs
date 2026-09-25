import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';

export const PROVIDER_DRIVER_CONTRACT_VERSION = '1.0.0';

const COMPONENTS = ['input', 'output', 'cacheRead', 'cacheWrite'];

export function normalizeProviderId(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^custom_provider:/, '')
    .replace(/^custom:/, '')
    .replace(/[^a-z0-9]/g, '');
}

export function normalizeModelId(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/^[^/]*\//, '')
    .replace(/[^a-z0-9]/g, '');
}

function assertNoSecretFields(value, location = 'driver') {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/^(?:apiKey|secret|password|authorization|accessToken|refreshToken)$/i.test(key)) {
      throw new Error(`${location} contains a serialized secret field ${key}`);
    }
    assertNoSecretFields(child, `${location}.${key}`);
  }
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function providerDriverFingerprint(manifest) {
  return `sha256:${createHash('sha256').update(JSON.stringify(manifest)).digest('hex')}`;
}

export function defineProviderDriver(definition) {
  const manifest = clone(definition?.manifest ?? definition);
  const handlers = definition?.handlers ?? {};
  assertNoSecretFields(manifest);
  if (manifest?.schemaVersion !== 1) throw new Error('provider driver schemaVersion must be 1');
  if (manifest?.contractVersion !== PROVIDER_DRIVER_CONTRACT_VERSION) {
    throw new Error(`provider driver contractVersion must be ${PROVIDER_DRIVER_CONTRACT_VERSION}`);
  }
  if (!manifest?.id || !manifest?.version) throw new Error('provider driver id and version are required');
  if (!manifest?.match || !Array.isArray(manifest.match.runtimes) || !manifest.match.runtimes.length) {
    throw new Error('provider driver must declare supported runtimes');
  }
  if (!manifest?.capabilities || !manifest?.tokenSemantics || !manifest?.source) {
    throw new Error('provider driver capabilities, token semantics, and source are required');
  }
  if (!Array.isArray(manifest?.match?.providerIds) || !manifest.match.providerIds.length) {
    throw new Error('provider driver must declare at least one provider id');
  }
  if (!Array.isArray(manifest.operations) || !manifest.operations.length) {
    throw new Error('provider driver must declare at least one operation');
  }
  for (const operation of manifest.operations ?? []) {
    if (typeof handlers[operation] !== 'function') throw new Error(`provider driver ${manifest.id} is missing ${operation}`);
  }
  return {
    manifest: Object.freeze({ ...manifest, fingerprint: providerDriverFingerprint(manifest) }),
    handlers: Object.freeze({ ...handlers }),
  };
}

export function createProviderRegistry(definitions, { runtimeId = null } = {}) {
  const drivers = new Map();
  for (const definition of definitions) {
    const driver = definition?.manifest?.fingerprint && definition.handlers
      ? definition
      : defineProviderDriver(definition);
    if (runtimeId && !driver.manifest.match.runtimes.includes(runtimeId)) continue;
    if (drivers.has(driver.manifest.id)) throw new Error(`duplicate provider driver ${driver.manifest.id}`);
    drivers.set(driver.manifest.id, driver);
  }
  return {
    list: () => [...drivers.values()],
    detect(providerId) {
      const normalized = normalizeProviderId(providerId);
      return [...drivers.values()].filter((driver) => driver.manifest.match.providerIds
        .some((candidate) => normalizeProviderId(candidate) === normalized));
    },
    resolve(providerId) {
      const matches = this.detect(providerId);
      if (matches.length === 0) return null;
      if (matches.length > 1) throw new Error(`multiple provider drivers match ${providerId}`);
      return matches[0];
    },
  };
}

function globMatches(pattern, value) {
  if (!pattern.includes('*')) return false;
  const escaped = pattern.split('*').map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('.*');
  return new RegExp(`^${escaped}$`, 'i').test(value);
}

export function resolveDriverModelMatch(driver, modelId, { knownModelIds = [] } = {}) {
  const known = [...new Set(knownModelIds.map(String))];
  if (known.includes(String(modelId))) {
    return { modelId, rule: 'exact-rate-model', matchedOn: modelId, alias: null, status: 'matched' };
  }
  const aliases = Object.entries(driver?.manifest?.modelAliases ?? {}).sort(([left], [right]) => left.localeCompare(right));
  const exactAlias = aliases.find(([alias]) => alias === modelId);
  if (exactAlias) return { modelId: exactAlias[1], rule: 'exact-alias', matchedOn: exactAlias[0], alias: exactAlias[0], status: 'matched' };
  const normalized = normalizeModelId(modelId);
  const normalizedAlias = aliases.find(([alias]) => normalizeModelId(alias) === normalized);
  if (normalizedAlias) return { modelId: normalizedAlias[1], rule: 'normalized-alias', matchedOn: normalizedAlias[0], alias: normalizedAlias[0], status: 'matched' };
  const normalizedModels = known.filter((candidate) => normalizeModelId(candidate) === normalized);
  if (normalizedModels.length === 1) {
    return { modelId: normalizedModels[0], rule: 'normalized-rate-model', matchedOn: normalizedModels[0], alias: null, status: 'matched' };
  }
  if (normalizedModels.length > 1) {
    return { modelId: null, rule: 'normalized-model-collision', matchedOn: normalized, alias: null, status: 'ambiguous', candidates: normalizedModels };
  }
  const globAlias = aliases.find(([alias]) => globMatches(alias, String(modelId)));
  if (globAlias) return { modelId: globAlias[1], rule: 'glob-alias', matchedOn: globAlias[0], alias: globAlias[0], status: 'matched' };
  return { modelId: String(modelId), rule: 'unknown', matchedOn: null, alias: null, status: 'unknown', candidates: [] };
}

export function resolveDriverModel(driver, modelId, options = {}) {
  return resolveDriverModelMatch(driver, modelId, options).modelId ?? String(modelId);
}

export const BUILTIN_PROVIDER_MANIFESTS = Object.freeze([
  {
    schemaVersion: 1,
    contractVersion: PROVIDER_DRIVER_CONTRACT_VERSION,
    id: 'commandcode',
    version: '3.0.0',
    match: { providerIds: ['commandcode', 'custom_provider:commandcode'], runtimes: ['cline', 'mcode'] },
    capabilities: {
      pricing: 'mirrored-rate',
      modelDiscovery: true,
      rateRetrieval: 'network',
      effectiveDates: true,
      contextTiers: true,
      timeBands: true,
      supportedComponents: COMPONENTS,
    },
    tokenSemantics: {
      inputIncludesCache: false,
      cacheReadSeparate: true,
      cacheWriteSeparate: true,
      reasoningIncludedInOutput: true,
      contextSizeIncludesOutput: true,
    },
    source: { kind: 'docs', url: 'https://commandcode.ai/docs/resources/pricing-limits', parserVersion: 3 },
    operations: ['detect', 'listModels', 'fetchRates', 'resolveRate'],
    modelAliases: {},
    credentialEnv: null,
  },
  {
    schemaVersion: 1,
    contractVersion: PROVIDER_DRIVER_CONTRACT_VERSION,
    id: 'stepfun',
    version: '2.0.0',
    match: { providerIds: ['stepfun', 'custom_provider:stepfun'], runtimes: ['cline', 'mcode'] },
    capabilities: {
      pricing: 'mirrored-rate',
      modelDiscovery: true,
      rateRetrieval: 'network',
      effectiveDates: true,
      contextTiers: false,
      timeBands: false,
      supportedComponents: COMPONENTS,
    },
    tokenSemantics: {
      inputIncludesCache: false,
      cacheReadSeparate: true,
      cacheWriteSeparate: true,
      reasoningIncludedInOutput: true,
      contextSizeIncludesOutput: true,
    },
    source: { kind: 'docs', url: 'https://platform.stepfun.ai/docs/en/guides/pricing/details.md', parserVersion: 2 },
    operations: ['detect', 'listModels', 'fetchRates', 'resolveRate'],
    modelAliases: {},
    credentialEnv: null,
  },
  {
    schemaVersion: 1,
    contractVersion: PROVIDER_DRIVER_CONTRACT_VERSION,
    id: 'openai-compatible',
    version: '1.0.0',
    match: { providerIds: ['openai-compatible', 'custom_provider:openai-compatible'], runtimes: ['cline', 'mcode'] },
    capabilities: {
      pricing: 'mirrored-rate',
      modelDiscovery: false,
      rateRetrieval: 'manual',
      effectiveDates: true,
      contextTiers: true,
      timeBands: true,
      supportedComponents: COMPONENTS,
    },
    tokenSemantics: {
      inputIncludesCache: false,
      cacheReadSeparate: true,
      cacheWriteSeparate: true,
      reasoningIncludedInOutput: true,
      contextSizeIncludesOutput: true,
    },
    source: { kind: 'protocol', url: 'https://github.com/openai/openai-openapi', parserVersion: 1 },
    operations: ['detect', 'listModels', 'normalizeUsage', 'parseStream', 'resolveRate'],
    modelAliases: {},
    credentialEnv: null,
  },
  {
    schemaVersion: 1,
    contractVersion: PROVIDER_DRIVER_CONTRACT_VERSION,
    id: 'anthropic-compatible',
    version: '1.0.0',
    match: { providerIds: ['anthropic-compatible', 'custom_provider:anthropic-compatible'], runtimes: ['cline', 'mcode'] },
    capabilities: {
      pricing: 'mirrored-rate',
      modelDiscovery: false,
      rateRetrieval: 'manual',
      effectiveDates: true,
      contextTiers: true,
      timeBands: true,
      supportedComponents: COMPONENTS,
    },
    tokenSemantics: {
      inputIncludesCache: false,
      cacheReadSeparate: true,
      cacheWriteSeparate: true,
      reasoningIncludedInOutput: false,
      contextSizeIncludesOutput: true,
    },
    source: { kind: 'protocol', url: 'https://docs.anthropic.com/en/api/messages', parserVersion: 1 },
    operations: ['detect', 'listModels', 'normalizeUsage', 'parseStream', 'resolveRate'],
    modelAliases: {},
    credentialEnv: null,
  },
].map(Object.freeze));

export function detectBuiltinProvider(providerId, runtimeId) {
  const registry = createProviderRegistry(
    BUILTIN_PROVIDER_MANIFESTS.map((manifest) => ({
      manifest,
      handlers: Object.fromEntries(manifest.operations.map((name) => [name, () => null])),
    })),
    { runtimeId },
  );
  return registry.resolve(providerId)?.manifest ?? null;
}

export function detectConfiguredProvider(providerId, configuration, runtimeId) {
  const profiles = configuration?.providers ?? [];
  const normalized = normalizeProviderId(providerId);
  const profile = profiles.find((candidate) => (
    candidate.match?.runtimes?.includes(runtimeId)
    && candidate.match.providerIds.some((id) => normalizeProviderId(id) === normalized)
  ));
  if (!profile) return detectBuiltinProvider(providerId, runtimeId);
  const base = BUILTIN_PROVIDER_MANIFESTS.find((candidate) => candidate.id === profile.driverId);
  if (!base) throw new Error(`provider profile ${profile.id} references unsupported driver ${profile.driverId}`);
  const aliases = Object.fromEntries((configuration.models ?? [])
    .filter((mapping) => profile.match.providerIds.includes(mapping.provider))
    .map((mapping) => [mapping.runtimeModel, mapping.rateModel]));
  return defineProviderDriver({
    manifest: {
      ...base,
      id: profile.id,
      version: `${base.version}+profile`,
      match: profile.match,
      modelAliases: { ...base.modelAliases, ...aliases },
    },
    handlers: Object.fromEntries(base.operations.map((operation) => [operation, () => null])),
  }).manifest;
}

export async function loadProviderDrivers(directory) {
  const root = path.resolve(directory);
  if (!fs.existsSync(root)) return [];
  const files = fs.readdirSync(root).filter((name) => name.endsWith('.mjs')).sort();
  const definitions = [];
  for (const file of files) {
    const target = path.join(root, file);
    const module = await import(pathToFileURL(target).href);
    definitions.push(module.default ?? module);
  }
  return definitions.map(defineProviderDriver);
}
