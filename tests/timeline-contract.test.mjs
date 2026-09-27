import test from 'node:test';
import assert from 'node:assert/strict';
import { createTimeline, timelineTotalUsd, DEFAULT_TIMELINE_LIMIT } from '../shared/timeline.mjs';

const call = (t, costUsd, extra = {}) => ({ t, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, costUsd, ...extra });

test('entries keep the fields a chart needs, and cost is null when unpriced', () => {
  const timeline = createTimeline();
  timeline.add(call('2026-06-15T12:00:00.000Z', 0.001, { model: 'm1', provider: 'p1', sessionId: 's1' }));
  timeline.add(call('2026-06-15T12:00:01.000Z', null, { model: 'unknown-model', provider: 'p1' }));
  const { timeline: entries, timelineMeta } = timeline.finalize();
  assert.equal(timelineMeta, null);
  assert.equal(entries.length, 2);
  assert.deepEqual(Object.keys(entries[0]).sort(), ['cacheRead', 'cacheWrite', 'costUsd', 'input', 'model', 'output', 'provider', 'sessionId', 't']);
  assert.equal(entries[0].costUsd, 0.001);
  // An unpriced call is null, never 0 - the same rule the report itself follows.
  assert.equal(entries[1].costUsd, null);
  // A null anywhere makes the total unknown rather than smaller.
  assert.equal(timelineTotalUsd(entries), null);
});

test('an unusable timestamp is skipped, never guessed into a position', () => {
  const timeline = createTimeline();
  timeline.add(call('not-a-date', 0.5));
  timeline.add(call(Number.NaN, 0.5));
  timeline.add(call('2026-06-15T12:00:00.000Z', 0.5));
  const { timeline: entries } = timeline.finalize();
  assert.equal(entries.length, 1, 'only the usable timestamp becomes an entry');
  assert.equal(entries[0].t, '2026-06-15T12:00:00.000Z');
});

test('entries keep the order they were added, whatever the timestamps say', () => {
  // The ledger order is the order calls actually happened. Sorting here would hide a
  // clock-skew problem instead of surfacing it.
  const timeline = createTimeline();
  timeline.add(call('2026-06-15T12:00:09.000Z', 0.2));
  timeline.add(call('2026-06-15T12:00:01.000Z', 0.1));
  const { timeline: entries } = timeline.finalize();
  assert.deepEqual(entries.map((entry) => entry.t), ['2026-06-15T12:00:09.000Z', '2026-06-15T12:00:01.000Z']);
});

test('past the limit the timeline buckets rather than growing without bound', () => {
  // 400 calls 100ms apart, so 10 calls share each 1s bucket. The point of bucketing is that the
  // array shrinks; calls that each occupy their own bucket legitimately do not compress, which is
  // why this uses dense timestamps rather than sparse ones.
  const base = Date.parse('2026-06-15T12:00:00.000Z');
  const timeline = createTimeline({ limit: 20, bucketMs: 1000 });
  for (let index = 0; index < 400; index += 1) {
    timeline.add(call(base + index * 100, 0.01));
  }
  const { timeline: entries, timelineMeta } = timeline.finalize();
  // The limit decides *whether* to bucket; the bucket count is then set by the time span, so a
  // 40-second session yields 40 one-second buckets. What must hold is that the array shrank and
  // the money survived: a bound expressed in entries would be a bound on the session's duration.
  assert.ok(entries.length < 400, `timeline grew to ${entries.length} entries for 400 calls`);
  assert.equal(timelineMeta.bucketed, true);
  assert.equal(timelineMeta.limit, 20);
  // Nothing is dropped: every call is either listed or folded into a bucket.
  assert.equal(timelineMeta.droppedCalls, 0);
  assert.match(timelineMeta.note, /time buckets/);
  // The rollup must still equal the total, or a chart and the headline figure disagree.
  assert.ok(Math.abs(timelineTotalUsd(entries) - 4) < 1e-9, `bucketed total drifted: ${timelineTotalUsd(entries)}`);
});

