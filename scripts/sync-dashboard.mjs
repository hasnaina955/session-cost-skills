import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shared', 'dashboard.mjs');
const targets = [
  path.join(root, 'adapters', 'cline', 'skill', 'scripts', 'lib', 'dashboard.mjs'),
  path.join(root, 'adapters', 'mcode', 'skill', 'scripts', 'lib', 'dashboard.mjs'),
  path.join(root, 'adapters', 'opencode', 'skill', 'scripts', 'lib', 'dashboard.mjs'),
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
    console.error(`Adapter dashboard copies are stale. Run npm run sync:dashboard:\n${files}`);
    process.exitCode = 1;
  } else {
    console.log(`Updated adapter dashboard copies:\n${files}`);
  }
} else if (checkOnly) {
  console.log('Adapter dashboard copies are in sync.');
}
