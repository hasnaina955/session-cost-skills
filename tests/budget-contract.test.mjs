import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BUDGET_EXIT_CODES,
  BUDGET_SCOPES,
  BUDGET_STATUS,
  elapsedMsFromReport,
  evaluateBudget,
  evaluateReportBudget,
  formatElapsed,
  formatUsd,
  isKnownCostUsd,
} from '../shared/budget.mjs';
import { createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

// fileURLToPath, never `new URL(...).pathname`: a path built from a URL pathname starts
// with a drive-relative `/C:/...` segment on Windows and resolves to the wrong file.
const testsDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(testsDirectory, '..');
const budgetSource = fs.readFileSync(path.join(repositoryRoot, 'shared', 'budget.mjs'), 'utf8');
const normalizedReportSchema = JSON.parse(fs.readFileSync(
  path.join(repositoryRoot, 'contracts', 'normalized-report-v1.schema.json'),
  'utf8',
));

const RECORDED = 'runtime-recorded';
const ESTIMATED = 'provider-rate-estimate';

// A report is read once and reused: each fixture costs several CLI processes, and a
// budget verdict is a pure function of the report, so re-running the CLI per assertion
// would add latency without adding coverage.
let clineFixture = null;
let mcodeFixture = null;
const clineReports = new Map();
const mcodeReports = new Map();

function cline() {
  if (clineFixture === null) clineFixture = createClineFixture();
  return clineFixture;
}

function mcode() {
  if (mcodeFixture === null) mcodeFixture = createMCodeFixture();
  return mcodeFixture;
}

function clineReport(sessionId) {
  if (!clineReports.has(sessionId)) {
    const fixture = cline();
    const { result, output } = runJson(fixture.script, fixture.dataDir, ['--session', sessionId]);
    assert.equal(result.status, 0, `Cline must report ${sessionId}: ${result.stderr}`);
    assert.notEqual(output, null, `Cline must emit JSON for ${sessionId}`);
    clineReports.set(sessionId, output);
  }
  return clineReports.get(sessionId);
}

function mcodeReport(args) {
  const key = args.join(' ');
  if (!mcodeReports.has(key)) {
    const fixture = mcode();
    const { result, output } = runJson(fixture.script, fixture.dataDir, args, fixture.environment);
    // MCode exits 2 on an unpriceable report, so only a parseable body is asserted here.
    assert.notEqual(output, null, `MCode must emit JSON for ${key}: ${result.stderr}`);
    mcodeReports.set(key, output);
  }
  return mcodeReports.get(key);
}

after(() => {
  for (const fixture of [clineFixture, mcodeFixture]) {
    if (fixture !== null) fs.rmSync(fixture.dataDir, { recursive: true, force: true });
  }
});

/** The fields of a complete, priced report that a budget verdict actually reads. */
function pricedReport(overrides = {}) {
  return { amountUsd: 4.2, budget: 5, coverage: 'complete', basis: RECORDED, ...overrides };
}

test('a spend under the limit is the only quiet verdict', () => {
  const verdict = evaluateBudget(pricedReport({ sessionId: 'cline-root', elapsedMs: 3_600_002 }));
  assert.equal(verdict.status, BUDGET_STATUS.OK);
  assert.equal(verdict.exitCode, 0);
  assert.equal(verdict.alert, false);
  assert.equal(verdict.reason, 'under-budget');
  assert.equal(verdict.message, null, 'nothing to warn about means no warning line');
  assert.equal(verdict.percentUsed, 84);
  assert.equal(verdict.overByUsd, null);
  assert.equal(verdict.settled, true);
});

test('sitting exactly on the limit has not passed it', () => {
  // A cap alerts when the threshold is *passed*, so the line itself is still inside.
  const onTheLine = evaluateBudget(pricedReport({ amountUsd: 5, budget: 5 }));
  assert.equal(onTheLine.status, BUDGET_STATUS.OK);
  assert.equal(onTheLine.exitCode, 0);
  assert.equal(onTheLine.percentUsed, 100);
  assert.equal(onTheLine.overByUsd, null);

  const oneCentOver = evaluateBudget(pricedReport({ amountUsd: 5.01, budget: 5 }));
  assert.equal(oneCentOver.status, BUDGET_STATUS.EXCEEDED);
  assert.notEqual(oneCentOver.exitCode, 0);
  assert.equal(oneCentOver.percentUsed, 100.2);
  // Floating-point sums make this the value most likely to leak 0.010000000000000231.
  assert.equal(oneCentOver.overByUsd, 0.01);
});

test('a zero budget is legal and blocks any spend at all', () => {
  const nothingSpent = evaluateBudget(pricedReport({ amountUsd: 0, budget: 0, coverage: 'no-calls' }));
  assert.equal(nothingSpent.status, BUDGET_STATUS.OK);
  assert.equal(nothingSpent.exitCode, 0);
  assert.equal(nothingSpent.percentUsed, 0);

  const oneCent = evaluateBudget(pricedReport({ amountUsd: 0.01, budget: 0 }));
  assert.equal(oneCent.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(oneCent.exitCode, 3);
  assert.equal(oneCent.overByUsd, 0.01);
  // Zero has no meaningful ratio: any spend is infinitely over it.
  assert.equal(oneCent.percentUsed, null);
  assert.match(oneCent.message, /a zero session budget/);
});

test('an unpriceable spend is never reported as under budget', () => {
  // The regression this module exists to prevent. Every one of these would compare as
  // "less than the limit" under a naive implementation.
  const unpriceable = [
    ['null', null],
    ['undefined', undefined],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['negative Infinity', Number.NEGATIVE_INFINITY],
    ['a numeric string', '0.04'],
    ['a negative amount', -1],
    ['an object', { usd: 0.04 }],
    ['a boolean', false],
  ];
  for (const [label, amountUsd] of unpriceable) {
    const verdict = evaluateBudget({ amountUsd, budget: 5, coverage: 'complete', basis: RECORDED });
    assert.equal(verdict.status, BUDGET_STATUS.UNKNOWN, `${label} must not read as under budget`);
    assert.notEqual(verdict.status, BUDGET_STATUS.OK, `${label} must not read as under budget`);
    assert.notEqual(verdict.exitCode, 0, `${label} must not exit zero`);
    assert.equal(verdict.alert, true, `${label} must warn`);
    assert.equal(verdict.reason, 'cost-unavailable', label);
    assert.equal(verdict.amountUsd, null, `${label} must not be passed on as a number`);
    assert.equal(verdict.percentUsed, null, label);
    assert.equal(verdict.overByUsd, null, label);
  }
});

test('a partial total is a lower bound, so it cannot confirm a limit was respected', () => {
  // One of the two calls in this session was never priced, so $0.04 says nothing about
  // whether the real total cleared $5.
  const partial = evaluateBudget(pricedReport({ amountUsd: 0.04, budget: 5, coverage: 'partial' }));
  assert.equal(partial.status, BUDGET_STATUS.UNKNOWN);
  assert.equal(partial.exitCode, 2);
  assert.equal(partial.reason, 'coverage-unsettled');
  assert.equal(partial.settled, false);
  assert.match(partial.message, /so the limit is not confirmed/);

  // The same partial amount can still prove a budget was blown.
  const partialButOver = evaluateBudget(pricedReport({ amountUsd: 6, budget: 5, coverage: 'partial' }));
  assert.equal(partialButOver.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(partialButOver.exitCode, 3);
});

test('every coverage the report contract allows is classified one way or the other', () => {
  const allowed = normalizedReportSchema.$defs.coverage.properties.status.enum;
  assert.ok(allowed.includes('partial') && allowed.includes('complete'), 'the contract must still describe coverage states');

  for (const coverage of allowed) {
    const verdict = evaluateBudget(pricedReport({ coverage }));
    if (coverage === 'complete' || coverage === 'no-calls') {
      assert.equal(verdict.status, BUDGET_STATUS.OK, `${coverage} is a settled total`);
      assert.equal(verdict.exitCode, 0, coverage);
    } else {
      assert.equal(verdict.status, BUDGET_STATUS.UNKNOWN, `${coverage} cannot confirm a limit`);
      assert.equal(verdict.exitCode, 2, coverage);
    }
    // Coverage never rescues an unpriceable amount into a pass.
    const unpriceable = evaluateBudget({ amountUsd: null, budget: 5, coverage, basis: RECORDED });
    assert.equal(unpriceable.status, BUDGET_STATUS.UNKNOWN, `${coverage} with no amount`);
  }
});


test('an alert names the session, the spend, the limit, and how long it took', () => {
  const verdict = evaluateBudget(pricedReport({
    amountUsd: 5.01,
    budget: 5,
    sessionId: 'cline-root',
    elapsedMs: 3_723_000, // 1h 2m 3s, reported at hour resolution
  }));
  assert.equal(verdict.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(verdict.elapsedLabel, '1h 2m');
  assert.match(verdict.message, /cline-root/, 'the session must be named');
  assert.match(verdict.message, /\$5\.01/, 'the spend must be named');
  assert.match(verdict.message, /\$5\.00/, 'the limit must be named');
  assert.match(verdict.message, /1h 2m/, 'the elapsed time must be named');

  // A report with no usable timestamps must omit the duration rather than invent one.
  const undated = evaluateBudget(pricedReport({ amountUsd: 5.01, budget: 5, elapsedMs: null }));
  assert.equal(undated.elapsedLabel, null);
  assert.equal(undated.elapsedMs, null);
  assert.doesNotMatch(undated.message, /\bnull\b|undefined|NaN/);
  assert.match(undated.message, /budget exceeded: this session/);
});

test('an estimate is never phrased as a charge, and a charge is never phrased as an estimate', () => {
  const estimated = evaluateBudget(pricedReport({
    amountUsd: 5.01, budget: 5, basis: ESTIMATED, sessionId: 'mcode-root', elapsedMs: 1_200,
  }));
  assert.match(estimated.message, /is estimated at/);
  assert.equal(estimated.recorded, false);
  assert.equal(estimated.estimated, true);
  assert.doesNotMatch(estimated.message, /\b(spent|charged|billed|charge)\b/);

  const recorded = evaluateBudget(pricedReport({
    amountUsd: 5.01, budget: 5, basis: RECORDED, sessionId: 'cline-root', elapsedMs: 1_200,
  }));
  assert.match(recorded.message, /spent \$5\.01/);
  assert.equal(recorded.recorded, true);
  assert.equal(recorded.estimated, false);

  // An unrecognised basis must fall back to the cautious wording, not to "spent".
  const unattributed = evaluateBudget(pricedReport({ amountUsd: 5.01, budget: 5, basis: null }));
  assert.match(unattributed.message, /is reported at/);
  assert.doesNotMatch(unattributed.message, /\b(spent|charged|billed)\b/);
});

test('a budget gates the exit code and never the report', () => {
  const verdicts = [
    evaluateBudget(pricedReport({ amountUsd: 1, budget: 5 })),
    evaluateBudget(pricedReport({ amountUsd: 9, budget: 5 })),
    evaluateBudget({ amountUsd: null, budget: 5, coverage: 'unavailable', basis: ESTIMATED }),
  ];
  for (const verdict of verdicts) {
    assert.equal(verdict.blocksOutput, false, 'a budget must never suppress a report');
  }
  // The alert is a separate line the caller chooses to print, so whatever the caller
  // already writes as the report is still fully available.
  assert.deepEqual(verdicts.map((verdict) => verdict.alert), [false, true, true]);
  assert.deepEqual(verdicts.map((verdict) => verdict.exitCode), [0, 3, 2]);
});

test('one helper serves a session cap and a daily cap', () => {
  const sessionCap = evaluateBudget(pricedReport({ amountUsd: 21, budget: 20, sessionId: 'cline-root' }));
  const dailyCap = evaluateBudget(pricedReport({
    amountUsd: 21, budget: 20, scope: BUDGET_SCOPES.DAY, sessionId: null, elapsedMs: 3_600_000,
  }));

  // Same helper, same verdict; only the window and the wording differ.
  assert.equal(sessionCap.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(dailyCap.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(sessionCap.exitCode, dailyCap.exitCode);
  assert.equal(sessionCap.overByUsd, dailyCap.overByUsd);
  assert.equal(sessionCap.scope, 'session');
  assert.equal(dailyCap.scope, 'day');
  assert.match(sessionCap.message, /\$20\.00 session budget/);
  assert.match(dailyCap.message, /\$20\.00 daily budget/);
  assert.match(dailyCap.message, /today/, 'a daily cap names its window');
});

test('exit codes keep the three outcomes distinguishable', () => {
  assert.deepEqual(BUDGET_EXIT_CODES, { ok: 0, exceeded: 3, unknown: 2 });
  // 1 stays reserved for an unexpected failure in both CLIs, so a script can tell a
  // blown budget apart from a crash.
  for (const code of Object.values(BUDGET_EXIT_CODES)) {
    assert.notEqual(code, 1);
    assert.ok(Number.isInteger(code) && code >= 0 && code <= 3);
  }
  // Exactly one outcome is silent, and it is the only one that exits zero.
  const statuses = Object.values(BUDGET_STATUS).sort();
  assert.deepEqual(statuses, ['exceeded', 'ok', 'unknown']);
  assert.deepEqual(statuses.filter((status) => BUDGET_EXIT_CODES[status] === 0), ['ok']);
  assert.deepEqual(
    statuses.filter((status) => BUDGET_EXIT_CODES[status] !== 0),
    ['exceeded', 'unknown'],
    'only a proved pass may exit zero',
  );
});


test('a real unpriced MCode report is not under budget, however generous the limit', () => {
  const report = mcodeReport(['--session', 'mcode-partial']);
  // Guard the premise: this is a real report whose cost genuinely could not be priced.
  assert.equal(report.billing.amountUsd, null, 'the fixture must produce an unpriced session');
  assert.equal(report.billing.rateKnown, false);
  assert.equal(report.billing.coverage, 'partial');
  assert.equal(report.billing.basis, ESTIMATED);

  for (const budget of [0, 0.01, 1, 5, 1e6]) {
    const verdict = evaluateReportBudget(report, { budget });
    assert.equal(verdict.status, BUDGET_STATUS.UNKNOWN, `a ${budget} USD limit must not be confirmed`);
    assert.equal(verdict.exitCode, 2, `a ${budget} USD limit must not exit zero`);
    assert.equal(verdict.reason, 'cost-unavailable');
    assert.equal(verdict.settled, false);
    assert.equal(verdict.alert, true);
    assert.equal(verdict.amountUsd, null);
    assert.equal(verdict.sessionId, 'mcode-partial');
    assert.match(verdict.message, /mcode-partial/);
    assert.doesNotMatch(verdict.message, /\b(spent|charged|billed)\b/);
  }

  // A daily rollup over the same unpriced session must not read any better.
  const today = mcodeReport(['--today']);
  assert.equal(today.billing.amountUsd, null);
  const daily = evaluateReportBudget(today, { budget: 100, scope: BUDGET_SCOPES.DAY });
  assert.equal(daily.status, BUDGET_STATUS.UNKNOWN);
  assert.equal(daily.exitCode, 2);
});

test('a real priced Cline report breaches a real budget and is reported as a charge', () => {
  const report = clineReport('cline-root');
  assert.equal(report.billing.basis, RECORDED);
  assert.equal(report.billing.coverage, 'complete');
  assert.equal(report.coverage.status, 'complete');
  // Real token sums are float sums, so the fixture total is not exactly 0.15.
  assert.notEqual(report.billing.amountUsd, 0.15);

  const verdict = evaluateReportBudget(report, { budget: 0.1 });
  assert.equal(verdict.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(verdict.exitCode, 3);
  assert.equal(verdict.reason, 'over-budget');
  assert.equal(verdict.blocksOutput, false, 'the report is still produced in full');
  assert.equal(verdict.settled, true);
  assert.equal(verdict.recorded, true);
  assert.equal(verdict.sessionId, 'cline-root');
  assert.equal(verdict.overByUsd, 0.05);
  assert.equal(verdict.amountUsd, report.billing.amountUsd);
  assert.match(verdict.message, /cline-root/);
  assert.match(verdict.message, /spent \$0\.15/, 'the float sum must render as a plain amount');
  assert.match(verdict.message, /\$0\.10/);
  // The fixture's session really did run for an hour, so the alert has to say so.
  assert.ok(verdict.elapsedMs >= 3_600_000, `expected an hour of runtime, got ${verdict.elapsedMs}`);
  assert.equal(verdict.elapsedLabel, '1h 0m');
  assert.match(verdict.message, /1h 0m/);

  // A limit above the real total is confirmed against that same real report.
  const withinLimit = evaluateReportBudget(report, { budget: 0.2 });
  assert.equal(withinLimit.status, BUDGET_STATUS.OK);
  assert.equal(withinLimit.exitCode, 0);
});


test('real reports are read through the fields the normalized contract defines', () => {
  const reports = [
    clineReport('cline-root'),
    clineReport('cline-partial'),
    clineReport('cline-truncated'),
    mcodeReport(['--session', 'mcode-root']),
    mcodeReport(['--session', 'mcode-partial']),
    mcodeReport(['--today']),
  ];
  for (const report of reports) {
    for (const key of ['billing', 'coverage', 'snapshot']) {
      assert.ok(key in report, `a real report must carry ${key}`);
      assert.ok(normalizedReportSchema.properties[key] || normalizedReportSchema.required.includes(key),
        `${key} must be in the normalized contract`);
    }
    assert.ok('amountUsd' in normalizedReportSchema.$defs.billing.properties);
    assert.ok(normalizedReportSchema.$defs.billing.properties.amountUsd.type.includes('null'),
      'the contract must admit a null cost, so a budget has to cope with one');
    // billing.coverage is what a budget reads, and it must agree with coverage.status.
    assert.equal(report.billing.coverage, report.coverage.status);
    assert.equal(report.runtime.costBasis, report.billing.basis);

    const verdict = evaluateReportBudget(report, { budget: 0.1 });
    assert.equal(verdict.amountUsd, report.billing.amountUsd ?? null);
    assert.equal(verdict.coverage, report.billing.coverage);
    assert.equal(verdict.basis, report.billing.basis);
    // The one rule that holds for every real report, whatever the runtime decided.
    if (verdict.amountUsd === null) assert.notEqual(verdict.status, BUDGET_STATUS.OK);
  }
});

test('a real zero-spend session satisfies a zero budget and a real partial one cannot', () => {
  const noCalls = clineReport('cline-truncated');
  assert.equal(noCalls.billing.amountUsd, 0);
  assert.equal(noCalls.billing.coverage, 'no-calls');
  const nothingSpent = evaluateReportBudget(noCalls, { budget: 0 });
  assert.equal(nothingSpent.status, BUDGET_STATUS.OK);
  assert.equal(nothingSpent.exitCode, 0);

  const partial = clineReport('cline-partial');
  assert.equal(partial.billing.coverage, 'partial');
  assert.ok(partial.billing.amountUsd > 0, 'the priced half of this session is real');
  const unconfirmed = evaluateReportBudget(partial, { budget: 100 });
  assert.equal(unconfirmed.status, BUDGET_STATUS.UNKNOWN);
  assert.equal(unconfirmed.exitCode, 2);
  assert.equal(unconfirmed.reason, 'coverage-unsettled');
  assert.match(unconfirmed.message, /cline-partial/);
});

test('a real MCode estimate breaches a tiny limit without ever calling itself a charge', () => {
  const report = mcodeReport(['--session', 'mcode-root']);
  assert.equal(report.billing.basis, ESTIMATED);
  assert.equal(report.billing.recordedCostUsd, null, 'nothing here was recorded as a charge');
  assert.ok(report.billing.amountUsd > 0, 'the fixture must produce a real estimate');
  assert.equal(report.billing.coverage, 'complete');

  const verdict = evaluateReportBudget(report, { budget: 0.0001 });
  assert.equal(verdict.status, BUDGET_STATUS.EXCEEDED);
  assert.equal(verdict.exitCode, 3);
  assert.equal(verdict.estimated, true);
  assert.equal(verdict.recorded, false);
  assert.match(verdict.message, /mcode-root/);
  assert.match(verdict.message, /is estimated at/);
  assert.doesNotMatch(verdict.message, /\b(spent|charged|billed|charge)\b/);
  // A sub-cent estimate must not print as $0.00 and read as free.
  assert.doesNotMatch(verdict.message, /\$0\.00 of/);
});


test('no input combination can produce ok without a settled, knowable total', () => {
  // The invariant, swept rather than spot-checked: `ok` is reachable only when the amount
  // is a finite non-negative number AND the report does not flag its own cost as
  // unsettled. Everything else is `unknown`.
  const amounts = [
    0, 0.000001, 0.04, 4.2, 5, 5.01, 1e6, 0.15000000000000002,
    null, undefined, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -0.01, '0.04', '5', '', true, false, [], {}, () => 0,
  ];
  const budgets = [0, 0.01, 0.1, 5, 20, 1e6];
  const coverages = [null, 'complete', 'partial', 'no-calls', 'not-recorded', 'unavailable', 'unknown', 'nonsense'];
  const bases = [null, RECORDED, ESTIMATED, 'mystery'];

  let checked = 0;
  for (const amountUsd of amounts) {
    for (const budget of budgets) {
      for (const coverage of coverages) {
        for (const basis of bases) {
          const verdict = evaluateBudget({ amountUsd, budget, coverage, basis, sessionId: 'sweep', elapsedMs: 1_000 });
          const label = `amount=${String(amountUsd)} budget=${budget} coverage=${coverage} basis=${basis}`;

          if (verdict.status === BUDGET_STATUS.OK) {
            assert.ok(isKnownCostUsd(amountUsd), `ok with an unpriceable amount: ${label}`);
            assert.ok(amountUsd <= budget, `ok above the limit: ${label}`);
            assert.ok(verdict.settled, `ok without a settled total: ${label}`);
            assert.equal(verdict.exitCode, 0, label);
            assert.equal(verdict.alert, false, label);
            assert.equal(verdict.message, null, label);
          } else {
            assert.notEqual(verdict.exitCode, 0, `a non-ok verdict must not exit zero: ${label}`);
            assert.equal(verdict.alert, true, label);
            assert.equal(typeof verdict.message, 'string', label);
            assert.ok(verdict.message.length > 0, label);
            if (!isKnownCostUsd(amountUsd)) {
              assert.equal(verdict.status, BUDGET_STATUS.UNKNOWN, label);
            }
            if (basis === ESTIMATED) {
              assert.doesNotMatch(verdict.message, /\b(spent|charged|billed)\b/, `an estimate called a charge: ${label}`);
            }
          }
          assert.equal(verdict.blocksOutput, false, label);
          checked += 1;
        }
      }
    }
  }
  assert.ok(checked > 500, `the sweep must be wide, only checked ${checked}`);
});

test('a malformed budget is a wiring defect and fails loudly', () => {
  // The CLI parser rejects a bad `--budget` before any storage opens, so a budget that
  // reaches the evaluator unvalidated means a caller skipped that check. Defaulting to
  // "no cap" here would quietly disable the governor.
  for (const budget of [-1, -0.01, Number.NaN, Number.POSITIVE_INFINITY, '5', '', null, undefined, {}, []]) {
    assert.throws(
      () => evaluateBudget({ amountUsd: 1, budget }),
      /a budget must be a non-negative number of USD/,
      `budget ${String(budget)} must be rejected`,
    );
  }
  assert.throws(() => evaluateBudget({ amountUsd: 1, budget: 5, scope: 'week' }), /unsupported budget scope/);
  assert.throws(() => evaluateBudget(), /a budget must be a non-negative number of USD/);
});

test('the verdict is pure: no clock, no mutation, and a repeatable answer', () => {
  const input = pricedReport({ sessionId: 'cline-root', elapsedMs: 2_500 });
  const frozenCopy = { ...input };
  const first = evaluateBudget(input);
  const second = evaluateBudget(input);
  assert.deepEqual(first, second, 'the same input must give the same verdict');
  assert.deepEqual(input, frozenCopy, 'the evaluator must not mutate its input');
  // Repeated evaluation of a real report must also be stable, which rules out a clock
  // leaking into elapsed time.
  const report = clineReport('cline-root');
  assert.deepEqual(evaluateReportBudget(report, { budget: 0.1 }), evaluateReportBudget(report, { budget: 0.1 }));
});


test('a duration is only reported when the report can support one', () => {
  assert.equal(formatElapsed(0), '0ms');
  assert.equal(formatElapsed(999), '999ms');
  assert.equal(formatElapsed(1_800), '1.8s');
  assert.equal(formatElapsed(60_000), '1m 0s');
  assert.equal(formatElapsed(3_723_000), '1h 2m');
  assert.equal(formatElapsed(3_600_000), '1h 0m');
  for (const unusable of [null, undefined, Number.NaN, -1, '90000', {}]) {
    assert.equal(formatElapsed(unusable), null, `${String(unusable)} has no duration`);
  }

  // Cline carries a real start/end pair; the derived span must match it exactly.
  const report = clineReport('cline-root');
  const derived = elapsedMsFromReport(report);
  assert.equal(derived, Date.parse(report.session.endedAt) - Date.parse(report.session.startedAt));

  // MCode carries no start/end pair, so an inverted anchor pair must yield null rather
  // than a zero that would claim the spend took no time at all.
  //
  // The inversion is applied explicitly here. It used to depend on the shared MCode fixture
  // stamping a ledger row 2s into the future, which only held while the CLI finished inside
  // that 2s window. Adding any concurrent test load made this fail intermittently, so the
  // property under test is now set deterministically on a real report instead of raced for.
  const mcodeSession = mcodeReport(['--session', 'mcode-partial']);
  const inverted = {
    ...mcodeSession,
    snapshot: {
      ...mcodeSession.snapshot,
      lastLedgerActivityAt: '2099-01-01T00:00:00.000Z',
      capturedAt: '2026-01-01T00:00:00.000Z',
    },
  };
  const activity = Date.parse(inverted.snapshot.lastLedgerActivityAt);
  const captured = Date.parse(inverted.snapshot.capturedAt);
  assert.ok(activity > captured, 'the report under test must present an unusable anchor order');
  assert.equal(elapsedMsFromReport(inverted), null);
  assert.equal(elapsedMsFromReport(null), null);
  assert.equal(elapsedMsFromReport({}), null);
});

test('a sub-cent spend stays visible instead of printing as a free session', () => {
  assert.equal(formatUsd(0.000012), '0.000012');
  assert.equal(formatUsd(0.00001), '0.00001');
  assert.equal(formatUsd(0), '0.00');
  assert.equal(formatUsd(0.15), '0.15');
  assert.equal(formatUsd(12.3), '12.30');
  // A sub-cent figure and a real zero must never render to the same string.
  assert.notEqual(formatUsd(0.000012), formatUsd(0));
  assert.equal(formatUsd(null), 'unknown');
  assert.equal(formatUsd(Number.NaN), 'unknown');
  assert.equal(formatUsd(-1), 'unknown');
  assert.equal(isKnownCostUsd('0.04'), false);
  assert.equal(isKnownCostUsd(0), true);
  assert.equal(isKnownCostUsd(Number.POSITIVE_INFINITY), false);
});

test('the evaluator ships with no dependencies and no platform-specific path handling', () => {
  // Copied verbatim into each adapter, so it must stay dependency-free and must never
  // build a path from a URL pathname, which is drive-relative on Windows.
  assert.doesNotMatch(budgetSource, /^\s*import\s/m, 'no imports, so no dependency can be pulled in');
  assert.doesNotMatch(budgetSource, /\brequire\s*\(/, 'no CommonJS require');
  assert.doesNotMatch(budgetSource, /\.pathname/, 'a URL pathname is not a Windows path');
  assert.doesNotMatch(budgetSource, /node:fs|node:path|node:child_process/, 'the evaluator reads and writes nothing');
});

