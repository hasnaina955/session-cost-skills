import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { removeDirectory } from './helpers/temp-dir.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ALERT_SEVERITY,
  NOTIFIER_UNAVAILABLE,
  createAlertGate,
  createNotifier,
  defaultCanRun,
  resolveDesktopCommand,
} from '../shared/notify.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * A notifier that records what it was asked to do.
 *
 * The roadmap's acceptance criterion is "inject a fake notifier and assert exactly one alert per
 * threshold crossing", so the fake has to be able to count alerts *and* capture the exact argv the
 * real one would have used. Nothing here writes to a real stream or spawns a real process: a test
 * that rang a bell or raised a toast on the developer's machine would be a test nobody runs twice.
 */
/**
 * A `PATH` value for the current platform, holding exactly one directory.
 *
 * Built from the real environment rather than hardcoded so the lookup test can run on any host:
 * an empty or invented PATH would find nothing and the assertion would prove nothing.
 */
function platformPathValue(directory) {
  const isWindows = process.platform === 'win32';
  return isWindows
    ? { PATH: directory, PATHEXT: '.COM;.EXE;.BAT;.CMD' }
    : { PATH: directory };
}

function recordingNotifier(overrides = {}) {
  const writes = [];
  const spawns = [];
  const notifier = createNotifier({
    platform: 'linux',
    canRun: () => true,
    stream: { write: (text) => writes.push(text) },
    spawn: (command, args, options) => {
      spawns.push({ command, args, options });
      return { on() {}, unref() {} };
    },
    ...overrides,
  });
  return { notifier, writes, spawns };
}

test('the alert gate fires a threshold exactly once, however often it is observed', () => {
  const gate = createAlertGate({ thresholds: [1] });

  assert.deepEqual(gate.observe(0.5), [], 'under the cap must not fire');
  assert.deepEqual(gate.observe(1.0), [], 'exactly at the cap is not over it');
  assert.deepEqual(gate.observe(1.5), [1], 'the first crossing fires');
  assert.deepEqual(gate.observe(1.6), [], 'a watch poll must not re-announce');
  assert.deepEqual(gate.observe(9.0), [], 'nor may a large jump re-announce');
  assert.deepEqual(gate.fired(), [1]);
  assert.deepEqual(gate.pending(), []);
});

test('an unknown cost never fires a threshold and never marks one as fired', () => {
  // Accounting rule 1 in its new home. `null` is not a small amount of money.
  const gate = createAlertGate({ thresholds: [1] });

  assert.deepEqual(gate.observe(null), [], 'null has no severity');
  assert.deepEqual(gate.observe(undefined), []);
  assert.deepEqual(gate.observe(Number.NaN), []);
  assert.deepEqual(gate.observe(Number.POSITIVE_INFINITY), [], 'infinite is not a real spend');
  assert.deepEqual(gate.pending(), [1], 'the threshold must still be armed afterwards');

  // The first real number after an unpriced stretch still alerts, rather than the unknown
  // having quietly consumed the one notification the user was owed.
  assert.deepEqual(gate.observe(2), [1]);
});

test('a partially priced lower bound can fire a blown budget, and an unknown one cannot', () => {
  // A partial amount is a lower bound: it can prove a cap was passed, but never that one was
  // respected. Only the first of those two is a notification this tool is entitled to send.
  const gate = createAlertGate({ thresholds: [1] });
  assert.deepEqual(gate.observe(1.2), [1], 'a known amount over the cap fires');
  assert.deepEqual(createAlertGate({ thresholds: [1] }).observe(0.2), [], 'under the cap stays quiet');
});

test('each threshold fires once, independently, and a low cap is not shadowed by a high one', () => {
  const gate = createAlertGate({ thresholds: [10, 1] });

  assert.deepEqual(gate.observe(2), [1], 'only the crossed one fires, in the order given');
  assert.deepEqual(gate.observe(11), [10], 'the high cap fires on its own crossing');
  assert.deepEqual(gate.observe(50), [], 'both are already spent');
  assert.deepEqual(gate.fired(), [10, 1]);
});

