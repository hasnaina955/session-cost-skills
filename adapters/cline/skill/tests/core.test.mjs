import test from 'node:test';
import assert from 'node:assert/strict';
import {
  addUsage,
  classifyBilling,
  combineMetrics,
  emptyMetrics,
  resolveSession,
  usageSummary,
} from '../scripts/lib/session-cost-core.mjs';

function metrics(entries) {
  const result = emptyMetrics();
  for (const entry of entries) addUsage(result, entry.metrics, entry.modelInfo);
  return result;
}

test('an internally inconsistent ledger cannot push the cache hit rate out of range', () => {
  // A ledger reporting more cache reads than input tokens violates Cline's own
  // semantics. That must not crash the whole report over a display ratio; the raw
  // token counts still report exactly what the ledger said.
  const result = usageSummary(metrics([
    { metrics: { inputTokens: 400_000, outputTokens: 9_000, cacheReadTokens: 2_400_000, cacheWriteTokens: 120_000 }, modelInfo: { provider: 'x', id: 'x' } },
  ]));
  assert.equal(result.cacheReadTokens, 2_400_000, 'the raw ledger count is reported unchanged');
  assert.equal(result.cacheHitRate, 1, 'the display ratio is clamped into the contract range');
  assert.ok(result.cacheHitRate >= 0 && result.cacheHitRate <= 1);
  assert.equal(usageSummary(metrics([])).cacheHitRate, 0, 'an empty ledger reports a zero rate, not NaN');
});

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
  assert.equal(unavailable.recordedCostUsd, null);

  const positivePass = classifyBilling(metrics([
    { metrics: { inputTokens: 10, cost: 0.42 }, modelInfo: { provider: 'cline-pass', id: 'stealth/model' } },
  ]));
  assert.equal(positivePass.classification, 'cline-pass-included');
  assert.equal(positivePass.recordedCostUsd, 0);
  assert.match(positivePass.evidence, /not an additional charge/i);

  const aggregate = classifyBilling({ ...emptyMetrics(), callCountKnown: false, cost: 0.75 });
  assert.equal(aggregate.classification, 'aggregate-usage');
  assert.equal(aggregate.recordedCostUsd, 0.75);
  assert.equal(aggregate.coverage, 'aggregate');
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

test('session resolver prioritizes explicit and environment IDs', () => {
  const rows = [{ session_id: 'a', pid: 1, status: 'running' }, { session_id: 'b', pid: 2, status: 'running' }];
  assert.equal(resolveSession(rows, { explicitId: 'b' }).row.session_id, 'b');
  assert.equal(resolveSession(rows, { environment: { CLINE_SESSION_ID: 'a' } }).method, 'environment');
});

test('session resolver refuses to guess among multiple active root sessions', () => {
  const rows = [
    { session_id: 'a', pid: 1, status: 'running', parent_session_id: null, started_at: '2026-01-02T00:00:00Z' },
    { session_id: 'b', pid: 2, status: 'idle', parent_session_id: null, started_at: '2026-01-01T00:00:00Z' },
  ];
  const result = resolveSession(rows);
  assert.equal(result.method, 'ambiguous-active-root');
  assert.equal(result.row, null);
  assert.deepEqual(result.ambiguousCandidates, ['a', 'b']);
  assert.match(result.error, /multiple active Cline root sessions/);
});

test('session resolver recognizes active states, runtime context, root-only PIDs, and warned fallback', () => {
  const rows = [
    { session_id: 'root', pid: 10, status: 'pending', parent_session_id: null, started_at: '2026-01-03T00:00:00Z' },
    { session_id: 'child', pid: 11, status: 'running', parent_session_id: 'root', started_at: '2026-01-04T00:00:00Z' },
    { session_id: 'old', pid: 12, status: 'completed', parent_session_id: null, started_at: '2026-01-01T00:00:00Z' },
  ];
  assert.equal(resolveSession(rows).row.session_id, 'root');
  assert.equal(resolveSession(rows, { logSessionId: 'child' }).method, 'runtime-context');
  const fallback = resolveSession([
    { session_id: 'old', pid: 12, status: 'completed', parent_session_id: null, started_at: '2026-01-01T00:00:00Z' },
  ], { ancestorPids: [12] });
  assert.equal(fallback.method, 'latest-root-fallback');
  assert.equal(fallback.row.session_id, 'old');
  assert.match(fallback.warning, /latest root/);
  const byPid = resolveSession([
    { session_id: 'a', pid: 1, status: 'idle', parent_session_id: null, started_at: '2026-01-02T00:00:00Z' },
    { session_id: 'b', pid: 2, status: 'pending', parent_session_id: null, started_at: '2026-01-01T00:00:00Z' },
  ], { ancestorPids: [2] });
  assert.equal(byPid.method, 'process-ancestry');
  assert.equal(byPid.row.session_id, 'b');
});
