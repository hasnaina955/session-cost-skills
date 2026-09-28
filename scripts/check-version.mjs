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

// Every adapter CLI must expose the installed version. The flag itself is defined in
// the shared argument schema, so assert the CLI routes through that schema rather than
// grepping for a literal that legitimately moves when the parser is refactored.
//
// The search spans the whole scripts directory rather than the entry point alone. MCode moved
// its runtime into lib/runtime.mjs when it was ported onto the kernel, leaving a twelve-line
// entry point, so a check pinned to that one file would have reported a missing version banner
// for a CLI that prints it correctly. What matters is that the runtime reports its own id and
// parses against its own schema, wherever those lines now live.
const schema = read('shared/cli-args.mjs');
for (const runtime of RUNTIMES) {
  const scriptsDir = path.join(root, 'adapters', runtime, 'skill', 'scripts');
  const cli = fs.readdirSync(scriptsDir, { recursive: true })
    .filter((file) => String(file).endsWith('.mjs'))
    .map((file) => read(path.join('adapters', runtime, 'skill', 'scripts', String(file))))
    .join('\n');
  assert.ok(cli.includes(`versionBanner('${runtime}')`), `the ${runtime} CLI must report its own runtime id`);
  assert.ok(cli.includes('parseCliArgs'), `the ${runtime} CLI must parse arguments through the shared schema`);
  assert.ok(cli.includes(`runtimeId: '${runtime}'`), `the ${runtime} CLI must parse against its own runtime schema`);
  // The help text is one block in the adapter, and several shared modules mention --data-dir as a
  // flag definition. Searching the concatenated sources for the first match therefore finds a
  // parser table, not the usage line, so the pairing is asserted against the help text alone:
  // a runtime that stops documenting a flag is a support problem, and a parser entry is not
  // documentation.
  //
  // The help text is located by the usage sentence each runtime opens it with, because the two are
  // not stored the same way: MCode holds it in a HELP_TEXT constant (it has to, since the adapter
  // returns it to the kernel) while Cline still prints a literal from printHelp. Both contain that
  // sentence, so both are found without either being rewritten first.
  const usageStart = cli.search(/session-cost — token usage and/);
  assert.ok(usageStart > -1, `the ${runtime} CLI must print a usage banner`);
  const helpText = cli.slice(usageStart, usageStart + 4000);
  assert.ok(helpText.includes('--data-dir'), `the ${runtime} CLI must document --data-dir`);
  assert.ok(helpText.includes('--version'), `the ${runtime} help text must document --version`);
}
for (const flag of ['version: {', 'help: {']) {
  assert.ok(schema.includes(flag), `the shared argument schema must define ${flag.replace(':', '')}`);
}

const contractVersion = read('shared/report-contract.mjs').match(/REPORT_CONTRACT_VERSION = '([^']+)'/)?.[1];
assert.match(contractVersion ?? '', SEMVER, 'the report contract must declare a semantic contract version');
assert.notEqual(contractVersion, version, 'the report contract version is independent of the release version');

console.log(`Release version contract verified (release ${version}, report contract ${contractVersion}, ${RUNTIMES.length} adapters).`);
