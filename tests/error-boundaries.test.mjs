import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describeStorageError, isExpectedFailure } from '../shared/error-boundaries.mjs';
import { MAX_RATE_RESPONSE_BYTES, RATE_FETCH_TIMEOUT_MS, fetchText } from '../adapters/mcode/skill/scripts/lib/rates.mjs';
import { writeDashboard } from '../shared/dashboard.mjs';
import { clineScript, mcodeScript, runCli } from './helpers/contract-fixtures.mjs';

const canonical = fs.readFileSync(new URL('../shared/error-boundaries.mjs', import.meta.url), 'utf8');
const scripts = { cline: clineScript, mcode: mcodeScript };
const scratch = (prefix) => fs.mkdtempSync(path.join(os.tmpdir(), `session-cost-${prefix}-`));

function clineDirWith(contents) {
  const dir = scratch('cline-bad');
  fs.mkdirSync(path.join(dir, 'data', 'db'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'data', 'db', 'sessions.db'), contents);
  return dir;
}

function mcodeDirWith(contents) {
  const dir = scratch('mcode-bad');
  fs.mkdirSync(path.join(dir, 'v2', 'sqlite'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'v2', 'sqlite', 'runtime-state.sqlite'), contents);
  return dir;
}

test('both adapters ship the same error-boundary translator', () => {
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/error-boundaries.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('storage failures become one readable line with no path or stack', () => {
  const cases = [
    ['Error: file is not a database', 'the file is not a readable database'],
    ['Error: no such table: sessions', 'the database is missing an expected table'],
    ['Error: database is locked', 'the database is locked by another process'],
    ['Error: SQLITE_CANTOPEN: permission denied', 'the file could not be read'],
  ];
  for (const [raw, expected] of cases) {
    assert.equal(describeStorageError(new Error(raw)), expected);
    assert.equal(isExpectedFailure(new Error(raw)), true);
  }
  // An unrecognised failure still must not leak a local path.
  const messy = new Error('boom at file:///home/alice/.cline/data/db/sessions.db\n    at Object.<anonymous>');
  const described = describeStorageError(messy);
  assert.doesNotMatch(described, /\/home\/|file:\/\/|at Object/);
  assert.ok(described.length <= 160);
  assert.equal(isExpectedFailure(new Error('boom')), false);
  assert.equal(describeStorageError(new Error('')), 'the storage layer reported an unknown error');
});

test('a corrupt database fails cleanly instead of printing a stack trace', () => {
  for (const [runtime, dir] of [['cline', clineDirWith('this is not sqlite')], ['mcode', mcodeDirWith('neither is this')]]) {
    const result = runCli(scripts[runtime], dir, ['--json']);
    assert.equal(result.status, 2, `${runtime} must exit 2 on a corrupt database`);
    assert.doesNotMatch(result.stderr, /\n\s+at |\.mjs:\d+/, `${runtime} leaked a stack trace`);
    assert.doesNotMatch(result.stderr, new RegExp(dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), `${runtime} leaked the full local path`);
    assert.match(result.stderr, /not a readable database/);
    assert.equal(result.stdout.trim(), '', `${runtime} must not emit a report it could not compute`);
  }
});

test('a database missing the expected table fails rather than reading as empty', () => {
  // The dangerous case: a valid SQLite file whose schema is wrong. Reporting zero
  // sessions would be indistinguishable from a genuine "you have no sessions" answer.
  const cline = scratch('cline-schema');
  fs.mkdirSync(path.join(cline, 'data', 'db'), { recursive: true });
  const clineDb = new DatabaseSync(path.join(cline, 'data', 'db', 'sessions.db'));
  clineDb.exec('CREATE TABLE unrelated (id INTEGER)');
  clineDb.close();
  const clineResult = runCli(scripts.cline, cline, ['--json']);
  assert.equal(clineResult.status, 2);
  assert.match(clineResult.stderr, /missing an expected table/);
  assert.equal(clineResult.stdout.trim(), '');

  const mcode = scratch('mcode-schema');
  fs.mkdirSync(path.join(mcode, 'v2', 'sqlite'), { recursive: true });
  const mcodeDb = new DatabaseSync(path.join(mcode, 'v2', 'sqlite', 'runtime-state.sqlite'));
  mcodeDb.exec('CREATE TABLE unrelated (id INTEGER)');
  mcodeDb.close();
  const mcodeResult = runCli(scripts.mcode, mcode, ['--json']);
  assert.equal(mcodeResult.status, 2);
  assert.match(mcodeResult.stderr, /missing an expected table|unreadable/);
  assert.equal(mcodeResult.stdout.trim(), '');
});

test('rate fetches have a deadline, a size cap, and a content-type check', async () => {
  assert.ok(RATE_FETCH_TIMEOUT_MS > 0 && RATE_FETCH_TIMEOUT_MS <= 60_000);
  assert.ok(MAX_RATE_RESPONSE_BYTES > 0);
  const respond = (init) => async () => ({
    ok: true,
    status: 200,
    headers: { get: (name) => init[name.toLowerCase()] ?? null },
    text: async () => init.body ?? '',
  });

  const html = await fetchText('https://example.test/pricing', { fetcher: respond({ 'content-type': 'text/html; charset=utf-8', body: '<html></html>' }) });
  assert.equal(html, '<html></html>');

  // The deadline must actually reach fetch, not merely be a declared constant.
  let captured = null;
  await fetchText('https://example.test/x', {
    fetcher: async (_url, init) => { captured = init; return { ok: true, status: 200, headers: { get: () => 'text/html' }, text: async () => 'ok' }; },
  });
  assert.ok(captured?.signal instanceof AbortSignal, 'fetch must be given an abort signal');
  await assert.rejects(fetchText('https://example.test/x', { fetcher: respond({ 'content-type': 'application/octet-stream', body: 'x' }) }), /unexpected content type/);
  await assert.rejects(fetchText('https://example.test/x', { fetcher: respond({ 'content-type': 'text/html', 'content-length': '99999999', body: 'x' }) }), /byte limit/);
  await assert.rejects(fetchText('https://example.test/x', { fetcher: respond({ 'content-type': 'text/html', body: 'x'.repeat(64) }), maxBytes: 16 }), /byte limit/);
  await assert.rejects(
    fetchText('https://example.test/x', { fetcher: async () => { throw Object.assign(new Error('socket hang up'), { name: 'TimeoutError' }); } }),
    /timed out after/,
  );
  await assert.rejects(
    fetchText('https://example.test/x', { fetcher: async () => { throw new Error('getaddrinfo ENOTFOUND'); } }),
    /rate source request failed/,
  );
  await assert.rejects(
    fetchText('https://example.test/x', { fetcher: async () => ({ ok: false, status: 503, headers: { get: () => null } }) }),
    /HTTP 503/,
  );
  // A fetch failure must not echo a URL or a local path back to the user.
  await assert.rejects(
    fetchText('file:///home/alice/secret', { fetcher: async () => { throw new Error('EACCES /home/alice/secret'); } }),
    (error) => !/\/home\/alice/.test(error.message),
  );
});

test('dashboard writes are atomic and leave no partial file behind', () => {
  const dir = scratch('dash');
  const out = path.join(dir, 'report.html');
  writeDashboard({ schemaVersion: 1, contractVersion: '1.2.0', generatedAt: new Date().toISOString(), runtime: { id: 'cline' } }, { outPath: out });
  assert.ok(fs.existsSync(out));
  assert.match(fs.readFileSync(out, 'utf8'), /<!DOCTYPE html>|<html/);
  assert.deepEqual(fs.readdirSync(dir), ['report.html'], 'no temporary file may survive a successful write');

  // A failed rename must clean up its temp file and report the target by name only.
  const original = fs.renameSync;
  fs.renameSync = () => { throw Object.assign(new Error('EXDEV cross-device link'), { code: 'EXDEV' }); };
  try {
    assert.throws(
      () => writeDashboard({ schemaVersion: 1 }, { outPath: path.join(dir, 'blocked.html') }),
      /could not write the dashboard to blocked\.html: EXDEV/,
    );
  } finally {
    fs.renameSync = original;
  }
  assert.deepEqual(fs.readdirSync(dir), ['report.html'], 'a failed write must not leave a partial dashboard');
});
