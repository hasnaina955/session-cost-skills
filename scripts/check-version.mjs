// Enforces the release version contract documented in docs/release.md.
//
// One semantic version describes the repository, both adapter skills, and every
// release archive. Nothing else carries an independent version number except the
// normalized report contract, which versions its own schema.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const RUNTIMES = ['cline', 'mcode'];

const packageJson = JSON.parse(read('package.json'));
const version = packageJson.version;
assert.match(version, SEMVER, 'package.json version must be a semantic version');

// npm publication is not part of the release contract; only GitHub archives ship.
assert.equal(packageJson.private, true, 'package.json must stay private so nothing publishes to npm by accident');
assert.equal(packageJson.files, undefined, 'package.json must not define an npm files allowlist; GitHub archives are the distribution channel');
assert.equal(packageJson.engines?.node, '>=22.15', 'package.json must declare the Node floor that CI exercises');

for (const runtime of RUNTIMES) {
  const versionFile = path.join(root, 'adapters', runtime, 'skill', 'VERSION');
  assert.ok(fs.existsSync(versionFile), `adapters/${runtime}/skill/VERSION is missing`);
  const stamped = read(`adapters/${runtime}/skill/VERSION`).trim();
  assert.equal(stamped, version, `adapters/${runtime}/skill/VERSION must match package.json version`);
}

const changelog = read('CHANGELOG.md');
assert.match(changelog, /^## Unreleased$/m, 'CHANGELOG.md must keep an Unreleased section');
assert.ok(
  changelog.includes(`## ${version}`),
  `CHANGELOG.md must have a released section for ${version}; move Unreleased content into it`,
);

// Every adapter CLI must expose the installed version, and the contract version is separate.
for (const runtime of RUNTIMES) {
  const cli = read(`adapters/${runtime}/skill/scripts/session-cost.mjs`);
  assert.ok(cli.includes(`versionBanner('${runtime}')`), `the ${runtime} CLI must report its own runtime id`);
  assert.ok(cli.includes("'--version'"), `the ${runtime} CLI must accept --version`);
  const helpIndex = cli.search(/--data-dir/);
  assert.ok(helpIndex > -1, `the ${runtime} CLI must document --data-dir`);
  assert.ok(cli.slice(helpIndex, helpIndex + 400).includes('--version'), `the ${runtime} help text must document --version`);
}

const contractVersion = read('shared/report-contract.mjs').match(/REPORT_CONTRACT_VERSION = '([^']+)'/)?.[1];
assert.match(contractVersion ?? '', SEMVER, 'the report contract must declare a semantic contract version');
assert.notEqual(contractVersion, version, 'the report contract version is independent of the release version');

console.log(`Release version contract verified (release ${version}, report contract ${contractVersion}, ${RUNTIMES.length} adapters).`);
