import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createClineFixture, createMCodeFixture, repositoryRoot, runJson } from './helpers/contract-fixtures.mjs';
import {
  COST_BASES,
  COVERAGE_VALUES,
  CSV_COLUMNS,
  CSV_COLUMN_NAMES,
  buildCsvRows,
  renderCsv,
} from '../shared/csv.mjs';

// The column contract, pinned by name and position. Renaming a column, adding one, or moving one is
// a breaking change for every spreadsheet built on this output, so the list is spelled out here
// rather than derived from the implementation it is meant to constrain.
const EXPECTED_COLUMNS = [
  'sessionId',
  'parentSessionId',
  'role',
  'status',
  'startedAt',
  'endedAt',
  'title',
  'calls',
  'pricedCalls',
  'unpricedCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'costUsd',
  'knownCostUsd',
  'costBasis',
  'coverage',
];

const NUMBER_COLUMNS = new Set([
  'calls',
  'pricedCalls',
  'unpricedCalls',
  'inputTokens',
  'outputTokens',
  'cacheReadTokens',
  'cacheWriteTokens',
  'totalTokens',
  'costUsd',
  'knownCostUsd',
]);

// Plain decimal, optionally signed: what a spreadsheet imports as a number. No currency symbol, no
// thousands separator, no exponent, no "n/a", no em dash.
const PLAIN_NUMBER = /^-?\d+(\.\d+)?$/;
const ISO_STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

/**
 * Strict RFC 4180 reader. It rejects what a lenient reader would paper over - a BOM, a bare LF
 * separator, a quote in the middle of a field, an unterminated quote - so a round-trip test cannot
 * pass on a file that only this module's own writer happens to understand.
 */
function parseCsv(text) {
  assert.notEqual(text.charCodeAt(0), 0xfeff, 'a byte order mark would corrupt the first column name');
  const records = [];
  let record = [];
  let field = '';
  let quoted = false;
  let index = 0;
  while (index < text.length) {
    const char = text[index];
    if (quoted) {
      if (char === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 2;
          continue;
        }
        quoted = false;
        index += 1;
        continue;
      }
      field += char;
      index += 1;
      continue;
    }
    if (char === '"') {
      assert.equal(field, '', 'a quote may only open a field, never continue one');
      quoted = true;
      index += 1;
      continue;
    }
    if (char === ',') {
      record.push(field);
      field = '';
      index += 1;
      continue;
    }
    if (char === '\r' && text[index + 1] === '\n') {
      record.push(field);
      records.push(record);
      record = [];
      field = '';
      index += 2;
      continue;
    }
    assert.notEqual(char, '\n', 'a bare LF is not an RFC 4180 record separator');
    field += char;
    index += 1;
  }
  assert.equal(quoted, false, 'unterminated quoted field');
  if (field !== '' || record.length > 0) {
    record.push(field);
    records.push(record);
  }
  return records;
}

/** Render, parse, and index a report's rows by column name, asserting the record shape. */
function rowsOf(report, options) {
  const [header, ...records] = parseCsv(renderCsv(report, options));
  assert.deepEqual(header, CSV_COLUMN_NAMES, 'the first record must be the pinned column contract');
  return records.map((record) => {
    assert.equal(record.length, CSV_COLUMN_NAMES.length, 'every record must have one cell per column');
    return Object.fromEntries(CSV_COLUMN_NAMES.map((name, position) => [name, record[position]]));
  });
}

/** A session entry shaped like the Cline report's `sessions[]` items. */
function session(sessionId, metrics = {}, row = {}) {
  return {
    row: {
      sessionId,
      parentSessionId: null,
      status: 'completed',
      startedAt: '2026-02-01T00:00:00.000Z',
      endedAt: '2026-02-01T00:05:00.000Z',
      ...row,
    },
    metrics: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      cost: 0,
      calls: 0,
      pricedCalls: 0,
      unpricedCalls: 0,
      callCountKnown: true,
      ...metrics,
    },
  };
}

