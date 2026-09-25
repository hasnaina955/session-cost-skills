import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  ROLLUP_PERIODS,
  dayKey,
  hasSessionRows,
  rankSessions,
  rollupSessions,
  rollupTotals,
  weekKey,
} from '../shared/rollup.mjs';
import { createClineFixture, createMCodeFixture, runJson, clineScript, mcodeScript } from './helpers/contract-fixtures.mjs';

test('both adapters ship the same rollup implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/rollup.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(
      fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/rollup.mjs`, import.meta.url), 'utf8'),
      canonical,
      `${runtime} must contain the canonical rollup copy`,
    );
  }
});

test('period keys bucket by UTC day and ISO week', () => {
  assert.deepEqual(ROLLUP_PERIODS, ['daily', 'weekly']);
  assert.equal(dayKey('2026-09-23T23:59:59.999Z'), '2026-09-23');
  assert.equal(dayKey('2026-09-24T00:00:00.000Z'), '2026-09-24');
  // 2026-09-23 is a Wednesday, so its ISO week starts Monday the 21st.
  assert.equal(weekKey('2026-09-23T12:00:00.000Z'), '2026-09-21');
  assert.equal(weekKey('2026-09-27T23:00:00.000Z'), '2026-09-21', 'Sunday belongs to the same ISO week');
  assert.equal(weekKey('2026-09-28T00:00:00.000Z'), '2026-09-28', 'the next Monday starts a new week');
});

test('a daily rollup totals the session tree and keeps cost real', () => {
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
  const daily = rollupSessions(report, { period: 'daily' });
  assert.equal(daily.length, 1);
  assert.equal(daily[0].coverage, 'complete');
  assert.equal(daily[0].costUsd, report.billing.amountUsd, 'the rollup total must equal the report total');
  assert.equal(daily[0].sessionCount, 3, 'the subagent tree is attributed to its root period');
  assert.equal(daily[0].calls, 4);
  assert.equal(daily[0].unpricedCalls, 0);
  assert.ok(Number.isFinite(daily[0].totalTokens));
  assert.equal(daily[0].totalTokens, 1980);
});

test('unknown cost is never folded into a total as zero', () => {
  const synthetic = {
    sessions: [
      { row: { sessionId: 'priced', startedAt: '2026-09-23T10:00:00.000Z' }, metrics: { cost: 1.5, calls: 2, pricedCalls: 2, unpricedCalls: 0, inputTokens: 10, outputTokens: 5 } },
      { row: { sessionId: 'unpriced', startedAt: '2026-09-23T11:00:00.000Z' }, metrics: { cost: 0.9, calls: 2, pricedCalls: 1, unpricedCalls: 1, inputTokens: 10, outputTokens: 5 } },
    ],
  };
  const [bucket] = rollupSessions(synthetic, { period: 'daily' });
  assert.equal(bucket.costUsd, null, 'a bucket containing an unpriced call reports null, not 1.5');
  assert.equal(bucket.knownCostUsd, 1.5, 'the priced portion is still reported separately');
  assert.equal(bucket.coverage, 'partial');
  assert.equal(bucket.unpricedCalls, 1);

  const totals = rollupTotals(synthetic);
  assert.equal(totals.costUsd, null);
  assert.equal(totals.knownCostUsd, 1.5);
  assert.equal(totals.coverage, 'partial');
});

test('a report with no per-session rows is unknown, never a confident zero', () => {
  // "You spent nothing" and "we could not measure this" are different claims.
  for (const report of [{}, { sessions: [] }, null]) {
    const totals = rollupTotals(report);
    assert.equal(totals.costUsd, null, 'an unmeasurable report must not report 0');
    assert.equal(totals.coverage, 'unknown');
    assert.equal(totals.knownCostUsd, null);
    assert.equal(hasSessionRows(report), false);
    assert.ok(totals.reason, 'the reason must be stated');
    assert.deepEqual(rankSessions(report), []);
  }
});

test('an unpriced session sorts last instead of looking cheapest', () => {
  const synthetic = {
    sessions: [
      { row: { sessionId: 'cheap', startedAt: '2026-09-23T10:00:00.000Z' }, metrics: { cost: 0.1, calls: 1, pricedCalls: 1, unpricedCalls: 0 } },
      { row: { sessionId: 'unknown', startedAt: '2026-09-23T11:00:00.000Z' }, metrics: { cost: 9, calls: 1, pricedCalls: 0, unpricedCalls: 1 } },
      { row: { sessionId: 'dear', startedAt: '2026-09-23T12:00:00.000Z' }, metrics: { cost: 5, calls: 1, pricedCalls: 1, unpricedCalls: 0 } },
    ],
  };
  assert.deepEqual(rankSessions(synthetic).map((row) => row.sessionId), ['dear', 'cheap', 'unknown']);
  assert.equal(rankSessions(synthetic)[2].costUsd, null);
  assert.equal(rankSessions(synthetic, { top: 2 }).length, 2);
});

test('a zero-call session is reported, not dropped', () => {
  const synthetic = {
    sessions: [
      { row: { sessionId: 'empty', startedAt: '2026-09-23T10:00:00.000Z' }, metrics: { cost: 0, calls: 0, pricedCalls: 0, unpricedCalls: 0 } },
    ],
  };
  const [row] = rankSessions(synthetic);
  assert.equal(row.sessionId, 'empty');
  assert.equal(row.costUsd, 0);
  assert.equal(row.coverage, 'no-calls', 'no calls is a distinct statement from priced at zero');
  const [bucket] = rollupSessions(synthetic);
  assert.equal(bucket.costUsd, 0, 'a genuinely empty session is a real zero');
  assert.equal(bucket.coverage, 'no-calls');
});

test('MCode reports carry no session rows, so a MCode rollup is unknown', () => {
  // The two adapters produce structurally different reports. A rollup that silently
  // returned 0 for MCode would be the worst possible outcome, so it reports unknown.
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  assert.equal(hasSessionRows(report), false, 'MCode does not populate report.sessions yet');
  const totals = rollupTotals(report);
  assert.equal(totals.costUsd, null);
  assert.equal(totals.coverage, 'unknown');
  assert.ok(report.billing.amountUsd != null, 'the report itself does carry a cost for the session');
});

test('periods are validated rather than silently defaulting', () => {
  const report = { sessions: [] };
  assert.throws(() => rollupSessions(report, { period: 'hourly' }), /unsupported rollup period/);
  assert.throws(() => rollupSessions(report, { period: null }), /unsupported rollup period/);
});
