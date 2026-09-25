import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  BUILTIN_PROVIDER_MANIFESTS,
  createProviderRegistry,
  defineProviderDriver,
  detectBuiltinProvider,
  loadProviderDrivers,
  resolveDriverModel,
} from '../adapters/mcode/skill/scripts/lib/provider-driver.mjs';
import { createMCodeProviderRegistry, resolveWithProviderDriver } from '../adapters/mcode/skill/scripts/lib/provider-drivers.mjs';
import { readRateTable } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../contracts/provider-driver-v1.schema.json', import.meta.url), 'utf8'));
const table = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));

test('built-in provider manifests satisfy the formal driver schema', () => {
  for (const raw of BUILTIN_PROVIDER_MANIFESTS) {
    const manifest = detectBuiltinProvider(raw.id, 'mcode');
    assert.deepEqual(validateJsonSchema(manifest, schema), []);
    assert.match(manifest.fingerprint, /^sha256:/);
  }
});

test('one provider fixture resolves consistently in Cline and MCode', () => {
  const clineDriver = detectBuiltinProvider('commandcode', 'cline');
  const registry = createMCodeProviderRegistry(table);
  const resolved = resolveWithProviderDriver(registry, {
    provider: 'custom_provider:commandcode',
    model: 'qwen-3.7-plus',
    at: '2026-09-26T00:00:00.000Z',
    contextTokens: 1_000,
  });
  assert.equal(resolved.providerDriver.id, clineDriver.id);
  assert.equal(resolved.providerDriver.fingerprint, clineDriver.fingerprint);
  assert.equal(resolved.rate.input, 0.4);
  assert.equal(resolved.rate.cacheWrite, 0.5);
});

test('provider detection rejects ambiguity and model aliases remain deterministic', () => {
  const manifest = (id) => ({
    schemaVersion: 1,
    contractVersion: '1.0.0',
    id,
    version: '1.0.0',
    match: { providerIds: ['shared-provider'], runtimes: ['mcode'] },
    capabilities: {
      pricing: 'mirrored-rate', modelDiscovery: true, rateRetrieval: 'manual', effectiveDates: true, contextTiers: false, timeBands: false, supportedComponents: ['input', 'output'],
    },
    tokenSemantics: { inputIncludesCache: false, cacheReadSeparate: true, cacheWriteSeparate: true, reasoningIncludedInOutput: 'unknown', contextSizeIncludesOutput: true },
    source: { kind: 'fixture', url: 'https://example.test/rates', parserVersion: 1 },
    operations: ['detect'],
    modelAliases: { 'Vendor/Alias Model': 'canonical-model' },
  });
  const driver = defineProviderDriver({ manifest: manifest('first'), handlers: { detect: () => true } });
  const registry = createProviderRegistry([driver, { manifest: manifest('second'), handlers: { detect: () => true } }], { runtimeId: 'mcode' });
  assert.throws(() => registry.resolve('shared-provider'), /multiple provider drivers/);
  assert.equal(resolveDriverModel(driver, 'vendor/alias model'), 'canonical-model');
  assert.throws(
    () => defineProviderDriver({ manifest: { ...manifest('secret'), apiKey: 'do-not-serialize' }, handlers: { detect: () => true } }),
    /serialized secret/,
  );
});

test('user-installed driver modules load in deterministic filename order', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'provider-drivers-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const manifest = {
    schemaVersion: 1,
    contractVersion: '1.0.0',
    id: 'fixture-driver',
    version: '1.0.0',
    match: { providerIds: ['fixture'], runtimes: ['mcode'] },
    capabilities: { pricing: 'none', modelDiscovery: true, rateRetrieval: 'none', effectiveDates: false, contextTiers: false, timeBands: false, supportedComponents: [] },
    tokenSemantics: { inputIncludesCache: true, cacheReadSeparate: true, cacheWriteSeparate: true, reasoningIncludedInOutput: 'unknown', contextSizeIncludesOutput: false },
    source: { kind: 'fixture', url: 'https://example.test', parserVersion: 1 },
    operations: ['detect'],
    credentialEnv: 'FIXTURE_PROVIDER_TOKEN',
  };
  fs.writeFileSync(path.join(directory, 'driver.mjs'), `const manifest = ${JSON.stringify(manifest)}; export default { manifest, handlers: { detect: () => true } };\n`);
  const drivers = await loadProviderDrivers(directory);
  assert.equal(drivers.length, 1);
  assert.equal(drivers[0].manifest.id, 'fixture-driver');
  assert.equal(drivers[0].manifest.credentialEnv, 'FIXTURE_PROVIDER_TOKEN');
  assert.equal(JSON.stringify(drivers[0]).includes('do-not-serialize'), false);
});
