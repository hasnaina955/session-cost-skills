import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, createRandomMCodeFixture, runCli, runJson } from './helpers/contract-fixtures.mjs';

/**
 * Accounting invariants, checked over randomly generated ledgers.
 *
 * Every wrong-money bug in this project's history produced a *plausible* number rather than an
 * error: peak-window calls priced at the off-peak rate, CommandCode's peak calendar applied to
 * unrelated providers, cache writes double-counted in the CSV export, `$0.0000` for a cost that
 * could not be established. None of those throw, and a spot assertion on one fixture misses
 * them. These tests generate many ledgers and assert the properties that must hold for any
 * input at all, so the next one fails a test instead of a user.
 *
 * Seeds are fixed so runs are reproducible; a failure prints its seed, and `INVARIANT_SEED=<n>`
 * replays exactly one case. Every property below is checked within 1e-9, which is far tighter
 * than display precision and loose enough for floating-point summation order.
 */

const SEEDS = [1, 7, 42, 1337, 90210];
const EPSILON = 1e-9;
const seedFromEnvironment = process.env.INVARIANT_SEED;
const seeds = seedFromEnvironment ? [Number(seedFromEnvironment)] : SEEDS;
const PINNED = '2026-06-15T18:00:00.000Z';
const close = (left, right) => Math.abs(left - right) <= EPSILON;
const sum = (values) => values.reduce((total, value) => total + value, 0);

test('the total is exactly the sum of the per-model and per-session costs', () => {
  for (const seed of seeds) {
    const fixture = createRandomMCodeFixture(seed, { sessions: 5 });
    const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'random-0', '--json'], { ...fixture.environment, SESSION_COST_NOW: PINNED }).output;
    if (report.billing.coverage !== 'complete') continue;

    const fromModels = sum(report.models.map((model) => model.totalCost ?? 0));
    const fromSessions = sum(report.sessions.map((session) => session.metrics?.cost ?? 0));
    assert.ok(close(report.billing.amountUsd, fromModels),
      `seed ${seed}: total ${report.billing.amountUsd} != sum of models ${fromModels}`);
    assert.ok(close(report.billing.amountUsd, fromSessions),
      `seed ${seed}: total ${report.billing.amountUsd} != sum of sessions ${fromSessions}`);

    // Per-model cost is itself the sum of its four component costs, so a component can never
    // be dropped or counted twice without the total moving.
    for (const model of report.models) {
      const components = sum([model.costInput, model.costOutput, model.costCacheRead, model.costCacheWrite].map((v) => v ?? 0));
      assert.ok(close(model.totalCost, components),
        `seed ${seed}: model ${model.modelId} total ${model.totalCost} != components ${components}`);
    }
  }
});

test('an unpriced call never becomes a zero cost', () => {
  // Principle 1. A ledger containing an unpriced model must not report a settled total of 0,
  // because null compares as "less than the limit" and a reader takes $0.0000 as "it was free".
  for (const seed of seeds) {
    const fixture = createRandomMCodeFixture(seed, { sessions: 4, includeUnpriced: true });
    for (const sessionId of ['random-0', 'random-1', 'random-2', 'random-3']) {
      const report = runJson(mcodeScript, fixture.dataDir, ['--session', sessionId, '--json'], { ...fixture.environment, SESSION_COST_NOW: PINNED }).output;
      if (report.billing.coverage === 'complete') continue;
      assert.notEqual(report.billing.amountUsd, 0,
        `seed ${seed}: ${sessionId} is not completely priced but reported a total of 0`);
      if (report.billing.amountUsd !== null) {
        assert.notEqual(report.billing.coverage, 'complete',
          `seed ${seed}: ${sessionId} reported a number and called itself complete`);
      }
    }
  }
});

