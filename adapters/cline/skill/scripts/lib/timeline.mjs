/**
 * Per-call timeline for a report.
 *
 * A report exposes `calls` as a count, which is enough to say what a session cost and not enough
 * to draw it. A cost-over-time chart, a cache-rate trend, and a "where did the money go" view all
 * need time-ordered events, and every one of those is downstream of this.
 *
 * Two rules shape the design:
 *
 * - **The timeline is computed, never derived later.** Entries are appended by the same code
 *   path that prices the call, so a timeline entry and the total it rolls up to cannot disagree.
 *   Recomputing cost from tokens here would give a second pricing path to keep in sync.
 * - **It is bounded.** A session with a million calls must not produce a million-entry array in a
 *   report that is written to disk and embedded in a dashboard. Past a limit the timeline becomes
 *   fixed-width buckets, and the rollup is asserted to still equal the total.
 *
 * The module is pure and holds no clock of its own: callers pass the timestamp they already have.
 */

/** Calls beyond this are bucketed rather than listed. Chosen to stay small in an embedded report. */
export const DEFAULT_TIMELINE_LIMIT = 2000;

/** Bucket width once bucketing starts. Fine enough to keep a session's shape visible. */
export const DEFAULT_BUCKET_MS = 60_000;

export function createTimeline({ limit = DEFAULT_TIMELINE_LIMIT, bucketMs = DEFAULT_BUCKET_MS } = {}) {
  const entries = [];
  const buckets = new Map();
  let bucketing = false;
  let dropped = 0;

  /** Fold one entry into a bucket, preserving the unknown-cost rule. */
  function foldInto(map, entry, width) {
    const key = Math.floor(Date.parse(entry.t) / width) * width;
    const existing = map.get(key);
    if (!existing) { map.set(key, { ...entry, t: new Date(key).toISOString(), sessionId: null, model: null, provider: null }); return; }
    existing.input += entry.input; existing.output += entry.output;
    existing.cacheRead += entry.cacheRead; existing.cacheWrite += entry.cacheWrite;
    if (entry.costUsd === null || entry.costUsd === undefined) existing.costUsd = null;
    else if (existing.costUsd !== null) existing.costUsd += entry.costUsd;
  }

  return {
    /**
     * Record one call. `costUsd` must be null when the call could not be priced - a timeline that
     * showed a confident number for an unpriced call would break principle 1 in a place no report
     * assertion currently looks.
     */
    add({ t, sessionId = null, model = null, provider = null, input = 0, output = 0, cacheRead = 0, cacheWrite = 0, costUsd = null }) {
      const at = typeof t === 'number' ? t : Date.parse(t);
      if (!Number.isFinite(at)) return; // an unusable timestamp is skipped, never guessed
      const entry = { t: new Date(at).toISOString(), sessionId, model, provider, input, output, cacheRead, cacheWrite, costUsd };
      // Bucketing is all-or-nothing. A half-and-half timeline - the first `limit` calls listed
      // and the rest bucketed - silently drops the calls that fall between a bucket edge and the
      // first bucket, so the rollup stops equalling the total. The first time the limit is
      // exceeded, everything already collected is folded into buckets too.
      if (!bucketing && entries.length + buckets.size < limit) { entries.push(entry); return; }
      if (!bucketing) {
        bucketing = true;
        for (const listed of entries.splice(0)) foldInto(buckets, listed, bucketMs);
      }
      const key = Math.floor(at / bucketMs) * bucketMs;
      const existing = buckets.get(key);
      if (existing) {
        existing.input += input; existing.output += output;
        existing.cacheRead += cacheRead; existing.cacheWrite += cacheWrite;
        // A bucket is unknown if *any* call in it is unknown. Summing prices and dropping the
        // unpriced ones would make a bucket look cheaper than the truth, which is the exact
        // failure the report contract forbids.
        if (costUsd === null) existing.costUsd = null;
        else if (existing.costUsd !== null) existing.costUsd += costUsd;
      } else {
        buckets.set(key, { t: new Date(key).toISOString(), sessionId: null, model: null, provider: null, input, output, cacheRead, cacheWrite, costUsd });
      }
    },

    get size() { return entries.length; },

    /** Finish, returning either the entries or the buckets plus the metadata describing them. */
    finalize() {
      if (buckets.size === 0) {
        return dropped === 0
          ? { timeline: entries, timelineMeta: null }
          : { timeline: entries, timelineMeta: { bucketed: true, limit, bucketMs, droppedCalls: dropped } };
      }
      const merged = [...buckets.values()].sort((left, right) => left.t.localeCompare(right.t));
      return {
        timeline: merged,
        timelineMeta: { bucketed: true, limit, bucketMs, bucketCount: merged.length, droppedCalls: dropped, note: 'entries are time buckets, not individual calls' },
      };
    },
  };
}

/**
 * The sum of a timeline's known costs, for the invariant that a timeline must roll up to the
 * report's own total. Returns null when any entry is unknown, matching how the report itself
 * represents an unpriceable session.
 */
export function timelineTotalUsd(timeline) {
  let total = 0;
  for (const entry of timeline ?? []) {
    if (entry.costUsd === null || entry.costUsd === undefined) return null;
    total += entry.costUsd;
  }
  return total;
}
