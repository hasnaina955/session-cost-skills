// Offline fixture coverage for every built-in provider driver in both adapters,
// plus the generic OpenAI-compatible and Anthropic-compatible protocol drivers.
//
// Nothing here touches the network, reads credentials, or depends on the wall
// clock. Every driver is enumerated from the real registry modules and every
// timestamp is derived from the bundled rate table, so a new driver or a rate
// refresh is picked up automatically instead of silently drifting away.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import * as mcodeDriver from '../adapters/mcode/skill/scripts/lib/provider-driver.mjs';
import * as clineDriver from '../adapters/cline/skill/scripts/lib/provider-driver.mjs';
import {
  createMCodeProviderRegistry,
  resolveWithProviderDriver,
} from '../adapters/mcode/skill/scripts/lib/provider-drivers.mjs';
import {
  REQUIRED_RATE_COMPONENTS,
  calculateTokenCost,
  readRateTable,
} from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import * as mcodeProtocol from '../adapters/mcode/skill/scripts/lib/protocol-adapters.mjs';
import * as clineProtocol from '../adapters/cline/skill/scripts/lib/protocol-adapters.mjs';
import * as clineDiagnostics from '../adapters/cline/skill/scripts/lib/provider-diagnostics.mjs';
import * as mcodeDiagnostics from '../adapters/mcode/skill/scripts/lib/provider-diagnostics.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const driverSchema = JSON.parse(fs.readFileSync(new URL('../contracts/provider-driver-v1.schema.json', import.meta.url), 'utf8'));
const configSchema = JSON.parse(fs.readFileSync(new URL('../contracts/session-config-v1.schema.json', import.meta.url), 'utf8'));
const table = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));

// Everything below is enumerated from the shipped registry modules on purpose:
// a hard-coded driver list would let a new driver ship with zero fixture coverage.
const BUILTINS = mcodeDriver.BUILTIN_PROVIDER_MANIFESTS;
const OPERATION_NAMES = driverSchema.properties.operations.items.enum;
const RATE_COMPONENTS = [...REQUIRED_RATE_COMPONENTS];
const CACHE_FIELDS = ['cacheReadTokens', 'cacheWriteTokens'];
const NORMALIZED_USAGE_FIELDS = ['inputTokens', 'outputTokens', ...CACHE_FIELDS, 'reasoningTokens'];
const NORMALIZED_USAGE_KEYS = [...NORMALIZED_USAGE_FIELDS, 'coverage', 'missingComponents'];
const BUILTIN_IDS = BUILTINS.map((manifest) => manifest.id);
const PROTOCOL_DRIVER_IDS = BUILTINS.filter((manifest) => manifest.source.kind === 'protocol').map((manifest) => manifest.id);
const RUNTIMES = [...new Set(BUILTINS.flatMap((manifest) => manifest.match.runtimes))].sort();
const registry = createMCodeProviderRegistry(table);

// Rate timestamps come from the bundled table. StepFun publishes no effective date,
// so its records only apply from the moment they were observed.
function resolvedAt(providerId) {
  const fetchedAt = table.providers[providerId]?.fetchedAt ?? table._meta.refreshedAt;
  return new Date(Date.parse(fetchedAt) + 86_400_000).toISOString();
}

function weekdayAt(providerId, hour) {
  const date = new Date(Date.parse(resolvedAt(providerId)) + 86_400_000);
  while (date.getUTCDay() === 0 || date.getUTCDay() === 6) date.setUTCDate(date.getUTCDate() + 1);
  date.setUTCHours(hour, 0, 0, 0);
  return date.toISOString();
}

// One complete payload and degraded payloads per generic protocol driver.
// `expected` is the token semantics the driver manifest declares.
const USAGE_FIXTURES = {
  'openai-compatible': [
    {
      name: 'complete-with-cache-read-and-cache-write',
      payload: {
        usage: {
          prompt_tokens: 4_000,
          completion_tokens: 900,
          prompt_tokens_details: { cached_tokens: 1_500, cache_creation_tokens: 250 },
          completion_tokens_details: { reasoning_tokens: 300 },
        },
      },
      expected: {
        inputTokens: 2_500,
        outputTokens: 900,
        cacheReadTokens: 1_500,
        cacheWriteTokens: 250,
        reasoningTokens: 300,
        coverage: 'complete',
        missingComponents: [],
      },
    },
    {
      name: 'zero-cache-read-no-cache-write',
      payload: { usage: { prompt_tokens: 2_000, completion_tokens: 120, prompt_tokens_details: { cached_tokens: 0 } } },
      expected: {
        inputTokens: 2_000,
        outputTokens: 120,
        cacheReadTokens: 0,
        cacheWriteTokens: null,
        reasoningTokens: null,
        coverage: 'partial',
        missingComponents: ['cacheWriteTokens'],
      },
    },
    {
      name: 'cache-read-above-prompt-is-clamped',
      payload: { usage: { prompt_tokens: 100, completion_tokens: 10, prompt_tokens_details: { cached_tokens: 250 } } },
      expected: {
        inputTokens: 0,
        outputTokens: 10,
        cacheReadTokens: 250,
        cacheWriteTokens: null,
        reasoningTokens: null,
        coverage: 'partial',
        missingComponents: ['cacheWriteTokens'],
      },
    },
    {
      name: 'no-usage-object',
      payload: { model: 'vendor-model', choices: [] },
      expected: {
        inputTokens: null,
        outputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        coverage: 'unavailable',
        missingComponents: ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'],
      },
    },
  ],
  'anthropic-compatible': [
    {
      name: 'complete-with-cache-read-and-cache-write',
      payload: {
        input_tokens: 1_200,
        output_tokens: 340,
        cache_read_input_tokens: 8_000,
        cache_creation_input_tokens: 600,
      },
      expected: {
        inputTokens: 1_200,
        outputTokens: 340,
        cacheReadTokens: 8_000,
        cacheWriteTokens: 600,
        reasoningTokens: null,
        coverage: 'complete',
        missingComponents: [],
      },
    },
    {
      name: 'explicit-zero-cache-is-known-not-missing',
      payload: { input_tokens: 50, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      expected: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        coverage: 'complete',
        missingComponents: [],
      },
    },
    {
      name: 'cache-fields-absent-stay-unknown',
      payload: { input_tokens: 50, output_tokens: 10 },
      expected: {
        inputTokens: 50,
        outputTokens: 10,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        reasoningTokens: null,
        coverage: 'partial',
        missingComponents: ['cacheReadTokens', 'cacheWriteTokens'],
      },
    },
  ],
};

// Each protocol's raw input field means something different: OpenAI's prompt_tokens
// includes cached tokens, while Anthropic's input_tokens already excludes both cache
// reads and cache writes. That difference belongs to the protocol, not the driver.
const RAW_INPUT_EXCLUDES_CACHE = { 'openai-compatible': false, 'anthropic-compatible': true };

