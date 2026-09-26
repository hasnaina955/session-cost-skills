import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  USAGE_SOURCE_PER_CALL,
  USAGE_SOURCE_SESSION_AGGREGATE,
  readAggregateOnlyUsage,
  readPerCallUsage,
  readSessionGraphRows,
  readSessions,
  readSourceCoverage,
  readUsageRecords,
} from '../scripts/lib/opencode-ledger.mjs';

// A synthetic OpenCode ledger shaped exactly like the real one, including the part that is easy
// to get wrong: 1.x and 2.x generations present at once, disagreeing about shared sessions.
//
// The shape was taken from a real install (85 session_v2 rows, 766 message rows, 3,368
// session_message rows, the 2.x message store carrying no token data at all, and three
// 1.18.30 sessions whose session_v2 aggregate is lower than the sum of their per-call rows).

function assistantMessage({ sessionId, created, completed, model, provider, tokens, cost = 0 }) {
  const data = JSON.stringify({
    role: 'assistant',
    modelID: model,
    providerID: provider,
    cost,
    time: { created, completed: completed ?? created },
    finish: 'stop',
    tokens: {
      total: tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write,
      input: tokens.input,
      output: tokens.output,
      reasoning: tokens.reasoning,
      cache: { read: tokens.cache.read, write: tokens.cache.write },
    },
  });
  // Positional, in `message` column order. node:sqlite reads an object argument as named
  // parameters, so an object cannot be spread in here.
  return [`msg_${created}`, sessionId, created, completed ?? created, data];
}

