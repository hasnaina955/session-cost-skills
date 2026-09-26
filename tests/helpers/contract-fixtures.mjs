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
export const opencodeScript = path.join(repositoryRoot, 'adapters', 'opencode', 'skill', 'scripts', 'session-cost.mjs');

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

function isoOffset({ days = 0, hours = 0 }) {
  return new Date(Date.now() + days * 86_400_000 + hours * 3_600_000).toISOString();
}

function writeMessages(directory, sessionId, messages) {
  const target = path.join(directory, 'data', 'sessions', `${sessionId}.json`);
  fs.writeFileSync(target, JSON.stringify({ schemaVersion: 1, messages }, null, 2), 'utf8');
  return target;
}

export function createClineFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-cline-contract-'));
  fs.mkdirSync(path.join(dataDir, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data', 'logs'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data', 'sessions'), { recursive: true });

  const rootStarted = isoOffset({ days: -2 });
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
    ['cline-root', null, 101, 'completed', rootStarted, isoOffset({ hours: -47 }), rootStarted, 'commandcode', 'root-model', rootMessages, JSON.stringify({ title: 'Root contract fixture' }), 'root', 0],
    ['cline-child', 'cline-root', 102, 'completed', rootStarted, isoOffset({ hours: -46 }), rootStarted, 'cline', 'child-model', childMessages, JSON.stringify({ title: 'Child contract fixture' }), 'child', 1],
    ['cline-grandchild', 'cline-child', 103, 'completed', rootStarted, isoOffset({ hours: -45 }), rootStarted, 'cline', 'grandchild-model', grandchildMessages, JSON.stringify({ title: 'Grandchild contract fixture' }), 'grandchild', 1],
    ['cline-other', null, 104, 'completed', otherStarted, isoOffset({ hours: -2 }), otherStarted, 'other-provider', 'other-model', otherMessages, JSON.stringify({ title: 'Other contract fixture' }), 'other', 0],
    ['cline-partial', null, 105, 'completed', partialStarted, isoOffset({ minutes: -30 }), partialStarted, 'partial-provider', 'priced-model', partialMessages, JSON.stringify({ title: 'Partial contract fixture' }), 'partial', 0],
    ['cline-truncated', null, 106, 'completed', isoOffset({ days: -4 }), isoOffset({ days: -4 }), isoOffset({ days: -4 }), 'unknown', 'unknown', badMessages, JSON.stringify({ schemaVersion: 99, title: 'Truncated fixture' }), 'truncated', 0],
  ];
  for (const row of rows) insert.run(...row);
  database.close();

  return {
    dataDir,
    script: clineScript,
    today: partialStarted.slice(0, 10),
    rootDate: rootStarted.slice(0, 10),
    sessionIds: ['cline-root', 'cline-child', 'cline-grandchild', 'cline-other', 'cline-partial', 'cline-truncated'],
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
  const stepfun = prepareProviderRates('stepfun', {
    'step-5-preview': {
      name: 'step-5-preview',
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

export function createMCodeFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-mcode-contract-'));
  fs.mkdirSync(path.join(dataDir, 'v2', 'sqlite'), { recursive: true });
  const rootTs = Date.parse(isoOffset({ days: -2 }));
  const todayTs = Date.now();
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
      message(rootTs + 2_000, 'step-5-preview', 'stepfun'),
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
      message(Date.parse(isoOffset({ days: -3 })) + 1_000, 'unknown-model', 'commandcode'),
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
    [8, 'mcode-truncated', 'truncated', 'truncated-1', Date.parse(isoOffset({ days: -4 })), 10, 1, 0, 0, 0],
    [9, 'mcode-unpriced', 'unpriced', 'unpriced-1', Date.parse(isoOffset({ days: -3 })), 400, 40, 0, 900, 0],
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
  };
}

// --- OpenCode -----------------------------------------------------------------
//
// A synthetic OpenCode ledger shaped like the real one, covering every case the CLI has to
// distinguish. Each session exists for one reason:
//
//   ses_root        1.x and 2.x per-call rows that DISAGREE, so the reader's precedence rule
//                   is observable from the CLI, plus a child and a grandchild to test
//                   --include-children and contract rule 4 (charge a descendant at most once)
//   ses_today       the only session started today, so --today pins an exact set
//   ses_free        a model whose rate card is all zeros: a genuinely free model
//   ses_unpriced    a model with no rate card at all: the cost must be unavailable, not zero
//   ses_aggregate   tokens on the session row and no per-call row anywhere, so the
//                   session-aggregate fallback fires and `source` has to be propagated
//   ses_empty       a session with no usage at all
//
// Every model sits at `fixture-provider`, a provider id no built-in driver matches, so the
// only rate source is the configured profile below. A profile whose providerIds overlapped a
// built-in would make `registry.resolve` report an ambiguous match, which is correct but would
// mean no test could reach the pricing path at all.

const OPENCODE_EFFECTIVE_FROM = '2020-01-01T00:00:00.000Z';

export function opencodeFixtureConfig() {
  return {
    schemaVersion: 1,
    providers: [{
      id: 'fixture-provider',
      driverId: 'openai-compatible',
      match: { providerIds: ['fixture-provider'], runtimes: ['opencode'] },
      currency: 'USD',
      rateCards: [
        {
          model: 'fixture-priced',
          effectiveFrom: OPENCODE_EFFECTIVE_FROM,
          input: 1,
          output: 2,
          cacheRead: 0.1,
          cacheWrite: 1.25,
        },
        {
          model: 'fixture-free',
          effectiveFrom: OPENCODE_EFFECTIVE_FROM,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ],
    }],
    models: [],
  };
}

/** 1.x shape: modelID/providerID at the top level, `tokens.total` always present. */
function opencodeV1Message({ sessionId, created, model, provider, tokens, cost = 0 }) {
  return [
    `msg_${sessionId}_${created}`,
    sessionId,
    created,
    created + 100,
    JSON.stringify({
      role: 'assistant',
      modelID: model,
      providerID: provider,
      cost,
      finish: 'stop',
      time: { created, completed: created + 100 },
      tokens: {
        total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cache.read, write: tokens.cache.write },
      },
    }),
  ];
}

/** 2.x shape: model nested with its variant and NO `tokens.total`, exactly as the real rows. */
function opencodeV2Message({ sessionId, created, model, provider, tokens, cost = 0 }) {
  return [
    `sm_${sessionId}_${created}`,
    sessionId,
    'assistant',
    created,
    created,
    created + 100,
    JSON.stringify({
      model: { id: model, providerID: provider, variant: 'high' },
      agent: 'build',
      finish: 'stop',
      providerState: { completed: true },
      cost,
      time: { created, streamed: created + 50, completed: created + 100 },
      tokens: {
        input: tokens.input,
        output: tokens.output,
        reasoning: tokens.reasoning,
        cache: { read: tokens.cache.read, write: tokens.cache.write },
      },
    }),
  ];
}

export function createOpenCodeFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-opencode-contract-'));
  const ledgerDir = path.join(dataDir, '.local', 'share', 'opencode');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const database = new DatabaseSync(path.join(ledgerDir, 'opencode.db'));
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, version TEXT, directory TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER,
      model TEXT
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, version TEXT, directory TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER,
      model TEXT
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const insV1 = database.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insV2 = database.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insMsg = database.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const insSM = database.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const tk = (input, output, reasoning, cacheRead, cacheWrite) => ({ input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } });
  const PROVIDER = 'fixture-provider';

  const rootTs = Date.parse(isoOffset({ days: -2 }));
  const todayTs = Date.now();
  const freeTs = Date.parse(isoOffset({ days: -4 }));
  const unpricedTs = Date.parse(isoOffset({ days: -3 }));
  const aggregateTs = Date.parse(isoOffset({ days: -5 }));

  // ses_root exists in both stores and they disagree: 1.x kept three calls that the 2.x
  // projection reduced to one. A CLI that ignored the reader's precedence rule would report
  // one call and a third of the tokens.
  insV1.run('ses_root', null, 'Root contract fixture', 'build', '1.18.30', '/w', 0, 300, 30, 0, 600, 0, rootTs, rootTs + 9_000, null);
  insV2.run('ses_root', null, 'Root contract fixture', 'build', '1.18.30', '/w', 0, 100, 10, 0, 200, 0, rootTs, rootTs + 9_000, null);
  for (const [offset, n] of [[0, 100], [3_000, 100], [6_000, 100]]) {
    insMsg.run(...opencodeV1Message({ sessionId: 'ses_root', created: rootTs + offset, model: 'fixture-priced', provider: PROVIDER, tokens: tk(n, 10, 0, n * 2, 0) }));
  }
  insSM.run(...opencodeV2Message({ sessionId: 'ses_root', created: rootTs, model: 'fixture-priced', provider: PROVIDER, tokens: tk(100, 10, 0, 200, 0) }));

  insV2.run('ses_child', 'ses_root', 'Child contract fixture', 'build', '2.0.16', '/w', 0, 50, 5, 0, 100, 0, rootTs + 10_000, rootTs + 11_000, null);
  insSM.run(...opencodeV2Message({ sessionId: 'ses_child', created: rootTs + 10_000, model: 'fixture-priced', provider: PROVIDER, tokens: tk(50, 5, 0, 100, 0) }));

  insV2.run('ses_grandchild', 'ses_child', 'Grandchild contract fixture', 'build', '2.0.16', '/w', 0, 20, 2, 0, 40, 0, rootTs + 12_000, rootTs + 13_000, null);
  insSM.run(...opencodeV2Message({ sessionId: 'ses_grandchild', created: rootTs + 12_000, model: 'fixture-priced', provider: PROVIDER, tokens: tk(20, 2, 0, 40, 0) }));

  insV2.run('ses_today', null, 'Today contract fixture', 'build', '2.0.16', '/w', 0, 200, 20, 0, 400, 0, todayTs, todayTs + 1_000, null);
  insSM.run(...opencodeV2Message({ sessionId: 'ses_today', created: todayTs, model: 'fixture-priced', provider: PROVIDER, tokens: tk(200, 20, 0, 400, 0) }));

  insV2.run('ses_free', null, 'Free contract fixture', 'build', '2.0.16', '/w', 0, 500, 50, 0, 900, 0, freeTs, freeTs + 1_000,
    JSON.stringify({ id: 'fixture-free', providerID: PROVIDER }));
  insSM.run(...opencodeV2Message({ sessionId: 'ses_free', created: freeTs, model: 'fixture-free', provider: PROVIDER, tokens: tk(500, 50, 0, 900, 0) }));

  insV2.run('ses_unpriced', null, 'Unpriced contract fixture', 'build', '2.0.16', '/w', 0, 400, 40, 0, 900, 0, unpricedTs, unpricedTs + 1_000,
    JSON.stringify({ id: 'unknown-model', providerID: PROVIDER }));
  insSM.run(...opencodeV2Message({ sessionId: 'ses_unpriced', created: unpricedTs, model: 'unknown-model', provider: PROVIDER, tokens: tk(400, 40, 0, 900, 0) }));

  // No per-call row in either store: this is the fallback the reader exists for.
  insV2.run('ses_aggregate', null, 'Aggregate contract fixture', 'plan', '2.0.16', '/w', 0, 700, 70, 0, 300, 0, aggregateTs, aggregateTs + 1_000,
    JSON.stringify({ id: 'fixture-priced', providerID: PROVIDER }));

  insV2.run('ses_empty', null, 'Empty contract fixture', 'plan', '2.0.16', '/w', 0, 0, 0, 0, 0, 0, aggregateTs, aggregateTs, null);

  database.close();

  const configPath = path.join(dataDir, 'session-cost.json');
  fs.writeFileSync(configPath, `${JSON.stringify(opencodeFixtureConfig(), null, 2)}\n`, 'utf8');
  // An empty directory that exists but holds no ledger, for the empty-ledger case.
  const emptyDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-opencode-empty-'));
  fs.mkdirSync(path.join(emptyDataDir, '.local', 'share', 'opencode'), { recursive: true });

  return {
    dataDir,
    emptyDataDir,
    script: opencodeScript,
    configPath,
    provider: PROVIDER,
    today: new Date(todayTs).toISOString().slice(0, 10),
    rootDate: new Date(rootTs).toISOString().slice(0, 10),
    // A config-layer home so a developer's real user config can never reach a test run.
    environment: {
      HOME: dataDir,
      USERPROFILE: dataDir,
      APPDATA: path.join(dataDir, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(dataDir, '.config'),
    },
    sessionIds: ['ses_root', 'ses_child', 'ses_grandchild', 'ses_today', 'ses_free', 'ses_unpriced', 'ses_aggregate', 'ses_empty'],
  };
}

/**
 * A ledger whose calls carry the cost the OpenCode runtime recorded, which is the case the
 * contract fixture cannot express: every row there records 0, so no report built from it ever
 * has a recorded total to report. Kept separate rather than added to `createOpenCodeFixture`
 * so the existing per-session and provider-filtered assertions stay exactly as they are.
 *
 * Runs with NO config at all (the fresh-install case) and with a config whose rate cards are
 * deliberately far from the recorded figures, so the two bases cannot be confused.
 */
export function createOpenCodeRecordedCostFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-opencode-recorded-'));
  const ledgerDir = path.join(dataDir, '.local', 'share', 'opencode');
  fs.mkdirSync(ledgerDir, { recursive: true });
  const database = new DatabaseSync(path.join(ledgerDir, 'opencode.db'));
  database.exec(`
    CREATE TABLE session (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, version TEXT, directory TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER,
      model TEXT
    );
    CREATE TABLE session_v2 (
      id TEXT PRIMARY KEY, parent_id TEXT, title TEXT, agent TEXT, version TEXT, directory TEXT,
      cost REAL, tokens_input INTEGER, tokens_output INTEGER, tokens_reasoning INTEGER,
      tokens_cache_read INTEGER, tokens_cache_write INTEGER, time_created INTEGER, time_updated INTEGER,
      model TEXT
    );
    CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
    CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);
  `);
  const insV2 = database.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insSM = database.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const tk = (input, output, reasoning, cacheRead, cacheWrite) => ({ input, output, reasoning, cache: { read: cacheRead, write: cacheWrite } });
  // Deliberately not a built-in provider id: an overlapping profile would be refused as
  // ambiguous, which is the documented cliff rather than anything this fixture should test.
  const PROVIDER = 'recorded-provider';
  const paidTs = Date.parse(isoOffset({ days: -6 }));
  const freeTs = Date.parse(isoOffset({ days: -7 }));

  // ses_paid mixes a zero-cost call into real recorded spend, exactly as the real
  // step-5-preview sessions do. The zero call belongs to the total; it is not a fallback
  // trigger.
  insV2.run('ses_paid', null, 'Recorded cost fixture', 'build', '2.0.16', '/w', 1.5, 100, 10, 0, 200, 0, paidTs, paidTs + 5_000,
    JSON.stringify({ id: 'paid-model', providerID: PROVIDER }));
  insSM.run(...opencodeV2Message({ sessionId: 'ses_paid', created: paidTs, model: 'paid-model', provider: PROVIDER, tokens: tk(100, 10, 0, 200, 0), cost: 1.0 }));
  insSM.run(...opencodeV2Message({ sessionId: 'ses_paid', created: paidTs + 1_000, model: 'paid-model', provider: PROVIDER, tokens: tk(0, 0, 0, 0, 0), cost: 0 }));
  insSM.run(...opencodeV2Message({ sessionId: 'ses_paid', created: paidTs + 2_000, model: 'paid-model', provider: PROVIDER, tokens: tk(0, 5, 0, 0, 0), cost: 0.5 }));

  // ses_free_named records 0 for every call, and the name says "free". The name is not
  // evidence: with no rate card behind it this must be unavailable, not $0.
  insV2.run('ses_free_named', null, 'Free-named but unconfigured', 'build', '2.0.16', '/w', 0, 300, 30, 0, 600, 0, freeTs, freeTs + 1_000,
    JSON.stringify({ id: 'vendor-model-free', providerID: PROVIDER }));
  for (const offset of [0, 1_000]) {
    insSM.run(...opencodeV2Message({ sessionId: 'ses_free_named', created: freeTs + offset, model: 'vendor-model-free', provider: PROVIDER, tokens: tk(150, 15, 0, 300, 0), cost: 0 }));
  }

  database.close();

  // The same ledger, plus rate cards chosen so a rate-based total is nothing like the
  // recorded one: $1000/M input would price ses_paid's 100 fresh input tokens at $0.10 on its
  // own. Any report that shows the rate figure instead of the recorded one is wrong.
  const configPath = path.join(dataDir, 'session-cost-recorded.json');
  fs.writeFileSync(configPath, `${JSON.stringify({
    schemaVersion: 1,
    providers: [{
      id: 'recorded-profile',
      driverId: 'openai-compatible',
      match: { providerIds: [PROVIDER], runtimes: ['opencode'] },
      currency: 'USD',
      rateCards: [
        { model: 'paid-model', effectiveFrom: OPENCODE_EFFECTIVE_FROM, input: 1000, output: 2000, cacheRead: 100, cacheWrite: 1000 },
        { model: 'vendor-model-free', effectiveFrom: OPENCODE_EFFECTIVE_FROM, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ],
    }],
    models: [],
  }, null, 2)}\n`, 'utf8');

  return {
    dataDir,
    script: opencodeScript,
    configPath,
    provider: PROVIDER,
    // The per-call recorded costs of ses_paid, which must be the headline on every basis.
    recordedPaid: 1.5,
    environment: {
      HOME: dataDir,
      USERPROFILE: dataDir,
      APPDATA: path.join(dataDir, 'AppData', 'Roaming'),
      XDG_CONFIG_HOME: path.join(dataDir, '.config'),
    },
    sessionIds: ['ses_paid', 'ses_free_named'],
  };
}