// Wire formats each generic protocol driver must be able to read offline.
const STREAM_FIXTURES = {
  'openai-compatible': [
    {
      name: 'sse-data-framing-with-done-sentinel',
      text: [
        ': keep-alive',
        'data: {"model":"vendor-chat","choices":[{"delta":{"content":"he"}}]}',
        '',
        'data: {"model":"vendor-chat","choices":[{"delta":{"content":"llo"}}]}',
        '',
        'data: {"model":"vendor-chat","choices":[],"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_tokens_details":{"cached_tokens":400,"cache_creation_tokens":100}}}',
        '',
        'data: [DONE]',
        '',
      ].join('\n'),
      expected: {
        protocol: 'openai-compatible',
        model: 'vendor-chat',
        eventCount: 3,
        inputTokens: 600,
        outputTokens: 20,
        cacheReadTokens: 400,
        cacheWriteTokens: 100,
        reasoningTokens: null,
      },
    },
  ],
  'anthropic-compatible': [
    {
      name: 'one-json-event-per-line',
      text: [
        JSON.stringify({ type: 'message_start', message: { model: 'vendor-claude', usage: { input_tokens: 120, cache_read_input_tokens: 40, cache_creation_input_tokens: 20, output_tokens: 1 } } }),
        JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
        JSON.stringify({ type: 'message_delta', usage: { output_tokens: 250 } }),
        JSON.stringify({ type: 'message_stop' }),
      ].join('\n'),
      expected: {
        protocol: 'anthropic-compatible',
        model: 'vendor-claude',
        eventCount: 4,
        inputTokens: 120,
        outputTokens: 250,
        cacheReadTokens: 40,
        cacheWriteTokens: 20,
        reasoningTokens: null,
      },
    },
  ],
};

const CARD = {
  model: 'vendor-model',
  effectiveFrom: '2026-01-01T00:00:00.000Z',
  currency: 'USD',
  input: 2,
  output: 6,
  cacheRead: 0.2,
  cacheWrite: 2.5,
};
const CARD_AT = '2026-06-01T00:00:00.000Z';
const VENDOR_RUNTIME_MODEL = 'Vendor/Offline Model';
const VENDOR_LOWERCASE_MODEL = 'vendor/offline model';

function vendorModelMappings(driverId) {
  return [VENDOR_RUNTIME_MODEL, VENDOR_LOWERCASE_MODEL].map((runtimeModel) => ({
    runtime: 'mcode',
    provider: `offline-${driverId}`,
    runtimeModel,
    rateModel: CARD.model,
  }));
}

// A fully offline manual-rates profile for a generic protocol driver, wired the way
// an end user configures a custom OpenAI- or Anthropic-compatible endpoint.
function vendorProfile(driverId) {
  return {
    id: `offline-${driverId}`,
    driverId,
    match: { providerIds: [`offline-${driverId}`], runtimes: ['cline', 'mcode'] },
    baseUrlEnv: 'OFFLINE_VENDOR_BASE_URL',
    credentialEnv: 'OFFLINE_VENDOR_API_KEY',
    region: 'offline-region',
    currency: 'USD',
    pricingMode: 'manual',
    rateCards: [CARD],
  };
}

function vendorRegistry(driverId) {
  return createMCodeProviderRegistry(table, {
    profiles: [vendorProfile(driverId)],
    models: vendorModelMappings(driverId),
  });
}

function vendorConfiguration() {
  return {
    schemaVersion: 1,
    runtimeDefaults: {},
    providers: PROTOCOL_DRIVER_IDS.map((driverId) => vendorProfile(driverId)),
    models: PROTOCOL_DRIVER_IDS.flatMap((driverId) => vendorModelMappings(driverId)),
  };
}

function vendorResolution(driverId) {
  return resolveWithProviderDriver(vendorRegistry(driverId), {
    provider: `offline-${driverId}`,
    model: VENDOR_RUNTIME_MODEL,
    at: CARD_AT,
    contextTokens: 1_000,
  });
}

test('driver enumeration comes from the real registries and both adapters agree', () => {
  assert.ok(BUILTINS.length > 0, 'the built-in manifest registry must not be empty');
  assert.equal(new Set(BUILTIN_IDS).size, BUILTIN_IDS.length, 'built-in driver ids must be unique');
  assert.deepEqual(clineDriver.BUILTIN_PROVIDER_MANIFESTS, BUILTINS, 'both adapters must ship the same built-in manifests');
  assert.equal(clineDriver.PROVIDER_DRIVER_CONTRACT_VERSION, mcodeDriver.PROVIDER_DRIVER_CONTRACT_VERSION);

  // The priced MCode registry must wire every built-in manifest, or a new driver
  // would ship with a manifest but no handlers.
  assert.deepEqual(registry.list().map((driver) => driver.manifest.id).sort(), [...BUILTIN_IDS].sort());
  for (const driver of registry.list()) {
    assert.deepEqual(Object.keys(driver.handlers).sort(), [...driver.manifest.operations].sort());
  }

  // Protocol drivers are exactly the manifests sourced from a protocol spec, and
  // each one has a matching entry in the shared protocol adapter registry.
  assert.deepEqual(Object.keys(mcodeProtocol.PROTOCOL_ADAPTERS).sort(), [...PROTOCOL_DRIVER_IDS].sort());
  assert.deepEqual(Object.keys(clineProtocol.PROTOCOL_ADAPTERS).sort(), [...PROTOCOL_DRIVER_IDS].sort());
  for (const manifest of BUILTINS.filter((candidate) => candidate.source.kind !== 'protocol')) {
    assert.equal(mcodeProtocol.PROTOCOL_ADAPTERS[manifest.id], undefined, `${manifest.id} must not borrow a protocol adapter`);
  }
  // Every operation in the schema vocabulary is exercised by at least one driver.
  const declaredOperations = new Set(BUILTINS.flatMap((manifest) => manifest.operations));
  for (const operation of OPERATION_NAMES) {
    assert.ok(declaredOperations.has(operation), `no built-in driver exercises the ${operation} operation`);
  }
});

test('every built-in manifest validates against the v1 driver contract in both adapters', () => {
  for (const raw of BUILTINS) {
    for (const runtime of raw.match.runtimes) {
      for (const [label, module] of [['cline', clineDriver], ['mcode', mcodeDriver]]) {
        const manifest = module.detectBuiltinProvider(raw.id, runtime);
        assert.ok(manifest, `${label} must expose ${raw.id} for runtime ${runtime}`);
        assert.equal(manifest.id, raw.id);
        assert.deepEqual(validateJsonSchema(manifest, driverSchema), [], `${label}/${raw.id} must satisfy the driver schema`);
        assert.equal(manifest.contractVersion, driverSchema.properties.contractVersion.const);
        const { fingerprint, ...withoutFingerprint } = manifest;
        assert.equal(fingerprint, module.providerDriverFingerprint(withoutFingerprint), `${label}/${raw.id} fingerprint must cover the whole manifest`);
        assert.deepEqual(manifest.match, raw.match);
        assert.deepEqual(manifest.capabilities, raw.capabilities);
        assert.deepEqual(manifest.tokenSemantics, raw.tokenSemantics);
        assert.deepEqual(manifest.operations, raw.operations);
        assert.deepEqual(manifest.source, raw.source);
        assert.deepEqual(manifest.modelAliases, raw.modelAliases);
        assert.equal(manifest.credentialEnv, raw.credentialEnv);
        assert.equal(Object.isFrozen(manifest), true, `${label}/${raw.id} manifest must be frozen`);
        assert.equal(JSON.stringify(manifest).includes('apiKey'), false);
      }
    }
  }
});

