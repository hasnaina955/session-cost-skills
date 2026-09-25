import test from 'node:test';
import assert from 'node:assert/strict';
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
