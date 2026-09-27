import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeXml, barChart, stackedBar, sparkline } from '../shared/charts.mjs';

test('every string reaching the SVG is escaped', () => {
  // The dashboard is a file people open and share, so a label carrying markup must not become
  // markup. This is the one place a stored-XSS regression could reappear.
  const hostile = '<script>alert(1)</script>';
  const svg = barChart({ rows: [{ label: hostile, value: 1 }], title: hostile });
  assert.doesNotMatch(svg, /<script>/);
  assert.match(svg, /&lt;script&gt;/);
  for (const fn of [barChart, stackedBar, sparkline]) {
    const out = typeof fn === 'sparkline'
      ? fn({ points: [1, 2, 3], title: hostile })
      : fn({ rows: [{ label: hostile, value: 1 }], segments: [{ label: hostile, value: 1 }], title: hostile });
    assert.doesNotMatch(out, /<script>/, 'a chart must never emit a script element');
  }
  assert.equal(escapeXml(`a&b<c>"d"'e'`), 'a&amp;b&lt;c&gt;&quot;d&quot;&apos;e&apos;');
});

test('an unknown value is drawn hatched and labelled, never as a zero-height bar', () => {
  // A bar of zero height for something we could not price is the silent-zero failure in a new
  // place: the reader sees an empty row and concludes the cost was nothing.
  const svg = barChart({ rows: [{ label: 'priced', value: 10 }, { label: 'unpriced', value: null, unknown: true }] });
  assert.match(svg, /url\(#sc-unknown\)/, 'an unknown row must be hatched');
  assert.match(svg, /unavailable/, 'an unknown row must say so in words');
  assert.doesNotMatch(svg, />0(\.0+)?</, 'an unknown value must not be rendered as the number 0');
});

test('a zero row and an unknown row are visibly different', () => {
  // These are different statements - "priced at zero" and "not priced" - and the chart must not
  // collapse them.
  const zero = barChart({ rows: [{ label: 'free', value: 0 }], format: (v) => String(v) });
  const unknown = barChart({ rows: [{ label: 'free', value: null, unknown: true }] });
  assert.doesNotMatch(zero, /unavailable/);
  assert.match(unknown, /unavailable/);
});

test('a bar is proportional to its share of the largest value', () => {
  const svg = barChart({ rows: [{ label: 'a', value: 10 }, { label: 'b', value: 5 }], width: 400 });
  // Match the bar rectangles specifically (they carry rx="3"); the hatch pattern in <defs> also
  // contains a <rect>, and counting it would compare a legend swatch against a bar.
  const widths = [...svg.matchAll(/<rect[^>]*width="([\d.]+)"[^>]*rx="3"/g)].map((match) => Number(match[1]));
  assert.equal(widths.length, 2);
  assert.ok(Math.abs(widths[0] / widths[1] - 2) < 0.01, `expected a 2:1 ratio, got ${widths[0]}:${widths[1]}`);
});

test('every chart carries a title and a description, so it is not an unlabelled image', () => {
  const charts = [
    barChart({ rows: [{ label: 'a', value: 1 }] }),
    stackedBar({ segments: [{ label: 'a', value: 1 }] }),
    sparkline({ points: [1, 2, 3] }),
  ];
  for (const svg of charts) {
    assert.match(svg, /<title>[^<]+<\/title>/, 'a chart needs a title');
    assert.match(svg, /<desc>[^<]*<\/desc>/, 'a chart needs a description for a screen reader');
    assert.match(svg, /role="img"/);
    assert.match(svg, /aria-label="[^"]+"/);
  }
});

test('empty and all-zero input says so instead of drawing a misleading shape', () => {
  // Only a genuinely empty input is "no data". A single row priced at zero is a real statement -
  // a free model - and must still render, which the zero-versus-unknown test above pins.
  for (const svg of [barChart({ rows: [] }), stackedBar({ segments: [] }), stackedBar({ segments: [{ label: 'a', value: 0 }] })]) {
    assert.match(svg, /no data/, 'an empty chart must say it has no data');
    assert.doesNotMatch(svg, /<polyline/, 'an empty chart must not draw a trend');
  }
  // A zero-height bar for a real zero is honest; the label is what carries the information.
  const zeroRow = barChart({ rows: [{ label: 'free', value: 0 }], format: (v) => String(v) });
  assert.match(zeroRow, />0</, 'a priced zero still shows its figure');
});

test('a sparkline refuses to imply a trend from fewer than three points', () => {
  // Two points are not a direction. A line through them reads as movement that did not happen.
  for (const points of [[], [1], [1, 2]]) {
    assert.match(sparkline({ points }), /too few points|no data/);
    assert.doesNotMatch(sparkline({ points }), /<polyline/);
  }
  assert.match(sparkline({ points: [1, 2, 3] }), /<polyline/);
});

test('a flat series is drawn flat rather than given an invented shape', () => {
  const svg = sparkline({ points: [5, 5, 5, 5] });
  const coords = /points="([^"]+)"/.exec(svg)[1].split(' ').map((pair) => Number(pair.split(',')[1]));
  assert.equal(new Set(coords).size, 1, `a flat series should be one height, got ${coords.join(',')}`);
});

test('a stacked bar keeps a slot for every part, including the unpriced one', () => {
  const svg = stackedBar({ segments: [{ label: 'input', value: 75 }, { label: 'output', value: 25 }, { label: 'cache', value: null, unknown: true }] });
  assert.match(svg, /input: 75 \(75%\)/);
  assert.match(svg, /output: 25 \(25%\)/);
  assert.match(svg, /cache: unavailable/);
  assert.match(svg, /not priced/, 'the unpriced part must be called out, not quietly resized to 0%');
});

test('charts never emit a script, a link, or an external reference', () => {
  // The CSP allows none of these, and a chart that quietly introduced one would break the
  // dashboard's only security boundary.
  const svg = barChart({ rows: [{ label: 'a', value: 1 }] }) + stackedBar({ segments: [{ label: 'a', value: 1 }] });
  assert.doesNotMatch(svg, /<script/i);
  // The SVG namespace declaration is a URI, not a fetch: `xmlns="http://www.w3.org/2000/svg"` is
  // required for the file to render. What must not appear is any *other* absolute URL.
  const withoutNamespace = svg.replaceAll('http://www.w3.org/2000/svg', '');
  assert.doesNotMatch(withoutNamespace, /https?:\/\//, 'no external reference may appear');
  assert.doesNotMatch(svg, /xlink:href|<use /i);
});