test('every built-in driver is detectable deterministically in every declared runtime', () => {
  for (const raw of BUILTINS) {
    for (const runtime of raw.match.runtimes) {
      for (const providerId of raw.match.providerIds) {
        // Only equivalent spellings belong here: `custom:` is an alternative prefix for
        // a bare id, not something that can be stacked on top of `custom_provider:`.
        const variants = providerId.startsWith('custom_') || providerId.startsWith('custom:')
          ? [providerId, providerId.toUpperCase()]
          : [providerId, providerId.toUpperCase(), `custom:${providerId}`];
        for (const variant of variants) {
          const cline = clineDriver.detectBuiltinProvider(variant, runtime);
          const mcode = mcodeDriver.detectBuiltinProvider(variant, runtime);
          assert.equal(cline?.id, raw.id, `cline must detect ${variant} as ${raw.id}`);
          assert.equal(mcode?.id, raw.id, `mcode must detect ${variant} as ${raw.id}`);
          assert.equal(cline.fingerprint, mcode.fingerprint, 'both adapters must detect the same driver bytes');
          assert.deepEqual(clineDriver.detectBuiltinProvider(variant, runtime), cline, 'detection must be deterministic');
          const explain = clineDiagnostics.explainProviderMatch({ providerId: variant, configuration: {}, runtimeId: runtime });
          assert.equal(explain.status, 'matched', `${variant} must explain as matched for ${runtime}`);
          assert.equal(explain.manifest.id, raw.id);
          assert.equal(explain.rule, variant === providerId ? 'exact-provider-id' : 'normalized-provider-id');
          assert.ok(raw.match.providerIds.includes(explain.matchedOn), `${variant} must report the declared provider id it matched on`);
          assert.equal(
            mcodeDriver.normalizeProviderId(explain.matchedOn),
            mcodeDriver.normalizeProviderId(variant),
            `${variant} must match the same normalized provider id it reports`,
          );
          if (variant === providerId) assert.equal(explain.matchedOn, providerId);
        }
      }
    }
  }
});

test('unknown providers and undeclared runtimes never resolve to a driver', () => {
  for (const runtime of RUNTIMES) {
    assert.equal(clineDriver.detectBuiltinProvider('not-a-real-provider', runtime), null);
    assert.equal(mcodeDriver.detectBuiltinProvider('not-a-real-provider', runtime), null);
    for (const diagnostics of [clineDiagnostics, mcodeDiagnostics]) {
      const match = diagnostics.explainProviderMatch({ providerId: 'not-a-real-provider', configuration: {}, runtimeId: runtime });
      assert.equal(match.status, 'unknown');
      assert.equal(match.manifest, null);
      assert.deepEqual(match.candidates, [...BUILTIN_IDS].sort());
    }
  }
  // A runtime no manifest declares must see an empty registry, not every driver.
  const foreign = mcodeDriver.createProviderRegistry(
    BUILTINS.map((manifest) => ({ manifest, handlers: Object.fromEntries(manifest.operations.map((name) => [name, () => null])) })),
    { runtimeId: 'not-a-runtime' },
  );
  assert.deepEqual(foreign.list(), []);
  assert.equal(foreign.resolve(BUILTIN_IDS[0]), null);
  assert.deepEqual(clineDiagnostics.discoverProviderManifests({}, 'not-a-runtime'), []);
});

test('driver diagnostics enumerate every built-in driver for both runtimes', () => {
  for (const runtime of RUNTIMES) {
    for (const [label, diagnostics] of [['cline', clineDiagnostics], ['mcode', mcodeDiagnostics]]) {
      const manifests = diagnostics.discoverProviderManifests({}, runtime);
      assert.deepEqual(manifests.map((manifest) => manifest.id), [...BUILTIN_IDS].sort(), `${label} must expose every built-in driver`);
      for (const manifest of manifests) {
        assert.equal(manifest.match.runtimes.includes(runtime), true);
        // Raw built-in manifests are not contract-shaped, so validate the detected one.
        const detected = mcodeDriver.detectBuiltinProvider(manifest.id, runtime);
        assert.deepEqual(validateJsonSchema(detected, driverSchema), [], `${label}/${manifest.id} must satisfy the driver schema`);
        assert.equal(detected.fingerprint.startsWith('sha256:'), true);
        assert.equal(detected.id, manifest.id);
        assert.deepEqual(detected.capabilities, manifest.capabilities);
      }
      const report = diagnostics.doctorReport({ configuration: null, runtimeId: runtime });
      assert.equal(report.runtime, runtime);
      assert.deepEqual(report.providers.map((provider) => provider.id), [...BUILTIN_IDS].sort());
      for (const provider of report.providers) {
        const manifest = BUILTINS.find((candidate) => candidate.id === provider.id);
        assert.deepEqual(provider.capabilities, manifest.capabilities);
        assert.equal(provider.version, manifest.version);
        assert.equal(provider.credentialEnv, null);
      }
      const rendered = diagnostics.renderDiagnostics({ ...report, action: 'providers' });
      assert.equal(rendered.split('\n').length, BUILTIN_IDS.length);
      for (const id of BUILTIN_IDS) assert.match(rendered, new RegExp(`^${id}@`, 'm'));
      const knownModels = Object.fromEntries(
        Object.entries(table.providers ?? {}).map(([providerId, entry]) => [providerId, Object.keys(entry.models ?? {})]),
      );
      const models = diagnostics.discoverModels({ configuration: {}, runtimeId: runtime, knownModels });
      assert.deepEqual(models.map((entry) => entry.provider), [...BUILTIN_IDS].sort());
      for (const entry of models) {
        const published = Object.keys(table.providers?.[entry.provider]?.models ?? {});
        assert.deepEqual(entry.models.map((model) => model.id).sort(), [...published].sort(), `${label}/${entry.provider} must surface every published model`);
        for (const model of entry.models) assert.deepEqual(model.aliases, [], 'built-in manifests declare no aliases');
      }
    }
  }
});

