// Contract tests for shared/insights.mjs (issue #55).
//
// The module exists to hold three lines that are easy to erode by accident, so each of them
// gets a test that fails the moment the line is crossed:
//
//   * too little history says so, and never becomes a fabricated baseline
//   * unknown cost stays null, so an unpriced session cannot look cheap
//   * no output can be read as a forecast of future spend
//
// The comparison is checked against real reports produced by both adapters wherever the real
// report can answer the question, because a synthetic row proves only that the arithmetic runs.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as insights from '../shared/insights.mjs';
import { createClineFixture, createMCodeFixture, runJson, clineScript, mcodeScript } from './helpers/contract-fixtures.mjs';

const {
  CACHE_RATE_BASES,
  DEVIATION_STATUS,
  INSIGHTS_BASIS,
  INSIGHTS_METRICS,
  INSIGHTS_SCOPE,
  INSIGHTS_STATUS,
  MIN_BASELINE_SESSIONS,
  buildInsights,
  compareToBaseline,
  describeBaseline,
  historyEntries,
  recurringDrivers,
  renderInsightsText,
  resolveMetrics,
  sessionCostUsd,
  utcDayKey,
} = insights;

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// ---------------------------------------------------------------- fixtures in the report's own shape

/** A `{row, metrics}` session row, exactly as `report.sessions[]` carries it. */
function row({ id, parent = null, start = '2026-09-10T10:00:00.000Z', end = '2026-09-10T10:30:00.000Z', ...metrics }) {
  return {
    row: { sessionId: id, parentSessionId: parent, status: 'completed', startedAt: start, endedAt: end },
    metrics: { callCountKnown: true, ...metrics },
  };
}

/** A uniform history of `count` prior sessions, all measured, one per day from `day`. */
function history(count, overrides = {}) {
  const settings = {
    cost: 0.01,
    calls: 2,
    cacheReadTokens: 30,
    inputTokens: 1000,
    outputTokens: 100,
    cacheWriteTokens: 10,
    day: 10,
    ...overrides,
  };
  return Array.from({ length: count }, (_, index) => row({
    id: `prior-${index}`,
    start: `2026-09-${String(settings.day + index).padStart(2, '0')}T10:00:00.000Z`,
    end: `2026-09-${String(settings.day + index).padStart(2, '0')}T10:30:00.000Z`,
    cost: settings.cost,
    calls: settings.calls,
    pricedCalls: settings.calls,
    unpricedCalls: 0,
    inputTokens: settings.inputTokens,
    outputTokens: settings.outputTokens,
    cacheReadTokens: settings.cacheReadTokens,
    cacheWriteTokens: settings.cacheWriteTokens,
  }));
}

// Forty times the history on cost and on cached input, the shape of the outlier the issue describes.
const OUTLIER = row({
  id: 'outlier',
  start: '2026-09-20T10:00:00.000Z',
  end: '2026-09-20T11:00:00.000Z',
  cost: 0.4,
  calls: 8,
  pricedCalls: 8,
  unpricedCalls: 0,
  inputTokens: 9000,
  outputTokens: 900,
  cacheReadTokens: 1200,
  cacheWriteTokens: 40,
});

function median(values) {
  const sorted = values.filter((value) => typeof value === 'number').slice().sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

// Sums of decimal costs are not exactly representable, so comparisons of a summed figure use a
// tolerance. A figure lifted straight out of a report is still compared exactly.
function close(actual, expected, message) {
  assert.ok(Math.abs(actual - expected) < 1e-9, `${message ?? ''} expected ${actual} to be within 1e-9 of ${expected}`);
}

function clineReport() {
  const fixture = createClineFixture();
  return runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
}

function mcodeReport() {
  const fixture = createMCodeFixture();
  return runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--include-children', '--json'], fixture.environment).output;
}

// ---------------------------------------------------------------- module shape

test('insights exports exactly the surface it documents, and nothing that projects', () => {
  assert.deepEqual(Object.keys(insights).sort(), [
    'CACHE_RATE_BASES',
    'DEVIATION_STATUS',
    'INSIGHTS_BASIS',
    'INSIGHTS_METRICS',
    'INSIGHTS_SCOPE',
    'INSIGHTS_STATUS',
    'MIN_BASELINE_SESSIONS',
    'buildInsights',
    'compareToBaseline',
    'describeBaseline',
    'formatCount',
    'formatDuration',
    'formatMetric',
    'formatRate',
    'formatUsd',
    'historyEntries',
    'recurringDrivers',
    'renderInsightsText',
    'resolveMetrics',
    'sessionCostUsd',
    'sessionIdOf',
    'utcDayKey',
  ].sort(), 'a new export has to be a deliberate decision, not an accident');

  // No entry point whose name could be a projection, whatever it does internally.
  const projectionNames = /forecast|predict|project|extrapolat|annual|perMonth|perDay|runRate|estimate/i;
  for (const name of Object.keys(insights)) {
    assert.doesNotMatch(name, projectionNames, `export "${name}" reads as a projection`);
  }
  assert.equal(INSIGHTS_BASIS, 'measured-history');
  assert.equal(INSIGHTS_SCOPE, 'past-only');
  assert.equal(MIN_BASELINE_SESSIONS, 5);
  assert.deepEqual([...INSIGHTS_METRICS], ['cost', 'cacheHitRate', 'cacheReadTokens', 'calls', 'subagentCount', 'durationMs']);
  assert.deepEqual([...CACHE_RATE_BASES], ['input-including-cache', 'prompt-including-cache-write']);
});

test('the module is dependency-free and cross-platform safe', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'shared', 'insights.mjs'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'insights must import nothing at all');
  assert.doesNotMatch(source, /\brequire\s*\(/, 'insights must import nothing at all');
  // `new URL(...).pathname` is a known Windows bug in this repo: it mangles drive letters.
  assert.doesNotMatch(source, /new URL\([^)]*\)\.pathname/);
});

test('the sync script targets both adapters and resolves its own path the safe way', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'scripts', 'sync-insights.mjs'), 'utf8');
  assert.match(source, /fileURLToPath/, 'the script must resolve its own directory with fileURLToPath');
  assert.doesNotMatch(source, /\.pathname/, 'new URL(...).pathname mangles Windows drive letters');
  assert.match(source, /'cline'/, 'both adapters ship a copy');
  assert.match(source, /'mcode'/, 'both adapters ship a copy');
  assert.match(source, /--check/, 'CI needs a read-only mode that does not write');
});

