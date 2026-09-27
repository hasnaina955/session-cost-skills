#!/usr/bin/env node
// Install or update an installed session-cost skill, correctly and on every platform.
//
// Why this exists rather than a `Copy-Item` line in the README: an install overwrites the whole
// skill directory, and MCode keeps its mirrored provider rates *inside* that directory
// (`references/provider-rates.json`). A plain copy silently discards every rate fetched with
// `--refresh-rates` and resets the refresh history, and nothing warns you - the next report just
// uses the rates bundled with the release. docs/migration.md documented the two-line workaround
// by hand, in PowerShell, which left macOS and Linux with no supported path at all.
//
// Everything here is read-only unless --apply is passed, so it is safe to run in CI or as a
// pre-flight check. It never touches a session ledger, and it never writes outside the skill
// directory it is given.
//
// Usage:
//   node scripts/update-skill.mjs                      # report what would change
//   node scripts/update-skill.mjs --apply              # perform the update
//   node scripts/update-skill.mjs --runtime mcode      # one adapter (default: both)
//   node scripts/update-skill.mjs --from ./dist/session-cost-mcode-v0.5.0/  # install a release
//   node scripts/update-skill.mjs --target-dir <path>  # override the resolved install location
//   node scripts/update-skill.mjs --json               # machine-readable
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name) => {
  const at = args.indexOf(name);
  return at === -1 ? null : args[at + 1] ?? null;
};

const APPLY = flag('--apply');
const JSON_OUT = flag('--json');
const RUNTIME = value('--runtime') ?? 'both';
const FROM = value('--from');
const TARGET_OVERRIDE = value('--target-dir');
const PACKAGE_VERSION = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

/**
 * Where each runtime's skill is installed.
 *
 * These are the documented targets, and they are per-runtime on purpose: the two adapters share
 * a skill name but never a directory and never a ledger, so updating one must not touch the
 * other. `home` is overridable so the tests can point at a temporary directory instead of the
 * real user profile.
 */
export function resolveTargets({ home = os.homedir(), platform = process.platform } = {}) {
  const base = platform === 'win32'
    ? (process.env.USERPROFILE ?? path.join(home, 'AppData', 'Roaming'))
    : home;
  return [
    { runtime: 'cline', directory: path.join(base, '.cline', 'skills', 'session-cost'), hasState: false },
    { runtime: 'mcode', directory: path.join(base, '.minimax', 'skills', 'session-cost'), hasState: true },
  ];
}

function sourceDirectory(runtime) {
  if (!FROM) return path.join(root, 'adapters', runtime, 'skill');
  // A release archive root contains one directory per adapter; accept either the archive root
  // or the adapter directory itself.
  const nested = path.join(FROM, runtime, 'skill');
  if (fs.existsSync(nested)) return nested;
  if (fs.existsSync(path.join(FROM, 'VERSION'))) return FROM;
  const direct = path.join(FROM, `session-cost-${runtime}`);
  if (fs.existsSync(path.join(direct, 'VERSION'))) return direct;
  return nested;
}

function readVersion(directory) {
  const file = path.join(directory, 'VERSION');
  if (!fs.existsSync(file)) return null;
  const stamped = fs.readFileSync(file, 'utf8').trim();
  return stamped === '' ? null : stamped;
}

/** Recursively list files, relative to `directory`, using forward slashes. */
function listFiles(directory, prefix = '') {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const relative = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) return listFiles(path.join(directory, entry.name), relative);
    return [relative];
  });
}

