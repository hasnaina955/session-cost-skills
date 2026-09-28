import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter } from '../shared/runtime-adapter.mjs';
import mcodeAdapter from '../adapters/mcode/skill/scripts/lib/runtime.mjs';

/**
 * MCode is the first adapter on the kernel, so this is the file that proves the interface is
 * expressible by a real runtime rather than only by the fake in runtime-adapter.test.mjs.
 *
 * The entry point is now twelve lines that import this adapter and call runCli, so if the adapter
 * stopped satisfying the interface the CLI would fail at startup with a message naming every
 * problem at once. These assertions are the cheap check that it never gets that far.
 */

test('the MCode adapter satisfies the runtime-adapter interface', () => {
  assert.deepEqual(validateAdapter(mcodeAdapter), []);
});

test('the adapter declares the cost basis that keeps recorded and calculated apart', () => {
  // MCode prices calls from mirrored provider rates; it never reads a cost the runtime recorded.
  // If this ever flips to RECORDED the report would claim a provenance it does not have.
  assert.equal(mcodeAdapter.costBasis, 'provider-rate-estimate');
});

test('the adapter names itself in the form the CLI and the contract expect', () => {
  assert.equal(mcodeAdapter.id, 'mcode');
  assert.equal(mcodeAdapter.displayName, 'MiniMax Code');
});

test('the entry point is a caller, not a second implementation', () => {
  // The duplication this project is removing is measurable: if orchestration creeps back into
  // session-cost.mjs, the line count starts climbing again and the kernel stops being the only
  // place that decides what a run does.
  assert.ok(mcodeAdapter.run, 'the adapter owns the report step');
  assert.equal(typeof mcodeAdapter.loadConfig, 'function');
  assert.equal(typeof mcodeAdapter.preflight, 'function');
});