test('unknown metrics are rejected rather than silently dropped', () => {
  assert.throws(() => compareToBaseline(OUTLIER, history(6), { metrics: ['costPerDay'] }), /unsupported insights metric/);
  assert.throws(() => resolveMetrics([]), /unsupported insights metric/);
  assert.deepEqual(resolveMetrics(['cost', 'calls']), ['cost', 'calls']);
});

test('day keys bucket by UTC, not by wherever the report happened to run', () => {
  assert.equal(utcDayKey('2026-09-23T23:59:59.999Z'), '2026-09-23');
  assert.equal(utcDayKey('2026-09-24T00:00:00.000Z'), '2026-09-24');
});

test('a report with no per-session rows contributes no session rows at all', () => {
  // A real report that genuinely carries no `sessions[]`. Treating it as a session row
  // would invent a session that never happened. MCode emits rows now, so this uses a
  // stripped report rather than a real adapter output.
  const report = { ...mcodeReport(), sessions: undefined };
  assert.ok(!Array.isArray(report.sessions), 'this fixture is the point: the report has no sessions');
  assert.ok(Number.isFinite(report.billing.amountUsd), 'and it does carry a real cost of its own');
  assert.deepEqual(historyEntries(report), []);
  assert.deepEqual(historyEntries([report, report]), []);
  assert.deepEqual(historyEntries({ sessions: history(3) }).length, 3);
  assert.deepEqual(historyEntries(null), []);
});

// ---------------------------------------------------------------- insufficient data, never invented

test('a real report with three sessions says it cannot compare, and invents nothing', () => {
  const report = clineReport();
  assert.equal(report.sessions.length, 3, 'this fixture really does carry only three sessions');

  const comparison = compareToBaseline(report.sessions[0], report);
  assert.equal(comparison.status, INSIGHTS_STATUS.INSUFFICIENT);
  assert.equal(comparison.insufficientReason.code, 'sample-too-small');
  assert.equal(comparison.insufficientReason.availableSessions, 2, 'the target is removed from its own baseline');
  assert.equal(comparison.insufficientReason.usableValues, 2);
  assert.equal(comparison.insufficientReason.required, MIN_BASELINE_SESSIONS);
  assert.ok(
    comparison.insufficientReason.message.includes(String(MIN_BASELINE_SESSIONS)),
    'the message must name the sample size that failed the gate',
  );

  // Nothing may read as a comparison.
  for (const deviation of comparison.deviations) {
    assert.equal(deviation.status, DEVIATION_STATUS.INSUFFICIENT);
    assert.equal(deviation.value, null);
    assert.equal(deviation.baseline, null);
    assert.equal(deviation.ratio, null);
    assert.equal(deviation.ratioText, null);
    assert.equal(deviation.notable, false);
  }
  assert.equal(comparison.deviations.filter((deviation) => deviation.status === DEVIATION_STATUS.COMPARED).length, 0);

  const text = renderInsightsText(comparison);
  assert.match(text, /NOT ENOUGH DATA TO COMPARE/);
  assert.match(text, /sample size 2 prior session\(s\); 5 required/);
  assert.match(text, /no comparison was invented in its place/);
  assert.doesNotMatch(text, /baseline: median of/, 'an insufficient result must not print a baseline it does not have');
  assert.doesNotMatch(text, /\d+\.\d+x/, 'no multiple may be printed without a baseline behind it');
});

test('a report with no session rows is reported as no history at all', () => {
  const report = { ...mcodeReport(), sessions: undefined };
  const comparison = compareToBaseline(null, report);
  assert.equal(comparison.status, INSIGHTS_STATUS.INSUFFICIENT);
  assert.equal(comparison.insufficientReason.code, 'no-history');
  assert.equal(comparison.insufficientReason.availableSessions, 0);
  assert.equal(comparison.baseline, null, 'there is nothing to build a baseline from');
  assert.equal(comparison.session.sessionId, null);
  assert.equal(comparison.deviations.length, INSIGHTS_METRICS.length);
  assert.equal(comparison.deviations.every((deviation) => deviation.value === null), true);

  const drivers = recurringDrivers([report]);
  assert.ok(drivers.insufficientReason, 'the missing per-session rows are named');
  assert.equal(drivers.insufficientReason.code, 'no-session-rows');
  assert.equal(drivers.range.sessions, 0);
  assert.deepEqual(drivers.days, []);
  // The report's own model costs are real and are still reported, with the gap named.
  assert.equal(drivers.modelSource, 'report model aggregate');
  assert.ok(drivers.topModels.length > 0);
  assert.equal(drivers.topModels[0].sessions, null, 'a report-level model row knows no session count');
});

test('the sample floor can be raised but never lowered below the five-session minimum', () => {
  const single = history(1);
  // A caller asking for a floor of one must still not get a comparison from one session.
  const lowered = compareToBaseline(OUTLIER, [...single, OUTLIER], { minSamples: 1 });
  assert.equal(lowered.minSamples, MIN_BASELINE_SESSIONS, 'the floor ignores attempts to lower it');
  assert.equal(lowered.status, INSIGHTS_STATUS.INSUFFICIENT);
  assert.equal(lowered.insufficientReason.required, MIN_BASELINE_SESSIONS);

  // Raising it works, and the raised number is what the output states.
  const raised = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { minSamples: 6 });
  assert.equal(raised.minSamples, 6);
  assert.equal(raised.status, INSIGHTS_STATUS.COMPARED);

  const stricter = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { minSamples: 8 });
  assert.equal(stricter.status, INSIGHTS_STATUS.INSUFFICIENT, 'six sessions cannot answer a question that needs eight');
  assert.equal(stricter.insufficientReason.required, 8);
});

