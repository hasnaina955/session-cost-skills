import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import { createLiveSurface, nextInterval, renderLiveFrame } from '../shared/live-view.mjs';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const realCline = () => createClineFixture()
  && runJson(clineScript, createClineFixture().dataDir, ['--session', 'cline-root', '--include-children', '--json']).output;
const realReports = () => {
  const cline = createClineFixture();
  const mcode = createMCodeFixture();
  return {
    cline: runJson(clineScript, cline.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output,
    mcode: runJson(mcodeScript, mcode.dataDir, ['--session', 'mcode-root', '--include-children', '--json'], mcode.environment).output,
  };
};

test('every adapter ships the same live-view implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/live-view.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode', 'opencode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/live-view.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('a REAL report from each adapter renders its identity, not blanks', () => {
  // The regression this file exists for: renderLiveFrame read one report vocabulary, so
  // every field came out blank on MCode. Fixtures built by hand would not have caught it.
  for (const [runtime, report, expectedId] of Object.entries(realReports())) {
    const frame = renderLiveFrame(report, {});
    assert.match(frame, new RegExp(expectedId), `${runtime}: the session id must appear`);
    assert.doesNotMatch(frame, /unknown ·/, `${runtime}: the session must not render as unknown`);
    assert.match(frame, /TOTAL COST/, `${runtime}: the headline must be present`);
    assert.doesNotMatch(frame, /unavailable\s+\S+\s+\S+\s+\S+\s+\S+\s+no baseline/, `${runtime}: token rows must be populated`);
  }
});

test('a REAL report renders its real cost, not a placeholder', () => {
  for (const [runtime, report] of Object.entries(realReports())) {
    const frame = renderLiveFrame(report, {});
    const cost = report.billing?.amountUsd;
    assert.equal(typeof cost, 'number', `${runtime}: the report must carry a measurable cost`);
    assert.ok(frame.includes(`$${cost.toFixed(4)}`), `${runtime}: the frame must show the report's own cost`);
  }
});

test('the frame distinguishes a recorded cost from an estimate', () => {
  const { cline, mcode } = realReports();
  assert.doesNotMatch(renderLiveFrame(cline, {}), /TOTAL COST \(estimate\)/, 'Cline cost is recorded, not estimated');
  assert.match(renderLiveFrame(mcode, {}), /TOTAL COST \(estimate\)/, 'MCode cost is a rate estimate');
});

test('a null or empty report renders a stale frame instead of throwing', () => {
  // The watch loop must survive a failed read, and a missing report is that case.
  for (const value of [null, undefined, {}, { usage: {}, billing: {} }]) {
    const frame = renderLiveFrame(value, { stale: true, staleReason: 'ledger locked' });
    assert.match(frame, /STALE/, 'a stale frame must be marked as such');
    assert.match(frame, /ledger locked/, 'the reason must be shown');
    assert.match(frame, /session-cost · live/, 'the frame must still render its frame');
  }
});

test('the growth marker only appears once there is a previous value', () => {
  const { mcode } = realReports();
  assert.doesNotMatch(renderLiveFrame(mcode, {}), /\+\d/, 'a first reading has nothing to compare to');
  const later = renderLiveFrame(mcode, { previous: 0.0001 });
  assert.match(later, /TOTAL COST[^\n]*\+\d/, 'a later reading shows the change on the cost line');
});

test('polling is fast while the session moves and backs off when idle', () => {
  assert.equal(nextInterval({ snapshot: { active: true } }, { activeMs: 500, idleMs: 3000 }), 500);
  assert.equal(nextInterval({ snapshot: { active: false } }, { activeMs: 500, idleMs: 3000 }), 3000);
  assert.equal(nextInterval(null, { activeMs: 500, idleMs: 3000 }), 3000, 'an unknown state must not spin');
});

function fakeStream(isTTY) {
  const stream = new EventEmitter();
  stream.isTTY = isTTY;
  stream.written = '';
  stream.write = (chunk) => { stream.written += chunk; return true; };
  return stream;
}

