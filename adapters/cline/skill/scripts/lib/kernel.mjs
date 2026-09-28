/**
 * The shared CLI kernel.
 *
 * ## Why this exists
 *
 * Both entry points independently define `parseArgs`, `loadConfig`, `handleConfigAction`,
 * `runSetup`, `runDiagnostic`, and a `main()` that dispatches the same modes. Every new mode is
 * written twice, and Phase 5 has six more runtimes queued, so the duplication is not a one-off
 * cost: it is six times the cost of every fix that follows.
 *
 * `shared/runtime-adapter.mjs` defines what an adapter must provide. This module is the other
 * half: it owns the orchestration that is identical for every runtime, so an adapter only has to
 * describe what is genuinely its own.
 *
 * ## What the kernel deliberately does not do
 *
 * It does not interpret a runtime's storage, and it does not render a report. Those are the two
 * places where being wrong produces a plausible number rather than an error, so they stay in the
 * adapter where a human reads them. The kernel decides *which* mode runs and *what the exit code
 * is*; the adapter decides what the mode means.
 *
 * ## Exit codes
 *
 * These are a contract, and they are the reason exit 2 is not the same as a crash:
 *
 * - `0` the run succeeded and every figure was priced.
 * - `2` the run succeeded but the answer is incomplete: an unpriced session, a partial-coverage
 *   rate table, or a usage error. A caller can tell "I could not price this" from "the tool broke".
 * - `1` an unexpected failure. Never used for a known condition.
 */

import { CliUsageError, parseCliArgs } from './cli-args.mjs';
import { STEP_HOOKS, assertAdapter } from './runtime-adapter.mjs';

/** The exit code for "ran fine, but the answer is not complete". */
export const EXIT_INCOMPLETE = 2;
/** The exit code for an unexpected failure. */
export const EXIT_FAILURE = 1;

/**
 * A user-facing failure: a condition the tool understood and can explain.
 *
 * Thrown rather than calling process.exit() because exiting while undici/fetch handles are still
 * open trips a libuv assertion on Windows. The top-level catch sets the exit code instead.
 */
export class KernelError extends Error {
  constructor(message, { exitCode = EXIT_INCOMPLETE } = {}) {
    super(message);
    this.name = 'KernelError';
    this.exitCode = exitCode;
  }
}

/** Report a condition the user can act on. Throws, so callers must be inside a try. */
export function fail(message, options) {
  throw new KernelError(message, options);
}

/**
 * Parse an argument vector for a runtime, and answer --help and --version.
 *
 * The ordering matters and is inherited from the entry points this replaces: a usage error must be
 * reported before any storage is opened, --help and --version must win over anything else in the
 * vector (a user who asked for help should get help, not a complaint about another flag), and the
 * defaults come from the adapter so each runtime keeps its own.
 *
 * Returns either a terminal action (`{ kind: 'help' | 'version' }`) or the parsed options.
 */
export function parseKernelArgs(adapter, argv) {
  let parsed;
  try {
    parsed = parseCliArgs(argv, { runtimeId: adapter.id, defaults: adapter.defaults ?? {} });
  } catch (error) {
    // A usage error is a user error, not a crash: exit 2, one readable line, no stack.
    if (error instanceof CliUsageError) fail(error.message);
    throw error;
  }
  if (parsed.help) return { kind: 'help' };
  if (parsed.version) return { kind: 'version' };
  return { kind: 'options', options: parsed };
}

/**
 * The order a run performs its steps in, as data.
 *
 * This is the kernel's actual contract with an adapter, and it is deliberately a list rather than
 * a call graph so the order is readable in one place and testable without running a runtime. The
 * entry points this replaces all did the same seven things in this order; a mode that ran before
 * the config action returned was a bug in one adapter and not the other.
 *
 * A step may be absent on an adapter that does not support it. The kernel skips absent steps
 * rather than calling an undefined function, so a runtime with no rate table has no refresh step.
 */
export const RUN_STEPS = STEP_HOOKS;

