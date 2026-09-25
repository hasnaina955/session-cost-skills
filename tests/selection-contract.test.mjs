import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createClineFixture, createMCodeFixture, clineScript, mcodeScript, runJson } from './helpers/contract-fixtures.mjs';

function updateStatuses(dataDir, statuses) {
  const database = new DatabaseSync(`${dataDir}/data/db/sessions.db`);
  const update = database.prepare('UPDATE sessions SET status = ? WHERE session_id = ?');
  for (const [id, status] of statuses) update.run(status, id);
  database.close();
}

test('Cline CLI rejects unknown and ambiguous explicit selection', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));

  const unknown = runJson(clineScript, fixture.dataDir, ['--session', 'missing-session']);
  assert.equal(unknown.result.status, 2);
  assert.equal(unknown.output, null);
  assert.match(unknown.result.stderr, /unknown session id: missing-session/);

  updateStatuses(fixture.dataDir, [['cline-root', 'running'], ['cline-other', 'idle']]);
  const ambiguous = runJson(clineScript, fixture.dataDir, []);
  assert.equal(ambiguous.result.status, 2);
  assert.equal(ambiguous.output, null);
  assert.match(ambiguous.result.stderr, /multiple active Cline root sessions/);
  assert.match(ambiguous.result.stderr, /cline-root/);
  assert.match(ambiguous.result.stderr, /cline-other/);
});

test('Cline CLI prefers a unique active root and renders fallback warnings', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  updateStatuses(fixture.dataDir, [['cline-root', 'pending'], ['cline-other', 'completed']]);
  const active = runJson(clineScript, fixture.dataDir, []);
  assert.equal(active.result.status, 0, active.result.stderr);
  assert.equal(active.output.selection.method, 'unique-active-root');
  assert.equal(active.output.session.id, 'cline-root');
  assert.equal(active.output.snapshot.active, true);
});

test('MCode CLI rejects unknown IDs and distinguishes known zero-call sessions', (t) => {
  const fixture = createMCodeFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const database = new DatabaseSync(`${fixture.dataDir}/v2/sqlite/runtime-state.sqlite`);
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)').run('mvs_zero', 'zero', 'Known zero call', null, 'zero');
  database.close();

  const unknown = runJson(mcodeScript, fixture.dataDir, ['--session', 'mvs_missing'], fixture.environment);
  assert.equal(unknown.result.status, 2);
  assert.equal(unknown.output, null);
  assert.match(unknown.result.stderr, /unknown MCode session id: mvs_missing/);

  const zero = runJson(mcodeScript, fixture.dataDir, ['--session', 'mvs_zero'], fixture.environment);
  assert.equal(zero.result.status, 0, zero.result.stderr);
  assert.equal(zero.output.coverage.status, 'no-calls');
  assert.equal(zero.output.billing.amountUsd, 0);
  assert.equal(zero.output.selection.method, 'explicit');
});

test('MCode CLI refuses to guess between parallel active roots', (t) => {
  const fixture = createMCodeFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  const database = new DatabaseSync(`${fixture.dataDir}/v2/sqlite/runtime-state.sqlite`);
  const now = Date.now();
  database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(90, 'mcode-other', 'other', 'active-a', now, 1, 1, 0, 0, 0);
  database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(91, 'mcode-partial', 'partial', 'active-b', now + 1, 1, 1, 0, 0, 0);
  database.close();

  const result = runJson(mcodeScript, fixture.dataDir, [], {
    ...fixture.environment,
    MCODE_SESSION_ID: '',
    MINIMAX_SESSION_ID: '',
    MCODE_THREAD_ID: '',
  });
  assert.equal(result.result.status, 2);
  assert.equal(result.output, null);
  assert.match(result.result.stderr, /multiple active MCode root sessions/);
  assert.match(result.result.stderr, /mcode-other/);
  assert.match(result.result.stderr, /mcode-partial/);
});
