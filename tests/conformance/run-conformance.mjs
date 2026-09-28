/**
 * The adapter conformance kit.
 *
 * ## Why this exists
 *
 * Issue #21 says an adapter must pass the shared usage, selection, session-graph and cost-domain
 * contracts before it is accepted. Until now that was a review question: a reviewer read the
 * adapter and decided. This makes it one command.
 *
 *     node tests/conformance/run-conformance.mjs <adapter-module> <fixture-factory>
 *
 * or, in a test, one line:
 *
 *     assertConformance({ adapter: mcodeAdapter, fixture: createMCodeFixture() });
 *
 * ## What the kit is not
 *
 * It is not a value oracle. It does not know what a session should cost, because no runtime's
 * numbers are another's. It knows the things that must hold for any runtime whose numbers can be
 * trusted at all: that a selection selects one thing, that children are counted once, that an
 * unknown stays unknown in every format, and that the three renderings of one report say the same
 * total. Those are the failure modes that produce a plausible number instead of an error.
 *
 * ## The fixture contract
 *
 * A fixture is what a runtime's factory must supply. The kit drives the CLI, so it needs the
 * entry point and where the ledger lives; the rest name the scenarios the battery exercises.
 *
 *   script        the adapter entry point
 *   dataDir       where the ledger lives
 *   environment   optional env vars for the run (rate tables, a pinned clock)
 *   sessionIds    every session the fixture contains
 *   root          a fully-priced root session
 *   child         a direct child of root
 *   grandchild    a descendant of child
 *   unpriced      a session whose cost cannot be known, optional but expected
 *   torn          a session whose final record is truncated, optional
 *   ambiguous     a fixture where current-selection must refuse rather than guess, optional
 *
 * Optional handles are reported as a skipped scenario rather than a pass, so a runtime that has
 * no such case is not forced to invent one - and so a runtime that claims to handle one cannot
 * quietly stop.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { validateAdapter } from '../../shared/runtime-adapter.mjs';
import { runCli, runJson } from '../helpers/contract-fixtures.mjs';

/** Every scenario the battery runs, in the order it reports them. */
export const CONFORMANCE_SCENARIOS = Object.freeze([
  'contract-validity',
  'explicit-selection',
  'current-selection',
  'ambiguity-refusal',
  'children-once',
  'unknown-stays-unknown',
  'torn-record-tolerated',
  'formats-agree',
  'total-is-a-sum',
]);

