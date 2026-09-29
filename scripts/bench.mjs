#!/usr/bin/env node
// Performance budgets, measured rather than assumed.
//
// Why this exists: `--list 20` took eleven seconds on a 10,000-session ledger when it was first
// measured, because it builds a full report per session instead of reading one grouped query.
// Nothing in the suite noticed, because correctness tests run against a handful of sessions and
// correctness is unaffected by how long an answer takes to compute. A slow tool stops being used,
// and a slow regression is the kind nobody files.
//
// The benchmark builds a synthetic ledger and times the database-driven operations. The numbers
// are machine-relative: they exist to catch a 10x regression between runs, not to claim absolute
// performance, which varies by hardware. Each operation has a generous budget; exceeding it fails
// the run so CI can post the timings, and a regression becomes visible rather than silent.
//
// Size is configurable. The default matches the shape that exposed the finding; a smaller shape
// (`--quick`) runs in a few seconds for local iteration.
//
//   node scripts/bench.mjs            # full shape
//   node scripts/bench.mjs --quick    # small shape, fast
//   node scripts/bench.mjs --json     # machine-readable
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const mcodeScript = path.join(root, 'adapters', 'mcode', 'skill', 'scripts', 'session-cost.mjs');
const args = process.argv.slice(2);
const QUICK = args.includes('--quick');
const JSON_OUT = args.includes('--json');

const SHAPE = QUICK
  ? { sessions: 500, callsPerSession: 20, note: 'quick shape' }
  : { sessions: 10_000, callsPerSession: 50, note: 'full shape, the one that exposed the finding' };

