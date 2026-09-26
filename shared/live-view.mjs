// The live terminal view for a running session.
//
// Two problems had to be solved before this was worth shipping. A live view has to repaint
// in place, or the reading you care about scrolls off the top. And a ledger can be
// momentarily unreadable while the agent is mid-write, which must not kill the view.
//
// The repaint uses the terminal's alternate screen buffer, so the user's scrollback is
// untouched and Ctrl-C returns them exactly where they were. When stdout is not a TTY there
// is no cursor to move, so frames are appended instead and the caller gets a readable
// transcript rather than a screenful of escape codes.
//
// Nothing here interprets the numbers. It renders a normalized report, so it cannot invent a
// figure or disagree with `--json` about one.

const WIDTH = 74;
const ANSI = {
  enterAlt: '\x1b[?1049h',
  leaveAlt: '\x1b[?1049l',
  home: '\x1b[H',
  clear: '\x1b[2J',
  hideCursor: '\x1b[?25l',
  showCursor: '\x1b[?25h',
};

const money = (value) => (typeof value === 'number' && Number.isFinite(value) ? `$${value.toFixed(4)}` : 'unavailable');
const millions = (value) => (typeof value === 'number' && Number.isFinite(value) ? `${(value / 1e6).toFixed(2)} M` : 'n/a');
const clock = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '--:--:--');

function bar(fraction, width = 20) {
  const filled = Math.max(0, Math.min(width, Math.round((Number(fraction) || 0) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function row(label, right = '') {
  const left = `  ${String(label).slice(0, 24).padEnd(24)}`;
  return `${left}${' '.repeat(Math.max(1, WIDTH - left.length - String(right).length - 1))}${right}`;
}

function line(inner) {
  const text = String(inner);
  return `│ ${text}${' '.repeat(Math.max(1, WIDTH - text.length - 2))} │`;
}

/** Burn rate is the session's own spend rate, never the watcher's uptime. */
function burnRate(view) {
  const start = view?.startedAt ? Date.parse(view.startedAt) : null;
  const end = view?.lastActivity ? Date.parse(view.lastActivity) : null;
  const cost = view?.cost;
  if (start == null || end == null || end <= start || typeof cost !== 'number') return null;
  return { usdPerMinute: cost / ((end - start) / 60_000), spanMinutes: (end - start) / 60_000 };
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
    cost: report.billing?.amountUsd ?? (typeof report.totalCost === 'number' ? report.totalCost : null),
    isEstimate: report.billing?.basis === 'provider-rate-estimate' || report.billing === undefined,
    models,
    tree: report.sessionGraph?.includedSessionIds ?? report.includedSessionIds ?? [],
  };
}

/** Render one frame of the live view from a normalized report. */
export function renderLiveFrame(rawReport, { previous = null, stale = false, staleReason = null } = {}) {
  const view = normalizeForView(rawReport);
  const report = view?.report;
  const usage = view?.usage ?? {};
  const total = usage.totalTokens || 1;
  const cost = view?.cost ?? null;
  const burn = burnRate(view);
  const isEstimate = view?.isEstimate;
  const out = [];

  const title = ' session-cost · live ';
  out.push(`┌─${title}${'─'.repeat(Math.max(0, WIDTH - title.length - 11))} ${clock(report?.snapshot?.capturedAt)} ─┐`);

  const session = `${view?.sessionId ?? 'unknown'} · ${(view?.title ?? '').slice(0, 24)}`;
  const badge = stale ? 'STALE' : view?.active ? 'RUNNING' : 'IDLE';
  out.push(line(`${session.slice(0, WIDTH - 12).padEnd(WIDTH - 12)}  ${badge}`));
  const last = view?.lastActivity
    ? `last ledger activity ${Math.max(0, Math.round((Date.now() - Date.parse(view.lastActivity)) / 1000))}s ago`
    : 'no ledger activity recorded';
  out.push(line(last));
  out.push(`├${'─'.repeat(WIDTH)}┤`);

  const growth = previous == null || cost == null || typeof previous !== 'number'
    ? ''
    : Math.abs(cost - previous) < 1e-9 ? '·' : `+${(cost - previous).toFixed(4)}`;
  out.push(line(`TOTAL COST${isEstimate ? ' (estimate)' : ''}`.padEnd(24) + money(cost) + '  ' + growth));
  out.push(line(burn == null ? '' : `$${burn.usdPerMinute.toFixed(2)}/min over ${burn.spanMinutes >= 60 ? `${(burn.spanMinutes / 60).toFixed(1)}h` : `${burn.spanMinutes.toFixed(1)}m`}`));
  if (stale && staleReason) out.push(line(`last read failed: ${staleReason}`));
  out.push(`├${'─'.repeat(WIDTH)}┤`);

  out.push(line(`Total tokens  ${millions(usage.totalTokens)}`));
  for (const [label, value] of [
    ['Fresh input', usage.freshInputTokens],
    ['Cached read', usage.cacheReadTokens],
    ['Cache write', usage.cacheWriteTokens],
    ['Output', usage.outputTokens],
  ]) {
    out.push(line(`${label.padEnd(14)} ${bar(value / total)} ${(value / total * 100).toFixed(0).padStart(3)}%`));
  }
  out.push(line(`cache hit rate ${((usage.cacheHitRate ?? 0) * 100).toFixed(1)}%`));
  out.push(`├${'─'.repeat(WIDTH)}┤`);

  out.push(line('MODELS'));
  const models = [...(view?.models ?? [])].sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 4);
  const modelTotal = models.reduce((sum, model) => sum + (model.cost ?? 0), 0) || 1;
  for (const model of models) {
    const name = model.rateKey ?? model.modelId ?? model.model;
    out.push(row(`${model.providerKey ?? model.provider ?? '?'}/${name ?? '?'}`, `${money(model.cost ?? model.totalCost).padStart(10)} ${bar((model.cost ?? model.totalCost ?? 0) / modelTotal, 12)}`));
  }

  const included = view?.tree ?? [];
  if (included.length > 1) {
    out.push(`├${'─'.repeat(WIDTH)}┤`);
    out.push(line(`SESSION TREE — ${included.length} sessions incl. subagents`));
    for (const id of included.slice(0, 5)) out.push(line(`  ${id}`));
  }
  out.push(`├${'─'.repeat(WIDTH)}┤`);
  out.push(`│${' '.repeat(Math.max(1, WIDTH - 17))}Ctrl-C to stop │`);
  out.push(`└${'─'.repeat(WIDTH)}┘`);
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