for (const manifest of BUILTINS) {
  const id = manifest.id;
  const capabilities = manifest.capabilities;

  test(`built-in ${id} honors its declared capabilities against the bundled rate table`, async () => {
    const driver = registry.resolve(id);
    assert.ok(driver, `${id} must be wired into the MCode provider registry`);
    assert.equal(driver.handlers.detect(), true, `${id} must detect its own provider`);
    const models = driver.handlers.listModels();
    const published = Object.keys(table.providers?.[id]?.models ?? {});
    const records = table.providers?.[id]?.rateRecords ?? [];
    const at = resolvedAt(id);

    if (capabilities.modelDiscovery) {
      assert.ok(models.length > 0, `${id} advertises model discovery, so it must list published models`);
      assert.deepEqual(models.map((model) => model.id).sort(), [...published].sort());
      for (const model of models) {
        assert.equal(model.provider, id);
        assert.ok(model.name, `${id}/${model.id} must carry a display name`);
      }
    } else {
      assert.deepEqual(models, [], `${id} must refuse model discovery instead of inventing models`);
      assert.deepEqual(published, [], `${id} publishes no models, so discovery has nothing to list`);
    }

    assert.equal(
      driver.manifest.operations.includes('fetchRates'),
      capabilities.rateRetrieval === 'network',
      `${id} must declare fetchRates exactly when it can retrieve rates from the network`,
    );
    if (capabilities.rateRetrieval === 'network') {
      await assert.rejects(
        () => driver.handlers.fetchRates({}),
        /ratesPath is required/,
        `${id}/fetchRates must be the real table refresher and must fail offline without a target`,
      );
    } else {
      assert.equal(driver.handlers.fetchRates, undefined, `${id} must not expose an unused rate fetcher`);
    }

    for (const component of capabilities.supportedComponents) {
      assert.ok(RATE_COMPONENTS.includes(component), `${id} declares unsupported component ${component}`);
    }
    for (const model of models) {
      const resolved = resolveWithProviderDriver(registry, { provider: id, model: model.id, at, contextTokens: 1_000 });
      assert.equal(resolved.providerDriver.id, id);
      assert.equal(resolved.resolvedModel, model.id);
      assert.equal(resolved.coverage, 'complete', `${id}/${model.id} must price every published model offline`);
      assert.deepEqual(resolved.missingComponents, []);
      for (const component of capabilities.supportedComponents) {
        assert.ok(Number.isFinite(resolved.rate[component]) && resolved.rate[component] >= 0, `${id}/${model.id}/${component} must be a real rate`);
      }
      for (const component of RATE_COMPONENTS.filter((name) => !capabilities.supportedComponents.includes(name))) {
        assert.equal(resolved.rate[component], undefined, `${id} must not price the unsupported ${component} component`);
      }
      assert.deepEqual(resolved.rate.rateRecords.map((record) => record.component).sort(), [...capabilities.supportedComponents].sort());
      if (capabilities.effectiveDates) {
        assert.deepEqual(resolved.rate.effectiveFrom, resolved.rate.rateRecords[0].effectiveFrom);
        assert.equal(resolved.rate.fingerprint.startsWith('sha256:'), true);
        for (const record of resolved.rate.rateRecords) {
          assert.ok(Number.isFinite(Date.parse(record.effectiveFrom)), `${id}/${model.id} records must carry a real effective date`);
          const through = record.effectiveThrough ? Date.parse(record.effectiveThrough) : Infinity;
          assert.ok(Date.parse(record.effectiveFrom) <= Date.parse(at) && Date.parse(at) < through, `${id}/${model.id}/${record.component} must be in force at the requested time`);
        }
      }
      if (!capabilities.timeBands) {
        assert.equal(resolved.timeBand, 'flat', `${id} publishes no time bands, so resolution must stay flat`);
        assert.deepEqual([...new Set(resolved.rate.rateRecords.map((record) => record.timeBand))], ['flat']);
      }
      if (!capabilities.contextTiers) {
        for (const record of resolved.rate.rateRecords) {
          assert.deepEqual(record.context, { minTokens: 0, maxTokens: null }, `${id} publishes no context tiers`);
        }
      }
    }

    if (capabilities.timeBands && models.length > 0) {
      const banded = models.filter((model) => Boolean(table.providers[id].models[model.id]?.timeOfDay));
      assert.ok(banded.length > 0, `${id} advertises time bands, so the table must publish banded models`);
      for (const model of banded) {
        const peak = resolveWithProviderDriver(registry, { provider: id, model: model.id, at: weekdayAt(id, 2), contextTokens: 1_000 });
        const offPeak = resolveWithProviderDriver(registry, { provider: id, model: model.id, at: weekdayAt(id, 13), contextTokens: 1_000 });
        assert.equal(peak.timeBand, 'peak');
        assert.equal(offPeak.timeBand, 'offPeak');
        assert.equal(peak.coverage, 'complete');
        assert.equal(offPeak.coverage, 'complete');
        assert.deepEqual([...new Set(peak.rate.rateRecords.map((record) => record.timeBand))], ['peak']);
        assert.deepEqual([...new Set(offPeak.rate.rateRecords.map((record) => record.timeBand))], ['offPeak']);
        assert.notDeepEqual(peak.rate.rateRecords.map((record) => record.amount), offPeak.rate.rateRecords.map((record) => record.amount));
        assert.ok(
          capabilities.supportedComponents.some((component) => peak.rate[component] > offPeak.rate[component]),
          `${id}/${model.id} peak pricing must exceed off-peak pricing`,
        );
      }
    }

    if (capabilities.contextTiers && models.length > 0) {
      const tiered = models.filter((model) => (table.providers[id].models[model.id]?.contextTiers?.length ?? 0) > 1);
      assert.ok(tiered.length > 0, `${id} advertises context tiers, so the table must publish tiered models`);
      for (const model of tiered) {
        const declared = table.providers[id].models[model.id].contextTiers;
        const ranges = declared.map((tier, index) => ({
          minTokens: index === 0 ? 0 : declared[index - 1].maxContext + 1,
          maxTokens: Number.isInteger(tier.maxContext) ? tier.maxContext : null,
        }));
        const at_ = (contextTokens) => resolveWithProviderDriver(registry, { provider: id, model: model.id, at, contextTokens });
        const first = at_(1_000);
        const last = at_(ranges.at(-1).minTokens);
        assert.equal(first.coverage, 'complete', `${id}/${model.id} lowest tier must price offline`);
        assert.equal(last.coverage, 'complete', `${id}/${model.id} highest tier must price offline`);
        assert.notDeepEqual(first.rate.rateRecords.map((record) => record.amount), last.rate.rateRecords.map((record) => record.amount), `${id}/${model.id} tiers must change the selected rate`);
        // Every published boundary belongs to the lower tier, and one token past it
        // moves the selection into the next tier.
        for (const [index, range] of ranges.entries()) {
          if (range.maxTokens === null) break;
          const onBoundary = at_(range.maxTokens);
          const aboveBoundary = at_(range.maxTokens + 1);
          assert.deepEqual(onBoundary.rate.rateRecords.map((record) => record.context), Array(capabilities.supportedComponents.length).fill(range), `${id}/${model.id} the ${range.maxTokens} boundary belongs to the lower tier`);
          assert.deepEqual(aboveBoundary.rate.rateRecords.map((record) => record.context), Array(capabilities.supportedComponents.length).fill(ranges[index + 1]), `${id}/${model.id} one token past ${range.maxTokens} must select the next tier`);
          assert.equal(onBoundary.coverage, 'complete');
          assert.equal(aboveBoundary.coverage, 'complete');
        }
        for (const resolved of [first, last, at_(ranges[0].maxTokens)]) {
          for (const record of resolved.rate.rateRecords) {
            assert.equal(resolved.contextTokens >= record.context.minTokens, true, `${id}/${model.id} selected record must start at or below the requested context`);
            assert.equal(record.context.maxTokens === null || resolved.contextTokens <= record.context.maxTokens, true, `${id}/${model.id} selected record must cover the requested context`);
          }
        }
      }
    }

    if (capabilities.effectiveDates && models.length > 0) {
      const earliest = records.map((record) => record.effectiveFrom).sort()[0];
      const before = new Date(Date.parse(earliest) - 86_400_000).toISOString();
      for (const model of models) {
        const resolved = resolveWithProviderDriver(registry, { provider: id, model: model.id, at: before, contextTokens: 0 });
        assert.equal(resolved.rate, null, `${id}/${model.id} must not invent a rate effective before ${earliest}`);
        assert.notEqual(resolved.coverage, 'complete');
        assert.deepEqual([...resolved.missingComponents].sort(), [...capabilities.supportedComponents].sort());
      }
    }
    if (models.length === 0) {
      // A driver with no bundled table takes every rate from a configured profile,
      // so the loop above is vacuous; the banded and tiered profile fixtures below
      // cover its declared time-band and context-tier capabilities instead.
      assert.equal(capabilities.rateRetrieval, 'manual', `${id} has no bundled rates, so it must take them from configuration`);
      assert.deepEqual(records, [], `${id} must not ship bundled rate records it cannot publish`);
    }
  });

  test(`built-in ${id} refuses unsupported operations and unknown targets explicitly`, () => {
    const driver = registry.resolve(id);
    for (const operation of OPERATION_NAMES) {
      const declared = driver.manifest.operations.includes(operation);
      assert.equal(typeof driver.handlers[operation] === 'function', declared, `${id}/${operation} must be wired exactly when the manifest declares it`);
      if (declared) continue;
      assert.throws(() => driver.handlers[operation]({}), TypeError, `${id} must refuse the undeclared ${operation} operation instead of ignoring it`);
    }
    if (capabilities.pricing === 'none') {
      assert.equal(driver.manifest.operations.includes('resolveRate'), false, `${id} cannot price, so it must not expose resolveRate`);
    }
    if (!capabilities.modelDiscovery) {
      assert.deepEqual(driver.handlers.listModels(), [], `${id} must refuse model discovery explicitly`);
    }
    const at = resolvedAt(id);
    const unknownModel = resolveWithProviderDriver(registry, { provider: id, model: 'offline-fixture-missing-model', at });
    assert.equal(unknownModel.rate, null, `${id} must not price an unknown model as free`);
    assert.equal(unknownModel.coverage, 'unavailable');
    assert.deepEqual([...unknownModel.missingComponents].sort(), [...capabilities.supportedComponents].sort());
    assert.equal(unknownModel.resolvedModel, 'offline-fixture-missing-model');
    assert.equal(unknownModel.providerDriver.id, id);
    const unknownProvider = resolveWithProviderDriver(registry, { provider: 'offline-fixture-missing-provider', model: 'x', at });
    assert.equal(unknownProvider.providerDriver, null);
    assert.equal(unknownProvider.rate, null);
    assert.equal(unknownProvider.coverage, 'unavailable');
    assert.deepEqual(unknownProvider.missingComponents, RATE_COMPONENTS);
  });
}