test('a non-numeric or negative threshold is not armed rather than armed as a trap', () => {
  const gate = createAlertGate({ thresholds: [1, Number.NaN, -5, '3', null, Number.POSITIVE_INFINITY] });
  assert.deepEqual(gate.observe(100), [1], 'only the one usable cap is live');
  assert.deepEqual(gate.pending(), []);
});

test('flush announces each crossing once and reports what fired', () => {
  const { notifier, writes, spawns } = recordingNotifier();
  const gate = createAlertGate({ thresholds: [1], notifier });

  gate.flush(0.5);
  assert.equal(spawns.length, 0, 'no alert before the cap is passed');

  gate.flush(1.5);
  assert.equal(spawns.length, 1, 'one alert on the crossing');
  assert.deepEqual(writes, ['\u0007'], 'the bell is written to the stream, once');

  gate.flush(4);
  assert.equal(spawns.length, 1, 'a later poll must not add a second alert');
  assert.equal(writes.length, 1, 'nor a second bell');
});

test('an unknown amount through flush is silent and leaves the alert undelivered', () => {
  const { notifier, writes, spawns } = recordingNotifier();
  const gate = createAlertGate({ thresholds: [1], notifier });

  assert.deepEqual(gate.flush(null), []);
  assert.deepEqual(gate.flush(Number.NaN), []);
  assert.equal(spawns.length, 0, 'no notification for a spend nobody can price');
  assert.equal(writes.length, 0, 'and no bell either');
  assert.deepEqual(gate.pending(), [1], 'the alert is still owed');
});

test('a notifier with no notifier available warns once, then stays quiet', () => {
  const writes = [];
  const notifier = createNotifier({
    platform: 'linux',
    canRun: () => false,
    stream: { write: (text) => writes.push(text) },
    spawn: () => assert.fail('must not spawn a notifier that was not found'),
  });

  assert.equal(notifier.available, false);
  assert.equal(notifier.unavailableReason, NOTIFIER_UNAVAILABLE.COMMAND_NOT_FOUND);

  notifier.alert({ title: 't', body: 'b' });
  notifier.alert({ title: 't', body: 'b' });
  notifier.alert({ title: 't', body: 'b' });

  // Three alerts, one warning. A `--watch` runs for hours; reprinting this per poll would make
  // the feature unusable.
  const warnings = writes.filter((text) => text.startsWith('note:'));
  assert.equal(warnings.length, 1, 'the missing notifier is reported once');
  assert.match(warnings[0], /notify-send not found/);
  assert.equal(writes.filter((text) => text === '\u0007').length, 3, 'the bell still rings each time');
});

test('desktop:false means bell only, and does not warn about a notifier nobody asked for', () => {
  const writes = [];
  const notifier = createNotifier({
    desktop: false,
    stream: { write: (text) => writes.push(text) },
    spawn: () => assert.fail('desktop:false must not spawn anything'),
  });

  const result = notifier.alert({ title: 't', body: 'b' });
  assert.equal(result.desktop, false);
  assert.equal(result.unavailableReason, NOTIFIER_UNAVAILABLE.DISABLED);
  assert.equal(notifier.warned, false, 'a deliberate bell-only mode is not a problem to report');
  assert.deepEqual(writes, ['\u0007']);
});

test('an alert that cannot spawn still leaves the report alone', () => {
  const writes = [];
  const notifier = createNotifier({
    platform: 'linux',
    canRun: () => true,
    stream: { write: (text) => writes.push(text) },
    spawn: () => { throw new Error('no notification daemon here'); },
  });

  // The budget verdict is already printed and has already set the exit code by this point. A
  // convenience that fails must not take the report down with it.
  const result = notifier.alert({ title: 't', body: 'b' });
  assert.equal(result.bell, true);
  assert.deepEqual(writes, ['\u0007']);
});

test('every platform is invoked with an argument array and no shell', () => {
  for (const platform of ['darwin', 'linux', 'win32']) {
    const { notifier, spawns } = recordingNotifier({ platform });
    assert.equal(notifier.available, true, `${platform} should resolve a notifier`);
    notifier.alert({ title: 'Budget crossed', body: 'session abc-123 spent $1.20' });

    assert.equal(spawns.length, 1);
    const [call] = spawns;
    assert.equal(call.options.shell, false, `${platform} must not go through a shell`);
    assert.equal(typeof call.args[0], 'string');
    // The body and title must appear as their own argv entries, never inside a command string.
    assert.ok(call.args.includes('session abc-123 spent $1.20'), `${platform}: body must be its own argument`);
    assert.ok(call.args.includes('Budget crossed'), `${platform}: title must be its own argument`);
  }
});

