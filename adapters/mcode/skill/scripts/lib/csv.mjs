// CSV projection of a normalized report (contracts/normalized-report-v1.schema.json).
//
// `--json` is the only machine-readable output today, and JSON is a poor fit for the person doing
// the accounting: reconciling a month of spend against a provider invoice means writing a
// conversion script first. This module is that conversion, as a pure function over an
// already-normalized report: no storage, no clock, no filesystem, zero dependencies, so both
// adapters can embed a byte-identical copy.
//
// THREE RULES THIS FILE EXISTS TO ENFORCE
//
// 1. Unknown cost is an EMPTY CELL, never `0`. A spreadsheet that sums `costUsd` must not be able
//    to absorb an unpriced, partially priced, or unrecorded session into a total that looks
//    complete. A charge is written only when the ledger disclosed the whole of it; a disclosed
//    lower bound goes to `knownCostUsd` instead and the row says so in `coverage`.
//    `0` is a legitimate value, written only when the charge is a KNOWN zero: a session with no
//    calls, or a report classified as included/free usage that is therefore not an additional
//    charge. Every other unknown stays empty.
// 2. Every row states `costBasis` and `coverage`, so no cell can be read as a recorded charge when
//    it is a provider-rate estimate, and no row hides behind a plausible number.
// 3. Only the fields listed in CSV_COLUMNS reach a cell. The report also carries configuration,
//    provider drivers, rate provenance, warnings, and billing evidence, none of which belong in a
//    file that gets emailed to an accountant. `title` is the single free-text column.
//
// COLUMN CONTRACT (stable; `coverage` is last so a truncated read still names the row's honesty)
//
//   sessionId        row key, from sessionGraph.includedSessionIds
//   parentSessionId  lineage; empty for a root or an unrecorded parent
//   role             root | child | unknown
//   status           ledger status; empty when unknown
//   startedAt        ISO-8601 UTC; empty when unknown
//   endedAt          ISO-8601 UTC; empty when unknown
//   title            session label verbatim; the only free-text column
//   calls            LLM calls; empty when the call count itself is unknown
//   pricedCalls      calls that carry a cost
//   unpricedCalls    calls that carry no cost
//   inputTokens      input tokens, per the report's own usage semantics
//   outputTokens     output tokens
//   cacheReadTokens  cache-read tokens
//   cacheWriteTokens cache-write tokens
//   totalTokens      all of the above
//   costUsd          the charge, ONLY when fully known; otherwise empty
//   knownCostUsd     everything the ledger disclosed; a lower bound unless coverage is complete
//   costBasis        runtime-recorded | provider-rate-estimate | unknown
//   coverage         complete | partial | no-calls | not-recorded | unavailable | unknown
//
// The row set is exactly `sessionGraph.includedSessionIds`, in that order (falling back to the
// roots when a report states no included set): one row per included session, so a subagent's cost
// is attributable without double counting. A session in `report.sessions` that the graph excluded
// (duplicate-suppressed or excluded descendants) gets no row; an included session the report has
// no data for still gets a row, with empty cells and `coverage` unknown, because silently dropping
// a session is how a total goes missing.
//
// Syntax: RFC 4180 - CRLF record separator, no BOM, `"` doubled inside a quoted field, and a field
// quoted only when it contains a comma, quote, CR, LF, or edge whitespace. An unknown value is
// zero characters between separators, never `""`, which is a real text value and would be
// indistinguishable from a formatted zero to some readers. Numbers are plain decimal with no
// currency symbol, no thousands separator and no exponent, so they import as numbers; the
// shortest form that round-trips to the same double is used, so float noise such as
// 0.18000000000000002 reads as 0.18 while a real cost can never collapse to 0.

const RECORD_SEPARATOR = '\r\n';

// C0/C1 controls other than tab, CR and LF cannot survive a CSV reader, so they are dropped
// instead of written into the file. Tab, CR and LF are preserved: a multi-line title must
// round-trip inside its quoted field.
const UNREPRESENTABLE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;

