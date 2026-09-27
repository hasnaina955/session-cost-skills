import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { observeSchema, checkSchema, describeDrift, fingerprintSchema } from '../shared/schema-drift.mjs';
import { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli } from './helpers/contract-fixtures.mjs';

const REQUIRED = {
  sessions: ['session_id', 'parent_session_id', 'started_at', 'messages_path'],
  usage: ['session_id', 'ts', 'input_tokens', 'output_tokens'],
};

test('a matching schema is ok, and extra columns are newer rather than broken', () => {
  const observed = { sessions: ['session_id', 'parent_session_id', 'started_at', 'messages_path'], usage: ['session_id', 'ts', 'input_tokens', 'output_tokens'] };
  assert.equal(checkSchema(observed, REQUIRED).status, 'ok');

  // A runtime that grows a column is normal and must not break a report.
  const grown = { sessions: [...observed.sessions, 'is_subagent'], usage: [...observed.usage, 'reasoning_tokens'] };
  const verdict = checkSchema(grown, REQUIRED);
  assert.equal(verdict.status, 'newer');
  assert.equal(verdict.missingColumns.length, 0);
  assert.equal(verdict.extraColumns.length, 2);
  assert.equal(describeDrift(verdict), null, 'a newer schema is not a failure and must not produce a message');
});

test('a renamed column is drift, named by table and column', () => {
  const observed = { sessions: ['session_id', 'parent_session_id', 'started_at', 'message_path'], usage: ['session_id', 'ts', 'input_tokens', 'output_tokens'] };
  const verdict = checkSchema(observed, REQUIRED);
  assert.equal(verdict.status, 'drifted');
  assert.deepEqual(verdict.missingColumns, [{ table: 'sessions', column: 'messages_path' }]);
  const message = describeDrift(verdict, { runtimeId: 'Test runtime' });
  assert.match(message, /Test runtime/);
  assert.match(message, /sessions\.messages_path/);
  assert.match(message, /No figure in this report is trustworthy/);
});

test('a missing table is drift, not an empty ledger', () => {
  const verdict = checkSchema({ sessions: REQUIRED.sessions, usage: null }, REQUIRED);
  assert.equal(verdict.status, 'drifted');
  assert.deepEqual(verdict.missingTables, ['usage']);
  assert.match(describeDrift(verdict), /the table `usage` is missing/);
});

test('the fingerprint is stable across key order and changes with the schema', () => {
  const a = { sessions: ['b', 'a'], usage: ['d', 'c'] };
  const b = { usage: ['c', 'd'], sessions: ['a', 'b'] };
  assert.equal(fingerprintSchema(a), fingerprintSchema(b), 'key and column order must not matter');
  const c = { sessions: ['a'], usage: ['c', 'd'] };
  assert.notEqual(fingerprintSchema(a), fingerprintSchema(c));
  assert.match(fingerprintSchema(a), /^sha256:[a-f0-9]{64}$/);
});

test('observeSchema reads real columns and reports a missing table as absent', () => {
  const db = new DatabaseSync(':memory:');
  db.exec('CREATE TABLE sessions (session_id TEXT, started_at TEXT)');
  const observed = observeSchema(db, ['sessions', 'usage']);
  assert.deepEqual(observed.sessions, ['session_id', 'started_at']);
  assert.equal(observed.usage, null, 'a missing table is null, not a thrown error');
  db.close();
});

function renameColumn(dataDir, table, from, to) {
  const db = new DatabaseSync(path.join(dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec(`ALTER TABLE ${table} RENAME COLUMN ${from} TO ${to}`);
  db.close();
}

test('a real MCode ledger with a renamed column fails loudly instead of reading as zero', () => {
  // This is the bug the module exists for. `cache_read_tokens` renamed does not throw: the
  // SELECT still succeeds, the row carries `undefined`, and the aggregate treats it as zero -
  // so the session reports a smaller bill with complete coverage rather than an error.
  const fixture = createMCodeFixture();
  renameColumn(fixture.dataDir, 'local_runtime_token_usage', 'cache_read_tokens', 'cache_read_token_v2');

  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment);
  assert.notEqual(result.status, 0, 'a renamed column must fail rather than under-report');
  assert.match(result.stderr, /local_runtime_token_usage\.cache_read_tokens/);
  assert.match(result.stderr, /schema has changed/);
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/, 'no stack trace');
  assert.equal(result.stdout, '', 'no report at all is the point: a partial figure is the failure mode');
});

test('the same ledger with an extra column still reports normally', () => {
  const fixture = createMCodeFixture();
  const db = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.exec('ALTER TABLE local_runtime_token_usage ADD COLUMN experimental_metric REAL');
  db.close();
  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-root', '--json'], fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).billing.coverage, 'complete', 'a new column must not change the figure');
});

test('a real Cline ledger with a renamed column fails loudly', () => {
  const fixture = createClineFixture();
  const db = new DatabaseSync(path.join(fixture.dataDir, 'data', 'db', 'sessions.db'));
  db.exec('ALTER TABLE sessions RENAME COLUMN messages_path TO message_path_v2');
  db.close();
  const result = runCli(clineScript, fixture.dataDir, ['--session', 'cline-root', '--json']);
  assert.notEqual(result.status, 0, 'a renamed column must fail rather than under-report');
  assert.match(result.stderr, /sessions\.messages_path/);
  assert.equal(result.stdout, '');
});

test('doctor reports the observed schema and its fingerprint', () => {
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['doctor', '--json'], fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.ok(report.storage, 'doctor must carry a storage block');
  assert.match(report.storage.fingerprint, /^sha256:[a-f0-9]{64}$/);
  assert.ok(['ok', 'newer'].includes(report.storage.status), `unexpected status ${report.storage.status}`);
  assert.equal(report.storage.missingTables.length, 0, 'the stock fixture is not drifted');
  assert.equal(report.storage.missingColumns.length, 0);

  // The same fingerprint must appear in the text form, or it is only useful to a JSON reader.
  const text = runCli(mcodeScript, fixture.dataDir, ['doctor'], fixture.environment);
  assert.match(text.stdout, /storage schema: (ok|newer) \(sha256:[a-f0-9]{64}\)/);
});

test('doctor still works when the ledger is missing, because that is when it is needed', () => {
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['doctor'], { ...fixture.environment, SESSION_COST_DATA_DIR: '/nonexistent' });
  // Whatever the data dir, doctor must not throw: it is the command a user runs to find out.
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/, 'no stack trace');
});