/**
 * The name of an extra mode the options select, if any.
 *
 * A runtime can offer a mode that is not a session report at all - Cline's `--account` reads the
 * account API rather than the local ledger and produces a different document. Declaring it as an
 * extraMode rather than branching inside the report step keeps that separation visible: there is
 * no code path on which an account figure can reach `billing`, because the two never share a
 * function. The roadmap's rule 3 depends on this, and a branch inside main() is exactly how it
 * would be lost.
 *
 * Returns undefined when no extra mode was requested, so the caller can fall through to the report.
 */
export function selectedExtraMode(adapter, options) {
  const modes = adapter.extraModes;
  if (!modes || typeof modes !== 'object') return undefined;
  for (const [name, handler] of Object.entries(modes)) {
    if (typeof handler !== 'function') continue;
    if (options[name] === true) return name;
  }
  return undefined;
}

/**
 * Run every step up to and including `stepName`.
 *
 * A step returning `undefined` means "nothing to do, carry on". A step returning a number is an
 * exit code and stops the run, which is how --help, --version, and the config actions return
 * without the adapter's own main ever being called.
 */
export async function runToStep(adapter, context, stepName) {
  const target = RUN_STEPS.indexOf(stepName);
  if (target === -1) throw new Error(`unknown kernel step: ${stepName}`);
  for (const step of RUN_STEPS.slice(0, target + 1)) {
    const handler = adapter[step];
    if (handler === undefined) continue;
    const result = await handler(context);
    if (typeof result === 'number') return result;
  }
  return undefined;
}

/**
 * Run a runtime end to end and resolve to an exit code.
 *
 * This never throws and never calls process.exit(): it translates a known failure into a readable
 * line plus exit 2, and an unknown one into a single line plus exit 1 with the stack kept behind
 * SESSION_COST_DEBUG. A stack trace names local source paths and can quote a payload fragment, so
 * it is not something to print by default.
 */
export async function runCli(adapter, argv, { env = process.env, stdout = console.log, stderr = console.error } = {}) {
  assertAdapter(adapter);
  const context = { argv, env, stdout, stderr };

  try {
    const parsed = parseKernelArgs(adapter, argv);
    if (parsed.kind === 'help') {
      stdout(adapter.helpLines().join('\n'));
      return 0;
    }
    if (parsed.kind === 'version') {
      stdout(adapter.versionBanner());
      return 0;
    }
    context.opts = parsed.options;

    // An extra mode replaces the *report* step, not the steps before it. That distinction is the
    // whole bug this comment exists to prevent: dispatching an extra mode straight after loadConfig
    // silently skipped configAction, setup, diagnostic and applyDefaults, so `--account --init-config`
    // stopped writing the config file and went to the network instead. Every earlier step still has
    // to run and still gets to end the run, exactly as it does for a normal report.
    const extraMode = selectedExtraMode(adapter, context.opts);
    if (!extraMode && typeof adapter.run !== 'function') {
      // A runtime with no setup wizard and no diagnostics is normal; one with nothing to report is
      // not. Reaching the end of a parsed argv with no step that produces output would tell a caller
      // a session cost $0.00 while printing nothing, which is the "unknown drawn as zero" failure
      // this project exists to avoid. An incomplete answer (2), not a success.
      fail(`the ${adapter.id} adapter defines no run step, so there is nothing to report`);
    }

    for (const step of RUN_STEPS) {
      if (step === 'run') {
        // The one place the two diverge. Every earlier step has already run and had its chance to
        // return an exit code.
        if (extraMode) {
          const result = await adapter.extraModes[extraMode](context);
          return typeof result === 'number' ? result : 0;
        }
        const result = await adapter.run(context);
        return typeof result === 'number' ? result : 0;
      }
      const handler = adapter[step];
      if (handler === undefined) continue;
      const result = await handler(context);
      if (typeof result === 'number') return result;
    }
    return 0;
  } catch (error) {
    if (error instanceof KernelError) {
      stderr(`session-cost: ${error.message}`);
      return error.exitCode;
    }
    stderr(`session-cost: unexpected failure: ${error?.message ?? String(error)}`);
    if (env.SESSION_COST_DEBUG) stderr(error?.stack ?? '');
    return EXIT_FAILURE;
  }
}
