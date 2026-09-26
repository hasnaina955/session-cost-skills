import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import {
  activityGlyph,
  createLiveSurface,
  nextInterval,
  renderLiveFrame,
  resolveStyle,
  severityFor,
  sparkline,
} from '../shared/live-view.mjs';
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

// Used with `.test()`, so deliberately NOT global: a global regex carries `lastIndex` between
// calls and would make a second `.test()` return the wrong answer.
const SGR_PATTERN = /\x1b\[[0-9;]*m/;
// Used with `.replace()`, where every occurrence must go, not just the first.
const stripSgr = (text) => text.replace(/\x1b\[[0-9;]*m/g, '');

test('both adapters ship the same live-view implementation', () => {
  const canonical = fs.readFileSync(new URL('../shared/live-view.mjs', import.meta.url), 'utf8');
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/live-view.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('a REAL report from each adapter renders its identity, not blanks', () => {
  for (const [runtime, report] of Object.entries(realReports())) {
    const frame = renderLiveFrame(report, {});
    assert.match(frame, new RegExp(runtime === 'cline' ? 'cline-root' : 'mcode-root'), `${runtime}: the session id must appear`);
    assert.doesNotMatch(frame, /unknown ·/, `${runtime}: the session must not render as unknown`);
    assert.match(frame, /TOTAL COST/, `${runtime}: the headline must be present`);
  }
});

// ---- the motion policy ------------------------------------------------------------------------
// These are the guarantees the animation exists to keep. They are the first tests to break if
// someone makes the view prettier in a way that costs accuracy.

test('the cost figure never animates: it renders once, exactly, with no interpolation', () => {
  const report = realReports().cline;
  const cost = report.billing?.amountUsd;
  assert.equal(typeof cost, 'number', 'premise: this report has a real cost');
  // A range of histories, frames and widths, all of which must show the identical figure.
  const histories = [null, [1, 2, 3], Array.from({ length: 30 }, (_, i) => i / 7)];
  for (const history of histories) {
    for (const frameIndex of [0, 1, 7, 99]) {
      const frame = renderLiveFrame(report, { history, frameIndex, color: false });
      // Scoped to the headline: the MODELS rows legitimately carry different per-model figures,
      // so only the session total is under the no-interpolation rule.
      const headline = frame.split('\n').find((l) => l.includes('TOTAL COST'));
      assert.ok(headline, 'the headline must be present');
      assert.ok(headline.includes(`$${cost.toFixed(4)}`), 'the exact figure must always be shown');
      // No other money-looking figure on the headline may differ from the real one: an
      // interpolated value between frames would be a number this session never had.
      for (const found of headline.match(/\$0\.\d{4}/g) ?? []) {
        assert.equal(found, `$${cost.toFixed(4)}`, `no interpolated figure may appear, found ${found}`);
      }
    }
  }
});

test('the activity indicator freezes when the ledger has not moved', () => {
  // A spinner that turns on a timer makes a wedged agent look identical to a working one, so the
  // glyph must be a function of real progress and nothing else.
  const idle = { color: false };
  for (let frameIndex = 0; frameIndex < 12; frameIndex += 1) {
    assert.equal(activityGlyph({ frameIndex, progressed: false, style: idle }), '·',
      'an idle frame must render the same glyph at every frame index');
  }
  const frames = new Set();
  for (let frameIndex = 0; frameIndex < 10; frameIndex += 1) {
    frames.add(activityGlyph({ frameIndex, progressed: true, style: idle }));
  }
  assert.equal(frames.size, 10, 'a moving session must show movement across frames');
});

test('an unknown cost is never given a severity, and never coloured as a value', () => {
  const unknown = severityFor({ cost: null, burn: null, delta: null, active: true });
  assert.equal(unknown.key, 'unknown');
  assert.equal(unknown.color, null, 'there is nothing to be urgent about when the figure is unknown');
  // And a large burn rate cannot manufacture a severity for a null cost.
  const pressured = severityFor({ cost: null, burn: { usdPerMinute: 99 }, delta: 5, active: true, fastUsdPerMin: 0.01 });
  assert.equal(pressured.key, 'unknown');
});

test('severity only escalates to "fast" or "over budget" on a caller-supplied threshold', () => {
  const hot = { cost: 10, burn: { usdPerMinute: 2.5 }, delta: 1, active: true };
  assert.equal(severityFor(hot).key, 'spending', 'with no threshold, a high burn rate is not a judgement call');
  assert.equal(severityFor({ ...hot, fastUsdPerMin: 1 }).key, 'fast');
  assert.equal(severityFor({ ...hot, budgetUsd: 5 }).key, 'over-budget');
  assert.equal(severityFor({ ...hot, fastUsdPerMin: 10 }).key, 'spending', 'a threshold the session is under must not fire');
});

test('colour is off by default and off entirely without a TTY', () => {
  const original = process.env.NO_COLOR;
  delete process.env.NO_COLOR;
  try {
    // A piped stdout is not a TTY, which is how the suite and any log capture runs.
    assert.equal(resolveStyle({}).color, false, 'no colour without an interactive surface');
    assert.equal(resolveStyle({ color: true }).color, true, 'an explicit opt-in is honoured');
    process.env.NO_COLOR = '1';
    assert.equal(resolveStyle({ color: true }).color, true, 'an explicit opt-in still wins over NO_COLOR');
    delete process.env.NO_COLOR;
    process.env.NO_COLOR = '1';
    assert.equal(resolveStyle({}).color, false, 'NO_COLOR is honoured when colour is not forced');
  } finally {
    if (original === undefined) delete process.env.NO_COLOR;
    else process.env.NO_COLOR = original;
  }
});

test('a frame rendered without colour contains no escape sequences at all', () => {
  for (const [runtime, report] of Object.entries(realReports())) {
    for (const options of [{}, { history: [1, 2, 3, 4], frameIndex: 3, progressed: true }, { width: 100 }]) {
      const frame = renderLiveFrame(report, { color: false, ...options });
      assert.doesNotMatch(frame, SGR_PATTERN, `${runtime}: an uncoloured frame must carry no SGR codes`);
      assert.ok(!frame.includes('\x1b'), `${runtime}: an uncoloured frame must carry no escapes`);
    }
  }
});

test('a coloured frame still renders every box border at one visible width', () => {
  // Colour codes are characters, so padding measured with String.length would leave the border
  // ragged. This is the failure mode colour introduces if the padding maths is not updated.
  const report = realReports().cline;
  for (const width of [56, 74, 100, 120, 400]) {
    const frame = renderLiveFrame(report, { color: true, width, history: [1, 5, 9, 14], frameIndex: 2, progressed: true });
    const borders = frame.split('\n').filter((l) => /^[┌├└]/.test(stripSgr(l)));
    assert.ok(borders.length >= 3, `width ${width}: expected box borders`);
    const widths = new Set(borders.map((b) => stripSgr(b).length));
    assert.equal(widths.size, 1, `width ${width}: every border must be the same visible length, got ${[...widths]}`);
    // And the requested width is honoured, within the documented clamp.
    const expected = Math.max(56, Math.min(width, 120));
    assert.equal([...widths][0], expected, `width ${width}: frame should be ${expected} columns wide`);
  }
});

test('the sparkline shows shape only when there is a trend to show', () => {
  assert.equal(sparkline([1, 2], { style: { color: false } }), '', 'too few points implies no trend');
  const flat = sparkline([5, 5, 5, 5, 5], { style: { color: false } });
  assert.equal(flat.length, 5, 'a flat series still draws, one column per sample');
  assert.equal(new Set(flat).size, 1, 'a flat series must not invent a shape');
  const rising = sparkline([1, 2, 3, 4, 9], { style: { color: false } });
  assert.equal(rising.length, 5);
  assert.ok(new Set(rising).size > 1, 'a rising series must show varying heights');
  assert.equal(sparkline([1, 2, 3, 4, 9], { width: 3, style: { color: false } }).length, 3, 'the window is respected');
  assert.equal(sparkline('not an array', { style: { color: false } }), '', 'a malformed series renders nothing');
});

test('a long quiet gap is called out as possibly wedged, not as running', () => {
  const report = realReports().cline;
  const recent = renderLiveFrame({ ...report, snapshot: { ...report.snapshot, active: true, lastLedgerActivityAt: new Date().toISOString() } }, { color: false });
  const stale = renderLiveFrame({ ...report, snapshot: { ...report.snapshot, active: true, lastLedgerActivityAt: new Date(Date.now() - 600_000).toISOString() } }, { color: false });
  assert.doesNotMatch(recent, /wedged/, 'a session that just wrote is not wedged');
  assert.match(stale, /wedged/, 'ten silent minutes is a different situation and must say so');
});

test('a non-TTY caller gets text, not escape codes', () => {
  const stream = new EventEmitter();
  stream.isTTY = false;
  stream.columns = 80;
  stream.written = '';
  stream.write = (chunk) => { stream.written += chunk; };
  const surface = createLiveSurface(stream, { registerSignalHandlers: false });
  surface.draw('frame one');
  surface.draw('frame two');
  assert.doesNotMatch(stream.written, /\x1b\[/, 'a non-TTY caller gets text, not escape codes');
  assert.equal(stream.written, 'frame one\nframe two\n', 'frames are appended as a readable transcript');
  assert.doesNotThrow(() => surface.leave());
});

test('leaving twice is harmless', () => {
  const stream = new EventEmitter();
  stream.isTTY = true;
  stream.columns = 80;
  stream.written = '';
  stream.write = (chunk) => { stream.written += chunk; };
  const surface = createLiveSurface(stream, { registerSignalHandlers: false });
  surface.draw('x');
  surface.leave();
  const after = stream.written.length;
  surface.leave();
  assert.equal(stream.written.length, after, 'a second leave must not write again');
});

test('a ledger-supplied string cannot inject terminal control sequences', () => {
  // The terminal twin of the stored-DOM-XSS the dashboard guards against. A session title
  // carrying ANSI escapes could clear the screen and repaint a forged report, or rewrite the
  // window title. Now that frames carry colour, the risk is higher, not lower.
  const { cline } = realReports();
  cline.session.title = 'evil\x1b[2J\x1b[H\x1b]0;pwned\x07END';
  cline.session.id = 'sess\x1b[31m';
  for (const options of [{}, { color: true }, { history: [1, 2, 3], frameIndex: 1, progressed: true, color: true }]) {
    const frame = renderLiveFrame(cline, options);
    const body = frame.split('\n').slice(0, 4).join('\n');
    // In a coloured frame SGR codes are legitimate, so the payload is checked with every SGR
    // removed: anything still carrying an escape came from the ledger, not from this module.
    const withoutSgr = stripSgr(body);
    assert.doesNotMatch(withoutSgr, /\x1b/, 'no escape character from the payload may survive');
    assert.doesNotMatch(withoutSgr, /\x07/, 'no bell from the payload may reach the terminal');
    assert.match(frame, /evilEND/, 'the readable part of the title is still shown');
    if (options.color !== true) assert.doesNotMatch(frame, SGR_PATTERN, 'an uncoloured frame has no SGR at all');
  }
});

test('an unpriceable session reads "unavailable", never $0.0000', () => {
  const fixture = createMCodeFixture();
  const report = runJson(mcodeScript, fixture.dataDir, ['--session', 'mcode-unpriced', '--json'], fixture.environment).output;
  assert.equal(report.totalCost, 0, 'premise: the legacy aggregate really is 0 here');
  assert.equal(report.billing.amountUsd, null);
  const frame = renderLiveFrame(report, { color: true, history: [0, 0, 0], frameIndex: 1, progressed: true });
  const headline = frame.split('\n').find((l) => l.includes('TOTAL COST'));
  assert.match(headline, /unavailable/, 'an unknown cost must read as unavailable');
  assert.doesNotMatch(frame, /\$0\.0000/, 'no field may present an unknown cost as $0.0000');
});

test('a priced session still shows its real cost', () => {
  const { cline } = realReports();
  const frame = renderLiveFrame(cline, { color: true });
  const cost = cline.billing?.amountUsd;
  assert.equal(typeof cost, 'number');
  assert.ok(frame.includes(`$${cost.toFixed(4)}`), 'a priced report keeps its real cost');
});

test('the polling interval still backs off when idle', () => {
  assert.equal(nextInterval({ snapshot: { active: true } }, { activeMs: 500, idleMs: 3000 }), 500);
  assert.equal(nextInterval({ snapshot: { active: false } }, { activeMs: 500, idleMs: 3000 }), 3000);
});
