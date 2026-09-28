import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { RATE_PARSER_VERSION, RATES_SOURCE, SOURCE_PARSER_VERSION, prepareProviderRates } from '../../adapters/mcode/skill/scripts/lib/rates.mjs';

export const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const clineScript = path.join(repositoryRoot, 'adapters', 'cline', 'skill', 'scripts', 'session-cost.mjs');
export const mcodeScript = path.join(repositoryRoot, 'adapters', 'mcode', 'skill', 'scripts', 'session-cost.mjs');

export function runCli(script, dataDir, args = [], environment = {}) {
  return spawnSync(process.execPath, [script, '--data-dir', dataDir, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...environment },
  });
}

export function runJson(script, dataDir, args = [], environment = {}) {
  const result = runCli(script, dataDir, [...args, '--json'], environment);
  let output = null;
  try { output = JSON.parse(result.stdout); } catch { /* Assertions below expose the CLI stderr. */ }
  return { result, output };
}

function isoOffset({ days = 0, hours = 0 }, base) {
  return new Date((base ?? Date.now()) + days * 86_400_000 + hours * 3_600_000).toISOString();
}

/**
 * The base instant a fixture's session timestamps are built from.
 *
 * Defaults to the real clock, so ordinary tests keep the relative-date behaviour they assert on
 * (`--today` selecting what started today, and so on). A test that compares rendered output
 * verbatim passes a fixed epoch instead, because a golden file that embeds "2 days ago" stops
 * matching the moment the day changes - the same expiry that made `rate-provenance` flip from
 * pass to fail on consecutive days, and the reason WP-1.1 introduced `SESSION_COST_NOW`.
 */
export const FIXTURE_EPOCH = '2026-06-15T12:00:00.000Z';

function writeMessages(directory, sessionId, messages) {
  const target = path.join(directory, 'data', 'sessions', `${sessionId}.json`);
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, messages }, null, 2), 'utf8');
  return target;
}

