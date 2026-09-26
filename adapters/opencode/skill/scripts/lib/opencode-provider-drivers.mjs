// Provider-driver wiring for the OpenCode adapter.
//
// ## Why this file exists and is not the MCode one
//
// The MCode adapter prices against a bundled, versioned rate table it ships and can refresh
// from the network (`rates.mjs` + `references/provider-rates.json`). This adapter must not
// ship one: OpenCode runs against whatever provider the user configured, including local and
// self-hosted ones, so there is no single correct table to bundle. The rate source here is the
// user's own provider profile, whose `rateCards` and `importedRateRecords` are validated by the
// shared config module and already carry effective dates, context tiers, and currency.
//
// Everything that decides *which* driver a call belongs to is the shared machinery, unchanged:
// the built-in manifests, the deterministic provider matching, alias resolution, and the
// duplicate/ambiguity failures all come from `./provider-driver.mjs`. Only the rate lookup
// differs, and it differs because the rate source differs.
//
// ## The one rule that shapes the whole file
//
// A call is priced only when every one of input / output / cacheRead / cacheWrite has an
// applicable rate record. A partial card yields no number at all. Zero is a legitimate answer
// (a genuinely free model) and is reported as a number; "no rate" is reported as `null` and
// never as `0`. Those two states must never be confused, because a `$0.00` that is really
// "unknown" is the single worst output this tool can produce.

import { createHash } from 'node:crypto';
import {
  BUILTIN_PROVIDER_MANIFESTS,
  createProviderRegistry,
  resolveDriverModel,
} from './provider-driver.mjs';
import { PROTOCOL_ADAPTERS } from './protocol-adapters.mjs';

const RUNTIME_ID = 'opencode';

export const REQUIRED_RATE_COMPONENTS = Object.freeze(['input', 'output', 'cacheRead', 'cacheWrite']);

const NO_RATE_REASON = 'no rate source is configured for this provider; add a provider profile with rate cards to your session-cost config';