/** A normalized-report lookalike, so a test can state only the field it is about. */
function clineReport(sessions, overrides = {}) {
  const ids = sessions.map((entry) => entry.row.sessionId);
  const billing = {
    basis: 'runtime-recorded',
    currency: 'USD',
    amountUsd: null,
    coverage: 'unknown',
    classification: 'unknown',
    ...overrides.billing,
  };
  return {
    schemaVersion: 1,
    contractVersion: '1.2.0',
    generatedAt: '2026-02-01T00:00:00.000Z',
    runtime: { id: 'cline', costBasis: 'runtime-recorded', storageSource: 'test ledger' },
    usage: { totalTokens: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, cacheHitRate: 0 },
    coverage: { status: billing.coverage, calls: 0, totalTokens: 0, unknownReasons: [] },
    billing,
    provenance: { kind: 'runtime-ledger', source: 'test ledger', rateSources: [] },
    sessionGraph: {
      rootSessionIds: ids.slice(0, 1),
      includedSessionIds: ids,
      excludedSessionIds: [],
      duplicateSuppressedSessionIds: [],
      ...overrides.sessionGraph,
    },
    warnings: [],
    sessions,
    ...overrides.report,
  };
}

/** An MCode-shaped report: per-session totals, no per-session call or token breakdown. */
function mcodeReport(perSession, overrides = {}) {
  const ids = Object.keys(perSession);
  return {
    schemaVersion: 1,
    contractVersion: '1.2.0',
    generatedAt: '2026-02-01T00:00:00.000Z',
    sessionId: ids[0],
    runtime: { id: 'mcode', costBasis: 'provider-rate-estimate', storageSource: 'test ledger' },
    childSessions: ids.slice(1),
    perSession,
    billing: {
      basis: 'provider-rate-estimate',
      currency: 'USD',
      amountUsd: null,
      coverage: 'unknown',
      classification: 'cost-unavailable',
      ...overrides.billing,
    },
    coverage: { status: 'unknown', calls: 0, totalTokens: 0, unknownReasons: [] },
    provenance: { kind: 'provider-rate-estimate', source: 'test rate table', rateSources: [] },
    sessionGraph: {
      rootSessionIds: ids.slice(0, 1),
      includedSessionIds: ids,
      excludedSessionIds: [],
      duplicateSuppressedSessionIds: [],
      ...overrides.sessionGraph,
    },
    warnings: [],
  };
}

test('the column contract is documented, ordered, and pinned', () => {
  assert.deepEqual(CSV_COLUMN_NAMES, EXPECTED_COLUMNS, 'column names and order are the published contract');
  assert.equal(new Set(CSV_COLUMN_NAMES).size, EXPECTED_COLUMNS.length, 'column names must be unique');
  for (const column of CSV_COLUMNS) {
    assert.ok(column.type.length > 0, `${column.name} must declare a type`);
    assert.ok(column.description.endsWith('.'), `${column.name} must document itself in prose`);
  }
  assert.equal(CSV_COLUMN_NAMES.at(-1), 'coverage', 'coverage is the column a truncated read still needs');
  assert.equal(CSV_COLUMNS.find((column) => column.name === 'costBasis').type, COST_BASES.join('|'));
  assert.equal(CSV_COLUMNS.find((column) => column.name === 'coverage').type, COVERAGE_VALUES.join('|'));
});

test('rendering is deterministic, pure, and refuses a scope it cannot honour', () => {
  const report = clineReport([session('a', { calls: 1, cost: 0.5, pricedCalls: 1, inputTokens: 10, outputTokens: 1 })]);
  const before = structuredClone(report);
  assert.equal(renderCsv(report), renderCsv(report), 'the same report must render byte-identical text twice');
  assert.deepEqual(report, before, 'rendering must not mutate the report it was given');
  assert.throws(() => renderCsv(null), TypeError);
  assert.throws(() => renderCsv(report, { scope: 'daily' }), /unsupported CSV scope "daily"/);
});

test('a report with no included sessions still emits the header contract', () => {
  const csv = renderCsv(clineReport([], { sessionGraph: { rootSessionIds: [], includedSessionIds: [] } }));
  assert.equal(csv, `${CSV_COLUMN_NAMES.join(',')}\r\n`);
  assert.deepEqual(parseCsv(csv), [EXPECTED_COLUMNS]);
});

