import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readRateTable } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

test('a priced MCode model reports the exact rate records that produced its cost', () => {
  // rateProvenance is optional in the schema, so an empty array is schema-valid and a
  // regression that emptied it would fail nothing. This is the test that prevents that.
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;

  assert.equal(report.coverage.status, 'complete');
  assert.ok(report.rateProvenance.length > 0, 'a completely priced report must carry rate provenance');
  for (const record of report.rateProvenance) {
    assert.match(record.fingerprint, FINGERPRINT, 'every provenance record needs a rate fingerprint');
    assert.ok(Number.isFinite(Date.parse(record.effectiveFrom)), 'effectiveFrom must be a timestamp');
    assert.ok(['input', 'output', 'cacheRead', 'cacheWrite'].includes(record.component));
    assert.ok(['flat', 'peak', 'offPeak'].includes(record.timeBand));
    assert.ok(record.context && typeof record.context === 'object');
    assert.ok(record.model && record.provider);
  }
  // Every completely priced model must be traceable to at least one record.
  // Note the two namespaces: a model's `provider` is the resolved driver id, while a
  // provenance record's `provider` is the rate provider. `providerKey` is the join.
  const provenanced = new Set(report.rateProvenance.map((r) => `${r.provider}/${r.model}`));
  for (const entry of report.models.filter((m) => m.rateKnown)) {
    assert.ok(provenanced.has(`${entry.providerKey}/${entry.modelId}`),
      `${entry.providerKey}/${entry.modelId} priced completely but has no rate provenance`);
  }
});

test('a partially priced model still carries provenance for the subset that did price', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-partial', '--json'], fixture.environment).output;
  assert.equal(report.coverage.status, 'partial');
  assert.ok(report.coverage.unknownReasons.length > 0, 'the unpriced call must be named');
  assert.ok(report.rateProvenance.length > 0, 'the priced subset must still be traceable');
  assert.equal(report.billing.coverage, 'partial');
});

test('Cline reports no rate provenance, and costBasis explains why', () => {
  // Cline cost is what the runtime recorded, not a rate-card calculation, so there is no
  // rate to fingerprint. The empty list is correct; the basis has to say so.
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--json']).output;
  assert.equal(report.runtime.costBasis, 'runtime-recorded');
  assert.equal((report.rateProvenance ?? []).length, 0, 'a runtime-recorded report claims no rate provenance');
  assert.equal(report.billing.recordedCostUsd, report.billing.amountUsd);
  assert.equal(report.billing.estimatedCostUsd, null, 'a recorded report never carries an estimate');
});

test('omitting the fixture rate table is a different scenario, not a provenance failure', () => {
  // Guards the exact mistake that produced a false bug report: running against the
  // bundled rate table instead of the fixture's makes the model unpriced, which
  // correctly yields no provenance and coverage "unavailable" rather than "complete".
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json']).output;
  assert.notEqual(report.coverage.status, 'complete', 'the fixture model is absent from the bundled table');
  assert.equal((report.rateProvenance ?? []).length, 0, 'an unpriced model must carry no rate provenance');
  assert.equal(report.billing.amountUsd, null, 'an unpriced session reports no cost rather than zero');
});

test('no MCode fixture model can be priced by the bundled rate table', () => {
  // The guard for the trap above. Any test that runs the CLI without SESSION_COST_RATES_PATH is
  // priced by the *bundled* table, so a fixture model name that the live catalog also publishes
  // quietly turns a hermetic test into a wall-clock one: the fixture's session dates are relative
  // to now, so they eventually cross the bundled record's `effectiveFrom` and the test flips from
  // pass to fail with no code change in between. That is exactly how naming a fixture model
  // `step-5-preview` left this file green on 2026-09-26 and red on 2026-09-27, on one commit.
  // Asserting the overlap is absent makes the next collision a test failure rather than a
  // surprise discovered the day after a rate refresh moves the boundary.
  const bundled = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));
  const bundledModels = new Set(
    Object.values(bundled.providers).flatMap((provider) => Object.keys(provider.models ?? {})),
  );
  assert.ok(bundledModels.size > 0, 'the bundled table publishes no models, so this guard would check nothing');

  const fixture = createMCodeFixture();
  const fixtureModels = new Set();
  const sessionsRoot = path.join(fixture.dataDir, 'v2', 'sessions');
  for (const entry of fs.readdirSync(sessionsRoot)) {
    fixtureModels.add(JSON.parse(fs.readFileSync(path.join(sessionsRoot, entry, 'llm-call.json'), 'utf8')).model);
  }
  const fixtureTable = JSON.parse(fs.readFileSync(fixture.ratesPath, 'utf8'));
  for (const provider of Object.values(fixtureTable.providers)) {
    for (const model of Object.keys(provider.models ?? {})) fixtureModels.add(model);
  }
  assert.ok(fixtureModels.size > 0, 'the fixture declares no models, so this guard would check nothing');

  const collisions = [...fixtureModels].filter((model) => bundledModels.has(model)).sort();
  assert.deepEqual(collisions, [],
    `fixture models the bundled table can price, which makes a fixture test wall-clock dependent: ${collisions.join(', ')}`);
});
