import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { collectSessionIds, createSessionGraph, selectTopLevelCandidates } from '../adapters/cline/skill/scripts/lib/session-graph.mjs';
import { collectSessionIds as mcodeCollect, createSessionGraph as mcodeGraph, selectTopLevelCandidates as mcodeSelect } from '../adapters/mcode/skill/scripts/lib/session-graph.mjs';

const canonical = fs.readFileSync(new URL('../shared/session-graph.mjs', import.meta.url), 'utf8');
const fixtures = [
  { session_id: 'root', parent_session_id: null },
  { session_id: 'child', parent_session_id: 'root' },
  { session_id: 'grandchild', parent_session_id: 'child' },
  { session_id: 'other', parent_session_id: null },
];

test('every adapter contains the same recursive session graph implementation', () => {
  for (const adapter of ['cline', 'mcode', 'opencode']) {
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