test('bucketing is all-or-nothing, so no call is silently dropped', () => {
  // An earlier version listed the first `limit` calls and bucketed only the remainder. Calls that
  // fell between a bucket edge and the first bucket were then in neither list, and the rollup came
  // out short - caught by the total drifting, not by any count.
  const base = Date.parse('2026-06-15T12:00:00.000Z');
  const timeline = createTimeline({ limit: 5, bucketMs: 60_000 });
  for (let index = 0; index < 9; index += 1) timeline.add(call(base + index * 1000, 0.25));
  const { timeline: entries, timelineMeta } = timeline.finalize();
  assert.equal(timelineMeta.bucketed, true);
  // All 9 calls are in one minute, so they collapse to a single bucket costing 2.25.
  assert.equal(entries.length, 1);
  assert.equal(timelineMeta.droppedCalls, 0, 'folding listed entries into buckets is not a dropped call');
  assert.ok(Math.abs(timelineTotalUsd(entries) - 2.25) < 1e-9, `lost calls: ${timelineTotalUsd(entries)}`);
});

test('a bucket containing an unpriced call is unknown, not the sum of the priced ones', () => {
  // Summing prices and dropping the unpriced calls would make a bucket look *cheaper* than the
  // truth. That is the under-reporting direction, so the whole bucket goes unknown instead.
  const base = Date.parse('2026-06-15T12:00:00.000Z');
  const timeline = createTimeline({ limit: 1, bucketMs: 60_000 });
  timeline.add(call(base, 0.5));
  timeline.add(call(base + 1000, null));
  const { timeline: entries } = timeline.finalize();
  assert.equal(entries.length, 1);
  assert.equal(entries[0].costUsd, null);
  assert.equal(timelineTotalUsd(entries), null);
  // Tokens still add up: a bucket is a count of work, and only the money goes unknown.
  assert.equal(entries[0].input, 20);
});

test('the default limit is a number a report can actually carry', () => {
  assert.ok(Number.isInteger(DEFAULT_TIMELINE_LIMIT) && DEFAULT_TIMELINE_LIMIT > 0);
  const timeline = createTimeline();
  for (let index = 0; index < DEFAULT_TIMELINE_LIMIT + 5; index += 1) {
    timeline.add(call(Date.parse('2026-06-15T12:00:00.000Z') + index, 0.001));
  }
  const { timeline: entries } = timeline.finalize();
  assert.ok(entries.length <= DEFAULT_TIMELINE_LIMIT + 1, `timeline grew to ${entries.length}`);
});

// --- End to end: a real MCode report must carry a timeline that agrees with its own total ---

test('a real MCode report emits a timeline that rolls up to its own total', async () => {
  const { mcodeScript, createMCodeFixture, runJson } = await import('./helpers/contract-fixtures.mjs');
  const { timelineTotalUsd: total } = await import('../shared/timeline.mjs');
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--include-children', '--json'],
    { ...fixture.environment, SESSION_COST_NOW: '2026-06-15T18:00:00.000Z' }).output;

  assert.ok(Array.isArray(report.timeline) && report.timeline.length > 0, 'a --json report must carry a timeline');
  assert.equal(report.calls, report.timeline.length, 'one entry per call');
  const summed = total(report.timeline);
  assert.ok(Math.abs(summed - report.billing.amountUsd) < 1e-9,
    `timeline total ${summed} != report total ${report.billing.amountUsd}`);
  // Every entry names the model and provider a chart groups by.
  for (const entry of report.timeline) {
    assert.ok(entry.model, 'an entry must name its model');
    assert.ok(Number.isFinite(Date.parse(entry.t)), 'an entry must carry a usable instant');
  }
});

test('a partially priced report is unknown in the timeline too, never a smaller number', async () => {
  const { mcodeScript, createMCodeFixture, runJson } = await import('./helpers/contract-fixtures.mjs');
  const { timelineTotalUsd: total } = await import('../shared/timeline.mjs');
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-partial', '--json'],
    { ...fixture.environment, SESSION_COST_NOW: '2026-06-15T18:00:00.000Z' }).output;

  assert.notEqual(report.billing.coverage, 'complete');
  assert.equal(report.billing.amountUsd, null, 'a partial report states no total');
  // The unpriced call is null in the timeline, so the rollup is null rather than the sum of the
  // calls that happened to price. A chart drawn from that sum would under-report.
  assert.equal(total(report.timeline), null, 'a partial timeline must not sum to a number');
  assert.ok(report.timeline.some((entry) => entry.costUsd === null), 'the unpriced call must be visible as null');
});

test('a text report carries no timeline, so the golden corpus stays readable', async () => {
  const { mcodeScript, createMCodeFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-root'],
    { ...fixture.environment, SESSION_COST_NOW: '2026-06-15T18:00:00.000Z' });
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /costUsd/, 'a text report has nowhere to put per-call events');
});
