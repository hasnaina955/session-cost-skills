import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectSessionIds, createSessionGraph, selectTopLevelCandidates } from '../adapters/cline/skill/scripts/lib/session-graph.mjs';
import { collectSessionIds as mcodeCollect, createSessionGraph as mcodeGraph, selectTopLevelCandidates as mcodeSelect } from '../adapters/mcode/skill/scripts/lib/session-graph.mjs';
import { seededRandom } from './helpers/contract-fixtures.mjs';

const canonical = fs.readFileSync(new URL('../shared/session-graph.mjs', import.meta.url), 'utf8');
const fixtures = [
  { session_id: 'root', parent_session_id: null },
  { session_id: 'child', parent_session_id: 'root' },
  { session_id: 'grandchild', parent_session_id: 'child' },
  { session_id: 'other', parent_session_id: null },
];

test('both adapters contain the same recursive session graph implementation', () => {
  for (const adapter of ['cline', 'mcode']) {
    const source = fs.readFileSync(new URL(`../adapters/${adapter}/skill/scripts/lib/session-graph.mjs`, import.meta.url), 'utf8');
    assert.equal(source, canonical);
  }
});

for (const [name, graphFor, selectFor, collectFor] of [
  ['Cline', createSessionGraph, selectTopLevelCandidates, collectSessionIds],
  ['MCode', mcodeGraph, mcodeSelect, mcodeCollect],
]) {
  test(`${name} graph resolves all descendants and suppresses duplicate child roots`, () => {
    const graph = graphFor(fixtures);
    assert.deepEqual([...graph.descendants('root')], ['root', 'child', 'grandchild']);
    assert.equal(graph.isDescendant('grandchild', 'root'), true);
    const selected = selectFor(['root', 'child', 'grandchild', 'other'], graph);
    assert.deepEqual(selected.includedRootIds, ['root', 'other']);
    assert.deepEqual(selected.duplicateSuppressedSessionIds, ['child', 'grandchild']);
    assert.deepEqual([...collectFor(['root'], graph, { includeChildren: false })], ['root']);
    assert.deepEqual([...collectFor(['root'], graph)], ['root', 'child', 'grandchild']);
  });
}

test('session graphs reject duplicate IDs and cycles', () => {
  assert.throws(() => createSessionGraph([
    { session_id: 'root', parent_session_id: null },
    { session_id: 'root', parent_session_id: null },
  ]), /duplicate session id/);
  assert.throws(() => createSessionGraph([
    { session_id: 'a', parent_session_id: 'b' },
    { session_id: 'b', parent_session_id: 'a' },
  ]), /cycle/);
});

test('top-level selection agrees with a reference implementation on random graphs', () => {
  // The shipped implementation walks each candidate's parent chain once. A reference that checks
  // `isDescendant` per pair is O(candidates squared) but obviously right. Asserting they agree on
  // many random graphs is the proof the optimisation is faithful, not a behaviour change.
  const reference = (candidateIds, graph) => {
    const candidates = [...new Set(candidateIds.map(String))].filter((id) => graph.byId.has(id));
    const includedRootIds = candidates.filter((candidate) => (
      !candidates.some((other) => other !== candidate && graph.isDescendant(candidate, other))
    ));
    const included = new Set(includedRootIds);
    return { includedRootIds, duplicateSuppressedSessionIds: candidates.filter((id) => !included.has(id)) };
  };

  const rand = seededRandom(20260615);
  for (let trial = 0; trial < 40; trial += 1) {
    const count = 2 + Math.floor(rand() * 30);
    const rows = [];
    for (let index = 0; index < count; index += 1) {
      const hasParent = index > 0 && rand() < 0.4;
      rows.push({
        session_id: `n${index}`,
        parent_session_id: hasParent ? `n${Math.floor(rand() * index)}` : null,
      });
    }
    const ids = rows.map((row) => row.session_id).filter(() => rand() > 0.1);
    for (const selectTopLevel of [selectTopLevelCandidates, mcodeSelect]) {
      const graph = mcodeGraph(rows);
      assert.deepEqual(
        selectTopLevel(ids, graph),
        reference(ids, graph),
        `trial ${trial}: top-level selection must match the pairwise reference`,
      );
    }
  }
});

test('top-level selection is not quadratic in the candidate count', () => {
  // The shape that took ten seconds: many candidates, some parented. If the parent-chain walk ever
  // becomes a per-pair descent again, this test gets slow rather than wrong, and the bench flags it.
  const count = 4000;
  const rows = Array.from({ length: count }, (_, index) => ({
    session_id: `n${index}`,
    parent_session_id: index % 3 === 0 && index > 0 ? `n${index - 1}` : null,
  }));
  const graph = mcodeGraph(rows);
  const ids = rows.map((row) => row.session_id);
  const started = Date.now();
  const result = mcodeSelect(ids, graph);
  const elapsed = Date.now() - started;
  assert.ok(result.includedRootIds.length > 0, 'roots were found');
  assert.ok(elapsed < 500, `selectTopLevelCandidates over ${count} candidates took ${elapsed}ms`);
});
