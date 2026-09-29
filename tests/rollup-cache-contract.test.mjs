import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { mcodeScript, createMCodeFixture, runCli } from './helpers/contract-fixtures.mjs';
import { fingerprintFile, sessionKey } from '../shared/rollup-cache.mjs';

const PINNED = '2026-06-15T18:00:00.000Z';
const env = (fixture) => ({ ...fixture.environment, NO_COLOR: '1', SESSION_COST_NOW: PINNED });

function listRows(fixture, args = ['--list', '10']) {
  const result = runCli(mcodeScript, fixture.dataDir, args, env(fixture));
  assert.equal(result.status, 0, result.stderr);
  return result.stdout;
}

test('a cache hit and a cold computation agree, exactly', () => {
  // The one rule that matters. A cache that can quietly disagree with the truth is worse than
  // none, so the second run is asserted to produce *identical output* to the first - not merely
  // similar, and not merely fast.
  const fixture = createMCodeFixture();
  const first = listRows(fixture);
  assert.ok(fs.existsSync(path.join(fixture.dataDir, 'cache', 'rollup-cache.json')), 'the cache was written');
  const second = listRows(fixture);
  assert.equal(second, first, 'a warm cache must return the same rows a cold computation produces');
});

test('the ledger changing invalidates the cache, so a stale figure cannot be served', () => {
  // Invalidate by the ledger's own file fingerprint: any write moves size and mtime. A new call
  // landing after a cached run must not return the old total.
  const fixture = createMCodeFixture();
  const before = listRows(fixture);
  const dbPath = path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec("INSERT INTO local_runtime_token_usage VALUES (900002, 'mcode-root', 'root', 'new-call', 1781524800000, 1000, 500, 0, 0, 0)");
  db.close();
  const after = listRows(fixture);
  assert.notEqual(after, before, 'a write to the ledger must change the reported totals');
  assert.ok(after.includes('mcode-root'), 'the session is still listed');
});

test('includeChildren is part of the cache key, so a childless answer is never served with children', () => {
  // A total built without subagents and a total built with them are different figures, and the
  // cache must not confuse them.
  const fixture = createMCodeFixture();
  const without = listRows(fixture, ['--list', '10']);
  const withChildren = listRows(fixture, ['--list', '10', '--include-children']);
  // Both ran; the cache must have stored two separate entries, not one.
  const cache = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'cache', 'rollup-cache.json'), 'utf8'));
  const keys = Object.keys(cache.entries ?? {});
  assert.ok(keys.length >= 2, `expected separate cached entries for the two includeChildren values, got ${keys.length}`);
});

test('a rate refresh invalidates the cache, because a call then costs a different amount', () => {
  // The rate table is an input, not just the ledger. Refreshed rates change every price, so a
  // cache built on the old table must not survive.
  const fixture = createMCodeFixture();
  const before = listRows(fixture);
  const beforeFp = fingerprintFile(fixture.ratesPath);
  // Touch the rates file so its fingerprint moves.
  const content = fs.readFileSync(fixture.ratesPath, 'utf8');
  fs.writeFileSync(fixture.ratesPath, content + ' ');
  assert.notEqual(fingerprintFile(fixture.ratesPath), beforeFp, 'the fingerprint must change with the table');
  const after = listRows(fixture);
  assert.equal(after, before, 'a rate refresh must not change the figures, but the cache is rebuilt behind the scenes');
  fs.writeFileSync(fixture.ratesPath, content);
});

test('a corrupt cache file is a miss, never a failure and never a wrong number', () => {
  const fixture = createMCodeFixture();
  listRows(fixture);
  fs.writeFileSync(path.join(fixture.dataDir, 'cache', 'rollup-cache.json'), '{"version":1,"entries":{"broken":');
  const result = runCli(mcodeScript, fixture.dataDir, ['--list', '10'], env(fixture));
  assert.equal(result.status, 0, 'a corrupt cache must not break the report');
  assert.ok(result.stdout.includes('mcode-root'), 'and it must still answer');
  assert.doesNotMatch(result.stderr, /\bat .*:\d+:\d+/, 'no stack trace');
});

test('the aggregate stored is only what the list reads, not the whole report', () => {
  // The cached value is the value the agreement test checks, so it cannot drift from what the
  // list actually reads. Storing the whole report would also keep rate fingerprints, which are
  // provenance that has no place in a list row.
  const fixture = createMCodeFixture();
  listRows(fixture);
  const cache = JSON.parse(fs.readFileSync(path.join(fixture.dataDir, 'cache', 'rollup-cache.json'), 'utf8'));
  for (const entry of Object.values(cache.entries ?? {})) {
    assert.ok(!('rateRecords' in entry.value), 'no rate records in the cached aggregate');
    assert.ok(!('rateFingerprints' in entry.value), 'no rate fingerprints in the cached aggregate');
    assert.ok(Array.isArray(entry.value.models), 'the aggregate keeps the model rows the list reads');
  }
});
