import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { removeDirectory } from './helpers/temp-dir.mjs';

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const script = path.join(repositoryRoot, 'scripts', 'update-skill.mjs');
const packageVersion = JSON.parse(fs.readFileSync(path.join(repositoryRoot, 'package.json'), 'utf8')).version;

function runUpdate(args) {
  return spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', timeout: 60_000 });
}

function stage(target, { version = packageVersion, files = {}, rates = null } = {}) {
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, 'VERSION'), `${version}\n`);
  for (const [relative, contents] of Object.entries(files)) {
    const full = path.join(target, ...relative.split('/'));
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents);
  }
  if (rates) {
    fs.mkdirSync(path.join(target, 'references'), { recursive: true });
    fs.writeFileSync(path.join(target, 'references', 'provider-rates.json'), rates);
  }
}

test('a dry run reports the plan and writes nothing', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-dry-'));
  try {
    const before = fs.readdirSync(dir);
    const result = runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.applied, false);
    assert.equal(report.results[0].state, 'absent');
    assert.ok(report.results[0].added.length > 0, 'an absent install has files to add');
    assert.deepEqual(fs.readdirSync(dir), before, 'a dry run must not write anything');
  } finally { removeDirectory(dir); }
});

test('--apply installs a working skill that reports the release version', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-apply-'));
  try {
    const result = runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].state, 'absent');
    assert.deepEqual(report.results[0].problems, [], 'verification must pass');
    assert.equal(fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim(), packageVersion);

    const cli = spawnSync(process.execPath, [path.join(dir, 'scripts', 'session-cost.mjs'), '--version'], { encoding: 'utf8' });
    assert.equal(cli.status, 0, cli.stderr);
    assert.match(cli.stdout, new RegExp(`session-cost ${packageVersion.replace(/\./g, '\\.')} \\(mcode adapter\\)`));
  } finally { removeDirectory(dir); }
});

test('an update preserves refreshed MCode rates, which a plain copy would destroy', () => {
  // The whole reason this script exists. MCode stores refreshed rates inside the skill
  // directory, so overwriting the directory silently discards every `--refresh-rates` result
  // and resets the refresh history. Nothing in a plain copy warns you.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-rates-'));
  try {
    const marker = JSON.stringify({ _meta: { refreshedAt: '2026-09-25T09:01:23.164Z' }, providers: { stepfun: { models: { 'marker-proof': { name: 'marker-proof' } } } } });
    runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    stage(dir, { rates: marker });

    const result = runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    const report = JSON.parse(result.stdout);
    assert.equal(report.results[0].preservedState, 'references/provider-rates.json');
    assert.equal(report.results[0].restoredState, true);
    const after = JSON.parse(fs.readFileSync(path.join(dir, 'references', 'provider-rates.json'), 'utf8'));
    assert.ok(after.providers.stepfun.models['marker-proof'], 'the refreshed table must survive the update');
    assert.equal(after._meta.refreshedAt, '2026-09-25T09:01:23.164Z');
  } finally { removeDirectory(dir); }
});

test('an update removes files the new release no longer ships', () => {
  // A stale generated copy left behind from an older release will not match the current
  // session-cost.mjs, which docs/migration.md warns about. Removing it is the point.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-stale-'));
  try {
    runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    const orphan = path.join(dir, 'scripts', 'lib', 'module-from-an-old-release.mjs');
    fs.writeFileSync(orphan, 'export const stale = true;\n');

    const report = JSON.parse(runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']).stdout);
    assert.ok(report.results[0].removed.includes('scripts/lib/module-from-an-old-release.mjs'));
    assert.equal(fs.existsSync(orphan), false, 'a file the release no longer ships must not survive');
  } finally { removeDirectory(dir); }
});

test('a second update is a no-op, so the workflow is safe to re-run', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-idempotent-'));
  try {
    runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    const second = JSON.parse(runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']).stdout);
    assert.equal(second.results[0].state, 'current');
    assert.equal(second.results[0].added.length, 0);
    assert.equal(second.results[0].changed.length, 0);
    assert.equal(second.results[0].removed.length, 0);
  } finally { removeDirectory(dir); }
});

test('a corrupted install is reported as a problem rather than silently accepted', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-broken-'));
  try {
    runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--apply', '--json']);
    fs.rmSync(path.join(dir, 'scripts', 'session-cost.mjs'));
    fs.writeFileSync(path.join(dir, 'scripts', 'session-cost.mjs'), 'this is not a program\n');
    // Re-applying repairs it; the check is that a broken tree is detected rather than reported
    // as `current`, which would make a CI gate pass on a dead install.
    const report = JSON.parse(runUpdate(['--runtime', 'mcode', '--target-dir', dir, '--check', '--json']).stdout);
    assert.notEqual(report.results[0].state, 'current');
  } finally { removeDirectory(dir); }
});

test('the Cline adapter has no preservable state and still installs', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'update-cline-'));
  try {
    const report = JSON.parse(runUpdate(['--runtime', 'cline', '--target-dir', dir, '--apply', '--json']).stdout);
    assert.deepEqual(report.results[0].problems, []);
    assert.equal(report.results[0].preservedState, null, 'Cline cost comes from the runtime ledger, so there is nothing to preserve');
    const cli = spawnSync(process.execPath, [path.join(dir, 'scripts', 'session-cost.mjs'), '--version'], { encoding: 'utf8' });
    assert.match(cli.stdout, /cline adapter/);
  } finally { removeDirectory(dir); }
});
