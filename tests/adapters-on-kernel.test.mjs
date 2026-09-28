import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateAdapter, REQUIRED_MEMBERS, KIT_MEMBERS } from '../shared/runtime-adapter.mjs';
import { selectedExtraMode } from '../shared/kernel.mjs';
import clineAdapter from '../adapters/cline/skill/scripts/lib/runtime.mjs';
import mcodeAdapter from '../adapters/mcode/skill/scripts/lib/runtime.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * Both adapters now run on the kernel, so these assertions are about the contract rather than about
 * any one runtime's numbers.
 *
 * The accounting-domain rule is the important one. Cline's `--account` reads the account API and
 * produces a different document from the local ledger report, and the rule is that the two never
 * merge. Expressing it as an extraMode rather than a branch inside the report is what makes that
 * structural rather than a promise: there is no function both of them pass through.
 */

test('no adapter claims a storage or report member, so the gap stays a gap and not a stub', () => {
  // This is the guard against the review finding. WP-2.1 required open/close/listSessions/
  // resolveCurrent/buildReport/aggregate, the kernel invoked none of them, and both adapters
  // satisfied the list with `() => []` and `() => ({})`. validateAdapter passed, which is the exact
  // false confidence the interface exists to prevent.
  //
  // They moved to KIT_MEMBERS when WP-2.3 landed. Until WP-2.4's conformance kit actually calls
  // them, an adapter defining one would be claiming to do something nothing exercises. This test
  // fails the moment that starts, so the reintroduction is a deliberate act with a reason attached
  // rather than a stub added to make a checklist green.
  for (const adapter of [clineAdapter, mcodeAdapter]) {
    for (const member of KIT_MEMBERS) {
      assert.equal(adapter[member], undefined, `${adapter.id} defines ${member}, which nothing calls yet`);
    }
  }
});

test('the two member lists are disjoint, and every required member is a real fact about a runtime', () => {
  // A member in both lists would be required on the strength of a contract nothing enforces.
  for (const member of KIT_MEMBERS) {
    assert.equal(REQUIRED_MEMBERS.includes(member), false, `${member} is in both lists`);
  }
  // The kernel reads exactly these three off the adapter, so they are the ones the required list
  // should be built from. If a future kernel starts driving a fourth, this fails and the interface
  // should be widened deliberately.
  const kernel = fs.readFileSync(path.join(root, 'shared', 'kernel.mjs'), 'utf8');
  const drivenByKernel = REQUIRED_MEMBERS.filter((member) => new RegExp(`adapter\\.${member}\\b`).test(kernel));
  assert.deepEqual(drivenByKernel.sort(), ['defaults', 'id', 'versionBanner']);
  // The rest are declared facts rather than called members, and each is asserted by a test above so
  // it cannot decay into decoration either.
  assert.deepEqual(
    REQUIRED_MEMBERS.filter((member) => !drivenByKernel.includes(member)).sort(),
    ['costBasis', 'defaultDataDir', 'displayName'],
  );
});

test('both adapters satisfy the runtime-adapter interface', () => {
  assert.deepEqual(validateAdapter(clineAdapter), []);
  assert.deepEqual(validateAdapter(mcodeAdapter), []);
});

test('the two runtimes declare opposite cost bases, and neither is guessed', () => {
  // This is rule 3 in the form the interface can check. Cline reads a cost the runtime recorded on
  // each call; MCode prices the call from mirrored provider rates. If either were to flip, the
  // report would claim a provenance it does not have, and nothing else in the pipeline would notice.
  assert.equal(clineAdapter.costBasis, 'runtime-recorded');
  assert.equal(mcodeAdapter.costBasis, 'provider-rate-estimate');
  assert.notEqual(clineAdapter.costBasis, mcodeAdapter.costBasis);
});

test('both adapters name themselves in the form the CLI and the contract expect', () => {
  assert.equal(clineAdapter.id, 'cline');
  assert.equal(clineAdapter.displayName, 'Cline');
  assert.equal(mcodeAdapter.id, 'mcode');
  assert.equal(mcodeAdapter.displayName, 'MiniMax Code');
});

test('Cline declares --account as an extra mode, and it is selected only when asked for', () => {
  assert.equal(typeof clineAdapter.extraModes?.account, 'function');
  assert.equal(selectedExtraMode(clineAdapter, { account: true }), 'account');
  assert.equal(selectedExtraMode(clineAdapter, { account: false }), undefined);
  assert.equal(selectedExtraMode(clineAdapter, {}), undefined);
});

test('MCode has no extra modes, and a runtime without them is not a failure', () => {
  // A runtime that offers nothing beyond a session report is the normal case, not a gap.
  assert.equal(selectedExtraMode(mcodeAdapter, {}), undefined);
  assert.deepEqual(validateAdapter(mcodeAdapter), []);
});

test('the account mode is reachable only through extraModes, never through the report step', () => {
  // If an account figure could reach the report's billing, rule 3 would be broken in a way no
  // value assertion would catch. The separation is what this asserts.
  assert.deepEqual(Object.keys(clineAdapter.extraModes), ['account']);
  const reportStep = String(clineAdapter.run);
  assert.doesNotMatch(reportStep, /account/i, 'the report step must not branch on --account');
});

test('each entry point is a caller, not a second implementation', () => {
  for (const adapter of [clineAdapter, mcodeAdapter]) {
    assert.equal(typeof adapter.loadConfig, 'function');
    // `typeof x ?? y` would never fall through - typeof always returns a string - so the optional
    // step is checked on the member, not on its type.
    assert.ok(adapter.preflight === undefined || typeof adapter.preflight === 'function');
    assert.equal(typeof adapter.run, 'function');
    assert.equal(typeof adapter.defaults, 'object');
    assert.equal(typeof adapter.versionBanner, 'function');
  }
});
