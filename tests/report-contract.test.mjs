import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_SCHEMA_VERSION, assertReportShape, validateReportShape } from '../shared/report-contract.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const schema = JSON.parse(fs.readFileSync(path.join(here, '..', 'shared', 'report.schema.json'), 'utf8'));

test('shared report schema and validator define the minimum contract', () => {
  assert.equal(REPORT_SCHEMA_VERSION, 1);
  assert.deepEqual(schema.required, ['schemaVersion', 'generatedAt', 'snapshot', 'usage', 'billing']);
  const report = {
    schemaVersion: 1,
    generatedAt: '2026-09-25T00:00:00.000Z',
    snapshot: { active: false, capturedAt: '2026-09-25T00:00:00.000Z' },
    usage: { totalTokens: 10, inputTokens: 10, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
    billing: { classification: 'cost-unavailable', costBasis: 'unavailable', coverage: 'not-recorded', recordedCostUsd: null },
  };
  assert.deepEqual(validateReportShape(report), { valid: true, errors: [] });
  assert.equal(assertReportShape(report), report);
});

test('shared report validator rejects missing accounting sections', () => {
  const result = validateReportShape({ schemaVersion: 1, generatedAt: 'not-a-date' });
  assert.equal(result.valid, false);
  assert.match(result.errors.join(' '), /snapshot/);
  assert.match(result.errors.join(' '), /usage/);
  assert.match(result.errors.join(' '), /billing/);
});
