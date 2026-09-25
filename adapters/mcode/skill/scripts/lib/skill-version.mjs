import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPORT_CONTRACT_VERSION } from './report-contract.mjs';

// The installed skill must identify itself without the repository, so the release
// version lives in a `VERSION` file at the skill root and both CLIs expose `--version`.
const SKILL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const UNKNOWN_VERSION = '0.0.0-unknown';
export const MINIMUM_NODE = '22.15.0';

export function readSkillVersion(skillRoot = SKILL_ROOT) {
  try {
    const raw = readFileSync(path.join(skillRoot, 'VERSION'), 'utf8').trim();
    return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(raw) ? raw : UNKNOWN_VERSION;
  } catch {
    return UNKNOWN_VERSION;
  }
}

export function versionBanner(runtimeId, skillRoot = SKILL_ROOT) {
  return {
    skill: 'session-cost',
    runtime: runtimeId,
    version: readSkillVersion(skillRoot),
    contractVersion: REPORT_CONTRACT_VERSION,
    minimumNode: MINIMUM_NODE,
    runningNode: process.versions.node,
  };
}

export function formatVersionBanner(banner) {
  return [
    `${banner.skill} ${banner.version} (${banner.runtime} adapter)`,
    `report contract: ${banner.contractVersion}`,
    `node: ${banner.runningNode} (requires >= ${banner.minimumNode})`,
  ].join('\n');
}
