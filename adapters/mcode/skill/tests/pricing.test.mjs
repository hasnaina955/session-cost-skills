import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  RATE_COMPONENTS,
  accumulate,
  atomicWriteJson,
  emptyAggregate,
  enhanceReport,
  finalize,
  parseCommandCodePayload,
  rateSelectionForCall,
  ratesForBand,
  refreshRates,
  validateRateTable,
} from '../scripts/session-cost.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'pricing-cases.json'), 'utf8'));
const sourceTime = '2026-01-10T00:00:00.000Z';
const call = (overrides = {}) => ({
  ts: Date.parse('2026-01-15T12:00:00.000Z'),
  input_tokens: 1_000_000,
  output_tokens: 1_000_000,
  reasoning_tokens: 0,
  cache_read_tokens: 1_000_000,
  cache_write_tokens: 1_000_000,
  cost_usd: 0,
  ...overrides,
});

function tableFromFixture(models = fixture.models) {
  return {
    _meta: { schemaVersion: 2, refreshedAt: sourceTime },
    providers: {
      commandcode: {
        source: fixture.source,
        parserVersion: fixture.parserVersion,
        sourceVersion: fixture.parserVersion,
        fetchedAt: fixture.fetchedAt,
        models,
      },
    },
    freeModels: [],
    aliases: {},
  };
}

test('CommandCode structured parser preserves explicit zero, nonzero, and missing cache-write rates', () => {
  const payload = JSON.stringify({
    models: [
      { id: 'zero', name: 'Zero', provider: 'Synthetic', inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0 },
      { id: 'paid', name: 'Paid', provider: 'Synthetic', inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 1.5 },
      { id: 'missing', name: 'Missing', provider: 'Synthetic', inputCost: 2, outputCost: 4, cacheReadCost: 0.2 },
      { id: 'tiered', name: 'Tiered', provider: 'Synthetic', inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0, contextTiers: [{ maxContext: 100, inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0 }, { inputCost: 3, outputCost: 6, cacheReadCost: 0.3, cacheWriteCost: 1.5 }], timeOfDay: { effective: '2026-01-01T00:00:00.000Z', peak: { inputCost: 4, outputCost: 8, cacheReadCost: 0.4, cacheWriteCost: 2 }, offPeak: { inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0 } } },
    ],
  });
  const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
  const parsed = parseCommandCodePayload(html, sourceTime);
  assert.equal(parsed.models.zero.cacheWrite, 0);
  assert.equal(parsed.models.paid.cacheWrite, 1.5);
  assert.equal(parsed.models.missing.cacheWrite, null);
  assert.equal(Object.hasOwn(parsed.models.zero, 'cacheWrite'), true);
  assert.equal(Object.hasOwn(parsed.models.missing, 'cacheWrite'), true);
  assert.equal(parsed.models.tiered.cacheWrite, 0);
  assert.equal(parsed.models.tiered.contextTiers[0].cacheWrite, 0);
  assert.equal(parsed.models.tiered.contextTiers[1].cacheWrite, 1.5);
  assert.equal(parsed.models.tiered.timeOfDay.peak.cacheWrite, 2);
  assert.equal(parsed.models.tiered.timeOfDay.offPeak.cacheWrite, 0);
});

test('CommandCode parser rejects duplicate model ids instead of publishing an ambiguous table', () => {
  const payload = JSON.stringify({ models: [
    { id: 'duplicate', name: 'One', provider: 'Synthetic', inputCost: 1, outputCost: 1, cacheReadCost: 0, cacheWriteCost: 0 },
    { id: 'duplicate', name: 'Two', provider: 'Synthetic', inputCost: 2, outputCost: 2, cacheReadCost: 0, cacheWriteCost: 0 },
  ] });
  const html = `<script>self.__next_f.push([1,${JSON.stringify(payload)}])</script>`;
  assert.throws(() => parseCommandCodePayload(html, sourceTime), /duplicate CommandCode model id/);
});

