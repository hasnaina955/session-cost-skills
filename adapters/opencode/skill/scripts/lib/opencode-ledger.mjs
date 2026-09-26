// OpenCode ledger reader.
//
// ## Storage source
//
// OpenCode keeps everything in one SQLite database, `opencode.db`, in WAL mode. It is NOT a
// single schema: the runtime is mid-migration from 1.x to 2.x and both generations are
// present in the same file at the same time.
//
//   1.18.x  `session`   (72 rows)  + `message`   (766 rows)
//   2.0.x   `session_v2` (85 rows)  + `session_message` (3368 rows)
//
// The trap is that the two generations disagree about the same sessions, and neither is a
// superset of the other:
//
//   - `session_message` (2.x) carries NO token data at all. Every `data` blob is null for
//     `$.tokens`. Per-call usage simply does not exist in the 2.x store.
//   - `message` (1.x) carries full per-call usage: cost, all four token components, modelID
//     and providerID per call.
//   - `session_v2` carries per-session aggregates (`tokens_*`, `cost`) for BOTH generations.
//
// Measured on a real install: 16 sessions have per-call rows, 85 have `session_v2` rows, 13
// appear in both. Of those 13, ten agree exactly and three DISAGREE — the `session_v2`
// aggregate is lower than the sum of the per-call rows (e.g. 18,862,280 vs 27,602,949 input
// tokens). All three mismatches are `version = 1.18.30`, the oldest runtime present, where the
// 2.x aggregate was backfilled without every earlier message.
//
// ## Token semantics
//
//   - `tokens.input`      fresh input, EXCLUDES cache reads (same rule as MCode)
//   - `tokens.cache.read` cached prompt reads
//   - `tokens.cache.write` cache writes
//   - `tokens.output`     output
//   - `tokens.reasoning`  reasoning, reported separately rather than folded into output
//   - `cost`              the runtime's own recorded cost, per call and per session
//
// Total prompt is input + cache read + cache write, so a fresh token and a cached token are
// never conflated into one rate.
//
// ## Precedence rule (this is the accounting decision)
//
// Per-call rows win wherever they exist. Session aggregates fill in only for sessions that
// have no per-call rows at all. The two are NEVER summed, because for the sessions where both
// exist they already overlap and summing would double-count.
//
// The consequence is reported rather than hidden: a session priced from per-call detail and
// one priced from an aggregate are not equally precise, and `readLedger` returns the source
// used for each so the report can say so. A 2.x session priced from its aggregate has no
// per-model split, because that granularity no longer exists in the store.
//
// Reading only the 1.x store would miss 72 sessions. Reading only the 2.x aggregates would lose
// per-model pricing for the 16 that still have it, and would silently under-report the three
// 1.18.30 sessions whose aggregate is incomplete. Neither is acceptable, hence the rule above.

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

export const LEDGER_RELATIVE_PATH = path.join('.local', 'share', 'opencode', 'opencode.db');

/** Per-call usage beats a session aggregate; a session aggregate never adds to per-call rows. */
export const USAGE_SOURCE_PER_CALL = 'per-call';
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
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?").get(name);
  return Boolean(row);
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
 * Open the ledger read-only and confirm it is really an OpenCode ledger.
 *
 * OpenCode may be writing to it while the agent runs, so the handle is opened read-only and
 * the caller is expected to tolerate a busy database rather than being handed a wrong number.
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

/**
 * Every session the ledger knows about, from both generations.
 *
 * The 1.x `session` table is read as well because three sessions exist there with no
 * `session_v2` row; dropping them would silently lose spend.
 */
export function readSessions(db) {
  const rows = [];
  if (tableExists(db, 'session_v2')) {
    for (const row of db.prepare(`
      SELECT id, parent_id, title, agent, version, directory, model,
             cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
             time_created, time_updated
      FROM session_v2`).all()) {
      rows.push({ ...row, schema: 'v2' });
    }
  }
  if (tableExists(db, 'session')) {
    for (const row of db.prepare(`
      SELECT id, parent_id, title, agent, version, directory, model,
             cost, tokens_input, tokens_output, tokens_reasoning, tokens_cache_read, tokens_cache_write,
             time_created, time_updated
      FROM session`).all()) {
      // A 1.x row for a session already seen in v2 must not be counted twice.
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

/**
 * Per-call usage from the 1.x `message` store.
 *
 * `time.created` is used rather than the row timestamp so ordering matches the runtime's own
 * clock, and `time.completed` is used as the effective timestamp so a call is billed against
 * the moment it finished.
 */
export function readPerCallUsage(db) {
  if (!tableExists(db, 'message')) return [];
  const records = [];
  for (const row of db.prepare("SELECT session_id, data FROM message WHERE data IS NOT NULL").all()) {
    const data = parseJson(row.data);
    if (!data || !data.tokens || data.role !== 'assistant') continue;
    const created = Number(data.time?.created ?? 0);
    const completed = Number(data.time?.completed ?? created);
    if (!Number.isFinite(created) || created <= 0) continue;
    records.push({
      sessionId: row.session_id,
      ts: completed || created,
      createdTs: created,
      input_tokens: toNumber(data.tokens.input),
      output_tokens: toNumber(data.tokens.output),
      reasoning_tokens: toNumber(data.tokens.reasoning),
      cache_read_tokens: toNumber(data.tokens.cache?.read),
      cache_write_tokens: toNumber(data.tokens.cache?.write),
      cost_usd: toNumber(data.cost),
      model: data.modelID ?? null,
      provider: data.providerID ?? null,
      source: USAGE_SOURCE_PER_CALL,
    });
  }
  return records;
}

/**
 * One aggregate record per session that has no per-call rows.
 *
 * These carry no per-model split because the 2.x store does not keep one. `model`/`provider`
 * are taken from the session's own model record when present, which is a session-level label
 * rather than a per-call fact, and coverage is reported as partial so nothing downstream
 * mistakes it for a per-call split.
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

/** Per-call records where they exist, aggregates only where they do not. Never summed. */
export function readUsageRecords(db) {
  return [...readPerCallUsage(db), ...readAggregateOnlyUsage(db)];
}

/**
 * How much of the ledger each generation accounts for, so a report can be honest about what it
 * measured instead of implying every session carries the same precision.
 */
export function readSourceCoverage(db) {
  const perCall = readPerCallUsage(db);
  const aggregate = readAggregateOnlyUsage(db);
  return {
    perCallSessions: new Set(perCall.map((record) => record.sessionId)).size,
    aggregateOnlySessions: new Set(aggregate.map((record) => record.sessionId)).size,
    perCallRecords: perCall.length,
    aggregateOnlyRecords: aggregate.length,
    hasPerCallStore: tableExists(db, 'message'),
    hasV1SessionTable: tableExists(db, 'session'),
    hasV2SessionTable: tableExists(db, 'session_v2'),
    hasV2MessageStore: tableExists(db, 'session_message'),
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