test('rows are exactly the included session set, in graph order', () => {
  const report = clineReport([
    session('root', { calls: 1, cost: 0.1, pricedCalls: 1 }),
    session('child', { calls: 1, cost: 0.2, pricedCalls: 1 }, { parentSessionId: 'root' }),
  ], {
    sessionGraph: {
      rootSessionIds: ['root'],
      includedSessionIds: ['root'],
      excludedSessionIds: ['child'],
      duplicateSuppressedSessionIds: [],
    },
  });
  assert.deepEqual(rowsOf(report).map((row) => row.sessionId), ['root'], 'an excluded descendant must not be double counted');
  assert.deepEqual(buildCsvRows(report).map((row) => row.sessionId), ['root']);

  const withGap = clineReport([session('root', { calls: 1, cost: 0.1, pricedCalls: 1 })], {
    sessionGraph: { rootSessionIds: ['root'], includedSessionIds: ['root', 'never-reported'], excludedSessionIds: [], duplicateSuppressedSessionIds: [] },
  });
  const rows = rowsOf(withGap);
  assert.deepEqual(rows.map((row) => row.sessionId), ['root', 'never-reported']);
  assert.equal(rows[1].costUsd, '', 'a session the report says nothing about must not be priced');
  assert.equal(rows[1].calls, '', 'and its call count must not read as zero');
  assert.equal(rows[1].coverage, 'unknown');
});

test('a title with commas, quotes, newlines, and edge whitespace round-trips', () => {
  const title = 'Fix "quoting", commas\r\nand a second line\twith a tab, padded  ';
  const report = clineReport([session('root', { calls: 1, cost: 0.1, pricedCalls: 1, title })]);
  const [row] = rowsOf(report);
  assert.equal(row.title, title, 'the parsed title must equal the title the ledger held');

  const raw = renderCsv(report);
  assert.ok(raw.includes('"Fix ""quoting"", commas\r\nand a second line'), 'a quote inside a quoted field must be doubled');
  assert.ok(raw.includes('padded  "'), 'edge whitespace must be inside the quotes it is preserved by');
  const embedded = raw.slice(raw.indexOf(',"'), raw.indexOf('",1,'));
  assert.equal(embedded.includes('\n'), true, 'the embedded newline stays a bare LF inside the quoted field');
  assert.equal(parseCsv(raw).length, 2, 'a CRLF inside a title must not create a record');
});

test('control characters a CSV reader cannot hold are dropped, not smuggled in', () => {
  const report = clineReport([session('root', { calls: 1, cost: 0.1, pricedCalls: 1, title: 'bellandnul' })]);
  const [row] = rowsOf(report);
  assert.equal(row.title, 'bellandnul');
  assert.equal(renderCsv(report).includes('\\u0007'), false);
});

test('numbers are plain decimals that a spreadsheet imports as numbers', () => {
  const report = clineReport([
    session('root', {
      calls: 1234,
      pricedCalls: 1234,
      unpricedCalls: 0,
      inputTokens: 1234567,
      outputTokens: 89,
      cacheReadTokens: 10,
      cacheWriteTokens: 5,
      cost: 0.18000000000000002,
    }),
  ], { billing: { amountUsd: 0.18000000000000002, coverage: 'complete', classification: 'usage-billed' } });
  const [row] = rowsOf(report);
  assert.equal(row.inputTokens, '1234567', 'no thousands separator');
  assert.equal(row.costUsd, '0.18', 'float noise is shortened to the value the ledger meant');
  assert.equal(row.totalTokens, '1234671');

  const tiny = rowsOf(clineReport([session('root', { calls: 1, pricedCalls: 1, cost: 1e-9 })], {
    billing: { amountUsd: 1e-9, coverage: 'complete', classification: 'usage-billed' },
  }))[0];
  assert.equal(tiny.costUsd, '0.000000001', 'a tiny real cost must never round to 0');
  assert.notEqual(tiny.costUsd, '0');

  for (const cell of Object.entries(row)) {
    if (NUMBER_COLUMNS.has(cell[0])) {
      assert.match(cell[1], PLAIN_NUMBER, `${cell[0]} must be a plain decimal`);
    }
  }
  const text = renderCsv(report);
  assert.equal(/[$€£]/.test(text), false, 'no currency symbol');
  assert.equal(/e[+-]\d/.test(text), false, 'no exponent notation');
  for (const row of rowsOf(report)) {
    for (const [name, cell] of Object.entries(row)) {
      assert.equal(/^\d{1,3}(?:,\d{3})+/.test(cell), false, `${name} must not group thousands: ${cell}`);
    }
  }
});