test('token totals reconcile under each runtime own semantics', () => {
  // Principle 7. The two runtimes define "input" differently and a shared formula would be
  // wrong for one of them, so the reconciliation is asserted per runtime rather than once.
  // MCode: input_tokens excludes cache, so total is input + output + cacheRead + cacheWrite
  // with reasoning already inside output. Cline: inputTokens includes cache.
  for (const seed of seeds) {
    const fixture = createRandomMCodeFixture(seed, { sessions: 4 });
    for (const sessionId of fixture.sessionIds) {
      const report = runJson(mcodeScript, fixture.dataDir, ['--session', sessionId, '--json'], { ...fixture.environment, SESSION_COST_NOW: PINNED }).output;
      for (const model of report.models) {
        const expected = model.inputTokens + model.outputTokens + model.cacheReadTokens + model.cacheWriteTokens;
        assert.ok(close(model.totalTokens, expected),
          `seed ${seed}: ${sessionId}/${model.modelId} totalTokens ${model.totalTokens} != input+output+cache ${expected}`);
        assert.ok(model.reasoningTokens <= model.outputTokens,
          `seed ${seed}: reasoning must be a subset of output, never added twice`);
      }
    }
  }

  const cline = createClineFixture();
  for (const sessionId of ['cline-root', 'cline-child', 'cline-partial']) {
    const report = runJson(clineScript, cline.dataDir, ['--session', sessionId, '--json'], { SESSION_COST_NOW: PINNED }).output;
    const usage = report.usage;
    assert.equal(usage.inputTokens, usage.freshInputTokens + usage.cacheReadTokens + usage.cacheWriteTokens,
      `Cline inputTokens includes cache: ${sessionId} must satisfy input = fresh + cacheRead + cacheWrite`);
    assert.equal(usage.totalTokens, usage.inputTokens + usage.outputTokens,
      `${sessionId}: total must be input (which includes cache) + output`);
  }
});

test('per-model rows sum to the raw ledger, not just to each other', () => {
  // The other reconciliations compare model rows to each other, which stays self-consistent
  // even when every row comes from the same wrong accumulator: doubling the cache-write count
  // in one place doubles it on both sides of the equality. This test anchors the breakdown to
  // the ledger itself, read here with SQL rather than through the CLI, so the witness is
  // genuinely independent of the code under test. It caught an injected cache-write
  // double-count that every other invariant in this file missed.
  const fields = [
    ['input_tokens', 'inputTokens'],
    ['output_tokens', 'outputTokens'],
    ['cache_read_tokens', 'cacheReadTokens'],
    ['cache_write_tokens', 'cacheWriteTokens'],
  ];
  for (const seed of seeds) {
    const fixture = createRandomMCodeFixture(seed, { sessions: 4 });
    for (const sessionId of fixture.sessionIds) {
      const report = runJson(mcodeScript, fixture.dataDir, ['--session', sessionId, '--json'], { ...fixture.environment, SESSION_COST_NOW: PINNED }).output;

      // Independent witness: sum the ledger table directly, in SQL.
      const database = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
      const totals = new Map();
      for (const [column] of fields) {
        const row = database.prepare(`SELECT COALESCE(SUM(${column}), 0) AS total FROM local_runtime_token_usage WHERE session_id = ?`).get(sessionId);
        totals.set(column, Number(row.total) || 0);
      }
      database.close();

      for (const [column, field] of fields) {
        const fromModels = sum(report.models.map((model) => Number(model[field]) || 0));
        assert.equal(fromModels, totals.get(column),
          `seed ${seed}: ${sessionId} model rows total ${fromModels} for ${field}, but the ledger holds ${totals.get(column)}`);
      }
    }
  }
});