test('explicit zero and missing components stay distinct in band selection', () => {
  const zero = ratesForBand({ input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }, 'flat');
  const missing = ratesForBand({ input: 2, output: 4, cacheRead: 0.2, cacheWrite: null }, 'flat');
  assert.equal(zero.cacheWrite, 0);
  assert.equal(missing.cacheWrite, null);
  assert.notEqual(zero.cacheWrite, missing.cacheWrite);
  assert.equal(ratesForBand({ input: 2, output: 4, cacheRead: 0.2, cacheWrite: 0 }, 'peak').input, null);
});

test('effective dates, context bands, and conservative unknown-context fallback are explicit', () => {
  const rate = fixture.models['context-model'];
  const shortContext = rateSelectionForCall(rate, call({ context_tokens: 50_000 }), { fetchedAt: sourceTime });
  assert.equal(shortContext.rates.input, 1);
  assert.equal(shortContext.contextMaxTokens, 100_000);
  assert.equal(shortContext.exact, true);

  const unknownContext = rateSelectionForCall(rate, call(), { fetchedAt: sourceTime });
  assert.equal(unknownContext.rates.input, 3, 'uses the highest published tier as a conservative bound');
  assert.equal(unknownContext.exact, false);
  assert.match(unknownContext.warnings.join(' '), /context unavailable/);

  const beforeEffective = rateSelectionForCall(rate, call({ ts: Date.parse('2025-12-31T23:59:59Z') }), { fetchedAt: sourceTime });
  assert.equal(beforeEffective.rates.input, null);
  assert.equal(beforeEffective.exact, false);
  assert.match(beforeEffective.warnings.join(' '), /predates/);
});

test('historical rate cards are selected by effective interval', () => {
  const historical = {
    input: 99,
    output: 99,
    cacheRead: 99,
    cacheWrite: 99,
    rateCards: [
      { rateCardVersion: 1, provider: 'synthetic', model: 'historical', currency: 'USD', unit: 'per 1M tokens', effectiveFrom: '2020-01-01T00:00:00.000Z', effectiveThrough: '2024-12-31T23:59:59.999Z', effectiveDateSource: 'source', contextMaxTokens: null, timeBand: 'flat', promotionId: null, components: { input: { value: 1 }, output: { value: 2 }, cacheRead: { value: 0.1 }, cacheWrite: { value: 0 } }, rateCardFingerprint: 'old' },
      { rateCardVersion: 1, provider: 'synthetic', model: 'historical', currency: 'USD', unit: 'per 1M tokens', effectiveFrom: '2025-01-01T00:00:00.000Z', effectiveThrough: null, effectiveDateSource: 'source', contextMaxTokens: null, timeBand: 'flat', promotionId: null, components: { input: { value: 3 }, output: { value: 4 }, cacheRead: { value: 0.3 }, cacheWrite: { value: 1 } }, rateCardFingerprint: 'new' },
    ],
  };
  assert.equal(rateSelectionForCall(historical, call({ ts: Date.parse('2023-01-01T00:00:00Z') }), {}).rates.input, 1);
  assert.equal(rateSelectionForCall(historical, call({ ts: Date.parse('2026-01-01T00:00:00Z') }), {}).rates.input, 3);
});

test('promotion windows select the explicit list rate outside the promotion', () => {
  const rate = fixture.models['promo-model'];
  const before = rateSelectionForCall(rate, call({ ts: Date.parse('2026-01-31T23:59:59Z') }), { fetchedAt: sourceTime });
  assert.equal(before.rates.input, 2, 'uses the explicit list rate before the promotion');
  assert.equal(before.promotionState, 'not-yet-active');
  const during = rateSelectionForCall(rate, call({ ts: Date.parse('2026-02-10T00:00:00Z') }), { fetchedAt: sourceTime });
  assert.equal(during.rates.input, 1, 'uses the promotion rate while effective');
  assert.equal(during.promotionState, 'active');
  const after = rateSelectionForCall(rate, call({ ts: Date.parse('2026-03-01T00:00:00Z') }), { fetchedAt: sourceTime });
  assert.equal(after.rates.input, 2, 'uses the explicit list rate after expiration');
  assert.equal(after.promotionState, 'expired');
});

