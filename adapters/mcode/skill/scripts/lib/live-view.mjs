// The live terminal view for a running session.
//
// Three problems had to be solved before this was worth shipping. A live view has to repaint in
// place, or the reading you care about scrolls off the top. A ledger can be momentarily
// unreadable while the agent is mid-write, which must not kill the view. And a view that repaints
// the same static block twice a second is not conveying anything a single frame would not.
//
// The repaint uses the terminal's alternate screen buffer, so the user's scrollback is untouched
// and Ctrl-C returns them exactly where they were. When stdout is not a TTY there is no cursor to
// move, so frames are appended instead and the caller gets a readable transcript rather than a
// screenful of escape codes.
//
// Nothing here interprets the numbers. It renders a normalized report, so it cannot invent a
// figure or disagree with `--json` about one.

// ---------------------------------------------------------------------------------------------
// Motion policy
//
// The rule this file is built around: animate the chrome, never the figures.
//
// A cost that counts up from $0.39 to $0.42 shows three different numbers while it settles, and
// the middle ones are not the session's cost. Somebody screenshots the middle one. The exact
// figure belongs to the report, and the report's digits are exact sums of per-call costs, so
// every number here is static and exact. What moves is the frame around it: the activity
// indicator, the severity colour, the trailing highlight on the history sparkline, and a one-shot
// highlight when a figure changes.
//
// Two things are deliberately absent. Nothing blinks: a flashing block is an accessibility
// hazard, so severity is carried by a static colour and a label instead. And nothing spins while
// idle: an indicator that animates when the ledger is not moving would be a decoration claiming
// activity that is not happening.
// ---------------------------------------------------------------------------------------------

const DEFAULT_WIDTH = 74;
const ANSI = {
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  home: '\x1b[H',
  clear: '\x1b[2J',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

// SGR sequences. Colour is only ever emitted when `style.color` is true, which requires an
// interactive surface, so the non-TTY transcript stays free of escape codes.
const SGR = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightRed: '\x1b[91m',
};

/**
 * Decide whether this frame may use colour and what the palette is.
 *
 * Honours the NO_COLOR convention and an explicit opt-out, and stays off entirely when stdout is
 * not a TTY. The escape codes themselves are a form of untrusted-looking output, and the
 * non-TTY transcript is the thing a human or a log file reads.
 */
export function resolveStyle({ color, width = DEFAULT_WIDTH } = {}) {
  const env = process.env ?? {};
  const enabled = color === true
    || (color !== false && Boolean(process.stdout?.isTTY) && !env.NO_COLOR);
  const bounded = Math.max(56, Math.min(Number(width) || DEFAULT_WIDTH, 120));
  return { color: Boolean(enabled), width: bounded };
}

// Any string that came from the ledger is untrusted: a session title, a model id, a
// provider name. A title containing ANSI escapes can clear the screen, move the cursor,
// or rewrite the window title, which would make the tool display a forged report. This is
// the terminal twin of the stored-DOM-XSS the dashboard guards against, so escape
// sequences and other control characters are stripped rather than printed.
export function sanitizeForTerminal(value) {
  if (value == null) return '';
  // Drop CSI/OSC and any other escape sequence, then any remaining C0/C1 control char.
  return String(value)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b[@-Z\\-_]|\x1b\[[0-?]*[ -\/]*[@-~]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '')
    .trim();
}

const safe = (value, max = 24) => sanitizeForTerminal(value).slice(0, max);

/**
 * Visible width of a string, ignoring SGR sequences.
 *
 * Colour codes are invisible but they are still characters, so padding computed with
 * `String.length` would mis-measure every coloured line and break the box. This is the classic
 * way coloured terminal UIs end up with ragged borders.
 */
function visibleLength(text) {
  return String(text).replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, '').length;
}

