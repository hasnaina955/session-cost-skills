import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  CACHE_VERSION,
  createRollupCache,
  fingerprintFile,
  sessionKey,
  verifyCacheAgreement,
} from '../shared/rollup-cache.mjs';

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-cache-'));
const inputs = (suffix = 'a') => ({ ledger: `1000:${suffix}`, messages: `50:${suffix}` });

test('a fresh cache misses and then hits', () => {
  const cache = createRollupCache({ directory: scratch() });
  assert.equal(cache.get('s1', inputs()), null, 'an unknown session must miss');
  cache.set('s1', inputs(), { costUsd: 1.5, tokens: 100 });
  assert.deepEqual(cache.get('s1', inputs()), { costUsd: 1.5, tokens: 100 });
  assert.equal(cache.size, 1);
});

test('any change to an input invalidates the entry', () => {
  const cache = createRollupCache({ directory: scratch() });
  cache.set('s1', inputs(), { costUsd: 1.5 });
  assert.equal(cache.get('s1', inputs('b')), null, 'a changed fingerprint must miss');
  assert.deepEqual(cache.get('s1', inputs('a')), { costUsd: 1.5 }, 'the original still hits');
});

test('a corrupt or partial cache file is a miss, never a failure', () => {
  const dir = scratch();
  const cache = createRollupCache({ directory: dir });
  cache.set('s1', inputs(), { costUsd: 1 });
  fs.writeFileSync(cache.file, '{ this is not json', 'utf8');
  assert.equal(cache.get('s1', inputs()), null, 'a corrupt entry must miss rather than throw');

  const partial = createRollupCache({ directory: dir });
  fs.writeFileSync(partial.file, JSON.stringify({ version: CACHE_VERSION, entries: { s1: { inputs: {} } } }), 'utf8');
  assert.equal(partial.get('s1', inputs()), null, 'an entry with no recorded inputs must miss');
});

test('a cache written by a different version is ignored', () => {
  const dir = scratch();
  const cache = createRollupCache({ directory: dir });
  cache.set('s1', inputs(), { costUsd: 1 });
  const state = JSON.parse(fs.readFileSync(cache.file, 'utf8'));
  state.version = CACHE_VERSION + 1;
  fs.writeFileSync(cache.file, JSON.stringify(state), 'utf8');
  assert.equal(cache.get('s1', inputs()), null, 'a stale cache version must not be trusted');
});

test('an unwritable cache location degrades to no cache, not to an error', () => {
  // A path whose parent is a regular file can never be created, on any platform.
  // The computation stays correct; only slower. A cache must never fail a run.
  const dir = scratch();
  const blocker = path.join(dir, 'blocker');
  fs.writeFileSync(blocker, 'not a directory', 'utf8');
  const cache = createRollupCache({ directory: path.join(blocker, 'cache') });
  assert.doesNotThrow(() => cache.set('s1', inputs(), { costUsd: 1 }));
  assert.equal(cache.get('s1', inputs()), null, 'nothing is cached, and nothing throws');
  assert.doesNotThrow(() => cache.clear());
  assert.doesNotThrow(() => cache.prune(() => inputs()));
});

test('the fingerprint tracks the real file, and a missing file is a stable state', () => {
  const dir = scratch();
  const file = path.join(dir, 'ledger.db');
  assert.equal(fingerprintFile(file), 'absent');
  assert.equal(fingerprintFile(file), 'absent', 'absence is stable, not an error');
  fs.writeFileSync(file, 'sqlite-ish', 'utf8');
  const first = fingerprintFile(file);
  assert.notEqual(first, 'absent');
  assert.equal(fingerprintFile(file), first, 'an unchanged file keeps its fingerprint');
  fs.appendFileSync(file, 'more', 'utf8');
  assert.notEqual(fingerprintFile(file), first, 'a changed file must change its fingerprint');
});

test('a disagreement between cache and cold computation is reported, not resolved', () => {
  assert.deepEqual(verifyCacheAgreement({ costUsd: 1 }, { costUsd: 1 }), []);
  const disagreements = verifyCacheAgreement({ costUsd: 1 }, { costUsd: 2 });
  assert.equal(disagreements.length, 1, 'a mismatch must surface');
  assert.equal(disagreements[0].cached.costUsd, 1);
  assert.equal(disagreements[0].computed.costUsd, 2, 'both sides are kept for inspection');
  // A missing side is not a disagreement; there is nothing to compare.
  assert.deepEqual(verifyCacheAgreement(null, { costUsd: 1 }), []);
  assert.deepEqual(verifyCacheAgreement({ costUsd: 1 }, null), []);
});

test('prune drops only the entries whose inputs moved on', () => {
  const cache = createRollupCache({ directory: scratch() });
  cache.set('keep', inputs('a'), { costUsd: 1 });
  cache.set('drop', inputs('b'), { costUsd: 2 });
  const removed = cache.prune((id) => inputs(id === 'drop' ? 'c' : 'a'));
  assert.equal(removed, 1);
  assert.equal(cache.size, 1);
  assert.deepEqual(cache.get('keep', inputs('a')), { costUsd: 1 });
});

test('session keys are version-scoped so an upgrade cannot read an old shape', () => {
  assert.equal(sessionKey('s1'), `v${CACHE_VERSION}:s1`);
  assert.notEqual(sessionKey('s1', { version: 99 }), sessionKey('s1'));
});

test('clearing the cache changes nothing about the computation', () => {
  const dir = scratch();
  const cache = createRollupCache({ directory: dir });
  const value = { costUsd: 4, tokens: 20 };
  cache.set('s1', inputs(), value);
  cache.clear();
  assert.equal(cache.get('s1', inputs()), null);
  // The caller still has the value it computed; the cache is a speed aid, not a source.
  assert.deepEqual(verifyCacheAgreement(value, { costUsd: 4, tokens: 20 }), []);
});