test('a published nonzero CommandCode cache-write rate is included in token arithmetic', () => {
  const rate = fixture.models['paid-write'];
  const selection = rateSelectionForCall(rate, call(), { fetchedAt: sourceTime });
  const aggregate = emptyAggregate();
  accumulate(aggregate, call(), rate, selection);
  const result = finalize(aggregate);
  assert.equal(result.costCacheWrite, 1.5);
  assert.equal(result.rateCalculatedCostUsd, 7.7);
  assert.equal(result.pricingCoverage, 'complete');
});

test('partial and unknown rate coverage never turns a missing component into a zero charge', () => {
  const rate = fixture.models['missing-write'];
  const selection = rateSelectionForCall(rate, call(), { fetchedAt: sourceTime });
  const aggregate = emptyAggregate();
  accumulate(aggregate, call(), rate, selection);
  const result = finalize(aggregate);
  assert.equal(result.costCacheWrite, null);
  assert.equal(result.missingRateComponents.cacheWrite, 1);
  assert.equal(result.pricingCoverage, 'partial');
  assert.equal(result.rateCalculatedCostUsd, null);
  assert.equal(result.apiEquivalentCostUsd, null);

  const unknown = emptyAggregate();
  accumulate(unknown, call(), null, rateSelectionForCall(null, call(), {}));
  assert.equal(finalize(unknown).pricingCoverage, 'unknown');
  assert.equal(finalize(unknown).totalCost, null);
  assert.equal(finalize(unknown).rateCalculatedCostUsd, null);
});

test('rate validation rejects missing required components but reports optional component gaps', () => {
  const valid = validateRateTable(tableFromFixture(), { requireParserVersion: true });
  assert.equal(valid.valid, true);
  assert.equal(valid.coverage.components.cacheWrite.missing, 1);

  const incomplete = structuredClone(fixture.models);
  delete incomplete['paid-write'].output;
  const result = validateRateTable(tableFromFixture(incomplete), { requireParserVersion: true });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /paid-write\.output/);
});

test('JSON separates recorded ledger cost from rate/API-equivalent estimate', () => {
  const report = enhanceReport({
    calls: 1,
    totalTokens: 4_000_000,
    totalCost: 7.5,
    pricedCalls: 1,
    rateKnown: true,
    pricingCoverage: 'complete',
    pricingExact: true,
    rateCalculatedCostUsd: 7.5,
    apiEquivalentCostUsd: 7.5,
    recordedCostUsd: 0,
    partialRecordedCostUsd: 0,
    recordedCostCoverage: 'complete',
    models: [],
  });
  assert.equal(report.billing.rateCalculatedCostUsd, 7.5);
  assert.equal(report.billing.apiEquivalentCostUsd, 7.5);
  assert.equal(report.billing.recordedCostUsd, 0);
  assert.notEqual(report.billing.recordedCostUsd, report.billing.rateCalculatedCostUsd);
});

test('failed refresh preserves the previous valid table and writes through an atomic temporary file', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-rate-refresh-'));
  const ratesPath = path.join(directory, 'provider-rates.json');
  const previous = tableFromFixture();
  atomicWriteJson(ratesPath, previous);
  const before = fs.readFileSync(ratesPath, 'utf8');
  const result = await refreshRates({
    ratesPath,
    now: sourceTime,
    fetchers: {
      commandcode: async () => ({ incomplete: { input: 1, output: 2 } }),
      stepfun: async () => ({ 'step-5-preview': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }),
    },
  });
  assert.deepEqual(result.providers.commandcode.models, previous.providers.commandcode.models);
  assert.equal(fs.readFileSync(ratesPath, 'utf8'), before);
  assert.equal(fs.readdirSync(directory).some((name) => name.endsWith('.tmp')), false);
  await assert.rejects(
    refreshRates({
      ratesPath,
      now: sourceTime,
      throwOnFailure: true,
      fetchers: {
        commandcode: async () => ({ incomplete: { input: 1, output: 2 } }),
        stepfun: async () => ({ 'step-5-preview': { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }),
      },
    }),
    /rate refresh rejected/,
  );
  assert.equal(fs.readFileSync(ratesPath, 'utf8'), before);
  fs.rmSync(directory, { recursive: true, force: true });
});

