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
const result = spawnSync(process.execPath, ['--test', ...testFiles], { cwd: root, stdio: 'inherit' });
process.exitCode = result.status ?? 1;