test('the three reasons for not comparing stay distinguishable', () => {
  const noHistory = compareToBaseline(OUTLIER, []);
  assert.equal(noHistory.insufficientReason.code, 'no-history');

  const tooThin = compareToBaseline(OUTLIER, history(3));
  assert.equal(tooThin.insufficientReason.code, 'sample-too-small');

  // History is ample, but this session cannot supply cost at all, so blaming the history
  // would send the reader to fix the wrong thing.
  const unmeasurable = row({
    id: 'unmeasurable',
    start: '2026-09-20T10:00:00.000Z',
    end: '2026-09-20T10:30:00.000Z',
    cost: 0.000001,
    calls: 2,
    pricedCalls: 1,
    unpricedCalls: 1,
  });
  const target = compareToBaseline(unmeasurable, [...history(6), unmeasurable], { metrics: ['cost'] });
  assert.equal(target.insufficientReason.code, 'target-unmeasurable');
  assert.match(target.insufficientReason.message, /6 prior session\(s\) were available/);
});

test('nothing is measurable from an empty input, and nothing prints as a zero', () => {
  for (const comparison of [compareToBaseline(null, null), compareToBaseline(OUTLIER, [])]) {
    assert.equal(comparison.status, INSIGHTS_STATUS.INSUFFICIENT);
    assert.equal(comparison.baseline, null);
    assert.equal(comparison.deviations.every((deviation) => deviation.value === null), true);
  }

  const drivers = recurringDrivers([]);
  assert.equal(drivers.status, INSIGHTS_STATUS.INSUFFICIENT);
  assert.equal(drivers.rangeCostUsd, null);
  assert.equal(drivers.knownCostUsd, null);
  assert.equal(drivers.rangeCoverage, 'unknown');
  assert.equal(drivers.cacheHitRate, null);
  assert.deepEqual(drivers.topModels, []);
  assert.equal(drivers.subagentCostShare.aggregate.share, null);

  const text = renderInsightsText({ comparison: compareToBaseline(null, null), drivers });
  assert.doesNotMatch(text, /\$0\.000000/, 'an unmeasurable cost must never print as $0');
  assert.match(text, /NOT ENOUGH DATA/);
  assert.match(text, /no per-session rows and no per-model rows/);
});

test('an unpriced range prints "unavailable" for the total and never a smaller real number', () => {
  // The whole range failed to price. "Total: $0.000000" and "total: unavailable" are different
  // claims, and only the second one is true here.
  const report = {
    sessions: [
      row({
        id: 'priced',
        cost: 0.25,
        calls: 1,
        pricedCalls: 1,
        unpricedCalls: 0,
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        models: { 'p|priced-model': { provider: 'p', model: 'priced-model', cost: 0.25, calls: 1, unpricedCalls: 0, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      }),
      row({
        id: 'unpriced',
        cost: 4,
        calls: 2,
        pricedCalls: 1,
        unpricedCalls: 1,
        inputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        models: { 'p|unpriced-model': { provider: 'p', model: 'unpriced-model', cost: 4, calls: 2, unpricedCalls: 1, inputTokens: 10, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } },
      }),
    ],
  };
  const drivers = recurringDrivers(report);
  assert.equal(drivers.rangeCostUsd, null, 'a partly unpriced range has no total');
  assert.equal(drivers.knownCostUsd, 0.25, 'the priced portion is still reported on its own');
  assert.equal(drivers.rangeCoverage, 'partial');

  const text = renderInsightsText(drivers);
  assert.match(text, /range cost: unavailable \(coverage: partial, from per-model rows\); known portion \$0\.250000/);
  assert.doesNotMatch(text, /\$0\.000000/);
  assert.match(text, /1 model\(s\) could not be priced and are listed with an unavailable cost rather than \$0/);
});

// ---------------------------------------------------------------- describing, and the baseline in the open

test('a session far above its own median is described with its numbers', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER]);
  assert.equal(comparison.status, INSIGHTS_STATUS.COMPARED);
  assert.equal(comparison.basis, INSIGHTS_BASIS);
  assert.equal(comparison.scope, INSIGHTS_SCOPE);

  const cost = comparison.deviations.find((deviation) => deviation.metric === 'cost');
  assert.equal(cost.status, DEVIATION_STATUS.COMPARED);
  assert.equal(cost.value, 0.4);
  assert.equal(cost.baseline, 0.01);
  assert.equal(cost.ratio, 40);
  assert.equal(cost.ratioText, '40.0x');
  assert.equal(cost.sampleSize, 6);
  assert.equal(cost.notable, true);

  // The issue's own example: forty times the median cached-input volume, as a number.
  const cache = comparison.deviations.find((deviation) => deviation.metric === 'cacheReadTokens');
  assert.equal(cache.value, 1200);
  assert.equal(cache.baseline, 30);
  assert.equal(cache.ratio, 40);
  assert.equal(cache.ratioText, '40.0x');
});

test('the baseline is stated in full and can be recomputed by hand', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER]);
  const baseline = comparison.baseline;

  assert.equal(baseline.method, 'median');
  assert.equal(baseline.minSamples, MIN_BASELINE_SESSIONS);
  assert.equal(baseline.availableSessions, 6);
  assert.equal(baseline.sessionIdsCount, 6);
  assert.deepEqual(baseline.sessionIds, ['prior-0', 'prior-1', 'prior-2', 'prior-3', 'prior-4', 'prior-5']);
  assert.equal(baseline.window.from, '2026-09-10T10:00:00.000Z');
  assert.equal(baseline.window.to, '2026-09-15T10:00:00.000Z');
  assert.equal(baseline.excludedTarget, 1);
  assert.equal(baseline.excludedTargetBy, 'session-id');
  assert.equal(describeBaseline(baseline), baseline.statement);
  assert.match(baseline.statement, /median of 6 prior sessions between 2026-09-10T10:00:00\.000Z and 2026-09-15T10:00:00\.000Z/);

  // The value and the session that produced it, side by side: a reader can redo the median.
  const cost = baseline.metrics.cost;
  assert.equal(cost.n, 6);
  assert.equal(cost.median, median(cost.samples.map((sample) => sample.value)));
  assert.equal(cost.min, 0.01);
  assert.equal(cost.max, 0.01);
  assert.deepEqual(cost.samples.map((sample) => sample.sessionId), baseline.sessionIds);

  const text = renderInsightsText(comparison);
  assert.match(text, /baseline: median of 6 prior sessions between/);
  assert.match(text, /sample size 6 prior session\(s\); 5 required/);
  assert.match(text, /the target was excluded by session-id/);
});

