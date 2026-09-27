/**
 * The reported clock.
 *
 * Every timestamp the tool *reports* - `generatedAt`, snapshot times, "today" boundaries,
 * period windows - comes from here rather than from `Date.now()`, so a test can pin it with
 * `SESSION_COST_NOW` and get byte-identical output. This is what stopped rendered output from
 * changing every day: `tests/rate-provenance.test.mjs` once flipped from pass to fail with no
 * code change because a fixture's relative session dates crossed a bundled rate record's
 * `effectiveFrom` between two consecutive days.
 *
 * This is a test and diagnostics hook, not a user feature. An invalid value fails loudly rather
 * than silently falling back to the real clock, because a silent fallback is the exact bug this
 * module exists to remove.
 *
 * Real-time call sites (the `--watch` poll loop, fetch timeouts) deliberately do NOT use this.
 * They are marked `// clock: real-time` so the source scan in
 * `tests/clock-determinism.test.mjs` can tell the two apart.
 */
export function now(environment = process.env) {
  const fixed = environment.SESSION_COST_NOW;
  if (fixed === undefined || fixed === '') return Date.now();
  const ms = Date.parse(fixed);
  if (!Number.isFinite(ms)) {
    throw new Error('SESSION_COST_NOW must be an ISO-8601 timestamp');
  }
  return ms;
}

/** The reported clock as an ISO-8601 string, the form every report field uses. */
export function isoNow(environment = process.env) {
  return new Date(now(environment)).toISOString();
}

/** The reported clock as a `Date`, for the many call sites that need date arithmetic. */
export function nowDate(environment = process.env) {
  return new Date(now(environment));
}

/** The UTC calendar day (`YYYY-MM-DD`) of the reported clock. */
export function utcDay(environment = process.env) {
  return isoNow(environment).slice(0, 10);
}
