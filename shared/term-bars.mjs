/**
 * Bars and layout for the plain-text report.
 *
 * The terminal is where most people will actually read this, and a column of numbers makes them
 * do arithmetic in their head. A bar answers "which of these dominates?" at a glance, which is
 * the question a cost report is usually asked.
 *
 * The rules this module holds itself to, all of them learned the hard way elsewhere in this
 * project:
 *
 * - **A bar is decoration; the figure is the content.** Every bar is followed by the number it
 *   represents, so nothing is conveyed only by a length. Colour and glyphs are additions, never
 *   the carrier of the only copy of a value.
 * - **An unknown value is never drawn as an empty bar.** An empty bar and a zero bar are the same
 *   pixels, so a session that could not be priced would read as a session that cost nothing -
 *   the silent-zero failure in a new place. Unknown renders as the word `unavailable`.
 * - **Padding is measured in visible characters.** Escape sequences and the box-drawing and block
 *   glyphs are all single display cells, and a bar built with `String.length` produces ragged
 *   columns in exactly the terminals that use colour.
 * - **Plain is a first-class mode.** Colour is off unless stdout is a TTY and `NO_COLOR` is
 *   unset, and `--plain` drops the glyphs too, because a legacy code page renders `█` as mojibake
 *   and a pasted report should not carry block characters into an issue.
 */

/** Eighth-blocks, so a bar can show a fraction a whole cell cannot. */
const EIGHTHS = ['', '▏', '▎', '▍', '▌', '▋', '▊', '▉'];

/** Distinct fills for a composition bar, so segments are separable without colour. */
export const SEGMENT_GLYPHS = ['█', '▓', '▒', '░'];

/** Strip SGR/CSI sequences so a string's display width can be measured. */
export function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').length;
}

/** Truncate to a visible width, keeping the tail of an over-long string. */
export function truncateVisible(text, width) {
  const value = String(text ?? '');
  if (visibleLength(value) <= width) return value;
  if (width <= 1) return value.slice(0, Math.max(0, width));
  // A session title is more useful at the end than an ellipsis at the start, so drop from the left.
  let out = '';
  let used = 0;
  for (const character of [...value].reverse()) {
    const step = visibleLength(character);
    if (used + step > width - 1) break;
    out = character + out;
    used += step;
  }
  return `${out}…`;
}

/** Pad to a visible width, truncating when the value is too long to fit. */
export function padVisible(text, width) {
  const value = truncateVisible(text, width);
  const gap = width - visibleLength(value);
  return gap > 0 ? value + ' '.repeat(gap) : value;
}

/** Right-align to a visible width. */
export function alignRight(text, width) {
  const value = truncateVisible(text, width);
  const gap = width - visibleLength(value);
  return gap > 0 ? ' '.repeat(gap) + value : value;
}

/**
 * A horizontal bar for one value, in eighths of a cell.
 *
 * `value` and `max` that are not finite numbers produce the word `unavailable` rather than an
 * empty bar, because an empty bar is indistinguishable from zero and this project has been bitten
 * by that distinction repeatedly.
 */
export function bar(value, max, { width = 16, plain = false } = {}) {
  const size = Math.max(1, Math.floor(width));
  // The placeholder has to fit the column, or every bar it sits in is pushed out of alignment.
  // At narrow widths it is abbreviated rather than allowed to overflow.
  if (!Number.isFinite(value) || !Number.isFinite(max)) {
    return size >= 'unavailable'.length ? 'unavailable'.padEnd(size) : '?'.padEnd(size);
  }
  if (max <= 0) return ' '.repeat(size);
  const fraction = Math.max(0, Math.min(1, value / max));
  const total = fraction * size;
  const whole = Math.floor(total);
  const remainder = total - whole;
  const partial = whole >= size ? '' : EIGHTHS[Math.floor(remainder * 8)];
  return `${'█'.repeat(whole)}${partial}${' '.repeat(Math.max(0, size - whole - visibleLength(partial)))}`;
}

/**
 * A single-line composition bar. Segments are `[{ label, value, unknown }]`.
 *
 * Segments are separated by glyph as well as position, so the bar reads without colour. An
 * unknown segment is dropped from the proportions - it has no share to contribute - and named in
 * the legend, because including it as zero would overstate the others.
 */
export function compositionBar(segments, { width = 28, plain = false } = {}) {
  const size = Math.max(1, Math.floor(width));
  const known = segments.filter((segment) => !segment.unknown && Number.isFinite(Number(segment.value)));
  const total = known.reduce((sum, segment) => sum + Number(segment.value), 0);
  if (total <= 0) return { bar: ' '.repeat(size), legend: segments.length ? legendFor(segments) : '' };

  let used = 0;
  const cells = known.map((segment, index) => {
    const cellsForSegment = index === known.length - 1
      ? size - used
      : Math.max(total > 0 ? 0 : 0, Math.floor((Number(segment.value) / total) * size));
    used += cellsForSegment;
    return SEGMENT_GLYPHS[index % SEGMENT_GLYPHS.length].repeat(Math.max(0, cellsForSegment));
  }).join('');
  return { bar: cells.padEnd(size).slice(0, size), legend: legendFor(segments) };
}

function legendFor(segments, format = (value) => String(value)) {
  return segments.map((segment) => {
    const shown = segment.unknown || !Number.isFinite(Number(segment.value))
      ? 'unavailable'
      : format(segment.value);
    return `${segment.label}: ${shown}`;
  }).join('  ');
}

/** Resolve whether the plain report may use colour, and how wide the terminal is. */
export function resolveReportStyle({ color = false, plain = false, environment = process.env, stream = process.stdout } = {}) {
  const noColor = Boolean(environment.NO_COLOR);
  const forced = environment.FORCE_COLOR !== undefined && environment.FORCE_COLOR !== '0';
  const enabled = !plain && (color === true || (color !== false && forced) || (Boolean(stream?.isTTY) && !noColor));
  const columns = Number(stream?.columns) || Number(environment.COLUMNS) || 80;
  return { color: Boolean(enabled) && !noColor, width: Math.max(60, Math.min(columns, 120)), plain: Boolean(plain) };
}

const SGR = { reset: '\x1b[0m', dim: '\x1b[2m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m' };

/** Wrap text in an SGR code, or return it unchanged when colour is off. */
export function paint(style, code, text) {
  return style?.color && code ? `${code}${text}${SGR.reset}` : String(text);
}

/** Colour a cost figure by severity. An unknown cost never gets a colour, because it has no severity. */
export function paintCost(style, value) {
  if (!Number.isFinite(value)) return paint(style, SGR.yellow, 'unavailable');
  if (style?.overBudget) return paint(style, SGR.red, `$${value.toFixed(4)}`);
  return paint(style, SGR.green, `$${value.toFixed(4)}`);
}
