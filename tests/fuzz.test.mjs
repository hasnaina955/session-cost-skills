import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { seededRandom } from './helpers/contract-fixtures.mjs';
import { parseCommandCodeRates, parseStepFunRates, calculateTokenCost } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli, runJson } from './helpers/contract-fixtures.mjs';

/**
 * Fuzzing the hostile-input surfaces.
 *
 * Three things here are untrusted and can be corrupt in ways a schema does not catch: a session
 * log torn mid-write by a killed process, a Cline message file truncated by a crash, and a
 * provider pricing page that is not what it was yesterday. The parsers must never throw an
 * uncaught exception, never print a stack trace, and - the rule that matters most - never turn
 * a corrupt field into a finite, confident-looking cost.
 *
 * Every case is seeded and replayable with FUZZ_SEED=<n>. Mutations are structural (truncation,
 * byte flips, oversized and negative numbers) rather than random noise, because those are the
 * shapes real corruption takes.
 */

const SEED = Number(process.env.FUZZ_SEED ?? 20260927);
// The in-process parser targets are cheap, so they get the full count. The two that spawn a
// real CLI per case cost ~90ms each, so they get a smaller number: the point is coverage of
// mutation shapes, not volume, and a slow suite stops being run.
const ITERATIONS = Number(process.env.FUZZ_ITERATIONS ?? 2000);
const SPAWN_ITERATIONS = Number(process.env.FUZZ_SPAWN_ITERATIONS ?? 100);
const random = seededRandom(SEED);

const HOSTILE_NUMBERS = [
  'NaN', 'Infinity', '-Infinity', '1e309', '0.1e-999',
  '9007199254740993', '123456789012345678901234567890', 'null', 'undefined', '', ' ', '0x10',
  '1,5', '1e', '.', '..', 'NaN%', '  ', '1'.repeat(400),
];

/** Corrupt a string the way a crash or a hostile page would. */
function mutate(text, seedOffset = 0) {
  const pick = seededRandom(SEED + seedOffset);
  const strategies = ['truncate', 'flip', 'cut', 'join', 'inject', 'empty'];
  const strategy = strategies[Math.floor(pick() * strategies.length)];
  if (strategy === 'truncate' || text.length === 0) {
    return text.slice(0, Math.floor(pick() * (text.length + 1)));
  }
  if (strategy === 'flip') {
    const at = Math.floor(pick() * text.length);
    const code = text.charCodeAt(at) ^ (1 + Math.floor(pick() * 255));
    return text.slice(0, at) + String.fromCharCode(code) + text.slice(at + 1);
  }
  if (strategy === 'cut') {
    const at = Math.floor(pick() * text.length);
    return text.slice(0, at) + text.slice(at + 1);
  }
  if (strategy === 'join') return text.split('\n').reverse().join('\n');
  if (strategy === 'inject') {
    const value = HOSTILE_NUMBERS[Math.floor(pick() * HOSTILE_NUMBERS.length)];
    return text.replace(/(\d[\d.eE+-]*)/, () => value);
  }
  return '';
}

function assertCleanFailure(result, label) {
  assert.doesNotMatch(result.stderr ?? '', /\bat .*:\d+:\d+/, `${label}: stderr leaked a stack trace`);
  assert.doesNotMatch(result.stderr ?? '', /\/workspace|[A-Za-z]:\\/, `${label}: stderr leaked a local path`);
}

test('a corrupted MCode session log never crashes', () => {
  // Scope note, learned the hard way while writing this: `messages.jsonl` is NOT MCode's money
  // path. Token counts come from the SQLite ledger (`local_runtime_token_usage`); the message
  // log only supplies per-call model attribution. Three earlier versions of this test tried to
  // assert something about cost here and were all wrong - they flagged a reordered file and an
  // emptied file, both of which leave the priced data intact and correctly report a complete
  // cost. Corrupting the ledger table itself is the money-path case, and it is already covered
  // by the corrupt-database tests in error-boundaries.
  //
  // So this asserts what the message log can actually break: the process must not crash, must
  // not print a stack trace or a local path, and must never exit 0 with unparseable JSON.
  const base = createMCodeFixture();
  const messagesPath = path.join(base.dataDir, 'v2', 'sessions', 'mcode-root', 'messages.jsonl');
  const original = fs.readFileSync(messagesPath, 'utf8');

  for (let iteration = 0; iteration < SPAWN_ITERATIONS; iteration += 1) {
    fs.writeFileSync(messagesPath, mutate(original, iteration), 'utf8');
    const result = runCli(mcodeScript, base.dataDir, ['--session', 'mcode-root', '--json'], base.environment);
    assertCleanFailure(result, `iteration ${iteration}`);
    if (result.status === 0 && result.stdout) {
      try { JSON.parse(result.stdout); } catch { assert.fail(`iteration ${iteration}: exit 0 with unparseable JSON`); }
    }
  }
  fs.writeFileSync(messagesPath, original, 'utf8');
});