function copyTree(from, to) {
  for (const relative of listFiles(from)) {
    const target = path.join(to, ...relative.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(path.join(from, ...relative.split('/')), target);
  }
}

export function planUpdate(target, source) {
  const incoming = readVersion(source);
  const installed = readVersion(target.directory);
  const incomingFiles = new Set(listFiles(source));
  const installedFiles = new Set(listFiles(target.directory));
  const added = [...incomingFiles].filter((file) => !installedFiles.has(file));
  const changed = [...incomingFiles].filter((file) => {
    if (!installedFiles.has(file)) return false;
    return fs.readFileSync(path.join(source, ...file.split('/'))).compare(
      fs.readFileSync(path.join(target.directory, ...file.split('/'))),
    ) !== 0;
  });
  // Files the new release no longer ships. Left in place they are dead weight at best and a
  // stale generated copy at worst, which is exactly the failure docs/migration.md warns about.
  const removed = [...installedFiles].filter((file) => !incomingFiles.has(file));
  return {
    runtime: target.runtime,
    directory: target.directory,
    source,
    installedVersion: installed,
    incomingVersion: incoming,
    state: installed === null ? 'absent' : (added.length + changed.length + removed.length === 0 ? 'current' : 'outdated'),
    added,
    changed,
    removed,
  };
}

function preserveState(target, backupDir) {
  // MCode's refreshed rates live inside the skill and are the only thing an update can destroy.
  if (!target.hasState) return null;
  const rates = path.join(target.directory, 'references', 'provider-rates.json');
  if (!fs.existsSync(rates)) return null;
  fs.mkdirSync(backupDir, { recursive: true });
  const backup = path.join(backupDir, 'provider-rates.json');
  fs.copyFileSync(rates, backup);
  let refreshedAt = null;
  try { refreshedAt = JSON.parse(fs.readFileSync(backup, 'utf8'))._meta?.refreshedAt ?? null; } catch { /* unreadable is still worth restoring */ }
  return { file: 'references/provider-rates.json', backup, refreshedAt };
}

function restoreState(target, preserved) {
  if (!preserved) return false;
  const destination = path.join(target.directory, ...preserved.file.split('/'));
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.copyFileSync(preserved.backup, destination);
  return true;
}

function verifyInstall(target, expectedVersion) {
  const problems = [];
  const version = readVersion(target.directory);
  if (version !== expectedVersion) problems.push(`VERSION reads ${version ?? 'nothing'}, expected ${expectedVersion}`);
  const entry = path.join(target.directory, 'scripts', 'session-cost.mjs');
  if (!fs.existsSync(entry)) problems.push('scripts/session-cost.mjs is missing');
  if (problems.length === 0) {
    const run = spawnSync(process.execPath, [entry, '--version'], { encoding: 'utf8', timeout: 20_000 });
    if (run.status !== 0) problems.push(`the installed CLI exited ${run.status}: ${(run.stderr ?? '').trim().split('\n')[0]}`);
    else if (!run.stdout.includes(expectedVersion)) problems.push(`--version did not report ${expectedVersion}: ${run.stdout.trim()}`);
  }
  return problems;
}

const targets = resolveTargets().filter((target) => RUNTIME === 'both' || target.runtime === RUNTIME);
if (TARGET_OVERRIDE && targets.length === 1) targets[0].directory = TARGET_OVERRIDE;

const plans = targets.map((target) => planUpdate(target, sourceDirectory(target.runtime)));
const results = [];

for (const plan of plans) {
  const target = targets.find((item) => item.runtime === plan.runtime);
  if (!APPLY) {
    results.push({ ...plan, applied: false });
    continue;
  }
  const backupDir = path.join(os.tmpdir(), `session-cost-update-${process.pid}-${plan.runtime}`);
  const preserved = preserveState(target, backupDir);
  try {
    for (const relative of plan.removed) {
      fs.rmSync(path.join(plan.directory, ...relative.split('/')), { force: true });
    }
    copyTree(plan.source, plan.directory);
    const restored = restoreState(target, preserved);
    const problems = verifyInstall(target, plan.incomingVersion);
    results.push({
      ...plan,
      applied: true,
      preservedState: preserved?.file ?? null,
      stateRefreshedAt: preserved?.refreshedAt ?? null,
      restoredState: restored,
      problems,
    });
  } finally {
    if (preserved) fs.rmSync(backupDir, { recursive: true, force: true });
  }
}

if (JSON_OUT) {
  console.log(JSON.stringify({ packageVersion: PACKAGE_VERSION, applied: APPLY, results }, null, 2));
} else {
  console.log(`session-cost ${PACKAGE_VERSION} (${APPLY ? 'applying' : 'dry run - nothing was written'})`);
  for (const result of results) {
    const label = { absent: 'not installed', current: 'up to date', outdated: 'update available' }[result.state];
    console.log(`\n  ${result.runtime}: ${label}`);
    console.log(`    installed: ${result.installedVersion ?? 'none'}  ->  incoming: ${result.incomingVersion ?? 'unknown'}`);
    console.log(`    target:    ${result.directory}`);
    if (result.added.length) console.log(`    added:     ${result.added.length} file(s)`);
    if (result.changed.length) console.log(`    changed:   ${result.changed.length} file(s)`);
    if (result.removed.length) console.log(`    removed:   ${result.removed.length} file(s)`);
    if (result.preservedState) console.log(`    preserved: ${result.preservedState}${result.stateRefreshedAt ? ` (refreshed ${result.stateRefreshedAt})` : ''}`);
    if (result.restoredState) console.log('    restored:  your refreshed rates were put back');
    for (const problem of result.problems ?? []) console.log(`    PROBLEM:   ${problem}`);
  }
  if (!APPLY && results.some((result) => result.state !== 'current')) {
    console.log('\n  Re-run with --apply to install. Nothing above was written.');
  }
}

// A non-zero exit makes this usable as a CI gate: an installed skill that is out of date, or an
// install that failed verification, must fail a pipeline rather than print a warning.
const failed = results.some((result) => (result.problems?.length ?? 0) > 0);
if (failed) process.exitCode = 1;
// `--check` means "is the installed skill exactly this release", so anything else fails: an
// outdated install, and an absent one. A machine meant to be pinned to a version must fail a
// pipeline rather than print a warning, and a missing skill is not a pinned skill.
if (flag('--check') && !APPLY && results.some((result) => result.state !== 'current')) process.exitCode = 1;
