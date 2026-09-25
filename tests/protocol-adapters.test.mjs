import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMCodeFixture, mcodeScript, runJson } from './helpers/contract-fixtures.mjs';
import {
  PROTOCOL_ADAPTERS,
  normalizeAnthropicUsage,
  normalizeOpenAIUsage,
  parseAnthropicCompatibleStream,
  parseOpenAICompatibleStream,
} from '../adapters/mcode/skill/scripts/lib/protocol-adapters.mjs';
import { createMCodeProviderRegistry, resolveWithProviderDriver } from '../adapters/mcode/skill/scripts/lib/provider-drivers.mjs';
import { makeRateRecord, readRateTable, REQUIRED_RATE_COMPONENTS } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const table = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));
const configSchema = JSON.parse(fs.readFileSync(new URL('../contracts/session-config-v1.schema.json', import.meta.url), 'utf8'));

test('OpenAI-compatible usage preserves cache detail and unknown cache writes', () => {
  const normalized = normalizeOpenAIUsage({
    usage: {
      prompt_tokens: 1_000,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 200 },
      completion_tokens_details: { reasoning_tokens: 50 },
    },
  });
  assert.equal(normalized.inputTokens, 800);
  assert.equal(normalized.outputTokens, 300);
  assert.equal(normalized.cacheReadTokens, 200);
  assert.equal(normalized.cacheWriteTokens, null);
  assert.equal(normalized.reasoningTokens, 50);
  assert.equal(normalized.coverage, 'partial');
  assert.deepEqual(normalized.missingComponents, ['cacheWriteTokens']);

  const missing = normalizeOpenAIUsage({ model: 'x' });
  assert.equal(missing.coverage, 'unavailable');
  assert.ok(missing.inputTokens === null);
});

test('OpenAI-compatible streaming keeps the final usage event', () => {
  const stream = [
    'data: {"model":"vendor-model","choices":[{"delta":{"content":"a"}}]}',
    'data: {"model":"vendor-model","usage":{"prompt_tokens":10,"completion_tokens":2,"prompt_tokens_details":{"cached_tokens":4}}}',
    'data: [DONE]',
  ].join('\n');
  const parsed = parseOpenAICompatibleStream(stream);
  assert.equal(parsed.model, 'vendor-model');
  assert.equal(parsed.events.length, 2);
  assert.equal(parsed.normalizedUsage.inputTokens, 6);
  assert.equal(parsed.normalizedUsage.cacheReadTokens, 4);
});

test('Anthropic-compatible usage and streaming normalize cache creation explicitly', () => {
  const normalized = normalizeAnthropicUsage({
    input_tokens: 100,
    output_tokens: 20,
    cache_read_input_tokens: 40,
    cache_creation_input_tokens: 10,
  });
  assert.equal(normalized.inputTokens, 100);
  assert.equal(normalized.cacheReadTokens, 40);
  assert.equal(normalized.cacheWriteTokens, 10);
  assert.equal(normalized.coverage, 'complete');

  const parsed = parseAnthropicCompatibleStream([
    JSON.stringify({ type: 'message_start', message: { model: 'vendor-claude', usage: { input_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 } } }),
    JSON.stringify({ type: 'message_delta', usage: { output_tokens: 7 } }),
    JSON.stringify({ type: 'message_stop' }),
  ].join('\n'));
  assert.equal(parsed.model, 'vendor-claude');
  assert.equal(parsed.normalizedUsage.inputTokens, 5);
  assert.equal(parsed.normalizedUsage.outputTokens, 7);
  assert.equal(parsed.normalizedUsage.cacheWriteTokens, 1);
});

function openAiProfile() {
  return {
    id: 'custom-openai',
    driverId: 'openai-compatible',
    match: { providerIds: ['custom-openai'], runtimes: ['mcode', 'cline'] },
    baseUrlEnv: 'CUSTOM_OPENAI_BASE_URL',
    endpointEnv: 'CUSTOM_OPENAI_BASE_URL',
    credentialEnv: 'CUSTOM_OPENAI_API_KEY',
    region: 'eu-west',
    currency: 'EUR',
    pricingMode: 'manual',
    rateSource: { kind: 'manual', url: 'https://pricing.example.test' },
    rateCards: [{
      model: 'vendor-model',
      effectiveFrom: '2026-01-01T00:00:00.000Z',
      currency: 'EUR',
      input: 2,
      output: 6,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    }],
  };
}

test('a custom OpenAI-compatible endpoint is priced from configured manual cards', () => {
  const registry = createMCodeProviderRegistry(table, {
    profiles: [openAiProfile()],
    models: [{ runtime: 'mcode', provider: 'custom-openai', runtimeModel: 'Vendor/Model', rateModel: 'vendor-model' }],
  });
  const resolved = resolveWithProviderDriver(registry, {
    provider: 'custom-openai',
    model: 'Vendor/Model',
    at: '2026-06-01T00:00:00.000Z',
    contextTokens: 1_000,
  });
  assert.equal(resolved.providerDriver.id, 'custom-openai');
  assert.equal(resolved.rate.input, 2);
  assert.equal(resolved.rate.cacheWrite, 2.5);
  assert.equal(resolved.rate.currency, 'EUR');
  assert.equal(resolved.rate.region, 'eu-west');
  assert.equal(resolved.rate.endpointEnv, 'CUSTOM_OPENAI_BASE_URL');
  assert.equal(resolved.rate.credentialEnv, 'CUSTOM_OPENAI_API_KEY');
  assert.equal(resolved.coverage, 'complete');
  assert.equal(registry.resolve('custom-openai').handlers.listModels()[0].id, 'vendor-model');
  assert.equal(registry.resolve('custom-openai').handlers.normalizeUsage, PROTOCOL_ADAPTERS['openai-compatible'].normalizeUsage);

  const before = resolveWithProviderDriver(registry, { provider: 'custom-openai', model: 'vendor-model', at: '2025-12-31T00:00:00.000Z' });
  assert.equal(before.rate, null);
  const unknown = resolveWithProviderDriver(registry, { provider: 'custom-openai', model: 'unknown-model', at: '2026-06-01T00:00:00.000Z' });
  assert.equal(unknown.rate, null);
  assert.equal(unknown.coverage, 'unavailable');
});


