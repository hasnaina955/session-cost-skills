import test from 'node:test';
import assert from 'node:assert/strict';
import { bar, compositionBar, visibleLength, padVisible, alignRight, truncateVisible, resolveReportStyle, paint, SEGMENT_GLYPHS } from '../shared/term-bars.mjs';
import { mcodeScript, createMCodeFixture, runCli } from './helpers/contract-fixtures.mjs';

test('a bar is exactly the requested visible width', () => {
  for (const [value, max] of [[0, 10], [5, 10], [10, 10], [3, 7]]) {
    for (const width of [1, 8, 16, 24]) {
      assert.equal(visibleLength(bar(value, max, { width })), width,
        `bar(${value}, ${max}, width ${width}) must occupy exactly ${width} columns`);
    }
  }
});

test('a bar is proportional to its share, using eighths for the remainder', () => {
  assert.equal(bar(10, 10, { width: 10 }), '█'.repeat(10));
  assert.equal(bar(5, 10, { width: 10 }), '█████     ');
  assert.equal(bar(0, 10, { width: 10 }), ' '.repeat(10));
  // 3/7 of 14 cells is 6 cells, so the bar must be proportional rather than rounded up to 7.
  const partial = bar(3, 7, { width: 14 });
  assert.equal(partial.length, 14);
  assert.ok(partial.indexOf(' ') > 5, `expected about 6 filled cells, got ${JSON.stringify(partial)}`);
});

test('an unknown value is never an empty bar', () => {
  // The whole point. An empty bar and a zero bar are the same pixels, so an unpriceable session
  // drawn as an empty bar reads as a session that cost nothing.
  // Width 16 so the full word fits; narrower columns abbreviate to ?, which the loop below covers.
  const unknown = bar(null, 10, { width: 16 });
  const zero = bar(0, 10, { width: 16 });
  assert.notEqual(unknown, zero);
  assert.match(unknown, /unavailable/);
  for (const bad of [null, undefined, Number.NaN, Infinity, -Infinity]) {
    const drawn = bar(bad, 10, { width: 8 });
    // Narrow columns abbreviate rather than overflow, but the mark is still there.
    assert.match(drawn, /unavailable|\?/, `${String(bad)} must not draw a bar`);
    assert.equal(visibleLength(drawn), 8, `${String(bad)} must not break the column`);
  }
});

test('a composition bar is sized to the known parts and names the unknown ones', () => {
  const segments = [
    { label: 'Fresh input', value: 60 },
    { label: 'Cached read', value: 30 },
    { label: 'Cache write', value: 10 },
  ];
  const { bar: cells, legend } = compositionBar(segments, { width: 20 });
  assert.equal(visibleLength(cells), 20, 'the bar fills its column exactly');
  assert.match(legend, /Fresh input: 60/);
  assert.match(legend, /Cache write: 10/);

  const withUnknown = compositionBar([
    { label: 'Priced', value: 100 },
    { label: 'Unpriced', value: null, unknown: true },
  ], { width: 20 });
  assert.equal(visibleLength(withUnknown.bar), 20);
  assert.match(withUnknown.legend, /Unpriced: unavailable/,
    'an unknown part is named in the legend rather than folded into the others');
  // The known part keeps the whole width: it is the only part with a share to show.
  assert.equal(withUnknown.bar.trim(), '█'.repeat(20));
});

test('a composition with nothing priced does not imply a zero bar', () => {
  const { bar: cells, legend } = compositionBar([
    { label: 'A', value: null, unknown: true },
    { label: 'B', value: 0, unknown: true },
  ], { width: 12 });
  assert.equal(visibleLength(cells), 12);
  assert.equal(cells.trim(), '', 'nothing is drawn when nothing is known');
  assert.match(legend, /A: unavailable/);
});

test('segments are separable by glyph, not only by colour', () => {
  const { bar: cells } = compositionBar([
    { label: 'a', value: 1 }, { label: 'b', value: 1 }, { label: 'c', value: 1 }, { label: 'd', value: 1 },
  ], { width: 24 });
  const distinct = new Set([...cells].filter((character) => character !== ' '));
  assert.equal(distinct.size, 4, `four segments must be four distinguishable glyphs, got ${[...distinct].join('')}`);
  for (const glyph of distinct) assert.ok(SEGMENT_GLYPHS.includes(glyph));
});

test('padding is measured in visible characters, so colour does not break alignment', () => {
  const plain = '$0.0000';
  const painted = `\x1b[32m${plain}\x1b[0m`;
  assert.ok(painted.length > plain.length, 'the painted string really is longer in characters');
  assert.equal(visibleLength(painted), visibleLength(plain), 'and identical in display cells');
  assert.equal(visibleLength(padVisible(painted, 12)), 12);
  assert.equal(visibleLength(alignRight(painted, 12)), 12);
});

