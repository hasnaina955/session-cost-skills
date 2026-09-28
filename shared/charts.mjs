/**
 * Zero-dependency inline SVG charts.
 *
 * Every function here returns an SVG **string**, rendered in Node at report time rather than drawn
 * in the browser. That is a deliberate constraint, not a limitation:
 *
 * - It needs no script, so the dashboard works with JavaScript disabled and prints to PDF.
 * - It satisfies the existing strict CSP with no new allowances: `default-src 'none'` governs
 *   scripts and connections, and inline SVG needs neither. `style-src 'unsafe-inline'` is already
 *   present.
 * - It cannot be intercepted or tampered with after the fact, which matters for a file that gets
 *   emailed around.
 * - It is testable as a pure function. A chart rendered in the browser can only be asserted by a
 *   screenshot; this can be asserted by comparing strings.
 *
 * The module never computes money. It receives figures the accounting already produced and draws
 * them, so a chart cannot disagree with the report it sits next to. In particular:
 *
 * - An unknown value is drawn hatched and labelled, never as a zero-height bar. A bar chart that
 *   renders "we do not know" as nothing is the silent-zero failure in a new place.
 * - Every figure a chart encodes also appears as text, so the chart is never the only place a
 *   number exists.
 * - Colour is never the only channel: every segment carries a label or a pattern as well.
 */

/** Escape text for an XML attribute or text node. Every string reaching SVG goes through this. */
export function escapeXml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

const PALETTE = ['var(--accent)', 'var(--accent-2)', 'var(--warning)', 'var(--danger)', 'var(--muted)'];

/** A pattern for values that are not known, so "unpriced" is visible rather than absent. */
const UNKNOWN_PATTERN_DEFS = `<pattern id="sc-unknown" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
    <rect width="6" height="6" fill="var(--surface-3)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--muted)" stroke-width="2"/>
  </pattern>`;

function frame({ width, height, title, description, body, defs = '' }) {
  return `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" `
    + `aria-label="${escapeXml(title)}" xmlns="http://www.w3.org/2000/svg" class="sc-chart">`
    + `<title>${escapeXml(title)}</title><desc>${escapeXml(description)}</desc>`
    + (defs ? `<defs>${UNKNOWN_PATTERN_DEFS}${defs}</defs>` : UNKNOWN_PATTERN_DEFS ? `<defs>${UNKNOWN_PATTERN_DEFS}</defs>` : '')
    + `${body}</svg>`;
}

const EMPTY = '<text x="8" y="20" class="sc-muted" font-size="12">no data</text>';

/**
 * Horizontal bars. `rows` is `[{ label, value, unknown }]`.
 *
 * `unknown` entries are hatched and keep their row, so a reader can see that something was there
 * and could not be priced. Dropping the row would hide it; drawing it at zero would understate.
 */
export function barChart({ rows = [], width = 520, rowHeight = 26, format = (value) => String(value), title = 'Bar chart', description = '' } = {}) {
  if (rows.length === 0) return frame({ width, height: 40, title, description: description || 'no data', body: EMPTY });
  const labelWidth = 132;
  const valueWidth = 96;
  const plot = width - labelWidth - valueWidth - 8;
  const known = rows.map((row) => (row.unknown ? 0 : Number(row.value) || 0));
  const max = Math.max(...known, 0);
  const height = rows.length * rowHeight + 8;
  const body = rows.map((row, index) => {
    const y = index * rowHeight + 4;
    const value = row.unknown ? 0 : Number(row.value) || 0;
    const w = max > 0 ? Math.max(0, (value / max) * plot) : 0;
    const fill = row.unknown ? 'url(#sc-unknown)' : PALETTE[index % PALETTE.length];
    // The figure is written out as text whether or not the bar is drawable, so an unknown value
    // is visible as the word rather than as an absence.
    const shown = row.unknown ? 'unavailable' : format(value);
    return `<text x="0" y="${y + 15}" font-size="12" fill="var(--text)">${escapeXml(row.label)}</text>`
      + `<rect x="${labelWidth}" y="${y + 3}" width="${w.toFixed(1)}" height="${rowHeight - 10}" rx="3" fill="${fill}"></rect>`
      + `<text x="${labelWidth + plot + 8}" y="${y + 15}" font-size="12" fill="${row.unknown ? 'var(--warning)' : 'var(--muted)'}">${escapeXml(shown)}</text>`;
  }).join('');
  // When nothing is priced, the largest value is not zero - it is unknown. Saying "$0.00" here
  // is the silent-zero failure wearing a chart, and it is the reason this branch exists.
  const priced = rows.filter((row) => !row.unknown);
  const summary = priced.length === 0
    ? 'no priced value'
    : `${rows.length} value(s), largest ${format(max)}`;
  return frame({ width, height, title, description: description || summary, body });
}