test('imported effective rate records work without an authoritative rate source', () => {
  const profile = {
    id: 'imported-anthropic',
    driverId: 'anthropic-compatible',
    match: { providerIds: ['imported-anthropic'], runtimes: ['mcode'] },
    currency: 'GBP',
    region: 'uk',
    pricingMode: 'manual',
    importedRateRecords: REQUIRED_RATE_COMPONENTS.map((component) => makeRateRecord({
      providerKey: 'imported-anthropic',
      modelKey: 'imported-model',
      component,
      sourceAmount: component === 'input' ? '1.25' : '0',
      amount: component === 'input' ? 1.25 : 0,
      effectiveFrom: '2026-02-01T00:00:00.000Z',
      context: { minTokens: 0, maxTokens: null },
      timeBand: 'flat',
      currency: 'GBP',
      source: { kind: 'imported', url: 'https://rates.example.test', parserVersion: 1, fetchedAt: '2026-02-01T00:00:00.000Z' },
    })),
  };
  const registry = createMCodeProviderRegistry(table, { profiles: [profile] });
  const resolved = resolveWithProviderDriver(registry, {
    provider: 'imported-anthropic',
    model: 'imported-model',
    at: '2026-06-01T00:00:00.000Z',
    contextTokens: 100,
  });
  assert.equal(resolved.rate.input, 1.25);
  assert.equal(resolved.rate.currency, 'GBP');
  assert.equal(resolved.rate.region, 'uk');
  assert.deepEqual(resolved.rate.rateRecords.map((record) => record.component), ['input', 'output', 'cacheRead', 'cacheWrite']);
});

test('incomplete manual rate cards fail instead of defaulting to zero', () => {
  const profile = openAiProfile();
  delete profile.rateCards[0].cacheWrite;
  assert.throws(
    () => createMCodeProviderRegistry(table, { profiles: [profile] }),
    /missing cacheWrite/,
  );
});


test('generic provider profiles validate against the configuration contract', () => {
  const config = {
    schemaVersion: 1,
    runtimeDefaults: {},
    providers: [openAiProfile()],
    models: [],
  };
  assert.deepEqual(validateJsonSchema(config, configSchema), []);
});


test('MCode prices a custom compatible endpoint from project configuration without network access', (t) => {
  const fixture = createMCodeFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const sessionsRoot = path.join(fixture.dataDir, 'v2', 'sessions');
  for (const entry of fs.readdirSync(sessionsRoot)) {
    for (const name of ['llm-call.json', 'messages.jsonl']) {
      const file = path.join(sessionsRoot, entry, name);
      const text = fs.readFileSync(file, 'utf8')
        .replaceAll('custom_provider:commandcode', 'custom-provider')
        .replaceAll('custom_provider:stepfun', 'custom-provider');
      fs.writeFileSync(file, text);
    }
  }
  const configPath = path.join(fixture.dataDir, 'custom.json');
  fs.writeFileSync(configPath, JSON.stringify({
    schemaVersion: 1,
    runtimeDefaults: {},
    providers: [{
      id: 'configured-openai',
      driverId: 'openai-compatible',
      match: { providerIds: ['custom-provider'], runtimes: ['mcode'] },
      baseUrlEnv: 'CUSTOM_BASE_URL',
      credentialEnv: 'CUSTOM_API_KEY',
      region: 'test-region',
      currency: 'EUR',
      pricingMode: 'manual',
      rateCards: ['vendor-model', 'step-5-preview'].map((model) => ({
        model,
        effectiveFrom: '2026-01-01T00:00:00.000Z',
        input: 1,
        output: 2,
        cacheRead: 0.1,
        cacheWrite: 0.25,
      })),
    }],
    models: [
      { runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'fixture-command-model', rateModel: 'vendor-model' },
      { runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'step-5-preview', rateModel: 'step-5-preview' },
    ],
  }, null, 2));

  const { result, output } = runJson(mcodeScript, fixture.dataDir, [
    '--session', 'mcode-root',
    '--session-config', configPath,
  ], fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.billing.currency, 'EUR');
  assert.equal(output.billing.estimatedCostUsd > 0, true);
  assert.deepEqual(output.providerDrivers.map((driver) => driver.id), ['configured-openai']);
  assert.equal(output.models.every((model) => model.rateRegion === 'test-region'), true);
  assert.equal(output.rateProvenance.every((record) => record.effectiveFrom === '2026-01-01T00:00:00.000Z'), true);
  assert.equal(result.stdout.includes('sk-'), false);
});
