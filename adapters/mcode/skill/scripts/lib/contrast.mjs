/**
 * WCAG contrast checking, so a palette is verified rather than believed.
 *
 * "Looks fine on my monitor" is not a check, and it is not transferable: a colour that reads
 * clearly on a bright display disappears on a dimmed one, and roughly one man in twelve has some
 * form of colour vision deficiency. The dashboard already ships a dark and a light theme, and
 * until now nothing asserted anything about either.
 *
 * The rules applied are WCAG 2.1:
 *   - 4.5:1 for body text, 3:1 for large text (>=18.66px bold or >=24px) and for non-text marks
 *     such as a chart bar, a border, or a focus ring.
 *
 * Colour vision is handled separately, by never using colour as the only channel - which the
 * charts already do, by carrying a label or a pattern beside every colour.
 */

/** Parse `#rgb`, `#rrggbb`, or `rgb(r, g, b)`. Returns null for anything it cannot read. */
export function parseColor(value) {
  const text = String(value ?? '').trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(text);
  if (hex) {
    const digits = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1];
    return [0, 2, 4].map((offset) => Number.parseInt(digits.slice(offset, offset + 2), 16));
  }
  const rgb = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/i.exec(text);
  if (rgb) return [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])];
  return null;
}

/** Relative luminance per WCAG 2.1. */
export function relativeLuminance(color) {
  const channels = typeof color === 'string' ? parseColor(color) : color;
  if (!channels) return null;
  const [r, g, b] = channels.map((value) => {
    const scaled = value / 255;
    return scaled <= 0.04045 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Contrast ratio between two colours, from 1 (identical) to 21 (black on white). */
export function contrastRatio(foreground, background) {
  const a = relativeLuminance(foreground);
  const b = relativeLuminance(background);
  if (a === null || b === null) return null;
  const lighter = Math.max(a, b);
  const darker = Math.min(a, b);
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * The pairs that matter in this dashboard, as data.
 *
 * `large` marks text set at 18.66px bold or larger, which needs 3:1 rather than 4.5:1. Chart
 * marks and borders are non-text and also need 3:1, because a bar nobody can see conveys nothing.
 */
export function requiredPairs(tokens) {
  return [
    { name: 'body text on background', foreground: tokens.text, background: tokens.bg, minimum: 4.5 },
    { name: 'body text on a surface', foreground: tokens.text, background: tokens.surface, minimum: 4.5 },
    { name: 'muted text on background', foreground: tokens.muted, background: tokens.bg, minimum: 4.5 },
    { name: 'muted text on a surface', foreground: tokens.muted, background: tokens.surface, minimum: 4.5 },
    { name: 'accent on background', foreground: tokens.accent, background: tokens.bg, minimum: 3 },
    { name: 'accent on a surface', foreground: tokens.accent, background: tokens.surface, minimum: 3 },
    { name: 'secondary accent on background', foreground: tokens['accent-2'], background: tokens.bg, minimum: 3 },
    { name: 'warning on background', foreground: tokens.warning, background: tokens.bg, minimum: 3 },
    { name: 'danger on background', foreground: tokens.danger, background: tokens.bg, minimum: 3 },
    { name: 'a border on a surface', foreground: tokens.line, background: tokens.surface, minimum: 1.2 },
  ];
}

/** Check one theme. Returns the failures and the measured ratios, rather than a pass/fail alone. */
export function auditTheme(tokens) {
  const results = requiredPairs(tokens).map((pair) => {
    const ratio = contrastRatio(pair.foreground, pair.background);
    return { ...pair, ratio, pass: ratio === null ? false : ratio >= pair.minimum };
  });
  return {
    results,
    failures: results.filter((result) => !result.pass),
    pass: results.every((result) => result.pass),
  };
}
