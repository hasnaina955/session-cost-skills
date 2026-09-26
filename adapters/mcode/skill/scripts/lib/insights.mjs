// Compare a session against the user's own recent history, and name the recurring spend
// drivers measured across a range.
//
// This file carries one permanent constraint that outranks every feature request: it never
// projects. Predicting future spend is not "deferred to a later issue", it is refused, because
// a number with no measurement behind it is the one output a reader cannot check. So there is
// no horizon parameter, no rate argument, and no code path that reads anything except sessions
// that already happened. Every result object carries `basis: 'measured-history'` and
// `scope: 'past-only'` so a caller cannot relabel the output as a projection.
//
// Three further rules, each here because the tempting shortcut is a lie:
//
//   1. Too little history says so. A median over two sessions is one of those two sessions,
//      so `MIN_BASELINE_SESSIONS` gates every comparison and a failure reports the sample
//      size that failed the gate. A missing baseline is never replaced by an invented one.
//   2. The baseline is stated in full: method, sample size, the window, and the session ids
//      it came from, so every flag is falsifiable by hand. A flag nobody can check is a
//      rumour with arithmetic attached.
//   3. Unknown cost is `null`, never `0`. An unpriced session is left out of the baseline
//      rather than counted as free, and a metric the target cannot supply is
//      `not-comparable` rather than a zero that would flatter it.
//
// A session row is the report's own `{row, metrics}` shape. `row` carries identity and timing
// (`sessionId`, `parentSessionId`, `startedAt`, `endedAt`); `metrics` carries the measured
// quantities. Nothing else is consulted, and nothing is inferred from a session not present.

export const INSIGHTS_BASIS = 'measured-history';
export const INSIGHTS_SCOPE = 'past-only';

/**
 * The smallest sample a comparison may be built from.
 *
 * Two is the count a user can already do in their head, and one is just a copy of the target
 * session. Five is the point where a median stops being an echo of its own inputs. Callers
 * may raise it; they may not obtain a comparison without it.
 */
export const MIN_BASELINE_SESSIONS = 5;

export const INSIGHTS_STATUS = Object.freeze({
  COMPARED: 'compared',
  INSUFFICIENT: 'insufficient-data',
});

/** Per-metric outcomes. `not-comparable` is distinct from `insufficient-data`: the history is
 *  fine and the target is the problem, so blaming the sample size would be wrong. */
export const DEVIATION_STATUS = Object.freeze({
  COMPARED: 'compared',
  INSUFFICIENT: 'insufficient-data',
  NOT_COMPARABLE: 'not-comparable',
});

/** The metrics a session can be compared on, all measured from its own row. */
export const INSIGHTS_METRICS = Object.freeze([
  'cost',
  'cacheHitRate',
  'cacheReadTokens',
  'calls',
  'subagentCount',
  'durationMs',
]);

/**
 * The two denominators the runtimes actually use for a cache-hit rate, and the reason a
 * caller must choose rather than let this file guess.
 *
 * Cline divides cached reads by `inputTokens` (which already includes cache). MCode divides
 * by `promptTokens` (input plus cache writes). The two differ, so computing one silently
 * would produce a rate the ledger never reported. Naming the basis is the only honest option,
 * and omitting it yields `not-comparable` rather than a guess.
 */
export const CACHE_RATE_BASES = Object.freeze([
  'input-including-cache',
  'prompt-including-cache-write',
]);

// Long enough that a real history is fully listed and auditable; a longer one is counted
// rather than truncated into silence.
const MAX_STATED_SAMPLE_IDS = 50;

const WEEKDAYS = Object.freeze(['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']);
const UTC_DAY_MS = 86_400_000;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
/**
 * A session's measured cost in USD, or `null` when any of its calls were unpriced.
 *
 * Mirrors the rollup rule exactly, and for the same reason: an unpriced session folded in as
 * zero drags a median down and makes the unknown session look like the cheap one. A session
 * with no calls is a real `0`, because "measured nothing" is not the same claim as "not
 * measured".
 */
export function sessionCostUsd(entry) {
  const metrics = entry?.metrics ?? null;
  if (!metrics) return null;
  if ((Number(metrics.calls) || 0) === 0) return 0;
  if (Number(metrics.unpricedCalls) > 0) return null;
  return finite(metrics.cost) ? metrics.cost : null;
}

/**
 * Flatten whatever a caller has into a list of session rows.
 *
 * Accepts a list of rows, a single report, or a list of reports. Reports are flattened rather
 * than assumed to be single-session, because the history of "what you normally do" comes from
 * a range of them.
 *
 * A report that carries no `sessions[]` contributes nothing rather than being mistaken for a
 * row. Treating the report object itself as a session would invent a session that never
 * happened, with a cost read from the wrong place, and every total built on top of it would be
 * quietly fabricated.
 */
export function historyEntries(history) {
  if (!history) return [];
  const source = Array.isArray(history) ? history : [history];
  const rows = [];
  for (const item of source) {
    if (!item || typeof item !== 'object') continue;
    if (Array.isArray(item.sessions)) rows.push(...item.sessions.filter((row) => row && typeof row === 'object'));
    else if ('row' in item || 'metrics' in item) rows.push(item);
  }
  return rows;
}

/** The session's id, or null. A missing id is reported rather than assumed. */
// A session row arrives in several shapes: `{row:{sessionId}}` from a report, a flat
// `{sessionId}`, or `{id}`. Reading only one of them made a real report render as
// "unknown session" even though the id was right there.
export function sessionIdOf(entry) {
  const id = entry?.row?.sessionId ?? entry?.sessionId ?? entry?.id;
  return typeof id === 'string' && id ? id : null;
}

