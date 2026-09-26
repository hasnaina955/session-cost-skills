import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
  USAGE_SOURCE_SESSION_AGGREGATE,
  USAGE_SOURCE_V1_PER_CALL,
  USAGE_SOURCE_V2_PER_CALL,
  readAggregateOnlyUsage,
  readPerCallUsage,
  readSessionGraphRows,
  readSessions,
  readSourceCoverage,
  readUsageRecords,
} from '../scripts/lib/opencode-ledger.mjs';

// A synthetic OpenCode ledger shaped like the real one. The shape came from reading a live
// install, and three details of it are load-bearing:
//
//   1. BOTH message stores carry per-call usage. An earlier version of this reader concluded
//      that 2.x kept no per-call usage, because the query filtered on `tokens.total > 0` and
//      that field is optional in the 2.x shape. So every 2.x row here omits `total`, exactly as
//      the real rows do, and a reader that filters on it finds nothing.
//   2. Where the two stores overlap, 1.x retains more calls than 2.x, and every disagreement
//      is a 1.18.30 session.
//   3. The session aggregate equals the sum of the 2.x per-call rows, so it is a roll-up of
//      the 2.x store and not an independent opinion.

/** 1.x shape: modelID/providerID at the top level, `tokens.total` always present. */
function v1Message({ sessionId, created, model, provider, tokens, cost = 0 }) {
  const data = JSON.stringify({
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
  });
  return [`msg_${created}`, sessionId, created, created + 100, data];
}

