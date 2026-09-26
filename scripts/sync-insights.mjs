// Copy the canonical insights module into both adapter libraries.
//
// The adapters ship byte-identical copies of every shared module, and `check:*` fails the
// build when a copy drifts. This script is the only sanctioned way to refresh them, so it
// writes the source file verbatim and never reformats it.
//
// `--check` reports drift and exits 1 without writing anything, which is what CI runs.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shared', 'insights.mjs');
const targets = [
  path.join(root, 'adapters', 'cline', 'skill', 'scripts', 'lib', 'insights.mjs'),
  path.join(root, 'adapters', 'mcode', 'skill', 'scripts', 'lib', 'insights.mjs'),
];
const checkOnly = process.argv.includes('--check');
const source = fs.readFileSync(sourcePath, 'utf8');
const stale = [];
for (const target of targets) {
  const current = fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : null;
  if (current === source) continue;
  stale.push(path.relative(root, target));
  if (!checkOnly) {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, source, 'utf8');
  }
}
if (stale.length) {
  const files = stale.map((file) => `- ${file}`).join('\n');
  if (checkOnly) {
    console.error(`insights copies are stale. Run npm run sync:insights:\n${files}`);
    process.exitCode = 1;
  } else console.log(`Updated insights copies:\n${files}`);
} else if (checkOnly) console.log('insights copies are in sync.');