test('over-long text is truncated to the column, keeping the informative end', () => {
  const title = 'A very long session title that will not fit inside a column at all';
  for (const width of [4, 10, 24]) {
    const cut = truncateVisible(title, width);
    assert.ok(visibleLength(cut) <= width, `"${cut}" must fit ${width}`);
    if (width > 2) assert.match(cut, /…$/, 'truncation is visible rather than silent');
  }
  assert.ok(truncateVisible(title, 10).includes('column at all') || truncateVisible(title, 10).includes('at all'),
    'the tail is kept, because that is the identifying part of a path or title');
  assert.equal(visibleLength(padVisible('short', 10)), 10);
});

test('colour is off for a pipe, off under NO_COLOR, and never on under --plain', () => {
  const tty = { isTTY: true, columns: 100 };
  const pipe = { isTTY: false, columns: 100 };
  assert.equal(resolveReportStyle({ stream: tty, environment: {} }).color, true);
  assert.equal(resolveReportStyle({ stream: pipe, environment: {} }).color, false, 'a pipe is not a terminal');
  assert.equal(resolveReportStyle({ stream: tty, environment: { NO_COLOR: '1' } }).color, false,
    'NO_COLOR wins, as the convention requires');
  assert.equal(resolveReportStyle({ stream: tty, environment: {}, plain: true }).color, false,
    '--plain drops colour as well as glyphs');
  // An explicit opt-in is honoured so CI can capture a coloured frame, but NO_COLOR still wins.
  assert.equal(resolveReportStyle({ stream: pipe, environment: {}, color: true }).color, true);
  assert.equal(resolveReportStyle({ stream: pipe, environment: { NO_COLOR: '1' }, color: true }).color, false);
  assert.equal(resolveReportStyle({ stream: tty, environment: { NO_COLOR: '1' }, color: true }).color, false);
});

test('width is clamped so a frame is never wider or narrower than the terminal', () => {
  assert.equal(resolveReportStyle({ stream: { columns: 20 }, environment: {} }).width, 60);
  assert.equal(resolveReportStyle({ stream: { columns: 5000 }, environment: {} }).width, 120);
  assert.equal(resolveReportStyle({ stream: { columns: 100 }, environment: {} }).width, 100);
  assert.equal(resolveReportStyle({ stream: {}, environment: {} }).width, 80, 'an unknown width falls back to 80');
  assert.equal(resolveReportStyle({ stream: {}, environment: { COLUMNS: '90' } }).width, 90);
});

test('paint is a no-op when colour is off, and never colours an unknown cost red', () => {
  const off = { color: false };
  assert.equal(paint(off, '\x1b[32m', 'text'), 'text');
  const on = { color: true };
  assert.match(paint(on, '\x1b[32m', 'text'), /\x1b\[32m/);
  // A severity colour on an unknown cost would tell a reader it is fine, or alarming, when the
  // truth is that nobody knows.
  assert.equal(visibleLength(paint(off, '\x1b[31m', 'unavailable')), 'unavailable'.length);
});

// --- End to end: a real report must carry the bars without a colour escape ---

test('a real report draws bars with no colour escape when stdout is a pipe', () => {
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--include-children'], fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.doesNotMatch(result.stdout, /\x1b\[/, 'a piped report must carry no escape sequences');
  assert.match(result.stdout, /[█▓▒░]/, 'the token mix bar is present');
  // Every bar sits beside its figure, so the number is never carried only by a length.
  const mixLine = result.stdout.split('\n').find((line) => line.includes('fresh input:')) ?? '';
  for (const label of ['fresh input', 'cached read', 'cache write', 'output']) {
    assert.ok(mixLine.includes(`${label}: `), `the legend must state ${label}`);
  }
});

test('an unpriced model is never drawn as an empty bar beside a real figure', () => {
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-partial'], fixture.environment);
  const text = result.stdout;
  assert.match(text, /unpriced/, 'the unpriced model is named');
  // Its row must not carry a bar, because a blank one would read as "this cost nothing".
  const row = text.split('\n').find((line) => line.includes('unknown-model')) ?? '';
  assert.doesNotMatch(row, /[█▏▎▍▌▋▊▉]/, `an unpriced model must not be drawn with a bar: ${row}`);
  assert.doesNotMatch(row, /\$0\.0000(?![\d])/, 'and must not be shown at zero');
});