function startedAtOf(entry) {
  const startedAt = entry?.row?.startedAt ?? entry?.metrics?.lastTs ?? null;
  if (startedAt == null) return null;
  if (typeof startedAt === 'number') {
    const date = new Date(startedAt);
    return Number.isFinite(date.getTime()) ? date.toISOString() : null;
  }
  const parsed = Date.parse(String(startedAt));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function endedAtOf(entry) {
  const endedAt = entry?.row?.endedAt ?? null;
  if (endedAt == null) return null;
  const parsed = Date.parse(String(endedAt));
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

// ------------------------------------------------------------------ statistics

/** A linearly interpolated quantile over an already-sorted array. */
function quantile(sorted, fraction) {
  if (!sorted.length) return null;
  if (sorted.length === 1) return sorted[0];
  const position = (sorted.length - 1) * fraction;
  const low = Math.floor(position);
  const high = Math.ceil(position);
  if (low === high) return sorted[low];
  return sorted[low] + (sorted[high] - sorted[low]) * (position - low);
}

/**
 * The reference distribution for one metric, kept together with the ids it came from.
 *
 * The median is the reference because the whole point is to spot the session that sat far
 * outside normal, and a mean is dragged by that very session. Quartiles and extremes are kept
 * alongside it because a median with nothing to compare against is just a number.
 */
function distribution(samples, unit) {
  const sorted = samples.filter((sample) => finite(sample.value)).slice().sort((left, right) => left.value - right.value);
  const values = sorted.map((sample) => sample.value);
  const stated = sorted.slice(0, MAX_STATED_SAMPLE_IDS);
  return {
    n: values.length,
    unit,
    median: quantile(values, 0.5),
    p25: quantile(values, 0.25),
    p75: quantile(values, 0.75),
    min: values.length ? values[0] : null,
    max: values.length ? values[values.length - 1] : null,
    // The value and the session that produced it, side by side, so the median can be
    // recomputed by hand instead of taken on trust.
    samples: stated,
    sessionIds: stated.map((sample) => sample.sessionId),
    sessionIdsCount: values.length,
    sessionIdsTruncated: values.length > stated.length,
  };
}

/** A UTC day key, matching the rollup convention: local-time buckets would make the same
 *  ledger produce different answers depending on where the report was run. */
export function utcDayKey(iso) {
  return String(iso).slice(0, 10);
}

function weekdayOf(iso) {
  const date = new Date(iso);
  return WEEKDAYS[new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())).getUTCDay()];
}

// ------------------------------------------------------------------ metric readers
//
// Every reader returns `{ value, basis?, note? }` rather than a bare number, because a metric
// that could not be measured has to carry the reason it could not be measured. Returning
// `null` alone would force the caller to guess between "zero", "unknown", and "not applicable".

function readCost(entry) {
  const value = sessionCostUsd(entry);
  if (value === null) {
    const calls = Number(entry?.metrics?.calls) || 0;
    const priced = Number(entry?.metrics?.pricedCalls) || 0;
    return {
      value: null,
      note: calls > 0
        ? `${calls - priced} of ${calls} call(s) carry no rate, so this session's cost is unavailable rather than low`
        : 'this session row carries no cost, so it cannot be compared on cost',
    };
  }
  return { value };
}

function readCacheHitRate(entry, context) {
  const metrics = entry?.metrics ?? {};
  // A row that already carries its own rate is taken as measured, whichever runtime wrote it.
  const recorded = Number(metrics.cacheHitRate ?? metrics.cacheRate);
  if (finite(recorded)) return { value: recorded, basis: 'as-recorded-on-the-session-row' };

  const basis = context?.cacheRateBasis;
  if (!CACHE_RATE_BASES.includes(basis)) {
    return {
      value: null,
      note: `a cache-hit rate needs its denominator named: the runtimes divide by different totals, so pass cacheRateBasis as one of ${CACHE_RATE_BASES.join(' | ')}`,
    };
  }
  const input = Number(metrics.inputTokens) || 0;
  const cacheRead = Number(metrics.cacheReadTokens) || 0;
  const cacheWrite = Number(metrics.cacheWriteTokens) || 0;
  const denominator = basis === 'input-including-cache' ? input : input + cacheRead + cacheWrite;
  if (!(denominator > 0)) {
    return { value: null, basis, note: 'this session row carries no input tokens, so the rate has no denominator' };
  }
  return { value: cacheRead / denominator, basis };
}

function readCacheReadTokens(entry) {
  const value = Number(entry?.metrics?.cacheReadTokens);
  return { value: finite(value) ? value : 0 };
}

function readCalls(entry) {
  const metrics = entry?.metrics ?? {};
  if (metrics.callCountKnown === false) {
    return { value: null, note: 'the ledger did not record a call count for this session, so the count is unavailable rather than small' };
  }
  return { value: Number(metrics.calls) || 0 };
}

function readSubagentCount(entry, context) {
  const id = sessionIdOf(entry);
  if (!id) return { value: null, note: 'this session row carries no id, so its subagents cannot be counted' };
  const children = (context?.entries ?? []).filter((other) => other?.row?.parentSessionId === id);
  return {
    value: children.length,
    subagentIds: children.map(sessionIdOf).filter(Boolean),
    note: 'counted from the sessions present in this set; a child outside the set is not counted',
  };
}

function readDurationMs(entry) {
  const startedAt = startedAtOf(entry);
  const endedAt = endedAtOf(entry);
  if (!startedAt || !endedAt) return { value: null, note: 'this session row carries no usable start and end time' };
  const span = Date.parse(endedAt) - Date.parse(startedAt);
  if (span < 0) return { value: null, note: 'this session row ends before it starts, so the duration is unusable' };
  return { value: span };
}

const METRIC_READERS = Object.freeze({
  cost: { label: 'cost', unit: 'usd', read: readCost },
  cacheHitRate: { label: 'cache-hit rate', unit: 'ratio', read: readCacheHitRate },
  cacheReadTokens: { label: 'cached input tokens', unit: 'tokens', read: readCacheReadTokens },
  calls: { label: 'LLM calls', unit: 'calls', read: readCalls },
  subagentCount: { label: 'subagents', unit: 'sessions', read: readSubagentCount },
  durationMs: { label: 'duration', unit: 'ms', read: readDurationMs },
});

/** The metrics a caller may request, validated rather than silently defaulted. */
export function resolveMetrics(metrics) {
  if (metrics == null) return INSIGHTS_METRICS.slice();
  const requested = (Array.isArray(metrics) ? metrics : [metrics]).map(String);
  const unknown = requested.filter((metric) => !METRIC_READERS[metric]);
  if (unknown.length) throw new Error(`unsupported insights metric: ${unknown.join(', ')}`);
  if (!requested.length) throw new Error('unsupported insights metric: none requested');
  return requested;
}

// ------------------------------------------------------------------ formatting
//
// One shared formatter per unit, so a number can never mean one thing in a comparison and
// another in a summary. An unmeasurable value prints as a word, never as a digit: `$0.000000`
// and "unavailable" are the difference between "free" and "not measured".

const UNKNOWN_TEXT = 'unavailable';