test('every generic protocol driver ships offline usage, stream, and pricing fixtures', () => {
  assert.deepEqual(Object.keys(USAGE_FIXTURES).sort(), [...PROTOCOL_DRIVER_IDS].sort());
  assert.deepEqual(Object.keys(STREAM_FIXTURES).sort(), [...PROTOCOL_DRIVER_IDS].sort());
  assert.deepEqual(Object.keys(RAW_INPUT_EXCLUDES_CACHE).sort(), [...PROTOCOL_DRIVER_IDS].sort());
  for (const id of PROTOCOL_DRIVER_IDS) {
    const fixtures = USAGE_FIXTURES[id];
    assert.ok(fixtures.length >= 2, `${id} needs at least a complete and a cache-free usage payload`);
    assert.equal(new Set(fixtures.map((fixture) => fixture.name)).size, fixtures.length, `${id} usage fixture names must be unique`);
    assert.ok(fixtures.some((fixture) => fixture.expected.coverage === 'complete'), `${id} needs one complete usage payload`);
    assert.ok(fixtures.some((fixture) => fixture.expected.missingComponents.length > 0), `${id} needs one payload with missing cache data`);
    assert.ok(fixtures.some((fixture) => fixture.expected.cacheReadTokens === 0), `${id} needs one payload with an explicit zero cache read`);
    for (const fixture of fixtures) {
      for (const field of NORMALIZED_USAGE_KEYS) {
        assert.ok(Object.hasOwn(fixture.expected, field), `${id}/${fixture.name} must declare an expectation for ${field}`);
      }
    }
    assert.ok(STREAM_FIXTURES[id].length >= 1, `${id} needs an offline stream fixture`);
  }
  // The generated offline configuration is itself a valid session configuration.
  assert.deepEqual(validateJsonSchema(vendorConfiguration(), configSchema), []);
});

