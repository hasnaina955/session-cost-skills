// Release rehearsal: build the archives, extract them the way a customer would,
// and prove the extracted copy is self-sufficient.
//
// It fails if the packaged skill cannot report its version, cannot render help,
// cannot answer a report against a synthetic ledger, or if the archive carried a
// credential, database, transcript, or report.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { forbiddenPackageReason, readDeterministicZip, repositoryRoot } from './lib/release-pkg.mjs';
import { createClineFixture, createMCodeFixture, runCli } from '../tests/helpers/contract-fixtures.mjs';

const packageJson = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8'));
const version = packageJson.version;
const outputDir = path.join(repositoryRoot, 'dist');

function readArchive(archive) {
  return readDeterministicZip(fs.readFileSync(archive));
}

function install(entries, runtime, destination) {
  const prefix = `${runtime}/`;
  let installed = 0;
  for (const entry of entries) {
    if (!entry.path.startsWith(prefix)) continue;
    const target = path.join(destination, entry.path.slice(prefix.length));
    assert.ok(
      path.resolve(target).startsWith(path.resolve(destination)),
      `archive entry escaped the install directory: ${entry.path}`,
    );
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, entry.data);
    installed += 1;
  }
  return installed;
}

execFileSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-release.mjs'), '--out', outputDir], {
  stdio: 'pipe',
});

const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-release-'));
const checks = [];

for (const runtime of ['cline', 'mcode']) {
  const archive = path.join(outputDir, `session-cost-${runtime}-v${version}.zip`);
  assert.ok(fs.existsSync(archive), `missing release archive ${path.basename(archive)}`);

  const entries = readArchive(archive);
  for (const entry of entries) {
    const reason = forbiddenPackageReason(entry.path);
    assert.equal(reason, null, `archive ${path.basename(archive)} contains ${entry.path}: matched ${reason}`);
  }

  // Install exactly the way SUPPORT.md documents: copy the skill folder contents.
  const installRoot = path.join(workspace, `${runtime}-install`, 'skills', 'session-cost');
  fs.mkdirSync(installRoot, { recursive: true });
  const installed = install(entries, runtime, installRoot);
  assert.ok(installed > 0, `${runtime}: the archive contained no ${runtime} entries`);

  assert.ok(fs.existsSync(path.join(installRoot, 'SKILL.md')), `${runtime}: SKILL.md is missing from the installed skill`);
  assert.ok(fs.existsSync(path.join(installRoot, 'VERSION')), `${runtime}: VERSION is missing from the installed skill`);
  assert.equal(
    fs.readFileSync(path.join(installRoot, 'VERSION'), 'utf8').trim(),
    version,
    `${runtime}: the installed skill reports a different version than the release`,
  );
  assert.equal(
    fs.existsSync(path.join(installRoot, 'tests')),
    false,
    `${runtime}: repository regression tests must not ship inside an installed skill`,
  );
  checks.push(`${runtime}: installed ${installed} files from the archive`);

  const script = path.join(installRoot, 'scripts', 'session-cost.mjs');
  const versionResult = runCli(script, path.join(workspace, 'unused'), ['--version']);
  assert.equal(versionResult.status, 0, `${runtime}: --version failed: ${versionResult.stderr}`);
  assert.match(versionResult.stdout, new RegExp(`session-cost ${version.replace(/\./g, '\\.')} \\(${runtime} adapter\\)`));
  checks.push(`${runtime}: --version reports ${version}`);

  const helpResult = runCli(script, path.join(workspace, 'unused'), ['--help']);
  assert.equal(helpResult.status, 0, `${runtime}: --help failed: ${helpResult.stderr}`);
  assert.match(helpResult.stdout, /--session/, `${runtime}: help text lost its documented flags`);
  checks.push(`${runtime}: --help renders`);

  const fixture = runtime === 'cline' ? createClineFixture() : createMCodeFixture();
  const report = runCli(script, fixture.dataDir, ['--session', fixture.sessionIds[0], '--json'], fixture.environment);
  assert.equal(report.status, 0, `${runtime}: an installed copy could not produce a report: ${report.stderr}`);
  const parsed = JSON.parse(report.stdout);
  assert.equal(parsed.runtime.id, runtime, `${runtime}: the installed copy reported the wrong runtime`);
  assert.equal(parsed.contractVersion, '1.2.0', `${runtime}: the installed copy reported an unexpected contract version`);
  assert.ok(parsed.usage.totalTokens > 0, `${runtime}: the installed copy reported no usage`);
  checks.push(`${runtime}: installed copy reports a ${runtime} session with ${parsed.usage.totalTokens} tokens`);

  const dashboard = path.join(workspace, `${runtime}-dashboard.html`);
  const dashboardResult = runCli(script, fixture.dataDir, ['--session', fixture.sessionIds[0], '--dashboard', '--out', dashboard], fixture.environment);
  assert.equal(dashboardResult.status, 0, `${runtime}: dashboard generation failed: ${dashboardResult.stderr}`);
  assert.ok(fs.existsSync(dashboard), `${runtime}: no dashboard was written`);
  checks.push(`${runtime}: installed copy writes a dashboard`);
}

const bundle = path.join(outputDir, `session-cost-bundle-v${version}.zip`);
const bundleNames = readArchive(bundle).map((entry) => entry.path);
for (const required of ['LICENSE', 'README.md', 'CHANGELOG.md', 'cline/VERSION', 'mcode/VERSION']) {
  assert.ok(bundleNames.includes(required), `bundle archive is missing ${required}`);
}
assert.ok(bundleNames.includes('cline/SKILL.md') && bundleNames.includes('mcode/SKILL.md'), 'bundle archive is missing a skill');
for (const entry of readArchive(bundle)) {
  assert.equal(forbiddenPackageReason(entry.path), null, `bundle archive contains ${entry.path}`);
}
checks.push(`bundle: ${bundleNames.length} entries including both skills, the MIT notice, and both VERSION files`);

fs.rmSync(workspace, { recursive: true, force: true });
for (const check of checks) console.log(`  ✔ ${check}`);
console.log(`Release rehearsal passed for v${version}: archives install and run from a clean extraction.`);