test('a TTY repaints in place and never appends frames', () => {
  const stream = fakeStream(true);
  const surface = createLiveSurface(stream, { registerSignalHandlers: false });
  surface.draw('frame one');
  surface.draw('frame two');
  assert.equal(stream.written.match(/\x1b\[\?1049h/g).length, 1, 'the alternate screen is entered once');
  assert.equal(stream.written.match(/\x1b\[H\x1b\[2J/g).length, 2, 'each frame clears and repaints');
  assert.equal(stream.written.match(/frame one/g).length, 1);
  assert.ok(!stream.written.includes('frame one\nframe two'), 'frames must replace, not stack');
  surface.leave();
  assert.match(stream.written, /\x1b\[\?1049l/, 'leaving must restore the screen');
  assert.match(stream.written, /\x1b\[\?25h/, 'the cursor must be restored');
});

test('piped output appends frames and emits no escape codes', () => {
  const stream = fakeStream(false);
  const surface = createLiveSurface(stream, { registerSignalHandlers: false });
  surface.draw('frame one');
  surface.draw('frame two');
  assert.doesNotMatch(stream.written, /\x1b\[/, 'a non-TTY caller gets text, not escape codes');
  assert.equal(stream.written, 'frame one\nframe two\n', 'frames are appended as a readable transcript');
  assert.doesNotThrow(() => surface.leave());
});

test('leaving twice is harmless', () => {
  const stream = fakeStream(true);
  const surface = createLiveSurface(stream, { registerSignalHandlers: false });
  surface.draw('x');
  surface.leave();
  const after = stream.written.length;
  surface.leave();
  assert.equal(stream.written.length, after, 'a second leave must not write again');
});

test('a ledger-supplied string cannot inject terminal control sequences', () => {
  // The terminal twin of the stored-DOM-XSS the dashboard guards against. A session title
  // carrying ANSI escapes could clear the screen and repaint a forged report, or rewrite
  // the window title. Found by putting a hostile title in a real report.
  const { cline } = realReports();
  cline.session.title = 'evil\x1b[2J\x1b[H\x1b]0;pwned\x07END';
  cline.session.id = 'sess\x1b[31m';
  const frame = renderLiveFrame(cline, {});
  const body = frame.split('\n').slice(0, 4).join('\n');
  assert.doesNotMatch(body, /\x1b/, 'no escape character may reach the terminal');
  assert.doesNotMatch(body, /\x07/, 'no bell may reach the terminal');
  assert.match(frame, /evilEND/, 'the readable part of the title is still shown');
});

test('an unpriceable session reads "unavailable", never $0.0000', () => {
  // Non-negotiable accounting rule 1: unknown cost is `null`, never `0`. Both adapters keep a
  // legacy `totalCost` aggregate that is 0 — not null — when nothing could be priced, so
  // falling back to it printed "$0.0000" for a session whose cost is genuinely unknown. A
  // reader takes that as "the session was free", which is the one conclusion the tool must
  // never let them draw. Found by pointing --watch at a live MCode session on a model that
  // has no mirrored rate, where the text report correctly said COST UNAVAILABLE.
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-unpriced', '--json'], fixture.environment).output;

  // Guard the premise: this fixture really is the unpriceable shape, not a priced one.
  assert.equal(report.totalCost, 0, 'the legacy aggregate really is 0 here, which is the trap');
  assert.equal(report.billing.amountUsd, null, 'the authoritative cost really is unknown');
  assert.equal(report.billing.rateKnown, false);

  const frame = renderLiveFrame(report, {});
  const headline = frame.split('\n').find((line) => line.includes('TOTAL COST'));
  assert.match(headline, /unavailable/, 'an unknown cost must read as unavailable');
  assert.doesNotMatch(frame, /\$0\.0000/, 'no field may present an unknown cost as $0.0000');
});

test('a priced session still shows its real cost', () => {
  // The null-cost fix must not swallow a genuine figure.
  const { cline } = realReports();
  const frame = renderLiveFrame(cline, {});
  const cost = cline.billing?.amountUsd;
  assert.equal(typeof cost, 'number');
  assert.ok(frame.includes(`$${cost.toFixed(4)}`), 'a priced report keeps its real cost');
});

// A session title is the user's own text and is displayed as-is, exactly as the HTML
// dashboard displays it. Scrubbing credential-shaped strings out of a title would mangle
// legitimate content and is not a property the tool can honestly promise. What it must
// promise is that a title cannot control the terminal, which is asserted above.
