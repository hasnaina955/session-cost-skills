import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { seededRandom } from './helpers/contract-fixtures.mjs';
import { parseCommandCodeRates, parseStepFunRates, calculateTokenCost } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli } from './helpers/contract-fixtures.mjs';

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

test('KNOWN GAP: calculateTokenCost coerces unusable token counts instead of refusing them', () => {
  // Found by the fuzzer, and pinned rather than quietly fixed here: changing pricing behaviour
  // belongs in its own change with its own decision about what the values mean.
  //
  // Two unsafe coercions, both in the direction of a *smaller or absent* bill:
  //
  //   1. A negative count produces a negative cost component, which reduces a total.
  //   2. An unparseable count ("NaN", "abc", "", " ") produces 0 - a finite, confident number
  //      for a value that is not known. That is the silent-zero failure this project treats as
  //      its worst class, arriving one layer below the report.
  //   3. "Infinity" passes straight through as Infinity.
  //
  // Reachability today: the ledger columns are INTEGER, so the values arriving from SQLite are
  // numbers or null, and a null count legitimately means zero tokens. So no current caller
  // triggers this. The risk is the contract - a helper that answers 0 for a value it could not
  // read is one refactor away from being fed a string, and nothing in the type stops it.
  //
  // The fix is a decision, not a patch: does an unusable count mean "no tokens" (0), or "not
  // known" (null, which would make the whole session cost unknown)? The second is consistent
  // with principle 1 and is what the rest of the report already does. When that is decided, this
  // test is inverted and the coercion is removed.
  const rate = { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.25 };

  const negative = calculateTokenCost({ input_tokens: -1, output_tokens: 100 }, rate);
  assert.ok(negative.input < 0, `expected the current negative behaviour, got ${String(negative.input)}`);

  for (const unusable of ['NaN', 'abc', '', ' ']) {
    const cost = calculateTokenCost({ input_tokens: unusable, output_tokens: 100 }, rate);
    assert.equal(cost.input, 0, `"${unusable}" currently reads as 0; invert this when it is fixed`);
  }

  const infinite = calculateTokenCost({ input_tokens: 'Infinity', output_tokens: 100 }, rate);
  assert.equal(infinite.input, Number.POSITIVE_INFINITY, 'Infinity currently passes through');
});
