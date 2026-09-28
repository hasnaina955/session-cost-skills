import test from 'node:test';
import assert from 'node:assert/strict';
import {
  EXIT_FAILURE,
  EXIT_INCOMPLETE,
  KernelError,
  RUN_STEPS,
  fail,
  runCli,
  runToStep,
} from '../shared/kernel.mjs';
import { validateAdapter, REQUIRED_MEMBERS } from '../shared/runtime-adapter.mjs';

/**
 * The kernel is the half of the CLI that is identical for every runtime, so these tests are about
 * the contract rather than about any one runtime's numbers: which step runs in which order, what a
 * step returning a number means, and above all what each exit code promises.
 *
 * The exit codes are the part that cannot be changed later without breaking someone's automation,
 * so they are pinned individually rather than as a group.
 */

/** A complete adapter with no runtime behaviour, plus whatever a test wants to observe. */
function kernelAdapter(overrides = {}) {
  const adapter = {
    id: 'mcode',
    displayName: 'MiniMax Code',
    costBasis: 'provider-rate-estimate',
    defaults: { session: null, mode: 'current', list: 0, json: false },
    defaultDataDir: () => '/tmp/kernel',
    open: () => ({}),
    close: () => {},
    listSessions: () => [],
    resolveCurrent: () => ({ sessionId: 's1' }),
    buildReport: () => ({}),
    aggregate: (reports) => ({ aggregated: reports.length }),
    helpLines: () => ['line one', 'line two'],
    versionBanner: () => 'session-cost 0.0.0 (kernel adapter)',
    ...overrides,
  };
  return adapter;
}

/** Capture stdout/stderr so a test can assert on what a user would actually see. */
function capture() {
  const out = [];
  const err = [];
  return { out, err, io: { stdout: (line) => out.push(line), stderr: (line) => err.push(line) } };
}

test('a complete kernel adapter validates', () => {
  // The kernel refuses an adapter it cannot drive, and it must refuse it before anything runs.
  assert.deepEqual(validateAdapter(kernelAdapter()), []);
});

test('the kernel owns the step order, and an adapter may only fill in gaps', () => {
  assert.deepEqual(RUN_STEPS, [
    'loadConfig', 'configAction', 'setup', 'diagnostic', 'applyDefaults', 'preflight', 'run',
  ]);
  // The order is a contract, so a reordering fails here rather than in one runtime's output.
  assert.equal(RUN_STEPS.indexOf('configAction') < RUN_STEPS.indexOf('run'), true);
});

test('steps run in order, and an absent step is skipped rather than called', async () => {
  const order = [];
  const adapter = kernelAdapter({
    loadConfig: () => { order.push('loadConfig'); },
    configAction: () => { order.push('configAction'); },
    // setup and diagnostic deliberately absent
    applyDefaults: () => { order.push('applyDefaults'); },
    preflight: () => { order.push('preflight'); },
    run: () => { order.push('run'); return 0; },
  });
  await runToStep(adapter, {}, 'run');
  assert.deepEqual(order, ['loadConfig', 'configAction', 'applyDefaults', 'preflight', 'run']);
});

test('a step returning a number is an exit code and stops the run', async () => {
  // This is how --help, --version and the config actions return without the adapter main running.
  let ranMain = false;
  const adapter = kernelAdapter({
    configAction: () => 0,
    run: () => { ranMain = true; return 0; },
  });
  const code = await runToStep(adapter, {}, 'run');
  assert.equal(code, 0);
  assert.equal(ranMain, false, 'main must not run after a step returned an exit code');
});

