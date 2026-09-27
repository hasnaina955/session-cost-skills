import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { removeDirectory } from './helpers/temp-dir.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli, FIXTURE_EPOCH } from './helpers/contract-fixtures.mjs';

/**
 * Golden output tests.
 *
 * Every other assertion in this suite checks that a *value* is right. None of them notices that a
 * table lost its borders, that a column drifted, that a line quietly disappeared from a report, or
 * that the wording changed from "not recorded" to something vaguer. Those are regressions a user
 * sees and a value assertion cannot see, and they are exactly what the visual work in Phase 3
 * risks while it is in flight.
 *
 * So the rendered output of a fixed set of scenarios is checked in verbatim and compared byte for
 * byte. Every scenario runs with SESSION_COST_NOW pinned (WP-1.1), because otherwise the snapshot
 * would expire the same way the fixture test did: correct today, stale tomorrow.
 *
 * Regenerate deliberately with:  UPDATE_GOLDEN=1 node --test tests/golden.test.mjs
 * Read a diff before you do. An unexplained change in a golden file is a behaviour change.
 */

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GOLDEN_DIR = path.join(repositoryRoot, 'tests', 'golden');
const PINNED = '2026-06-15T18:00:00.000Z';
const UPDATE = process.env.UPDATE_GOLDEN === '1';

// A scenario is one command against one fixture. `expectExit` matters: several of these are the
// unknown-cost paths, which exit 2 on purpose. Pinning the exit code is part of the contract -
// "no usable cost" must stay distinguishable from "a crash".
const SCENARIOS = [
  { name: 'mcode-session', script: 'mcode', args: ['--session', 'mcode-root'], format: 'txt', expectExit: 0 },
  { name: 'mcode-session-children', script: 'mcode', args: ['--session', 'mcode-root', '--include-children'], format: 'txt', expectExit: 0 },
  { name: 'mcode-list', script: 'mcode', args: ['--list', '5'], format: 'txt', expectExit: 0 },
  { name: 'mcode-partial-coverage', script: 'mcode', args: ['--session', 'mcode-partial'], format: 'txt', expectExit: 2 },
  { name: 'mcode-unpriced', script: 'mcode', args: ['--session', 'mcode-unpriced'], format: 'txt', expectExit: 2 },
  { name: 'mcode-rates', script: 'mcode', args: ['--rates'], format: 'txt', expectExit: 0 },
  { name: 'mcode-csv', script: 'mcode', args: ['--session', 'mcode-root', '--csv'], format: 'csv', expectExit: 0 },
  { name: 'cline-session', script: 'cline', args: ['--session', 'cline-root'], format: 'txt', expectExit: 0 },
  { name: 'cline-list', script: 'cline', args: ['--list', '5'], format: 'txt', expectExit: 0 },
  { name: 'cline-session-children', script: 'cline', args: ['--session', 'cline-root', '--include-children'], format: 'txt', expectExit: 0 },
];

/**
 * Remove the two things that legitimately vary between machines and runs: the temporary fixture
 * directory, and the dashboard's script hash, which is a hash of the payload and therefore changes
 * whenever any figure does.
 *
 * Nothing else is normalised. A timestamp that drifts, a reordered row, or a changed column width
 * all fail the test, which is the entire point.
 */
export function normalize(text, { dataDir }) {
  return text
    .split(dataDir).join('<DATA_DIR>')
    .replace(/sha256-[A-Za-z0-9+/=]{43,}/g, 'sha256-<HASH>')
    .replace(/[0-9a-f]{64}/g, '<FINGERPRINT>')
    .replace(/\r\n/g, '\n');
}