function makeLedger(root, { provider, model, sessionId }) {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'v2', 'sqlite'), { recursive: true });
  fs.mkdirSync(path.join(root, 'v2', 'sessions', 'history'), { recursive: true });
  const db = new DatabaseSync(path.join(root, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, agent_name TEXT, title TEXT, parent_session_id TEXT, history_relative_dir TEXT);
    CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, turn_id TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER, cost_usd REAL);`);
  const timestamp = Date.parse('2026-09-24T12:00:00.000Z');
  db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?)').run(sessionId, 'fixture', 'fixture', null, 'history');
  db.prepare('INSERT INTO local_runtime_token_usage (session_id,agent_name,turn_id,ts,input_tokens,output_tokens,reasoning_tokens,cache_read_tokens,cache_write_tokens,cost_usd) VALUES (?,?,?,?,?,?,?,?,?,?)').run(sessionId, 'fixture', 'turn', timestamp, 1_000_000, 1_000_000, 0, 1_000_000, 1_000_000, 0);
  db.close();
  fs.writeFileSync(path.join(root, 'v2', 'sessions', 'history', 'llm-call.json'), JSON.stringify({ provider, model }));
  fs.writeFileSync(path.join(root, 'v2', 'sessions', 'history', 'messages.jsonl'), `${JSON.stringify({ message: { role: 'assistant', model, provider, timestamp, usage: {} } })}\n`);
  return root;
}

test('MCode SQLite fixture keeps explicit cache-write arithmetic and exposes partial coverage', () => {
  const script = path.resolve(here, '..', 'scripts', 'session-cost.mjs');
  const completeRoot = makeLedger(path.join(os.tmpdir(), 'mcode-e2e-complete'), { provider: 'custom_provider:stepfun', model: 'step-5-preview', sessionId: 'mvs_complete' });
  const complete = spawnSync(process.execPath, [script, '--data-dir', completeRoot, '--json'], { encoding: 'utf8' });
  assert.equal(complete.status, 0, complete.stderr);
  const completeJson = JSON.parse(complete.stdout);
  assert.equal(completeJson.usage.cacheWriteTokens, 1_000_000);
  assert.equal(completeJson.billing.rateCalculatedCostUsd, 4.75);
  assert.equal(completeJson.billing.recordedCostUsd, 0);
  assert.notEqual(completeJson.billing.recordedCostUsd, completeJson.billing.rateCalculatedCostUsd);

  const partialRoot = makeLedger(path.join(os.tmpdir(), 'mcode-e2e-partial'), { provider: 'custom_provider:commandcode', model: 'tencent/hy4-preview', sessionId: 'mvs_partial' });
  const partial = spawnSync(process.execPath, [script, '--data-dir', partialRoot, '--json'], { encoding: 'utf8' });
  assert.equal(partial.status, 2, partial.stderr);
  const partialJson = JSON.parse(partial.stdout);
  assert.equal(partialJson.billing.pricingCoverage, 'partial');
  assert.equal(partialJson.billing.rateCalculatedCostUsd, null);
  assert.equal(partialJson.billing.partialRateCalculatedCostUsd, 3.377);
  assert.equal(partialJson.models[0].componentCompleteness.cacheWrite, 'missing');
  fs.rmSync(completeRoot, { recursive: true, force: true });
  fs.rmSync(partialRoot, { recursive: true, force: true });
});