test('a reported timestamp is normalized to UTC ISO-8601, and an unusable one is empty', () => {
  const report = clineReport([
    session('root', { calls: 1, cost: 0.1, pricedCalls: 1 }, { startedAt: '2026-02-01T09:30:00+02:00' }),
    session('child', { calls: 1, cost: 0.1, pricedCalls: 1 }, { parentSessionId: 'root', startedAt: 'not-a-date', endedAt: 12345 }),
  ], {
    billing: { amountUsd: 0.2, coverage: 'complete', classification: 'usage-billed' },
    sessionGraph: { rootSessionIds: ['root'], includedSessionIds: ['root', 'child'], excludedSessionIds: [], duplicateSuppressedSessionIds: [] },
  });
  const [root, child] = rowsOf(report);
  assert.equal(root.startedAt, '2026-02-01T07:30:00.000Z');
  assert.match(root.endedAt, ISO_STAMP);
  assert.equal(child.startedAt, '', 'an unparseable timestamp is unknown, not a guess');
  assert.equal(child.endedAt, '', 'a number too small to be epoch milliseconds is not a time');
});

// Every cost shape a report can hand us, with the cells the contract demands for it. The point of
// the table is the two rules a reader of the CSV depends on: a charge that is not fully known is an
// EMPTY cell, and `0` appears only where the charge is a known zero.
const COST_CASES = [
  {
    name: 'a fully priced session carries its charge',
    report: clineReport([session('a', { calls: 2, pricedCalls: 2, cost: 0.5, inputTokens: 10 })], {
      billing: { amountUsd: 0.5, coverage: 'complete', classification: 'usage-billed' },
    }),
    costUsd: '0.5',
    knownCostUsd: '0.5',
    coverage: 'complete',
  },
  {
    name: 'a session with no calls is a known zero, not an unknown',
    report: clineReport([session('a')]),
    costUsd: '0',
    knownCostUsd: '0',
    coverage: 'no-calls',
  },
  {
    name: 'a partly priced session reports a lower bound in knownCostUsd only',
    report: clineReport([session('a', { calls: 2, pricedCalls: 1, unpricedCalls: 1, cost: 0.04, inputTokens: 20 })], {
      billing: { amountUsd: 0.04, coverage: 'partial', classification: 'partial-cost' },
    }),
    costUsd: '',
    knownCostUsd: '0.04',
    coverage: 'partial',
  },
  {
    name: 'a session where nothing was priced reports nothing, not a zero',
    report: clineReport([session('a', { calls: 2, pricedCalls: 0, unpricedCalls: 2, cost: 0, inputTokens: 20 })], {
      billing: { amountUsd: null, coverage: 'not-recorded', classification: 'cost-unavailable' },
    }),
    costUsd: '',
    knownCostUsd: '',
    coverage: 'not-recorded',
  },
  {
    name: 'an end-to-end aggregate total is a complete cost with an unknown call count',
    report: clineReport([session('a', { calls: 0, cost: 1.25, storedTotalCost: 1.25, callCountKnown: false, inputTokens: 100_000 })], {
      billing: { amountUsd: 1.25, coverage: 'aggregate', classification: 'aggregate-usage' },
    }),
    costUsd: '1.25',
    knownCostUsd: '1.25',
    coverage: 'complete',
    calls: '',
  },
  {
    name: 'an aggregate with no total left the cost unknown',
    report: clineReport([session('a', { calls: 0, cost: 0, callCountKnown: false })], {
      billing: { amountUsd: null, coverage: 'aggregate', classification: 'aggregate-usage' },
    }),
    costUsd: '',
    knownCostUsd: '',
    coverage: 'unknown',
    calls: '',
  },
  {
    name: 'usage the report classifies as included or free is a known zero charge',
    report: clineReport([session('a', { calls: 3, pricedCalls: 3, cost: 0, inputTokens: 30 })], {
      billing: { amountUsd: 0, coverage: 'not-recorded', classification: 'cline-pass-included' },
    }),
    costUsd: '0',
    knownCostUsd: '0',
    coverage: 'not-recorded',
  },
  {
    name: 'numeric zero costs with no classification are not claimed as a zero charge',
    report: clineReport([session('a', { calls: 1, pricedCalls: 1, cost: 0 })], {
      billing: { amountUsd: null, coverage: 'unavailable', classification: 'cost-unavailable' },
    }),
    costUsd: '',
    knownCostUsd: '',
    coverage: 'unavailable',
  },
  {
    name: 'a completely priced rate estimate states that it is an estimate',
    report: mcodeReport({ 'm-1': { role: 'target', billed: true, calls: 4, totalTokens: 494, totalCost: 0.00046 } }, {
      billing: { amountUsd: 0.00046, coverage: 'complete', classification: 'rate-estimated' },
    }),
    costUsd: '0.00046',
    knownCostUsd: '0.00046',
    coverage: 'complete',
    costBasis: 'provider-rate-estimate',
  },
  {
    name: 'a partly priced rate estimate keeps its lower bound out of the charge column',
    report: mcodeReport({ 'm-1': { role: 'target', billed: true, calls: 2, totalTokens: 110, totalCost: 0.00006 } }, {
      billing: { amountUsd: null, coverage: 'partial', classification: 'cost-unavailable' },
    }),
    costUsd: '',
    knownCostUsd: '0.00006',
    coverage: 'partial',
  },
  {
    name: 'a rate estimate with no applicable rate at all stays empty rather than zero',
    report: mcodeReport({ 'm-1': { role: 'target', billed: true, calls: 2, totalTokens: 110, totalCost: 0 } }, {
      billing: { amountUsd: null, coverage: 'unavailable', classification: 'cost-unavailable' },
    }),
    costUsd: '',
    knownCostUsd: '',
    coverage: 'unavailable',
  },
  {
    name: 'a rate estimate for a session with no calls is a known zero',
    report: mcodeReport({ 'm-1': { role: 'target', billed: true, calls: 0, totalTokens: 0, totalCost: 0 } }, {
      billing: { amountUsd: null, coverage: 'no-calls', classification: 'cost-unavailable' },
    }),
    costUsd: '0',
    knownCostUsd: '0',
    coverage: 'no-calls',
  },
];