/** 2.x shape: model nested with its variant, `time.streamed`, and NO `tokens.total`. */
function v2Message({ sessionId, created, model, provider, tokens, cost = 0 }) {
  const data = JSON.stringify({
    model: { id: model, providerID: provider, variant: 'xhigh' },
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
  });
  return [`sm_${created}`, sessionId, 'assistant', created, created, created + 100, data];
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
  const insV1 = db.prepare('INSERT INTO session VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insV2 = db.prepare('INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)');
  const insMsg = db.prepare('INSERT INTO message VALUES (?,?,?,?,?)');
  const insSM = db.prepare('INSERT INTO session_message VALUES (?,?,?,?,?,?,?)');
  const tk = (i, o, r, cr, cw) => ({ input: i, output: o, reasoning: r, cache: { read: cr, write: cw } });

  // --- Agreement: a session in both stores with identical totals. ---
  insV1.run('ses_agree', null, 'Agree', 'build', '1.18.30', '/w', 0, 300, 20, 5, 700, 0, 1000, 5000, null);
  insV2.run('ses_agree', null, 'Agree', 'build', '1.18.30', '/w', 0, 300, 20, 5, 700, 0, 1000, 5000, null);
  insMsg.run(...v1Message({ sessionId: 'ses_agree', created: 1000, model: 'vendor/m', provider: 'opencode', tokens: tk(300, 20, 5, 700, 0) }));
  insSM.run(...v2Message({ sessionId: 'ses_agree', created: 1000, model: 'vendor/m', provider: 'opencode', tokens: tk(300, 20, 5, 700, 0) }));

  // --- Disagreement: 1.x kept three calls that 2.x never projected. 1.18.30, as in the real data. ---
  // 1.x total: 900 input / 1100 cache read.  2.x total: 400 / 500.
  insV1.run('ses_lost', null, 'Lost', 'build', '1.18.30', '/w', 0, 400, 10, 0, 500, 0, 2000, 5000, null);
  insV2.run('ses_lost', null, 'Lost', 'build', '1.18.30', '/w', 0, 400, 10, 0, 500, 0, 2000, 5000, null);
  for (const [i, n] of [[2000, 300], [2100, 300], [2200, 300]]) {
    insMsg.run(...v1Message({ sessionId: 'ses_lost', created: i, model: 'vendor/m', provider: 'opencode', tokens: tk(n, 3, 0, 366, 0) }));
  }
  insSM.run(...v2Message({ sessionId: 'ses_lost', created: 2000, model: 'vendor/m', provider: 'opencode', tokens: tk(400, 10, 0, 500, 0) }));

  // --- 2.x only: per-call rows exist even though no 1.x row does. ---
  insV2.run('ses_v2only', null, 'V2 only', 'build', '2.0.16', '/w', 1.25, 2000, 300, 100, 4000, 250, 7000, 9000,
    JSON.stringify({ id: 'step-5-preview', providerID: 'stepfun' }));
  insSM.run(...v2Message({ sessionId: 'ses_v2only', created: 7000, model: 'step-5-preview', provider: 'stepfun', tokens: tk(2000, 300, 100, 4000, 250), cost: 1.25 }));

  // --- 1.x only: no session_v2 row at all, so it must not be dropped. ---
  insV1.run('ses_v1only', null, 'V1 only', 'build', '1.18.32', '/w', 0, 10, 1, 0, 5, 0, 6000, 6500, null);
  insMsg.run(...v1Message({ sessionId: 'ses_v1only', created: 6000, model: 'vendor/m', provider: 'opencode', tokens: tk(10, 1, 0, 5, 0) }));

  // --- Aggregate-only: the fallback. Tokens on the session, no per-call row anywhere. ---
  insV2.run('ses_aggonly', null, 'Aggregate only', 'plan', '2.0.16', '/w', 0.5, 700, 70, 0, 300, 0, 9500, 9600,
    JSON.stringify({ id: 'vendor/m', providerID: 'opencode' }));

  // --- No usage at all: must contribute nothing, not a phantom zero. ---
  insV2.run('ses_empty', null, 'Empty', 'plan', '2.0.16', '/w', 0, 0, 0, 0, 0, 0, 9900, 9900, null);

  // A child of a 2.x-only parent, to prove the graph works across generations.
  insV2.run('ses_child', 'ses_v2only', 'Child', 'build', '2.0.16', '/w', 0, 20, 2, 0, 10, 0, 7500, 7600, null);
  insSM.run(...v2Message({ sessionId: 'ses_child', created: 7500, model: 'vendor/m', provider: 'opencode', tokens: tk(20, 2, 0, 10, 0) }));

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

test('the 2.x store really does carry per-call usage, despite tokens.total being optional', () => {
  withDb((db) => {
    // The original bug in one assertion: every 2.x fixture row omits `total`, so a reader that
    // filters on `json_extract(data,'$.tokens.total') > 0` sees nothing at all.
    const withTotal = db.prepare("SELECT COUNT(*) c FROM session_message WHERE json_extract(data,'$.tokens.total') IS NOT NULL").get().c;
    const withTokens = db.prepare("SELECT COUNT(*) c FROM session_message WHERE json_extract(data,'$.tokens') IS NOT NULL").get().c;
    assert.equal(withTotal, 0, 'the fixture must reproduce the missing optional field');
    assert.ok(withTokens > 0, 'but the rows carrying usage must be there');

    const records = readPerCallUsage(db).filter((r) => r.source === USAGE_SOURCE_V2_PER_CALL);
    assert.ok(records.length > 0, '2.x per-call usage must be read');
  });
});

test('a 2.x-only session is priced per call, not from its aggregate', () => {
  withDb((db) => {
    const records = readUsageRecords(db);
    const v2only = records.filter((r) => r.sessionId === 'ses_v2only');
    assert.equal(v2only.length, 1);
    assert.equal(v2only[0].source, USAGE_SOURCE_V2_PER_CALL, 'per-call, not the aggregate fallback');
    assert.equal(v2only[0].input_tokens, 2000);
    assert.equal(v2only[0].cache_read_tokens, 4000);
    assert.equal(v2only[0].cache_write_tokens, 250, 'cache writes are their own component');
    assert.equal(v2only[0].cost_usd, 1.25);
    // The 2.x shape nests the model; it must still be resolved.
    assert.equal(v2only[0].model, 'step-5-preview');
    assert.equal(v2only[0].provider, 'stepfun');
  });
});

test('1.x wins where the two stores disagree, because it retained more calls', () => {
  withDb((db) => {
    const records = readUsageRecords(db).filter((r) => r.sessionId === 'ses_lost');
    // Three 1.x calls, all from one source. "One source" is the invariant; a session with
    // several calls legitimately yields several records.
    assert.equal(records.length, 3, 'the three 1.x calls are reported');
    for (const record of records) assert.equal(record.source, USAGE_SOURCE_V1_PER_CALL);
    const total = records.reduce((sum, r) => sum + r.input_tokens, 0);
    assert.equal(total, 900, 'the 1.x total must be reported, not the 2.x projection of 400');
    assert.equal(records.reduce((sum, r) => sum + r.cache_read_tokens, 0), 1098);
    // The 2.x row for this session must be discarded, not added on top.
    assert.equal(records.filter((r) => r.source === USAGE_SOURCE_V2_PER_CALL).length, 0);
  });
});

test('a session described identically by both stores is counted once', () => {
  withDb((db) => {
    const records = readUsageRecords(db).filter((r) => r.sessionId === 'ses_agree');
    assert.equal(records.length, 1);
    assert.equal(records[0].input_tokens, 300);
    assert.equal(records[0].cache_read_tokens, 700);
  });
});

test('a 1.x-only session with no session_v2 row is not dropped', () => {
  withDb((db) => {
    const records = readUsageRecords(db).filter((r) => r.sessionId === 'ses_v1only');
    assert.equal(records.length, 1);
    assert.equal(records[0].source, USAGE_SOURCE_V1_PER_CALL);
    assert.equal(readSessions(db).some((s) => s.id === 'ses_v1only'), true, 'it must also appear as a session');
  });
});

test('the aggregate fallback fires only for a session with no per-call row at all', () => {
  withDb((db) => {
    const aggregate = readAggregateOnlyUsage(db);
    assert.equal(aggregate.length, 1);
    assert.equal(aggregate[0].sessionId, 'ses_aggonly');
    assert.equal(aggregate[0].source, USAGE_SOURCE_SESSION_AGGREGATE);
    assert.equal(aggregate[0].input_tokens, 700);
    assert.equal(aggregate[0].model, 'vendor/m', 'the session model label is resolved from its JSON');
  });
});

test('a session with no usage contributes nothing at all', () => {
  withDb((db) => {
    // A phantom zero row would read as "this session was free", which the project forbids.
    assert.equal(readUsageRecords(db).some((r) => r.sessionId === 'ses_empty'), false);
  });
});

test('no session is ever priced from more than one source', () => {
  withDb((db) => {
    const counts = new Map();
    for (const r of readUsageRecords(db)) counts.set(r.sessionId, (counts.get(r.sessionId) ?? 0) + 1);
    for (const [id, n] of counts) assert.ok(n >= 1, `${id} must contribute at least one record`);
    // No session may be billed from both a per-call set and an aggregate.
    const sources = new Map();
    for (const r of readUsageRecords(db)) {
      if (!sources.has(r.sessionId)) sources.set(r.sessionId, new Set());
      sources.get(r.sessionId).add(r.source === USAGE_SOURCE_SESSION_AGGREGATE ? 'agg' : 'call');
    }
    for (const [id, set] of sources) {
      assert.equal(set.size, 1, `${id} must come from exactly one of per-call or aggregate`);
    }
  });
});

test('sessions are read from both generations without duplication, and the graph spans them', () => {
  withDb((db) => {
    const ids = readSessions(db).map((s) => s.id);
    assert.equal(new Set(ids).size, ids.length);
    const byId = new Map(readSessionGraphRows(db).map((r) => [r.id, r.parent_id]));
    assert.equal(byId.get('ses_agree'), null);
    assert.equal(byId.get('ses_child'), 'ses_v2only', 'a child links to its parent across generations');
    assert.equal(byId.get('ses_v1only'), null);
  });
});

test('source coverage separates the two per-call stores from the fallback', () => {
  withDb((db) => {
    const coverage = readSourceCoverage(db);
    assert.equal(coverage.hasV1MessageStore, true);
    assert.equal(coverage.hasV2MessageStore, true);
    assert.equal(coverage.v1PerCallSessions, 3, 'ses_agree, ses_lost, ses_v1only');
    assert.equal(coverage.v2PerCallSessions, 2, 'ses_v2only, ses_child');
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
