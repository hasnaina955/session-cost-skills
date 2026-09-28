import test from 'node:test';
import assert from 'node:assert/strict';
import clineAdapter from '../adapters/cline/skill/scripts/lib/runtime.mjs';
import mcodeAdapter from '../adapters/mcode/skill/scripts/lib/runtime.mjs';
import { createClineFixture, createMCodeFixture } from './helpers/contract-fixtures.mjs';
import {
  createClineAmbiguousFixture,
  createMCodeAmbiguousFixture,
} from './conformance/ambiguous-fixtures.mjs';
import {
  CONFORMANCE_SCENARIOS,
  assertConformance,
  runConformance,
} from './conformance/run-conformance.mjs';

/**
 * Both existing adapters must pass the shared contracts, and this is what "must pass" means.
 *
 * Issue #21 asked for an adapter to clear the shared usage, selection, session-graph and
 * cost-domain contracts before being accepted. These two lines are the whole answer to "does this
 * adapter conform", and they are the same two lines a third adapter will need. The work is in the
 * kit; the acceptance test is deliberately trivial.
 *
 * The scenarios that need a handle the fixture cannot supply are reported as skipped rather than
 * passed, and the count is asserted here so a scenario cannot quietly stop being exercised: if a
 * future fixture stops offering a case, this fails and asks whether the runtime lost the case or
 * the kit lost the check.
 */

test('the Cline adapter passes the conformance kit', () => {
  assertConformance({
    adapter: clineAdapter,
    fixture: createClineFixture(),
    ambiguous: createClineAmbiguousFixture(),
    label: 'cline',
  });
});

test('the MCode adapter passes the conformance kit', () => {
  assertConformance({
    adapter: mcodeAdapter,
    fixture: createMCodeFixture(),
    ambiguous: createMCodeAmbiguousFixture(),
    label: 'mcode',
  });
});

test('the kit names every scenario it can run, and says when one is skipped', () => {
  // A kit that omits a check silently is worse than one that is narrow, because the reader cannot
  // tell the difference. Every scenario must be reported either way.
  const { checks } = runConformance({ adapter: mcodeAdapter, fixture: createMCodeFixture() });
  assert.deepEqual(checks.map((check) => check.name).sort(), [...CONFORMANCE_SCENARIOS].sort());
});

test('a failing adapter fails the kit rather than passing by default', () => {
  // The kit has to be able to fail. If a check cannot fail, it proves nothing, so this wires a
  // deliberately wrong fixture and requires the kit to refuse it.
  const fixture = createMCodeFixture();
  const broken = { ...fixture, root: 'mcode-no-such-session' };
  const { ok, failures } = runConformance({ adapter: mcodeAdapter, fixture: broken });
  assert.equal(ok, false);
  assert.ok(failures.length > 0, 'a fixture pointing at a missing session must fail at least one scenario');
  assert.ok(
    failures.some((failure) => failure.name === 'explicit-selection'),
    `expected explicit-selection to fail, got ${failures.map((failure) => failure.name).join(', ')}`,
  );
  assert.throws(() => assertConformance({ adapter: mcodeAdapter, fixture: broken, label: 'mcode' }), /failed the conformance kit/);
});

test('a stub that claims a kit member fails the interface check, not the battery', () => {
  // Ties the kit back to the interface decision in WP-2.3: a member nothing calls must not be
  // implemented. This is the same guard in a second place, so an adapter cannot pass the kit while
  // quietly re-adding a stub.
  const stubbed = { ...mcodeAdapter, listSessions: () => [] };
  const { checks } = runConformance({ adapter: stubbed, fixture: createMCodeFixture() });
  const contract = checks.find((check) => check.name === 'contract-validity');
  assert.equal(contract.ok, false);
  assert.match(contract.message, /unknown member: listSessions/);
});