function createLedger() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-ledger-'));
  fs.mkdirSync(path.join(dir, '.local', 'share', 'opencode'), { recursive: true });
  const file = path.join(dir, '.local', 'share', 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);

  db.exec(`
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

  const insertV1 = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertV2 = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insertMessage = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const insertSessionMessage = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');

  // 1.18.30 root with two children, priced per call. The aggregate agrees with the per-call sum.
  insertV1.run('ses_root', null, 'Root', 'build', '1.18.30', '/w', 0, 300, 20, 5, 700, 0, 1000, 5000, null);
  insertV2.run('ses_root', null, 'Root', 'build', '1.18.30', '/w', 0, 300, 20, 5, 700, 0, 1000, 5000, null);
  insertMessage.run(...assistantMessage({ sessionId: 'ses_root', created: 1000, model: 'vendor/m', provider: 'opencode', tokens: { input: 300, output: 20, reasoning: 5, cache: { read: 700, write: 0 } } }));

  insertV1.run('ses_child', 'ses_root', 'Child', 'build', '1.18.30', '/w', 0, 50, 5, 0, 120, 0, 2000, 3000, null);
  insertV2.run('ses_child', 'ses_root', 'Child', 'build', '1.18.30', '/w', 0, 50, 5, 0, 120, 0, 2000, 3000, null);
  insertMessage.run(...assistantMessage({ sessionId: 'ses_child', created: 2000, model: 'vendor/m', provider: 'opencode', tokens: { input: 50, output: 5, reasoning: 0, cache: { read: 120, write: 0 } } }));

  // The disagreement: per-call rows total 900 input tokens, the 2.x aggregate says 400.
  // This is the real 1.18.30 case, and it is why the two sources are never summed.
  insertV1.run('ses_partial', null, 'Partial', 'build', '1.18.30', '/w', 0, 400, 10, 0, 100, 0, 4000, 5000, null);
  insertV2.run('ses_partial', null, 'Partial', 'build', '1.18.30', '/w', 0, 400, 10, 0, 100, 0, 4000, 5000, null);
  insertMessage.run(...assistantMessage({ sessionId: 'ses_partial', created: 4000, model: 'vendor/m', provider: 'opencode', tokens: { input: 600, output: 7, reasoning: 0, cache: { read: 500, write: 0 } } }));

  // 1.x-only session: present in `session` with no session_v2 row. It must not be lost.
  insertV1.run('ses_legacy', null, 'Legacy', 'build', '1.18.32', '/w', 0, 10, 1, 0, 5, 0, 6000, 6500, null);
  insertMessage.run(...assistantMessage({ sessionId: 'ses_legacy', created: 6000, model: 'vendor/m', provider: 'opencode', tokens: { input: 10, output: 1, reasoning: 0, cache: { read: 5, write: 0 } } }));

  // 2.x-only session: aggregates only, no per-call rows, model named at session level.
  insertV2.run('ses_modern', null, 'Modern', 'plan', '2.0.16', '/w', 1.25, 2000, 300, 100, 4000, 250, 7000, 9000,
    JSON.stringify({ id: 'step-5-preview', providerID: 'stepfun' }));
  insertSessionMessage.run('sm_1', 'ses_modern', 'assistant', 1, 7000, 9000, JSON.stringify({ role: 'assistant' }));

  // 2.x session with no token activity at all: it must contribute nothing, not a phantom zero row.
  insertV2.run('ses_empty', null, 'Empty', 'plan', '2.0.16', '/w', 0, 0, 0, 0, 0, 0, 9500, 9500, null);

  db.close();
  return { dir, file };
}

function withDb(fn) {
  const { dir, file } = createLedger();
  const db = new DatabaseSync(file, { readOnly: true, timeout: 2000 });
  try {
    return fn(db, dir);
  } finally {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('sessions are read from both generations and never duplicated', () => {
  withDb((db) => {
    const sessions = readSessions(db);
    const ids = sessions.map((row) => row.id);
    assert.equal(new Set(ids).size, ids.length, 'a session must not appear twice');
    // ses_root exists in both `session` and `session_v2`; it must be reported once.
    assert.equal(ids.filter((id) => id === 'ses_root').length, 1);
    // ses_legacy exists only in the 1.x table and must survive.
    assert.ok(ids.includes('ses_legacy'), 'a 1.x-only session must not be dropped');
    assert.ok(ids.includes('ses_modern'), 'a 2.x-only session must be read');
  });
});

test('the session graph links children to their parent', () => {
  withDb((db) => {
    const rows = readSessionGraphRows(db);
    const byId = new Map(rows.map((row) => [row.id, row.parent_id]));
    assert.equal(byId.get('ses_root'), null);
    assert.equal(byId.get('ses_child'), 'ses_root');
    assert.equal(byId.get('ses_modern'), null);
  });
});

test('per-call rows carry model, provider and all four token components', () => {
  withDb((db) => {
    const records = readPerCallUsage(db);
    assert.equal(records.length, 4, 'one record per assistant message carrying tokens');
    for (const record of records) {
      assert.equal(record.source, USAGE_SOURCE_PER_CALL);
      assert.equal(record.model, 'vendor/m');
      assert.equal(record.provider, 'opencode');
      for (const key of ['input_tokens', 'output_tokens', 'reasoning_tokens', 'cache_read_tokens', 'cache_write_tokens']) {
        assert.equal(typeof record[key], 'number', `${key} must be a number, never undefined`);
      }
    }
    const root = records.find((record) => record.sessionId === 'ses_root');
    assert.equal(root.input_tokens, 300);
    assert.equal(root.cache_read_tokens, 700);
  });
});

test('a session with per-call rows is never also priced from its aggregate', () => {
  withDb((db) => {
    // ses_partial has per-call rows AND a session_v2 row that disagrees. Exactly one must win,
    // and the per-call figure is the one that must be reported.
    const records = readUsageRecords(db);
    for (const id of ['ses_partial', 'ses_root', 'ses_child', 'ses_legacy']) {
      const forSession = records.filter((record) => record.sessionId === id);
      assert.equal(forSession.length, 1, `${id} must contribute exactly one record`);
      assert.equal(forSession[0].source, USAGE_SOURCE_PER_CALL);
    }
    const partial = records.find((record) => record.sessionId === 'ses_partial');
    // The aggregate claims 400 input tokens; the per-call row is the authoritative 600.
    assert.equal(partial.input_tokens, 600, 'the per-call row must win over the aggregate');
    assert.equal(records.some((record) => record.sessionId === 'ses_partial'
      && record.source === USAGE_SOURCE_SESSION_AGGREGATE), false, 'the aggregate must not be added on top');
  });
});

test('an aggregate-only session is still reported, marked as such', () => {
  withDb((db) => {
    const records = readAggregateOnlyUsage(db);
    assert.equal(records.length, 1, 'only ses_modern has aggregates and no per-call rows');
    const modern = records[0];
    assert.equal(modern.sessionId, 'ses_modern');
    assert.equal(modern.source, USAGE_SOURCE_SESSION_AGGREGATE);
    assert.equal(modern.input_tokens, 2000);
    assert.equal(modern.cache_read_tokens, 4000);
    assert.equal(modern.cache_write_tokens, 250, 'cache writes are their own component');
    assert.equal(modern.cost_usd, 1.25, 'the runtime-recorded cost is preserved');
    assert.equal(modern.model, 'step-5-preview');
    assert.equal(modern.provider, 'stepfun');
  });
});

test('a session with no token activity contributes nothing at all', () => {
  withDb((db) => {
    // A phantom zero row would read as "this session was free", which is exactly the
    // failure the project forbids.
    const records = readUsageRecords(db);
    assert.equal(records.some((record) => record.sessionId === 'ses_empty'), false);
  });
});

test('usage is never summed across both generations', () => {
  withDb((db) => {
    const records = readUsageRecords(db);
    const bySession = new Map();
    for (const record of records) bySession.set(record.sessionId, (bySession.get(record.sessionId) ?? 0) + 1);
    for (const [id, count] of bySession) {
      assert.equal(count, 1, `${id} must appear exactly once, or a report would bill it twice`);
    }
    const totalInput = records.reduce((sum, record) => sum + record.input_tokens, 0);
    // 300 + 50 + 600 + 10 from per-call rows, plus 2000 from the single aggregate-only session.
    assert.equal(totalInput, 2960, 'the total must count each session once');
  });
});

test('source coverage reports the precision each part of the ledger has', () => {
  withDb((db) => {
    const coverage = readSourceCoverage(db);
    assert.equal(coverage.hasPerCallStore, true);
    assert.equal(coverage.hasV1SessionTable, true);
    assert.equal(coverage.hasV2SessionTable, true);
    assert.equal(coverage.hasV2MessageStore, true);
    assert.equal(coverage.perCallSessions, 4);
    assert.equal(coverage.aggregateOnlySessions, 1);
  });
});

test('a ledger missing every session table is refused rather than read as empty', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-bad-'));
  fs.mkdirSync(path.join(dir, '.local', 'share', 'opencode'), { recursive: true });
  const file = path.join(dir, '.local', 'share', 'opencode', 'opencode.db');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE unrelated (id TEXT)');
  db.close();
  const { openLedger } = await import('../scripts/lib/opencode-ledger.mjs');
  await assert.rejects(() => openLedger(dir), /not an OpenCode ledger/);
  fs.rmSync(dir, { recursive: true, force: true });
});
