import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';
import schema from '../contracts/session-config-v1.schema.json' with { type: 'json' };
import { attributeCostCentres, expandCostCentres, renderCostCentresText } from '../shared/cost-centres.mjs';
import { clineScript, createClineFixture, runJson } from './helpers/contract-fixtures.mjs';

function fixture() {
  const f = createClineFixture();
  return runJson(clineScript, f.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
}

test('both adapters ship the same cost-centre implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/cost-centres.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/cost-centres.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('tagging a root attributes its whole subagent tree', () => {
  const report = fixture();
  const result = attributeCostCentres(report, [{ name: 'auth refactor', sessionIds: ['cline-root'] }]);
  assert.equal(result.centres.length, 1);
  assert.equal(result.centres[0].sessionCount, 3, 'the two subagents must follow the root');
  assert.equal(result.untagged, null, 'nothing is left untagged when the root covers the tree');
});

test('a cost centre expands only real descendants', () => {
  // The fixture tree is root -> child -> grandchild. Tagging the child must take its own
  // child with it and must not reach back up to the root.
  const report = fixture();
  const fromChild = expandCostCentres([{ name: 'auth', sessionIds: ['cline-child'] }], { sessions: report.sessions });
  assert.deepEqual(fromChild[0].memberSessionIds.sort(), ['cline-child', 'cline-grandchild']);
  const fromRoot = expandCostCentres([{ name: 'all', sessionIds: ['cline-root'] }], { sessions: report.sessions });
  assert.deepEqual(fromRoot[0].memberSessionIds.sort(), ['cline-child', 'cline-grandchild', 'cline-root']);
  // A session that is not in this report expands to nothing rather than being invented.
  const absent = expandCostCentres([{ name: 'other', sessionIds: ['cline-other'] }], { sessions: report.sessions });
  assert.deepEqual(absent[0].memberSessionIds, [], 'an id outside the report must not be claimed');
});

test('a parent cycle in a hand-edited ledger cannot hang the walk', () => {
  const cyclic = {
    sessions: [
      { row: { sessionId: 'a', parentSessionId: 'b' }, metrics: { cost: 1, calls: 1, inputTokens: 1, outputTokens: 1 } },
      { row: { sessionId: 'b', parentSessionId: 'a' }, metrics: { cost: 1, calls: 1, inputTokens: 1, outputTokens: 1 } },
    ],
  };
  const expanded = expandCostCentres([{ name: 'x', sessionIds: ['a'] }], { sessions: cyclic.sessions });
  assert.deepEqual(expanded[0].memberSessionIds.sort(), ['a', 'b']);
});

test('untagged spend is reported separately, never merged into a named centre', () => {
  const report = fixture();
  const result = attributeCostCentres(report, [{ name: 'auth', sessionIds: ['cline-child'] }]);
  assert.equal(result.centres.length, 1);
  assert.equal(result.centres[0].sessionCount, 2, 'the tagged child brings its own child');
  assert.ok(result.untagged, 'the rest must be reported as untagged');
  assert.equal(result.untagged.sessionCount, 1, 'only the root is left untagged here');
  const named = result.centres.reduce((sum, c) => sum + c.knownCostUsd, 0);
  const untagged = result.untagged.knownCostUsd;
  assert.ok(Math.abs((named + untagged) - report.billing.amountUsd) < 1e-9, 'the split must account for every dollar');
});

test('a session in two cost centres is reported, not double-counted', () => {
  const report = fixture();
  const result = attributeCostCentres(report, [
    { name: 'alpha', sessionIds: ['cline-root'] },
    { name: 'beta', sessionIds: ['cline-root', 'cline-other'] },
  ]);
  assert.ok(result.conflicts.length > 0, 'the overlap must be named');
  assert.ok(result.conflicts.some((conflict) => conflict.sessionId === 'cline-root'));
  assert.ok(result.conflicts.every((conflict) => conflict.counted === false));
  const total = [...result.centres, result.untagged].filter(Boolean)
    .reduce((sum, group) => sum + group.knownCostUsd, 0);
  assert.ok(Math.abs(total - report.billing.amountUsd) < 1e-9, 'a conflict must not inflate the total');
});

test('an unpriced session makes its centre partial rather than cheaper', () => {
  const synthetic = {
    sessions: [
      { row: { sessionId: 'a', parentSessionId: null }, metrics: { cost: 1, calls: 2, pricedCalls: 1, unpricedCalls: 1, inputTokens: 10, outputTokens: 5 } },
    ],
  };
  const result = attributeCostCentres(synthetic, [{ name: 'risky', sessionIds: ['a'] }]);
  assert.equal(result.centres[0].costUsd, null, 'a centre containing unpriced work reports no total');
  // A partially priced session's total cannot be split, so nothing is claimed as known.
  // Claiming the whole figure would assert knowledge we do not have.
  assert.equal(result.centres[0].knownCostUsd, 0, 'a partially priced total must not be claimed as known spend');
  assert.equal(result.centres[0].unpricedCalls, 1, 'the unpriced call is still counted and visible');
  assert.match(renderCostCentresText(result), /unavailable/);

  // A fully priced centre alongside it does report a real figure.
  const mixed = attributeCostCentres({
    sessions: [
      ...synthetic.sessions,
      { row: { sessionId: 'b', parentSessionId: null }, metrics: { cost: 2, calls: 1, pricedCalls: 1, unpricedCalls: 0, inputTokens: 1, outputTokens: 1 } },
    ],
  }, [{ name: 'clean', sessionIds: ['b'] }]);
  assert.equal(mixed.centres.find((centre) => centre.name === 'clean').costUsd, 2);
});

test('the config schema accepts a valid cost centre and rejects a malformed one', () => {
  const base = { schemaVersion: 1, runtimeDefaults: {}, providers: [], models: [] };
  assert.deepEqual(validateJsonSchema({ ...base, costCentres: [{ name: 'auth refactor', sessionIds: ['s1'] }] }, schema), []);
  // A centre must name itself and list at least one session.
  assert.ok(validateJsonSchema({ ...base, costCentres: [{ sessionIds: ['s1'] }] }, schema).length > 0);
  assert.ok(validateJsonSchema({ ...base, costCentres: [{ name: 'x', sessionIds: [] }] }, schema).length > 0);
  // A cost centre must not smuggle in anything else.
  assert.ok(validateJsonSchema({ ...base, costCentres: [{ name: 'x', sessionIds: ['s1'], secret: 'no' }] }, schema).length > 0);
  // The name is constrained so it cannot carry markup or a path.
  assert.ok(validateJsonSchema({ ...base, costCentres: [{ name: '<script>', sessionIds: ['s1'] }] }, schema).length > 0);
});

test('cost centres hold no credential or prompt content', () => {
  const report = fixture();
  const result = attributeCostCentres(report, [{ name: 'auth', sessionIds: ['cline-root'] }]);
  const text = renderCostCentresText(result);
  assert.doesNotMatch(text, /api[_-]?key|secret|authorization/i);
  assert.doesNotMatch(text, /<script|<img|onerror=/i, 'a cost centre name must never become markup');
});
