// A local cache of computed session aggregates, invalidated by the ledger itself.
//
// A month-long rollup re-reads and re-aggregates every message record on every invocation.
// SQLite makes invalidation cheap and honest: the file's size and mtime change whenever
// anything is written, so the cache key can be derived from the real inputs rather than a
// timer.
//
// The one rule that matters: a cache hit and a cold computation must agree. If they do not,
// the cold computation wins and the disagreement is reported. A cache that can quietly
// disagree with the truth is worse than no cache at all.

import fs from 'node:fs';
import path from 'node:path';

export const CACHE_VERSION = 1;

/**
 * A fingerprint of the inputs a computation depended on. Any change to size or mtime
 * invalidates, because SQLite rewrites pages in place.
 */
export function fingerprintFile(file) {
  try {
    const stat = fs.statSync(file);
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`;
  } catch {
    // A missing file is itself a stable input state, not an error.
    return 'absent';
  }
}

/** The key for one session's aggregate. */
export function sessionKey(sessionId, { version = CACHE_VERSION } = {}) {
  return `v${version}:${sessionId}`;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    // Corrupt or partial cache entry: treat as a miss. A cache must never be able to
    // make a run fail.
    return null;
  }
}

/**
 * A cache of computed session aggregates stored under `directory`.
 *
 * Each entry records the fingerprint of the inputs it was computed from. A hit requires
 * both the entry to exist and every recorded fingerprint to still match.
 */
export function createRollupCache({ directory, fingerprint }) {
  const file = path.join(directory, 'rollup-cache.json');

  const load = () => readJson(file) ?? { version: CACHE_VERSION, entries: {} };
  const store = (state) => {
    try {
      fs.mkdirSync(directory, { recursive: true });
      fs.writeFileSync(file, JSON.stringify(state), 'utf8');
    } catch {
      // An unwritable cache directory degrades to no cache, which is acceptable: the
      // computation is still correct, only slower.
    }
  };

  return {
    file,
    /**
     * Return a cached aggregate when every input still matches, otherwise null.
     * @param {string} sessionId
     * @param {Record<string,string>} inputs map of input name -> fingerprint
     */
    get(sessionId, inputs) {
      const state = load();
      if (state.version !== CACHE_VERSION) return null;
      const entry = state.entries?.[sessionId];
      if (!entry) return null;
      for (const [name, value] of Object.entries(inputs)) {
        if (entry.inputs?.[name] !== value) return null;
      }
      return entry.value ?? null;
    },
    set(sessionId, inputs, value) {
      const state = load();
      state.version = CACHE_VERSION;
      state.entries = state.entries ?? {};
      state.entries[sessionId] = { inputs, value };
      store(state);
    },
    /** Drop entries whose inputs no longer match. Returns how many were removed. */
    prune(inputsFor) {
      const state = load();
      let removed = 0;
      for (const [sessionId, entry] of Object.entries(state.entries ?? {})) {
        const current = inputsFor(sessionId) ?? {};
        const stale = Object.entries(current).some(([name, value]) => entry.inputs?.[name] !== value);
        if (stale) { delete state.entries[sessionId]; removed += 1; }
      }
      if (removed) store(state);
      return removed;
    },
    clear() {
      try { fs.rmSync(file, { force: true }); } catch { /* Already gone. */ }
    },
    get size() {
      return Object.keys(load().entries ?? {}).length;
    },
  };
}

/**
 * Verify a cache against a cold computation. Returns the disagreements rather than
 * silently preferring either side, because a mismatch is a defect to investigate, not
 * something to resolve in favour of speed.
 */
export function verifyCacheAgreement(cachedValue, computedValue) {
  if (cachedValue == null || computedValue == null) return [];
  try {
    return JSON.stringify(cachedValue) === JSON.stringify(computedValue) ? [] : [{ cached: cachedValue, computed: computedValue }];
  } catch {
    return [{ cached: cachedValue, computed: computedValue }];
  }
}