test('an unknown step name is refused rather than silently ignored', async () => {
  await assert.rejects(() => runToStep(kernelAdapter(), {}, 'nope'), /unknown kernel step: nope/);

test('--help prints the adapter help and exits 0 without running the adapter', async () => {
  const { out, err, io } = capture();
  let ranMain = false;
  const code = await runCli(kernelAdapter({ run: () => { ranMain = true; return 0; } }), ['--help'], io);
  assert.equal(code, 0);
  assert.deepEqual(out, ['line one\nline two']);
  assert.deepEqual(err, []);
  assert.equal(ranMain, false);
});

test('--version prints the banner and exits 0', async () => {
  const { out, io } = capture();
  const code = await runCli(kernelAdapter(), ['--version'], io);
  assert.equal(code, 0);
  assert.deepEqual(out, ['session-cost 0.0.0 (kernel adapter)']);
});

test('--help wins over an invalid flag, because a user asking for help should get help', async () => {
  // Inherited from the entry points this replaces, and a regression here is a regression in both.
  const { out, err, io } = capture();
  const code = await runCli(kernelAdapter(), ['--nonsense', '--help'], io);
  assert.equal(code, 0);
  assert.equal(out.length, 1);
  assert.deepEqual(err, []);
});

test('a usage error is exit 2 with one readable line and no stack', async () => {
  const { out, err, io } = capture();
  const code = await runCli(kernelAdapter(), ['--nonsense'], io);
  assert.equal(code, EXIT_INCOMPLETE, 'an unknown flag is a user error, not a crash');
  assert.deepEqual(out, []);
  assert.equal(err.length, 1);
  assert.match(err[0], /^session-cost: unknown argument: --nonsense$/);
  assert.doesNotMatch(err[0], /at .*\.mjs:\d+/, 'a usage error must not print a stack');
});

test('a known failure is exit 2 and an unknown one is exit 1', async () => {
  const known = capture();
  const adapter = kernelAdapter({ run: () => fail('MCode ledger contains no known sessions') });
  assert.equal(await runCli(adapter, [], known.io), EXIT_INCOMPLETE);
  assert.deepEqual(known.err, ['session-cost: MCode ledger contains no known sessions']);

  // Exit 1 is reserved for a real fault, so a caller can tell "could not price this" from
  // "the tool broke". These are different problems with different responses.
  const unknown = capture();
  const broken = kernelAdapter({ run: () => { throw new TypeError('cannot read x of undefined'); } });
  assert.equal(await runCli(broken, [], unknown.io), EXIT_FAILURE);
  assert.equal(unknown.err.length, 1);
  assert.match(unknown.err[0], /unexpected failure: cannot read x of undefined/);
  assert.doesNotMatch(unknown.err[0], /at .*\.mjs:\d+/, 'a stack is withheld by default');
});

test('the stack appears only behind SESSION_COST_DEBUG', async () => {
  // A stack names local source paths and can quote a payload fragment, so it is opt-in.
  const boom = () => { throw new TypeError('boom'); };
  const quiet = capture();
  await runCli(kernelAdapter({ run: boom }), [], { ...quiet.io, env: {} });
  assert.doesNotMatch(quiet.err.join('\n'), /kernel\.mjs:\d+/);

  const loud = capture();
  await runCli(kernelAdapter({ run: boom }), [], { ...loud.io, env: { SESSION_COST_DEBUG: '1' } });
  assert.match(loud.err.join('\n'), /kernel\.mjs:\d+/, 'the detail stays available on request');
});

test('an adapter that cannot be driven is refused before any output', async () => {
  const broken = kernelAdapter();
  delete broken.close;
  const { out, io } = capture();
  // assertAdapter throws rather than returning a code, so this surfaces as a rejected promise
  // rather than a silent success: a half-built adapter must never look like a clean run.
  await assert.rejects(() => runCli(broken, [], io), /not usable[\s\S]*close/);
  assert.deepEqual(out, []);
});

test('an adapter with no run step reports an incomplete answer, never a silent zero', async () => {
  // Every earlier step is optional, so a runtime with no setup wizard is normal. Reaching the end
  // of a parsed argv with no run step is not: returning 0 there would tell a caller a session cost
  // $0.00 while printing nothing, which is the exact failure this project exists to prevent.
  const { out, err, io } = capture();
  const code = await runCli(kernelAdapter(), [], io);
  assert.equal(code, EXIT_INCOMPLETE);
  assert.deepEqual(out, [], 'nothing may be printed that could be read as a figure');
  assert.match(err.join('\n'), /defines no run step/);
});

test('the adapter receives the parsed options, not the raw argv', async () => {
  let seen = null;
  const { io } = capture();
  await runCli(kernelAdapter({ run: (context) => { seen = context.opts; return 0; } }), ['--json'], io);
  assert.equal(seen.json, true);
  assert.equal(seen.mode, 'current', 'defaults come from the adapter');
  assert.equal(REQUIRED_MEMBERS.includes('buildReport'), true, 'the interface still names buildReport');
});

});

test('fail raises a KernelError carrying the incomplete exit code', () => {
  assert.throws(() => fail('no sessions match'), (error) => {
    assert.ok(error instanceof KernelError);
    assert.equal(error.exitCode, EXIT_INCOMPLETE);
    assert.equal(error.message, 'no sessions match');
    return true;
  });
});
