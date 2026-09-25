// Aggregate a normalized report across time and rank the sessions inside it.
//
// Two rules shape everything here. Unknown cost is `null`, never `0`, so a total can never
// absorb an unpriced session as if it were free. And a session that did not fully price stays
// visible in the output rather than being dropped, because a ranking that silently omits
// the expensive-unknown session is worse than no ranking.

// A UTC day bucket. Local-time bucketing would make the same report produce different
// totals depending on where it was run, which breaks reproducibility.
export function dayKey(iso) {
  return String(iso).slice(0, 10);
}

// A UTC week bucket, ISO-8601 style, starting Monday.
export function weekKey(iso) {
  const date = new Date(iso);
  const midnight = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
  const weekday = (new Date(midnight).getUTCDay() + 6) % 7;
  return dayKey(new Date(midnight - weekday * 86_400_000).toISOString());
}

export const ROLLUP_PERIODS = Object.freeze(['daily', 'weekly']);
const keyFor = { daily: dayKey, weekly: weekKey };

/** A session's cost, or null when any of its calls were unpriced. */
function sessionCost(metrics) {
  if (!metrics) return null;
  if (Number(metrics.unpricedCalls) > 0) return null;
  if (Number(metrics.calls) === 0) return 0;
  return Number.isFinite(metrics.cost) ? metrics.cost : null;
}

/** Coverage for one session, mirroring the report vocabulary. */
function sessionCoverage(metrics) {
  if (!metrics) return 'unknown';
  if (Number(metrics.calls) === 0) return 'no-calls';
  if (Number(metrics.unpricedCalls) > 0) return 'partial';
  if (metrics.callCountKnown === false) return 'unknown';
  return 'complete';
}

// Number(undefined) is NaN, not undefined, so a nullish fallback never fires. Tokens
// fall back to input+output only when the aggregate genuinely omits the field.
function tokensFor(metrics) {
  const total = Number(metrics?.totalTokens);
  if (Number.isFinite(total)) return total;
  return (Number(metrics?.inputTokens) || 0) + (Number(metrics?.outputTokens) || 0);
}

function emptyBucket() {
  return {
    totalTokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    calls: 0,
    pricedCalls: 0,
    unpricedCalls: 0,
    sessionCount: 0,
    // Accumulated separately so a partial total is never presented as a real one.
    knownCostUsd: 0,
    hasUnknownCost: false,
  };
}

function addSession(bucket, entry) {
  const metrics = entry.metrics ?? {};
  bucket.totalTokens += tokensFor(metrics);
  bucket.inputTokens += Number(metrics.inputTokens) || 0;
  bucket.outputTokens += Number(metrics.outputTokens) || 0;
  bucket.cacheReadTokens += Number(metrics.cacheReadTokens) || 0;
  bucket.cacheWriteTokens += Number(metrics.cacheWriteTokens) || 0;
  bucket.calls += Number(metrics.calls) || 0;
  bucket.pricedCalls += Number(metrics.pricedCalls) || 0;
  bucket.unpricedCalls += Number(metrics.unpricedCalls) || 0;
  bucket.sessionCount += 1;
  const cost = sessionCost(metrics);
  if (cost === null) bucket.hasUnknownCost = true;
  else bucket.knownCostUsd += cost;
  return bucket;
}

function finishBucket(bucket, period) {
  return {
    period,
    totalTokens: bucket.totalTokens,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    calls: bucket.calls,
    pricedCalls: bucket.pricedCalls,
    unpricedCalls: bucket.unpricedCalls,
    sessionCount: bucket.sessionCount,
    // null whenever anything in the bucket was unpriced, so the caller cannot mistake a
    // partial sum for a real total.
    costUsd: bucket.hasUnknownCost ? null : bucket.knownCostUsd,
    knownCostUsd: bucket.knownCostUsd,
    coverage: bucket.hasUnknownCost ? 'partial' : bucket.unpricedCalls > 0 ? 'partial' : bucket.calls === 0 ? 'no-calls' : 'complete',
  };
}

/**
 * Bucket the report's sessions into daily or weekly periods.
 * @param {object} report a normalized report carrying `sessions`
 * @param {{period?: 'daily'|'weekly'}} [options]
 */
export function rollupSessions(report, { period = 'daily' } = {}) {
  if (!ROLLUP_PERIODS.includes(period)) throw new Error(`unsupported rollup period: ${period}`);
  const keyOf = keyFor[period];
  const buckets = new Map();
  for (const entry of report?.sessions ?? []) {
    const startedAt = entry?.row?.startedAt ?? entry?.metrics?.lastTs;
    if (!startedAt) continue;
    const iso = typeof startedAt === 'number' ? new Date(startedAt).toISOString() : String(startedAt);
    const key = keyOf(iso);
    if (!buckets.has(key)) buckets.set(key, emptyBucket());
    addSession(buckets.get(key), entry);
  }
  return [...buckets.entries()]
    .sort(([left], [right]) => (left < right ? -1 : 1))
    .map(([periodStart, bucket]) => ({ periodStart, ...finishBucket(bucket, period) }));
}

/** One row per session, shaped for a ranked table. */
export function rankSessions(report, { top = null } = {}) {
  const rows = (report?.sessions ?? []).map((entry) => {
    const metrics = entry.metrics ?? {};
    const cost = sessionCost(metrics);
    const startedAt = entry?.row?.startedAt ?? null;
    return {
      sessionId: entry?.row?.sessionId ?? null,
      parentSessionId: entry?.row?.parentSessionId ?? null,
      title: metrics.title ?? entry?.row?.title ?? null,
      startedAt: startedAt ? (typeof startedAt === 'number' ? new Date(startedAt).toISOString() : startedAt) : null,
      costUsd: cost,
      coverage: sessionCoverage(metrics),
      calls: Number(metrics.calls) || 0,
      unpricedCalls: Number(metrics.unpricedCalls) || 0,
      totalTokens: tokensFor(metrics),
    };
  });
  // Unknown-cost sessions sort last rather than first, so a partial total never looks
  // like the cheapest thing in the range.
  rows.sort((left, right) => {
    if (left.costUsd === null && right.costUsd === null) return 0;
    if (left.costUsd === null) return 1;
    if (right.costUsd === null) return -1;
    return right.costUsd - left.costUsd;
  });
  return top ? rows.slice(0, top) : rows;
}

/** True when a report carries the per-session rows a rollup needs. */
export function hasSessionRows(report) {
  return Array.isArray(report?.sessions) && report.sessions.length > 0;
}

/**
 * Totals across every session in the report, preserving unknown cost.
 *
 * A report with no per-session rows is reported as unknown, never as a confident zero.
 * "You spent nothing" and "we could not measure this" are different claims, and returning
 * 0 for the second is the exact failure this project exists to prevent. MCode reports
 * currently carry no `sessions` field, so a MCode rollup is `unknown` until it does.
 */
export function rollupTotals(report) {
  const rows = rankSessions(report);
  if (!hasSessionRows(report)) {
    return {
      period: 'total',
      totalTokens: null,
      inputTokens: null,
      outputTokens: null,
      cacheReadTokens: null,
      cacheWriteTokens: null,
      calls: null,
      pricedCalls: null,
      unpricedCalls: null,
      sessionCount: 0,
      costUsd: null,
      knownCostUsd: null,
      coverage: 'unknown',
      reason: 'this report carries no per-session rows, so no total can be computed',
      sessions: 0,
    };
  }
  const bucket = emptyBucket();
  for (const entry of report.sessions) addSession(bucket, entry);
  return { ...finishBucket(bucket, 'total'), sessions: rows.length };
}
