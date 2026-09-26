import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  FORBIDDEN_PACKAGE_PATTERNS,
  buildDeterministicZip,
  collectFiles,
  forbiddenPackageReason,
  readDeterministicZip,
  sha256,
} from '../scripts/lib/release-pkg.mjs';
import { readSkillVersion, versionBanner, formatVersionBanner } from '../adapters/cline/skill/scripts/lib/skill-version.mjs';
import { clineScript, mcodeScript, opencodeScript, runCli } from './helpers/contract-fixtures.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (file) => fs.readFileSync(path.join(repositoryRoot, file), 'utf8');
const packageJson = JSON.parse(read('package.json'));
const RUNTIMES = ['cline', 'mcode', 'opencode'];
const SCRIPTS = { cline: clineScript, mcode: mcodeScript, opencode: opencodeScript };

test('the release version, every adapter VERSION file, and the changelog agree', () => {
  assert.match(packageJson.version, /^\d+\.\d+\.\d+/);
  for (const runtime of RUNTIMES) {
    assert.equal(read(`adapters/${runtime}/skill/VERSION`).trim(), packageJson.version);
  }
  assert.ok(read('CHANGELOG.md').includes(`## ${packageJson.version}`));
});

test('the package cannot be published to npm by accident', () => {
  assert.equal(packageJson.private, true);
  assert.equal(packageJson.files, undefined, 'no npm files allowlist: GitHub archives are the distribution channel');
});

test('every adapter exposes the same skill-version implementation', () => {
  const canonical = read('shared/skill-version.mjs');
  for (const runtime of RUNTIMES) {
    assert.equal(read(`adapters/${runtime}/skill/scripts/lib/skill-version.mjs`), canonical);
  }
});

test('an installed skill reports its own version, runtime, and contract version', () => {
  for (const runtime of RUNTIMES) {
    const result = runCli(SCRIPTS[runtime], os.tmpdir(), ['--version']);
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, new RegExp(`^session-cost ${packageJson.version.replace(/\./g, '\\.')} \\(${runtime} adapter\\)`));
    assert.match(result.stdout, /report contract: 1\.2\.0/);
    assert.match(result.stdout, /requires >= 22\.15\.0/);
  }
});

test('version reporting never opens runtime storage or prints local paths', () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-version-'));
  for (const script of RUNTIMES.map((runtime) => SCRIPTS[runtime])) {
    const result = runCli(script, empty, ['--version']);
    assert.equal(result.status, 0);
    assert.equal(result.stdout.includes(empty), false, 'version output leaked a local data directory');
    assert.doesNotMatch(result.stdout, /api[_-]?key|token|secret/i);
  }
});

test('archives are byte-identical across builds and independent of entry order', () => {
  const entries = [
    { path: 'b.txt', data: Buffer.from('second') },
    { path: 'a.txt', data: Buffer.from('first') },
  ];
  const reordered = [...entries].reverse();
  assert.equal(sha256(buildDeterministicZip(entries)), sha256(buildDeterministicZip(reordered)));
  assert.equal(buildDeterministicZip(entries).length, buildDeterministicZip(entries, { modified: new Date() }).length);
});

test('a real skill archive is byte-identical on a second build', () => {
  const skillRoot = path.join(repositoryRoot, 'adapters', 'cline', 'skill');
  const build = () => buildDeterministicZip(collectFiles(skillRoot).map((relative) => ({
    path: relative,
    data: fs.readFileSync(path.join(skillRoot, relative)),
  })));
  assert.equal(sha256(build()), sha256(build()));
});

test('archives reject credentials, databases, transcripts, reports, and unsafe paths', () => {
  const rejected = [
    'skill/secrets.json',
    'skill/data/settings/providers.json',
    'skill/.env',
    'skill/data/db/sessions.db',
    'skill/v2/sqlite/runtime-state.sqlite',
    'skill/data/logs/messages.jsonl',
    'skill/reports/account.json',
    'skill/reports/session-dashboard.html',
    'skill/.session-cost/state.json',
  ];
  for (const entry of rejected) {
    assert.ok(forbiddenPackageReason(entry), `${entry} must be rejected by a packaging rule`);
    assert.throws(() => buildDeterministicZip([{ path: entry, data: Buffer.from('x') }]), /refusing to package/);
  }
  assert.equal(FORBIDDEN_PACKAGE_PATTERNS.length > 0, true);
  assert.equal(forbiddenPackageReason('skill/SKILL.md'), null);
  assert.equal(forbiddenPackageReason('skill/references/provider-rates.json'), null);
  for (const unsafe of ['/absolute/path', '../escape', 'a/../../escape']) {
    assert.throws(() => buildDeterministicZip([{ path: unsafe, data: Buffer.from('x') }]), /unsafe archive entry path/);
  }
  assert.throws(() => buildDeterministicZip([
    { path: 'same.txt', data: Buffer.from('a') },
    { path: 'same.txt', data: Buffer.from('b') },
  ]), /duplicate archive entry/);
});

test('archives round-trip through the reader with their bytes intact', () => {
  const entries = [
    { path: 'skill/SKILL.md', data: Buffer.from('# Session Cost\n') },
    { path: 'skill/VERSION', data: Buffer.from('0.3.0\n') },
    { path: 'skill/scripts/lib/nested.mjs', data: Buffer.from('export const x = 1;\n') },
  ];
  const read = readDeterministicZip(buildDeterministicZip(entries));
  assert.deepEqual(read.map((entry) => entry.path), entries.map((entry) => entry.path).sort());
  for (const entry of entries) {
    assert.equal(read.find((item) => item.path === entry.path).data.toString('utf8'), entry.data.toString('utf8'));
  }
  const corrupt = buildDeterministicZip(entries);
  corrupt[corrupt.indexOf(0x23)] ^= 0xff; // flip a byte inside the first entry's data
  assert.throws(() => readDeterministicZip(corrupt), /CRC check|corrupt ZIP/);
  assert.throws(() => readDeterministicZip(Buffer.from('not a zip at all')), /not a ZIP archive/);
});

test('release archives match the published checksums and never carry local data', () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-checks-'));
  const result = spawnSync(process.execPath, [path.join(repositoryRoot, 'scripts', 'build-release.mjs'), '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const sums = fs.readFileSync(path.join(out, 'SHA256SUMS.txt'), 'utf8').trim().split('\n');
  // One archive per adapter plus the bundle.
  assert.equal(sums.length, RUNTIMES.length + 1, `${RUNTIMES.join(', ')}, and bundle archives are expected`);
  for (const runtime of RUNTIMES) {
    assert.ok(sums.some((line) => line.endsWith(`session-cost-${runtime}-v${packageJson.version}.zip`)),
      `no archive was published for the ${runtime} adapter`);
  }
  for (const line of sums) {
    const [digest, name] = line.split(/\s+/);
    assert.match(digest, /^[a-f0-9]{64}$/);
    const data = fs.readFileSync(path.join(out, name));
    assert.equal(sha256(data), `sha256:${digest}`, `${name} does not match its published checksum`);
    assert.ok(name.includes(packageJson.version), `${name} does not carry the release version`);
  }
  fs.rmSync(out, { recursive: true, force: true });
});