for (const scenario of COST_CASES) {
  test(`cost contract: ${scenario.name}`, () => {
    const [row] = rowsOf(scenario.report);
    assert.equal(row.costUsd, scenario.costUsd, 'costUsd');
    assert.equal(row.knownCostUsd, scenario.knownCostUsd, 'knownCostUsd');
    assert.equal(row.coverage, scenario.coverage, 'coverage');
    if (scenario.calls !== undefined) assert.equal(row.calls, scenario.calls, 'calls');
    if (scenario.costBasis) assert.equal(row.costBasis, scenario.costBasis, 'costBasis');
    assert.ok(COVERAGE_VALUES.includes(row.coverage), 'coverage must come from the documented vocabulary');
    assert.ok(COST_BASES.includes(row.costBasis), 'costBasis must come from the documented vocabulary');
    if (['partial', 'unavailable', 'unknown'].includes(row.coverage)) {
      assert.equal(row.costUsd, '', 'a charge that is not fully known must never reach costUsd');
    }
    if (row.costUsd === '0') {
      assert.ok(['no-calls', 'not-recorded'].includes(row.coverage), 'a zero charge must be a known zero');
    }
    if (row.costUsd !== '') {
      assert.match(row.costUsd, PLAIN_NUMBER, 'a written charge is a plain decimal a SUM can read');
      assert.equal(Number(row.costUsd) >= 0, true);
    }
  });
}