test('the target is excluded from its own baseline, and duplicates are counted once', () => {
  const withTarget = compareToBaseline(OUTLIER, [...history(6), OUTLIER]);
  assert.equal(withTarget.baseline.availableSessions, 6);
  assert.equal(withTarget.baseline.excludedTarget, 1);
  assert.equal(withTarget.baseline.metrics.cost.median, 0.01, 'the outlier cannot pull its own median');

  // The same session reachable from two reports is one session.
  const duplicated = compareToBaseline(OUTLIER, [...history(6), history(6)[2], OUTLIER]);
  assert.equal(duplicated.baseline.availableSessions, 6);
  assert.equal(duplicated.baseline.duplicatesDropped, 1);
  assert.match(renderInsightsText(duplicated), /1 duplicate row\(s\) dropped/);

  // An id-less row is excluded by identity rather than silently compared against itself.
  const anonymous = { metrics: { calls: 1, cost: 0.5, unpricedCalls: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const identity = compareToBaseline(anonymous, [...history(6), anonymous]);
  assert.equal(identity.baseline.excludedTarget, 1);
  assert.equal(identity.baseline.excludedTargetBy, 'object-identity');
  assert.equal(identity.session.sessionId, null);
});

test('a zero median yields no multiple rather than Infinity', () => {
  // Six genuinely empty sessions: a real measured zero, not an unknown.
  const empty = Array.from({ length: 6 }, (_, index) => row({
    id: `empty-${index}`,
    start: `2026-09-1${index}T10:00:00.000Z`,
    cost: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
  }));
  const comparison = compareToBaseline(OUTLIER, [...empty, OUTLIER], { metrics: ['cost'] });
  const cost = comparison.deviations[0];
  assert.equal(cost.status, DEVIATION_STATUS.COMPARED);
  assert.equal(cost.baseline, 0);
  assert.equal(cost.ratio, null, 'a multiple of zero is not a number');
  assert.equal(cost.ratioText, null);
  assert.match(cost.ratioNote, /divide by zero/);
  assert.equal(cost.notable, false, 'and it cannot be marked notable without a multiple');

  const text = renderInsightsText(comparison);
  assert.doesNotMatch(text, /Infinity|NaN|undefined/);
  assert.match(text, /n\/a/, 'the multiple column says it has none');
  assert.match(text, /the median cost across these 6 session\(s\) is 0, so a multiple of it would divide by zero/);
});

test('an unpriced session is left out of the baseline instead of counting as free', () => {
  // Two of the eight prior sessions never priced. Folded in as zero they would halve the
  // median and make every priced session look like it doubled.
  const unpriced = row({
    id: 'unpriced-history',
    start: '2026-09-20T10:00:00.000Z',
    end: '2026-09-20T10:30:00.000Z',
    cost: 0.9,
    calls: 2,
    pricedCalls: 1,
    unpricedCalls: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
  });
  const comparison = compareToBaseline(OUTLIER, [...history(6), unpriced, unpriced, OUTLIER], { metrics: ['cost'] });
  const cost = comparison.deviations[0];
  assert.equal(cost.status, DEVIATION_STATUS.COMPARED);
  assert.equal(cost.sampleSize, 6, 'only the six priced sessions may enter the baseline');
  assert.equal(cost.baselineStats.n, 6);
  assert.equal(cost.baseline, 0.01, 'the unpriced 0.9 never became a 0 and never entered');
  assert.equal(cost.baselineStats.samples.some((sample) => sample.sessionId === 'unpriced-history'), false);
  assert.equal(sessionCostUsd(unpriced), null);
});

test('a target that cannot be measured is not compared, and is never reported as zero', () => {
  const unmeasurable = row({
    id: 'unmeasurable',
    start: '2026-09-20T10:00:00.000Z',
    end: '2026-09-20T10:30:00.000Z',
    cost: 0.000001,
    calls: 2,
    pricedCalls: 1,
    unpricedCalls: 1,
    inputTokens: 1000,
    outputTokens: 100,
    cacheReadTokens: 30,
    cacheWriteTokens: 10,
  });
  const comparison = compareToBaseline(unmeasurable, [...history(6), unmeasurable], { metrics: ['cost', 'calls'] });
  const cost = comparison.deviations.find((deviation) => deviation.metric === 'cost');
  assert.equal(cost.status, DEVIATION_STATUS.NOT_COMPARABLE);
  assert.equal(cost.value, null, 'the tiny recorded cost must not stand in for the unpriced one');
  assert.notEqual(cost.value, 0);
  assert.equal(cost.ratio, null);
  assert.equal(cost.notable, false);
  assert.match(cost.note, /1 of 2 call\(s\) carry no rate/);
  assert.equal(cost.baseline, 0.01, 'the baseline itself is still available and is shown');

  // A metric the target can supply is still compared, so one unknown does not blind the rest.
  const calls = comparison.deviations.find((deviation) => deviation.metric === 'calls');
  assert.equal(calls.status, DEVIATION_STATUS.COMPARED);
  assert.equal(calls.value, 2);
  assert.equal(comparison.status, INSIGHTS_STATUS.COMPARED);

  const text = renderInsightsText(comparison);
  assert.match(text, /cost could not be measured for this session, so it is reported as unavailable rather than as a number/);
  assert.doesNotMatch(text, /\$0\.000000/);
});

// ---------------------------------------------------------------- cache-hit rate, which is not one number

test('a cache-hit rate is only computed once its denominator is named', () => {
  // The two runtimes divide by different totals, so computing one silently would report a
  // rate the ledger never measured. With no basis named, the history cannot produce a rate
  // either, so this is honestly "insufficient data" rather than a comparison.
  const unnamed = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { metrics: ['cacheHitRate'] });
  const rate = unnamed.deviations[0];
  assert.equal(unnamed.status, INSIGHTS_STATUS.INSUFFICIENT);
  assert.equal(rate.status, DEVIATION_STATUS.INSUFFICIENT);
  assert.equal(rate.value, null);
  assert.equal(rate.baseline, null);
  assert.match(rate.note, /needs its denominator named/);
  assert.match(rate.note, /input-including-cache/);
  assert.match(rate.note, /prompt-including-cache-write/);

  // Cline divides cached reads by input tokens, which already include cache.
  const clineBasis = compareToBaseline(OUTLIER, [...history(6), OUTLIER], {
    metrics: ['cacheHitRate'],
    cacheRateBasis: 'input-including-cache',
  });
  assert.equal(clineBasis.deviations[0].status, DEVIATION_STATUS.COMPARED);
  assert.equal(clineBasis.deviations[0].value, 1200 / 9000);
  assert.match(clineBasis.deviations[0].note, /cache-hit rate basis: input-including-cache/);

  // MCode divides by prompt tokens, which add the cache writes. The same rows give a
  // different number, which is the whole reason the basis has to be named.
  const mcodeBasis = compareToBaseline(OUTLIER, [...history(6), OUTLIER], {
    metrics: ['cacheHitRate'],
    cacheRateBasis: 'prompt-including-cache-write',
  });
  assert.equal(mcodeBasis.deviations[0].value, 1200 / (9000 + 1200 + 40));
  assert.notEqual(clineBasis.deviations[0].value, mcodeBasis.deviations[0].value);
  assert.equal(clineBasis.deviations[0].baselineStats.median, 30 / 1000);

  // A row that carries its own rate is taken as measured, whichever runtime wrote it, and no
  // basis is needed because the runtime already applied its own.
  const withRate = (id, rate, day) => row({
    id,
    start: `2026-09-${String(day).padStart(2, '0')}T10:00:00.000Z`,
    cost: 0.02,
    calls: 1,
    pricedCalls: 1,
    unpricedCalls: 0,
    cacheRate: rate,
    inputTokens: 100,
    outputTokens: 1,
    cacheReadTokens: 25,
    cacheWriteTokens: 5,
  });
  const priorRates = [10, 11, 12, 13, 14, 15].map((day) => withRate(`rate-${day}`, 0.25, day));
  const targetRate = withRate('rate-target', 0.5, 20);
  const recorded = compareToBaseline(targetRate, [...priorRates, targetRate], { metrics: ['cacheHitRate'] });
  assert.equal(recorded.status, INSIGHTS_STATUS.COMPARED);
  assert.equal(recorded.deviations[0].value, 0.5);
  assert.equal(recorded.deviations[0].baseline, 0.25);
  assert.match(recorded.deviations[0].note, /as-recorded-on-the-session-row/);
});

test('a session row with no input tokens has no rate, rather than a rate of zero', () => {
  const blank = row({ id: 'blank', cost: 0.01, calls: 1, pricedCalls: 1, unpricedCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const comparison = compareToBaseline(blank, [...history(6), blank], {
    metrics: ['cacheHitRate'],
    cacheRateBasis: 'input-including-cache',
  });
  assert.equal(comparison.deviations[0].value, null);
  assert.match(comparison.deviations[0].note, /no denominator/);
});

// ---------------------------------------------------------------- recurring drivers over a range

test('drivers measured on a real report reconcile with that report', () => {
  const report = clineReport();
  const drivers = recurringDrivers([report]);

  // The whole point of these numbers is that they are the ledger's own, addable.
  assert.equal(drivers.rangeCostUsd, report.billing.amountUsd);
  assert.equal(drivers.rangeCoverage, 'complete');
  assert.equal(drivers.modelSource, 'per-session model rows');
  assert.equal(drivers.range.sessions, report.sessions.length);
  assert.equal(drivers.cacheHitRate.value, report.usage.cacheHitRate);
  assert.equal(drivers.cacheHitRate.inputTokenMeaning, report.usage.semantics.inputTokenMeaning);

  const modelSum = drivers.topModels.reduce((sum, model) => sum + model.costUsd, 0);
  assert.equal(modelSum, report.billing.amountUsd, 'the per-model rows must add up to the reported total');
  assert.equal(drivers.topModels.reduce((sum, model) => sum + model.shareOfKnownCost, 0), 1);
  assert.equal(drivers.topModels[0].model, 'root-model');
  assert.equal(drivers.topModels[0].costUsd, 0.1);
  assert.equal(drivers.topModels[0].sessions, 1);
  assert.equal(drivers.allDayCount, 1, 'the whole fixture tree started on one UTC day');
});

test('a real subagent share is the child cost over its own parent cost', () => {
  const report = clineReport();
  const drivers = recurringDrivers([report]);
  const root = drivers.subagentCostShare.perParent.find((entry) => entry.parentSessionId === 'cline-root');
  const rootRow = report.sessions.find((entry) => entry.row.sessionId === 'cline-root');
  assert.deepEqual(root.subagentIds, ['cline-child']);
  assert.equal(root.parentCostUsd, rootRow.metrics.cost, 'the parent cost is the report\'s own figure, not a recomputed one');
  assert.equal(root.subagentCostUsd, 0.02);
  assert.equal(root.share, 0.02 / rootRow.metrics.cost);
  assert.equal(root.coverage, 'complete');

  const child = drivers.subagentCostShare.perParent.find((entry) => entry.parentSessionId === 'cline-child');
  assert.equal(child.subagentCostUsd, 0.01);
  assert.equal(child.share, 0.5);
  assert.equal(drivers.subagentCostShare.aggregate.parents, 2);
  assert.equal(drivers.subagentCostShare.aggregate.subagents, 2);
});

test('a subagent share is null when either side of the ratio is unknown', () => {
  const sessions = [
    row({ id: 'parent', cost: 1, calls: 1, pricedCalls: 1, unpricedCalls: 0 }),
    row({ id: 'priced-child', parent: 'parent', cost: 0.2, calls: 1, pricedCalls: 1, unpricedCalls: 0, start: '2026-09-11T10:00:00.000Z' }),
    row({ id: 'unpriced-child', parent: 'parent', cost: 5, calls: 1, pricedCalls: 0, unpricedCalls: 1, start: '2026-09-12T10:00:00.000Z' }),
  ];
  const drivers = recurringDrivers({ sessions });
  const parent = drivers.subagentCostShare.perParent[0];
  assert.equal(parent.parentCostUsd, 1);
  assert.equal(parent.subagentCostUsd, null, 'a known 0.2 out of an unknown total is not a 0.2 share');
  assert.equal(parent.knownSubagentCostUsd, 0.2);
  assert.equal(parent.share, null);
  assert.equal(parent.coverage, 'partial');
  assert.match(parent.note, /unavailable rather than small/);
  assert.equal(drivers.subagentCostShare.aggregate.share, null);

  const text = renderInsightsText(drivers);
  assert.match(text, /share unavailable/);
  assert.doesNotMatch(text, /20\.0%/);

  // A parent that measured nothing has no denominator, which is not a 0% share either.
  const free = recurringDrivers({
    sessions: [
      row({ id: 'free-parent', cost: 0, calls: 0, pricedCalls: 0, unpricedCalls: 0 }),
      row({ id: 'free-child', parent: 'free-parent', cost: 0.2, calls: 1, pricedCalls: 1, unpricedCalls: 0, start: '2026-09-11T10:00:00.000Z' }),
    ],
  });
  const freeParent = free.subagentCostShare.perParent[0];
  assert.equal(freeParent.parentCostUsd, 0);
  assert.equal(freeParent.share, null);
  assert.match(freeParent.note, /no denominator/);
});

test('days and weekdays are UTC buckets ranked by what they measured', () => {
  // 2026-09-21 is a Monday, so these four sessions fall on three different weekdays. The most
  // expensive day is deliberately the LATEST date, so a ranking that quietly fell back to
  // date order or insertion order would name Monday instead and be caught.
  const sessions = [
    row({ id: 'mon-a', start: '2026-09-21T09:00:00.000Z', cost: 1, calls: 2, pricedCalls: 2, unpricedCalls: 0 }),
    row({ id: 'tue-a', start: '2026-09-22T09:00:00.000Z', cost: 8, calls: 2, pricedCalls: 2, unpricedCalls: 0 }),
    row({ id: 'tue-b', start: '2026-09-22T10:00:00.000Z', cost: 1, calls: 2, pricedCalls: 2, unpricedCalls: 0 }),
    row({ id: 'wed-a', start: '2026-09-23T09:00:00.000Z', cost: 9, calls: 2, pricedCalls: 0, unpricedCalls: 2 }),
  ];
  const drivers = recurringDrivers({ sessions });

  assert.equal(drivers.allDayCount, 3);
  assert.equal(drivers.mostExpensiveDay.day, '2026-09-22', 'ranked by what the day measured, not by its date');
  assert.deepEqual(drivers.days.map((day) => day.day), ['2026-09-22', '2026-09-21', '2026-09-23']);
  assert.equal(drivers.mostExpensiveDay.costUsd, 9, 'both Tuesday sessions are attributed to Tuesday');
  assert.equal(drivers.mostExpensiveDay.weekday, 'Tuesday');
  assert.equal(drivers.mostExpensiveDay.sessions, 2);

  // The unpriced day is last and says so, rather than ranking as the cheapest day there was.
  const wednesday = drivers.days.find((day) => day.day === '2026-09-23');
  assert.equal(wednesday.costUsd, null);
  assert.equal(wednesday.knownCostUsd, 0);
  assert.equal(wednesday.coverage, 'partial');
  assert.equal(drivers.days[drivers.days.length - 1].day, '2026-09-23');

  assert.equal(drivers.mostExpensiveWeekday.weekday, 'Tuesday');
  assert.equal(drivers.mostExpensiveWeekday.costUsd, 9);
  assert.deepEqual(drivers.weekdays.map((entry) => entry.weekday), ['Tuesday', 'Monday', 'Wednesday']);
  assert.equal(drivers.mostExpensiveWeekday.days, 1);
});

test('a session with no start time is counted but not bucketed into a day', () => {
  const undated = { row: { sessionId: 'undated', parentSessionId: null }, metrics: { calls: 1, cost: 1, pricedCalls: 1, unpricedCalls: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 } };
  const drivers = recurringDrivers({ sessions: [undated, ...history(3)] });
  assert.equal(drivers.range.sessions, 4);
  assert.equal(drivers.range.sessionsWithoutStart, 1);
  assert.equal(drivers.range.from, '2026-09-10T10:00:00.000Z');
  assert.match(renderInsightsText(drivers), /across 4 session\(s\) in 1 report\(s\)/);
});

// ---------------------------------------------------------------- no forecasting, ever

// Forward-looking phrasing. Every one of these would attach a number to a period that has not
// happened, which is the one thing this module must never do. The disclaimer is worded
// without any of this vocabulary, so the rendered output can be checked for it directly.
const FORWARD_LOOKING = [
  /\bforecast\w*/i,
  /\bpredict\w*/i,
  /\bextrapolat\w*/i,
  /\bproject\w*/i,
  /\bwill (?:be|spend|cost|total|reach|come|likely)/i,
  /\bgoing to\b/i,
  /\bnext (?:week|month|year|period|quarter|tuesday|wednesday|monday|friday|saturday|sunday|thursday)\b/i,
  /\bupcoming\b/i,
  /\bon track\b/i,
  /\bat this rate\b/i,
  /\brun rate\b/i,
  /\bspend per (?:day|week|month)\b/i,
  /\bper-(?:day|week|month) rate\b/i,
  /\b(?:monthly|annual|annualized|annualised) (?:cost|spend|total|budget)\b/i,
  /\bexpected (?:spend|cost|total|to)\b/i,
  /\bby the end of\b/i,
  /\bimplied (?:spend|cost|total)\b/i,
  /\bif you keep\b/i,
];

// Collect every object key anywhere in a result, at any depth.
function collectKeys(value, found = new Set()) {
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  if (!value || typeof value !== 'object') return found;
  for (const [key, nested] of Object.entries(value)) {
    found.add(key);
    collectKeys(nested, found);
  }
  return found;
}

test('no result object carries a field that could be read as a projection', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER], {
    cacheRateBasis: 'input-including-cache',
  });
  const drivers = recurringDrivers(clineReport());
  const forbidden = /forecast|predict|project|extrapolat|expected|future|upcoming|outlook|trend|trajector|perMonth|perDay|runRate|run_rate|monthly|annual|pace|nextWeek|nextMonth|nextDay/i;
  for (const key of collectKeys({ comparison, drivers })) {
    assert.doesNotMatch(key, forbidden, `the field "${key}" reads as a projection`);
  }
  // And the two markers that pin the scope are present on both halves.
  assert.equal(comparison.basis, 'measured-history');
  assert.equal(comparison.scope, 'past-only');
  assert.equal(drivers.basis, 'measured-history');
  assert.equal(drivers.scope, 'past-only');
});

