// A spend budget is a gate on the exit code, never on the report.
//
// The rule this file exists to enforce is the one that is easy to get wrong by
// accident: an unpriced session must never read as "safely under budget". Every other
// spend tool compares whatever number it has, and `null` compares as "less than the
// limit" in JavaScript. So the status is derived from whether the amount is *knowable*,
// not from whether the number happens to be small.
//
// Three statuses, and `ok` is the only quiet one:
//   ok        the report supports a total and the total is within the limit (exit 0)
//   exceeded  the spend is known and has passed the limit (exit 3)
//   unknown   the total cannot be established, so under budget is unproven (exit 2)
//
// `unknown` is deliberately not `ok`. A caller that checks `status === 'ok'` must be
// able to mean "proved within budget", and a caller that checks `exitCode === 0` must
// not be told that a session with no price attached is fine.
//
// The reported-versus-estimated distinction is structural rather than editorial: the
// word "spent" is only reachable when the runtime recorded a charge, so an estimate
// can never be phrased as one.

export const BUDGET_STATUS = Object.freeze({ OK: 'ok', EXCEEDED: 'exceeded', UNKNOWN: 'unknown' });

// `ok` is 0. `unknown` reuses 2 because both CLIs already exit 2 when a cost cannot be
// determined (`rateKnown === false`), so a wrapper that treats 2 as "no usable cost"
// keeps working. `exceeded` takes 3: 1 is reserved for an unexpected failure in both
// CLIs, and a blown budget is a governance result a script wants to tell apart from a
// crash.
export const BUDGET_EXIT_CODES = Object.freeze({ ok: 0, exceeded: 3, unknown: 2 });

/** The scopes one cap can cover. Same helper, different window. */
export const BUDGET_SCOPES = Object.freeze({ SESSION: 'session', DAY: 'day' });

const SCOPE_VALUES = new Set(Object.values(BUDGET_SCOPES));

// Coverage states in which the report's amount is a settled total. `partial` is absent
// on purpose: a partial amount is a lower bound, so it can prove a budget was blown but
// can never prove one was respected.
const SETTLED_COVERAGE = new Set(['complete', 'no-calls']);

// Wording per cost basis. Only `runtime-recorded` is allowed to say "spent".
const BASIS_PHRASING = Object.freeze({
  'runtime-recorded': { verb: 'spent', noun: 'the recorded spend' },
  'provider-rate-estimate': { verb: 'is estimated at', noun: 'the estimated spend' },
  unknown: { verb: 'is reported at', noun: 'the reported spend' },
});

const UNKNOWN_REASONS = Object.freeze({
  unpriced: 'cost-unavailable',
  unsettled: 'coverage-unsettled',
});

/**
 * True only for a number a report can stand behind: finite, and not negative.
 *
 * A numeric string is deliberately rejected. `Number.isFinite('0.04')` is false, and
 * accepting one would let `'0.04' <= 5` read as a pass through JavaScript's own
 * coercion while `Number.isFinite` reports otherwise. Failing closed here is the whole
 * point.
 */
