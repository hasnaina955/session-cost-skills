import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { counterfactualCost, renderCounterfactualText } from '../shared/counterfactual.mjs';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

function mcodeReport() {
  const f = createMCodeFixture();
  return runJson(mcodeScript, f.dataDir, ['--session', 'mcode-root', '--json'], f.environment).output;
}

// Re-price the same model under a different provider's rates, with real fingerprints.
function alternativeRecords(report, { model = 'alternative-model', scale = 10 } = {}) {
  return report.models[0].rateRecords.map((record) => ({
    ...record,
    model,
    amount: record.amount * scale,
    fingerprint: `sha256:${'a'.repeat(64)}`,
  }));
}

test('both adapters ship the same counterfactual implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/counterfactual.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/counterfactual.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('a counterfactual never mutates the reported cost', () => {
  // The single most important property. A deep snapshot is compared afterwards.
  const report = mcodeReport();
  const before = JSON.stringify(report);
  const result = counterfactualCost(report, { model: 'alternative-model', rateRecords: alternativeRecords(report) });
  assert.equal(JSON.stringify(report), before, 'the report must be untouched');
  assert.equal(report.billing.amountUsd, result.actualCostUsd, 'the actual cost is carried, not replaced');
  assert.notEqual(result.costUsd, result.actualCostUsd, 'the estimate must differ from the real figure here');
  assert.equal(result.basis, 'counterfactual-estimate');
  assert.equal(result.isEstimate, true);
});

test('an unknown model is unavailable, never extrapolated', () => {
  const report = mcodeReport();
  for (const bad of [{ model: 'never-heard-of-it', rateRecords: [] }, { model: null, rateRecords: alternativeRecords(report) }]) {
    const result = counterfactualCost(report, bad);
    assert.equal(result.status, 'unavailable');
    assert.equal(result.costUsd, null, 'an unknown model must produce no number at all');
    assert.equal(result.deltaUsd, null);
    assert.ok(result.reason, 'the reason must be stated');
    assert.match(renderCounterfactualText(report, result), /UNAVAILABLE/);
  }
});

test('an incomplete rate card is refused rather than partially priced', () => {
  const report = mcodeReport();
  const records = alternativeRecords(report).filter((record) => record.component !== 'cacheWrite');
  const result = counterfactualCost(report, { model: 'alternative-model', rateRecords: records });
  assert.equal(result.status, 'unavailable');
  assert.equal(result.costUsd, null);
  assert.deepEqual(result.missingComponents, ['cacheWrite']);
  assert.match(result.reason, /cacheWrite/);
});

test('a rate record not effective at the call time is not used', () => {
  const report = mcodeReport();
  const future = alternativeRecords(report).map((record) => ({ ...record, effectiveFrom: '2099-01-01T00:00:00.000Z' }));
  const at = Date.parse('2026-06-01T00:00:00.000Z');
  assert.equal(counterfactualCost(report, { model: 'alternative-model', rateRecords: future, at }).status, 'unavailable');
  // The same records do apply at a time inside their window.
  const later = alternativeRecords(report).map((record) => ({ ...record, effectiveFrom: '2026-01-01T00:00:00.000Z', effectiveThrough: null }));
  assert.equal(counterfactualCost(report, { model: 'alternative-model', rateRecords: later, at }).status, 'available');
});

test('a context tier outside the record is not used', () => {
  const report = mcodeReport();
  const tiered = alternativeRecords(report).map((record) => ({ ...record, context: { minTokens: 1_000_000, maxTokens: null } }));
  assert.equal(counterfactualCost(report, { model: 'alternative-model', rateRecords: tiered, contextTokens: 100 }).status, 'unavailable');
  assert.equal(counterfactualCost(report, { model: 'alternative-model', rateRecords: tiered, contextTokens: 2_000_000 }).status, 'available');
});

test('every counterfactual rate carries a fingerprint and an effective window', () => {
  const report = mcodeReport();
  const result = counterfactualCost(report, { model: 'alternative-model', rateRecords: alternativeRecords(report) });
  assert.equal(result.status, 'available');
  for (const line of result.lines) {
    assert.match(line.fingerprint, FINGERPRINT, 'a counterfactual rate must be traceable');
    assert.ok(Number.isFinite(Date.parse(line.effectiveFrom)));
    assert.ok(['flat', 'peak', 'offPeak'].includes(line.timeBand));
  }
});

test('the counterfactual arithmetic is reproducible by hand', () => {
  const report = mcodeReport();
  const result = counterfactualCost(report, { model: 'alternative-model', rateRecords: alternativeRecords(report) });
  let sum = 0;
  for (const line of result.lines) {
    assert.ok(Math.abs((line.tokens / 1_000_000) * line.ratePerMillion - line.amount) < 1e-12);
    sum += line.amount;
  }
  assert.ok(Math.abs(sum - result.costUsd) < 1e-12);
  assert.ok(Math.abs(result.deltaUsd - (result.costUsd - result.actualCostUsd)) < 1e-12);
});

test('the rendering states it is an estimate and changes nothing', () => {
  const report = mcodeReport();
  const before = report.billing.amountUsd;
  const text = renderCounterfactualText(report, counterfactualCost(report, { model: 'alternative-model', rateRecords: alternativeRecords(report) }));
  assert.match(text, /ESTIMATE/);
  assert.match(text, /does not\s+change the reported cost/);
  assert.match(text, /may tokenize differently/);
  assert.match(text, /reported cost/i);
  assert.equal(report.billing.amountUsd, before);
  assert.doesNotMatch(text, /api[_-]?key|authorization|secret/i);
});

test('a recorded report can still be re-priced, and says what it is', () => {
  // Cline's cost is runtime-recorded; a counterfactual against a known rate is still a
  // legitimate estimate, as long as it is labelled and the recorded figure is untouched.
  const f = createClineFixture();
  const report = runJson(clineScript, f.dataDir, ['--session', 'cline-root', '--json']).output;
  const before = report.billing.amountUsd;
  const result = counterfactualCost(report, { model: 'alt', rateRecords: [] });
  assert.equal(result.status, 'unavailable', 'with no rate record there is nothing to estimate from');
  assert.equal(report.billing.amountUsd, before);
  assert.match(renderCounterfactualText(report, result), /Reported cost stays authoritative/);
});

test('the newest effective record wins, so a refresh is not ignored', () => {
  const report = mcodeReport();
  const base = alternativeRecords(report);
  const newer = base.map((record) => ({
    ...record,
    amount: record.amount * 2,
    effectiveFrom: '2026-06-01T00:00:00.000Z',
    fingerprint: `sha256:${'b'.repeat(64)}`,
  }));
  const result = counterfactualCost(report, { model: 'alternative-model', rateRecords: [...base, ...newer], at: Date.parse('2026-07-01T00:00:00.000Z') });
  assert.equal(result.status, 'available');
  for (const line of result.lines) {
    assert.match(line.fingerprint, new RegExp(`^sha256:${'b'.repeat(64)}$`), 'the newer record must be selected');
  }
});
