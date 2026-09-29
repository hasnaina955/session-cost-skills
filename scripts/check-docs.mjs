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
  'docs/session-cost-support-pack.html',
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

// The support pack is the document a customer is pointed at when something is already installed and
// already paid for, so a stale figure in it is worse than no document. Its version, its Node floor,
// and its support promise are asserted here against the sources of truth rather than trusted: the
// pack was written against 0.2.0 and kept claiming that version, a 22.13 floor, MCode direct-children
// only, and Bun on Windows, all of which were true when written and none of which is true now.
const pack = sources.get('docs/session-cost-support-pack.html');
const supportFloor = pkg.engines.node.replace(/^>=/, '');
assert.ok(
  pack.includes(`Repository version: <strong>${pkg.version}</strong>`),
  `support pack states a version that does not match package.json (${pkg.version})`,
);
assert.ok(
  pack.includes(`Session Cost Skills ${pkg.version}`),
  `support pack footer states a version that does not match package.json (${pkg.version})`,
);
assert.ok(
  pack.includes(`Node.js ${supportFloor} or newer`),
  `support pack states a Node floor that does not match engines.node (${pkg.engines.node})`,
);
assert.doesNotMatch(
  pack,
  /MCode 0\.\d+\.\d+ includes direct children|includes direct child sessions only/i,
  'support pack still claims MCode stops at direct children; both adapters include all descendants',
);
// Bun is CI-tested on Ubuntu only. Advertising it on Windows invites a support ticket about the
// 11 EBUSY failures that the CI comment already documents as expected.
assert.doesNotMatch(
  pack,
  /Bun (?:1\.\d+\.\d+ or newer is optional|CI-tested for adapter tests)/i,
  'support pack advertises Bun without the Ubuntu-only limitation',
);
assert.match(pack, /Ubuntu only/i, 'support pack must state that Bun is CI-tested on Ubuntu only');
// The four config keys are required by the schema; a pack showing an invented key teaches a
// customer to write a file the CLI then rejects.
for (const key of ['schemaVersion', 'runtimeDefaults', 'providers', 'models']) {
  assert.ok(pack.includes(`"${key}"`), `support pack omits the required config key ${key}`);
}
for (const key of ['standingSummary', 'warnOnCacheRateBelow', 'defaultFormat']) {
  assert.doesNotMatch(
    pack,
    new RegExp(`"${key}"`),
    `support pack shows config key ${key}, which is not in the session-config schema`,
  );
}

// A release section with two `### Added` headings is two sections pretending to be one: a reader
// cannot tell whether an entry belongs to the batch above or the batch below, and the changelog is
// what someone reads to find out what actually shipped. Unreleased accumulated three. Scoped to
// Unreleased because released sections are memory rather than drafts, and 0.3.0 deliberately files
// a second batch under "### Also in this release".
const changelog = sources.get('CHANGELOG.md');
assert.match(changelog, /^## Unreleased$/m, 'CHANGELOG.md must keep an Unreleased section');
const unreleased = changelog.match(/^## Unreleased\r?\n([\s\S]*?)(?=^## )/m)?.[1];
assert.ok(unreleased, 'CHANGELOG.md has no section after ## Unreleased to bound it');
const unreleasedHeadings = unreleased.split(/\r?\n/).filter((line) => /^### /.test(line));
const duplicatedHeadings = unreleasedHeadings
  .filter((heading, index) => unreleasedHeadings.indexOf(heading) !== index);
assert.deepEqual(
  [...new Set(duplicatedHeadings)],
  [],
  `CHANGELOG.md Unreleased repeats a heading (${[...new Set(duplicatedHeadings)].join(', ')}); ` +
  'one release section must contain at most one of each heading',
);

console.log(
  `Documentation terms, encoding, install paths, contacts, and Unreleased headings verified (${documents.length} files).`,
);
