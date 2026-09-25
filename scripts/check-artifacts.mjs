import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'adapters/cline/skill/SKILL.md',
  'adapters/cline/skill/scripts/session-cost.mjs',
  'adapters/mcode/skill/SKILL.md',
  'adapters/mcode/skill/scripts/session-cost.mjs',
  'adapters/mcode/skill/references/provider-rates.json',
];
for (const file of required) assert.ok(fs.existsSync(path.join(root, file)), `missing artifact file ${file}`);

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.match(packageJson.engines.node, /22\.15/);

const tracked = execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8' }).split('\0').filter(Boolean);
const forbidden = [
  /(^|\/)(secrets?\.json|providers\.json)$/i,
  /\.(?:db|sqlite|sqlite3)$/i,
  /(^|\/)(?:reports?|transcripts?|messages?\.jsonl)$/i,
  /\.(?:zip|7z|tar|gz)$/i,
];
for (const file of tracked) {
  assert.ok(!forbidden.some((pattern) => pattern.test(file)), `runtime data or archive is tracked: ${file}`);
  if (/\.(?:md|html|json|mjs)$/i.test(file)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, `${file} is not valid UTF-8`);
  }
}

for (const file of tracked.filter((item) => item.endsWith('.html'))) {
  const text = fs.readFileSync(path.join(root, file), 'utf8');
  assert.doesNotMatch(text, /\uFFFD|ΓÇ|â€|Ã./, `${file} contains mojibake`);
}

console.log(`Clean artifact allowlist and encoding checks passed (${required.length} required files, ${tracked.length} tracked files).`);
