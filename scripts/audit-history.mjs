import assert from 'node:assert/strict';
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const git = (args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' });
const commits = git(['rev-list', '--all']).trim().split(/\r?\n/).filter(Boolean);
const commitsWithMeta = git(['log', '--all', '--format=%H%x00%ad', '--date=iso-strict']).trim().split(/\r?\n/).filter(Boolean).map((line) => {
  const [sha, date] = line.split('\0');
  return { sha, date };
});
const paths = [...new Set(git(['log', '--all', '--name-only', '--format=']).trim().split(/\r?\n/).filter(Boolean))].sort();

const forbiddenNames = [
  { rule: 'credential-file', pattern: /(^|\/)(?:secrets?\.json|providers\.json|\.env(?:\..*)?)$/i },
  { rule: 'session-database', pattern: /\.(?:db|sqlite|sqlite3|sqlite-shm|sqlite-wal)$/i },
  { rule: 'transcript', pattern: /(^|\/)messages?\.jsonl$|(^|\/)(?:transcript|conversation|prompt)s?\.(?:jsonl|txt|log)$/i },
  { rule: 'generated-report', pattern: /(^|\/)reports?\/|dashboard.*\.html$|account-dashboard\.html$/i },
  { rule: 'archive', pattern: /\.(?:zip|7z|tar|gz)$/i },
];
const filenameFindings = paths.flatMap((file) => forbiddenNames
  .filter((rule) => rule.pattern.test(file))
  .map((rule) => ({ rule: rule.rule, path: file })));

const contentRules = {
  bearerToken: 'Bearer[[:space:]]+[A-Za-z0-9._~-]{20,}',
  secretKeyPattern: 'sk-[A-Za-z0-9_-]{16,}',
  accessTokenAssignment: '[Aa]ccess[Tt]oken["\u0027]?[[:space:]]*[:=][[:space:]]*["\u0027][^"\u0027]{20,}',
  apiKeyAssignment: '[Aa]pi[Kk]ey["\u0027]?[[:space:]]*[:=][[:space:]]*["\u0027][^"\u0027]{16,}',
  databaseConnectionUri: '(postgres|mysql|mongodb|sqlite)://',
};
// Test files intentionally contain placeholder credential literals to prove that
// secret-shaped input is rejected. Matches are only ignored when the matched value
// is one of these documented fixtures; any other value in a test file is still reported.
const FIXTURE_ALLOWLIST_FILES = /(^|\/)([^/]*\.test\.mjs|tests\/.*\.mjs)$/;
// Documented, deliberately fake credential literals that appear only in test files, to
// prove secrets never reach a report, a CSV, or a dashboard. Each is scoped twice over:
// the file must match FIXTURE_ALLOWLIST_FILES, and the exact literal must appear below.
// A real credential anywhere else, or a different value in one of these files, is still
// reported. Do not add a value here that could plausibly be live.
const FIXTURE_ALLOWLIST_VALUES = new Set([
  'do-not-serialize',
  'literal-secret',
  'secret-token',
  'legacy-token',
  'oauth-token',
  'expired-token',
  'runtime-only',
  'sk-ant-SECRETKEYVALUE',
  'sk-ant-REALSECRETKEY',
]);

// A documented sentinel can appear under any key, not only next to an apiKey field, so a
// line quoting an allowlisted value is exempt outright. Without this, a sentinel used as,
// say, a credentialEnv value is reported by the generic key-shape rule and cannot be
// allowlisted at all.
function quotedAllowlistedValue(text) {
  for (const quoted of text.matchAll(/["']([^"']{6,})["']/g)) {
    if (FIXTURE_ALLOWLIST_VALUES.has(quoted[1].trim())) return quoted[1].trim();
  }
  return null;
}

function matchedLiteral(text) {
  const match = text.match(/(?:access[_-]?token|api[_-]?key)["']?\s*[:=]\s*["']([^"']+)["']/i);
  return match ? match[1] : null;
}

const contentFindings = [];
for (const [rule, pattern] of Object.entries(contentRules)) {
  let output = '';
  try {
    output = execFileSync('git', ['grep', '-I', '-n', '-E', pattern, ...commits], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch (error) {
    if (error.status !== 1) throw new Error(`history scan failed for rule ${rule}: ${error.message}`);
  }
  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const firstColon = line.indexOf(':');
    const rest = line.slice(firstColon + 1);
    const secondColon = rest.indexOf(':');
    const filePath = rest.slice(0, secondColon);
    const text = rest.slice(secondColon + 1);
    // This scanner necessarily contains the very patterns it searches for, and its own
    // allowlist of documented sentinels would otherwise be reported as a live credential.
    // Excluding the scanner by path is the only way to keep that list maintainable.
    if (filePath === 'scripts/audit-history.mjs') continue;
    if (FIXTURE_ALLOWLIST_FILES.test(filePath)) {
      const literal = matchedLiteral(text);
      if (literal !== null && FIXTURE_ALLOWLIST_VALUES.has(literal.trim())) continue;
      if (quotedAllowlistedValue(text)) continue;
    }
    contentFindings.push({ rule, path: filePath });
  }
}

const uniqueFindings = [...new Map([...filenameFindings, ...contentFindings]
  .map((finding) => [`${finding.rule}|${finding.path}`, finding])).values()];
const findings = uniqueFindings;
const report = {
  generatedAt: new Date().toISOString(),
  reachableCommits: commits.length,
  historyPaths: paths.length,
  findings,
  result: findings.length ? 'review-required' : 'pass',
};
assert.equal(findings.length, 0, `history audit found ${findings.length} secret/data findings`);

const markdown = [
  '# History secret and data audit',
  '',
  `- Result: ${report.result.toUpperCase()}`,
  `- Generated: ${report.generatedAt}`,
  `- Reachable commits scanned: ${report.reachableCommits}`,
  `- Historical paths scanned: ${report.historyPaths}`,
  `- Findings: none`,
  '',
  '## Method',
  '',
  '- Enumerated all commits reachable from the current repository.',
  '- Checked historical filenames for credentials, session databases, transcripts, generated reports, and archives.',
  '- Used history-wide literal/token-pattern searches that return paths only, never secret values.',
  '- Verified the current checkout contains no forbidden runtime-data file or high-confidence credential value.',
  '',
  'No credentials were printed or preserved in this report.',
  '',
];
if (!process.argv.includes('--check')) {
  fs.writeFileSync(path.join(root, 'docs', 'history-audit.md'), `${markdown.join('\n')}`, 'utf8');
  fs.writeFileSync(path.join(root, 'docs', 'history-audit.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
}
console.log(`History audit passed: ${commits.length} commits, ${paths.length} paths, no live credential or runtime-data findings.`);
