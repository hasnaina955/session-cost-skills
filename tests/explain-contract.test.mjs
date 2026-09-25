import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { explainCost, renderExplanation } from '../shared/explain.mjs';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const FINGERPRINT = /^sha256:[a-f0-9]{64}$/;

test('both adapters ship the same cost-explainer implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/explain.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/explain.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('the explanation reconciles to the reported total', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  const explanation = explainCost(report);
  assert.equal(explanation.total.reconciles, true, 'the lines must add up to the reported total');
  assert.equal(explanation.total.reported, report.billing.amountUsd);
  assert.ok(Math.abs(explanation.total.derivedFromLines - report.billing.amountUsd) < 1e-9);
  assert.ok(explanation.lines.length > 0);
});

test('every shown rate carries a fingerprint, an effective window, and a context', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  for (const line of explainCost(report).lines) {
    for (const component of line.components) {
      assert.match(component.fingerprint, FINGERPRINT, `${line.modelId}/${component.component} needs a fingerprint`);
      assert.ok(Number.isFinite(Date.parse(component.effectiveFrom)), 'effectiveFrom must be a timestamp');
      assert.ok(component.context && typeof component.context === 'object', 'the context tier must be shown');
      assert.ok(['flat', 'peak', 'offPeak'].includes(component.timeBand));
    }
  }
});

test('the arithmetic is reproducible by hand', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  for (const line of explainCost(report).lines) {
    let sum = 0;
    for (const component of line.components) {
      const expected = (component.tokens / 1_000_000) * component.ratePerMillion;
      assert.ok(Math.abs(expected - component.amount) < 1e-12, `${line.modelId}/${component.component} arithmetic is wrong`);
      sum += expected;
    }
    assert.ok(Math.abs(sum - line.cost) < 1e-9, 'the model subtotal must equal the sum of its components');
  }
});

test('an unpriced model is a named line, never a silent omission', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-partial', '--json'], fixture.environment).output;
  const explanation = explainCost(report);
  const named = [...explanation.lines, ...explanation.unpriced].map((entry) => entry.modelId);
  for (const model of report.models) {
    assert.ok(named.includes(model.rateKey ?? model.modelId), `${model.rateKey} must appear in the explanation`);
  }
  const rendered = renderExplanation(report);
  for (const entry of explanation.unpriced) {
    assert.match(rendered, new RegExp(`${entry.modelId}: NOT PRICED`), 'an unpriced model must be visibly labelled');
    assert.ok(entry.reason.length > 0, 'an unpriced model must state why');
  }
});

test('a recorded cost and an estimate are labelled differently', () => {
  const mcode = createMCodeFixture();
  const estimate = runJson(mcodeScript, mcode.dataDir, ['--session', 'mcode-root', '--json'], mcode.environment).output;
  assert.equal(explainCost(estimate).isEstimate, true);
  assert.match(renderExplanation(estimate), /provider-rate estimate/);

  const cline = createClineFixture();
  const recorded = runJson(clineScript, cline.dataDir, ['--session', 'cline-root', '--json']).output;
  assert.equal(explainCost(recorded).isEstimate, false);
  assert.match(renderExplanation(recorded), /runtime-recorded cost/);
});

test('a total that cannot be reconciled says so rather than looking tidy', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  const tampered = { ...report, billing: { ...report.billing, amountUsd: 99 } };
  const explanation = explainCost(tampered);
  assert.equal(explanation.total.reconciles, false);
  assert.match(renderExplanation(tampered), /do not reconcile/);
  assert.equal(explanation.total.reported, 99, 'the reported total stays authoritative and is not overwritten');
});

test('the rendered explanation carries no prompt, transcript, or credential content', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment).output;
  const text = renderExplanation(report);
  assert.doesNotMatch(text, /api[_-]?key|authorization|bearer|sk-[A-Za-z0-9]{8}/i);
  // Only the report's own identifiers and rate metadata may appear.
  for (const line of text.split('\n')) {
    assert.doesNotMatch(line, /content|message|role|instruction/i, 'the explanation must not quote prompt content');
  }
});

test('a runtime-recorded report explains its per-model sums without inventing a rate', () => {
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
  const explanation = explainCost(report);
  assert.equal(explanation.isEstimate, false);
  assert.equal(explanation.total.reconciles, true, 'the per-model sums must add up to the total');
  assert.ok(explanation.lines.length > 0);
  for (const line of explanation.lines) {
    assert.equal(line.recorded, true);
    assert.ok(isFiniteNumber(line.cost));
    // A recorded line has no rate, and must not be given one.
    for (const component of line.components) {
      assert.equal(component.ratePerMillion, undefined, 'a recorded line must not invent a rate');
      assert.equal(component.fingerprint, undefined);
    }
  }
  const rendered = renderExplanation(report);
  assert.match(rendered, /there is no rate card to show/);
  assert.doesNotMatch(rendered, /x\s+\$\d/, 'a recorded report must not show a multiplication');
});

test('an unrecorded model in a recorded report is named, not dropped', () => {
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
  // Inject a model with no recorded cost, which is what a partial runtime record looks like.
  const tampered = {
    ...report,
    total: {
      ...report.total,
      models: {
        ...report.total.models,
        'cline|unpriced': { provider: 'cline', model: 'unpriced', cost: null, calls: 2, pricedCalls: 0, unpricedCalls: 2, inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 0 },
      },
    },
  };
  const explanation = explainCost(tampered);
  assert.ok(explanation.unpriced.some((entry) => entry.modelId === 'cline|unpriced'), 'an unpriced model must be named');
  assert.match(renderExplanation(tampered), /NOT PRICED/);
});

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}
