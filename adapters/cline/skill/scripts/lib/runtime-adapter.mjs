/**
 * The interface a runtime adapter implements.
 *
 * ## Why this exists
 *
 * The two current entry points are 922 and 1,533 lines, and six functions - `parseArgs`,
 * `parseDate`, `loadConfig`, `runSetup`, `runDiagnostic`, `handleConfigAction` - are written twice,
 * verbatim. A third runtime added the current way is a third copy of all of it, and a third place
 * for the next orchestration bug to be fixed in. The roadmap's Phase 5 has six more runtimes queued
 * (CommandCode, OpenCode, Claude Code, Codex, Qwen, Goose), so the duplication is not a one-off
 * cost: it is six times the cost of every fix that follows.
 *
 * An adapter is therefore a plain object with a documented shape, and the kernel owns parsing,
 * selection, mode dispatch, rendering, and exit codes. What stays in the adapter is everything that
 * is genuinely runtime-specific: where the ledger lives, what a call record means, and how a
 * session becomes a normalized report.
 *
 * ## What the kernel deliberately does not do
 *
 * It does not interpret a runtime's storage, and it does not know what a cost means for a given
 * runtime. Those are the two places where being wrong produces a plausible number rather than an
 * error, so they stay in the adapter where a human reads them. `costBasis` exists precisely to
 * keep "the runtime recorded this" and "we calculated this" from being merged.
 */

/** The cost domains, which must never be added together. See docs/architecture.md. */
export const COST_BASIS = Object.freeze({
  /** The runtime itself recorded the cost on each call, as Cline does. */
  RECORDED: 'runtime-recorded',
  /** We price the call from a rate record, as MCode does. */
  ESTIMATED: 'provider-rate-estimate',
});

/**
 * Every member an adapter must provide. Checked before the kernel runs anything.
 *
 * `defaults` and `versionBanner` are here because the kernel drives them, not because an adapter
 * finds them useful: the kernel parses through `shared/cli-args.mjs` and needs each runtime's
 * option defaults, and it answers `--version` on the runtime's behalf. An adapter that supplies
 * neither cannot be run, which is why they are required rather than optional. `helpLines` and the
 * rest stay optional so a minimal adapter is still expressible in a test.
 */
export const REQUIRED_MEMBERS = Object.freeze([
  'id', 'displayName', 'costBasis', 'defaultDataDir', 'open', 'close',
  'listSessions', 'resolveCurrent', 'buildReport', 'aggregate',
  'defaults', 'versionBanner',
]);

/**
 * Optional members.
 *
 * The step hooks (`loadConfig`, `configAction`, `setup`, `diagnostic`, `applyDefaults`,
 * `preflight`, `run`) are deliberately absent from both lists. They are the kernel's own step
 * contract, named by `RUN_STEPS` in `shared/kernel.mjs`, and the kernel skips any it does not find
 * rather than refusing the adapter: a runtime with no rate table has no refresh step, and one with
 * no setup wizard has no setup step. Listing them here would make every runtime declare hooks it
 * has no use for, and the unknown-member guard exists precisely to catch a typo like `buildReprot`
 * that would otherwise be a method nobody calls.
 */
export const OPTIONAL_MEMBERS = Object.freeze(['extraModes', 'helpLines', 'storageSchema']);

/**
 * The kernel's step hooks, duplicated here so the validator can recognise them without importing
 * the kernel (which imports this module, and the cycle would be worse than the duplication).
 *
 * They are optional because the kernel skips any it does not find: a runtime with no rate table
 * has no refresh step, and one with no setup wizard has no setup step. They are nevertheless
 * *permitted*, which is the part that matters - the unknown-member guard exists to catch a typo
 * like `buildReprot` that would otherwise be a method nobody calls, and a hook the kernel itself
 * looks up by name is not that.
 */
export const STEP_HOOKS = Object.freeze([
  'loadConfig', 'configAction', 'setup', 'diagnostic', 'applyDefaults', 'preflight', 'run',
]);


/**
 * Validate an adapter, and return a list of what is wrong with it.
 *
 * This runs before any storage is opened. A missing member found at this point is a clear
 * message; the same mistake found halfway through a report is a stack trace quoting a path.
 */
export function validateAdapter(adapter) {
  const problems = [];
  if (adapter === null || typeof adapter !== 'object') {
    return ['an adapter must be an object'];
  }
  for (const member of REQUIRED_MEMBERS) {
    if (adapter[member] === undefined || adapter[member] === null) {
      problems.push(`missing required member: ${member}()`);
    }
  }
  for (const [member, value] of Object.entries(adapter)) {
    if (REQUIRED_MEMBERS.includes(member) || OPTIONAL_MEMBERS.includes(member) || STEP_HOOKS.includes(member)) continue;
    problems.push(`unknown member: ${member} - extend the interface in shared/runtime-adapter.mjs instead`);
  }
  if (adapter.id !== undefined && !/^[a-z][a-z0-9-]*$/.test(String(adapter.id))) {
    problems.push(`id must be lowercase kebab-case, got ${JSON.stringify(adapter.id)}`);
  }
  if (adapter.costBasis !== undefined && !Object.values(COST_BASIS).includes(adapter.costBasis)) {
    problems.push(`costBasis must be one of ${Object.values(COST_BASIS).join(' | ')}, got ${JSON.stringify(adapter.costBasis)}`);
  }
  for (const member of ['open', 'close', 'listSessions', 'resolveCurrent', 'buildReport', 'aggregate', 'defaultDataDir']) {
    if (adapter[member] !== undefined && typeof adapter[member] !== 'function') {
      problems.push(`${member} must be a function`);
    }
  }
  if (adapter.extraModes !== undefined && (typeof adapter.extraModes !== 'object' || adapter.extraModes === null)) {
    problems.push('extraModes must be an object of mode name to handler');
  }
  return problems;
}

/**
 * Throw with every problem listed at once, rather than one per run.
 *
 * An adapter under development will usually be missing more than one member, and fixing them one
 * error message at a time is a poor use of anyone's time.
 */
export function assertAdapter(adapter) {
  const problems = validateAdapter(adapter);
  if (problems.length === 0) return adapter;
  const name = adapter?.id ?? '(anonymous)';
  throw new Error(`the ${name} runtime adapter is not usable:\n  - ${problems.join('\n  - ')}`);
}

/**
 * Close an adapter's handle, whatever goes wrong on the way.
 *
 * SQLite handles that are still open are why the Bun-on-Windows suite needed a retrying delete, and
 * why every adapter must be closable. An adapter that throws mid-report must still release its
 * handle, or the next test cannot remove its fixture.
 */
export async function withAdapter(adapter, options, run) {
  const handle = await adapter.open(options);
  try {
    return await run(handle);
  } finally {
    try {
      await adapter.close(handle);
    } catch {
      // A close that fails must not mask the error that brought us here, and must not stop the
      // handle being released on a later attempt.
    }
  }
}