function fingerprint(value) {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

/**
 * A rate record in the `rate-record-v1` shape, so a record taken from a configured profile is
 * indistinguishable from one read out of a mirrored table downstream.
 */
function makeRateRecord({ provider, model, component, amount, effectiveFrom, effectiveThrough, context, timeBand, currency, source }) {
  const sourceAmount = String(amount);
  return {
    schemaVersion: 1,
    id: `${provider}|${model}|${component}|${effectiveFrom}`,
    provider,
    model,
    component,
    sourceAmount,
    amount,
    currency,
    unit: 'per_1m_tokens',
    effectiveFrom,
    effectiveThrough: effectiveThrough ?? null,
    context: { minTokens: context?.minTokens ?? 0, maxTokens: context?.maxTokens ?? null },
    timeBand: timeBand ?? 'flat',
    source: { url: source?.url ?? null, parserVersion: 1, fetchedAt: effectiveFrom },
    fingerprint: fingerprint(`${provider}|${model}|${component}|${sourceAmount}|${effectiveFrom}|${effectiveThrough ?? ''}|${context?.minTokens ?? 0}|${context?.maxTokens ?? ''}|${timeBand ?? 'flat'}|${currency}`),
  };
}

/** Every rate record a configured provider profile declares, in the shared v1 shape. */
export function profileRateRecords(profile) {
  const imported = (profile.importedRateRecords ?? []).map((record) => ({
    schemaVersion: 1,
    unit: 'per_1m_tokens',
    effectiveFrom: new Date(0).toISOString(),
    ...record,
    id: record.id ?? `${profile.id}|${record.model}|${record.component}`,
    currency: record.currency ?? profile.currency ?? 'USD',
    context: { minTokens: record.context?.minTokens ?? 0, maxTokens: record.context?.maxTokens ?? null },
    timeBand: record.timeBand ?? 'flat',
    source: { url: record.source?.url ?? null, parserVersion: record.source?.parserVersion ?? 1, fetchedAt: record.source?.fetchedAt ?? new Date(0).toISOString() },
  }));
  const manual = (profile.rateCards ?? []).flatMap((card) => {
    // validateConfig already rejects a card missing a component, but a driver can be
    // constructed directly, so a card that cannot price a call is refused here too rather
    // than silently contributing 0 for the components it omits.
    for (const component of REQUIRED_RATE_COMPONENTS) {
      if (!Number.isFinite(card[component]) || card[component] < 0) {
        throw new Error(`provider profile ${profile.id} rate card for ${card.model} is missing ${component}`);
      }
    }
    return REQUIRED_RATE_COMPONENTS.map((component) => makeRateRecord({
      provider: profile.id,
      model: card.model,
      component,
      amount: card[component],
      effectiveFrom: card.effectiveFrom,
      effectiveThrough: card.effectiveThrough ?? null,
      context: card.context ?? null,
      timeBand: card.timeBand ?? 'flat',
      currency: card.currency ?? profile.currency ?? 'USD',
      source: { url: profile.rateSource?.url ?? null },
    }));
  });
  return [...imported, ...manual];
}

/**
 * A peak/off-peak card cannot be priced without a time-of-day policy, and guessing a band
 * produces a plausible wrong number. Only `flat` records are resolvable here, so a profile
 * that declares bands is reported unpriced with the reason rather than banded by guesswork.
 */
function resolveProfileTimeBand(records) {
  const bands = new Set(records.map((record) => record.timeBand));
  if (bands.size === 0) return { timeBand: 'flat' };
  if (bands.size === 1 && bands.has('flat')) return { timeBand: 'flat' };
  return {
    timeBand: null,
    reason: 'the configured rate card declares time-banded rates, and this adapter resolves flat rates only, so no band can be selected without guessing',
  };
}

function resolveProfileRate(profile, context) {
  const records = profileRateRecords(profile).filter((record) => record.model === context.model);
  const { timeBand, reason: bandReason } = resolveProfileTimeBand(records);
  const contextTokens = Math.max(0, Number(context.contextTokens) || 0);
  if (timeBand === null) {
    return {
      key: context.model,
      rate: null,
      free: false,
      coverage: 'unavailable',
      missingComponents: [...REQUIRED_RATE_COMPONENTS],
      timeBand: null,
      contextTokens,
      reason: bandReason,
    };
  }
  if (records.length === 0) {
    return {
      key: context.model,
      rate: null,
      free: false,
      coverage: 'unavailable',
      missingComponents: [...REQUIRED_RATE_COMPONENTS],
      timeBand,
      contextTokens,
      reason: `no rate is configured for model ${context.model} at provider ${profile.id}`,
    };
  }

  const timestamp = typeof context.at === 'string' ? Date.parse(context.at) : Number(context.at ?? Date.now());
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
      .sort((left, right) => String(right.effectiveFrom).localeCompare(String(left.effectiveFrom)));
    if (!matches.length) missingComponents.push(component);
    else selected.push(matches[0]);
  }
  if (missingComponents.length) {
    // Partial coverage is not a smaller number. It is no number.
    return {
      key: context.model,
      rate: null,
      free: false,
      coverage: selected.length ? 'partial' : 'unavailable',
      missingComponents,
      timeBand,
      contextTokens,
      reason: `no rate applies for ${missingComponents.join(', ')} at ${new Date(timestamp).toISOString()}`,
    };
  }

  const amounts = Object.fromEntries(REQUIRED_RATE_COMPONENTS.map((component) => [
    component,
    selected.find((record) => record.component === component).amount,
  ]));
  const free = REQUIRED_RATE_COMPONENTS.every((component) => amounts[component] === 0);
  return {
    key: context.model,
    rate: {
      ...amounts,
      name: context.model,
      currency: selected[0].currency ?? profile.currency ?? 'USD',
      region: profile.region ?? null,
      endpointEnv: profile.baseUrlEnv ?? profile.endpointEnv ?? null,
      credentialEnv: profile.credentialEnv ?? null,
      profileId: profile.id,
      rateRecords: selected,
      effectiveFrom: selected.map((record) => record.effectiveFrom).sort()[0],
      effectiveThrough: selected.every((record) => record.effectiveThrough)
        ? selected.map((record) => record.effectiveThrough).sort().at(-1)
        : null,
      sourceUrls: [...new Set(selected.map((record) => record.source?.url).filter(Boolean))],
      fingerprint: fingerprint(selected.map((record) => record.fingerprint).sort().join('\n')),
    },
    free,
    coverage: 'complete',
    missingComponents: [],
    timeBand,
    contextTokens,
  };
}