test('no rendered output can be read as a claim about spend that has not happened', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { cacheRateBasis: 'input-including-cache' });
  const outputs = [
    renderInsightsText({ comparison, drivers: recurringDrivers(clineReport()) }),
    renderInsightsText(comparison),
    renderInsightsText(recurringDrivers(clineReport())),
    renderInsightsText(recurringDrivers(mcodeReport())),
    renderInsightsText(compareToBaseline(null, null)),
    renderInsightsText(recurringDrivers([])),
    renderInsightsText(null),
    renderInsightsText({}),
    // A range with subagents, weekdays, and an unpriced model all in one.
    renderInsightsText(recurringDrivers({
      sessions: [
        ...history(6),
        row({ id: 'parent', start: '2026-09-21T09:00:00.000Z', cost: 1, calls: 1, pricedCalls: 1, unpricedCalls: 0 }),
        row({ id: 'kid', parent: 'parent', start: '2026-09-22T09:00:00.000Z', cost: 0.2, calls: 1, pricedCalls: 0, unpricedCalls: 1 }),
      ],
    })),
  ];

  for (const output of outputs) {
    // Both halves of the scope statement, not just the reassuring one, so deleting either
    // sentence is a failure.
    assert.match(output, /every number below is a measurement of sessions that already happened/);
    assert.match(output, /Nothing here makes a claim about spend that has not happened yet/);
    for (const pattern of FORWARD_LOOKING) {
      assert.doesNotMatch(output, pattern, `the output contains forward-looking phrasing: ${output}`);
    }
  }

  // No arithmetic that would imply a period total: nothing scales a measured day or session up.
  for (const output of outputs) {
    assert.doesNotMatch(output, /\/ ?7\b/, 'nothing divides by a week to make a period total');
    assert.doesNotMatch(output, /\* ?30\b/, 'nothing multiplies by a month to make a period total');
    assert.doesNotMatch(output, /\* ?365\b/, 'nothing multiplies by a year to make a period total');
  }
});

