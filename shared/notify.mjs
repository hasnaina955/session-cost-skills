// Budget alerts leave the terminal, because a budget you have to be looking at is not a budget.
//
// The rule this file exists to protect is accounting rule 1 carried into a new place: an unknown
// cost has no severity, so it cannot raise an alert. A session whose price cannot be established is
// not "safely under budget", and a notification saying so would be the most expensive kind of wrong
// this tool can produce - it interrupts a person to tell them something false. `null` therefore
// never crosses a threshold here, and never marks one as fired.
//
// The second rule is about how the alert is delivered. Every platform command is invoked with an
// argument *array* and `shell: false`. A notification body carries a session id and a dollar
// figure, both of which are attacker-adjacent strings as far as a shell is concerned; a
// concatenated command line would be a quoting bug waiting for a session id with a semicolon in it.
// Where a platform's own quoting rules would otherwise force user data into a script literal, the
// script reads its arguments from the process argv instead - see the osascript and PowerShell
// shapes below.
//
// Everything is injectable. `spawn`, `write`, `canRun` and `platform` are parameters so a test can
// assert the exact argv that would have been executed without a bell ever ringing and a desktop
// notification ever appearing.

import { spawn as nodeSpawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

/** The severity a budget alert carries. `unknown` is deliberately not a severity. */
export const ALERT_SEVERITY = Object.freeze({ CRITICAL: 'critical' });

/** Why a requested desktop notifier is unavailable, or null when one was found. */
export const NOTIFIER_UNAVAILABLE = Object.freeze({
  UNSUPPORTED_PLATFORM: 'unsupported-platform',
  COMMAND_NOT_FOUND: 'command-not-found',
  DISABLED: 'disabled',
});

const BELL = '\u0007';

/**
 * The argv plan for one platform's desktop notification.
 *
 * This is a pure function: it decides *what would be run* and never runs it. Separating
 * resolution from delivery is what makes "which command would fire" a question a test can assert
 * on any host, including one with no notification daemon at all.
 *
 * The caller's strings (title, body) are never interpolated into the script text on any platform.
 * On macOS the script reads `argv` through an `on run` handler; on Windows the values are passed
 * positionally after the `-Command` script and arrive as `$args[0]`/`$args[1]`. Only the Linux path
 * hands them straight to the command, because `notify-send` takes ordinary arguments and does no
 * parsing of its own beyond markup.
 *
 * `placeholders` gives the indices of the body and the title within `args`, so a caller can splice
 * real values in without this function having to build a partial command line.
 */
export function resolveDesktopCommand({ platform = process.platform, canRun = () => true } = {}) {
  if (platform === 'darwin') {
    if (!canRun('osascript')) {
      return { unavailable: NOTIFIER_UNAVAILABLE.COMMAND_NOT_FOUND, command: 'osascript' };
    }
    return {
      command: 'osascript',
      // `--` ends osascript's own option parsing, so a body beginning with `-` is read as an
      // argument rather than an option. The handler takes the body first so the two are never
      // positionally transposed.
      args: [
        '-e', 'on run argv',
        '-e', 'display notification (item 1 of argv) with title (item 2 of argv)',
        '-e', 'end run',
        '--', '', '',
      ],
      placeholders: [7, 8],
    };
  }

  if (platform === 'linux') {
    if (!canRun('notify-send')) {
      return { unavailable: NOTIFIER_UNAVAILABLE.COMMAND_NOT_FOUND, command: 'notify-send' };
    }
    // notify-send reads a leading `-` as an option, so `--` terminates them first.
    return { command: 'notify-send', args: ['--', '', ''], placeholders: [1, 2] };
  }

  if (platform === 'win32') {
    if (!canRun('powershell.exe')) {
      return { unavailable: NOTIFIER_UNAVAILABLE.COMMAND_NOT_FOUND, command: 'powershell.exe' };
    }
    // A plain WinRT toast: no icon, no sound, no module to install. The title and body are
    // appended after the script text and arrive as `$args[1]` and `$args[0]`, so a session id
    // containing a quote cannot terminate the PowerShell string literal it would otherwise have
    // been pasted into. The XML is built inside PowerShell because WinRT wants an XmlDocument,
    // not a string.
    const script = [
      'Add-Type -AssemblyName System.Runtime.WindowsRuntime',
      '$t = New-Object Windows.Data.Xml.Dom.XmlDocument',
      '$t.LoadXml(\'<toast><visual><binding template="ToastGeneric"><text id="1">\' + $args[1] + \'</text><text id="2">\' + $args[0] + \'</text></binding></visual></toast>\')',
      '[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("session-cost").Show([Windows.UI.Notifications.ToastNotification]::new($t))',
    ].join('; ');
    return {
      command: 'powershell.exe',
      args: ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script, '', ''],
      placeholders: [6, 7],
    };
  }

  return { unavailable: NOTIFIER_UNAVAILABLE.UNSUPPORTED_PLATFORM, command: null };
}