test('--include-children counts every descendant exactly once', () => {
  // Principle 8. A session graph has a parent and children; summing overlapping rows is how a
  // subagent's cost gets billed twice. The child set here is a real chain, so the total must
  // equal the root alone plus the sum of the descendants, with no descendant appearing twice.
  const fixture = createClineFixture();
  const rootOnly = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--json'], { SESSION_COST_NOW: PINNED }).output;
  const withChildren = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json'], { SESSION_COST_NOW: PINNED }).output;

  const included = withChildren.sessionGraph?.includedSessionIds ?? withChildren.includedSessionIds ?? [];
  assert.equal(new Set(included).size, included.length, `a session was included twice: ${included.join(', ')}`);
  const child = runJson(clineScript, fixture.dataDir, ['--session', 'cline-child', '--json'], { SESSION_COST_NOW: PINNED }).output;
  const grandchild = runJson(clineScript, fixture.dataDir, ['--session', 'cline-grandchild', '--json'], { SESSION_COST_NOW: PINNED }).output;
  const expected = rootOnly.billing.amountUsd + child.billing.amountUsd + grandchild.billing.amountUsd;
  assert.ok(close(withChildren.billing.amountUsd, expected),
    `root + child + grandchild should total ${expected}, but --include-children reported ${withChildren.billing.amountUsd}`);
});

test('the text, CSV, and JSON reports agree on the same total', () => {
  // A figure that differs by output format is a figure a reader cannot trust. The CSV export
  // double-counting cached tokens is exactly this class of bug, and it is invisible in JSON.
  for (const seed of seeds.slice(0, 3)) {
    const fixture = createRandomMCodeFixture(seed, { sessions: 4 });
    const environment = { ...fixture.environment, SESSION_COST_NOW: PINNED };
    for (const sessionId of ['random-0', 'random-1']) {
      const report = runJson(mcodeScript, fixture.dataDir, ['--session', sessionId, '--json'], environment).output;
      const text = runCli(mcodeScript, fixture.dataDir, ['--session', sessionId], environment);
      const csv = runCli(mcodeScript, fixture.dataDir, ['--session', sessionId, '--csv'], environment);
      assert.equal(text.status, 0, text.stderr);
      assert.equal(csv.status, 0, csv.stderr);

      const amount = report.billing.amountUsd.toFixed(6);
      assert.ok(text.stdout.includes(amount), `seed ${seed}: text report omits the total ${amount}`);
      // CSV carries one row per session; its cost column must reconcile to the same total.
      const rows = csv.stdout.trim().split('\n').filter((line) => line.trim() !== '');
      const header = rows[0].split(',');
      const costColumn = header.indexOf('costUsd');
      assert.notEqual(costColumn, -1, 'the CSV must name its cost column rather than leave it positional');
      const costs = rows.slice(1).map((line) => Number(line.split(',')[costColumn])).filter(Number.isFinite);
      assert.equal(costs.length, rows.length - 1, 'every CSV row must carry a numeric cost');
      assert.ok(close(sum(costs), report.billing.amountUsd),
        `seed ${seed}: CSV rows total ${sum(costs)} but the report says ${report.billing.amountUsd}`);
    }
  }
});

test('reordering ledger rows does not change any figure', () => {
  // A total that depends on row order is summing something that is not a total. This catches
  // accumulation bugs - a rate applied to the wrong call, a band resolved from stale state -
  // that a fixed fixture would hide, because the fixture always presents rows in one order.
  const fixture = createRandomMCodeFixture(1337, { sessions: 4 });
  const environment = { ...fixture.environment, SESSION_COST_NOW: PINNED };
  const original = runJson(mcodeScript, fixture.dataDir, ['--session', 'random-0', '--json'], environment).output;

  // Reverse the usage rows in place and read the same session again.
  const database = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const rows = database.prepare('SELECT * FROM local_runtime_token_usage WHERE session_id = ?').all('random-0');
  database.exec('DELETE FROM local_runtime_token_usage WHERE session_id = \'random-0\'');
  const insert = database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const row of [...rows].reverse()) insert.run(...Object.values(row));
  database.close();

  const reordered = runJson(mcodeScript, fixture.dataDir, ['--session', 'random-0', '--json'], environment).output;
  assert.equal(reordered.billing.amountUsd, original.billing.amountUsd,
    'the total changed when ledger rows were reordered, so something other than the calls is being summed');
  for (const [index, model] of original.models.entries()) {
    assert.equal(reordered.models[index].totalCost, model.totalCost, 'per-model cost depends on row order');
  }
});