export function formatUsd(value) {
  return finite(value) ? `$${value.toFixed(6)}` : UNKNOWN_TEXT;
}

export function formatRate(value) {
  return finite(value) ? `${(value * 100).toFixed(1)}%` : UNKNOWN_TEXT;
}

export function formatCount(value) {
  return finite(value) ? String(Math.round(value)) : UNKNOWN_TEXT;
}

export function formatDuration(ms) {
  if (!finite(ms) || ms < 0) return UNKNOWN_TEXT;
  const total = Math.round(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  if (hours) return `${hours}h ${minutes}m`;
  if (minutes) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

const FORMATTERS = Object.freeze({
  usd: formatUsd,
  ratio: formatRate,
  tokens: formatCount,
  calls: formatCount,
  sessions: formatCount,
  ms: formatDuration,
});

/** Format a measured value in the unit its metric was measured in. */
export function formatMetric(value, unit) {
  const formatter = FORMATTERS[unit] ?? formatCount;
  return formatter(value);
}

// ------------------------------------------------------------------ baseline comparison

/**
 * Deduplicate session rows by id.
 *
 * A session reachable from two reports in a range is one session, and counting it twice
 * would silently weight the baseline towards whatever the caller happened to select.
 */
function dedupeEntries(entries) {
  const seen = new Set();
  const unique = [];
  let duplicatesDropped = 0;
  let anonymous = 0;
  for (const entry of entries) {
    const id = sessionIdOf(entry);
    const key = id ?? `anonymous#${anonymous++}`;
    if (seen.has(key)) { duplicatesDropped += 1; continue; }
    seen.add(key);
    unique.push({ entry, id });
  }
  return { unique, duplicatesDropped };
}

// A one-line statement of what a baseline is, for output the reader can check.
function baselineStatement(baseline) {
  if (!baseline) return 'no baseline was established';
  const count = baseline.availableSessions;
  const plural = count === 1 ? 'session' : 'sessions';
  const window = baseline.window ? ` between ${baseline.window.from} and ${baseline.window.to}` : '';
  return `median of ${count} prior ${plural}${window}`;
}

/**
 * The baseline, as a sentence. Exported so a caller cannot print a comparison without the
 * thing it was compared against.
 */
export function describeBaseline(baseline) {
  return baselineStatement(baseline);
}

function buildBaselineWindow(prior) {
  const starts = prior.map(({ entry }) => startedAtOf(entry)).filter(Boolean).sort();
  if (!starts.length) return null;
  return { from: starts[0], to: starts[starts.length - 1] };
}

/** The fields every deviation carries, whatever its outcome. */
function deviationShell(metric, reader, sampleSize, required) {
  return {
    metric,
    label: reader.label,
    unit: reader.unit,
    status: DEVIATION_STATUS.INSUFFICIENT,
    value: null,
    baseline: null,
    baselineStats: null,
    ratio: null,
    ratioText: null,
    ratioNote: null,
    notable: false,
    note: null,
    sampleSize,
    required,
    sentence: '',
  };
}

/**
 * One deviation, as a sentence, with no adjective in it.
 *
 * The brief is "this session used forty times your median cached-input volume", not "this
 * session was expensive". A reader can act on the first; the second is a verdict from a tool
 * that does not know what the session was for. So the numbers, the multiple, and the sample
 * size, and nothing about whether any of it is good.
 */
function describeDeviation(deviation, baseline) {
  const { label, unit, status, value, baseline: reference, ratioText, sampleSize } = deviation;
  const against = baseline ? baselineStatement(baseline) : 'no baseline';
  if (status === DEVIATION_STATUS.COMPARED) {
    const multiple = ratioText ? `, ${ratioText} the median of ${sampleSize} prior session(s)` : '';
    return `${label}: ${formatMetric(value, unit)} against a baseline of ${formatMetric(reference, unit)}${multiple} (${against})`;
  }
  if (status === DEVIATION_STATUS.NOT_COMPARABLE) {
    return `${label}: not compared - ${deviation.note}. The baseline itself holds ${sampleSize} prior session(s).`;
  }
  return `${label}: not compared - ${deviation.note}. Nothing was substituted for the missing baseline.`;
}

/**
 * Why no comparison was made, stated with the sample size that caused it.
 *
 * The three causes are kept apart on purpose. "No history at all", "history too thin", and
 * "this session could not be measured" call for different actions, and collapsing them into
 * one vague "not enough data" would hide which one happened.
 */
function insufficientReason({ availableSessions, bestSample, minSamples, unmeasurableMetrics }) {
  if (!availableSessions) {
    return {
      code: 'no-history',
      message: `no prior sessions were supplied, so there is no baseline to compare against; at least ${minSamples} measured session(s) are required`,
      availableSessions: 0,
      usableValues: 0,
      required: minSamples,
    };
  }
  if (!unmeasurableMetrics) {
    return {
      code: 'sample-too-small',
      message: `${availableSessions} prior session(s) were available, of which ${bestSample} carried a measured value for the best-supported metric; ${minSamples} are required, so no comparison was made`,
      availableSessions,
      usableValues: bestSample,
      required: minSamples,
    };
  }
  return {
    code: 'target-unmeasurable',
    message: `${availableSessions} prior session(s) were available, but this session could not supply the measured value for ${unmeasurableMetrics} metric(s), so no comparison was made`,
    availableSessions,
    usableValues: bestSample,
    required: minSamples,
  };
}

/**
 * Compare one session against the user's own recent history.
 *
 * @param {object} session a `{row, metrics}` session row, as the report carries it
 * @param {object|object[]} history prior session rows, or reports carrying `sessions[]`
 * @param {object} [options]
 * @param {string[]} [options.metrics] which metrics to compare; defaults to all of them
 * @param {number} [options.minSamples] the sample floor; defaults to MIN_BASELINE_SESSIONS
 * @param {string} [options.cacheRateBasis] required before a cache-hit rate is computed
 * @param {number} [options.notableRatio] the multiple at which a deviation is marked; the
 *   mark is arithmetic, and the number that produced it travels with the result
 * @returns {{status: 'compared'|'insufficient-data', baseline: object|null, deviations: object[]}}
 *
 * The two ways this returns nothing, both deliberate:
 *
 *   `insufficient-data`  the history is too thin to compare against. The result carries the
 *                         sample size that failed the gate, and no deviations. A comparison is
 *                         never synthesised to fill the gap, because a baseline invented from
 *                         one or two sessions is just one of those sessions wearing a hat.
 *   `not-comparable`     the history is fine and this session cannot supply the metric, so
 *                         the metric is skipped and says why. Only ever a per-metric state.
 *
 * The target session is removed from its own baseline first. A session forty times its own
 * median is arithmetic, not a finding.
 */
export function compareToBaseline(session, history, options = {}) {
  const metrics = resolveMetrics(options.metrics);
  // The floor can be raised by a caller who wants stricter evidence, never lowered: the point
  // of MIN_BASELINE_SESSIONS is that no caller can talk this module into a comparison built
  // from one or two sessions.
  const minSamples = Math.max(
    MIN_BASELINE_SESSIONS,
    Number.isInteger(options.minSamples) && options.minSamples >= 1 ? options.minSamples : 0,
  );
  const notableRatio = finite(options.notableRatio) && options.notableRatio > 1 ? options.notableRatio : 2;

  const { unique, duplicatesDropped } = dedupeEntries(historyEntries(history));
  const targetId = sessionIdOf(session);

  // Remove the target from the history. By id where it has one, by identity where it does
  // not, and the basis used is reported so the exclusion can be checked.
  let excludedBy = 'none';
  const prior = [];
  for (const candidate of unique) {
    // The id check comes first: when a caller passes the target's own row, the meaningful
    // statement is that its session id was excluded, not that a duplicate object was found.
    if (targetId && candidate.id === targetId) { excludedBy = 'session-id'; continue; }
    if (candidate.entry === session) { excludedBy = excludedBy === 'none' ? 'object-identity' : excludedBy; continue; }
    prior.push(candidate);
  }

  // Subagent counts and durations are properties of the whole set, not of one row in
  // isolation, so the readers see the target together with everything the caller supplied.
  const context = {
    entries: [...prior.map((candidate) => candidate.entry), ...(session ? [session] : [])],
    cacheRateBasis: options.cacheRateBasis ?? null,
  };

  const window = buildBaselineWindow(prior);
  const baseline = prior.length
    ? {
      method: 'median',
      minSamples,
      availableSessions: prior.length,
      window,
      sessionIds: prior.map((candidate) => candidate.id).filter(Boolean).slice(0, MAX_STATED_SAMPLE_IDS),
      sessionIdsCount: prior.length,
      sessionIdsTruncated: prior.length > MAX_STATED_SAMPLE_IDS,
      excludedTarget: unique.length - prior.length,
      excludedTargetBy: excludedBy,
      duplicatesDropped,
      metrics: {},
      statement: '',
    }
    : null;
  if (baseline) baseline.statement = baselineStatement(baseline);

  const deviations = [];
  let comparedMetrics = 0;
  let unmeasurableMetrics = 0;
  // The largest sample any metric reached, which is the one worth quoting when the comparison
  // fails: it is the closest any of them came to being measurable.
  let bestSample = 0;

  for (const metric of metrics) {
    const reader = METRIC_READERS[metric];
    const samples = [];
    for (const candidate of prior) {
      const read = reader.read(candidate.entry, context);
      if (finite(read.value)) samples.push({ sessionId: candidate.id, value: read.value });
    }
    const read = session
      ? reader.read(session, context)
      : { value: null, note: 'no session row was supplied' };

    const stats = samples.length ? distribution(samples, reader.unit) : null;
    if (stats && baseline) baseline.metrics[metric] = stats;
    const sampleSize = stats ? stats.n : 0;
    if (sampleSize > bestSample) bestSample = sampleSize;

    if (!stats || sampleSize < minSamples) {
      // When the target's own read could not produce a value either, its reason is the more
      // useful half of the story: "no baseline" helps nobody, "no baseline because the
      // denominator was never named" tells the reader what to do.
      const reason = stats
        ? `${sampleSize} prior session(s) carried a measurable ${reader.label} and ${minSamples} are required`
        : `no prior session carried a measurable ${reader.label}, so there is nothing to compare against`;
      const hint = !finite(read.value) && read.note ? ` (${read.note})` : '';
      deviations.push({
        ...deviationShell(metric, reader, sampleSize, minSamples),
        status: DEVIATION_STATUS.INSUFFICIENT,
        note: `${reason}${hint}`,
      });
      continue;
    }

    if (!finite(read.value)) {
      unmeasurableMetrics += 1;
      deviations.push({
        ...deviationShell(metric, reader, sampleSize, minSamples),
        status: DEVIATION_STATUS.NOT_COMPARABLE,
        baseline: stats.median,
        baselineStats: stats,
        note: read.note ?? `this session carries no measurable ${reader.label}`,
      });
      continue;
    }

    comparedMetrics += 1;
    // A median of zero has no meaningful ratio: dividing by it would print Infinity, and
    // "infinitely more than usual" is a statement about the baseline, not about this session.
    const ratio = stats.median > 0 ? read.value / stats.median : null;
    deviations.push({
      ...deviationShell(metric, reader, sampleSize, minSamples),
      status: DEVIATION_STATUS.COMPARED,
      value: read.value,
      baseline: stats.median,
      baselineStats: stats,
      ratio,
      ratioText: ratio === null ? null : `${ratio.toFixed(1)}x`,
      ratioNote: ratio === null
        ? `the median ${reader.label} across these ${sampleSize} session(s) is 0, so a multiple of it would divide by zero`
        : null,
      // Arithmetic only, and the threshold that produced it is reported alongside.
      notable: ratio !== null && (ratio >= notableRatio || ratio <= 1 / notableRatio),
      note: read.basis ? `cache-hit rate basis: ${read.basis}` : (read.note ?? null),
    });
  }

  for (const deviation of deviations) deviation.sentence = describeDeviation(deviation, baseline);

  const status = comparedMetrics > 0 ? INSIGHTS_STATUS.COMPARED : INSIGHTS_STATUS.INSUFFICIENT;
  return {
    basis: INSIGHTS_BASIS,
    scope: INSIGHTS_SCOPE,
    status,
    minSamples,
    notableRatio,
    session: {
      sessionId: targetId,
      parentSessionId: session?.row?.parentSessionId ?? null,
      title: session?.metrics?.title ?? session?.row?.title ?? null,
      startedAt: startedAtOf(session),
      endedAt: endedAtOf(session),
      costUsd: sessionCostUsd(session),
      costKnown: sessionCostUsd(session) !== null,
      costBasis: options.costBasis ?? null,
    },
    baseline,
    deviations,
    insufficientReason: status === INSIGHTS_STATUS.COMPARED
      ? null
      : insufficientReason({ availableSessions: prior.length, bestSample, minSamples, unmeasurableMetrics }),
  };
}

// ------------------------------------------------------------------ recurring drivers
//
// Everything below aggregates sessions that already happened. There is no per-day rate turned
// into a monthly figure, no average multiplied out to a month, and no "at this rate" line. A
// weekday total is what a weekday cost; it is not a claim about next Tuesday.

/**
 * Per-model rows for a set of reports, from exactly one source.
 *
 * Two adapters, two shapes: a report may carry per-session `metrics.models` maps, or a
 * flat `report.models[]`. Adding them together would count the same tokens twice, so the
 * per-session rows win when present and the report aggregate is used only when they are not.
 * The source used travels with the result so a reader knows which one they are reading.
 */
function collectModelRows(reportList, entries) {
  const fromSessions = [];
  for (const entry of entries) {
    const models = entry?.metrics?.models;
    if (!models || typeof models !== 'object') continue;
    for (const [key, value] of Object.entries(models)) {
      if (value && typeof value === 'object') fromSessions.push({ key, sessionId: sessionIdOf(entry), ...value });
    }
  }
  if (fromSessions.length) return { rows: fromSessions, source: 'per-session model rows' };

  const fromReports = [];
  for (const report of reportList) {
    for (const model of report?.models ?? []) {
      if (!model || typeof model !== 'object') continue;
      const key = `${model.providerKey ?? model.provider ?? 'unknown'}|${model.modelId ?? model.model ?? 'unknown'}`;
      fromReports.push({ key, ...model });
    }
  }
  return { rows: fromReports, source: fromReports.length ? 'report model aggregate' : 'none' };
}

// A model row with no rate attached is unknown, whether the runtime said so with
// `rateKnown: false` or left unpriced calls sitting in `unpricedCalls`.
function rowIsUnpriced(row) {
  return row.rateKnown === false || Number(row.unpricedCalls) > 0;
}

function aggregateModels(rows) {
  const buckets = new Map();
  for (const row of rows) {
    const key = String(row.key ?? `${row.provider ?? 'unknown'}|${row.model ?? 'unknown'}`);
    if (!buckets.has(key)) {
      buckets.set(key, {
        model: row.model ?? row.modelId ?? 'unknown',
        provider: row.provider ?? row.providerKey ?? null,
        calls: 0,
        unpricedCalls: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        knownCostUsd: 0,
        hasUnknownCost: false,
        sessions: new Set(),
      });
    }
    const bucket = buckets.get(key);
    const unpriced = rowIsUnpriced(row);
    bucket.calls += Number(row.calls) || 0;
    bucket.unpricedCalls += Number(row.unpricedCalls) || 0;
    bucket.inputTokens += Number(row.inputTokens) || 0;
    bucket.outputTokens += Number(row.outputTokens) || 0;
    bucket.cacheReadTokens += Number(row.cacheReadTokens) || 0;
    bucket.cacheWriteTokens += Number(row.cacheWriteTokens) || 0;
    if (row.sessionId) bucket.sessions.add(row.sessionId);
    const cost = Number(row.cost ?? row.totalCost);
    if (unpriced || !finite(cost)) bucket.hasUnknownCost = true;
    else bucket.knownCostUsd += cost;
  }

  const aggregated = [...buckets.entries()].map(([key, bucket]) => ({
    key,
    model: bucket.model,
    provider: bucket.provider,
    calls: bucket.calls,
    unpricedCalls: bucket.unpricedCalls,
    inputTokens: bucket.inputTokens,
    outputTokens: bucket.outputTokens,
    cacheReadTokens: bucket.cacheReadTokens,
    cacheWriteTokens: bucket.cacheWriteTokens,
    // null, never 0: an unpriced model must not sit at the bottom of a cost ranking looking
    // like the cheapest thing in the range.
    costUsd: bucket.hasUnknownCost ? null : bucket.knownCostUsd,
    knownCostUsd: bucket.knownCostUsd,
    coverage: bucket.unpricedCalls > 0 || bucket.hasUnknownCost ? 'partial' : bucket.calls === 0 ? 'no-calls' : 'complete',
    // A report-level model row knows nothing about which sessions used it, so the count is
    // unknown rather than zero.
    sessions: bucket.sessions.size || null,
  }));

  // Unknown last, exactly as the rollup ranking does, so a partial cost never reads as cheap.
  aggregated.sort((left, right) => {
    if (left.costUsd === null && right.costUsd === null) return 0;
    if (left.costUsd === null) return 1;
    if (right.costUsd === null) return -1;
    return right.costUsd - left.costUsd;
  });
  return aggregated;
}

/** Bucket sessions by UTC day of their start, keeping unknown cost unknown. */
function aggregateDays(entries) {
  const buckets = new Map();
  let undated = 0;
  for (const entry of entries) {
    const startedAt = startedAtOf(entry);
    if (!startedAt) { undated += 1; continue; }
    const day = utcDayKey(startedAt);
    if (!buckets.has(day)) {
      buckets.set(day, {
        day,
        weekday: weekdayOf(startedAt),
        sessions: 0,
        calls: 0,
        knownCostUsd: 0,
        hasUnknownCost: false,
      });
    }
    const bucket = buckets.get(day);
    bucket.sessions += 1;
    bucket.calls += Number(entry?.metrics?.calls) || 0;
    const cost = sessionCostUsd(entry);
    if (cost === null) bucket.hasUnknownCost = true;
    else bucket.knownCostUsd += cost;
  }
  const days = [...buckets.values()].map((bucket) => ({
    day: bucket.day,
    weekday: bucket.weekday,
    sessions: bucket.sessions,
    calls: bucket.calls,
    costUsd: bucket.hasUnknownCost ? null : bucket.knownCostUsd,
    knownCostUsd: bucket.knownCostUsd,
    coverage: bucket.hasUnknownCost ? 'partial' : bucket.sessions === 0 ? 'no-calls' : 'complete',
  }));
  // Ranked by measured cost, most first, unknowns last. This is a ranking of days that
  // already happened; it is not an ordering of days to come.
  days.sort((left, right) => {
    if (left.costUsd === null && right.costUsd === null) return left.day < right.day ? -1 : 1;
    if (left.costUsd === null) return 1;
    if (right.costUsd === null) return -1;
    if (right.costUsd !== left.costUsd) return right.costUsd - left.costUsd;
    return left.day < right.day ? -1 : 1;
  });
  return { days, undated };
}

/** The same measured days grouped by weekday, so "which day costs most" is answerable. */
function aggregateWeekdays(days) {
  const buckets = new Map();
  for (const day of days) {
    if (!buckets.has(day.weekday)) {
      buckets.set(day.weekday, { weekday: day.weekday, days: 0, sessions: 0, knownCostUsd: 0, hasUnknownCost: false });
    }
    const bucket = buckets.get(day.weekday);
    bucket.days += 1;
    bucket.sessions += day.sessions;
    bucket.knownCostUsd += day.knownCostUsd;
    if (day.costUsd === null) bucket.hasUnknownCost = true;
  }
  const weekdays = [...buckets.values()].map((bucket) => ({
    weekday: bucket.weekday,
    days: bucket.days,
    sessions: bucket.sessions,
    costUsd: bucket.hasUnknownCost ? null : bucket.knownCostUsd,
    knownCostUsd: bucket.knownCostUsd,
    coverage: bucket.hasUnknownCost ? 'partial' : 'complete',
  }));
  weekdays.sort((left, right) => {
    if (left.costUsd === null && right.costUsd === null) return 0;
    if (left.costUsd === null) return 1;
    if (right.costUsd === null) return -1;
    return right.costUsd - left.costUsd;
  });
  return weekdays;
}

/**
 * What each parent's subagents cost, relative to the parent.
 *
 * The share is `null` unless both sides are fully known. An unpriced subagent, an unpriced
 * parent, or a parent that genuinely cost nothing all make the ratio unanswerable, and a
 * small number there would read as "subagents are cheap", which is exactly the claim this
 * project refuses to make from an unmeasured input.
 */
function aggregateSubagents(entries) {
  const perParent = [];
  for (const entry of entries) {
    const id = sessionIdOf(entry);
    if (!id) continue;
    const children = entries.filter((other) => other?.row?.parentSessionId === id);
    if (!children.length) continue;

    const parentCost = sessionCostUsd(entry);
    let knownSubagentCost = 0;
    let hasUnknownSubagent = false;
    for (const child of children) {
      const cost = sessionCostUsd(child);
      if (cost === null) hasUnknownSubagent = true;
      else knownSubagentCost += cost;
    }
    const coverage = hasUnknownSubagent ? 'partial' : parentCost === null ? 'unknown' : 'complete';
    perParent.push({
      parentSessionId: id,
      parentCostUsd: parentCost,
      subagentIds: children.map(sessionIdOf).filter(Boolean),
      subagentCount: children.length,
      subagentCostUsd: hasUnknownSubagent ? null : knownSubagentCost,
      knownSubagentCostUsd: knownSubagentCost,
      share: coverage === 'complete' && parentCost > 0 ? knownSubagentCost / parentCost : null,
      coverage,
      note: hasUnknownSubagent
        ? 'at least one subagent carries no rate, so the share is unavailable rather than small'
        : parentCost === 0
          ? 'the parent session measured $0, so a share of it has no denominator'
          : null,
    });
  }
  perParent.sort((left, right) => {
    const leftShare = left.share ?? -1;
    const rightShare = right.share ?? -1;
    if (leftShare !== rightShare) return rightShare - leftShare;
    return right.knownSubagentCostUsd - left.knownSubagentCostUsd;
  });

  let knownParentCost = 0;
  let knownSubagentTotal = 0;
  let hasUnknown = false;
  for (const row of perParent) {
    if (row.parentCostUsd === null) hasUnknown = true;
    else knownParentCost += row.parentCostUsd;
    if (row.subagentCostUsd === null) hasUnknown = true;
    else knownSubagentTotal += row.subagentCostUsd;
  }
  return {
    perParent,
    aggregate: {
      parents: perParent.length,
      subagents: perParent.reduce((sum, row) => sum + row.subagentCount, 0),
      parentCostUsd: hasUnknown ? null : knownParentCost,
      knownParentCostUsd: knownParentCost,
      subagentCostUsd: hasUnknown ? null : knownSubagentTotal,
      knownSubagentCostUsd: knownSubagentTotal,
      share: !hasUnknown && knownParentCost > 0 ? knownSubagentTotal / knownParentCost : null,
      coverage: hasUnknown ? 'partial' : perParent.length ? 'complete' : 'no-subagents',
    },
  };
}

/**
 * The recurring drivers measured over a range of reports.
 *
 * Top models by measured cost, the days and weekdays that measured most, and what subagents
 * cost relative to their parents. Every figure is a sum, or a share of sums, over sessions that
 * already happened, and every one of them is `null` rather than `0` when part of the range
 * could not be priced.
 *
 * @param {object|object[]} reports one report, a list of reports, or a `{sessions[]}` holder
 * @param {object} [options]
 * @param {number} [options.top] how many models to keep in `topModels`; defaults to 5
 * @param {number} [options.topDays] how many days to keep in `days`; defaults to 5
 */
export function recurringDrivers(reports, options = {}) {
  const reportList = (Array.isArray(reports) ? reports : [reports]).filter((report) => report && typeof report === 'object');
  const entries = historyEntries(reportList);
  const top = Number.isInteger(options.top) && options.top > 0 ? options.top : 5;
  const topDays = Number.isInteger(options.topDays) && options.topDays > 0 ? options.topDays : 5;

  const { days, undated } = aggregateDays(entries);
  const weekdays = aggregateWeekdays(days);
  const { rows: modelRows, source: modelSource } = collectModelRows(reportList, entries);
  const models = aggregateModels(modelRows);
  const subagents = aggregateSubagents(entries);

  // A share of a partly-unknown total would understate every model that IS priced, so a share
  // only appears when the range is fully priced.
  const rangeComplete = models.length > 0 && models.every((model) => model.costUsd !== null);
  const modelKnownCost = models.reduce((sum, model) => sum + model.knownCostUsd, 0);

  // The range total prefers the per-model rows, and falls back to the sessions' own costs when
  // a report carries sessions but no model breakdown. Reporting "unknown" there would throw
  // away six measured session costs because a breakdown was missing.
  const sessionTotals = entries.reduce((totals, entry) => {
    const cost = sessionCostUsd(entry);
    if (cost === null) totals.unknown += 1;
    else totals.known += cost;
    return totals;
  }, { known: 0, unknown: 0 });

  let knownCostUsd = null;
  let rangeCostUsd = null;
  let rangeCoverage = 'unknown';
  let rangeSource = 'none';
  if (models.length) {
    knownCostUsd = modelKnownCost;
    rangeCostUsd = rangeComplete ? modelKnownCost : null;
    rangeCoverage = rangeComplete ? 'complete' : 'partial';
    rangeSource = 'per-model rows';
  } else if (entries.length) {
    knownCostUsd = sessionTotals.known;
    rangeCostUsd = sessionTotals.unknown ? null : sessionTotals.known;
    rangeCoverage = sessionTotals.unknown ? 'partial' : 'complete';
    rangeSource = 'session costs';
  }
  for (const model of models) {
    model.shareOfKnownCost = rangeComplete && modelKnownCost > 0 ? model.costUsd / modelKnownCost : null;
  }

  const starts = entries.map((entry) => startedAtOf(entry)).filter(Boolean).sort();
  const range = {
    from: starts.length ? starts[0] : null,
    to: starts.length ? starts[starts.length - 1] : null,
    sessions: entries.length,
    reports: reportList.length,
    sessionsWithoutStart: undated,
  };

  // A report's own cache-hit rate is taken as measured, with the token semantics that produced
  // it printed alongside, because the two runtimes use different denominators.
  let cacheHitRate = null;
  for (const report of reportList) {
    const value = Number(report?.usage?.cacheHitRate);
    if (finite(value)) {
      cacheHitRate = {
        value,
        inputTokenMeaning: report?.usage?.semantics?.inputTokenMeaning ?? null,
        source: 'as-reported-by-the-runtime',
      };
      break;
    }
  }

  return {
    basis: INSIGHTS_BASIS,
    scope: INSIGHTS_SCOPE,
    // 'measured' when anything at all was measured. A report with no per-session rows can
    // still rank its own models by measured cost, and hiding that behind a blanket
    // "insufficient" would throw away real numbers. What is missing is named in
    // `insufficientReason` and printed ahead of the sections that do hold.
    status: entries.length || models.length ? 'measured' : INSIGHTS_STATUS.INSUFFICIENT,
    range,
    modelSource,
    topModels: models.slice(0, top),
    allModelCount: models.length,
    knownCostUsd,
    rangeCostUsd,
    rangeCoverage,
    rangeSource,
    days: days.slice(0, topDays),
    allDayCount: days.length,
    mostExpensiveDay: days[0] ?? null,
    weekdays,
    mostExpensiveWeekday: weekdays[0] ?? null,
    subagentCostShare: subagents,
    cacheHitRate,
    insufficientReason: entries.length
      ? null
      : {
        code: 'no-session-rows',
        message: models.length
          ? 'these reports carry no per-session rows, so the model costs below are measured but no day, weekday, or subagent share could be measured'
          : 'these reports carry no per-session rows and no per-model rows, so no recurring driver could be measured from them',
      },
  };
}

/**
 * Both halves in one object, shaped for `renderInsightsText`.
 *
 * @param {object} report the report the session came from
 * @param {object|object[]} [history] prior session rows or reports; defaults to the report's own tree
 * @param {object} [options] passed through to both halves
 */
export function buildInsights(report, history, options = {}) {
  const entries = historyEntries(history ?? report);
  const wanted = report?.sessionId ?? options.sessionId ?? null;
  const target = entries.find((entry) => sessionIdOf(entry) === wanted) ?? entries[0] ?? null;
  const range = Array.isArray(history) ? history : [report ?? null].filter(Boolean);
  return {
    comparison: compareToBaseline(target, entries, options),
    drivers: recurringDrivers(range, options),
  };
}

// ------------------------------------------------------------------ text rendering

// Printed on every render, unskippable, so a reader who screenshots one section still has the
// scope of the whole thing in front of them. It is also worded without any of the vocabulary a
// projection would use, so "this output contains no forecast" is checkable by grepping the
// output itself rather than taken on trust.
const DISCLAIMER = 'Measured history only: every number below is a measurement of sessions that already happened. '
  + 'Nothing here makes a claim about spend that has not happened yet.';

const pad = (value, width) => String(value ?? '').padEnd(width);
const padStart = (value, width) => String(value ?? '').padStart(width);

const NO_BASELINE_NOTE = 'no baseline was established, and no comparison was invented in its place';

function comparisonLines(comparison) {
  const out = [];
  const name = comparison.session?.sessionId ?? 'unknown session';
  out.push(`Compared session: ${name}${comparison.session?.startedAt ? `  (started ${comparison.session.startedAt})` : ''}`);
  out.push('');

  if (comparison.status === INSIGHTS_STATUS.INSUFFICIENT) {
    const reason = comparison.insufficientReason;
    out.push('  NOT ENOUGH DATA TO COMPARE');
    out.push(`    reason (${reason?.code ?? 'unknown'}): ${reason?.message ?? 'the history could not be compared'}`);
    out.push(`    ${NO_BASELINE_NOTE}.`);
    out.push(`    sample size ${reason?.availableSessions ?? 0} prior session(s); ${reason?.required ?? comparison.minSamples} required.`);
    return out;
  }

  const baseline = comparison.baseline;
  out.push(`  baseline: ${describeBaseline(baseline)}`);
  out.push(`  sample size ${baseline.availableSessions} prior session(s); ${baseline.minSamples} required; the target was excluded by ${baseline.excludedTargetBy === 'none' ? 'nothing' : baseline.excludedTargetBy}; ${baseline.duplicatesDropped} duplicate row(s) dropped.`);
  out.push(`  A metric is marked * at ${comparison.notableRatio}x the baseline median or less, which is arithmetic, not a verdict.`);
  out.push('');
  out.push(`  ${pad('metric', 22)}${padStart('this session', 15)}${padStart('baseline', 15)}${padStart('multiple', 12)}  n`);
  for (const deviation of comparison.deviations) {
    const marker = deviation.notable ? '*' : ' ';
    // 12 is the width of the longest word this column ever holds, "no baseline", so an
    // unavailable value can never run into the column beside it.
    const multiple = deviation.ratioText ?? (deviation.status === DEVIATION_STATUS.INSUFFICIENT ? 'no baseline' : 'n/a');
    out.push(`  ${pad(`${marker} ${deviation.label}`, 22)}${padStart(formatMetric(deviation.value, deviation.unit), 15)}${padStart(formatMetric(deviation.baseline, deviation.unit), 15)}${padStart(multiple, 12)}  ${deviation.sampleSize}`);
  }
  out.push('');
  for (const deviation of comparison.deviations) {
    out.push(`  ${deviation.sentence}`);
    if (deviation.ratioNote) out.push(`    (${deviation.ratioNote})`);
    else if (deviation.status === DEVIATION_STATUS.COMPARED && deviation.note) out.push(`    (${deviation.note})`);
  }
  const unverifiable = comparison.deviations.find((deviation) => deviation.status === DEVIATION_STATUS.NOT_COMPARABLE);
  if (unverifiable) {
    out.push('');
    out.push(`  ${unverifiable.label} could not be measured for this session, so it is reported as unavailable rather than as a number.`);
  }
  return out;
}

function driverLines(drivers) {
  const out = [];
  const range = drivers.range ?? {};
  const window = range.from && range.to ? `${range.from} .. ${range.to}` : 'an undated range';
  out.push(`Recurring drivers, measured over ${window} across ${range.sessions ?? 0} session(s) in ${range.reports ?? 0} report(s)`);
  out.push('');

  if (drivers.status === INSIGHTS_STATUS.INSUFFICIENT) {
    out.push(`  NOT ENOUGH DATA: ${drivers.insufficientReason?.message ?? 'no per-session rows were available'}.`);
    out.push('  No driver was estimated in place of the missing measurements.');
    return out;
  }
  if (drivers.insufficientReason) {
    out.push(`  NOT ENOUGH DATA FOR EVERY SECTION: ${drivers.insufficientReason.message}.`);
    out.push('  Nothing below was estimated in place of the missing measurements; the sections that');
    out.push('  could be measured are still shown, and the ones that could not are marked unavailable.');
    out.push('');
  }

  out.push(`  range cost: ${formatUsd(drivers.rangeCostUsd)} (coverage: ${drivers.rangeCoverage}, from ${drivers.rangeSource}); known portion ${formatUsd(drivers.knownCostUsd)}`);
  out.push('');

  out.push(`  top models by measured cost (source: ${drivers.modelSource})`);
  if (!drivers.topModels.length) out.push('    none: these reports carry no per-model rows');
  for (const model of drivers.topModels) {
    const share = model.shareOfKnownCost === null ? 'share unavailable' : `${(model.shareOfKnownCost * 100).toFixed(1)}% of the range`;
    const sessions = model.sessions === null ? 'sessions unmeasured' : `${model.sessions} session(s)`;
    out.push(`    ${pad(`${model.provider ? `${model.provider}/` : ''}${model.model}`, 34)}${padStart(formatUsd(model.costUsd), 15)}  ${padStart(`${model.calls} call(s)`, 10)}  ${padStart(sessions, 19)}  ${share}`);
  }
  const unpricedModels = drivers.topModels.filter((model) => model.costUsd === null);
  if (unpricedModels.length) {
    out.push(`    ${unpricedModels.length} model(s) could not be priced and are listed with an unavailable cost rather than $0.`);
  }
  out.push('');

  out.push('  days that measured most (UTC)');
  if (!drivers.days.length) out.push('    none: no session in this range carries a start time');
  for (const day of drivers.days) {
    out.push(`    ${pad(`${day.day} (${day.weekday})`, 24)}${padStart(formatUsd(day.costUsd), 15)}  ${padStart(`${day.sessions} session(s)`, 14)}  ${day.coverage}`);
  }
  out.push('');
  out.push('  weekdays that measured most');
  for (const weekday of drivers.weekdays) {
    out.push(`    ${pad(`${weekday.weekday} (${weekday.days} day(s))`, 24)}${padStart(formatUsd(weekday.costUsd), 15)}  ${padStart(`${weekday.sessions} session(s)`, 14)}  ${weekday.coverage}`);
  }
  out.push('');

  const subagents = drivers.subagentCostShare ?? { perParent: [], aggregate: {} };
  out.push('  subagent cost relative to the parent it belongs to');
  if (!subagents.perParent?.length) out.push('    none: no session in this range has a child in the set');
  for (const row of (subagents.perParent ?? []).slice(0, 5)) {
    const share = row.share === null ? 'share unavailable' : `${(row.share * 100).toFixed(1)}%`;
    out.push(`    ${pad(row.parentSessionId, 24)} subagents ${padStart(formatUsd(row.subagentCostUsd), 15)} of parent ${padStart(formatUsd(row.parentCostUsd), 15)}  ${padStart(share, 18)}  ${row.subagentCount} subagent(s)`);
    if (row.note) out.push(`      ${row.note}`);
  }
  const aggregate = subagents.aggregate ?? {};
  if (aggregate.parents) {
    const share = aggregate.share === null ? 'share unavailable' : `${(aggregate.share * 100).toFixed(1)}%`;
    out.push(`    across the range: subagents ${formatUsd(aggregate.subagentCostUsd)} of ${formatUsd(aggregate.parentCostUsd)} = ${share}, over ${aggregate.parents} parent(s) and ${aggregate.subagents} subagent(s)`);
  }
  out.push('');

  if (drivers.cacheHitRate) {
    const meaning = drivers.cacheHitRate.inputTokenMeaning ? `input semantics: ${drivers.cacheHitRate.inputTokenMeaning}` : 'input semantics unstated';
    out.push(`  cache-hit rate ${formatRate(drivers.cacheHitRate.value)} (${drivers.cacheHitRate.source}; ${meaning})`);
  }
  return out;
}

/**
 * Render insights as plain text for a terminal.
 *
 * Accepts `{comparison, drivers}` from `buildInsights`, or either half on its own: a result
 * carrying `deviations` is a comparison, one carrying `range` is a drivers block. Anything
 * else prints the scope line and says that there was nothing to describe.
 *
 * @param {object} result `{comparison, drivers}`, a comparison, or a drivers block
 * @returns {string}
 */
export function renderInsightsText(result) {
  const comparison = result?.comparison ?? (Array.isArray(result?.deviations) ? result : null);
  const drivers = result?.drivers ?? (result?.range ? result : null);
  const out = ['Insights', '', `  ${DISCLAIMER}`, ''];
  if (comparison) out.push(...comparisonLines(comparison));
  if (drivers) out.push('', ...driverLines(drivers));
  if (!comparison && !drivers) out.push('  nothing to describe: no comparison and no drivers were supplied');
  return out.join('\n');
}