/** Build a synthetic ledger and the session files a report needs for model attribution. */
function buildLedger(directory, { sessions, callsPerSession }) {
  fs.mkdirSync(path.join(directory, 'v2', 'sqlite'), { recursive: true });
  fs.mkdirSync(path.join(directory, 'v2', 'sessions'), { recursive: true });
  const db = new DatabaseSync(path.join(directory, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`CREATE TABLE local_runtime_sessions (session_id TEXT PRIMARY KEY, agent_name TEXT, title TEXT, parent_session_id TEXT, history_relative_dir TEXT);
           CREATE TABLE local_runtime_token_usage (id INTEGER PRIMARY KEY, session_id TEXT, agent_name TEXT, turn_id TEXT, ts INTEGER, input_tokens INTEGER, output_tokens INTEGER, reasoning_tokens INTEGER, cache_read_tokens INTEGER, cache_write_tokens INTEGER);`);
  const insertSession = db.prepare('INSERT INTO local_runtime_sessions VALUES (?,?,?,?,?)');
  const insertCall = db.prepare('INSERT INTO local_runtime_token_usage VALUES (?,?,?,?,?,?,?,?,?,?)');
  const base = Date.parse('2026-06-15T12:00:00.000Z');
  db.exec('BEGIN');
  let id = 0;
  for (let s = 0; s < sessions; s += 1) {
    const sessionId = `s-${s}`;
    insertSession.run(sessionId, 'agent', `Session ${s}`, null, `v2/sessions/${sessionId}`);
    const sd = path.join(directory, 'v2', 'sessions', sessionId);
    fs.mkdirSync(sd, { recursive: true });
    fs.writeFileSync(path.join(sd, 'llm-call.json'), JSON.stringify({ provider: 'custom_provider:commandcode', model: 'qwen3-coder' }));
    fs.writeFileSync(path.join(sd, 'messages.jsonl'),
      Array.from({ length: callsPerSession }, (_, i) => JSON.stringify({ message: { role: 'assistant', timestamp: base + s * 86_400_000 + i * 1000, model: 'qwen3-coder', provider: 'custom_provider:commandcode', usage: { input_tokens: 100, output_tokens: 20, cache_read_tokens: 50, cache_write_tokens: 10 } } })).join('\n') + '\n');
    for (let c = 0; c < callsPerSession; c += 1) {
      insertCall.run(id++, sessionId, 'agent', `${sessionId}-${c}`, base + s * 86_400_000 + c * 1000, 100, 20, 0, 50, 10);
    }
  }
  db.exec('COMMIT');
  db.close();
}

function time(label, directory, argv, budgetMs) {
  const start = Date.now();
  const result = spawnSync(process.execPath, [mcodeScript, '--data-dir', directory, ...argv],
    { encoding: 'utf8', env: { ...process.env, SESSION_COST_NOW: '2026-06-15T18:00:00.000Z', NO_COLOR: '1' } });
  const ms = Date.now() - start;
  return { label, ms, budgetMs, exit: result.status, pass: result.status <= 2 && ms <= budgetMs, note: result.status === 2 ? 'exit 2 (no usable cost) - timing still valid' : null };
}

const BASELINE_PATH = path.join(root, 'tests', 'perf-baseline.json');
const REGRESSION_FACTOR = Number(process.env.PERF_REGRESSION_FACTOR ?? 3);

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-bench-'));
const t0 = Date.now();
buildLedger(directory, SHAPE);
const generateMs = Date.now() - t0;

const results = [
  time('single session', directory, ['--session', `s-${SHAPE.sessions - 1}`], 1_000),
  time('--list 20 (cold)', directory, ['--list', '20'], 8_000),
  time('--list 20 (warm)', directory, ['--list', '20'], 8_000),
  time('--list 20 --rollup daily', directory, ['--list', '20', '--rollup', 'daily'], 12_000),
];

fs.rmSync(directory, { recursive: true, force: true });

// A regression gate compares against a recorded baseline, not an absolute speed. An absolute
// budget that passed today and failed tomorrow would be a machine benchmark, not a regression
// test, and it is exactly the wall-clock trap WP-1.1 was written to stop. `--write-baseline`
// records the current numbers; any later run fails if an operation got much slower.
const WRITE_BASELINE = args.includes('--write-baseline');
if (WRITE_BASELINE) {
  const payload = JSON.stringify({ shape: SHAPE, node: process.version, platform: process.platform, timings: Object.fromEntries(results.map((r) => [r.label, r.ms])) }, null, 2);
  fs.writeFileSync(BASELINE_PATH, `${payload}\n`);
}
let baseline = null;
if (fs.existsSync(BASELINE_PATH)) baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
// Compare only like for like. A baseline recorded for the quick shape says nothing about the full
// shape, and comparing across them reported a 6x "regression" that was just a bigger ledger. The
// shape is part of the baseline, and a mismatch skips the comparison rather than inventing one.
const baselineMatchesShape = baseline?.shape?.sessions === SHAPE.sessions
  && baseline?.shape?.callsPerSession === SHAPE.callsPerSession;
for (const result of results) {
  const base = baselineMatchesShape ? baseline?.timings?.[result.label] : null;
  result.baselineMs = base ?? null;
  result.regressed = base != null && result.ms > base * REGRESSION_FACTOR;
  result.pass = result.pass && !result.regressed;
}
const baselineNote = !baseline
  ? 'no baseline recorded; run --write-baseline to start tracking regressions'
  : (baselineMatchesShape ? null : `baseline is for the ${baseline.shape?.sessions}-session shape, not this one; regression comparison skipped`);

const summary = {
  shape: { ...SHAPE, generateMs },
  node: process.version,
  platform: process.platform,
  results,
  note: 'A regression gate, not a machine benchmark: an operation fails when it is much slower than the recorded baseline for the same shape, not when it is slow in absolute terms. `--list` building a full report per session is the known cost driver; rollup-cache is unwired, which is why cold and warm are the same time (tracked in the perf issue).',
};

if (JSON_OUT) {
  console.log(JSON.stringify(summary, null, 2));
} else {
  console.log(`bench: ${SHAPE.sessions} sessions x ${SHAPE.callsPerSession} calls (${generateMs}ms to generate) on ${process.platform} / ${process.version}`);
  if (baselineNote) console.log(`  note: ${baselineNote}`);
  for (const result of results) {
    const marker = result.pass ? 'PASS' : 'FAIL';
    const vs = result.baselineMs != null ? `  (baseline ${result.baselineMs}ms, ${(result.ms / result.baselineMs).toFixed(1)}x)` : '  (no baseline)';
    console.log(`  ${marker}  ${result.label.padEnd(28)} ${String(result.ms).padStart(6)}ms${vs}${result.note ? `  ${result.note}` : ''}`);
  }
}

// Exit non-zero when any operation exceeds its budget, so this can gate CI.
const failures = results.filter((result) => !result.pass);
if (failures.length > 0) {
  if (!JSON_OUT) console.error(`\n${failures.length} operation(s) exceeded their budget`);
  process.exitCode = 1;
}
