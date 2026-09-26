// OpenCode ledger reader.
//
// ## Storage source
//
// OpenCode keeps everything in one SQLite database, `opencode.db`, in WAL mode. It is NOT a
// single schema: the runtime is mid-migration from 1.x to 2.x and both generations are live in
// the same file at once.
//
//   1.18.x  `session`    + `message`         (per-call usage)
//   2.0.x   `session_v2` + `session_message` (per-call usage) + aggregates on the session
//
// Both message stores carry PER-CALL usage. They are two projections of the same session
// history, not one detailed and one summary-only.
//
// The two differ in shape. A 1.x `message.data` is:
//
//   { role, modelID, providerID, cost, finish, time: { created, completed },
//     tokens: { total, input, output, reasoning, cache: { read, write } } }
//
// A 2.x `session_message.data` is:
//
//   { model: { id, providerID, variant }, agent, finish, providerState, cost,
//     time: { created, streamed, completed },
//     tokens: { total?, input, output, reasoning, cache: { read, write } } }
//
// `tokens.total` is OPTIONAL in the 2.x shape. Filtering on it hides every row, which is exactly
// the mistake that produced the first version of this reader.
//
// ## Token semantics
//
//   - `tokens.input`       fresh input, EXCLUDES cache reads (same rule as MCode)
//   - `tokens.cache.read`  cached prompt reads
//   - `tokens.cache.write` cache writes
//   - `tokens.output`      output
//   - `tokens.reasoning`   reasoning, reported separately rather than folded into output
//   - `cost`               the runtime's own recorded cost, per call
//
// Total prompt is input + cache read + cache write, so a fresh token and a cached token are
// never conflated into one rate.
//
// ## Precedence, and why it is not a guess
//
// The 1.x and 2.x stores overlap, and for three sessions they disagree. Measured on a real
// install across the 13 sessions present in both:
//
//   ses_f356325ebffedEei0kkAJIamvg  v1 411 calls / 27,602,949 in   v2 324 calls / 18,862,280 in
//   ses_f31b4495bffelIw55JC3FQVPle  v1  40 calls /    250,212 in   v2  26 calls /    145,470 in
//   ses_f3134e298ffe1JvJc0Go8QynTM  v1  37 calls /    907,793 in   v2  20 calls /    198,109 in
//
// Every other shared session agrees exactly. All three disagreements are `version = 1.18.30`,
// and in every case the 1.x store retains MORE calls than the 2.x projection. So the 2.x
// projection lost history the 1.x store still holds, rather than the 1.x store double-counting.
//
// The `session_v2` aggregate columns are NOT a separate opinion. Checked against the 2.x
// per-call rows they match exactly for 48 of 54 sessions; the six that differ do so by a few
// hundred tokens and are the sessions being written at read time. The aggregate is a faithful
// roll-up of whatever the 2.x store holds.
//
// Therefore: **1.x per-call rows win wherever a session has them**, because they are the more
// complete record; 2.x per-call rows are used for sessions only 2.x has; the session aggregate
// is a last-resort fallback. The three sources are never summed, so a session contributes
// exactly one set of records and cannot be billed twice.
//
// ## What the fallback is for
//
// On the install measured here, zero sessions need it: all 57 sessions with any usage have
// per-call rows in at least one store. It exists because a future OpenCode version could
// aggregate without projecting, and a report that silently dropped those sessions would
// under-report spend. When it does apply, `source` says so, because an aggregate-priced
// session has no per-model split and must not be presented as if it did.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const LEDGER_RELATIVE_PATH = path.join('.local', 'share', 'opencode', 'opencode.db');

export const USAGE_SOURCE_V1_PER_CALL = 'v1-per-call';
export const USAGE_SOURCE_V2_PER_CALL = 'v2-per-call';
export const USAGE_SOURCE_SESSION_AGGREGATE = 'session-aggregate';

let DatabaseSync;

/** `node:sqlite` is only present on Node 22.15+, so it is imported lazily like the MCode reader. */
async function loadSqlite() {
  if (!DatabaseSync) ({ DatabaseSync } = await import('node:sqlite'));
  return DatabaseSync;
}

export function defaultDataDir() {
  return process.env.SESSION_COST_OPENCODE_DATA_DIR || os.homedir();
}