function handlersFor(base, profile = null) {
  const profileModels = profile ? [...new Set(profileRateRecords(profile).map((record) => record.model))] : [];
  const hasProfileRates = Boolean(profile?.rateCards?.length || profile?.importedRateRecords?.length);
  // A manifest declares an operation, and `defineProviderDriver` refuses a driver that is
  // missing one, so the protocol handlers the built-ins declare are supplied from the shared
  // protocol adapters. They are not used by the ledger path — OpenCode records usage
  // normalised already — but they belong to the driver's declared surface.
  const protocol = PROTOCOL_ADAPTERS[base.id];
  return {
    detect: () => true,
    listModels: () => profileModels.map((id) => ({ id, name: id, provider: profile.id })),
    ...(protocol ? { normalizeUsage: protocol.normalizeUsage, parseStream: protocol.parseStream } : {}),
    ...(base.operations.includes('fetchRates') ? {
      fetchRates: () => {
        // The manifest declares `rateRetrieval` because that is what the shared built-in
        // does for the adapters that ship a table. This adapter ships none, so the
        // operation fails explicitly instead of pretending to refresh a table it lacks.
        throw new Error(`this adapter ships no rate table for ${base.id}: configure a provider profile with rate cards instead`);
      },
    } : {}),
    resolveRate: (context) => {
      if (!profile || !hasProfileRates) {
        return {
          key: context.model,
          rate: null,
          free: false,
          coverage: 'unavailable',
          missingComponents: [...REQUIRED_RATE_COMPONENTS],
          timeBand: null,
          contextTokens: Math.max(0, Number(context.contextTokens) || 0),
          reason: NO_RATE_REASON,
        };
      }
      return resolveProfileRate(profile, context);
    },
  };
}

/**
 * The OpenCode provider registry: the shared built-in manifests, plus one driver per
 * configured provider profile whose `match.runtimes` includes this runtime.
 */
export function createOpenCodeProviderRegistry({ profiles = [], models = [] } = {}) {
  const aliasesFor = (providerIds) => Object.fromEntries(
    models.filter((mapping) => providerIds.includes(mapping.provider)).map((mapping) => [mapping.runtimeModel, mapping.rateModel]),
  );
  const definitions = BUILTIN_PROVIDER_MANIFESTS.map((base) => ({
    manifest: { ...base, modelAliases: { ...base.modelAliases, ...aliasesFor(base.match.providerIds) } },
    handlers: handlersFor(base, null),
  }));
  for (const profile of profiles) {
    if (!profile.match?.runtimes?.includes(RUNTIME_ID)) continue;
    const base = BUILTIN_PROVIDER_MANIFESTS.find((candidate) => candidate.id === profile.driverId);
    if (!base) throw new Error(`provider profile ${profile.id} references unsupported driver ${profile.driverId}`);
    definitions.push({
      manifest: {
        ...base,
        id: profile.id,
        version: `${base.version}+profile`,
        match: profile.match,
        modelAliases: { ...base.modelAliases, ...aliasesFor(profile.match.providerIds) },
      },
      handlers: handlersFor(base, profile),
    });
  }
  return createProviderRegistry(definitions, { runtimeId: RUNTIME_ID });
}

/**
 * Resolve one call's provider driver, model, and rate.
 *
 * An unmatched provider, an unmatched model, and a partially covered card all return
 * `rate: null` with a reason. None of them throws and none of them returns zero.
 */
export function resolveWithProviderDriver(registry, context) {
  const driver = registry.resolve(context.provider);
  if (!driver) {
    return {
      key: null,
      rate: null,
      free: false,
      providerKey: String(context.provider ?? ''),
      coverage: 'unavailable',
      missingComponents: [...REQUIRED_RATE_COMPONENTS],
      providerDriver: null,
      resolvedModel: context.model ?? null,
      reason: `no provider driver matches ${context.provider ?? 'the recorded provider'}`,
    };
  }
  const model = resolveDriverModel(driver, context.model, { knownModelIds: driver.handlers.listModels().map((entry) => entry.id) });
  const result = driver.handlers.resolveRate({ ...context, provider: driver.manifest.id, model });
  return { ...result, providerDriver: driver.manifest, resolvedModel: model };
}
