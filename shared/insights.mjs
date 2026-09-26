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
 */
export function historyEntries(history) {
  if (!history) return [];
  const source = Array.isArray(history) ? history : [history];
  const rows = [];
  for (const item of source) {
    if (Array.isArray(item?.sessions)) rows.push(...item.sessions);
    else if (item && typeof item === 'object') rows.push(item);
  }
  return rows;
}

/** The session's id, or null. A missing id is reported rather than assumed. */
export function sessionIdOf(entry) {
  const id = entry?.row?.sessionId;
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
function insufficientReason({ availableSessions, thinnestSample, minSamples, unmeasurableMetrics }) {
  if (!availableSessions) {
    return {
      code: 'no-history',
      message: `no prior sessions were supplied, so there is no baseline to compare against; at least ${minSessions} measured session(s) are required`,
      availableSessions: 0,
      usableValues: 0,
      required: minSamples,
    };
  }
  if (!unmeasurableMetrics) {
    return {
      code: 'sample-too-small',
      message: `${availableSessions} prior session(s) were available, of which ${thinnestSample} carried a measured value; ${minSamples} are required, so no comparison was made`,
      availableSessions,
      usableValues: thinnestSample,
      required: minSamples,
    };
  }
  return {
    code: 'target-unmeasurable',
    message: `${availableSessions} prior session(s) were available, but this session could not supply the measured value for ${unmeasurableMetrics} metric(s), so no comparison was made`,
    availableSessions,
    usableValues: thinnestSample,
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
  const minSamples = Number.isInteger(options.minSamples) && options.minSamples >= 1
    ? options.minSamples
    : MIN_BASELINE_SESSIONS;
  const notableRatio = finite(options.notableRatio) && options.notableRatio > 1 ? options.notableRatio : 2;

  const { unique, duplicatesDropped } = dedupeEntries(historyEntries(history));
  const targetId = sessionIdOf(session);

  // Remove the target from the history. By id where it has one, by identity where it does
  // not, and the basis used is reported so the exclusion can be checked.
  let excludedBy = 'none';
  const prior = [];
  for (const candidate of unique) {
    if (candidate.entry === session) { excludedBy = excludedBy === 'none' ? 'object-identity' : excludedBy; continue; }
    if (targetId && candidate.id === targetId) { excludedBy = 'session-id'; continue; }
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
  let thinnestSample = null;

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
    if (stats) baseline?.metrics[metric] = stats;
    const sampleSize = stats ? stats.n : 0;
    if (thinnestSample === null || sampleSize < thinnestSample) thinnestSample = sampleSize;

    if (!stats || sampleSize < minSamples) {
      deviations.push({
        ...deviationShell(metric, reader, sampleSize, minSamples),
        status: DEVIATION_STATUS.INSUFFICIENT,
        note: stats
          ? `${sampleSize} prior session(s) carried a measurable ${reader.label} and ${minSamples} are required`
          : `no prior session carried a measurable ${reader.label}, so there is nothing to compare against`,
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
      : insufficientReason({ availableSessions: prior.length, thinnestSample, minSamples, unmeasurableMetrics }),
  };
}

// @@INSIGHTS-TAIL@@