export function ledgerPath(dataDir = defaultDataDir()) {
  return path.join(dataDir, LEDGER_RELATIVE_PATH);
}

function toNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function tableExists(db, name) {
  return Boolean(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name));
}

function parseJson(value, fallback = null) {
  if (value == null) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

/**
 * Open the ledger read-only and confirm it really is an OpenCode ledger.
 *
 * OpenCode may be writing to it while the agent runs, so the handle is read-only and the
 * caller is expected to treat a busy database as transient rather than reporting a number
 * read from a half-written state.
 */
export async function openLedger(dataDir = defaultDataDir()) {
  const Database = await loadSqlite();
  const file = ledgerPath(dataDir);
  if (!fs.existsSync(file)) {
    throw new Error(`OpenCode ledger not found at ${file}. Set SESSION_COST_OPENCODE_DATA_DIR or pass --data-dir.`);
  }
  const db = new Database(file, { readOnly: true, timeout: 2000 });
  if (!tableExists(db, 'session_v2') && !tableExists(db, 'session')) {
    db.close();
    throw new Error(`${file} is not an OpenCode ledger: it has neither a session nor a session_v2 table.`);
  }
  return { db, file };
}

const SESSION_COLUMNS = `
  id, parent_id, title, agent, version, directory, model,
  cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
  time_created, time_updated`;

/**
 * Every session the ledger knows about, from both generations.
 *
 * The 1.x `session` table is read as well because some sessions exist there with no
 * `session_v2` row, and dropping them would silently lose spend.
 */
export function readSessions(db) {
  const rows = [];
  if (tableExists(db, 'session_v2')) {
    for (const row of db.prepare(`SELECT ${SESSION_COLUMNS} FROM session_v2`).all()) {
      rows.push({ ...row, schema: 'v2' });
    }
  }
  if (tableExists(db, 'session')) {
    for (const row of db.prepare(`SELECT ${SESSION_COLUMNS} FROM session`).all()) {
      if (rows.some((existing) => existing.id === row.id)) continue;
      rows.push({ ...row, schema: 'v1' });
    }
  }
  return rows;
}

/** Session-graph rows in the vocabulary `createSessionGraph` expects. */
export function readSessionGraphRows(db) {
  return readSessions(db).map((row) => ({ id: row.id, parent_id: row.parent_id ?? null }));
}

function usageFromData(sessionId, data, source) {
  if (!data || !data.tokens) return null;
  const created = Number(data.time?.created ?? 0);
  if (!Number.isFinite(created) || created <= 0) return null;
  const completed = Number(data.time?.completed ?? created);
  return {
    sessionId,
    ts: completed || created,
    createdTs: created,
    input_tokens: toNumber(data.tokens.input),
    output_tokens: toNumber(data.tokens.output),
    reasoning_tokens: toNumber(data.tokens.reasoning),
    cache_read_tokens: toNumber(data.tokens.cache?.read),
    cache_write_tokens: toNumber(data.tokens.cache?.write),
    cost_usd: toNumber(data.cost),
    // 1.x names the model at the top level; 2.x nests it alongside the variant.
    model: source === USAGE_SOURCE_V1_PER_CALL
      ? data.modelID ?? null
      : data.model?.id ?? data.modelID ?? null,
    provider: source === USAGE_SOURCE_V1_PER_CALL
      ? data.providerID ?? null
      : data.model?.providerID ?? data.providerID ?? null,
    source,
  };
}

/**
 * Per-call usage from BOTH message stores, with 1.x taking precedence per session.
 *
 * `time.completed` is preferred over `time.created` so a call is billed against the moment it
 * finished. Rows are selected without filtering on `tokens.total`: that field is optional in
 * the 2.x shape, and requiring it to be present (let alone non-zero) discards real usage.
 */
export function readPerCallUsage(db) {
  const byV1Session = new Map();
  const byV2Session = new Map();

  if (tableExists(db, 'message')) {
    for (const row of db.prepare('SELECT session_id, data FROM message WHERE data IS NOT NULL').all()) {
      const record = usageFromData(row.session_id, parseJson(row.data), USAGE_SOURCE_V1_PER_CALL);
      if (!record) continue;
      if (!byV1Session.has(record.sessionId)) byV1Session.set(record.sessionId, []);
      byV1Session.get(record.sessionId).push(record);
    }
  }
  if (tableExists(db, 'session_message')) {
    for (const row of db.prepare('SELECT session_id, data FROM session_message WHERE data IS NOT NULL').all()) {
      const record = usageFromData(row.session_id, parseJson(row.data), USAGE_SOURCE_V2_PER_CALL);
      if (!record) continue;
      if (!byV2Session.has(record.sessionId)) byV2Session.set(record.sessionId, []);
      byV2Session.get(record.sessionId).push(record);
    }
  }

  const records = [];
  const covered = new Set();
  // 1.x first: where both stores describe a session, 1.x retained strictly more calls.
  for (const [sessionId, list] of byV1Session) {
    records.push(...list);
    covered.add(sessionId);
  }
  for (const [sessionId, list] of byV2Session) {
    if (covered.has(sessionId)) continue;
    records.push(...list);
    covered.add(sessionId);
  }
  return records;
}

/**
 * One aggregate record per session that has token totals but no per-call rows in either store.
 *
 * These carry no per-model split because no per-call record exists to derive one from.
 * `source` is reported so the caller never presents them as per-call precision.
 */
export function readAggregateOnlyUsage(db) {
  const perCallSessions = new Set(readPerCallUsage(db).map((record) => record.sessionId));
  const records = [];
  for (const session of readSessions(db)) {
    if (perCallSessions.has(session.id)) continue;
    const tokens = toNumber(session.tokens_input) + toNumber(session.tokens_output)
      + toNumber(session.tokens_reasoning) + toNumber(session.tokens_cache_read)
      + toNumber(session.tokens_cache_write);
    if (tokens <= 0) continue;
    const model = parseJson(session.model, null);
    records.push({
      sessionId: session.id,
      ts: toNumber(session.time_updated) || toNumber(session.time_created),
      createdTs: toNumber(session.time_created),
      input_tokens: toNumber(session.tokens_input),
      output_tokens: toNumber(session.tokens_output),
      reasoning_tokens: toNumber(session.tokens_reasoning),
      cache_read_tokens: toNumber(session.tokens_cache_read),
      cache_write_tokens: toNumber(session.tokens_cache_write),
      cost_usd: toNumber(session.cost),
      model: typeof model?.id === 'string' ? model.id : null,
      provider: typeof model?.providerID === 'string' ? model.providerID : null,
      source: USAGE_SOURCE_SESSION_AGGREGATE,
    });
  }
  return records;
}

/** Per-call records wherever they exist, aggregates only where they do not. Never summed. */
export function readUsageRecords(db) {
  return [...readPerCallUsage(db), ...readAggregateOnlyUsage(db)];
}

/**
 * How much of the ledger each source accounts for, so a report can be honest about what it
 * measured instead of implying every session carries the same precision.
 */
export function readSourceCoverage(db) {
  const perCall = readPerCallUsage(db);
  const aggregate = readAggregateOnlyUsage(db);
  const v1 = perCall.filter((r) => r.source === USAGE_SOURCE_V1_PER_CALL);
  const v2 = perCall.filter((r) => r.source === USAGE_SOURCE_V2_PER_CALL);
  return {
    v1PerCallSessions: new Set(v1.map((r) => r.sessionId)).size,
    v2PerCallSessions: new Set(v2.map((r) => r.sessionId)).size,
    v1PerCallRecords: v1.length,
    v2PerCallRecords: v2.length,
    aggregateOnlySessions: new Set(aggregate.map((r) => r.sessionId)).size,
    aggregateOnlyRecords: aggregate.length,
    hasV1MessageStore: tableExists(db, 'message'),
    hasV2MessageStore: tableExists(db, 'session_message'),
    hasV1SessionTable: tableExists(db, 'session'),
    hasV2SessionTable: tableExists(db, 'session_v2'),
  };
}

/** Open, read, and close in one call, for callers that do not need the handle. */
export async function readLedger(dataDir = defaultDataDir()) {
  const { db, file } = await openLedger(dataDir);
  try {
    return {
      file,
      sessions: readSessions(db),
      graphRows: readSessionGraphRows(db),
      usage: readUsageRecords(db),
      coverage: readSourceCoverage(db),
    };
  } finally {
    db.close();
  }
}