/**
 * Whether `command` is on PATH and executable.
 *
 * PATH is walked by hand rather than shelling out to `which` (absent on Windows) or spawning a
 * probe process (which would cost a spawn on every `--watch` start). A non-executable or
 * unreadable candidate is skipped exactly as a missing one would be, so a directory containing a
 * same-named data file does not yield a notifier that fails the first time it fires.
 *
 * On Windows the lookup honours PATHEXT, and honours it in one direction only: a command that
 * already names an extension is matched as written. Appending the extensions to every command
 * would search for `powershell.exe.exe` and conclude the one notifier Windows has is missing.
 */
export function defaultCanRun(command, {
  env = process.env,
  platform = process.platform,
  fsImpl = fs,
} = {}) {
  if (typeof command !== 'string' || command === '') return false;
  const rawPath = env?.PATH ?? env?.Path ?? env?.path ?? '';
  if (rawPath === '') return false;
  const separator = platform === 'win32' ? ';' : ':';
  const pathext = (env?.PATHEXT ?? env?.PathExt ?? '.COM;.EXE;.BAT;.CMD').toUpperCase().split(';');
  const extensions = platform === 'win32'
    // A command that already carries an extension - which every Windows notifier does, because
    // `powershell.exe` is the command - must be looked up as-is. Appending PATHEXT to it searches
    // for `powershell.exe.exe`, finds nothing, and reports the one notifier the machine has as
    // missing, which silently downgrades `--notify` to the terminal bell.
    ? (() => {
      const upper = command.toUpperCase();
      if (pathext.some((extension) => extension !== '' && upper.endsWith(extension))) return [''];
      return pathext;
    })()
    : [''];
  for (const directory of rawPath.split(separator)) {
    if (directory === '') continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      try {
        if (!fsImpl.statSync(candidate).isFile()) continue;
        if (platform === 'win32') return true;
        // On POSIX the execute bit is the whole question; a readable data file is not a command.
        fsImpl.accessSync(candidate, fsImpl.constants?.X_OK ?? 1);
        return true;
      } catch {
        // Not a candidate, or not runnable. Either way, keep looking.
      }
    }
  }
  return false;
}

function defaultWrite(stream, text) {
  stream.write(text);
}

/**
 * Deliver through the resolved plan.
 *
 * `shell: false` is passed explicitly rather than left to inherit, so a future edit cannot make
 * the spawn pick up a shell from a wider options object.
 */
function spawnDesktop(spawnImpl, desktop, title, body) {
  const args = [...desktop.args];
  const [bodyIndex, titleIndex] = desktop.placeholders;
  args[bodyIndex] = body;
  args[titleIndex] = title;
  const child = spawnImpl(desktop.command, args, { stdio: 'ignore', shell: false });
  // A failed notification is a missing convenience, not a failed report: the verdict is already
  // printed and has already set the exit code. Without these two the child's failure would
  // surface as an unhandled 'error' event and take the process down.
  child?.on?.('error', () => {});
  child?.unref?.();
}

/**
 * Build a notifier.
 *
 * `desktop: false` forces bell-only mode, which is what `--notify` degrades to when the platform
 * has no notifier. The missing-notifier warning is emitted at most once per notifier, on first
 * use, so a long `--watch` does not reprint it on every poll.
 */
