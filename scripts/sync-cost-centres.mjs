import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sourcePath = path.join(root, 'shared', 'cost-centres.mjs');
const targets = [
  path.join(root, 'adapters', 'cline', 'skill', 'scripts', 'lib', 'cost-centres.mjs'),
  path.join(root, 'adapters', 'mcode', 'skill', 'scripts', 'lib', 'cost-centres.mjs'),
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
    console.error(`cost-centres copies are stale. Run npm run sync:cost-centres:\n${files}`);
    process.exitCode = 1;
  } else console.log(`Updated cost-centres copies:\n${files}`);
} else if (checkOnly) console.log('cost-centres copies are in sync.');