test('no credential, prompt, or transcript content reaches any column', () => {
  const secrets = {
    apiKey: 'sk-ant-SECRETKEYVALUE',
    authorization: 'Bearer SECRETBEARERTOKEN',
    prompt: 'PROMPTTEXT please delete production',
    transcript: 'TRANSCRIPTLINE the user said something private',
    env: 'ENVIRONMENTVARIABLENAME',
    credentialEnv: 'CREDENTIALVARIABLE',
    source: 'SOURCESTRING the ledger at /home/user/.cline',
    evidence: 'EVIDENCESTRING 1/2 calls contain cost',
    label: 'LABELSTRING Partial cost',
    config: 'CONFIGSTRING provider=anthropic',
    driver: 'DRIVERSTRING provider-drivers/anthropic',
    warning: 'WARNINGSTRING aggregate usage already includes descendants',
    rate: 'RATESTRING https://example.invalid/rates.json',
  };
  const report = clineReport([session('root', { calls: 2, pricedCalls: 2, cost: 0.5, title: 'Accountable title' })], {
    billing: { amountUsd: 0.5, coverage: 'complete', classification: 'usage-billed', evidence: secrets.evidence, label: secrets.label },
    report: {
      warnings: [secrets.warning],
      session: { id: 'root', title: 'Accountable title', prompt: secrets.prompt, messages: [{ role: 'user', content: secrets.transcript }] },
      configuration: { config: { note: secrets.config, env: secrets.env }, paths: { user: secrets.source } },
      providerDriver: { manifest: secrets.driver },
      models: [{ model: 'accountable-model', credentialEnv: secrets.credentialEnv, apiKey: secrets.apiKey }],
      rateProvenance: [{ provider: 'p', model: 'm', component: 'input', source: { url: secrets.rate, parserVersion: 3 } }],
      provenance: { kind: 'runtime-ledger', source: secrets.source, rateSources: [] },
      credentials: { apiKey: secrets.apiKey, authorization: secrets.authorization },
      environment: { ANTHROPIC_API_KEY: secrets.apiKey },
    },
  });

  const csv = renderCsv(report);
  for (const [field, value] of Object.entries(secrets)) {
    assert.equal(csv.includes(value), false, `${field} must not reach the CSV`);
  }
  assert.ok(csv.includes('Accountable title'), 'the documented title column still carries the label');
  assert.equal(parseCsv(csv)[0].join(','), CSV_COLUMN_NAMES.join(','), 'no column may be added for any of it');

  // Every cell outside `title` is a closed vocabulary: an id, a status word, a stamp, or a number.
  for (const row of rowsOf(report)) {
    for (const [name, cell] of Object.entries(row)) {
      if (name === 'title' || cell === '') continue;
      const closed = PLAIN_NUMBER.test(cell)
        || ISO_STAMP.test(cell)
        || COST_BASES.includes(cell)
        || COVERAGE_VALUES.includes(cell)
        || ['root', 'child', 'unknown', 'completed'].includes(cell)
        || cell === 'root';
      assert.equal(closed, true, `${name} must be a closed value, got ${JSON.stringify(cell)}`);
    }
  }
});

test('formula neutralization is opt-in and leaves numbers alone', () => {
  const report = clineReport([session('root', { calls: 1, cost: 0.5, pricedCalls: 1, title: '=1+1' })], {
    billing: { amountUsd: 0.5, coverage: 'complete', classification: 'usage-billed' },
  });
  assert.equal(rowsOf(report)[0].title, '=1+1', 'the default output reproduces the title byte for byte');
  const guarded = rowsOf(report, { neutralizeFormulas: true })[0];
  assert.equal(guarded.title, "'=1+1", 'an opt-in guard prefixes a cell a spreadsheet would evaluate');
  assert.equal(guarded.costUsd, '0.5', 'and it must not touch a number');
  assert.equal(rowsOf(clineReport([session('r', { calls: 1, cost: 1, pricedCalls: 1, title: 'Plain title' })]), {
    neutralizeFormulas: true,
  })[0].title, 'Plain title');
});