export function createNotifier({
  platform = process.platform,
  canRun = defaultCanRun,
  bell = true,
  desktop = true,
  stream = process.stderr,
  write = defaultWrite,
  spawn = nodeSpawn,
  env = process.env,
} = {}) {
  const plan = desktop ? resolveDesktopCommand({ platform, canRun }) : null;
  const missing = !desktop
    ? NOTIFIER_UNAVAILABLE.DISABLED
    : plan === null
      ? NOTIFIER_UNAVAILABLE.UNSUPPORTED_PLATFORM
      : plan.unavailable ?? null;
  let warned = false;

  function warnOnce() {
    if (warned) return false;
    warned = true;
    const which = plan?.command === null || plan?.command === undefined ? '' : ` (${plan.command} not found)`;
    write(stream, `note: no desktop notifier available${which}; using the terminal bell only\n`);
    return true;
  }

  return {
    /** Whether a desktop notifier was found. */
    available: missing === null,
    unavailableReason: missing,

    /**
     * Raise one alert.
     *
     * Returns what it actually did, so a caller - or a test - can read the decision rather than
     * infer it from a side effect. `desktop: true` here means "the platform notifier was invoked",
     * not that the notification was displayed; nothing in this tool can know that, and claiming it
     * would be a claim it cannot support.
     */
    alert({ title, body, severity = ALERT_SEVERITY.CRITICAL } = {}) {
      const safeTitle = typeof title === 'string' && title !== '' ? title : 'session-cost';
      const safeBody = typeof body === 'string' && body !== '' ? body : '';
      const rang = bell ? (write(stream, BELL), true) : false;
      const sentDesktop = missing === null;
      if (sentDesktop) {
        try {
          spawnDesktop(spawn, plan, safeTitle, safeBody);
        } catch {
          // A notifier that refuses to start is not a reason to fail the report.
        }
      } else if (desktop) {
        warnOnce();
      }
      return { bell: rang, desktop: sentDesktop, severity, unavailableReason: missing };
    },

    /** True the first time it reports a missing notifier, false every time after. */
    warnMissing: warnOnce,

    /** Whether the notifier has already complained. */
    get warned() { return warned; },
  };
}

/**
 * The alert gate: thresholds that fire once each, and never on an unknown amount.
 *
 * A threshold fires when a *known* amount passes it. `null` is not a small amount, so it is never
 * compared - the same decision `shared/budget.mjs` makes about whether a budget was exceeded,
 * applied to the moment of announcement. An unknown reading leaves every threshold unfired, so the
 * first real number after an unpriced stretch still alerts.
 *
 * Falling back is deliberately unsupported. If a spend rises, crosses, and a later report cannot
 * price it, the alert has fired and stays fired: re-announcing a crossing that was already
 * announced is the failure this gate exists to prevent.
 */
export function createAlertGate({ thresholds = [], notifier = null } = {}) {
  const armed = [];
  for (const value of thresholds) {
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      armed.push({ usd: value, fired: false });
    }
  }

  return {
    /**
     * Offer the latest known amount. Returns the thresholds this call crossed, in the order given.
     * An empty array is the common case on every poll after the first crossing.
     */
    observe(amountUsd) {
      // Accounting rule 1, in a new place: an unknown amount has no severity and cannot alert.
      if (typeof amountUsd !== 'number' || !Number.isFinite(amountUsd)) return [];
      const crossed = [];
      for (const threshold of armed) {
        if (threshold.fired) continue;
        if (amountUsd > threshold.usd) {
          threshold.fired = true;
          crossed.push(threshold.usd);
        }
        // No early break: a low cap must not be shadowed by a high one that was checked first.
      }
      return crossed;
    },

    /**
     * Observe and announce. Returns the thresholds that fired, so a caller can log or count them.
     * Separated from `observe` so a caller can decide *when* to announce - the live view wants to
     * repaint before it rings, and a test wants to assert the gate without any output at all.
     */
    flush(amountUsd, {
      title = 'session-cost budget',
      format = (usd) => `session spend passed $${usd}`,
    } = {}) {
      const fired = this.observe(amountUsd);
      if (notifier !== null) {
        for (const usd of fired) {
          notifier.alert({ title, body: format(usd), severity: ALERT_SEVERITY.CRITICAL });
        }
      }
      return fired;
    },

    /** Thresholds still waiting to fire, for a line in the live frame. */
    pending() {
      return armed.filter((threshold) => !threshold.fired).map((threshold) => threshold.usd);
    },

    /** Thresholds that have already announced. */
    fired() {
      return armed.filter((threshold) => threshold.fired).map((threshold) => threshold.usd);
    },
  };
}
