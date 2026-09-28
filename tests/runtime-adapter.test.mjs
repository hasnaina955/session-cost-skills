import test from 'node:test';
import assert from 'node:assert/strict';
import { validateAdapter, assertAdapter, withAdapter, COST_BASIS, REQUIRED_MEMBERS } from '../shared/runtime-adapter.mjs';

/** A complete, minimal adapter. Anything the kernel tests need is built on this. */
export function fakeAdapter(overrides = {}) {
  return {
    id: 'fake',
    displayName: 'Fake Runtime',
    costBasis: COST_BASIS.RECORDED,
    defaultDataDir: () => '/tmp/fake',
    open: () => ({ closed: false }),
    close: (handle) => { handle.closed = true; },
    listSessions: () => [{ id: 's1', parentId: null, startedAt: '2026-06-15T12:00:00.000Z', title: 'One' }],
    resolveCurrent: () => ({ sessionId: 's1', method: 'unique-active', requestedId: null, candidateIds: ['s1'] }),
    buildReport: () => ({ runtime: 'fake', sessionId: 's1' }),
    aggregate: (reports) => ({ runtime: 'fake', aggregated: reports.length }),
    ...overrides,
  };
}

test('a complete adapter validates, and the real ones declare every member', () => {
  assert.deepEqual(validateAdapter(fakeAdapter()), []);
  // The list is the contract, so a member cannot be added to the interface without it appearing
  // here - which would fail this test and force the question "does every adapter still satisfy it".
  assert.ok(REQUIRED_MEMBERS.includes('buildReport'));
  assert.ok(REQUIRED_MEMBERS.includes('costBasis'));
  assert.deepEqual(Object.keys(COST_BASIS).sort(), ['ESTIMATED', 'RECORDED']);
});

test('a missing member is named, and all of them are listed at once', () => {
  const broken = fakeAdapter();
  delete broken.listSessions;
  delete broken.aggregate;
  const problems = validateAdapter(broken);
  assert.equal(problems.length, 2);
  assert.ok(problems.some((problem) => problem.includes('listSessions')));
  assert.ok(problems.some((problem) => problem.includes('aggregate')));
  // One message naming both, so a new adapter is not fixed one error per run.
  assert.throws(() => assertAdapter(broken), /not usable[\s\S]*listSessions[\s\S]*aggregate/);
});

test('an adapter with an unknown member is refused rather than silently ignored', () => {
  // This is the guard on the interface itself. A typo like `buildReprot` would otherwise be a
  // method that is never called, discovered only when a report comes back empty.
  const problems = validateAdapter(fakeAdapter({ buildReprot: () => null }));
  assert.equal(problems.filter((problem) => problem.includes('unknown member: buildReprot')).length, 1);
});

test('the identity fields are checked, not assumed', () => {
  assert.match(validateAdapter(fakeAdapter({ id: 'Fake' })).join(), /lowercase kebab-case/);
  assert.match(validateAdapter(fakeAdapter({ id: 'fake_runtime' })).join(), /lowercase kebab-case/);
  assert.deepEqual(validateAdapter(fakeAdapter({ id: 'fake-2' })), []);
  // costBasis is how "the runtime recorded this" stays separate from "we calculated this".
  assert.match(validateAdapter(fakeAdapter({ costBasis: 'guess' })).join(), /costBasis must be one of/);
  for (const basis of Object.values(COST_BASIS)) {
    assert.deepEqual(validateAdapter(fakeAdapter({ costBasis: basis })), [], `${basis} must be accepted`);
  }
  assert.match(validateAdapter(fakeAdapter({ buildReport: 'nope' })).join(), /buildReport must be a function/);
  assert.match(validateAdapter(fakeAdapter({ extraModes: 7 })).join(), /extraModes must be an object/);
  assert.deepEqual(validateAdapter(fakeAdapter({ extraModes: { rates: () => null } })), [], 'a valid extraModes map is accepted');
});

test('a non-object is refused with something a reader can act on', () => {
  assert.deepEqual(validateAdapter(null), ['an adapter must be an object']);
  assert.match(validateAdapter(undefined).join(), /must be an object/);
  assert.throws(() => assertAdapter(null), /not usable/);
});

test('a handle is released even when the run throws', () => {
  // The reason the Bun-on-Windows suite needed a retrying temp delete: a SQLite handle left open
  // blocks removal of the fixture directory on Windows. An adapter that throws mid-report must
  // still release its handle.
  const handle = { closed: false };
  const adapter = fakeAdapter({ open: () => handle, close: (h) => { h.closed = true; } });
  assert.throws(() => withAdapterSync(adapter, {}, () => { throw new Error('report blew up'); }), /report blew up/);
  assert.equal(handle.closed, true, 'the handle must be closed even when the run throws');
});

test('a close that itself fails neither masks the real error nor stops the release attempt', () => {
  const handle = { closed: false };
  const adapter = fakeAdapter({
    open: () => handle,
    close: (h) => { h.closed = true; throw new Error('close failed too'); },
  });
  assert.throws(() => withAdapterSync(adapter, {}, () => { throw new Error('the real problem'); }), /the real problem/);
  assert.equal(handle.closed, true);
});

test('withAdapter returns the run result and awaits an async run', async () => {
  const adapter = fakeAdapter();
  const handle = { closed: false };
  adapter.open = async () => handle;
  const result = await withAdapter(adapter, {}, async (h) => `used ${h === handle}`);
  assert.equal(result, 'used true');
  assert.equal(handle.closed, true);
});

/** The synchronous form, so the throwing cases above do not need an async harness. */
function withAdapterSync(adapter, options, run) {
  const handle = adapter.open(options);
  try {
    return run(handle);
  } finally {
    try { adapter.close(handle); } catch { /* a close failure must not mask the run's error */ }
  }
}