test('a corrupted Cline message file never crashes', () => {
  const base = createClineFixture();
  const messagesPath = path.join(base.dataDir, 'data', 'sessions', 'cline-root.json');
  const original = fs.readFileSync(messagesPath, 'utf8');

  for (let iteration = 0; iteration < SPAWN_ITERATIONS; iteration += 1) {
    fs.writeFileSync(messagesPath, mutate(original, iteration), 'utf8');
    const result = runCli(clineScript, base.dataDir, ['--session', 'cline-root', '--json']);
    assertCleanFailure(result, `iteration ${iteration}`);
    if (result.status === 0 && result.stdout) {
      try { JSON.parse(result.stdout); } catch { assert.fail(`iteration ${iteration}: exit 0 with unparseable JSON`); }
    }
  }
  fs.writeFileSync(messagesPath, original, 'utf8');
});

test('a hostile pricing page yields no models rather than wrong ones', () => {
  const parsers = {
    commandcode: { parse: parseCommandCodeRates, page: '| `evil` | 1M tokens | $NaN | $NaN | $NaN |' },
    stepfun: { parse: parseStepFunRates, page: '| `evil` | 1M tokens | $NaN | $NaN | $NaN |' },
  };

  for (const [id, { parse, page }] of Object.entries(parsers)) {
    for (let iteration = 0; iteration < ITERATIONS; iteration += 1) {
      const html = mutate(page + '\n' + mutate(page, iteration + 7), iteration);
      let models;
      try {
        models = parse(html);
      } catch (error) {
        // Rejecting hostile input is fine, but only through a documented error - never a
        // TypeError from arithmetic on undefined, and never a message quoting the bad value.
        assert.ok(error instanceof Error, `${id}: threw a non-Error`);
        assert.doesNotMatch(String(error.message), /\bundefined\b|\bNaN\b/, `${id}: error message exposes a corrupt value: ${error.message}`);
        continue;
      }
      for (const [modelId, model] of Object.entries(models ?? {})) {
        for (const component of ['input', 'output', 'cacheRead', 'cacheWrite']) {
          const value = model[component];
          if (value === null || value === undefined) continue;
          assert.ok(Number.isFinite(value) && value >= 0,
            `${id}/${modelId}.${component} is ${String(value)}, which is not a usable rate`);
        }
      }
    }
  }
});

test('an unusable token count makes a cost component unknown, never a smaller number', () => {
  // Issue #67. A count is usable when it is null - a call that recorded no tokens, which costs
  // nothing - or a finite, non-negative number. Everything else was once coerced, and every
  // coercion moved a bill *down*: a negative count subtracted, a non-numeric or empty value
  // became a confident 0, and Infinity passed through as Infinity.
  const rate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.25 };

  // A negative count subtracts from a total. That is the under-reporting direction.
  assert.equal(calculateTokenCost({ input_tokens: -1, output_tokens: 100 }, rate).input, null);

  // A field that is not a number at all is not "no tokens".
  for (const unusable of ['abc', 'N/A', 'NaN', {}, []]) {
    assert.equal(calculateTokenCost({ input_tokens: unusable, output_tokens: 100 }, rate).input, null,
      `${JSON.stringify(unusable)} must not become a confident cost`);
  }

  // Overflow is not a token total.
  assert.equal(calculateTokenCost({ input_tokens: Infinity, output_tokens: 100 }, rate).input, null);
  assert.equal(calculateTokenCost({ input_tokens: 'Infinity', output_tokens: 100 }, rate).input, null);

  // The legitimate cases are untouched: null means "no tokens", and a real number is used.
  assert.equal(calculateTokenCost({ input_tokens: null, output_tokens: 100 }, rate).input, 0);
  assert.equal(calculateTokenCost({ input_tokens: 0, output_tokens: 100 }, rate).input, 0);
  assert.ok(Math.abs(calculateTokenCost({ input_tokens: 500, output_tokens: 100 }, rate).input - 0.0005) < 1e-9);
  // An unusable input does not poison the output component, which is independently computable.
  const cost = calculateTokenCost({ input_tokens: 'abc', output_tokens: 100 }, rate);
  assert.equal(cost.input, null);
  assert.ok(Math.abs(cost.output - 0.0002) < 1e-9);
});


test('a negative token count degrades a session to partial coverage instead of understating it', () => {
  // The whole reason #67 mattered. A negative count does not just misprice one call: if it
  // slipped through, it would reduce a total, so the session would report *less than it spent*.
  // The fix routes that call into the same "no cost" path a model with no rate takes, so the
  // report names the gap instead of quietly shrinking.
  const fixture = createMCodeFixture();
  const dbPath = path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("INSERT INTO local_runtime_token_usage VALUES (900001, 'mcode-root', 'root', 'neg-1', 1781524800000, -50, 20, 0, 0, 0)");
  db.close();

  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'],
    { ...fixture.environment, SESSION_COST_NOW: '2026-06-15T18:00:00.000Z' }).output;
  assert.equal(report.billing.coverage, 'partial',
    'a negative count must make the session partial, not complete at a smaller total');
  assert.equal(report.billing.amountUsd, null,
    'a partial session states no total rather than a smaller one');
  assert.ok(report.coverage.unknownReasons.some((reason) => reason.length > 0),
    'the reason must be named');

  // And the timeline, which is the other place a zero could masquerade, is null for that call.
  if (report.timeline) {
    assert.equal(report.timeline.some((entry) => entry.costUsd === null), true,
      'the negative-cost call must be null in the timeline, not zero');
  }
});