for (const manifest of BUILTINS.filter((candidate) => candidate.source.kind === 'protocol')) {
  const id = manifest.id;
  const semantics = manifest.tokenSemantics;

  test(`generic ${id} normalizes complete and cache-free usage without inventing cache data`, () => {
    const driver = registry.resolve(id);
    const normalize = driver.handlers.normalizeUsage;
    assert.equal(normalize, mcodeProtocol.PROTOCOL_ADAPTERS[id].normalizeUsage, `${id} must expose the shared protocol normalizer`);
    assert.equal(semantics.inputIncludesCache, false, `${id} fixture expectations assume input excludes cache`);
    for (const fixture of USAGE_FIXTURES[id]) {
      const normalized = normalize(fixture.payload);
      for (const field of NORMALIZED_USAGE_FIELDS) {
        assert.equal(normalized[field], fixture.expected[field], `${id}/${fixture.name}/${field} must match the declared token semantics`);
        if (normalized[field] !== null) {
          assert.equal(Number.isFinite(normalized[field]) && normalized[field] >= 0, true, `${id}/${fixture.name}/${field} must be a real token count or an explicit null`);
        }
      }
      assert.equal(normalized.coverage, fixture.expected.coverage, `${id}/${fixture.name} coverage must follow the missing components`);
      assert.deepEqual(normalized.missingComponents, fixture.expected.missingComponents, `${id}/${fixture.name} must name every unknown component`);
      if (normalized.missingComponents.length === 0) assert.equal(normalized.coverage, 'complete');
      else assert.notEqual(normalized.coverage, 'complete', `${id}/${fixture.name} must never claim complete coverage with gaps`);
      // An unknown component is always enumerated; a known zero never is.
      for (const field of CACHE_FIELDS) {
        assert.equal(normalized[field] === null, normalized.missingComponents.includes(field), `${id}/${fixture.name}/${field} must be listed exactly when it is unknown`);
      }
      // The driver may not add fields that were never measured.
      assert.deepEqual(Object.keys(normalized).sort(), [...NORMALIZED_USAGE_KEYS].sort());

      const raw = fixture.payload.usage?.prompt_tokens ?? fixture.payload.usage?.input_tokens ?? fixture.payload.input_tokens;
      if (Number.isFinite(raw)) {
        if (RAW_INPUT_EXCLUDES_CACHE[id]) {
          assert.equal(normalized.inputTokens, raw, `${id}/${fixture.name} raw input already excludes cache and must pass through untouched`);
        } else {
          assert.equal(normalized.inputTokens, Math.max(0, raw - (normalized.cacheReadTokens ?? 0)), `${id}/${fixture.name} input must exclude cache reads and never go negative`);
        }
      }
      const reasoning = fixture.payload.usage?.completion_tokens_details?.reasoning_tokens;
      if (semantics.reasoningIncludedInOutput === true) {
        assert.equal(normalized.reasoningTokens, Number.isFinite(reasoning) ? reasoning : null, `${id}/${fixture.name} must report reasoning only when the payload does`);
        if (normalized.reasoningTokens !== null) {
          assert.ok(normalized.reasoningTokens <= normalized.outputTokens, `${id}/${fixture.name} reasoning must be part of the output total`);
        }
      } else if (semantics.reasoningIncludedInOutput === false) {
        assert.equal(normalized.reasoningTokens, null, `${id} must never invent reasoning tokens`);
      }
    }
  });

  test(`generic ${id} prices offline usage from manual cards and keeps unknown cache data unknown`, () => {
    const resolved = vendorResolution(id);
    assert.equal(resolved.providerDriver.id, `offline-${id}`);
    assert.equal(resolved.resolvedModel, CARD.model, `${id} must resolve the vendor model onto its rate card`);
    assert.equal(resolved.coverage, 'complete');
    assert.deepEqual(resolved.missingComponents, []);
    for (const component of manifest.capabilities.supportedComponents) {
      assert.equal(resolved.rate[component], CARD[component], `${id} must price ${component} from the offline card`);
    }
    assert.equal(resolved.rate.currency, 'USD');
    assert.equal(resolved.rate.region, 'offline-region');
    assert.equal(resolved.rate.endpointEnv, 'OFFLINE_VENDOR_BASE_URL');
    assert.equal(resolved.rate.credentialEnv, 'OFFLINE_VENDOR_API_KEY');
    assert.deepEqual(resolved.rate.rateRecords.map((record) => record.component).sort(), [...manifest.capabilities.supportedComponents].sort());
    assert.deepEqual(
      vendorRegistry(id).resolve(`offline-${id}`).handlers.listModels().map((model) => model.id),
      [CARD.model],
      `${id} must discover exactly the models it can price`,
    );

    const normalize = registry.resolve(id).handlers.normalizeUsage;
    for (const fixture of USAGE_FIXTURES[id]) {
      const usage = normalize(fixture.payload);
      const cost = calculateTokenCost(usage, resolved.rate);
      for (const component of RATE_COMPONENTS) {
        const tokens = usage[`${component}Tokens`] ?? 0;
        assert.equal(cost[component], tokens / 1_000_000 * CARD[component], `${id}/${fixture.name}/${component} must cost the offline card rate`);
      }
      // A missing cache component costs nothing because the token count is unknown,
      // never because the driver replaced a real rate with zero.
      for (const field of CACHE_FIELDS) {
        if (usage[field] !== null) continue;
        const component = field.replace('Tokens', '');
        assert.ok(CARD[component] > 0, `${id} must keep a real ${component} rate even when the count is unknown`);
        assert.equal(cost[component], 0, `${id}/${fixture.name} must not invent ${component} tokens`);
      }
      const total = Object.values(cost).reduce((sum, value) => sum + value, 0);
      if (usage.coverage === 'complete') assert.ok(total > 0, `${id}/${fixture.name} must produce a positive offline estimate`);
    }
  });

  test(`generic ${id} parses its offline stream fixture`, () => {
    const parseStream = registry.resolve(id).handlers.parseStream;
    assert.equal(parseStream, mcodeProtocol.PROTOCOL_ADAPTERS[id].parseStream, `${id} must expose the shared stream parser`);
    for (const fixture of STREAM_FIXTURES[id]) {
      const parsed = parseStream(fixture.text);
      assert.equal(parsed.protocol, fixture.expected.protocol);
      assert.equal(parsed.model, fixture.expected.model, `${id}/${fixture.name} must recover the streamed model`);
      assert.equal(parsed.events.length, fixture.expected.eventCount, `${id}/${fixture.name} must collect every data event exactly once`);
      assert.deepEqual(Object.keys(parsed).sort(), ['events', 'model', 'normalizedUsage', 'protocol', 'usage'].sort());
      for (const field of NORMALIZED_USAGE_FIELDS) {
        assert.equal(parsed.normalizedUsage[field], fixture.expected[field], `${id}/${fixture.name}/${field} must come from the streamed usage`);
      }
      assert.equal(parsed.normalizedUsage.coverage, 'complete', `${id}/${fixture.name} must reach complete coverage`);
    }
  });
}

test('both adapters normalize and parse every generic protocol fixture identically', () => {
  for (const id of PROTOCOL_DRIVER_IDS) {
    for (const fixture of USAGE_FIXTURES[id]) {
      const mcode = registry.resolve(id).handlers.normalizeUsage(fixture.payload);
      assert.deepEqual(clineProtocol.PROTOCOL_ADAPTERS[id].normalizeUsage(fixture.payload), mcode, `${id}/${fixture.name} must normalize identically in both adapters`);
      assert.deepEqual(mcodeProtocol.PROTOCOL_ADAPTERS[id].normalizeUsage(fixture.payload), mcode, `${id}/${fixture.name} must match the shared protocol registry`);
    }
    for (const fixture of STREAM_FIXTURES[id]) {
      assert.deepEqual(
        clineProtocol.PROTOCOL_ADAPTERS[id].parseStream(fixture.text),
        mcodeProtocol.PROTOCOL_ADAPTERS[id].parseStream(fixture.text),
        `${id}/${fixture.name} must parse identically in both adapters`,
      );
    }
  }
});

// ---------------------------------------------------------------------------
// Configured-profile capability fixtures, followed by three REAL BUGS found while
// writing them. Each failing test carries a comment naming the driver, the code
// path, and the observed behaviour. Nothing here is skipped or focused, so the
// failures stay loud until the driver is fixed.
// ---------------------------------------------------------------------------

const BANDED_MODEL = 'vendor-banded-model';
const TIERED_MODEL = 'vendor-tiered-model';
const TIER_BOUNDARY = 100_000;
const CARD_COMPONENTS = { input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 };
// 2026-06-01 is a Monday, 02:00 UTC is inside the published 01-04 & 06-10 window.
const PEAK_AT = '2026-06-01T02:00:00.000Z';
const OFF_PEAK_AT = '2026-06-01T13:00:00.000Z';

function profileRegistry(driverId, rateCards, profileOverrides) {
  return createMCodeProviderRegistry(table, {
    profiles: [{
      id: `offline-${driverId}`,
      driverId,
      match: { providerIds: [`offline-${driverId}`], runtimes: ['mcode'] },
      currency: 'USD',
      pricingMode: 'manual',
      rateCards,
      ...profileOverrides,
    }],
  });
}

function profileResolution(driverId, model, extra) {
  return resolveWithProviderDriver(profileRegistry(driverId, extra.rateCards, extra.profile), {
    provider: `offline-${driverId}`,
    model,
    ...extra.context,
  });
}