function render(scenario, fixtures) {
  const isMcode = scenario.script === 'mcode';
  const fixture = isMcode ? fixtures.mcode : fixtures.cline;
  const script = isMcode ? mcodeScript : clineScript;
  const environment = isMcode ? { ...fixture.environment, SESSION_COST_NOW: PINNED } : { SESSION_COST_NOW: PINNED };
  const result = runCli(script, fixture.dataDir, scenario.args, environment);
  assert.equal(result.status, scenario.expectExit,
    `${scenario.name}: expected exit ${scenario.expectExit}, got ${result.status}\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/, `${scenario.name}: stderr leaked a stack trace`);
  const body = scenario.format === 'json' ? JSON.stringify(result.output ?? JSON.parse(result.stdout || '{}'), null, 2) : result.stdout;
  return normalize(body, { dataDir: fixture.dataDir });
}

/** First differing line, with its number on both sides - a diff nobody has to read by hand. */
function firstDifference(actual, expected) {
  const left = actual.split('\n');
  const right = expected.split('\n');
  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    if (left[index] !== right[index]) {
      return `first difference at line ${index + 1}:\n  expected: ${JSON.stringify(right[index])}\n  actual:   ${JSON.stringify(left[index])}`;
    }
  }
  return 'outputs are equal';
}

test('rendered output matches the checked-in golden files', async (t) => {
  fs.mkdirSync(GOLDEN_DIR, { recursive: true });
  // A fixed fixture epoch AND a pinned reported clock. The epoch fixes the data; SESSION_COST_NOW
  // fixes what the report says about "now". Without the epoch the golden files embed a date that
  // is two days ago every morning, which is the same expiry WP-1.1 was written to stop.
  const base = Date.parse(FIXTURE_EPOCH);
  const fixtures = { mcode: createMCodeFixture({ base }), cline: createClineFixture({ base }) };
  t.after(() => { removeDirectory(fixtures.mcode.dataDir); removeDirectory(fixtures.cline.dataDir); });

  for (const scenario of SCENARIOS) {
    await t.test(scenario.name, () => {
      const goldenPath = path.join(GOLDEN_DIR, `${scenario.name}.${scenario.format}`);
      const actual = render(scenario, fixtures);
      if (UPDATE || !fs.existsSync(goldenPath)) {
        fs.writeFileSync(goldenPath, actual, 'utf8');
        if (!UPDATE) console.log(`  wrote missing golden: ${path.relative(repositoryRoot, goldenPath)}`);
        return;
      }
      const expected = fs.readFileSync(goldenPath, 'utf8').replace(/\r\n/g, '\n');
      assert.equal(actual, expected, `${scenario.name} output changed.\n${firstDifference(actual, expected)}`);
    });
  }
});

test('the golden scenarios cannot drift with the wall clock', () => {
  // A golden file that embeds a real date expires the next morning, which is exactly what
  // happened to `rate-provenance` before WP-1.1. Two things prevent that here, and both are
  // asserted rather than assumed:
  //
  //   - the fixture epoch is a fixed constant, not `Date.now()`, so the *data* does not move;
  //   - every scenario pins SESSION_COST_NOW, so the report's idea of "now" does not move either.
  //
  // If someone drops the pin, this fails structurally instead of the corpus quietly going stale.
  assert.match(FIXTURE_EPOCH, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/, 'the fixture epoch must be a fixed ISO instant');
  const source = fs.readFileSync(path.join(repositoryRoot, 'tests', 'helpers', 'contract-fixtures.mjs'), 'utf8');
  const epochLine = source.split('\n').find((line) => line.includes('export const FIXTURE_EPOCH'));
  assert.ok(epochLine && !epochLine.includes('Date.now()'), 'the fixture epoch must be a constant, not the real clock');

  const own = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8');
  assert.ok(own.includes('SESSION_COST_NOW: PINNED'),
    'every golden scenario must run with the reported clock pinned');
});

test('the golden corpus covers both runtimes, both exit codes, and the unknown-cost paths', () => {
  // A golden suite that quietly loses its awkward cases is worse than none: the partial and
  // unpriced scenarios are where wording regressions ("unavailable" becoming "0") hide.
  assert.ok(SCENARIOS.length >= 10, 'the corpus should not shrink silently');
  const scripts = new Set(SCENARIOS.map((scenario) => scenario.script));
  assert.deepEqual([...scripts].sort(), ['cline', 'mcode'], 'both runtimes must be represented');
  const exits = new Set(SCENARIOS.map((scenario) => scenario.expectExit));
  assert.ok(exits.has(0) && exits.has(2), 'both a priced and an unknown-cost exit must be pinned');
  for (const required of ['mcode-partial-coverage', 'mcode-unpriced']) {
    assert.ok(SCENARIOS.some((scenario) => scenario.name === required), `${required} must stay in the corpus`);
  }
});