/**
 * A single stacked bar for parts of a whole, with every part labelled.
 * `segments` is `[{ label, value, unknown }]`.
 */
export function stackedBar({ segments = [], width = 520, height = 44, title = 'Composition', format = (value) => String(value) } = {}) {
  const present = segments.filter((segment) => !segment.unknown);
  const total = present.reduce((sum, segment) => sum + (Number(segment.value) || 0), 0);
  if (segments.length === 0 || total <= 0) {
    return frame({ width, height, title, description: 'no data', body: `<text x="0" y="26" font-size="12" fill="var(--muted)">no data</text>` });
  }
  let x = 0;
  const bars = present.map((segment, index) => {
    const w = (Number(segment.value) / total) * width;
    const rect = `<rect x="${x.toFixed(1)}" y="0" width="${Math.max(0, w - 1).toFixed(1)}" height="20" fill="${PALETTE[index % PALETTE.length]}"></rect>`;
    x += w;
    return rect;
  }).join('');
  const unknown = segments.filter((segment) => segment.unknown);
  const legend = segments.map((segment, index) => {
    const colour = segment.unknown ? 'var(--muted)' : PALETTE[index % PALETTE.length];
    const shown = segment.unknown ? 'unavailable' : `${format(segment.value)} (${Math.round((Number(segment.value) / total) * 100)}%)`;
    return `<rect x="${(index * 190) % width}" y="30" width="10" height="10" fill="${segment.unknown ? 'url(#sc-unknown)' : colour}"></rect>`
      + `<text x="${(index * 190) % width + 15}" y="39" font-size="11" fill="var(--text)">${escapeXml(`${segment.label}: ${shown}`)}</text>`;
  }).join('');
  const note = unknown.length > 0
    ? `<text x="0" y="${height - 2}" font-size="11" fill="var(--warning)">${escapeXml(`${unknown.map((segment) => segment.label).join(', ')} not priced`)}</text>`
    : '';
  return frame({ width, height: height + 12, title, description: `${segments.length} parts`, body: bars + legend + note });
}

/**
 * A sparkline over time. Fewer than three points is not a trend, so anything shorter returns an
 * explicit "not enough data" rather than a line through two points, which reads as movement.
 */
export function sparkline({ points = [], width = 160, height = 32, title = 'Trend' } = {}) {
  if (points.length < 3) {
    return frame({ width, height, title, description: 'not enough data to show a trend', body: `<text x="0" y="20" font-size="10" fill="var(--muted)">too few points</text>` });
  }
  const values = points.map((point) => (typeof point === 'number' ? point : Number(point.value) || 0));
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min;
  const step = values.length > 1 ? width / (values.length - 1) : width;
  // A flat series is drawn flat. Inventing a shape from a zero range would imply variation that
  // the data does not contain.
  const coords = values.map((value, index) => {
    const y = span > 0 ? height - ((value - min) / span) * (height - 4) - 2 : height / 2;
    return `${(index * step).toFixed(1)},${y.toFixed(1)}`;
  });
  const body = `<polyline points="${coords.join(' ')}" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linejoin="round"></polyline>`;
  return frame({ width, height, title, description: `${points.length} points from ${format(min)} to ${format(max)}`, body });
}

const format = (value) => (Math.abs(value) >= 0.01 ? Number(value).toFixed(2) : String(Number(value).toPrecision(2)));