export function createClineFixture({ base } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-cline-contract-'));
  fs.mkdirSync(path.join(dataDir, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data', 'sessions'), { recursive: true });

  const rootStarted = isoOffset({ days: -2 }, base);
  const todayStarted = new Date().toISOString();
  const otherStarted = todayStarted;
  const partialStarted = todayStarted;
  const rootMessages = writeMessages(dataDir, 'cline-root', [
    {
      role: 'assistant',
      ts: Date.parse(rootStarted) + 1_000,
      metrics: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 200, cacheWriteTokens: 50, cost: 0.1 },
      modelInfo: { provider: 'cline', id: 'root-model' },
    },
    {
      role: 'assistant',
      ts: Date.parse(rootStarted) + 2_000,
      metrics: { inputTokens: 500, outputTokens: 50, cacheReadTokens: 100, cacheWriteTokens: 25, cost: 0.05 },
      modelInfo: { provider: 'cline', id: 'switched-model' },
    },
  ]);
  const childMessages = writeMessages(dataDir, 'cline-child', [
    {
      role: 'assistant',
      ts: Date.parse(rootStarted) + 3_000,
      metrics: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.02 },
      modelInfo: { provider: 'cline', id: 'child-model' },
    },
  ]);
  const grandchildMessages = writeMessages(dataDir, 'cline-grandchild', [
    {
      role: 'assistant',
      ts: Date.parse(rootStarted) + 4_000,
      metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.01 },
      modelInfo: { provider: 'cline', id: 'grandchild-model' },
    },
  ]);
  const otherMessages = writeMessages(dataDir, 'cline-other', [
    {
      role: 'assistant',
      ts: Date.parse(otherStarted) + 1_000,
      metrics: { inputTokens: 300, outputTokens: 30, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.03 },
      modelInfo: { provider: 'other-provider', id: 'other-model' },
    },
  ]);
  const partialMessages = writeMessages(dataDir, 'cline-partial', [
    {
      role: 'assistant',
      ts: Date.parse(partialStarted) + 1_000,
      metrics: { inputTokens: 400, outputTokens: 40, cacheReadTokens: 0, cacheWriteTokens: 0, cost: 0.04 },
      modelInfo: { provider: 'partial-provider', id: 'priced-model' },
    },
    {
      role: 'assistant',
      ts: Date.parse(partialStarted) + 2_000,
      metrics: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 0, cacheWriteTokens: 0 },
      modelInfo: { provider: 'partial-provider', id: 'unpriced-model' },
    },
  ]);
  const badMessages = path.join(dataDir, 'data', 'sessions', 'cline-truncated.json');
  fs.writeFileSync(badMessages, '{"schemaVersion":1,"messages":[', 'utf8');

  const database = new DatabaseSync(path.join(dataDir, 'data', 'db', 'sessions.db'));
  database.exec(`
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      parent_session_id TEXT,
      pid INTEGER,
      status TEXT,
      started_at TEXT,
      ended_at TEXT,
      updated_at TEXT,
      provider TEXT,
      model TEXT,
      messages_path TEXT,
      metadata_json TEXT,
      prompt TEXT,
      is_subagent INTEGER DEFAULT 0
    );
  `);
  const insert = database.prepare(`INSERT INTO sessions (
    session_id, parent_session_id, pid, status, started_at, ended_at, updated_at,
    provider, model, messages_path, metadata_json, prompt, is_subagent
  ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const rows = [
    ['cline-root', null, 101, 'completed', rootStarted, isoOffset({ hours: -47 }, base), rootStarted, 'commandcode', 'root-model', rootMessages, JSON.stringify({ title: 'Root contract fixture' }), 'root', 0],
    ['cline-child', 'cline-root', 102, 'completed', rootStarted, isoOffset({ hours: -46 }, base), rootStarted, 'cline', 'child-model', childMessages, JSON.stringify({ title: 'Child contract fixture' }), 'child', 1],
    ['cline-grandchild', 'cline-child', 103, 'completed', rootStarted, isoOffset({ hours: -45 }, base), rootStarted, 'cline', 'grandchild-model', grandchildMessages, JSON.stringify({ title: 'Grandchild contract fixture' }), 'grandchild', 1],
    ['cline-other', null, 104, 'completed', otherStarted, isoOffset({ hours: -2 }, base), otherStarted, 'other-provider', 'other-model', otherMessages, JSON.stringify({ title: 'Other contract fixture' }), 'other', 0],
    ['cline-partial', null, 105, 'completed', partialStarted, isoOffset({ minutes: -30 }, base), partialStarted, 'partial-provider', 'priced-model', partialMessages, JSON.stringify({ title: 'Partial contract fixture' }), 'partial', 0],
    ['cline-truncated', null, 106, 'completed', isoOffset({ days: -4 }, base), isoOffset({ days: -4 }, base), isoOffset({ days: -4 }, base), 'unknown', 'unknown', badMessages, JSON.stringify({ schemaVersion: 99, title: 'Truncated fixture' }), 'truncated', 0],
  ];
  for (const row of rows) insert.run(...row);
  database.close();

  return {
    dataDir,
    script: clineScript,
    today: partialStarted.slice(0, 10),
    rootDate: rootStarted.slice(0, 10),
    sessionIds: ['cline-root', 'cline-child', 'cline-grandchild', 'cline-other', 'cline-partial', 'cline-truncated'],
    // The conformance kit's scenario handles. See tests/conformance/run-conformance.mjs for what
    // each one is required to be. Naming them here rather than in the kit keeps the kit
    // runtime-agnostic: a new adapter supplies its own fixture with the same five handles.
    root: 'cline-root',
    child: 'cline-child',
    grandchild: 'cline-grandchild',
    // Cline has no session whose cost is wholly unknown - it records a cost per call - so the rule-1
    // case is `cline-partial`, whose coverage is partial: the disclosed amount is a lower bound and
    // the CSV charge cell must stay empty. `cline-truncated` is the known-zero case (no calls),
    // which is a real answer and is what the `torn` handle exercises.
    unpriced: 'cline-partial',
    torn: 'cline-truncated',
  };
}


function writeMCodeSession(dataDir, sessionId, provider, model, messages, malformed = false) {
  const relative = path.join('v2', 'sessions', sessionId);
  const directory = path.join(dataDir, relative);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'llm-call.json'), JSON.stringify({
    provider: `custom_provider:${provider}`,
    model,
  }), 'utf8');
  const lines = messages.map((message) => JSON.stringify({ message })).join('\n');
  fs.writeFileSync(path.join(directory, 'messages.jsonl'), `${malformed ? '{"message":' : ''}${lines}\n`, 'utf8');
  return path.relative(path.join(dataDir, 'v2', 'sessions'), directory);
}

function testRateTable() {
  const refreshedAt = '2026-01-01T00:00:00.000Z';
  const commandcode = prepareProviderRates('commandcode', {
    'fixture-command-model': {
      name: 'Fixture Command Model',
      provider: 'commandcode',
      category: 'fixture',
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.25,
      cacheWriteSource: 'commandcode-model',
      sourceAmounts: { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0.25' },
    },
  }, { refreshedAt });
  // Every model name in this fixture is deliberately synthetic. A test that runs the CLI
  // without SESSION_COST_RATES_PATH falls back to the *bundled* table, and a real model name
  // here would silently become priceable the moment a refresh published a record effective
  // from a timestamp older than the fixture's relative session dates. That is not
  // hypothetical: naming this model `step-5-preview` made one contract test pass on
  // 2026-09-26 and fail on 2026-09-27, with no code change in between.
  const stepfun = prepareProviderRates('stepfun', {
    'fixture-step-model': {
      name: 'fixture-step-model',
      provider: 'stepfun',
      category: 'fixture',
      input: 1,
      output: 2.7,
      cacheRead: 0.05,
      cacheWrite: 1,
      cacheWriteSource: 'stepfun-cache-miss-policy',
      sourceAmounts: { input: '1', output: '2.7', cacheRead: '0.05', cacheWrite: '1' },
    },
  }, { refreshedAt });
  return {
    _meta: {
      parserVersion: RATE_PARSER_VERSION,
      sourceParserVersion: { ...SOURCE_PARSER_VERSION },
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt,
      history: [{ versionId: refreshedAt, parserVersion: RATE_PARSER_VERSION }],
      sourceCoverage: {
        commandcode: { sourceModels: 1, publishedModels: 1, excludedModels: 0 },
        stepfun: { sourceModels: 1, publishedModels: 1, excludedModels: 0 },
      },
    },
    providers: {
      commandcode: { source: RATES_SOURCE.commandcode, fetchedAt: refreshedAt, ...commandcode },
      stepfun: { source: RATES_SOURCE.stepfun, fetchedAt: refreshedAt, ...stepfun },
    },
    freeModels: [],
    aliases: {},
  };
}

export function createMCodeFixture({ base } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-mcode-contract-'));
  fs.mkdirSync(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const rootTs = Date.parse(isoOffset({ days: -2 }, base));
  const todayTs = base ?? Date.now();
  const otherTs = todayTs;
  const partialTs = todayTs;
  const message = (timestamp, model, provider) => ({
    role: 'assistant',
    timestamp,
    model,
    provider: `custom_provider:${provider}`,
    usage: { input_tokens: 1, output_tokens: 1, cache_read_tokens: 1, cache_write_tokens: 1 },
  });
  const history = {
    root: writeMCodeSession(dataDir, 'mcode-root', 'commandcode', 'fixture-command-model', [
      message(rootTs + 1_000, 'fixture-command-model', 'commandcode'),
      message(rootTs + 2_000, 'fixture-step-model', 'stepfun'),
    ]),
    child: writeMCodeSession(dataDir, 'mcode-child', 'commandcode', 'fixture-command-model', [message(rootTs + 3_000, 'fixture-command-model', 'commandcode')]),
    grandchild: writeMCodeSession(dataDir, 'mcode-grandchild', 'commandcode', 'fixture-command-model', [message(rootTs + 4_000, 'fixture-command-model', 'commandcode')]),
    other: writeMCodeSession(dataDir, 'mcode-other', 'commandcode', 'fixture-command-model', [message(otherTs + 1_000, 'fixture-command-model', 'commandcode')]),
    partial: writeMCodeSession(dataDir, 'mcode-partial', 'commandcode', 'fixture-command-model', [
      message(partialTs + 1_000, 'fixture-command-model', 'commandcode'),
      message(partialTs + 2_000, 'unknown-model', 'commandcode'),
    ]),
    truncated: writeMCodeSession(dataDir, 'mcode-truncated', 'commandcode', 'fixture-command-model', [], true),
    // A session whose only model is absent from the mirrored rate tables, so the whole
    // session is unpriceable. Dated outside "today" so it cannot disturb the --today
    // selection assertions, which pin the exact set of sessions started that day.
    unpriced: writeMCodeSession(dataDir, 'mcode-unpriced', 'commandcode', 'unknown-model', [
      message(Date.parse(isoOffset({ days: -3 }, base)) + 1_000, 'unknown-model', 'commandcode'),
    ]),
  };


  const database = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  database.exec(`
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT,
      title TEXT,
      parent_session_id TEXT,
      history_relative_dir TEXT
    );
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      agent_name TEXT,
      turn_id TEXT,
      ts INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER
    );
  `);
  const insertSession = database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)');
  [
    ['mcode-root', 'root', 'Root contract fixture', null, history.root],
    ['mcode-child', 'child', 'Child contract fixture', 'mcode-root', history.child],
    ['mcode-grandchild', 'grandchild', 'Grandchild contract fixture', 'mcode-child', history.grandchild],
    ['mcode-other', 'other', 'Other contract fixture', null, history.other],
    ['mcode-partial', 'partial', 'Partial contract fixture', null, history.partial],
    ['mcode-truncated', 'truncated', 'Truncated contract fixture', null, history.truncated],
    ['mcode-unpriced', 'unpriced', 'Unpriced contract fixture', null, history.unpriced],
  ].forEach((row) => insertSession.run(...row));
  const insertUsage = database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  [
    [1, 'mcode-root', 'root', 'root-1', rootTs + 1_000, 100, 10, 5, 20, 30],
    [2, 'mcode-root', 'root', 'root-2', rootTs + 2_000, 200, 20, 10, 40, 50],
    [3, 'mcode-child', 'child', 'child-1', rootTs + 3_000, 10, 1, 0, 0, 1],
    [4, 'mcode-grandchild', 'grandchild', 'grandchild-1', rootTs + 4_000, 10, 1, 0, 0, 1],
    [5, 'mcode-other', 'other', 'other-1', otherTs + 1_000, 50, 5, 0, 0, 0],
    [6, 'mcode-partial', 'partial', 'partial-1', partialTs + 1_000, 50, 5, 0, 0, 0],
    [7, 'mcode-partial', 'partial', 'partial-2', partialTs + 2_000, 50, 5, 0, 0, 0],
    [8, 'mcode-truncated', 'truncated', 'truncated-1', Date.parse(isoOffset({ days: -4 }, base)), 10, 1, 0, 0, 0],
    [9, 'mcode-unpriced', 'unpriced', 'unpriced-1', Date.parse(isoOffset({ days: -3 }, base)), 400, 40, 0, 900, 0],
  ].forEach((row) => insertUsage.run(...row));
  database.close();

  const ratesPath = path.join(dataDir, 'provider-rates.json');
  fs.writeFileSync(ratesPath, JSON.stringify(testRateTable(), null, 2) + '\n', 'utf8');
  return {
    dataDir,
    script: mcodeScript,
    ratesPath,
    environment: { SESSION_COST_RATES_PATH: ratesPath },
    today: new Date(partialTs).toISOString().slice(0, 10),
    rootDate: new Date(rootTs).toISOString().slice(0, 10),
    sessionIds: ['mcode-root', 'mcode-child', 'mcode-grandchild', 'mcode-other', 'mcode-partial', 'mcode-truncated', 'mcode-unpriced'],
    // The conformance kit's scenario handles. See tests/conformance/run-conformance.mjs for what
    // each one is required to be. Naming them here rather than in the kit keeps the kit
    // runtime-agnostic: a new adapter supplies its own fixture with the same five handles.
    root: 'mcode-root',
    child: 'mcode-child',
    grandchild: 'mcode-grandchild',
    unpriced: 'mcode-unpriced',
    torn: 'mcode-truncated',
  };
}

/**
 * A seeded pseudo-random generator (mulberry32). Written out longhand because this project
 * ships zero dependencies (principle 12) and a random ledger that cannot be replayed is a
 * random ledger nobody can debug. The seed is printed on failure and accepted through
 * `INVARIANT_SEED`, so a case that fails once can be replayed exactly.
 */
export function seededRandom(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const PRICED_MODELS = [
  { model: 'fixture-command-model', provider: 'commandcode' },
  { model: 'fixture-step-model', provider: 'stepfun' },
];
const UNPRICED_MODEL = { model: 'unknown-model', provider: 'commandcode' };

/**
 * Build a random MCode ledger on top of the real fixture: N sessions, each with a random
 * number of calls, a random mix of priced and unpriced models, random token counts, and
 * timestamps spread over a window. Reuses the fixture's own rate table and ledger schema, so
 * the CLI under test is exercised exactly as it is in production.
 *
 * `includeUnpriced` is a parameter rather than a constant because the invariants differ for a
 * fully priceable ledger and one with an unpriced call, and both need covering.
 */
export function createRandomMCodeFixture(seed, { sessions = 4, includeUnpriced = false } = {}) {
  const random = seededRandom(seed);
  const fixture = createMCodeFixture();
  const pick = (values) => values[Math.floor(random() * values.length)];
  const integer = (min, max) => min + Math.floor(random() * (max - min + 1));
  const base = Date.parse('2026-06-15T12:00:00.000Z');

  const built = [];
  for (let index = 0; index < sessions; index += 1) {
    const sessionId = `random-${index}`;
    const callCount = integer(1, 5);
    const messages = [];
    for (let call = 0; call < callCount; call += 1) {
      const choice = includeUnpriced && random() < 0.3 ? UNPRICED_MODEL : pick(PRICED_MODELS);
      const ts = base + index * 60_000 + call * 1_000;
      messages.push({
        role: 'assistant',
        timestamp: ts,
        model: choice.model,
        provider: `custom_provider:${choice.provider}`,
        usage: {
          input_tokens: integer(1, 400),
          output_tokens: integer(1, 90),
          cache_read_tokens: integer(0, 300),
          cache_write_tokens: integer(0, 200),
        },
      });
    }
    built.push({
      sessionId,
      history: writeMCodeSession(fixture.dataDir, sessionId, 'commandcode', messages[0].model, messages),
      startedAt: new Date(base + index * 60_000).toISOString(),
      rows: messages.map((message, call) => [
        100_000 + index * 100 + call, sessionId, 'random', `${sessionId}-${call}`,
        message.timestamp,
        message.usage.input_tokens, message.usage.output_tokens, 0,
        message.usage.cache_read_tokens, message.usage.cache_write_tokens,
      ]),
    });
  }

  const database = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  const insertSession = database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)');
  const insertUsage = database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  for (const entry of built) {
    insertSession.run(entry.sessionId, `random-${entry.sessionId}`, `Random ${entry.sessionId}`, null, entry.history);
    for (const row of entry.rows) insertUsage.run(...row);
  }
  database.close();
  return { ...fixture, sessionIds: [...fixture.sessionIds, ...built.map((entry) => entry.sessionId)] };
}
