import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { renderDashboard } from '../shared/dashboard.mjs';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

function payloadOf(html) {
  const match = html.match(/const P=(\{.*?\});\n/s);
  assert.ok(match, 'the dashboard must embed its payload');
  return JSON.parse(match[1]);
}

test('a date range of Cline sessions populates every dashboard row', () => {
  const fixture = createClineFixture();
  const list = runJson(clineScript, fixture.dataDir, ['--list', '5', '--json']).output;
  const payload = payloadOf(renderDashboard(list, { title: 'range' }));
  assert.ok(payload.sessions.length > 1, 'a list must contain several sessions');
  for (const session of payload.sessions) {
    assert.ok(session.id, 'every row needs a session id');
    // A genuinely empty session renders 0, which is correct; a missing value would
    // render as undefined, which is not. Assert the field is populated, not that it is big.
    assert.equal(typeof session.metrics.totalTokens, 'number', `${session.id} rendered without a token count`);
    assert.equal(typeof session.metrics.calls, 'number', `${session.id} rendered without a call count`);
    assert.ok(session.metrics.totalCost === null || typeof session.metrics.totalCost === 'number',
      `${session.id} rendered with a non-numeric cost`);
  }
  // The rows must carry different values, not one row's numbers repeated.
  const costs = new Set(payload.sessions.map((session) => session.metrics.totalCost));
  assert.ok(costs.size > 1, 'each session must report its own cost');
  assert.ok(payload.sessions.some((session) => session.metrics.totalTokens > 0), 'at least one session must show tokens');
});

test('both adapters feed the same dashboard shape despite different vocabularies', () => {
  // Cline reports total.cost and splits tokens; MCode reports total.totalCost and
  // total.totalTokens. The table reads one shape, so the renderer normalizes first.
  const cline = createClineFixture();
  const clinePayload = payloadOf(renderDashboard(
    runJson(clineScript, cline.dataDir, ['--list', '5', '--json']).output, { title: 't' },
  ));
  const mcode = createMCodeFixture();
  const mcodePayload = payloadOf(renderDashboard(
    runJson(mcodeScript, mcode.dataDir, ['--list', '5', '--json'], mcode.environment).output, { title: 't' },
  ));
  for (const payload of [clinePayload, mcodePayload]) {
    for (const session of payload.sessions) {
      assert.ok(session.id, 'a session needs an id');
      assert.equal(typeof session.metrics.totalTokens, 'number', `${session.id} has no token count`);
      assert.equal(typeof session.metrics.calls, 'number', `${session.id} has no call count`);
      assert.equal(typeof session.metrics.totalCost, 'number', `${session.id} has no cost`);
    }
    assert.ok(payload.sessions.some((s) => s.metrics.totalTokens > 0), 'rows must be populated, not all zero');
  }
});

test('a single-session report still renders its tree, unchanged in meaning', () => {
  const fixture = createClineFixture();
  const report = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
  const payload = payloadOf(renderDashboard(report, { title: 't' }));
  assert.equal(payload.sessions.length, 3, 'the subagent tree must still be present');
  const root = payload.sessions.find((session) => session.id === 'cline-root');
  // The root row is the root's own cost; the tree total is larger because it includes
  // the subagents, which are listed as their own rows.
  const treeTotal = payload.sessions.reduce((sum, s) => sum + (s.metrics.totalCost ?? 0), 0);
  assert.ok(root.metrics.totalCost < report.billing.amountUsd, 'the root row must not absorb its subagents');
  assert.ok(Math.abs(treeTotal - report.billing.amountUsd) < 1e-9, 'the rows must add up to the reported tree total');
});

test('an unmeasurable session cost stays null rather than becoming $0.00', () => {
  const fixture = createClineFixture();
  const list = runJson(clineScript, fixture.dataDir, ['--list', '5', '--json']).output;
  list.sessions[0].total = { ...list.sessions[0].total, cost: null, totalCost: null };
  const payload = payloadOf(renderDashboard(list, { title: 't' }));
  const unpriced = payload.sessions.find((session) => session.id === list.sessions[0].session.id);
  assert.equal(unpriced.metrics.totalCost, null, 'an unknown cost must not render as zero');
});

test('a multi-session dashboard keeps the XSS and offline guarantees', () => {
  const fixture = createClineFixture();
  const list = runJson(clineScript, fixture.dataDir, ['--list', '5', '--json']).output;
  list.sessions[0].session.title = '<img src=x onerror=alert(1)>';
  list.sessions[1].session.title = '"><script>alert(1)</script>';
  const html = renderDashboard(list, { title: 'range' });

  assert.doesNotMatch(html, /<img src=x/, 'a malicious title must not become markup');
  assert.doesNotMatch(html, /<script>alert/, 'a malicious title must not introduce a script');
  assert.match(html, /&lt;img/, 'the value must still be shown, escaped');
  assert.doesNotMatch(html, /(?:src|href)=["']https?:/i, 'the dashboard must stay self-contained');
  assert.match(html, /script-src/, 'the content security policy must remain');
  // The CSP hash must cover the actual runtime, or the policy is decorative.
  const csp = (html.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '').replace(/&#39;/g, "'");
  assert.ok(csp, 'the dashboard must carry a content security policy');
  assert.match(csp, /default-src 'none'/, 'the CSP must default to none');
  // Prove the hash is not decorative: recompute it from the embedded script.
  const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];
  assert.ok(script, 'the dashboard must embed its runtime');
  const digest = createHash('sha256').update(script).digest('base64');
  assert.ok(csp.includes(`script-src 'sha256-${digest}'`), 'the CSP hash must cover the script actually embedded');
});

test('an empty range renders without inventing a total', () => {
  const html = renderDashboard({ sessions: [], total: { cost: null } }, { title: 'empty' });
  const payload = payloadOf(html);
  assert.deepEqual(payload.sessions, []);
  assert.match(html, /<html/i);
});