export function isKnownCostUsd(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function roundUsd(value) {
  return Math.round(value * 1e6) / 1e6;
}

/**
 * Render a dollar amount for a human reader.
 *
 * A sub-cent spend formatted at two decimals prints `$0.00`, which is byte-identical to
 * a real zero, so a real spend would read as free. Keep the digits that tell those two
 * apart.
 */
export function formatUsd(value) {
  if (!isKnownCostUsd(value)) return 'unknown';
  if (value >= 0.01) return value.toFixed(2);
  const precise = value.toFixed(6);
  if (Number(precise) === 0) return '0.00';
  return precise.replace(/(\.\d{2,})0+$/, '$1');
}

/** Render a duration for a human reader, or null when there is no honest duration. */
export function formatElapsed(elapsedMs) {
  if (typeof elapsedMs !== 'number' || !Number.isFinite(elapsedMs) || elapsedMs < 0) return null;
  if (elapsedMs < 1_000) return `${Math.round(elapsedMs)}ms`;
  if (elapsedMs < 60_000) return `${(elapsedMs / 1_000).toFixed(1)}s`;
  const seconds = Math.floor(elapsedMs / 1_000);
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function parseTimestamp(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value !== 'string' || value === '') return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Derive how long a report's subject took, or null when the report cannot say.
 *
 * Cline reports a `session` object with `startedAt`/`endedAt`. MCode reports a bare
 * `sessionId` with no start/end pair, so its last ledger activity is the only anchor
 * available. A live snapshot is bounded by the moment it was captured rather than by the
 * caller's clock, so a report examined later is not silently re-aged.
 */
export function elapsedMsFromReport(report, { now = Date.now() } = {}) {
  const session = report?.session ?? null;
  const snapshot = report?.snapshot ?? null;
  const startedAt = parseTimestamp(session?.startedAt);
  const endedAt = parseTimestamp(session?.endedAt);
  const capturedAt = parseTimestamp(snapshot?.capturedAt);

  if (startedAt !== null && endedAt !== null && endedAt >= startedAt) return endedAt - startedAt;
  if (startedAt !== null && capturedAt !== null && capturedAt >= startedAt) return capturedAt - startedAt;

  const activityAt = parseTimestamp(snapshot?.lastLedgerActivityAt);
  if (activityAt !== null && capturedAt !== null && capturedAt >= activityAt) return capturedAt - activityAt;

  // Activity recorded after the capture means the two timestamps are not a usable pair.
  // Reporting 0 here would claim the spend took no time at all.
  return null;
}

function percentOf(amountUsd, budget) {
  if (!isKnownCostUsd(amountUsd)) return null;
  // A zero budget has no meaningful ratio: any spend is infinitely over it, and no spend
  // sits on the line. Return the one case that has an answer.
  if (budget === 0) return amountUsd === 0 ? 0 : null;
  return Math.round((amountUsd / budget) * 1_000) / 10;
}

function phrasingFor(basis) {
  return BASIS_PHRASING[basis] ?? BASIS_PHRASING.unknown;
}

function subjectFor(sessionId, scope) {
  if (typeof sessionId === 'string' && sessionId !== '') return sessionId;
  return scope === BUDGET_SCOPES.DAY ? 'today' : 'this session';
}

function limitFor(budget, scope) {
  const scopeLabel = scope === BUDGET_SCOPES.DAY ? 'daily' : 'session';
  return budget === 0 ? `a zero ${scopeLabel} budget` : `a $${formatUsd(budget)} ${scopeLabel} budget`;
}

/**
 * Decide whether a known spend is inside a known limit.
 *
 * Pure: no clock, no I/O, no globals. `amountUsd` is the report's total and `budget` is
 * the cap in USD; everything else shapes the alert. Throws only when `budget` is not a
 * usable number, because the CLI parser has already rejected a bad `--budget` before any
 * storage opens, so reaching this point with one is a wiring defect rather than a
 * condition a user can provoke.
 */
export function evaluateBudget({
  amountUsd = null,
  budget,
  coverage = null,
  basis = null,
  sessionId = null,
  elapsedMs = null,
  scope = BUDGET_SCOPES.SESSION,
} = {}) {
  if (typeof budget !== 'number' || !Number.isFinite(budget) || budget < 0) {
    throw new TypeError(`a budget must be a non-negative number of USD, but got ${String(budget)}`);
  }
  if (!SCOPE_VALUES.has(scope)) throw new TypeError(`unsupported budget scope: ${String(scope)}`);

  const known = isKnownCostUsd(amountUsd);
  const reportCoverage = typeof coverage === 'string' && coverage !== '' ? coverage : null;
  // A total the report itself will stand behind. An absent coverage claim is taken at
  // face value: the caller passed a number and said nothing that contradicts it.
  const settled = known && (reportCoverage === null || SETTLED_COVERAGE.has(reportCoverage));

  // Order matters. The unknowable case is resolved before any comparison, so no amount
  // of rearranging the branches below can turn "no price" into "under budget".
  const status = !known
    ? BUDGET_STATUS.UNKNOWN
    : amountUsd > budget
      ? BUDGET_STATUS.EXCEEDED
      : settled
        ? BUDGET_STATUS.OK
        : BUDGET_STATUS.UNKNOWN;

  // The invariant the whole module rests on, re-checked at the point of return. The
  // branch above cannot violate it, so a violation means a future edit reordered the
  // decision; failing loudly beats shipping an unpriced session as "under budget".
  if (status === BUDGET_STATUS.OK && !settled) {
    throw new Error('budget verdict invariant violated: an unsettled total was about to be reported as under budget');
  }

  const reason = status === BUDGET_STATUS.OK
    ? 'under-budget'
    : status === BUDGET_STATUS.EXCEEDED
      ? 'over-budget'
      : known
        ? UNKNOWN_REASONS.unsettled
        : UNKNOWN_REASONS.unpriced;
  const phrasing = phrasingFor(basis);
  const subject = subjectFor(sessionId, scope);
  const limit = limitFor(budget, scope);
  const elapsedLabel = formatElapsed(elapsedMs);
  const totalUsd = known ? amountUsd : null;

  let message = null;
  if (status === BUDGET_STATUS.EXCEEDED) {
    const percent = percentOf(totalUsd, budget);
    const share = percent === null ? '' : ` (${percent}% of the limit)`;
    const elapsed = elapsedLabel === null ? '' : ` in ${elapsedLabel}`;
    message = `budget exceeded: ${subject} ${phrasing.verb} $${formatUsd(totalUsd)} of ${limit}${share}${elapsed}`;
  } else if (status === BUDGET_STATUS.UNKNOWN) {
    const elapsed = elapsedLabel === null ? '' : ` after ${elapsedLabel}`;
    const coverageLabel = reportCoverage ?? 'not reported';
    message = known
      ? `budget not confirmed: ${subject} ${phrasing.verb} $${formatUsd(totalUsd)} of ${limit}, but the report marks the total as ${coverageLabel}, so the limit is not confirmed${elapsed}`
      : `budget not confirmed: ${phrasing.noun} for ${subject} is unknown (coverage: ${coverageLabel}), so ${limit} cannot be checked${elapsed}`;
  }

  return {
    status,
    exitCode: BUDGET_EXIT_CODES[status],
    reason,
    alert: status !== BUDGET_STATUS.OK,
    // Stated in the result so no adapter has to infer it: a budget decides the exit code
    // and nothing else. Nothing in this module can suppress a report.
    blocksOutput: false,
    scope,
    budget,
    amountUsd: totalUsd,
    coverage: reportCoverage,
    basis: typeof basis === 'string' ? basis : null,
    recorded: basis === 'runtime-recorded',
    estimated: basis === 'provider-rate-estimate',
    settled,
    sessionId: typeof sessionId === 'string' && sessionId !== '' ? sessionId : null,
    overByUsd: status === BUDGET_STATUS.EXCEEDED ? roundUsd(amountUsd - budget) : null,
    percentUsed: status === BUDGET_STATUS.OK || status === BUDGET_STATUS.EXCEEDED
      ? percentOf(totalUsd, budget)
      : null,
    elapsedMs: typeof elapsedMs === 'number' && Number.isFinite(elapsedMs) && elapsedMs >= 0 ? elapsedMs : null,
    elapsedLabel,
    message,
  };
}

/**
 * Evaluate a cap against a real normalized report.
 *
 * The same helper serves a session cap and a daily cap; only the scope and the amount
 * change. `billing.coverage` is preferred over `coverage.status` because it is the field
 * that describes the cost specifically.
 */
export function evaluateReportBudget(report, {
  budget,
  scope = BUDGET_SCOPES.SESSION,
  elapsedMs = null,
  now,
} = {}) {
  return evaluateBudget({
    amountUsd: report?.billing?.amountUsd ?? null,
    coverage: report?.billing?.coverage ?? report?.coverage?.status ?? null,
    basis: report?.billing?.basis ?? null,
    sessionId: report?.session?.id ?? report?.sessionId ?? null,
    elapsedMs: elapsedMs ?? elapsedMsFromReport(report, { now }),
    budget,
    scope,
  });
}
