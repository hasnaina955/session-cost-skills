import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function testFiles(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return testFiles(full);
    return entry.isFile() && entry.name.endsWith('.test.mjs') ? [full] : [];
  });
}

const suites = [
  ...testFiles(path.join(repositoryRoot, 'tests')),
  ...testFiles(path.join(repositoryRoot, 'adapters')),
];

test('temp directories are removed through the retrying helper, never a bare rmSync', () => {
  // Windows refuses to delete a directory whose SQLite handle is still open and returns EBUSY;
  // POSIX permits it. That asymmetry is why the suite passed everywhere under Node and failed
  // on Windows under Bun, and it will return the moment a new test deletes a temp directory
  // directly. A source scan is the only way to keep that from happening quietly.
  const offenders = [];
  for (const file of suites) {
    fs.readFileSync(file, 'utf8').split('\n').forEach((line, index) => {
      if (!/\bfs\.rmSync\(|\brmSync\(/.test(line)) return;
      // Removing a single known file needs no retry; removing a directory does.
      if (!/recursive:\s*true/.test(line)) return;
      offenders.push(`${path.relative(repositoryRoot, file)}:${index + 1}: ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [],
    `use removeDirectory() from tests/helpers/temp-dir.mjs for directory cleanup:\n${offenders.join('\n')}`);
});

test('the cleanup helper actually retries before giving up', () => {
  // A helper that silently lost its retry options would pass the scan above and fail on
  // Windows, so the options are asserted rather than assumed.
  const source = fs.readFileSync(path.join(repositoryRoot, 'tests', 'helpers', 'temp-dir.mjs'), 'utf8');
  assert.match(source, /maxRetries:\s*\d+/, 'the helper must allow the OS time to release a handle');
  assert.match(source, /retryDelay:\s*\d+/, 'a retry with no delay would busy-wait');
  assert.match(source, /force:\s*true/, 'cleanup must not fail on an already-removed directory');
});
