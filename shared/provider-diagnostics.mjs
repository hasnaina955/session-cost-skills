import {
  BUILTIN_PROVIDER_MANIFESTS,
  detectConfiguredProvider,
  normalizeModelId,
  normalizeProviderId,
  resolveDriverModelMatch,
} from './provider-driver.mjs';

function manifestForConfiguredProfile(profile, configuration, runtimeId) {
  return detectConfiguredProvider(profile.match.providerIds[0], configuration, runtimeId);
}

export function discoverProviderManifests(configuration, runtimeId) {
  const manifests = new Map();
  for (const manifest of BUILTIN_PROVIDER_MANIFESTS) {
    if (manifest.match.runtimes.includes(runtimeId)) manifests.set(manifest.id, manifest);
  }
  for (const profile of configuration?.providers ?? []) {
    if (!profile.match.runtimes.includes(runtimeId)) continue;
    const manifest = manifestForConfiguredProfile(profile, configuration, runtimeId);
    manifests.set(manifest.id, manifest);
  }
  return [...manifests.values()].sort((left, right) => left.id.localeCompare(right.id));
}

export function explainProviderMatch({ providerId, configuration = {}, runtimeId }) {
  const manifests = discoverProviderManifests(configuration, runtimeId);
  const exact = [];
  const normalized = [];
  for (const manifest of manifests) {
    for (const candidate of manifest.match.providerIds) {
      if (candidate === providerId) exact.push({ manifest, matchedOn: candidate });
      if (normalizeProviderId(candidate) === normalizeProviderId(providerId)) normalized.push({ manifest, matchedOn: candidate });
    }
  }
  const matches = exact.length ? exact : normalized;
  const unique = [...new Map(matches.map((match) => [match.manifest.id, match])).values()];
  if (unique.length === 0) {
    return {
      requestedProvider: providerId ?? null,
      status: 'unknown',
      rule: 'unknown',
      providerId: null,
      manifest: null,
      candidates: manifests.map((manifest) => manifest.id),
    };
  }
  if (unique.length > 1) {
    return {
      requestedProvider: providerId,
      status: 'ambiguous',
      rule: exact.length ? 'provider-id-collision' : 'normalized-provider-collision',
      providerId: null,
      manifest: null,
      candidates: unique.map((match) => match.manifest.id),
    };
  }
  return {
    requestedProvider: providerId,
    status: 'matched',
    rule: exact.length ? 'exact-provider-id' : 'normalized-provider-id',
    providerId: unique[0].manifest.id,
    matchedOn: unique[0].matchedOn,
    manifest: unique[0].manifest,
    candidates: [unique[0].manifest.id],
  };
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex;
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      const above = previous[rightIndex];
      previous[rightIndex] = Math.min(
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + 1,
        diagonal + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[right.length];
}

export function suggestModels(modelId, candidates, limit = 3) {
  const normalized = normalizeModelId(modelId);
  return [...new Set(candidates.map(String))]
    .map((candidate) => ({ model: candidate, distance: editDistance(normalized, normalizeModelId(candidate)) }))
    .filter((item) => item.distance <= Math.max(2, Math.floor(normalized.length * 0.25)))
    .sort((left, right) => left.distance - right.distance || left.model.localeCompare(right.model))
    .slice(0, limit)
    .map((item) => ({ ...item, rule: 'suggestion-only' }));
}

export function explainModelMatch({
  runtimeId,
  providerId,
  modelId,
  configuration = {},
  knownModelIds = [],
  rateRecords = [],
}) {
  const provider = explainProviderMatch({ providerId, configuration, runtimeId });
  if (provider.status !== 'matched') {
    return {
      runtime: runtimeId,
      provider,
      requestedModel: modelId ?? null,
      resolvedModel: null,
      status: 'unknown',
      rule: provider.rule,
      alias: null,
      matchedOn: null,
      rateCard: null,
      currency: null,
      coverage: 'unavailable',
      suggestions: [],
    };
  }
  const model = resolveDriverModelMatch({ manifest: provider.manifest }, modelId, { knownModelIds });
  const selectedRecords = model.modelId
    ? rateRecords.filter((record) => record.model === model.modelId)
    : [];
  const inputRecord = selectedRecords.find((record) => record.component === 'input');
  const rateCard = selectedRecords.length ? {
    effectiveFrom: selectedRecords.map((record) => record.effectiveFrom).sort()[0],
    effectiveThrough: selectedRecords.every((record) => record.effectiveThrough) ? selectedRecords.map((record) => record.effectiveThrough).sort().at(-1) : null,
    fingerprint: inputRecord?.fingerprint ?? selectedRecords[0].fingerprint,
    source: inputRecord?.source ?? selectedRecords[0].source,
  } : null;
  return {
    runtime: runtimeId,
    provider,
    requestedModel: modelId ?? null,
    resolvedModel: model.modelId,
    status: model.status,
    rule: model.rule,
    alias: model.alias,
    matchedOn: model.matchedOn,
    candidates: model.candidates ?? [],
    rateCard,
    currency: rateCard ? 'USD' : null,
    coverage: model.status === 'matched' ? (rateCard ? 'complete' : 'model-known-rate-unavailable') : 'unavailable',
    suggestions: model.status === 'unknown' ? suggestModels(modelId, knownModelIds) : [],
  };
}


export function doctorReport({ configuration, runtimeId, providerId = null, modelId = null, knownModelIds = [], rateRecords = [] }) {
  const providers = discoverProviderManifests(configuration, runtimeId).map((manifest) => ({
    id: manifest.id,
    version: manifest.version,
    fingerprint: manifest.fingerprint,
    match: manifest.match,
    capabilities: manifest.capabilities,
    credentialEnv: manifest.credentialEnv,
  }));
  const explanation = providerId || modelId
    ? explainModelMatch({ runtimeId, providerId, modelId, configuration, knownModelIds, rateRecords })
    : null;
  const warnings = [];
  if (providerId && !configuration?.providers?.some((profile) => profile.match.providerIds.includes(providerId))) warnings.push(`provider ${providerId} uses built-in matching`);
  if (explanation?.status === 'unknown') warnings.push(`model ${modelId} is unresolved`);
  if (explanation?.status === 'ambiguous') warnings.push(`model ${modelId} has ambiguous normalized candidates`);
  return {
    schemaVersion: 1,
    runtime: runtimeId,
    configuration: configuration ? { sources: configuration.sources, profileSources: configuration.profileSources, selected: configuration.selected } : null,
    providers,
    explanation,
    warnings,
  };
}

export function discoverModels({ configuration, runtimeId, providerId = null, knownModels = {} }) {
  const explanations = discoverProviderManifests(configuration, runtimeId).map((manifest) => ({
    provider: manifest.id,
    models: (knownModels[manifest.id] ?? []).map((id) => ({
      id,
      aliases: Object.entries(manifest.modelAliases).filter(([, target]) => target === id).map(([alias]) => alias),
    })),
  }));
  return providerId ? explanations.filter((item) => item.provider === providerId) : explanations;
}

export function renderDiagnostics(report) {
  if (report.action === 'providers') {
    return report.providers.map((provider) => `${provider.id}@${provider.version} [${provider.capabilities.pricing}]`).join('\n');
  }
  if (report.action === 'models') {
    return report.models.flatMap((entry) => entry.models.map((model) => `${entry.provider} ${model.id}${model.aliases.length ? ` aliases=${model.aliases.join(',')}` : ''}`)).join('\n');
  }
  if (report.action === 'config-explain' && report.explanation) {
    const item = report.explanation;
    return [
      `runtime: ${item.runtime}`,
      `provider: ${item.provider.providerId ?? 'unknown'} (${item.provider.rule})`,
      `model: ${item.requestedModel ?? 'unknown'} -> ${item.resolvedModel ?? 'unknown'} (${item.rule})`,
      `coverage: ${item.coverage}`,
      ...item.suggestions.map((suggestion) => `suggestion: ${suggestion.model} (${suggestion.rule})`),
    ].join('\n');
  }
  return [
    `runtime: ${report.runtime}`,
    `configuration sources: ${Object.keys(report.configuration?.sources ?? {}).join(', ') || 'none'}`,
    `providers: ${report.providers.length}`,
    ...report.warnings,
  ].join('\n');
}