test('the module has no time-scaling arithmetic anywhere in its source', () => {
  // The tests above check the output. This checks the implementation, so a projection cannot
  // be added and left unexercised.
  const source = fs.readFileSync(path.join(repositoryRoot, 'shared', 'insights.mjs'), 'utf8');
  const code = source
    .split('\n')
    .filter((line) => !/^\s*(\/\/|\*|\/\*)/.test(line))
    .join('\n');
  assert.doesNotMatch(code, /\b30\s*\*|\*\s*30\b/, 'no monthly scaling');
  assert.doesNotMatch(code, /\b365\b|\b52\b|\b4\s*\*\s*7\b/, 'no yearly or weekly scaling');
  assert.doesNotMatch(code, /\/\s*7\b|\/=\s*7/, 'no weekly average');
  assert.doesNotMatch(code, /Date\.now\(\)/, 'nothing reads the current time to look forward');
  assert.doesNotMatch(code, /new Date\(\)\.getTime\(\)|performance\.now/, 'no implicit clock');
});

// ---------------------------------------------------------------- describing, not judging

test('the output states measurements and never delivers a verdict', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { cacheRateBasis: 'input-including-cache' });
  const output = renderInsightsText({ comparison, drivers: recurringDrivers(clineReport()) });

  // The numbers and the baseline are all there, which is what makes the line falsifiable.
  assert.match(output, /\$0\.400000/, 'the session\'s own measured cost');
  assert.match(output, /\$0\.010000/, 'the baseline it was compared against');
  assert.match(output, /40\.0x/);
  assert.match(output, /median of 6 prior sessions/);
  assert.match(output, /n=6|the median of 6 prior session/);

  // And no adjective about whether any of it is good.
  const judgement = /\b(expensive|cheap(?:er|est)?|wasteful|wasted|waste|over-?budget|too much|too many|too few|problematic|alarming|outrageous|spiky?|spike|badly|bad|good|wrong|should have|you should|recommend\w*|concerning|risky|abuse\w*|unnecessary|needless|excessive)\b/i;
  assert.doesNotMatch(output, judgement, `the output delivers a verdict: ${output}`);

  // The mark on a row is arithmetic and says which arithmetic.
  assert.match(output, /marked \* at 2x the baseline median or less, which is arithmetic, not a verdict/);
});

