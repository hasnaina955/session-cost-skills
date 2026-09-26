import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const requiredRoots = ['tests', 'adapters'];
const excluded = new Set(['.git', 'node_modules', 'dist', 'coverage']);

function discover(directory) {
  const files = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (excluded.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...discover(target));
    else if (entry.name.endsWith('.test.mjs')) files.push(target);
  }
  return files;
}

const testFiles = discover(root).sort();
for (const file of testFiles) {
  const source = fs.readFileSync(file, 'utf8');
  if (/\b(?:test|describe)\.(?:skip|only|todo)\b|MCODE_TEST_DATA_DIR/.test(source)) {
    console.error(`test discovery rejected skipped, focused, todo, or environment-gated test: ${path.relative(root, file)}`);
    process.exit(1);
  }
}
for (const relative of requiredRoots) {
  const prefix = path.join(root, relative, '');
  if (!testFiles.some((file) => file.startsWith(prefix))) {
    console.error(`test discovery found no tests under ${relative}`);
    process.exit(1);
  }
}

console.log(`[test-discovery] Running ${testFiles.length} test file(s)`);
for (const file of testFiles) console.log(`  ${path.relative(root, file)}`);
// Two runner differences make the suite behave differently under Bun:
//   - Node's runner is `node --test <files>`. Bun's is the `test` subcommand and
//     `bun --test` is not it: the files run as plain scripts instead, so every
//     suite throws "Cannot use test outside of the test runner" and the run exits 1.
//   - node:test applies no default per-test timeout, but Bun's default is 5000ms,
//     which is shorter than the slowest CLI end-to-end test needs. Without raising
//     it, a passing test fails under Bun purely for being slower than that default.
const bun = typeof process.versions?.bun === 'string';
const runnerArgs = bun ? ['test', '--timeout', '120000', ...testFiles] : ['--test', ...testFiles];
const result = spawnSync(process.execPath, runnerArgs, { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
