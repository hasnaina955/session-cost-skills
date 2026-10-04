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

test('the headline figures are in the server-rendered HTML, not only in the script', () => {
  // The redesign dropped the four KPI tiles that used to be rendered into the page and left only
  // the container the script fills. With JavaScript disabled - which is the case the
  // server-rendered charts exist for - the page then had no totals at all. No test noticed,
  // because every assertion was about the charts. This one asserts the numbers themselves.
  const { status, html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root', '--include-children']);
  assert.equal(status, 0);
  // Strip the script, so only what the server produced is inspected.
  const serverRendered = html.replace(/<script>[\s\S]*?<\/script>/g, '');
  for (const label of ['Total tokens', 'Cache-hit rate']) {
    assert.ok(serverRendered.includes(label), `"${label}" must be in the server-rendered HTML`);
  }
  // And they carry real figures, not placeholders: the tile for tokens shows a number.
  const tokensTile = /Total tokens<\/div><div class="value">([^<]+)</.exec(serverRendered);
  assert.ok(tokensTile, 'the total-tokens tile must have a value element');
  assert.match(tokensTile[1], /[0-9]/, 'the tile must carry a figure, not an empty value');
  // The container the script fills is the same element, so a JS reader gets filter-aware tiles
  // and a no-JS reader still gets the session totals.
  assert.match(serverRendered, /<section class="kpis" id="cards">[\s\S]*?<\/section>/, 'the KPI container must hold the server-rendered tiles');
});

test('the headline KPI row leads with the cost domain the report actually carries', () => {
  // The row was hardcoded to the Cline account domains, so on MCode two of the four tiles
  // could only ever read "-" and the estimated cost - the one number the tool exists to
  // report - appeared nowhere server-side. Found by rendering the dashboard and reading it,
  // the only way this class of bug has ever been found here.
  const tile = (serverRendered, label) => {
    const match = new RegExp(`<div class="kpi"><div class="label">${label}</div><div class="value">([^<]+)</div></div>`).exec(serverRendered);
    return match ? match[1] : null;
  };

  // MCode's only cost figure is the estimate, and it must be the headline.
  const mcode = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root', '--include-children']);
  assert.equal(mcode.status, 0);
  const mcodeServer = mcode.html.replace(/<script>[\s\S]*?<\/script>/g, '');
  const estimated = tile(mcodeServer, 'Estimated cost');
  assert.ok(estimated, 'an MCode dashboard must carry an Estimated cost tile server-side');
  assert.match(estimated, /^\$[0-9]/, 'the tile must carry the priced figure, not a dash');
  assert.equal(tile(mcodeServer, 'Recorded / reference cost'), null, 'a foreign domain renders no tile');
  assert.equal(tile(mcodeServer, 'Credits used'), null, 'a domain with no figure renders no tile');

  // Cline's cost domain is the recorded figure; the estimate tile must not appear.
  const cline = dashboardFor(createClineFixture(), clineScript, ['--session', 'cline-root']);
  assert.equal(cline.status, 0);
  const clineServer = cline.html.replace(/<script>[\s\S]*?<\/script>/g, '');
  const recorded = tile(clineServer, 'Recorded / reference cost');
  assert.ok(recorded, 'a Cline dashboard must carry its recorded-cost tile server-side');
  assert.match(recorded, /^\$[0-9]/, 'the tile must carry the recorded figure, not a dash');
  assert.equal(tile(clineServer, 'Estimated cost'), null, 'a foreign domain renders no tile');

  // An unknown estimated cost is an em dash in its own tile, never $0.000000 and never a
  // missing headline (accounting rule 1).
  const unpriced = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-unpriced']);
  assert.equal(unpriced.status, 2, 'an unpriceable session exits 2 but must still render');
  const unpricedServer = unpriced.html.replace(/<script>[\s\S]*?<\/script>/g, '');
  assert.equal(tile(unpricedServer, 'Estimated cost'), '—', 'an unknown cost is a dash, not a zero and not a missing tile');
});

/**
 * The payload the browser runtime reads: `const P=<json>;` at the head of the inline script.
 *
 * The two filter tables are built by that runtime, not by the server, so the file on disk never
 * contains the strings a reader finally sees. Asserting on `strip(html)` therefore cannot see a
 * mis-rendered cost cell at all - which is how an unpriced session came to render `$0.000000` in
 * front of a reader while the test that claims to cover exactly that case stayed green.
 */
function clientPayload(html) {
  const start = html.indexOf('const P=');
  assert.ok(start >= 0, 'the inline script must start with the payload assignment');
  const from = start + 'const P='.length;
  // The literal runs to the end of the line; the runtime is one statement per line.
  const end = html.indexOf(';', from);
  return JSON.parse(html.slice(from, end));
}

test('an unpriced session cannot reach the client as a finite zero', () => {
  // The witness is the payload, not the rendered text. The report's own verdict is that the cost
  // is unavailable, and a finite `0` in that position is what a reader takes as "this was free".
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-unpriced']);
  const sessions = clientPayload(html).sessions;
  assert.equal(sessions.length, 1);

  const [session] = sessions;
  assert.equal(session.costKnown, false, 'the session must carry the unknown verdict from the report');
  assert.equal(session.cost, null, 'no zero may reach the client as a cost');
  assert.equal(session.metrics.costKnown, false);
  assert.equal(session.metrics.totalCost, null, 'a finite 0 here is the silent-zero failure');
  // The raw number is still in the report, because hiding it would be its own kind of lie.
  assert.equal(typeof session.metrics.calls, 'number');
});

test('a priced session keeps its real figure through the same path', () => {
  // The positive control for the test above: a guard that blanks every cost would pass it too.
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-root', '--include-children']);
  const [session] = clientPayload(html).sessions;
  assert.equal(session.costKnown, true, 'a priced session must not be marked unknown');
  assert.equal(typeof session.cost, 'number');
  assert.ok(session.cost > 0, 'a priced session carries a positive figure');
  assert.ok(session.metrics.totalCost > 0);
});

test('a partly priced session reports its lower bound rather than dropping it', () => {
  // `partial` is a real figure: a lower bound. It can prove a budget was blown, so it is shown.
  // Only `unavailable` means nobody could price the work, and only that blanks the cell.
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-partial']);
  const [session] = clientPayload(html).sessions;
  assert.equal(session.costKnown, true, 'a partial total is disclosed, not discarded');
  assert.equal(typeof session.metrics.totalCost, 'number');
});

test('the file on disk cannot contain a zero cost for the unpriced session', () => {
  // Kept, and now understood for what it is: a guard on the server-rendered half only. It passes
  // even on a build that renders $0.000000 to the reader, which is why the payload assertions
  // above exist alongside it rather than instead of it.
  const { html } = dashboardFor(createMCodeFixture(), mcodeScript, ['--session', 'mcode-unpriced']);
  assert.doesNotMatch(html, /\$0\.000000/, 'no formatted zero belongs in the file either');
});
