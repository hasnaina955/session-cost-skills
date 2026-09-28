/**
 * A shareable summary card, as a standalone SVG.
 *
 * People share what they can screenshot. A tidy one-image summary travels in a chat, an issue, or
 * a status update in a way a terminal transcript never will, so this is the cheapest distribution
 * the project has.
 *
 * Two decisions shape it:
 *
 * - **SVG, not PNG.** No encoder, no dependency, no headless browser, and it is a text file that
 *   renders in a browser, an image viewer, and a terminal. The size is bounded by the content, not
 *   by a raster canvas.
 * - **Privacy by default.** No session title, prompt, file path, or session id appears unless the
 *   caller asks. A card is the most likely artefact of this tool to leave the machine it was made
 *   on, and "what did my agent cost me" rarely needs the name of the session to be useful. The
 *   figures are the point; the identifiers are not.
 */

import { escapeXml, PALETTE_HINT } from './charts.mjs';

const WIDTH = 1200;
const HEIGHT = 630;

/** Format a cost for a card: exact to the cent, or an explicit refusal to state one. */
function cost(value) {
  if (!Number.isFinite(value)) return 'unavailable';
  if (value === 0) return '$0.00';
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

function count(value) {
  if (!Number.isFinite(value)) return 'n/a';
  if (value >= 1e6) return `${(value / 1e6).toFixed(2)} M`;
  if (value >= 1e3) return `${(value / 1e3).toFixed(1)} k`;
  return String(Math.round(value));
}

/**
 * Build the card.
 *
 * `report` is the normalized report. `includeTitle` is the only way a title or id reaches the
 * output, and the caller has to pass it deliberately.
 */
export function renderCard(report, {
  title = 'session-cost',
  includeTitle = false,
  generatedAt = null,
  plain = false,
} = {}) {
  const billing = report?.billing ?? {};
  const usage = report?.usage ?? {};
  const models = Array.isArray(report?.models) ? report.models : [];
  const total = Number.isFinite(billing.amountUsd) ? billing.amountUsd : null;
  const known = total !== null;

  // The token mix, drawn from the same figures the report states.
  const segments = [
    { label: 'fresh input', value: Number(usage.freshInputTokens ?? usage.inputTokens ?? 0) || 0 },
    { label: 'cached read', value: Number(usage.cacheReadTokens ?? 0) || 0 },
    { label: 'cache write', value: Number(usage.cacheWriteTokens ?? 0) || 0 },
    { label: 'output', value: Number(usage.outputTokens ?? 0) || 0 },
  ];
  const mixTotal = segments.reduce((sum, segment) => sum + segment.value, 0);
  const barWidth = 1100;
  let x = 50;
  const mixBars = mixTotal > 0
    ? segments.map((segment, index) => {
      const w = (segment.value / mixTotal) * barWidth;
      const rect = `<rect x="${x.toFixed(1)}" y="300" width="${Math.max(0, w - 2).toFixed(1)}" height="34" fill="${PALETTE_HINT[index % PALETTE_HINT.length]}" rx="3"></rect>`;
      x += w;
      return rect;
    }).join('')
    : '';

  const legend = segments.map((segment, index) => {
    const share = mixTotal > 0 ? Math.round((segment.value / mixTotal) * 100) : 0;
    const lx = 50 + (index * 285);
    return `<rect x="${lx}" y="366" width="14" height="14" fill="${PALETTE_HINT[index % PALETTE_HINT.length]}" rx="3"></rect>`
      + `<text x="${lx + 22}" y="378" font-size="19" fill="#8b9cb5">${escapeXml(`${segment.label} ${count(segment.value)} (${share}%)`)}</text>`;
  }).join('');

  const topModels = models
    .filter((model) => model.rateKnown !== false && Number.isFinite(Number(model.totalCost)))
    .sort((a, b) => b.totalCost - a.totalCost)
    .slice(0, 4);
  const modelMax = Math.max(...topModels.map((model) => model.totalCost), 0);
  const modelRows = topModels.map((model, index) => {
    const y = 460 + index * 34;
    const w = modelMax > 0 ? (model.totalCost / modelMax) * 420 : 0;
    return `<text x="50" y="${y + 16}" font-size="20" fill="#e8f0fb">${escapeXml(String(model.modelId ?? '').slice(0, 34))}</text>`
      + `<rect x="480" y="${y + 3}" width="${w.toFixed(1)}" height="18" fill="${PALETTE_HINT[index % PALETTE_HINT.length]}" rx="3"></rect>`
      + `<text x="${480 + w + 14}" y="${y + 17}" font-size="19" fill="#8b9cb5">${escapeXml(cost(model.totalCost))}</text>`;
  }).join('');
  const unpriced = models.filter((model) => model.rateKnown === false);
  const unpricedNote = unpriced.length > 0
    ? `<text x="50" y="${460 + topModels.length * 34 + 6}" font-size="17" fill="${plain ? '#805400' : '#f5c56b'}">${escapeXml(`${unpriced.length} model(s) could not be priced`)}</text>`
    : '';

  // A card that states a coverage verdict is more useful than one that shows a number with no
  // caveat, and a card that cannot say what it does not know should not pretend otherwise.
  // The verdict comes from `coverage`, not from whether a number happens to be present: a
  // partially priced session has no `amountUsd` either, and calling that "no priced calls" would
  // misdescribe it.
  const coverageNote = billing.coverage === 'complete'
    ? ''
    : billing.coverage === 'partial'
      ? 'partial coverage - some calls could not be priced'
      : 'no priced calls in this session';

  const background = plain ? '#ffffff' : '#0b1526';
  const textColour = plain ? '#101c2e' : '#eef4ff';
  const muted = plain ? '#4a5a72' : '#8b9cb5';
  const stroke = plain ? '#d7e1ef' : '#26395a';

  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${WIDTH} ${HEIGHT}" width="${WIDTH}" height="${HEIGHT}" role="img" aria-label="${escapeXml(`${title}: ${cost(total)} total`)}">`
    + `<title>${escapeXml(`${title}: ${cost(total)} total`)}</title>`
    + `<desc>${escapeXml(`Total ${cost(total)}. ${Number.isFinite(usage.totalTokens) ? count(usage.totalTokens) : 'unknown'} tokens, cache-hit rate ${Number.isFinite(usage.cacheHitRate) ? `${Math.round(usage.cacheHitRate * 100)}%` : 'unknown'}. ${coverageNote || 'Complete coverage.'}`)}</desc>`
    + `<rect width="${WIDTH}" height="${HEIGHT}" fill="${background}" rx="18"></rect>`
    + `<text x="50" y="88" font-size="26" fill="${muted}" font-family="Inter, system-ui, sans-serif">${escapeXml(includeTitle && report?.title ? String(report.title).slice(0, 60) : title)}</text>`
    + `<text x="50" y="196" font-size="88" font-weight="700" fill="${known ? textColour : '#f5c56b'}" font-family="Inter, system-ui, sans-serif">${escapeXml(cost(total))}</text>`
    + (coverageNote ? `<text x="50" y="240" font-size="21" fill="${muted}">${escapeXml(coverageNote)}</text>` : '')
    + `<text x="700" y="150" font-size="20" fill="${muted}">tokens</text>`
    + `<text x="700" y="184" font-size="34" fill="${textColour}">${escapeXml(count(usage.totalTokens))}</text>`
    + `<text x="920" y="150" font-size="20" fill="${muted}">cache hit</text>`
    + `<text x="920" y="184" font-size="34" fill="${textColour}">${escapeXml(Number.isFinite(usage.cacheHitRate) ? `${Math.round(usage.cacheHitRate * 100)}%` : 'n/a')}</text>`
    + `<text x="50" y="284" font-size="20" fill="${muted}">token mix</text>`
    + mixBars
    + legend
    // The unpriced disclosure is NOT nested inside "if there are priced models". An earlier
    // version put it there, which meant the note was hidden in exactly the case it exists for:
    // a session where nothing could be priced.
    + (modelRows ? `<text x="50" y="446" font-size="20" fill="${muted}">cost by model</text>${modelRows}` : '')
    + unpricedNote
    + `<line x1="50" y1="${HEIGHT - 56}" x2="${WIDTH - 50}" y2="${HEIGHT - 56}" stroke="${stroke}" stroke-width="1"></line>`
    + `<text x="50" y="${HEIGHT - 26}" font-size="18" fill="${muted}">${escapeXml(generatedAt ? `generated ${generatedAt} · ` : '')}generated locally by session-cost - no session data leaves this machine</text>`
    + '</svg>';
}