test('the renderer stays dependency-free, path-safe, and valid UTF-8', () => {
  const source = fs.readFileSync(path.join(repositoryRoot, 'shared', 'csv.mjs'), 'utf8');
  assert.doesNotMatch(source, /^\s*import\s/m, 'the module must not import anything, npm or builtin');
  assert.doesNotMatch(source, /\brequire\(/, 'the module must not require anything');
  assert.doesNotMatch(source, /\.pathname\b/, 'new URL(...).pathname is the known Windows path bug in this repo');
  assert.equal(Buffer.from(source, 'utf8').toString('utf8'), source, 'the module must be valid UTF-8');
  assert.doesNotMatch(source, /\uFFFD|ΓÇ|â€|Ã./, 'the module must contain no mojibake');
});

const sumOfColumn = (rows, column) => rows.reduce((total, row) => total + (row[column] === '' ? 0 : Number(row[column])), 0);

test('a real fully priced Cline report reconciles row by row with the report total', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const { result, output } = runJson(fixture.script, fixture.dataDir, ['--session', 'cline-root', '--include-children']);
  assert.equal(result.status, 0, result.stderr);

  const rows = rowsOf(output);
  assert.deepEqual(rows.map((row) => row.sessionId), output.sessionGraph.includedSessionIds, 'one row per included session, in order');
  assert.deepEqual(rows.map((row) => row.role), ['root', 'child', 'child']);
  assert.deepEqual(rows.map((row) => row.parentSessionId), ['', 'cline-root', 'cline-child']);
  assert.equal(rows[0].title, 'Root contract fixture');
  assert.match(rows[0].startedAt, ISO_STAMP);
  for (const row of rows) {
    assert.equal(row.costBasis, output.runtime.costBasis, 'every row states the cost basis it was measured on');
    assert.equal(row.coverage, 'complete', 'a fully priced session is complete');
    assert.equal(row.knownCostUsd, row.costUsd, 'a complete row has no gap between the charge and the known amount');
  }
  assert.equal(rows[0].calls, '2');
  assert.equal(rows[0].inputTokens, '1500');
  // Cline's inputTokens already includes cached tokens, so the total is input+output.
  // Summing all four columns double-counted the cache and reported 2025 for 1650 real
  // tokens. The export now reads the report's declared token semantics.
  assert.equal(rows[0].totalTokens, '1650');
  assert.equal(rows[0].costUsd, '0.15');

  const source = output.sessions;
  assert.equal(sumOfColumn(rows, 'costUsd').toFixed(10), Number(output.billing.amountUsd).toFixed(10), 'the charge column sums to the reported total');
  // totalTokens is reconciled too: leaving it out is how the double-count above went
  // unnoticed, because every other column happened to line up.
  for (const token of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'calls']) {
    const expected = source.reduce((total, entry) => total + entry.metrics[token], 0);
    assert.equal(sumOfColumn(rows, token), expected, `${token} must reconcile with the report`);
  }
  // Cline's per-session rows do not state totalTokens, so it is derived the way the report
  // derives it: per the declared token semantics. Reading metrics.totalTokens here would be
  // NaN, which is how the double-count stayed invisible.
  const cacheInsideInput = output.usage.semantics.inputTokenMeaning === 'includes-cache';
  const expectedTokens = source.reduce((total, entry) => total + (
    cacheInsideInput
      ? entry.metrics.inputTokens + entry.metrics.outputTokens
      : entry.metrics.inputTokens + entry.metrics.outputTokens + entry.metrics.cacheReadTokens + entry.metrics.cacheWriteTokens
  ), 0);
  assert.equal(sumOfColumn(rows, 'totalTokens'), expectedTokens, 'totalTokens must reconcile per the declared semantics');
  assert.equal(sumOfColumn(rows, 'totalTokens'), output.usage.totalTokens, 'and must match the report headline');
  for (const row of rows) {
    const entry = source.find((item) => item.row.sessionId === row.sessionId);
    assert.equal(row.costUsd, String(Number(entry.metrics.cost.toPrecision(15))), 'each row carries its own session cost');
    assert.equal(row.title, entry.metrics.title, 'each row carries its own title');
    assert.equal(row.calls, String(entry.metrics.calls), 'each row carries its own call count');
  }
});

test('a real partly priced session leaves the charge cell empty on real CLI output', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const { result, output } = runJson(fixture.script, fixture.dataDir, ['--session', 'cline-partial']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.billing.coverage, 'partial');

  const [row] = rowsOf(output);
  assert.equal(row.costUsd, '', 'an unpriced call must leave the charge empty, never 0');
  assert.notEqual(row.costUsd, '0');
  assert.equal(row.knownCostUsd, '0.04', 'the disclosed part is reported as a lower bound');
  assert.equal(row.coverage, 'partial');
  assert.equal(row.costBasis, 'runtime-recorded');
  assert.equal(row.calls, '2', 'the call count is still known and still reported');
  assert.equal(row.pricedCalls, '1');
  assert.equal(row.unpricedCalls, '1', 'and the row says which call is missing its cost');

  const raw = renderCsv(output).split('\r\n')[1];
  assert.equal(raw.includes('""'), false, 'an unknown cost is zero characters, never a quoted empty string');
  assert.equal(raw.endsWith(',660,,0.04,runtime-recorded,partial'), true, 'the empty charge cell sits between two commas');
  assert.equal(sumOfColumn([row], 'costUsd'), 0, 'summing the charge column cannot absorb the unknown');
  assert.equal(sumOfColumn([row], 'knownCostUsd'), Number(output.billing.amountUsd));
});