/** An unknown cost is null in JSON and an empty cell in CSV. Never 0. */
function costIsUnknown(value) {
  return value === null || value === undefined || value === '' || !Number.isFinite(Number(value));
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

/** Compare two money figures at the precision the reports print. */
function close(left, right, epsilon = 1e-6) {
  return Math.abs(Number(left) - Number(right)) <= epsilon;
}

/**
 * The selected session id, read from wherever a runtime puts it.
 *
 * The two do not agree on shape: Cline normalizes to `session.id`, MCode carries `sessionId` at the
 * top level and has no `session` object. A kit that assumed one would report "no session selected"
 * for a runtime that selected one correctly, which is a failure that costs a reader a morning.
 */
function sessionIdOf(report) {
  return report?.session?.id ?? report?.sessionId ?? report?.sessions?.[0]?.row?.sessionId ?? null;
}

/**
 * The per-session costs, as an independent sum.
 *
 * Both runtimes expose `sessions[].metrics.cost`, and that is the one shape they share. Summing
 * these and comparing to the reported total checks the total against something it did not
 * accumulate itself - comparing a total to its own accumulator is how a double-count survives.
 */
function perSessionCosts(report) {
  return (report?.sessions ?? [])
    .map((entry) => entry?.metrics?.cost)
    .filter((value) => typeof value === 'number' && Number.isFinite(value));
}


/**
 * Run the whole battery against one adapter.
 *
 * Returns every scenario with its outcome, so a caller can print a report as well as assert on it.
 * A scenario that needs a handle the fixture does not supply is recorded as skipped with a reason,
 * never as a pass: a kit that silently omits a check is worse than one that is narrow, because the
 * reader cannot tell the difference.
 */
export function runConformance({ adapter, fixture, ambiguous }) {
  const checks = [];
  const record = (name, ok, message = null, skipped = false) => {
    checks.push({ name, ok, skipped, message });
    return ok;
  };
  const run = (args) => runCli(fixture.script, fixture.dataDir, args, fixture.environment ?? {});
  const runJ = (args) => runJson(fixture.script, fixture.dataDir, args, fixture.environment ?? {});

  // ---- contract validity
  const problems = validateAdapter(adapter);
  record('contract-validity', problems.length === 0, problems.join('; ') || null);

  // ---- explicit selection
  // `--session <id>` must select that session and nothing else, and must say it was asked for.
  // A selector that quietly falls back to "whatever is most recent" makes every other number
  // unattributable, which is why this is the first behavioural check.
  if (fixture.root) {
    const { result, output } = runJ(['--session', fixture.root]);
    if (!output) {
      record('explicit-selection', false, `--session ${fixture.root} produced no JSON: ${result.stderr}`);
    } else {
      const selected = sessionIdOf(output);
      record(
        'explicit-selection',
        selected === fixture.root && output.selection?.requestedId === fixture.root,
        `asked for ${fixture.root}, got session=${selected} requestedId=${output.selection?.requestedId}`,
      );
    }
  } else {
    record('explicit-selection', true, 'fixture supplies no root session', true);
  }

  // ---- current selection
  // With no --session the CLI must still resolve to exactly one session, and must say which one.
  // "Last updated", "first", or a silent pick among equals are all wrong; the resolver must either
  // resolve or refuse (the refusal is the ambiguity scenario below).
  {
    const { result, output } = runJ([]);
    if (!output) {
      // Refusing is correct when the CLI cannot choose among equals, as long as it refuses rather
      // than guessing - that is the ambiguity scenario, and a clean refusal here is not a failure.
      const refusedCleanly = result.status !== 0
        && (result.stderr.toLowerCase().includes('multiple') || result.stderr.toLowerCase().includes('ambiguous'));
      record(
        'current-selection',
        refusedCleanly,
        refusedCleanly
          ? 'refused to guess and named the candidates (correct for a fixture with several live roots)'
          : `no --session produced no JSON and did not refuse cleanly: ${result.stderr}`,
      );
    } else {
      const selected = sessionIdOf(output);
      const known = !selected || (fixture.sessionIds ?? []).includes(selected);
      record(
        'current-selection',
        Boolean(selected) && known && Boolean(output.selection?.method),
        `current selection gave session=${selected} method=${output.selection?.method}`,
      );
    }
  }

  // ---- ambiguity refusal
  // Two live roots must be refused, not guessed between. The scenario uses the ambiguous fixture
  // when one is supplied, and falls back to the standard fixture: a runtime whose normal fixture
  // already has several live roots (MCode) exercises the check without extra work, while one whose
  // normal fixture resolves (Cline) supplies the purpose-built case. Either way the check runs, so
  // a runtime cannot pass by simply not offering the scenario.
  //
  // "Live" is the one thing the two runtimes genuinely disagree on: Cline reads a status column,
  // MCode reads how recently a call landed. That is exactly why the fixture owns the scenario.
  const ambiguousFixture = ambiguous ?? fixture;
  {
    const { result, output } = runJson(ambiguousFixture.script, ambiguousFixture.dataDir, [], ambiguousFixture.environment ?? {});
    const refused = result.status !== 0;
    const namesCandidates = result.stderr.toLowerCase().includes('multiple')
      || result.stderr.toLowerCase().includes('ambiguous')
      || (output?.selection?.ambiguousCandidates?.length > 0);
    record(
      'ambiguity-refusal',
      refused && namesCandidates,
      refused
        ? `refused (exit ${result.status}) and named the candidates`
        : `did not refuse; exit ${result.status} session=${output ? sessionIdOf(output) : 'none'}`,
    );
  }

  // ---- children exactly once
  // --include-children must fold every descendant in exactly once. A grandchild counted through
  // both its parent and its grandparent inflates the total while leaving every per-session figure
  // correct, so only the inclusive total exposes it.
  if (fixture.root && fixture.child && fixture.grandchild) {
    const { result, output } = runJ(['--session', fixture.root, '--include-children']);
    if (!output) {
      record('children-once', false, `--include-children produced no JSON: ${result.stderr}`);
    } else {
      const included = output.session?.includedSessionIds ?? output.includedSessionIds ?? [];
      const once = included.length === new Set(included).size;
      const hasAll = [fixture.root, fixture.child, fixture.grandchild].every((id) => included.includes(id));
      const alone = runJ(['--session', fixture.root]).output;
      const grew = alone?.billing?.amountUsd == null || close(output.billing.amountUsd, alone.billing.amountUsd)
        || output.billing.amountUsd >= alone.billing.amountUsd;
      record(
        'children-once',
        once && hasAll && grew,
        `included=[${included.join(', ')}] once=${once} all=${hasAll} grew=${grew}`,
      );
    }
  } else {
    record('children-once', true, 'fixture supplies no child and grandchild', true);
  }

  // ---- unknown stays unknown
  // Rule 1, stated as the CSV contract actually implements it: `costUsd` carries the charge ONLY
  // when the ledger disclosed the whole of it. Anything less leaves the cell empty, so a spreadsheet
  // summing the column cannot absorb a partially priced or unpriced session into a total that looks
  // complete. A KNOWN zero - a session with no calls, or free usage - is the one exception and is
  // written as `0`, because it is a real answer rather than an absent one.
  //
  // The failure this catches is the one this project exists to prevent: a `0` that means "I don't
  // know" is indistinguishable from a real free session.
  if (fixture.unpriced) {
    const { result, output } = runJ(['--session', fixture.unpriced]);
    const csv = run(['--session', fixture.unpriced, '--csv']);
    if (!output) {
      record('unknown-stays-unknown', false, `--session ${fixture.unpriced} produced no JSON: ${result.stderr}`);
    } else {
      const coverage = output.billing?.coverage ?? 'unknown';
      const amount = output.billing?.amountUsd;
      const rows = csv.stdout.trim().split('\n').filter((line) => line.trim() !== '');
      const header = rows[0] ? rows[0].split(',') : [];
      const costColumn = header.indexOf('costUsd');
      const cell = costColumn === -1 ? null : (rows[1] ? rows[1].split(',')[costColumn] : '');

      let ok;
      let detail;
      if (coverage === 'complete') {
        // Fully disclosed: the charge must be written.
        ok = cell !== null && !costIsUnknown(cell) && Number(cell) !== 0;
        detail = `complete coverage: costUsd=${JSON.stringify(cell)} amountUsd=${amount}`;
      } else if (coverage === 'no-calls') {
        // A known zero is a real answer, not an absent one.
        ok = cell === '' || cell === undefined || Number(cell) === 0;
        detail = `no-calls: costUsd=${JSON.stringify(cell)} (a known zero may be written as 0)`;
      } else {
        // partial / unavailable / unknown: the charge cell must be empty. Not the partial sum, and
        // not 0 - both read as "this is the whole cost".
        ok = costIsUnknown(cell) && amount !== 0;
        detail = `coverage=${coverage}: amountUsd=${JSON.stringify(amount)} costUsd=${JSON.stringify(cell)}`;
      }
      record('unknown-stays-unknown', ok, detail);
    }
  } else {
    record('unknown-stays-unknown', true, 'fixture supplies no unpriced session', true);
  }

  // ---- torn final record tolerated
  // A session whose last record is cut in half must report what it has, not crash and not report an
  // empty session. The exit code may legitimately be 2 - "incomplete" is the honest answer for a
  // torn ledger - but never 1, which means the tool broke.
  if (fixture.torn) {
    const { result, output } = runJ(['--session', fixture.torn]);
    record(
      'torn-record-tolerated',
      result.status !== 1 && output !== null && sessionIdOf(output) !== null,
      `exit=${result.status} parsed=${output !== null} session=${output ? sessionIdOf(output) : 'none'}`,
    );
  } else {
    record('torn-record-tolerated', true, 'fixture supplies no torn session', true);
  }

  // ---- formats agree
  // The same report rendered three ways must say the same total. A figure that differs by format
  // is a figure a reader cannot trust, and the difference is invisible from one format alone - the
  // CSV double-counting cached tokens is exactly this bug.
  if (fixture.root) {
    const { output } = runJ(['--session', fixture.root]);
    const text = run(['--session', fixture.root]);
    const csv = run(['--session', fixture.root, '--csv']);
    const amount = output?.billing?.amountUsd;
    if (amount == null) {
      record('formats-agree', true, 'root session has no known cost to compare', true);
    } else {
      const printed = Number(amount).toFixed(6);
      const textAgrees = text.stdout.includes(printed);
      const rows = csv.stdout.trim().split('\n').filter((line) => line.trim() !== '');
      const header = rows[0] ? rows[0].split(',') : [];
      const costColumn = header.indexOf('costUsd');
      const costs = rows.slice(1)
        .map((line) => Number(line.split(',')[costColumn]))
        .filter((value) => Number.isFinite(value));
      const csvAgrees = costColumn !== -1 && costs.length > 0 && close(sum(costs), amount);
      record(
        'formats-agree',
        textAgrees && csvAgrees,
        `json=${printed} text=${textAgrees} csvTotal=${costColumn === -1 ? 'no costUsd column' : sum(costs)}`,
      );
    }
  } else {
    record('formats-agree', true, 'fixture supplies no root session', true);
  }

  // ---- total is a sum
  // The reported total must be the sum of its parts. These are the per-session costs, which the
  // total did not accumulate itself: adding them and comparing to `billing.amountUsd` is an
  // independent check. Comparing a total to its own accumulator is how a double-count survives.
  if (fixture.root) {
    const { output } = runJ(['--session', fixture.root]);
    const parts = perSessionCosts(output);
    const total = output?.billing?.amountUsd;
    if (parts.length === 0 || total == null) {
      record('total-is-a-sum', true, 'report carries no per-session figures to add', true);
    } else {
      record(
        'total-is-a-sum',
        close(sum(parts), total),
        `sum of ${parts.length} session costs = ${sum(parts)}, reported total = ${total}`,
      );
    }
  } else {
    record('total-is-a-sum', true, 'fixture supplies no root session', true);
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
    failures: checks.filter((check) => !check.ok),
  };
}

/**
 * Run the battery and throw with every failure named at once.
 *
 * This is the form a new adapter's acceptance test uses, so that "does this adapter conform" is one
 * line and a reviewer reads a list rather than deciding from scratch.
 */
export function assertConformance(spec) {
  const { ok, checks, failures } = runConformance(spec);
  const label = spec.label ?? spec.adapter?.id ?? 'adapter';
  const skipped = checks.filter((check) => check.skipped);
  const report = [
    `${label}: ${checks.length - skipped.length}/${checks.length} conformance scenarios ran`
      + (skipped.length ? `, ${skipped.length} skipped` : ''),
    ...checks.map((check) => {
      const verdict = check.ok ? (check.skipped ? 'skip' : 'pass') : 'FAIL';
      return `  ${verdict} ${check.name}${check.message ? ` - ${check.message}` : ''}`;
    }),
  ].join('\n');
  assert.ok(ok, `${label} failed the conformance kit:\n${report}\n`);
  return report;
}

/**
 * The documented command form.
 *
 *   node tests/conformance/run-conformance.mjs <adapter-module> <fixture-factory> [ambiguous-factory]
 *
 * All three are paths to ES modules: the adapter's default export is used and each factory is
 * called with no arguments. The exit code is 0 when every scenario passes, so this works from a
 * script or from CI as well as from a test.
 */
export async function runFromCommandLine(argv) {
  const [adapterPath, fixturePath, ambiguousPath] = argv;
  if (!adapterPath || !fixturePath) {
    console.error('usage: run-conformance.mjs <adapter-module> <fixture-factory> [ambiguous-fixture-factory]');
    return 2;
  }
  const resolve = (input) => pathToFileURL(path.resolve(input)).href;
  const adapterModule = await import(resolve(adapterPath));
  const fixtureModule = await import(resolve(fixturePath));
  const fixtureFactory = fixtureModule.default ?? fixtureModule.createFixture;
  const fixture = await fixtureFactory();
  let ambiguous = null;
  if (ambiguousPath) {
    const ambiguousModule = await import(resolve(ambiguousPath));
    const ambiguousFactory = ambiguousModule.default ?? ambiguousModule.createFixture;
    ambiguous = await ambiguousFactory();
  }
  const result = runConformance({ adapter: adapterModule.default, fixture, ambiguous });
  for (const check of result.checks) {
    const verdict = check.ok ? (check.skipped ? 'skip' : 'pass') : 'FAIL';
    console.log(`${verdict} ${check.name}${check.message ? ` - ${check.message}` : ''}`);
  }
  console.log(result.ok ? 'conformance: PASS' : `conformance: FAIL (${result.failures.length} scenario(s))`);
  return result.ok ? 0 : 1;
}

// Only run the command form when this file is the entry point, so importing it from a test is quiet.
const isEntryPoint = process.argv[1]
  && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isEntryPoint) {
  process.exitCode = await runFromCommandLine(process.argv.slice(2));
}