for (const manifest of BUILTINS.filter((candidate) => candidate.capabilities.contextTiers)) {
  const id = manifest.id;
  const cards = [
    { model: TIERED_MODEL, effectiveFrom: '2026-01-01T00:00:00.000Z', context: { minTokens: 0, maxTokens: TIER_BOUNDARY }, ...CARD_COMPONENTS },
    { model: TIERED_MODEL, effectiveFrom: '2026-01-01T00:00:00.000Z', context: { minTokens: TIER_BOUNDARY + 1, maxTokens: null }, input: 2, output: 6, cacheRead: 0.2, cacheWrite: 2 },
  ];

  test(`${id} selects the configured context tier that contains the requested context`, () => {
    const resolve = (at, contextTokens) => profileResolution(id, TIERED_MODEL, { rateCards: cards, context: { at, contextTokens } });
    const low = resolve('2026-06-01T13:00:00.000Z', 1_000);
    const onBoundary = resolve('2026-06-01T13:00:00.000Z', TIER_BOUNDARY);
    const high = resolve('2026-06-01T13:00:00.000Z', TIER_BOUNDARY + 1);
    for (const resolved of [low, onBoundary, high]) {
      assert.equal(resolved.coverage, 'complete', `${id} must price a configured tier offline`);
      assert.equal(resolved.rate.input, resolved.contextTokens > TIER_BOUNDARY ? 2 : 1, `${id} must select the configured tier rate`);
      assert.equal(resolved.timeBand, 'flat', `${id} configured flat cards must stay flat`);
    }
    assert.deepEqual(low.rate.rateRecords.map((record) => record.context), Array(manifest.capabilities.supportedComponents.length).fill({ minTokens: 0, maxTokens: TIER_BOUNDARY }));
    assert.deepEqual(onBoundary.rate.rateRecords.map((record) => record.context), Array(manifest.capabilities.supportedComponents.length).fill({ minTokens: 0, maxTokens: TIER_BOUNDARY }), `${id} the boundary itself belongs to the lower tier`);
    assert.deepEqual(high.rate.rateRecords.map((record) => record.context), Array(manifest.capabilities.supportedComponents.length).fill({ minTokens: TIER_BOUNDARY + 1, maxTokens: null }), `${id} one token past the boundary must select the higher tier`);
    // A timestamp before the card is effective must be refused, not priced.
    const early = resolve('2025-12-31T00:00:00.000Z', 1_000);
    assert.equal(early.rate, null);
    assert.equal(early.coverage, 'unavailable');
    assert.deepEqual([...early.missingComponents].sort(), [...manifest.capabilities.supportedComponents].sort());
  });
}