test('a body or title with shell metacharacters stays one inert argument', () => {
  // The reason the argv form exists at all. A concatenated command line would execute this.
  const hostile = "'; rm -rf ~ #";
  const { notifier, spawns } = recordingNotifier({ platform: 'linux' });
  notifier.alert({ title: hostile, body: hostile });

  const [call] = spawns;
  assert.equal(call.args.filter((arg) => arg === hostile).length, 2, 'both survive intact');
  assert.equal(call.options.shell, false);
  // Nothing was concatenated: no argument contains another argument's text plus a separator.
  for (const arg of call.args) {
    assert.doesNotMatch(arg, /rm -rf ~ #.*rm -rf/, 'no argument should have absorbed another');
  }
});

test('the caller strings are never interpolated into the script text', () => {
  // The stronger form of the rule above: on the two platforms whose quoting would have forced
  // user data into a literal, the script must not contain the data at all.
  for (const platform of ['darwin', 'win32']) {
    const { notifier, spawns } = recordingNotifier({ platform });
    const marker = 'UNIQUE-SESSION-9f3a';
    notifier.alert({ title: 't', body: marker });

    const [call] = spawns;
    const script = call.args.filter((arg) => arg.includes('notification') || arg.includes('LoadXml'));
    assert.ok(script.length > 0, `${platform} should carry a script argument`);
    for (const arg of script) {
      assert.ok(!arg.includes(marker), `${platform}: the script text must not contain caller data`);
    }
  }
});

test('an unsupported platform degrades to the bell rather than failing', () => {
  const writes = [];
  const notifier = createNotifier({
    platform: 'freebsd',
    stream: { write: (text) => writes.push(text) },
    spawn: () => assert.fail('must not spawn on an unsupported platform'),
  });

  assert.equal(notifier.available, false);
  assert.equal(notifier.unavailableReason, NOTIFIER_UNAVAILABLE.UNSUPPORTED_PLATFORM);
  const result = notifier.alert({ title: 't', body: 'b' });
  assert.equal(result.bell, true);
  // The bell rings first, then the one-time note explains why there was no desktop notification.
  assert.ok(writes.includes('\u0007'), 'the bell still rings');
  assert.ok(
    writes.some((text) => /note: no desktop notifier available/.test(text)),
    `expected a missing-notifier note, got ${JSON.stringify(writes)}`,
  );
});

test('an empty title or body is replaced rather than sent blank', () => {
  const { notifier, spawns } = recordingNotifier();
  notifier.alert({ title: '', body: '' });
  const [call] = spawns;
  assert.equal(call.args[2], 'session-cost', 'a blank title becomes a real one');
  assert.equal(call.args[1], '', 'a blank body stays blank rather than becoming the word undefined');
});

test('defaultCanRun resolves a real executable and rejects a missing one', () => {
  // The witness is the node binary already running this test, located by PATH search rather than by
  // absolute path, so the assertion tests the lookup itself. It is hermetic: no CI image needs to
  // ship a particular command, and no platform needs a particular tool to be installed.
  //
  // An earlier version asserted that `where` was findable, on the reasoning that it was "on PATH on
  // every supported platform". It is a Windows-only command; Linux and macOS have no such binary,
  // so the test failed on three of the five CI jobs while passing on the machine it was written on.
  const nodeDirectory = path.dirname(process.execPath);
  const nodeCommand = path.basename(process.execPath);
  const searchPath = platformPathValue(nodeDirectory);
  assert.equal(
    defaultCanRun(nodeCommand, { platform: process.platform, env: searchPath }),
    true,
    'the running node binary must be found by PATH lookup',
  );
  assert.equal(
    defaultCanRun('definitely-not-installed-xyzzy', { platform: process.platform, env: searchPath }),
    false,
    'a name that is not there is not found',
  );
  assert.equal(defaultCanRun('', { platform: process.platform, env: searchPath }), false, 'no name, no command');
});

/**
 * A filesystem stub that records every candidate the lookup probes and can be told which
 * candidates exist.
 *
 * A recording stub is the only honest way to test the separator logic. The previous version
 * asserted `defaultCanRun(nodeBinary, {platform:'linux', env:{PATH:…realNodeDirectory}})` is true,
 * which is untestable on Windows: splitting `C:\hostedtoolcache\...` on ":" shreds the drive
 * letter into a bare "C", so the real directory is never a candidate at all and the assertion
 * cannot hold on a GitHub Windows runner - it only passed locally because `path.join` on that one
 * host happens to rebuild something that resolves.
 */
function recordingFs(existing) {
  const probed = [];
  const constant = { X_OK: 1 };
  return {
    probed,
    constants: constant,
    statSync(candidate) {
      probed.push(candidate);
      if (!new Set(existing).has(candidate)) throw new Error('ENOENT');
      return { isFile: () => true };
    },
    // Only reached for a candidate that statSync accepted, so a recorded candidate that never
    // got here is one the POSIX branch rejected on existence rather than on permissions.
    accessSync(candidate) {
      if (!new Set(existing).has(candidate)) throw new Error('EACCES');
    },
  };
}

test('PATH is split on the separator the platform uses, not a hardcoded one', () => {
  // The bug this guards: joining with ':' on Windows, or with ';' on POSIX, finds nothing at all,
  // so the notifier is reported missing on a machine that has it. Neither branch touches the host
  // filesystem, so the same assertions hold on every platform the matrix runs.
  const COMMAND = 'notify-send';
  const POSIX_PATH = '/usr/local/bin:/usr/bin:/bin';
  const WINDOWS_PATH = String.raw`C:\first;C:\second;C:\third`;

  // The fixture builds its paths with `path.join`, exactly as the code under test does, so the
  // comparison is platform-independent. Hardcoding them with "/" would make a Windows host probe
  // `\usr\bin\notify-send` and compare it against a fixture entry written `/usr/bin/notify-send`.
  const posixFound = path.join('/usr/bin', COMMAND);
  const posix = recordingFs([posixFound]);
  assert.equal(
    defaultCanRun(COMMAND, { platform: 'linux', env: { PATH: POSIX_PATH }, fsImpl: posix }),
    true,
    'a POSIX PATH must be split on ":" and the middle directory still reachable',
  );
  assert.deepEqual(posix.probed, [
    path.join('/usr/local/bin', COMMAND),
    posixFound,
  ], 'the ":"-separated directories are each probed, in order');

  // The wrong separator is the failure this test exists for: on a POSIX host, ";" is not a
  // separator, so a ";"-joined PATH is one single directory name and nothing is found.
  const semicolon = recordingFs([posixFound]);
  assert.equal(
    defaultCanRun(COMMAND, { platform: 'linux', env: { PATH: '/usr/local/bin;/usr/bin' }, fsImpl: semicolon }),
    false,
    'a POSIX lookup must not split on ";"',
  );
  assert.deepEqual(semicolon.probed, [
    path.join('/usr/local/bin;/usr/bin', COMMAND),
  ], 'the whole ";"-joined string is one candidate');

  // The fixture names a real Windows executable, extension included, because that is what the
  // code actually probes: PATHEXT is appended to a bare name, so `notify-send` alone is never a
  // candidate on Windows. Naming the bare file here would leave the second directory genuinely
  // unreachable and the assertion would fail for a reason that has nothing to do with separators.
  const windowsFound = path.join('C:\\second', COMMAND + '.COM');
  const windows = recordingFs([windowsFound]);
  assert.equal(
    defaultCanRun(COMMAND, { platform: 'win32', env: { PATH: WINDOWS_PATH }, fsImpl: windows }),
    true,
    'a Windows PATH must be split on ";" and the second directory still reachable',
  );
  assert.deepEqual(windows.probed, [
    path.join('C:\\first', COMMAND + '.COM'),
    path.join('C:\\first', COMMAND + '.EXE'),
    path.join('C:\\first', COMMAND + '.BAT'),
    path.join('C:\\first', COMMAND + '.CMD'),
    windowsFound,
  ], 'each directory is tried against each PATHEXT extension, in order');

  // A Windows command that already names its extension must be matched as written rather than
  // have PATHEXT appended, or the one notifier Windows has is reported missing.
  const powershellFound = path.join('C:\\second', 'powershell.exe');
  const powershell = recordingFs([powershellFound]);
  assert.equal(
    defaultCanRun('powershell.exe', { platform: 'win32', env: { PATH: WINDOWS_PATH }, fsImpl: powershell }),
    true,
    'powershell.exe must be looked up as written, not as powershell.exe.exe',
  );
  assert.deepEqual(powershell.probed, [
    path.join('C:\\first', 'powershell.exe'),
    powershellFound,
  ], 'a named extension suppresses the PATHEXT search');
});

test('the execute bit is what makes a file a command', { skip: process.platform === 'win32' ? 'POSIX permissions only' : false }, () => {
  // Windows has no execute permission bit: `accessSync(path, X_OK)` degrades to an existence
  // check there, so this distinction cannot be asserted on this host and claiming otherwise
  // would be a test that only passes on the machine it was written on.
  const tempDirectory = fs.mkdtempSync(path.join(repositoryRoot, 'tests', '.notify-xbit-'));
  try {
    const candidate = path.join(tempDirectory, 'fakecommand');
    fs.writeFileSync(candidate, 'not a program', 'utf8');
    assert.equal(
      defaultCanRun('fakecommand', { platform: 'linux', env: { PATH: tempDirectory } }),
      false,
      'a readable file without the execute bit is not a command',
    );

    fs.chmodSync(candidate, 0o755);
    assert.equal(
      defaultCanRun('fakecommand', { platform: 'linux', env: { PATH: tempDirectory } }),
      true,
      'the execute bit is what makes it one',
    );
  } finally {
    removeDirectory(tempDirectory);
  }
});

test('a directory on PATH is not mistaken for a command', () => {
  const tempDirectory = fs.mkdtempSync(path.join(repositoryRoot, 'tests', '.notify-dir-'));
  try {
    const directoryNamedLikeACommand = path.join(tempDirectory, 'notify-send');
    fs.mkdirSync(directoryNamedLikeACommand);
    assert.equal(
      defaultCanRun('notify-send', { platform: 'linux', env: { PATH: tempDirectory } }),
      false,
      'a directory that merely shares a command name must not resolve',
    );
  } finally {
    removeDirectory(tempDirectory);
  }
});

test('the desktop command is resolved as a plan, never executed, during resolution', () => {
  let asked = 0;
  const plan = resolveDesktopCommand({ platform: 'linux', canRun: () => { asked += 1; return true; } });
  assert.equal(asked, 1, 'the probe runs once');
  assert.equal(plan.command, 'notify-send');
  assert.equal(plan.unavailable, undefined, 'a found notifier reports no reason');
  // A missing binary is named, so the one-time warning can tell the user what to install.
  const missing = resolveDesktopCommand({ platform: 'darwin', canRun: () => false });
  assert.equal(missing.command, 'osascript');
  assert.equal(missing.unavailable, NOTIFIER_UNAVAILABLE.COMMAND_NOT_FOUND);
});

test('the notifier copy shipped in each adapter is the shared source, byte for byte', () => {
  // The rule that bites: shared/ is the source of truth and adapters hold generated copies.
  const source = fs.readFileSync(path.join(repositoryRoot, 'shared', 'notify.mjs'), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    const copy = path.join(repositoryRoot, 'adapters', runtime, 'skill', 'scripts', 'lib', 'notify.mjs');
    assert.ok(fs.existsSync(copy), `${runtime} adapter is missing its notify copy; run npm run sync:notify`);
    assert.equal(fs.readFileSync(copy, 'utf8'), source, `${runtime} notify copy has drifted`);
  }
});

test('an alert carries a severity, and only one severity exists', () => {
  const { notifier } = recordingNotifier();
  const result = notifier.alert({ title: 't', body: 'b' });
  assert.equal(result.severity, ALERT_SEVERITY.CRITICAL);
  assert.deepEqual(Object.values(ALERT_SEVERITY), ['critical'],
    'there is deliberately no "unknown" severity for an unpriceable session to use');
});
