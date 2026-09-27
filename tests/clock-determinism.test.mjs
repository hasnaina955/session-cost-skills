import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { now, isoNow, utcDay } from '../shared/clock.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runJson } from './helpers/contract-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PINNED = '2026-06-15T12:00:00.000Z';

// The two places a raw clock read is the design rather than an oversight: the clock module's
// own fallback (there is nothing above it) and the budget evaluator, which is contractually
// import-free so a relative import could pull in a dependency. The evaluator takes the clock as
// an argument, so its callers inject it.
const EXEMPT = new Set(['shared/clock.mjs', 'shared/budget.mjs']);

const REPORTING_SOURCES = [
  'shared/clock.mjs',
  'shared/budget.mjs',
  'shared/config.mjs',
  'shared/cost-centres.mjs',
  'shared/counterfactual.mjs',
  'shared/csv.mjs',
  'shared/dashboard.mjs',
  'shared/error-boundaries.mjs',
  'shared/explain.mjs',
  'shared/insights.mjs',
  'shared/protocol-adapters.mjs',
  'shared/provider-diagnostics.mjs',
  'shared/provider-driver.mjs',
  'shared/report-contract.mjs',
  'shared/rollup-cache.mjs',
  'shared/rollup.mjs',
  'shared/session-graph.mjs',
  'shared/setup.mjs',
  'shared/skill-version.mjs',
  'adapters/cline/skill/scripts/session-cost.mjs',
  'adapters/mcode/skill/scripts/session-cost.mjs',
];

test('the reported clock is pinned by SESSION_COST_NOW and fails loudly on nonsense', () => {
  assert.equal(now({ SESSION_COST_NOW: PINNED }), Date.parse(PINNED));
  assert.equal(isoNow({ SESSION_COST_NOW: PINNED }), PINNED);
  assert.equal(utcDay({ SESSION_COST_NOW: PINNED }), '2026-06-15');
  // An absent or empty variable means the real clock, not a pinned one.
  assert.ok(Math.abs(now({}) - Date.now()) < 5_000);
  assert.ok(Math.abs(now({ SESSION_COST_NOW: '' }) - Date.now()) < 5_000);
  // Silently falling back to the real clock is the exact bug this module exists to prevent,
  // so a bad value is an error rather than a shrug.
  assert.throws(() => now({ SESSION_COST_NOW: 'yesterday' }), /SESSION_COST_NOW/);
  assert.throws(() => now({ SESSION_COST_NOW: '1780000000000' }), /SESSION_COST_NOW/);
});

test('no reporting path reads the real clock without an explicit allow-list comment', () => {
  // The guard for the bug: `tests/rate-provenance.test.mjs` passed on one day and failed on
  // the next with no code change, because a fixture's relative dates crossed a bundled rate
  // record's effectiveFrom between runs. A raw `Date.now()` in a reporting path is how that
  // comes back, so a new one has to be written down as a deliberate choice.
  const offenders = [];
  for (const relative of REPORTING_SOURCES) {
    if (EXEMPT.has(relative)) continue;
    const lines = fs.readFileSync(path.join(repositoryRoot, relative), 'utf8').split('\n');
    lines.forEach((line, index) => {
      if (!/\bDate\.now\(\)|\bnew Date\(\s*\)/.test(line)) return;
      const previous = lines[index - 1] ?? '';
      const allowListed = line.includes('clock: real-time') || previous.includes('clock: real-time');
      if (!allowListed) offenders.push(`${relative}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `reporting paths must take the clock from shared/clock.mjs, or carry a '// clock: real-time' comment:\n${offenders.join('\n')}`);
});

test('the same report is byte-identical across runs when the clock is pinned', () => {
  // A second apart in wall-clock time must not change a single byte of the report.
  const fixture = createMCodeFixture();
  const args = ['--session', 'mcode-root', '--include-children', '--json'];
  const first = runJson(mcodeScript, fixture.dataDir, args, { ...fixture.environment, SESSION_COST_NOW: PINNED });
  const second = runJson(mcodeScript, fixture.dataDir, args, { ...fixture.environment, SESSION_COST_NOW: PINNED });
  assert.equal(first.result.status, 0, first.result.stderr);
  assert.equal(first.result.stdout, second.result.stdout,
    'a pinned clock must produce identical output; no field may be deleted to pass this');

  const cline = createClineFixture();
  const clineArgs = ['--session', 'cline-root', '--json'];
  const firstCline = runJson(clineScript, cline.dataDir, clineArgs, { SESSION_COST_NOW: PINNED });
  const secondCline = runJson(clineScript, cline.dataDir, clineArgs, { SESSION_COST_NOW: PINNED });
  assert.equal(firstCline.result.stdout, secondCline.result.stdout, 'Cline must be deterministic too');
});

test('the reported clock really comes from SESSION_COST_NOW, and --today follows it', () => {
  // Proof by falsification: pin the clock a year past every fixture session and the same
  // command must report that timestamp and select no sessions for --today. If any field
  // ignored the variable, this fails.
  const fixture = createMCodeFixture();
  const later = '2027-06-15T12:00:00.000Z';
  const environment = { ...fixture.environment, SESSION_COST_NOW: later };
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], environment).output;
  assert.equal(report.generatedAt, later, 'generatedAt must follow the pinned clock');
  assert.equal(report.snapshot.capturedAt, later, 'snapshot.capturedAt must follow the pinned clock');

  // A clock past every fixture session must make --today match nothing, and "nothing matched"
  // is a clean exit 2 with one readable line - not a report and not a crash.
  const today = runJson(mcodeScript, fixture.dataDir, ['--today', '--json'], environment);
  assert.equal(today.result.status, 2, 'no match is exit 2 in both adapters');
  assert.equal(today.output, null, 'no sessions means no JSON body');
  assert.match(today.result.stderr, /no sessions match/);
});

test('an invalid SESSION_COST_NOW is one readable line, not a stack trace', () => {
  // The error-boundary contract: a bad value is a configuration mistake, so it is reported
  // the way every other bad invocation is, with no path and no stack.
  const fixture = createMCodeFixture();
  const result = spawnSync(process.execPath, [mcodeScript, '--data-dir', fixture.dataDir, '--session', 'mcode-root', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, ...fixture.environment, SESSION_COST_NOW: 'not-a-timestamp' },
  });
  assert.notEqual(result.status, 0, 'an invalid clock must fail rather than fall back to the real one');
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/, 'no stack trace');
  assert.match(result.stderr, /SESSION_COST_NOW/);
});
