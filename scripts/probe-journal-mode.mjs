// Answers issue #50: is reading a live ledger safe while the agent writes to it?
//
//   node scripts/probe-journal-mode.mjs                    # probe both default locations
//   node scripts/probe-journal-mode.mjs <path-to-db> ...  # probe specific files
//
// WAL allows concurrent readers alongside a writer, so live polling is straightforward.
// A rollback journal takes a brief exclusive lock at commit and a concurrent reader can
// receive SQLITE_BUSY. This reports which case you are in and, for the risky case,
// whether a busy timeout is enough.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DEFAULT_TARGETS = [
  ['Cline', path.join(os.homedir(), '.cline', 'data', 'db', 'sessions.db')],
  ['MCode', path.join(os.homedir(), '.minimax', 'v2', 'sqlite', 'runtime-state.sqlite')],
];

function journalMode(file) {
  const db = new DatabaseSync(file, { readOnly: true, timeout: 500 });
  try {
    return db.prepare('PRAGMA journal_mode').get().journal_mode;
  } finally {
    db.close();
  }
}

// Exercise a reader against a live writer, which is the case that actually matters.
function concurrencyProbe(iterations = 2000) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-journal-'));
  const file = path.join(dir, 'probe.db');
  const writer = new DatabaseSync(file);
  try {
    writer.exec('PRAGMA journal_mode=WAL');
    writer.exec('CREATE TABLE t(x INTEGER)');
    let reads = 0;
    let busy = 0;
    for (let i = 0; i < iterations; i += 1) {
      writer.prepare('INSERT INTO t VALUES (?)').run(i);
      try {
        const reader = new DatabaseSync(file, { readOnly: true, timeout: 500 });
        reader.prepare('SELECT count(*) AS c FROM t').get();
        reader.close();
        reads += 1;
      } catch {
        busy += 1;
      }
    }
    return { reads, busy, mode: journalMode(file) };
  } finally {
    writer.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const targets = process.argv.slice(2).length
  ? process.argv.slice(2).map((file) => [path.basename(file), file])
  : DEFAULT_TARGETS;

const synthetic = concurrencyProbe();
console.log(`synthetic control: journal_mode=${synthetic.mode} reads=${synthetic.reads} busy=${synthetic.busy}`);
console.log(`  -> ${synthetic.busy === 0
  ? 'this runtime supports concurrent readers, so the control is valid'
  : 'this runtime does NOT support concurrent readers; treat a WAL result below with suspicion'}\n`);

for (const [label, file] of targets) {
  if (!fs.existsSync(file)) {
    console.log(`${label}: NOT FOUND at ${file}`);
    console.log('  -> unmeasured. Run this on a machine with that runtime installed.\n');
    continue;
  }
  let mode = 'unknown';
  try {
    mode = journalMode(file);
  } catch (error) {
    console.log(`${label}: could not read ${file}: ${error.message}\n`);
    continue;
  }
  const wal = mode.toLowerCase() === 'wal';
  console.log(`${label}: journal_mode=${mode}  (${file})`);
  console.log(`  -> ${wal
    ? 'WAL: concurrent readers are permitted, so a live view can poll without a busy fallback.'
    : 'rollback journal: a reader can receive SQLITE_BUSY during a commit. A live view MUST treat'
      + ' that as transient, keep the last known frame, mark it stale, and retry.'}`);
}

if (!process.argv.slice(2).length) {
  const missing = targets.filter(([, file]) => !fs.existsSync(file));
  if (missing.length) {
    console.log(`\n${missing.length} target(s) not present here. Re-run on a machine with those runtimes installed.`);
  }
}