test('buildInsights wires both halves to one report and renders them together', () => {
  const report = clineReport();
  const result = buildInsights(report);
  assert.equal(result.comparison.session.sessionId, 'cline-root', 'the report\'s own session is the one compared');
  assert.equal(result.comparison.status, INSIGHTS_STATUS.INSUFFICIENT, 'three sessions cannot support a comparison');
  assert.equal(result.drivers.rangeCostUsd, report.billing.amountUsd);
  const output = renderInsightsText(result);
  assert.match(output, /Compared session: cline-root/);
  assert.match(output, /Recurring drivers, measured over/);
  assert.equal(output.split('NOT ENOUGH DATA TO COMPARE').length, 2, 'printed once, not once per section');
});

test('the renderer takes either half on its own and says so when given neither', () => {
  const comparison = compareToBaseline(OUTLIER, [...history(6), OUTLIER]);
  const drivers = recurringDrivers(clineReport());
  assert.match(renderInsightsText(comparison), /Compared session: outlier/);
  assert.doesNotMatch(renderInsightsText(comparison), /Recurring drivers/);
  assert.match(renderInsightsText(drivers), /Recurring drivers/);
  assert.doesNotMatch(renderInsightsText(drivers), /Compared session/);
  assert.match(renderInsightsText(null), /nothing to describe/);
  assert.match(renderInsightsText({}), /nothing to describe/);
  // The scope line survives even when there is nothing to scope.
  assert.match(renderInsightsText(null), /sessions that already happened/);
});

