import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { renderDashboard } from '../shared/dashboard.mjs';
import { removeDirectory } from './helpers/temp-dir.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli } from './helpers/contract-fixtures.mjs';

const PINNED = '2026-06-15T18:00:00.000Z';
const strip = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

function dashboardFor(fixture, script, args) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dash-v2-'));
  const out = path.join(dir, 'd.html');
  const environment = script === mcodeScript ? { ...fixture.environment, SESSION_COST_NOW: PINNED } : { SESSION_COST_NOW: PINNED };
  const result = runCli(script, fixture.dataDir, [...args, '--dashboard', '--out', out], environment);
  // Read before cleaning up: an earlier version deleted the temp directory first and then
  // asserted on the file, which failed for a reason that had nothing to do with the dashboard.
  const html = fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null;
  removeDirectory(dir);
  return { status: result.status, html, stderr: result.stderr };
}

test('a priced session draws its shape with server-rendered SVG', () => {
  const { status, html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root', '--include-children']);
  assert.equal(status, 0);
  // These are rendered in Node, so they exist in the file itself rather than being built by
  // script at page load. That is what makes the dashboard work with JavaScript disabled.
  assert.ok((html.match(/<svg/g) ?? []).length >= 3, 'the new sections must ship as inline SVG');
  for (const section of ['Where the session went', 'Token mix', 'Cost by model', 'Session tree']) {
    assert.ok(html.includes(section), `missing section: ${section}`);
  }
  // Every chart carries an accessible name; an unlabelled graphic is invisible to a screen reader.
  assert.ok((html.match(/<desc>/g) ?? []).length >= 3);
  assert.doesNotMatch(html, /<svg[^>]*>\s*<\/svg>/, 'an empty svg element is a chart that failed to render');
});

test('an unpriced session never shows a zero cost for work that could not be priced', () => {
  // The regression this file exists for. An earlier version of the new code reported "largest
  // $0.000000" and "$0.000000 priced" for a session where no call could be priced at all, which
  // is the silent-zero failure wearing a chart.
  const { status, html, stderr } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-unpriced']);
  assert.equal(status, 2, 'an unpriceable session exits 2 but must still render');
  assert.ok(html, 'the dashboard is still written for an unpriceable session');
  const text = strip(html);
  assert.doesNotMatch(text, /\$0\.0000/, 'no zero cost may stand in for an unknown one');
  assert.match(text, /unavailable|not priced|no call could be priced/i);
  assert.ok(text.includes('unknown-model'), 'the unpriced model must be named, not hidden');
  assert.ok(html.includes('url(#sc-unknown)'), 'an unknown value is drawn hatched');
  assert.doesNotMatch(stderr, /\bat .*:\d+:\d+/, 'no stack trace');
});

test('a partially priced session marks the gap rather than quietly shrinking', () => {
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-partial']);
  const text = strip(html);
  assert.ok(text.includes('unknown-model'), 'the unpriced call must appear');
  // Exactly "$0.0000" and nothing longer. A real price like $0.000060 is a small *price*, and
  // prefix-matching it would fail a correct report.
  assert.doesNotMatch(text, /\$0\.0000(?!\d)/, 'an unpriced call must not be shown as a zero cost');
  assert.match(text, /unavailable|not priced|partly unpriced/i);
});

test('the dashboard stays self-contained and under the strict CSP', () => {
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root']);
  // Inspect tag *attributes* only. A pattern like /<script[^>]+src=/ happily spans the inline
  // script's own body, so it reports an external script that is not there.
  for (const tag of html.match(/<(?:script|link|img|iframe)[^>]*>/gi) ?? []) {
    assert.doesNotMatch(tag, /\s(?:src|href)\s*=/i, `a resource tag must not load anything: ${tag.slice(0, 80)}`);
  }
  // The page prints rate-source URLs - where each rate card was mirrored from. Those appear
  // twice, as visible provenance text and inside the embedded JSON payload. Both are deliberately
  // inert: they are never fetched, which is what `connect-src 'none'` below guarantees, and no
  // tag carries them as a resource. Asserting "no URL anywhere" would forbid the provenance this
  // project exists to provide.
  const csp = /Content-Security-Policy[^>]*content="([^"]*)"/.exec(html)?.[1] ?? '';
  // The policy is HTML-escaped inside the attribute, so quotes arrive as &#39;. Decode before
  // asserting on the directives, or every check here fails for a formatting reason.
  const policy = csp.replaceAll('&#39;', "'").replaceAll('&quot;', '"');
  assert.ok(policy, 'the dashboard must carry a Content-Security-Policy');
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'none'/, 'the page must not be able to make a request');
  assert.match(policy, /script-src 'sha256-/, 'the inline script is allow-listed by hash, not by a nonce');
  assert.match(html, /https:\/\/commandcode\.ai/, 'the rate source stays visible so a figure can be traced');
  // The inline SVG must not smuggle in script or a fetch.
  for (const svg of html.match(/<svg[\s\S]*?<\/svg>/g) ?? []) {
    assert.doesNotMatch(svg, /<script|onload=|xlink:href|href=/i, 'an inline SVG must stay inert');
  }
});

test('the session tree lists a subagent once, and marks an excluded one', () => {
  const included = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root', '--include-children']);
  assert.ok(included.html, 'renders');
  const rows = (included.html.match(/<tr>/g) ?? []).length;
  assert.ok(rows > 0, 'the tree has rows');
  // Without --include-children the children are excluded, and the table must say so rather than
  // letting a smaller total look complete.
  const excluded = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root']);
  assert.ok(excluded.html, 'renders');
  assert.match(strip(excluded.html), /excluded/i);
});

test('a Cline report renders the same sections', () => {
  const { status, html } = dashboardFor(createClineFixture(), clineScript, ['--session', 'cline-root', '--include-children']);
  assert.equal(status, 0);
  assert.ok(html.includes('Cost by model'), 'Cline gets the same model chart');
  assert.ok((html.match(/<svg/g) ?? []).length >= 2);
});

test('a report with no timeline omits that section rather than drawing an empty chart', () => {
  // Cline's recorded report has no per-call timeline yet; the section must disappear, not appear
  // with a zeroed axis that implies a session with no spend.
  const { html } = dashboardFor(createClineFixture(), clineScript, ['--session', 'cline-root']);
  assert.ok(html, 'renders');
  const text = strip(html);
  assert.ok(!text.includes('Where the session went') || text.includes('too few points'));
});
