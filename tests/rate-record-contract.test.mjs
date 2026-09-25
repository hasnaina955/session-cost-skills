import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { readRateTable, resolveRate, validateRateRecord } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../contracts/rate-record-v1.schema.json', import.meta.url), 'utf8'));
const table = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));

test('every bundled rate component matches the formal effective-rate schema', () => {
  const records = Object.values(table.providers).flatMap((provider) => provider.rateRecords);
  assert.ok(records.length > 250);
  for (const record of records) {
    assert.deepEqual(validateJsonSchema(record, schema), []);
    assert.equal(validateRateRecord(record), record);
    assert.match(record.fingerprint, /^sha256:[a-f0-9]{64}$/);
    assert.ok(record.sourceAmount.length > 0);
    assert.ok(Number.isFinite(record.amount));
  }
});

test('current bundled rates select by effective date and context threshold', () => {
  const beforeSnapshot = resolveRate(table, 'commandcode', 'qwen-3.7-plus', {
    at: '2026-09-24T23:59:59.000Z',
    contextTokens: 1_000,
  });
  assert.equal(beforeSnapshot.rate, null);
  assert.equal(beforeSnapshot.coverage, 'unavailable');

  const lowContext = resolveRate(table, 'commandcode', 'qwen-3.7-plus', {
    at: '2026-09-26T00:00:00.000Z',
    contextTokens: 1_000,
  });
  const highContext = resolveRate(table, 'commandcode', 'qwen-3.7-plus', {
    at: '2026-09-26T00:00:00.000Z',
    contextTokens: 300_000,
  });
  assert.equal(lowContext.rate.input, 0.4);
  assert.equal(lowContext.rate.cacheWrite, 0.5);
  assert.equal(highContext.rate.input, 1.2);
  assert.equal(highContext.rate.cacheWrite, 1.5);
  assert.deepEqual(lowContext.rate.rateRecords[0].context, { minTokens: 0, maxTokens: 256_000 });
  assert.deepEqual(highContext.rate.rateRecords[0].context, { minTokens: 256_001, maxTokens: null });
});

test('historical time-band rates select the band effective at the call timestamp', () => {
  const peak = resolveRate(table, 'commandcode', 'deepseek-v4-pro', {
    at: '2026-09-28T02:00:00.000Z',
    contextTokens: 10_000,
  });
  const offPeak = resolveRate(table, 'commandcode', 'deepseek-v4-pro', {
    at: '2026-09-28T05:00:00.000Z',
    contextTokens: 10_000,
  });
  assert.equal(peak.timeBand, 'peak');
  assert.equal(peak.rate.input, 1.32);
  assert.equal(offPeak.timeBand, 'offPeak');
  assert.equal(offPeak.rate.input, 0.66);
  assert.equal(peak.rate.rateRecords[0].sourceAmount, '1.32');
});