const MUST_QUOTE = /["\r\n,]/;

// CSV formula injection: a cell a spreadsheet evaluates rather than displays. Neutralizing is
// opt-in (`neutralizeFormulas`) because it rewrites the title, and a title that round-trips
// byte-for-byte is part of this module's contract. A leading `-` counts only when the cell is not
// a number, so a negative amount is never mangled.
const FORMULA_START = /^[=+@\t\r]|^-[^\d.]/;

// A session started after 1973 is the earliest number accepted as an epoch-millisecond timestamp.
// Anything smaller is a unit mix-up (seconds, or a call count), not a session time.
const EARLIEST_EPOCH_MS = 1e11;

export const COST_BASES = Object.freeze(['runtime-recorded', 'provider-rate-estimate', 'unknown']);

export const COVERAGE_VALUES = Object.freeze([
  'complete',
  'partial',
  'no-calls',
  'not-recorded',
  'unavailable',
  'unknown',
]);

// The documented, stable column set. `tests/csv-contract.test.mjs` pins these names and this
// order, and the CLI layer is expected to copy them into user-facing documentation rather than
// re-describe them, so a consumer can rely on the contract instead of on prose.
export const CSV_COLUMNS = Object.freeze([
  { name: 'sessionId', type: 'string', description: 'Session id, from sessionGraph.includedSessionIds.' },
  { name: 'parentSessionId', type: 'string', description: 'Parent session id; empty for a root or an unrecorded parent.' },
  { name: 'role', type: 'root|child|unknown', description: 'Whether the session is a report root or a descendant of one.' },
  { name: 'status', type: 'string', description: 'Ledger status for the session; empty when unknown.' },
  { name: 'startedAt', type: 'date-time', description: 'Session start, ISO-8601 UTC; empty when unknown.' },
  { name: 'endedAt', type: 'date-time', description: 'Session end, ISO-8601 UTC; empty when unknown.' },
  { name: 'title', type: 'string', description: 'Session label verbatim; the only free-text column.' },
  { name: 'calls', type: 'integer', description: 'LLM calls; empty when the call count itself is unknown.' },
  { name: 'pricedCalls', type: 'integer', description: 'Calls that carry a cost.' },
  { name: 'unpricedCalls', type: 'integer', description: 'Calls that carry no cost.' },
  { name: 'inputTokens', type: 'integer', description: 'Input tokens, per the report usage semantics.' },
  { name: 'outputTokens', type: 'integer', description: 'Output tokens.' },
  { name: 'cacheReadTokens', type: 'integer', description: 'Cache-read tokens.' },
  { name: 'cacheWriteTokens', type: 'integer', description: 'Cache-write tokens.' },
  { name: 'totalTokens', type: 'integer', description: 'Input, output, cache-read and cache-write tokens.' },
  { name: 'costUsd', type: 'number', description: 'The charge in USD, only when the whole of it is known; otherwise empty.' },
  { name: 'knownCostUsd', type: 'number', description: 'Every amount the ledger disclosed; a lower bound unless coverage is complete.' },
  { name: 'costBasis', type: COST_BASES.join('|'), description: 'One of COST_BASES.' },
  { name: 'coverage', type: COVERAGE_VALUES.join('|'), description: 'One of COVERAGE_VALUES.' },
].map(Object.freeze));

export const CSV_COLUMN_NAMES = Object.freeze(CSV_COLUMNS.map((column) => column.name));

// Classifications that describe the charge itself rather than one session's slice of it. When a
// report carries one, the verdict holds for each of its rows: a report whose total is a known
// zero charge has no hidden charge in any of its sessions.
const NON_CHARGE_CLASSIFICATIONS = new Set(['free-model', 'cline-pass-included', 'mixed-billing']);

const isFiniteNumber = (value) => typeof value === 'number' && Number.isFinite(value);

const text = (value) => (typeof value === 'string' && value !== '' ? value : null);

/**
 * Shortest plain-decimal form of a number that still parses back to the same double.
 * `0.18000000000000002` (three summed floats) becomes `0.18`; `1e-9` becomes `0.000000001` so no
 * reader has to understand exponent notation and no small cost can round away to `0`.
 */
function plainNumber(value) {
  if (!isFiniteNumber(value)) return '';
  if (value === 0) return '0';
  const shortened = String(Number(value.toPrecision(15)));
  if (!shortened.includes('e')) return shortened;
  const match = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(shortened);
  if (!match) return shortened;
  const [, sign, whole, fraction = '', exponent] = match;
  const digits = whole + fraction;
  const point = whole.length + Number(exponent);
  if (point <= 0) return `${sign}0.${'0'.repeat(-point)}${digits}`;
  if (point >= digits.length) return `${sign}${digits}${'0'.repeat(point - digits.length)}`;
  return `${sign}${digits.slice(0, point)}.${digits.slice(point)}`;
}

/** A number cell, or an empty cell when the value is missing, non-finite, or not a number. */
function numberCell(value) {
  return plainNumber(value);
}

/** ISO-8601 UTC for an ISO string or an epoch-millisecond number; empty when unusable. */
function timestampCell(value) {
  if (isFiniteNumber(value)) {
    if (Math.abs(value) < EARLIEST_EPOCH_MS) return '';
    const fromEpoch = new Date(value);
    return Number.isFinite(fromEpoch.getTime()) ? fromEpoch.toISOString() : '';
  }
  if (typeof value !== 'string' || value === '') return '';
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : '';
}

function quote(field) {
  return `"${field.replace(/"/g, '""')}"`;
}

/** Free text, quoted only when the content requires it. */
function textCell(value, { neutralizeFormulas = false } = {}) {
  const cleaned = String(value ?? '').replace(UNREPRESENTABLE, '');
  if (cleaned === '') return '';
  if (neutralizeFormulas && FORMULA_START.test(cleaned)) return `'${cleaned}`;
  return MUST_QUOTE.test(cleaned) || cleaned !== cleaned.trim() ? quote(cleaned) : cleaned;
}

/** An enum cell: one of the documented words, or empty rather than an invented value. */
function enumCell(value, allowed) {
  return allowed.includes(value) ? String(value) : '';
}

const firstCell = (...cells) => cells.find((cell) => cell !== '');

const sumOf = (values) => (values.every(isFiniteNumber)
  ? values.reduce((total, value) => total + value, 0)
  : null);

const stringIds = (values) => [...new Set((Array.isArray(values) ? values : [])
  .map((value) => text(typeof value === 'string' ? value : null))
  .filter(Boolean))];

/** The included set and the roots, in report order, from the session graph. */
function graphOf(report) {
  const graph = report?.sessionGraph ?? {};
  const included = stringIds(graph.includedSessionIds ?? report?.includedSessionIds);
  return {
    ids: included.length ? included : stringIds(graph.rootSessionIds ?? report?.rootSessionIds),
    roots: new Set(stringIds(graph.rootSessionIds ?? report?.rootSessionIds)),
  };
}

/**
 * Per-session evidence keyed by session id. `row`/`metrics` is the Cline shape; `per` is the
 * MCode shape. A session can appear in both, so the two are merged rather than one replacing
 * the other.
 */
function sessionData(report) {
  const byId = new Map();
  const merge = (id, patch) => {
    if (!id) return;
    byId.set(id, { ...byId.get(id), ...patch });
  };
  for (const entry of Array.isArray(report?.sessions) ? report.sessions : []) {
    const row = entry?.row ?? entry ?? null;
    merge(text(row?.sessionId) ?? text(entry?.sessionId), { row, metrics: entry?.metrics ?? null });
  }
  const perSession = report?.perSession;
  if (perSession && typeof perSession === 'object' && !Array.isArray(perSession)) {
    for (const [id, per] of Object.entries(perSession)) merge(text(id), { per });
  }
  return byId;
}

/**
 * Decide what a row's cost cells may contain: the `coverage` word, plus the two amounts. `cost` is
 * the charge and is written only when the whole of it is known; `known` is everything the ledger
 * disclosed. Both are null whenever nothing is known, so no branch here can invent a zero.
 */
function resolveCharge({ basis, metrics, per, callCountKnown, reportCoverage, reportClassification, reportAmount }) {
  const disclosed = (value) => (isFiniteNumber(value) && value >= 0 ? value : null);
  const reportWord = enumCell(reportCoverage, COVERAGE_VALUES) || 'unknown';

  if (basis === 'provider-rate-estimate') {
    // MCode reports a per-session total but not per-session model coverage, so a report that is
    // not completely priced cannot promote any one of its rows to a complete charge. Assuming
    // otherwise is how a half-priced session ends up billed as a whole one.
    if (per?.billed === false) return { coverage: 'not-recorded', cost: null, known: null };
    const amount = disclosed(per?.totalCost);
    if (isFiniteNumber(per?.calls) && per.calls === 0) return { coverage: 'no-calls', cost: 0, known: 0 };
    if (reportWord === 'complete') {
      return amount === null
        ? { coverage: 'unavailable', cost: null, known: null }
        : { coverage: 'complete', cost: amount, known: amount };
    }
    if (amount === null || amount === 0) {
      return { coverage: reportWord === 'no-calls' ? 'unavailable' : reportWord, cost: null, known: null };
    }
    return { coverage: reportWord === 'unavailable' ? 'unavailable' : 'partial', cost: null, known: amount };
  }

  // A report whose whole charge is a known zero (included or free usage), or whose charge is
  // unknown, says so about every row it contains: a slice of that report cannot be more complete
  // than the report it came from.
  if (NON_CHARGE_CLASSIFICATIONS.has(reportClassification)) {
    return { coverage: 'not-recorded', cost: 0, known: 0 };
  }
  if (reportAmount === null && (reportWord === 'not-recorded' || reportWord === 'unavailable')) {
    return { coverage: reportWord, cost: null, known: null };
  }

  const cost = disclosed(metrics?.cost);
  if (callCountKnown === false) {
    // The runtime supplied an end-to-end total for this session: the amount is known, the call
    // count is not, so the count columns stay empty rather than reading as zero calls. A total
    // that was never supplied arrives as 0, and here 0 means "nothing to report", not "nothing
    // was charged": publishing it would invent a free session the ledger never priced.
    const aggregate = [metrics?.cost, metrics?.storedTotalCost]
      .find((value) => isFiniteNumber(value) && value > 0);
    return aggregate === undefined
      ? { coverage: 'unknown', cost: null, known: null }
      : { coverage: 'complete', cost: aggregate, known: aggregate };
  }

  const calls = isFiniteNumber(metrics?.calls) ? metrics.calls : null;
  if (calls === 0) return { coverage: 'no-calls', cost: 0, known: 0 };
  if (calls === null) return { coverage: 'unknown', cost: null, known: null };

  const unpriced = isFiniteNumber(metrics?.unpricedCalls) ? metrics.unpricedCalls : 0;
  const priced = isFiniteNumber(metrics?.pricedCalls) ? metrics.pricedCalls : null;
  if (unpriced > 0) {
    // A disclosed lower bound, kept out of `costUsd` so a SUM cannot call it the whole charge.
    if (priced !== null && priced > 0 && cost !== null && cost > 0) {
      return { coverage: 'partial', cost: null, known: cost };
    }
    // Nothing was priced: `metrics.cost` is 0 here, and writing that 0 would report a zero charge
    // that nobody made.
    return { coverage: 'not-recorded', cost: null, known: null };
  }
  if (cost !== null && cost > 0) return { coverage: 'complete', cost, known: cost };
  // Every call carries a numeric zero. The ledger does not say whether that zero is a real charge,
  // a free model, or a provider it never instrumented, so the cell stays empty.
  return { coverage: 'unavailable', cost: null, known: null };
}

/**
 * The rows a report produces, one per included session, as `{ sessionId, values }` where `values`
 * is keyed by CSV_COLUMN_NAMES. Cells are finished CSV fields (quoted where the content requires
 * it, empty where the value is unknown), so a caller that wants a different container can reuse
 * them without re-implementing the cost rules. `renderCsv` is the serializer.
 */
export function buildCsvRows(report, { scope = 'session', neutralizeFormulas = false } = {}) {
  if (report === null || typeof report !== 'object') {
    throw new TypeError('buildCsvRows requires a normalized report object');
  }
  if (scope !== 'session') {
    throw new Error(
      `unsupported CSV scope "${String(scope)}": only "session" rows exist today; rollup scopes land with issue #43`,
    );
  }

  const { ids, roots } = graphOf(report);
  const data = sessionData(report);
  const targetId = text(report?.sessionId) ?? text(report?.session?.id) ?? [...roots][0] ?? null;
  const children = stringIds(report?.childSessions);
  const billing = report?.billing ?? {};
  const basis = enumCell(report?.runtime?.costBasis, COST_BASES)
    || enumCell(billing.basis, COST_BASES)
    || 'unknown';
  const reportCoverage = text(billing.coverage) ?? text(report?.coverage?.status);
  const reportClassification = text(billing.classification);
  // `undefined` means the report never stated a total; `null` means it stated that none is known.
  const reportAmount = billing.amountUsd === null
    ? null
    : (isFiniteNumber(billing.amountUsd) ? billing.amountUsd : undefined);

  return ids.map((id) => {
    const { row = null, metrics = null, per = null } = data.get(id) ?? {};
    const isTarget = id === targetId;
    let parentSessionId = text(row?.parentSessionId);
    if (!parentSessionId && !isTarget && (per?.role === 'child' || children.includes(id))) {
      parentSessionId = targetId;
    }
    const role = roots.has(id) || (isTarget && !parentSessionId)
      ? 'root'
      : parentSessionId ? 'child' : 'unknown';
    const callCountKnown = per ? true : metrics?.callCountKnown !== false;
    const parts = [metrics?.inputTokens, metrics?.outputTokens, metrics?.cacheReadTokens, metrics?.cacheWriteTokens];
    const summed = sumOf(parts);
    const charge = resolveCharge({
      basis,
      metrics,
      per,
      callCountKnown,
      reportCoverage,
      reportClassification,
      reportAmount,
    });

    return {
      sessionId: id,
      values: {
        sessionId: textCell(id, { neutralizeFormulas }),
        parentSessionId: textCell(parentSessionId, { neutralizeFormulas }),
        role,
        status: textCell(row?.status, { neutralizeFormulas }),
        startedAt: timestampCell(row?.startedAt) || (isTarget ? timestampCell(report?.firstTs) : ''),
        endedAt: timestampCell(row?.endedAt) || (isTarget ? timestampCell(report?.lastTs) : ''),
        title: textCell(
          metrics?.title ?? per?.title ?? (isTarget ? report?.title ?? report?.session?.title : null),
          { neutralizeFormulas },
        ),
        calls: metrics ? (callCountKnown ? numberCell(metrics.calls) : '') : numberCell(per?.calls),
        pricedCalls: metrics && callCountKnown ? numberCell(metrics.pricedCalls) : '',
        unpricedCalls: metrics && callCountKnown ? numberCell(metrics.unpricedCalls) : '',
        inputTokens: metrics ? numberCell(metrics.inputTokens) : '',
        outputTokens: metrics ? numberCell(metrics.outputTokens) : '',
        cacheReadTokens: metrics ? numberCell(metrics.cacheReadTokens) : '',
        cacheWriteTokens: metrics ? numberCell(metrics.cacheWriteTokens) : '',
        totalTokens: metrics
          ? firstCell(numberCell(metrics.totalTokens), summed === null ? '' : numberCell(summed))
          : numberCell(per?.totalTokens),
        costUsd: numberCell(charge.cost),
        knownCostUsd: numberCell(charge.known),
        costBasis: basis,
        coverage: charge.coverage,
      },
    };
  });
}

/**
 * Render a normalized report as CSV text: a header record of CSV_COLUMN_NAMES followed by one
 * record per included session, records separated by CRLF and terminated by CRLF. Pure: the report
 * is not read for a clock, mutated, or written anywhere.
 */
export function renderCsv(report, options = {}) {
  const rows = buildCsvRows(report, options);
  const records = [CSV_COLUMN_NAMES.join(',')];
  for (const row of rows) {
    records.push(CSV_COLUMN_NAMES.map((name) => row.values[name] ?? '').join(','));
  }
  return `${records.join(RECORD_SEPARATOR)}${RECORD_SEPARATOR}`;
}