test('a range with sessions but no model breakdown is totalled from the sessions', () => {
  // Six measured session costs are real. Reporting "unknown" because no per-model breakdown
  // accompanied them would discard six measurements over a missing convenience.
  const drivers = recurringDrivers({ sessions: history(6, { cost: 0.02 }) });
  assert.equal(drivers.modelSource, 'none');
  assert.equal(drivers.allModelCount, 0);
  assert.equal(drivers.rangeSource, 'session costs');
  close(drivers.rangeCostUsd, 0.12, 'the six session costs add up');
  close(drivers.knownCostUsd, 0.12);
  assert.equal(drivers.rangeCoverage, 'complete');

  // One unpriced session in the range still makes the total unavailable.
  const partial = recurringDrivers({
    sessions: [
      ...history(6, { cost: 0.02 }),
      row({ id: 'unpriced', start: '2026-09-20T10:00:00.000Z', cost: 3, calls: 1, pricedCalls: 0, unpricedCalls: 1, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ],
  });
  assert.equal(partial.rangeCostUsd, null, 'a measured 0.12 out of an unknown total is not the total');
  close(partial.knownCostUsd, 0.12);
  assert.equal(partial.rangeCoverage, 'partial');
  assert.equal(partial.rangeSource, 'session costs');

  // And the per-model rows still win where both exist, so nothing is counted twice.
  const report = clineReport();
  assert.equal(recurringDrivers([report]).rangeSource, 'per-model rows');
  assert.equal(recurringDrivers([report]).rangeCostUsd, report.billing.amountUsd);
});

test('a duration needs both ends of the session, and a sane order', () => {
  // A row with a start and no end has no duration. Reporting zero would make an open session
  // look like the fastest one in the range.
  const openEnded = row({
    id: 'open-ended',
    start: '2026-09-20T10:00:00.000Z',
    end: undefined,
    cost: 0.01,
    calls: 1,
    pricedCalls: 1,
    unpricedCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  delete openEnded.row.endedAt;

  const backwards = row({
    id: 'backwards',
    start: '2026-09-20T12:00:00.000Z',
    end: '2026-09-20T11:00:00.000Z',
    cost: 0.01,
    calls: 1,
    pricedCalls: 1,
    unpricedCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  for (const broken of [openEnded, backwards]) {
    const comparison = compareToBaseline(broken, [...history(6), broken], { metrics: ['durationMs'] });
    const duration = comparison.deviations[0];
    assert.equal(duration.value, null, `${broken.row.sessionId} has no usable duration`);
    assert.notEqual(duration.value, 0);
    assert.equal(duration.status, DEVIATION_STATUS.NOT_COMPARABLE);
    assert.match(duration.note, /usable start and end time|ends before it starts/);
    assert.equal(comparison.status, INSIGHTS_STATUS.INSUFFICIENT, 'and no duration comparison is produced for it');
  }

  // A row whose start and end are both present still measures, in milliseconds.
  const measured = compareToBaseline(OUTLIER, [...history(6), OUTLIER], { metrics: ['durationMs'] });
  assert.equal(measured.deviations[0].status, DEVIATION_STATUS.COMPARED);
  assert.equal(measured.deviations[0].value, 3_600_000);
  assert.equal(measured.deviations[0].baseline, 1_800_000);
  assert.equal(measured.deviations[0].ratio, 2);
});

test('a call count the ledger never recorded is unavailable, not zero', () => {
  // An aggregate-only session has no call count. Zero would say "this session made no calls",
  // which is a different and much stronger claim than "the ledger did not count them".
  const uncounted = row({
    id: 'uncounted',
    start: '2026-09-20T10:00:00.000Z',
    end: '2026-09-20T10:30:00.000Z',
    cost: 0.01,
    calls: 4,
    pricedCalls: 4,
    unpricedCalls: 0,
    callCountKnown: false,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });
  const comparison = compareToBaseline(uncounted, [...history(6), uncounted], { metrics: ['calls', 'cost'] });
  const calls = comparison.deviations.find((deviation) => deviation.metric === 'calls');
  assert.equal(calls.status, DEVIATION_STATUS.NOT_COMPARABLE);
  assert.equal(calls.value, null);
  assert.notEqual(calls.value, 0);
  assert.match(calls.note, /did not record a call count/);
  assert.equal(calls.baseline, 2, 'the history did record its own calls, so that baseline still holds');
  assert.equal(comparison.status, INSIGHTS_STATUS.COMPARED, 'the cost comparison is unaffected');

  const text = renderInsightsText(comparison);
  assert.doesNotMatch(text, /LLM calls\s+unavailable\s+2\s+0\.0x/, 'an unknown count is never divided into a multiple');
});

test('a subagent count is the children present in the set, named', () => {
  const target = row({ id: 'orchestrator', start: '2026-09-20T10:00:00.000Z', end: '2026-09-20T10:30:00.000Z', cost: 0.2, calls: 4, pricedCalls: 4, unpricedCalls: 0, inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0 });
  const children = ['kid-a', 'kid-b'].map((id, index) => row({
    id,
    parent: 'orchestrator',
    start: `2026-09-20T10:0${index}:00.000Z`,
    end: `2026-09-20T10:0${index}:30.000Z`,
    cost: 0.01,
    calls: 1,
    pricedCalls: 1,
    unpricedCalls: 0,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  }));
  const comparison = compareToBaseline(target, [...history(6), ...children, target], { metrics: ['subagentCount'] });
  const subagents = comparison.deviations[0];
  assert.equal(subagents.status, DEVIATION_STATUS.COMPARED);
  assert.equal(subagents.value, 2, 'both children of the target are counted');
  assert.equal(subagents.baseline, 0, 'the prior sessions had no children in the set');
  assert.equal(subagents.ratio, null, 'a multiple of a zero median is not a number');
  assert.match(subagents.ratioNote, /divide by zero/);
});

test('a real report row renders its session id, not "unknown session"', () => {
  // Regression: sessionIdOf read only entry.row.sessionId, so a real report row rendered
  // as "unknown session" even though the id was present. The teammate's own fixtures used
  // a flat {sessionId} shape, which is why 35 tests passed while the real shape was broken.
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
  const rows = report.sessions.map((entry) => ({ row: entry.row, metrics: entry.metrics }));
  const rendered = renderInsightsText(compareToBaseline(rows[0], rows));
  assert.match(rendered, new RegExp(`Compared session: ${rows[0].row.sessionId}`), 'the real id must be shown');
  assert.doesNotMatch(rendered, /unknown session/);
});