test('a real session with no calls is a known zero charge', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const { result, output } = runJson(fixture.script, fixture.dataDir, ['--session', 'cline-truncated']);
  assert.equal(result.status, 0, result.stderr);
  const [row] = rowsOf(output);
  assert.equal(row.coverage, 'no-calls');
  assert.equal(row.costUsd, '0', 'no calls is a real, known zero charge');
  assert.equal(row.calls, '0');
});

test('a real Cline aggregate total is a complete cost with an empty call count', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  fs.writeFileSync(path.join(fixture.dataDir, 'data', 'sessions', 'cline-root.json'), '{"messages":[', 'utf8');
  const database = new DatabaseSync(path.join(fixture.dataDir, 'data', 'db', 'sessions.db'));
  database
    .prepare('UPDATE sessions SET metadata_json = ? WHERE session_id = ?')
    .run(JSON.stringify({ title: 'Aggregate root', aggregateUsage: { inputTokens: 100_000, outputTokens: 10_000 }, totalCost: 1.25 }), 'cline-root');
  database.close();

  const { result, output } = runJson(fixture.script, fixture.dataDir, ['--session', 'cline-root']);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.billing.amountUsd, 1.25);
  const [row] = rowsOf(output);
  assert.equal(row.costUsd, '1.25');
  assert.equal(row.knownCostUsd, '1.25');
  assert.equal(row.coverage, 'complete');
  assert.equal(row.calls, '', 'an unavailable call count must stay empty rather than read as zero calls');
  assert.equal(row.inputTokens, '100000', 'the aggregate token counts are still real numbers');
});

test('a real MCode rate estimate states the basis and prices only what the rate table covered', (t) => {
  const fixture = createMCodeFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));

  const priced = runJson(fixture.script, fixture.dataDir, ['--session', 'mcode-root', '--include-children'], fixture.environment);
  assert.equal(priced.result.status, 0, priced.result.stderr);
  const rows = rowsOf(priced.output);
  assert.deepEqual(rows.map((row) => row.sessionId), priced.output.sessionGraph.includedSessionIds);
  assert.deepEqual(rows.map((row) => row.role), ['root', 'child', 'child']);
  // MCode now emits per-session rows, so a child of a child is reachable and its real
  // parent is reported. It used to emit none, which is why this expected a blank row.
  assert.deepEqual(rows.map((row) => row.parentSessionId), ['', 'mcode-root', 'mcode-child']);
  for (const row of rows) {
    assert.equal(row.costBasis, 'provider-rate-estimate', 'an estimate must never be presented as a recorded charge');
    assert.equal(row.coverage, 'complete');
  }
  assert.equal(rows[0].costUsd, '0.0004355');
  assert.equal(rows[0].title, 'Root contract fixture', 'the selected session keeps its title');
  assert.equal(rows[0].totalTokens, '470');
  // MCode now reports a per-session token split, which it could not before: it emitted no
  // session rows at all. The split is real data, not a derived guess.
  assert.equal(rows[0].inputTokens, '300');
  assert.equal(rows[0].outputTokens, '30');
  // MCode now reports per-session call-level pricing too, since it emits session rows.
  assert.equal(rows[0].pricedCalls, '2');
  assert.equal(rows[0].unpricedCalls, '0');
  assert.equal(sumOfColumn(rows, 'costUsd').toFixed(12), Number(priced.output.billing.amountUsd).toFixed(12));

  const partial = runJson(fixture.script, fixture.dataDir, ['--session', 'mcode-partial'], fixture.environment);
  assert.ok(partial.output, partial.result.stderr);
  assert.equal(partial.output.billing.amountUsd, null, 'the report itself refuses to state a total');
  const [partialRow] = rowsOf(partial.output);
  assert.equal(partialRow.costUsd, '', 'a half-priced rate estimate must not reach the charge column');
  assert.equal(partialRow.knownCostUsd, '0.00006', 'only the priced part is disclosed');
  assert.equal(partialRow.coverage, 'partial');
  assert.equal(partialRow.costBasis, 'provider-rate-estimate');
  assert.equal(sumOfColumn([partialRow], 'costUsd'), 0);
});
