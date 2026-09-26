import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shared', 'cli-args.mjs');
const targets = [
  path.join(root, 'adapters', 'cline', 'skill', 'scripts', 'lib', 'cli-args.mjs'),
  path.join(root, 'adapters', 'mcode', 'skill', 'scripts', 'lib', 'cli-args.mjs'),
  path.join(root, 'adapters', 'opencode', 'skill', 'scripts', 'lib', 'cli-args.mjs'),
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
    console.error(`cli-args copies are stale. Run npm run sync:cli-args:\n${files}`);
    process.exitCode = 1;
  } else console.log(`Updated cli-args copies:\n${files}`);
} else if (checkOnly) console.log('cli-args copies are in sync.');
