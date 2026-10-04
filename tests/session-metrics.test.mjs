import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMCodeFixture, runCli, runJson, FIXTURE_EPOCH } from './helpers/contract-fixtures.mjs';
import { removeDirectory } from './helpers/temp-dir.mjs';

/**
 * #104: the per-session metrics contract, pinned at the data layer.
 *
 * The shared consumers (rollup, insights, CSV, cost centres) were all written for Cline's
 * convention: `cost` is the sum of the calls that could be priced - a lower bound when
 * partial - and `pricedCalls` / `unpricedCalls` say how much of the session the figure
 * covers. MCode's builder read `priced.missing`, a field priceRow does not return, so
 * unpricedCalls was always 0 and every one of those consumers treated a partial session as
 * complete. Every assertion in this file fails against the pre-fix builder.
 */

const env = (fixture) => ({ ...fixture.environment, SESSION_COST_NOW: FIXTURE_EPOCH });

async function listMetrics(fixture) {
  const { output } = runJson(fixture.script, fixture.dataDir, ['--list', '10'], env(fixture));
  const out = new Map();
  for (const nested of output.sessions) {
    const mine = (nested.sessions ?? []).find((s) => s.row?.sessionId === nested.sessionId);
    if (mine) out.set(nested.sessionId, mine.metrics);
  }
  return out;
}

test('a partial session discloses the priced sum and counts the gap (#104)', async (t) => {
  const fixture = createMCodeFixture({ base: Date.parse(FIXTURE_EPOCH) });
  t.after(() => removeDirectory(fixture.dataDir));
  const metrics = await listMetrics(fixture);

  const partial = metrics.get('mcode-partial');
  assert.equal(partial.calls, 2);
  assert.equal(partial.pricedCalls, 1, 'the priced call is counted');
  assert.equal(partial.unpricedCalls, 1, 'the unpriced call is counted, not folded away');
  assert.equal(partial.cost, 0.00006, 'cost is the priced sum - a lower bound, not null and not a guessed total');
});

test('a session where no call could be priced has a null cost, never a zero (#104, rule 1)', async (t) => {
  const fixture = createMCodeFixture({ base: Date.parse(FIXTURE_EPOCH) });
  t.after(() => removeDirectory(fixture.dataDir));
  const metrics = await listMetrics(fixture);

  const unpriced = metrics.get('mcode-unpriced');
  assert.equal(unpriced.calls, 1, 'counting is not pricing');
  assert.equal(unpriced.pricedCalls, 0);
  assert.equal(unpriced.unpricedCalls, 1);
  assert.equal(unpriced.cost, null, 'the sum of zero priced calls is the absence of a figure, not $0');

  // The edge that is NOT unknown: a session with no calls has a real zero. --list skips
  // zero-usage sessions, so this edge is selected directly.
  const database = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)')
    .run('mcode-empty', 'empty', 'Empty fixture', null, null);
  database.close();
  const { output: emptyReport } = runJson(fixture.script, fixture.dataDir, ['--session', 'mcode-empty'], env(fixture));
  const empty = (emptyReport.sessions ?? []).find((s) => s.row?.sessionId === 'mcode-empty')?.metrics;
  assert.ok(empty, 'the empty session must appear in its own report');
  assert.equal(empty.calls, 0);
  assert.equal(empty.cost, 0, '"nothing happened" is an answer, not an unknown');
});

test('the rollup refuses to present a partial day as a final total (#104)', (t) => {
  const fixture = createMCodeFixture({ base: Date.parse(FIXTURE_EPOCH) });
  t.after(() => removeDirectory(fixture.dataDir));
  const result = runCli(fixture.script, fixture.dataDir, ['--list', '10', '--rollup', 'daily'], env(fixture));
  assert.equal(result.status, 0, result.stderr);
  const text = result.stdout;
  // Before the fix every day showed a confident figure, because the unpriced calls that
  // would have marked it were never counted.
  assert.match(text, /2026-06-15\s+0\.00 M\s+unavailable\s+2\s+partial/, 'a day with an unpriced call is partial, its cost unavailable');
  assert.match(text, /2026-06-13\s+0\.00 M\s+\$0\.000436\s+1\s+complete/, 'a fully priced day still shows its figure');
  assert.match(text, /known portion is \$0\.000508/, 'the disclosed lower bound is named');
  assert.match(text, /reported as unavailable rather than as a smaller real number/, 'the refusal is explained');
});
