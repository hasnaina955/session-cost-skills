import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';
import { removeDirectory } from './helpers/temp-dir.mjs';
import { prepareProviderRates } from '../adapters/mcode/skill/scripts/lib/rates.mjs';

/**
 * #100 end to end: a ledger row whose timestamp is NULL must degrade to unpriced, not price at
 * the epoch. `Number(null)` is 0, and `new Date(0)` is a real instant - epoch Thursday, 00:00
 * UTC - which falls in the off-peak band, the cheaper one. Before the fix, a torn row on a
 * banded model was priced at off-peak and silently under-reported the session.
 *
 * The fixture builds a real session with two calls on a banded model: one with a good
 * timestamp (a weekday outside the peak windows, so off-peak is the *correct* band for it)
 * and one with ts NULL. The report must price the first and refuse the second, and it must
 * not crash: one torn row degrades one call, never the whole report.
 */

const GOOD_TS = Date.parse('2026-06-15T12:00:00.000Z'); // a Monday, 12:00 UTC: outside every peak window
const BANDED_MODEL = 'fixture-banded-model';
// Off-peak rates per 1M tokens: input 1, output 2, cacheRead 0.1, cacheWrite 0.25.
const EXPECTED_GOOD_COST = (1000 * 1 + 500 * 2 + 100 * 0.1 + 50 * 0.25) / 1_000_000;

function addBandedModel(ratesPath) {
  const table = JSON.parse(fs.readFileSync(ratesPath, 'utf8'));
  const band = (input, output, cacheRead, cacheWrite) => ({
    input,
    output,
    cacheRead,
    cacheWrite,
    cacheWriteSource: 'fixture-banded-cache-write',
    sourceAmounts: { input: String(input), output: String(output), cacheRead: String(cacheRead), cacheWrite: String(cacheWrite) },
  });
  const prepared = prepareProviderRates('commandcode', {
    [BANDED_MODEL]: {
      name: 'Fixture Banded Model',
      provider: 'commandcode',
      category: 'fixture',
      // The validator requires the flat components even on a banded model; the band cards are
      // what pricing actually reads for a banded call.
      ...band(1, 2, 0.1, 0.25),
      cacheWriteSource: 'fixture-banded-cache-write',
      timeOfDay: {
        effective: '2025-01-01T00:00:00.000Z',
        peak: band(2, 4, 0.2, 0.5),
        offPeak: band(1, 2, 0.1, 0.25),
      },
    },
  }, { refreshedAt: '2025-02-01T00:00:00.000Z' });
  Object.assign(table.providers.commandcode.models, prepared.models);
  table.providers.commandcode.rateRecords.push(...prepared.rateRecords);
  table._meta.sourceCoverage.commandcode = { sourceModels: 2, publishedModels: 2, excludedModels: 0 };
  fs.writeFileSync(ratesPath, JSON.stringify(table, null, 2) + '\n', 'utf8');
}

function addTornSession(dataDir) {
  const relative = path.join('v2', 'sessions', 'mcode-torn-ts');
  const directory = path.join(dataDir, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'llm-call.json'), JSON.stringify({
    provider: 'custom_provider:commandcode',
    model: BANDED_MODEL,
  }), 'utf8');
  const message = {
    role: 'assistant',
    timestamp: GOOD_TS,
    model: BANDED_MODEL,
    provider: 'custom_provider:commandcode',
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1 },
  };
  fs.writeFileSync(path.join(directory, 'messages.jsonl'), `${JSON.stringify({ message })}\n`, 'utf8');

  const database = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)')
    .run('mcode-torn-ts', 'torn', 'Torn timestamp fixture', null, 'mcode-torn-ts');
  const insertUsage = database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  insertUsage.run(100, 'mcode-torn-ts', 'torn', 'torn-1', GOOD_TS, 1000, 500, 0, 100, 50);
  insertUsage.run(101, 'mcode-torn-ts', 'torn', 'torn-2', null, 4000, 2000, 0, 400, 200);
  database.close();
}

test('a ledger row with a NULL timestamp is unpriced, not priced at the epoch (#100)', (t) => {
  const fixture = createMCodeFixture();
  t.after(() => removeDirectory(fixture.dataDir));
  addBandedModel(fixture.ratesPath);
  addTornSession(fixture.dataDir);

  const { result, output: report } = runJson(fixture.script, fixture.dataDir, ['--session', 'mcode-torn-ts'], fixture.environment);
  assert.ok(report, `the report must still be written:\n${result.stderr}`);
  // Exit 2 is the documented signal for a report whose cost is not fully known (the same code
  // an unknown-model session exits with): one torn row degrades one call, never the report.
  assert.equal(result.status, 2, 'an incompletely priced report exits non-zero, but it still reports');

  const session = report.sessions.find((candidate) => candidate.row?.sessionId === 'mcode-torn-ts');
  assert.ok(session, 'the session must appear in the report');

  // The good call prices at the off-peak band (correct for its timestamp); the torn call
  // contributes nothing. Before the fix the torn call priced too - at the epoch's off-peak
  // band - and the total was the sum of both with no warning.
  assert.equal(report.totalCost, EXPECTED_GOOD_COST, 'only the call with a real timestamp may be priced');
  assert.equal(session.metrics.cost, EXPECTED_GOOD_COST, 'the per-session cost is the priced sum, a lower bound');
  assert.equal(session.metrics.calls, 2, 'both calls are still counted; counting is not pricing');

  // The coverage verdict names the gap rather than hiding it in a smaller, confident total.
  // Before the aggregation fix this said "unavailable" while a priced sum sat beside it.
  assert.equal(report.coverage.status, 'partial', 'a session with an unpriceable call is partial, never a clean total');
  assert.ok(
    report.coverage.unknownReasons.some((reason) => reason.includes('no applicable cost')),
    'the verdict names the gap',
  );

  // The timeline carries the same verdict per call: the priced call is listed with its real
  // cost, and the torn call is absent - createTimeline skips an unusable timestamp rather
  // than guessing one, the same rule the pricing path now follows.
  const events = (report.timeline ?? []).filter((event) => event.sessionId === 'mcode-torn-ts');
  assert.equal(events.length, 1, 'the torn call is skipped, never given a fabricated instant');
  assert.equal(events[0].costUsd, EXPECTED_GOOD_COST, 'the priced call carries its real cost');
});
