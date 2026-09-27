import fs from 'node:fs';

/**
 * Remove a temporary directory, tolerating a handle that has not been released yet.
 *
 * Windows refuses to delete a file any process still holds open and returns EBUSY; POSIX does
 * not. That asymmetry is why the same tests pass under Node everywhere and fail under Bun on
 * Windows: a SQLite handle is released when its object is collected rather than at the end of
 * its scope, so a delete issued immediately afterwards can still race it. `maxRetries` makes the
 * cleanup wait for the handle instead of failing, which is the entire reason this helper exists
 * in place of a bare `fs.rmSync` at each call site.
 *
 * This lives in its own module rather than in `contract-fixtures.mjs` so that a test which does
 * not otherwise need the ledger fixtures can still use it.
 */
export function removeDirectory(directory) {
  fs.rmSync(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
}