const paint = (style, code, text) => (style.color && code ? `${code}${text}${SGR.reset}` : String(text));
const money = (value) => (typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : 'unavailable');
const millions = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${(value / 1e6).toFixed(2)} M` : 'n/a');
const clock = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '--:--:--');

function bar(fraction, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((Number(fraction) || 0) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

// Eight vertical blocks, used as a sparkline so the frame shows shape over time rather than
// only the present instant.
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];

/**
 * Render a series of numbers as a sparkline, oldest on the left, with the newest segment
 * highlighted so recency is visible at a glance.
 *
 * Returns an empty string for a series too short to imply a trend. Scaling is between the
 * window's own min and max; when every value is identical there is no range to scale against,
 * so the line is drawn flat at mid height rather than inventing a shape.
 */
export function sparkline(values, { width = 12, style = { color: false } } = {}) {
  const points = (Array.isArray(values) ? values : []).filter((v) => typeof v === 'number' && Number.isFinite(v));
  if (points.length < 3) return '';
  const windowed = points.slice(-width);
  const min = Math.min(...windowed);
  const max = Math.max(...windowed);
  const span = max - min;
  return windowed.map((value, index) => {
    const level = span === 0 ? 3 : Math.round(((value - min) / span) * (SPARK.length - 1));
    const glyph = SPARK[Math.max(0, Math.min(SPARK.length - 1, level))];
    // The leading segment is the newest sample; older ones recede.
    if (index === windowed.length - 1) return paint(style, SGR.brightCyan, glyph);
    return paint(style, SGR.dim, glyph);
  }).join('');
}

const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

/**
 * An activity indicator that advances only when the ledger actually moved.
 *
 * Free-running spinners are the usual way a live view lies: they turn at a fixed rate regardless
 * of whether anything is happening, so a wedged agent looks identical to a working one. Here the
 * glyph freezes when there is no progress, and a frozen frame is itself the signal.
 */
export function activityGlyph({ frameIndex = 0, progressed = false, style = { color: false } } = {}) {
  if (!progressed) return paint(style, SGR.dim, '·');
  const glyph = SPINNER[Math.abs(Math.trunc(frameIndex)) % SPINNER.length];
  return paint(style, SGR.brightCyan, glyph);
}

// Frame geometry. `width` is the TOTAL column count including the two border characters, so a
// frame is never wider than the terminal it was asked for. `content` is what is available
// between the borders once each line's own padding is removed.
const contentOf = (width) => Math.max(1, width - 4);

/**
 * A left/right aligned line inside the box.
 *
 * The model rows used to be emitted without borders, which left them dangling past the right
 * edge of the frame they sit in. A borderless row cannot be padded correctly by the same maths
 * as a bordered one, so both now share one shape and the frame lines up.
 */
function row(label, right = '', width = DEFAULT_WIDTH) {
  const left = String(label).slice(0, 24).padEnd(24);
  const gap = Math.max(1, contentOf(width) - visibleLength(left) - visibleLength(right));
  return `│ ${left}${' '.repeat(gap)}${right} │`;
}

function line(inner, width = DEFAULT_WIDTH) {
  const text = String(inner);
  return `│ ${text}${' '.repeat(Math.max(1, contentOf(width) - visibleLength(text)))} │`;
}

const rule = (width, style, code) => paint(style, code, `├${'─'.repeat(Math.max(1, width - 2))}┤`);

/** Burn rate is the session's own spend rate, never the watcher's uptime. */
function burnRate(view) {
  const start = view?.startedAt ? Date.parse(view.startedAt) : null;
  const end = view?.lastActivity ? Date.parse(view.lastActivity) : null;
  const cost = view?.cost;
  if (start == null || end == null || end <= start || typeof cost !== 'number') return null;
  return { usdPerMinute: cost / ((end - start) / 60_000), spanMinutes: (end - start) / 60_000 };
}

// Non-negotiable accounting rule 1: unknown cost is `null`, never `0`. Both adapters keep a
// legacy `totalCost` aggregate that is `0` — not `null` — when no call could be priced, so a
// naive `typeof totalCost === 'number'` fallback silently turns "we do not know what this cost"
// into "$0.0000", which a reader takes as "this session was free". The report's own declared
// verdict wins; the legacy aggregate is only consulted when nothing contradicts it.
function reportDeclaresCostUnknown(report, billing) {
  return report?.rateKnown === false
    || billing?.rateKnown === false
    || billing?.coverage === 'unavailable'
    || billing?.classification === 'cost-unavailable'
    || report?.coverage?.status === 'unavailable';
}

function reportedCost(report) {
  const billing = report?.billing;
  const declared = billing?.amountUsd;
  if (typeof declared === 'number' && Number.isFinite(declared)) return declared;
  // A present `billing` block is authoritative even when it carries no number: it has already
  // adjudicated the cost, so there is nothing for the legacy aggregate to add.
  if (billing && typeof billing === 'object') return null;
  if (reportDeclaresCostUnknown(report, billing)) return null;
  const legacy = report?.totalCost;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null;
}

// The same rule one level down: an unpriced model row also carries `totalCost: 0`.
function modelCost(model) {
  if (model?.rateKnown === false || model?.rateCoverage === 'unavailable') return null;
  const declared = model?.cost;
  if (typeof declared === 'number' && Number.isFinite(declared)) return declared;
  const legacy = model?.totalCost;
  return typeof legacy === 'number' && Number.isFinite(legacy) ? legacy : null;
}

/**
 * How urgent this frame looks.
 *
 * Deliberately asymmetric. `quiet` and `spending` are facts read off the ledger. `fast` is a
 * judgement, so it needs a caller-supplied threshold and never fires on a default guess about
 * what a dollar a minute should mean to somebody. An unknown cost is never given a severity,
 * because there is nothing to be urgent about when the figure is unknown.
 */
export function severityFor({ cost, burn, delta, active, budgetUsd = null, fastUsdPerMin = null }) {
  if (typeof cost !== 'number') return { key: 'unknown', label: '', color: null };
  if (typeof budgetUsd === 'number' && cost >= budgetUsd) {
    return { key: 'over-budget', label: 'OVER BUDGET', color: SGR.brightRed };
  }
  if (typeof fastUsdPerMin === 'number' && burn != null && burn.usdPerMinute >= fastUsdPerMin) {
    return { key: 'fast', label: 'burning fast', color: SGR.brightYellow };
  }
  if (active && typeof delta === 'number' && Math.abs(delta) > 1e-9) {
    return { key: 'spending', label: 'spending', color: SGR.brightGreen };
  }
  if (!active) return { key: 'quiet', label: 'idle', color: SGR.dim };
  return { key: 'steady', label: '', color: SGR.dim };
}

// The two adapters serialize the same facts differently: Cline nests a `session` object
// and an aggregate `total.models` map, MCode is flat with a `models` array. Normalize once
// here rather than branching throughout the frame, so the view cannot show a blank field
// for one adapter just because the key is named differently.
function normalizeForView(report) {
  if (!report || typeof report !== 'object') return null;
  const models = Array.isArray(report.models)
    ? report.models
    : Object.values(report?.total?.models ?? {});
  return {
    report,
    sessionId: report.session?.id ?? report.sessionId ?? 'unknown',
    title: report.session?.title ?? report.title ?? '',
    startedAt: report.session?.startedAt ?? null,
    lastActivity: report.snapshot?.lastLedgerActivityAt ?? report.ledgerLastCallAt ?? null,
    active: report.snapshot?.active ?? report.sessionActive ?? false,
    capturedAt: report.snapshot?.capturedAt ?? report.generatedAt ?? null,
    usage: report.usage ?? {
      totalTokens: report.totalTokens,
      freshInputTokens: report.inputTokens,
      cacheReadTokens: report.cacheReadTokens,
      cacheWriteTokens: report.cacheWriteTokens,
      outputTokens: report.outputTokens,
      cacheHitRate: report.cacheRate ?? 0,
    },
    cost: reportedCost(report),
    isEstimate: report.billing?.basis === 'provider-rate-estimate' || report.billing === undefined,
    models,
    tree: report.sessionGraph?.includedSessionIds ?? report.includedSessionIds ?? [],
  };
}

/**
 * Render one frame of the live view from a normalized report.
 *
 * Every new option has a default that reproduces the previous static frame, so a caller that
 * passes nothing but a report still gets a valid view and a caller that does not know about
 * motion cannot break one.
 */
export function renderLiveFrame(rawReport, {
  previous = null,
  stale = false,
  staleReason = null,
  history = null,
  frameIndex = 0,
  progressed = null,
  width = DEFAULT_WIDTH,
  color = undefined,
  budgetUsd = null,
  fastUsdPerMin = null,
} = {}) {
  const style = resolveStyle({ color, width });
  const W = style.width;
  const view = normalizeForView(rawReport);
  const report = view?.report;
  const usage = view?.usage ?? {};
  const total = usage.totalTokens || 1;
  const cost = view?.cost ?? null;
  const burn = burnRate(view);
  const isEstimate = view?.isEstimate;
  const out = [];

  // Progress defaults to "the token count moved since the previous frame", which is the most
  // honest signal available: it is derived from the ledger rather than from a timer.
  const moved = progressed === null
    ? (typeof previous === 'number' && cost != null && Math.abs(cost - previous) > 1e-9)
    : Boolean(progressed);
  const delta = typeof previous === 'number' && cost != null ? cost - previous : null;
  const severity = severityFor({ cost, burn, delta, active: view?.active, budgetUsd, fastUsdPerMin });

  // --- header ---------------------------------------------------------------------------------
  const glyph = activityGlyph({ frameIndex, progressed: moved, style });
  const title = ' session-cost · live ';
  const stamp = clock(report?.snapshot?.capturedAt);
  const headLeft = `${glyph} ${title}`;
  const headRight = stamp;
  const headFill = Math.max(0, W - visibleLength(headLeft) - visibleLength(headRight) - 6);
  out.push(`┌─${paint(style, SGR.dim, headLeft)}${'─'.repeat(headFill)} ${paint(style, SGR.dim, headRight)} ─┐`);

  const badge = stale ? 'STALE' : view?.active ? 'RUNNING' : 'IDLE';
  const badgeColor = stale ? SGR.brightRed : view?.active ? SGR.brightCyan : SGR.dim;
  const session = `${safe(view?.sessionId, 22)} · ${safe(view?.title)}`;
  const badgeText = paint(style, badgeColor, badge);
  const sessionWidth = W - 12 - visibleLength(badgeText);
  out.push(line(`${session.slice(0, Math.max(0, sessionWidth)).padEnd(Math.max(0, sessionWidth))}  ${badgeText}`));

  const idleSeconds = view?.lastActivity
    ? Math.max(0, Math.round((Date.now() - Date.parse(view.lastActivity)) / 1000))
    : null;
  // Distinguishing "quiet" from "wedged" matters: a long gap since the last ledger call is a
  // different situation from a session that has finished, and both used to read as RUNNING.
  let last = 'no ledger activity recorded';
  if (idleSeconds != null) {
    const quiet = idleSeconds > 90;
    last = `last ledger activity ${idleSeconds}s ago${quiet ? ' — quiet, may be wedged' : ''}`;
    out.push(line(paint(style, quiet ? SGR.brightYellow : SGR.dim, last)));
  } else {
    out.push(line(paint(style, SGR.dim, last)));
  }
  out.push(rule(W, style));

  // --- cost block -----------------------------------------------------------------------------
  // The figure itself never animates. It brightens for exactly as long as it is newly changed,
  // which is a fact about the last frame, not a rolling approximation of the value.
  const costText = money(cost);
  const costPainted = cost == null
    ? paint(style, SGR.dim, costText)
    : paint(style, moved ? severity.color ?? SGR.brightGreen : SGR.reset, costText);
  const growth = delta == null
    ? ''
    : Math.abs(delta) < 1e-9
      ? paint(style, SGR.dim, '·')
      : paint(style, severity.color ?? SGR.green, `+${delta.toFixed(4)}`);
  const spark = sparkline(history, { width: 12, style });
  out.push(line(paint(style, SGR.bold, `TOTAL COST${isEstimate ? ' (estimate)' : ''}`.padEnd(24)) + costPainted + '  ' + growth + (spark ? `  ${spark}` : '')));

  // The severity label shares the burn-rate line rather than taking a line of its own: a single
  // word is not worth a full row in a frame this size.
  const burnText = burn == null ? '' : `$${burn.usdPerMinute.toFixed(2)}/min over ${burn.spanMinutes >= 60 ? `${(burn.spanMinutes / 60).toFixed(1)}h` : `${burn.spanMinutes.toFixed(1)}m`}`;
  const urgent = severity.key === 'fast' || severity.key === 'over-budget';
  if (burnText || (severity.label && severity.key !== 'quiet')) {
    const body = burnText ? `${burnText}  ·  ${severity.label || 'steady'}` : severity.label;
    out.push(line(urgent ? paint(style, severity.color, body) : paint(style, SGR.dim, body)));
  }
  if (stale && staleReason) out.push(line(paint(style, SGR.brightRed, `last read failed: ${safe(staleReason, 60)}`)));
  out.push(rule(W, style));

  // --- usage ----------------------------------------------------------------------------------
  out.push(line(paint(style, SGR.bold, `Total tokens  ${millions(usage.totalTokens)}`)));
  for (const [label, value, color] of [
    ['Fresh input', usage.freshInputTokens, SGR.blue],
    ['Cached read', usage.cacheReadTokens, SGR.cyan],
    ['Cache write', usage.cacheWriteTokens, SGR.yellow],
    ['Output', usage.outputTokens, SGR.green],
  ]) {
    const fraction = value / total;
    out.push(line(`${paint(style, color, label.padEnd(14))} ${paint(style, color, bar(fraction))} ${paint(style, SGR.dim, `${(fraction * 100).toFixed(0).padStart(3)}%`)}`));
  }
  out.push(line(paint(style, SGR.dim, `cache hit rate ${((usage.cacheHitRate ?? 0) * 100).toFixed(1)}%`)));
  out.push(rule(W, style));

  // --- models ---------------------------------------------------------------------------------
  out.push(line(paint(style, SGR.bold, 'MODELS')));
  const models = [...(view?.models ?? [])]
    .map((model) => ({ model, cost: modelCost(model) }))
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0))
    .slice(0, 4);
  // An unpriced model contributes no proportion, so it never draws a full bar it did not earn.
  const modelTotal = models.reduce((sum, entry) => sum + (entry.cost ?? 0), 0) || 1;
  for (const { model, cost: modelAmount } of models) {
    const name = safe(model.rateKey ?? model.modelId ?? model.model, 22);
    const amount = money(modelAmount);
    out.push(row(
      `${safe(model.providerKey ?? model.provider, 14) || '?'}/${name || '?'}`,
      `${paint(style, modelAmount == null ? SGR.dim : SGR.reset, amount.padStart(10))} ${paint(style, SGR.cyan, bar((modelAmount ?? 0) / modelTotal, 12))}`,
      W,
    ));
  }

  const included = view?.tree ?? [];
  if (included.length > 1) {
    out.push(rule(W, style));
    out.push(line(paint(style, SGR.bold, `SESSION TREE — ${included.length} sessions incl. subagents`)));
    for (const id of included.slice(0, 5)) out.push(line(paint(style, SGR.dim, `  ${safe(id, 40)}`)));
  }
  out.push(rule(W, style));
  const footer = 'Ctrl-C to stop';
  out.push(`│${' '.repeat(Math.max(1, W - footer.length - 3))}${paint(style, SGR.dim, footer)} │`);
  out.push(`└${'─'.repeat(Math.max(1, W - 2))}┘`);
  return out.join('\n');
}

/**
 * A drawing surface. On a TTY it repaints in place; otherwise it appends frames.
 * Always leaves the terminal as it found it, including on SIGINT.
 */
export function createLiveSurface(stream = process.stdout, { registerSignalHandlers = true } = {}) {
  const interactive = Boolean(stream?.isTTY);
  let drawing = false;

  const leave = () => {
    if (!drawing) return;
    drawing = false;
    stream.write(ANSI.showCursor + ANSI.leaveAlt);
  };

  return {
    interactive,
    draw(frame) {
      if (!interactive) {
        stream.write(`${frame}\n`);
        return;
      }
      if (!drawing) {
        drawing = true;
        if (registerSignalHandlers) {
          // process.on, not process.once: a second Ctrl-C must still exit.
          process.on('exit', leave);
          for (const signal of ['SIGINT', 'SIGTERM']) {
            process.on(signal, () => { leave(); process.exit(130); });
          }
        }
        stream.write(ANSI.enterAlt + ANSI.hideCursor);
      }
      stream.write(ANSI.home + ANSI.clear + frame);
    },
    leave,
  };
}

/**
 * Decide how long to wait before the next poll. Fast while the session is moving, backing off
 * when idle so watching a finished session does not spin a core.
 */
export function nextInterval(report, { activeMs = 500, idleMs = 3000 } = {}) {
  return report?.snapshot?.active ? activeMs : idleMs;
}
