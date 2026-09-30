import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { CliUsageError, RUNTIME_FLAGS, parseCliArgs, valueFlagsFor } from '../shared/cli-args.mjs';
import { clineScript, mcodeScript, runCli } from './helpers/contract-fixtures.mjs';

const RUNTIMES = ['cline', 'mcode'];
const parse = (argv, runtimeId = 'cline') => parseCliArgs(argv, { runtimeId });
const canonical = fs.readFileSync(new URL('../shared/cli-args.mjs', import.meta.url), 'utf8');

test('both adapters ship the same argument parser', () => {
  for (const runtime of RUNTIMES) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/cli-args.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('every value-taking flag rejects a missing value and a following flag', () => {
  for (const runtime of RUNTIMES) {
    for (const flag of valueFlagsFor(runtime)) {
      const camel = flag.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      if (camel === 'list') continue; // --list legitimately has an optional value
      assert.throws(() => parse([flag], runtime), CliUsageError, `${flag} must require a value`);
      assert.throws(() => parse([flag, '--json'], runtime), /requires a value, but got the flag --json/, `${flag} must not swallow a flag`);
    }
  }
});

test('--list never consumes the next flag as its count', () => {
  // The regression the shared parser exists to prevent.
  for (const runtime of RUNTIMES) {
    const options = parse(['--list', '--json'], runtime);
    assert.equal(options.list, 10, 'the default count must survive');
    assert.equal(options.json, true, '--json must remain a separate flag');

    assert.equal(parse(['--list', '25'], runtime).list, 25);
    assert.equal(parse(['--list', '--json', '--include-children'], runtime).list, 10);
    assert.equal(parse(['--json', '--list'], runtime).list, 10);
    assert.throws(() => parse(['--list', 'abc'], runtime), /--list expects a whole number, but got "abc"/);
    assert.throws(() => parse(['--list', '0'], runtime), /--list must be between 1 and 1000/);
    assert.throws(() => parse(['--list', '1001'], runtime), /--list must be between 1 and 1000/);
  }
});

test('conflicting modes are rejected instead of silently overriding', () => {
  for (const runtime of RUNTIMES) {
    for (const args of [['--last', '--today'], ['--today', '--compare'], ['--compare', '--last']]) {
      assert.throws(() => parse(args, runtime), /session mode flags are mutually exclusive/, args.join(' '));
    }
    assert.throws(() => parse(['--init-config', '--export-config'], runtime), /config action flags are mutually exclusive/);
    assert.throws(() => parse(['doctor', 'providers'], runtime), /diagnostic flags are mutually exclusive/);
    // A repeated boolean is idempotent; a repeated value is ambiguous.
    assert.doesNotThrow(() => parse(['--json', '--json'], runtime));
    assert.throws(() => parse(['--session', 'a', '--session', 'b'], runtime), /--session was given more than once/);
  }
});

test('numeric ranges and calendar dates are validated before storage opens', () => {
  for (const runtime of RUNTIMES) {
    assert.throws(() => parse(['--from', '2026-13-99'], runtime), /not a real calendar date/);
    assert.throws(() => parse(['--from', '2026-02-30'], runtime), /not a real calendar date/);
    assert.throws(() => parse(['--to', 'yesterday'], runtime), /--to expects YYYY-MM-DD/);
    assert.equal(parse(['--from', '2026-02-28', '--to', '2026-03-01'], runtime).from, '2026-02-28');
  }
  assert.throws(() => parse(['--account-days', 'abc']), /--account-days expects a whole number/);
  assert.throws(() => parse(['--account-days', '0']), /--account-days must be between 1 and 365/);
  assert.equal(parse(['--account-days', '30']).accountDays, 30);
  assert.throws(() => parse(['--rates'], 'cline'), /unknown argument: --rates/);
  assert.throws(() => parse(['--account'], 'mcode'), /unknown argument: --account/);
});

test('the two-word and bare diagnostic spellings resolve identically', () => {
  for (const runtime of RUNTIMES) {
    assert.equal(parse(['models', 'discover'], runtime).diagnostic, 'models');
    assert.equal(parse(['--models-discover'], runtime).diagnostic, 'models');
    assert.equal(parse(['config', 'explain'], runtime).diagnostic, 'config-explain');
    assert.equal(parse(['--config-explain'], runtime).diagnostic, 'config-explain');
    assert.equal(parse(['doctor'], runtime).diagnostic, 'doctor');
    assert.equal(parse(['--doctor'], runtime).diagnostic, 'doctor');
    assert.equal(parse(['providers'], runtime).diagnostic, 'providers');
    assert.throws(() => parse(['models', 'explain'], runtime), /unexpected argument: models/);
  }
});

test('help and version short-circuit every other validation', () => {
  for (const runtime of RUNTIMES) {
    assert.equal(parse(['--help'], runtime).help, true);
    assert.equal(parse(['-h'], runtime).help, true);
    assert.equal(parse(['--version'], runtime).version, true);
    assert.equal(parse(['-v'], runtime).version, true);
    assert.doesNotThrow(() => parse(['--help', '--last', '--today'], runtime));
  }
});

test('the parser never leaks credentials or local paths into a usage error', () => {
  for (const runtime of RUNTIMES) {
    for (const args of [['--session'], ['--out'], ['--import-config'], ['--account-days', 'x'], ['--from', 'nope']]) {
      try {
        parse(args, runtime);
        assert.fail(`${args.join(' ')} should have thrown`);
      } catch (error) {
        assert.ok(error instanceof CliUsageError);
        assert.equal(error.exitCode, 2);
        assert.doesNotMatch(error.message, /api[_-]?key|secret|token|[A-Z]:\\/i);
      }
    }
  }
});

test('the flag schema declares every value a help line promises', () => {
  for (const [runtime, script] of [['cline', clineScript], ['mcode', mcodeScript]]) {
    const help = runCli(script, os.tmpdir(), ['--help']).stdout;
    for (const [flag, spec] of Object.entries(RUNTIME_FLAGS[runtime])) {
      assert.ok(spec.key, `${runtime} flag ${flag} must declare an options key`);
      // Either a boolean switch, a constant it sets, or something that reads a value.
      const shape = spec.value === true || typeof spec.value === 'string' || typeof spec.value === 'function'
        || spec.optionalCount || spec.takesValue;
      assert.ok(shape, `${runtime} flag ${flag} must declare whether it takes a value`);
    }
    for (const documented of new Set(help.match(/--[a-z][a-z-]*/g) ?? [])) {
      const camel = documented.replace(/^--/, '').replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      // `--help`/`-h` are documented as a short alias, and the diagnostics are
      // documented as bare words, so the schema name will not always appear verbatim.
      const alias = camel === 'h' ? 'help' : camel;
      assert.ok(alias in RUNTIME_FLAGS[runtime], `${runtime} help documents ${documented} but the schema does not define it`);
    }
    // Every schema flag must be discoverable from the help text in some spelling.
    const helpText = help.toLowerCase();
    for (const flag of Object.keys(RUNTIME_FLAGS[runtime])) {
      if (flag === 'help') continue;
      const kebab = flag.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
      assert.ok(helpText.includes(kebab), `${runtime} schema defines ${kebab} but the help text never mentions it`);
    }
  }
});

test('both CLIs fail a bad invocation before touching storage', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-cli-'));
  const cases = [['--session'], ['--last', '--today'], ['--list', 'abc'], ['--from', '2026-13-99'], ['--account-days', 'x']];
  for (const [runtime, script] of [['cline', clineScript], ['mcode', mcodeScript]]) {
    for (const args of cases) {
      if (runtime === 'mcode' && args.includes('--account-days')) continue;
      const result = runCli(script, empty, args);
      assert.equal(result.status, 2, `${runtime} ${args.join(' ')} must exit 2`);
      assert.doesNotMatch(result.stderr, /at [A-Za-z]+ \(.*:\d+:\d+\)|\.mjs:\d+$/m, `${runtime} ${args.join(' ')} leaked a stack trace`);
      assert.doesNotMatch(result.stderr, /not found/i, `${runtime} ${args.join(' ')} reached storage`);
    }
  }
});

// A flag that is accepted and then quietly does nothing is the same class of failure as printing
// a number the accounting did not produce: the user asked for an artefact, got none, and was told
// nothing. `--dashboard` only renders a single selected session (or, on Cline, an account), so the
// aggregate modes are rejected up front rather than ignored.
const UNSUPPORTED_WITH_DASHBOARD = [
  [['--today'], '--today'],
  [['--compare'], '--compare'],
  [['--list', '5'], '--list'],
  [['--rollup', 'daily'], '--rollup'],
  [['--from', '2026-01-01'], '--from/--to'],
  [['--to', '2026-12-31'], '--from/--to'],
];

test('--dashboard is rejected with an aggregate mode, and says which one', () => {
  for (const runtimeId of ['cline', 'mcode']) {
    for (const [argv, named] of UNSUPPORTED_WITH_DASHBOARD) {
      assert.throws(
        () => parseCliArgs([...argv, '--dashboard'], { runtimeId }),
        (error) => {
          assert.ok(error instanceof CliUsageError, 'a usage error, before any storage is opened');
          assert.match(error.message, /--dashboard does not support/);
          assert.ok(error.message.includes(named), `the message must name ${named}, got: ${error.message}`);
          return true;
        },
        `${runtimeId}: ${argv.join(' ')} --dashboard must be rejected`,
      );
    }
  }
});

test('--dashboard still works for the modes that can produce one', () => {
  // The positive control. A guard written against the wrong shape of "absent" rejects everything,
  // which is what the first version of this check did - the runtime defaults spell absent three
  // different ways: a null (`from`), a zero (`list`), and a missing key (`rollup`).
  const supported = [[], ['--last'], ['--session', 'abc'], ['--include-children'], ['--provider', 'x'], ['--brief'], ['--json'], ['--out', 'p.html']];
  for (const runtimeId of ['cline', 'mcode']) {
    for (const argv of supported) {
      const parsed = parseCliArgs([...argv, '--dashboard'], { runtimeId });
      assert.equal(parsed.dashboard, true, `${runtimeId}: ${argv.join(' ')} --dashboard must parse`);
    }
  }
});

test('several aggregate flags are named together rather than one at a time', () => {
  assert.throws(
    () => parseCliArgs(['--today', '--list', '3', '--dashboard'], { runtimeId: 'mcode' }),
    (error) => {
      assert.ok(error.message.includes('--list'));
      assert.ok(error.message.includes('--today'));
      return true;
    },
  );
});

test('the Cline message points at the one extra mode it can render', () => {
  // Cline has an account dashboard, MCode does not, so the guidance cannot be identical.
  assert.throws(
    () => parseCliArgs(['--today', '--dashboard'], { runtimeId: 'cline' }),
    (error) => { assert.match(error.message, /--account/); return true; },
  );
  assert.throws(
    () => parseCliArgs(['--today', '--dashboard'], { runtimeId: 'mcode' }),
    (error) => { assert.doesNotMatch(error.message, /--account/); return true; },
  );
});
