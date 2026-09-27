import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const documents = [
  'README.md',
  'CONTRIBUTING.md',
  'SUPPORT.md',
  'LICENSE',
  'CHANGELOG.md',
  'docs/gumroad-selling-guide.html',
  'docs/principles.md',
  'adapters/cline/USAGE.md',
  'adapters/cline/skill/SKILL.md',
  'adapters/mcode/USAGE.md',
  'adapters/mcode/skill/SKILL.md',
];
const sources = new Map(documents.map((file) => [file, fs.readFileSync(path.join(root, file), 'utf8')]));

for (const [file, text] of sources) {
  assert.equal(Buffer.from(text, 'utf8').toString('utf8'), text, `${file} is not valid UTF-8`);
  assert.doesNotMatch(text, /\uFFFD|ΓÇ|â€|Ã./, `${file} contains mojibake`);
  assert.doesNotMatch(
    text,
    /replace (?:the |the private-development |the private )?license|commercial single-user license|private-development license/i,
    `${file} tells readers to relicense MIT code`,
  );
  assert.doesNotMatch(text, /cline-session-cost|mcode-session-cost/i, `${file} contains a stale bundle directory name`);
}

const support = sources.get('SUPPORT.md');
const launch = sources.get('docs/gumroad-selling-guide.html');
const readme = sources.get('README.md');
const license = sources.get('LICENSE');

assert.match(license, /MIT License/);
assert.match(support, /%USERPROFILE%\\\.cline\\skills\\session-cost\\SKILL\.md/);
assert.match(support, /%USERPROFILE%\\\.minimax\\skills\\session-cost\\SKILL\.md/);
assert.match(support, /https:\/\/github\.com\/hasnaina955\/session-cost-skills\/issues/);
assert.match(launch, /Internal optional-support launch checklist/);
assert.match(launch, /adapters\/cline\/skill/);
assert.match(launch, /adapters\/mcode\/skill/);
assert.match(launch, /qualified legal review/i);
assert.match(readme, /\[Optional support and troubleshooting\]\(SUPPORT\.md\)/);
assert.ok(fs.existsSync(path.join(root, 'adapters/cline/skill/SKILL.md')));
assert.ok(fs.existsSync(path.join(root, 'adapters/mcode/skill/SKILL.md')));

// A principle that points at a test which does not exist is worse than no principle: it reads
// as enforced and is not. Every tests/ reference in the principles document must resolve, and
// the document must stay linked from the places a contributor reads first.
const principles = sources.get('docs/principles.md');
const referenced = [...principles.matchAll(/\b(tests\/[A-Za-z0-9._-]+\.test\.mjs)\b/g)].map((match) => match[1]);
assert.ok(referenced.length > 0, 'docs/principles.md must cite the tests that enforce it');
for (const relative of new Set(referenced)) {
  assert.ok(
    fs.existsSync(path.join(root, relative)),
    `docs/principles.md cites ${relative}, which does not exist. A rule must point at a real test.`,
  );
}
assert.match(readme, /\[Principles\]\(docs\/principles\.md\)/, 'README links the principles');
// The README quotes `--version` output. It was pinned to 0.3.0 for two releases, so it is now
// checked against package.json instead of being trusted.
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
assert.ok(
  readme.includes(`session-cost ${pkg.version} (cline adapter)`),
  `README quotes a --version example that does not match package.json (${pkg.version})`,
);

assert.match(sources.get('CONTRIBUTING.md'), /\[docs\/principles\.md\]\(docs\/principles\.md\)/, 'CONTRIBUTING links the principles');

console.log(`Documentation terms, encoding, install paths, and contacts verified (${documents.length} files).`);