// REAL BUG: every provider profile silently resolves its time band as `offPeak`
// when the caller passes the ISO-8601 `at` string that the same public API
// accepts for the bundled rate table.
//
//   adapters/mcode/skill/scripts/lib/provider-drivers.mjs, resolveProfileRate:
//     const timeBand = knownBands.has('flat')
//       ? 'flat'
//       : bandForTimestamp(context.at, { timeOfDay: {} });     <-- raw value
//     const timestamp = typeof context.at === 'string' ? Date.parse(context.at) : Number(context.at ?? Date.now());
//
// bandForTimestamp() does `new Date(Number(timestamp))`, so an ISO string becomes
// NaN, getUTCDay() is NaN, and the band collapses to `offPeak` for every call.
// rates.mjs resolveRate() parses `at` before banding, so the bundled and profile
// paths disagree for the same input shape. A configured `timeBand: 'peak'` card
// can therefore never be selected through an ISO timestamp: peak traffic is
// priced at the off-peak rate with no error and no warning.
test('every driver that declares time bands prices a configured peak window identically for both at shapes', () => {
  const bandedDrivers = BUILTINS.filter((manifest) => manifest.capabilities.timeBands);
  assert.ok(bandedDrivers.length > 0, 'at least one built-in driver must declare time bands');
  const cards = (model) => [
    { model, effectiveFrom: '2026-01-01T00:00:00.000Z', timeBand: 'peak', input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 },
    { model, effectiveFrom: '2026-01-01T00:00:00.000Z', timeBand: 'offPeak', input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
  ];
  // The profile declares its own peak calendar, which is what makes the band knowable.
  const policy = { timeOfDay: { peak: [[1, 4], [6, 10]], offPeak: [[0, 24]] } };
  const observed = {};
  for (const manifest of bandedDrivers) {
    const id = manifest.id;
    const price = (at, overrides) => profileResolution(id, BANDED_MODEL, { rateCards: cards(BANDED_MODEL), profile: overrides, context: { at, contextTokens: 1_000 } });
    const fromIsoString = price(PEAK_AT, policy);
    const fromEpochMilliseconds = price(Date.parse(PEAK_AT), policy);
    const offPeakFromIsoString = price(OFF_PEAK_AT, policy);
    assert.equal(fromEpochMilliseconds.timeBand, 'peak', `${id} must select the peak card for an epoch-millisecond timestamp`);
    assert.equal(fromEpochMilliseconds.rate.input, 3, `${id} must price the peak card for an epoch-millisecond timestamp`);
    assert.equal(fromEpochMilliseconds.coverage, 'complete', `${id} must price the peak window offline`);
    observed[id] = {
      peakFromIsoString: { timeBand: fromIsoString.timeBand, input: fromIsoString.rate?.input ?? null },
      peakFromEpochMilliseconds: { timeBand: fromEpochMilliseconds.timeBand, input: fromEpochMilliseconds.rate?.input ?? null },
      offPeakFromIsoString: { timeBand: offPeakFromIsoString.timeBand, input: offPeakFromIsoString.rate?.input ?? null },
    };
  }
  const expected = Object.fromEntries(bandedDrivers.map((manifest) => [manifest.id, {
    peakFromIsoString: { timeBand: 'peak', input: 3 },
    peakFromEpochMilliseconds: { timeBand: 'peak', input: 3 },
    offPeakFromIsoString: { timeBand: 'offPeak', input: 1 },
  }]));
  assert.deepEqual(observed, expected, 'an ISO-8601 `at` must price the same window an epoch-millisecond `at` prices');
});

test('a profile with banded records and no declared calendar is unpriced, not guessed', () => {
  // Borrowing another provider's peak window produced a plausible number that silently
  // under-reported cost. The band is unknowable here, so the tool must say so.
  for (const manifest of BUILTINS.filter((candidate) => candidate.capabilities.timeBands)) {
    const resolution = profileResolution(manifest.id, BANDED_MODEL, {
      rateCards: [
        { model: BANDED_MODEL, effectiveFrom: '2026-01-01T00:00:00.000Z', timeBand: 'peak', input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 },
        { model: BANDED_MODEL, effectiveFrom: '2026-01-01T00:00:00.000Z', timeBand: 'offPeak', input: 1, output: 3, cacheRead: 0.1, cacheWrite: 1 },
      ],
      context: { at: PEAK_AT, contextTokens: 1_000 },
    });
    assert.equal(resolution.coverage, 'unavailable', `${manifest.id} must not price an unknowable band`);
    assert.equal(resolution.rate, null, `${manifest.id} must not invent a rate`);
    assert.equal(resolution.timeBand, null);
  }
});

test('a profile whose records declare a single band prices without a calendar', () => {
  const flatOnly = [{ model: BANDED_MODEL, effectiveFrom: '2026-01-01T00:00:00.000Z', timeBand: 'peak', input: 3, output: 9, cacheRead: 0.3, cacheWrite: 3 }];
  for (const manifest of BUILTINS.filter((candidate) => candidate.capabilities.timeBands)) {
    const resolution = profileResolution(manifest.id, BANDED_MODEL, {
      rateCards: flatOnly,
      context: { at: OFF_PEAK_AT, contextTokens: 1_000 },
    });
    assert.equal(resolution.timeBand, 'peak', `${manifest.id} must use the only band its records declare`);
    assert.equal(resolution.coverage, 'complete');
  }
});

// REAL BUG: the anthropic-compatible driver's `parseStream` handler cannot read
// the wire format its own manifest cites.
//
//   shared/protocol-adapters.mjs, parseAnthropicCompatibleStream:
//     for (const line of String(text).split(/\r?\n/)) {
//       const trimmed = line.trim();
//       if (!trimmed) continue;
//       const event = JSON.parse(trimmed);            <-- no SSE framing
//
// The driver declares `source.url: "https://docs.anthropic.com/en/api/messages"`
// and the `parseStream` operation, and that endpoint streams server-sent events
// as `event: <name>` / `data: <json>` pairs. Only a bare JSON-lines transcript
// parses; a real Messages API stream throws
// `SyntaxError: Unexpected token 'e', "event: message_start" is not valid JSON`
// instead of returning normalized usage. parseOpenAICompatibleStream strips the
// `data:` prefix and honours `[DONE]`, so the two protocol drivers disagree
// about the framing of the very thing they are named after.
test('generic anthropic-compatible parses a real Messages API server-sent-event stream', () => {
  const driver = registry.resolve('anthropic-compatible');
  assert.ok(driver.manifest.operations.includes('parseStream'), 'the driver must declare parseStream');
  assert.equal(
    driver.manifest.source.url,
    'https://docs.anthropic.com/en/api/messages',
    'the driver must still cite the Messages API it parses',
  );
  const text = [
    'event: message_start',
    'data: {"type":"message_start","message":{"id":"msg_fixture","type":"message","role":"assistant","model":"vendor-claude","content":[],"stop_reason":null,"usage":{"input_tokens":120,"cache_creation_input_tokens":20,"cache_read_input_tokens":40,"output_tokens":1}}}',
    '',
    'event: ping',
    'data: {"type": "ping"}',
    '',
    'event: content_block_delta',
    'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"hi"}}',
    '',
    'event: message_delta',
    'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":250}}',
    '',
    'event: message_stop',
    'data: {"type":"message_stop"}',
    '',
  ].join('\n');
  const parsed = driver.handlers.parseStream(text);
  assert.equal(parsed.protocol, 'anthropic-compatible');
  assert.equal(parsed.model, 'vendor-claude');
  assert.equal(parsed.events.length, 5, 'every data event must be collected exactly once');
  assert.equal(parsed.normalizedUsage.inputTokens, 120);
  assert.equal(parsed.normalizedUsage.outputTokens, 250, 'the final usage delta must win');
  assert.equal(parsed.normalizedUsage.cacheReadTokens, 40);
  assert.equal(parsed.normalizedUsage.cacheWriteTokens, 20);
  assert.equal(parsed.normalizedUsage.coverage, 'complete');
  assert.deepEqual(parsed.normalizedUsage.missingComponents, []);
});

// REAL BUG: the built-in driver manifests are surfaced to users without their
// contract fingerprint.
//
//   shared/provider-diagnostics.mjs, discoverProviderManifests returns the raw
//   BUILTIN_PROVIDER_MANIFESTS entries, which never pass through
//   defineProviderDriver, so `manifest.fingerprint` is undefined; doctorReport
//   copies that undefined value into every provider entry.
//
// docs/provider-drivers.md states that `doctor --json` lists each driver with
// `id`, `version`, `fingerprint`, `match`, `capabilities`, and `credentialEnv`,
// and contracts/provider-driver-v1.schema.json requires `fingerprint` on every
// driver manifest. In practice `session-cost.mjs providers --json` and
// `doctor --json` emit `id, version, match, capabilities, credentialEnv` and drop
// the fingerprint entirely for all four built-in drivers, so driver identity is
// not reproducible from the diagnostics output. Configured profiles go through
// defineProviderDriver and do carry a fingerprint, which is why only the built-ins
// are affected.
test('built-in driver diagnostics report the fingerprint the driver contract requires', () => {
  for (const runtime of RUNTIMES) {
    for (const [label, diagnostics] of [['cline', clineDiagnostics], ['mcode', mcodeDiagnostics]]) {
      const report = diagnostics.doctorReport({ configuration: null, runtimeId: runtime });
      const serialized = JSON.parse(JSON.stringify(report));
      for (const provider of report.providers) {
        assert.match(
          provider.fingerprint ?? '',
          /^sha256:[a-f0-9]{64}$/,
          `${label}/${provider.id} must report the manifest fingerprint required by provider-driver-v1`,
        );
        assert.equal(
          provider.fingerprint,
          mcodeDriver.detectBuiltinProvider(provider.id, runtime).fingerprint,
          `${label}/${provider.id} must report the same fingerprint the pricing path uses`,
        );
      }
      for (const provider of serialized.providers) {
        assert.ok(Object.hasOwn(provider, 'fingerprint'), `${label}/${provider.id} fingerprint must survive JSON serialization`);
      }
    }
  }
});

// Every driver owns model resolution, so each one is exercised with the same
// offline alias/normalization fixtures rather than only through CommandCode.
for (const manifest of BUILTINS) {
  const id = manifest.id;

  test(`built-in ${id} resolves model ids by the documented exact, alias, and normalized rules`, () => {
    const driver = vendorRegistry(id).resolve(`offline-${id}`);
    assert.ok(driver, `${id} must accept a configured profile`);
    assert.deepEqual(
      driver.manifest.modelAliases,
      { [VENDOR_RUNTIME_MODEL]: CARD.model, [VENDOR_LOWERCASE_MODEL]: CARD.model },
      `${id} must carry every configured alias`,
    );
    const knownModelIds = [CARD.model];
    const cases = [
      [CARD.model, 'exact-rate-model'],
      [VENDOR_RUNTIME_MODEL, 'exact-alias'],
      [VENDOR_LOWERCASE_MODEL, 'exact-alias'],
      [CARD.model.toUpperCase(), 'normalized-rate-model'],
      [`vendor/${CARD.model}`, 'normalized-rate-model'],
      [VENDOR_RUNTIME_MODEL.toUpperCase(), 'normalized-alias'],
    ];
    for (const [modelId, rule] of cases) {
      const match = mcodeDriver.resolveDriverModelMatch(driver, modelId, { knownModelIds });
      assert.equal(match.status, 'matched', `${id}/${modelId} must resolve to the rate model`);
      assert.equal(match.rule, rule, `${id}/${modelId} must be reported with the documented rule`);
      assert.equal(match.modelId, CARD.model);
      if (rule === 'exact-alias') assert.equal(match.alias, modelId, `${id}/${modelId} must report the exact alias that matched`);
      if (rule === 'normalized-alias') assert.ok(Object.keys(driver.manifest.modelAliases).includes(match.alias), `${id}/${modelId} must report a declared alias`);
      assert.equal(mcodeDriver.resolveDriverModel(driver, modelId, { knownModelIds }), CARD.model, `${id}/${modelId} must resolve deterministically`);
    }
    const unknown = mcodeDriver.resolveDriverModelMatch(driver, `${CARD.model}-typo`, { knownModelIds });
    assert.equal(unknown.status, 'unknown', `${id} must never guess a model`);
    assert.equal(unknown.modelId, `${CARD.model}-typo`, `${id} must report the unresolved model unchanged`);
    assert.deepEqual(unknown.candidates, []);
    // The unresolved model must still be reported, not silently priced.
    const unresolved = resolveWithProviderDriver(vendorRegistry(id), {
      provider: `offline-${id}`,
      model: `${CARD.model}-typo`,
      at: CARD_AT,
      contextTokens: 1_000,
    });
    assert.equal(unresolved.resolvedModel, `${CARD.model}-typo`);
    assert.equal(unresolved.rate, null);
    assert.equal(unresolved.coverage, 'unavailable');
  });
}
