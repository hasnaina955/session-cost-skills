import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addUsage,
  classifyBilling,
  combineMetrics,
  descendantIds,
  emptyMetrics,
  resolveSession,
  usageSummary,
} from '../scripts/lib/session-cost-core.mjs';

function metrics(entries) {
  const result = emptyMetrics();
  for (const entry of entries) addUsage(result, entry.metrics, entry.modelInfo);
  return result;
}

test('Cline input tokens include cache; fresh input is the non-cached remainder', () => {
  const result = usageSummary(metrics([{ metrics: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 50 }, modelInfo: { provider: 'x', id: 'x' } }]));
  assert.deepEqual(result, {
    totalTokens: 1100,
    inputTokens: 1000,
    freshInputTokens: 150,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    outputTokens: 100,
    cacheHitRate: 0.8,
  });
});

test('classifies ClinePass, free, billed, partial, and unavailable calls', () => {
  const pass = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'cline-pass', id: 'stealth/model' } }]));
  assert.equal(pass.classification, 'cline-pass-included');
  assert.equal(pass.coverage, 'not-recorded');

  const free = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'cline', id: 'poolside/model:free' } }]));
  assert.equal(free.classification, 'free-model');

  const billed = classifyBilling(metrics([{ metrics: { inputTokens: 10, cost: 0.01 }, modelInfo: { provider: 'api', id: 'paid' } }]));
  assert.equal(billed.classification, 'usage-billed');
  assert.equal(billed.recordedCostUsd, 0.01);

  const partial = classifyBilling(metrics([
    { metrics: { inputTokens: 10, cost: 0.01 }, modelInfo: { provider: 'api', id: 'paid' } },
    { metrics: { inputTokens: 10 }, modelInfo: { provider: 'api', id: 'paid' } },
  ]));
  assert.equal(partial.classification, 'partial-cost');
  assert.equal(partial.coverage, 'partial');

  const unavailable = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'unknown', id: 'mystery' } }]));
  assert.equal(unavailable.classification, 'cost-unavailable');
});

test('combines model and call metrics without losing coverage counters', () => {
  const left = metrics([{ metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cost: 0.1 }, modelInfo: { provider: 'p', id: 'm' } }]);
  const right = metrics([{ metrics: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100 }, modelInfo: { provider: 'p', id: 'm' } }]);
  const result = combineMetrics(emptyMetrics(), left);
  combineMetrics(result, right);
  assert.equal(result.calls, 2);
  assert.equal(result.pricedCalls, 1);
  assert.equal(result.unpricedCalls, 1);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.models.get('p|m').calls, 2);
});

test('descendantIds includes nested subagents', () => {
  const rows = [
    { session_id: 'root', parent_session_id: null },
    { session_id: 'child', parent_session_id: 'root' },
    { session_id: 'grandchild', parent_session_id: 'child' },
    { session_id: 'other', parent_session_id: null },
  ];
  assert.deepEqual([...descendantIds(rows, 'root')], ['root', 'child', 'grandchild']);
});

test('session resolver prioritizes explicit and environment IDs', () => {
  const rows = [{ session_id: 'a', pid: 1, status: 'running' }, { session_id: 'b', pid: 2, status: 'running' }];
  assert.equal(resolveSession(rows, { explicitId: 'b' }).row.session_id, 'b');
  assert.equal(resolveSession(rows, { environment: { CLINE_SESSION_ID: 'a' } }).method, 'environment');
});

test('session resolver does not guess among multiple running sessions', () => {
  const rows = [
    { session_id: 'a', pid: 1, status: 'running', started_at: '2026-01-02T00:00:00Z' },
    { session_id: 'b', pid: 2, status: 'running', started_at: '2026-01-01T00:00:00Z' },
  ];
  const result = resolveSession(rows);
  assert.equal(result.method, 'ambiguous-running');
  assert.deepEqual(result.ambiguousCandidates, ['a', 'b']);
  assert.match(result.warning, /multiple running/);
});
