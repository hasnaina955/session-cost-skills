import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateJsonSchema } from '../../../../scripts/validate-json-schema.mjs';
import { REPORT_CONTRACT_VERSION, assertNormalizedReport } from '../scripts/lib/report-contract.mjs';
import { createOpenCodeFixture, runCli, runJson } from '../../../../tests/helpers/contract-fixtures.mjs';

// The end-to-end contract for the OpenCode CLI, against a synthetic ledger.
//
// The load-bearing assertion in this file is negative: a model with no applicable rate must
// report token counts and an unavailable cost, and the string `$0.0000` must never appear for
// it. A plausible wrong number is the worst outcome this tool can produce, so the tests check
// for its absence rather than only for the presence of a right one.

const schema = JSON.parse(fs.readFileSync(new URL('../../../../contracts/normalized-report-v1.schema.json', import.meta.url), 'utf8'));

function assertContract(report, { runtime = 'opencode' } = {}) {
  assert.deepEqual(validateJsonSchema(report, schema), [], 'report must satisfy normalized-report-v1');
  assert.equal(assertNormalizedReport(report), report, 'report must satisfy the normalized contract');
  assert.equal(report.contractVersion, REPORT_CONTRACT_VERSION);
  assert.equal(report.runtime.id, runtime);
  assert.equal(report.runtime.costBasis, 'provider-rate-estimate');
  assert.equal(report.billing.recordedCostUsd, null, 'a rate estimate carries no recorded cost');
  assert.equal(report.usage.semantics.inputTokenMeaning, 'excludes-cache');
}

function withFixture(t) {
  const fixture = createOpenCodeFixture();
  t.after(() => {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    fs.rmSync(fixture.emptyDataDir, { recursive: true, force: true });
  });
  return { ...fixture, config: ['--session-config', fixture.configPath] };
}

test('the report satisfies the normalized contract in every mode', (t) => {
  const fixture = withFixture(t);
  const env = fixture.environment;

  const root = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_root', ...fixture.config], env);
  assert.equal(root.result.status, 0, root.result.stderr);
  assertContract(root.output);
  assert.equal(root.output.selection.method, 'explicit');
  assert.deepEqual(root.output.sessionGraph.rootSessionIds, ['ses_root']);
  assert.deepEqual(root.output.sessionGraph.includedSessionIds, ['ses_root']);
  assert.deepEqual(root.output.sessionGraph.excludedSessionIds, ['ses_child', 'ses_grandchild']);
  assert.ok(root.output.warnings.some((warning) => warning.includes('descendant session')));

  // The reader's precedence rule, observed from the CLI: where 1.x and 2.x disagree, 1.x wins,
  // so this session has three calls and the 1.x token totals, not the single 2.x call.
  assert.equal(root.output.usageSources['v1-per-call'], 3);
  assert.equal(root.output.usageSources['v2-per-call'], undefined);
  assert.equal(root.output.calls, 3);
  assert.equal(root.output.usage.totalTokens, 930);
  assert.equal(root.output.usage.freshInputTokens, 300);
  assert.equal(root.output.usage.cacheReadTokens, 600);
  assert.equal(root.output.usage.cacheWriteTokens, 0);
  assert.equal(root.output.billing.rateKnown, true);
  assert.equal(root.output.billing.coverage, 'complete');
  assert.equal(root.output.coverage.status, 'complete');
  assert.ok(root.output.providerDrivers.every((driver) => /^sha256:[a-f0-9]{64}$/.test(driver.fingerprint)));
  assert.equal(root.output.configuration.config.schemaVersion, 1);
  assert.ok(root.output.provenance.rateSources.includes('config-profile:fixture-provider'));

  const children = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_root', '--include-children', ...fixture.config], env);
  assert.equal(children.result.status, 0, children.result.stderr);
  assertContract(children.output);
  assert.deepEqual(children.output.sessionGraph.includedSessionIds, ['ses_root', 'ses_child', 'ses_grandchild']);
  assert.equal(children.output.sessionGraph.excludedSessionIds.length, 0);

  // Contract rule 4: a descendant is billed at most once, and the total is exactly the sum of
  // the per-session costs rather than a multiple of any of them.
  const perSession = Object.entries(children.output.perSession);
  assert.equal(perSession.length, 3, 'each billed session appears exactly once');
  const summed = perSession.reduce((total, [, entry]) => total + entry.totalCost, 0);
  assert.ok(Math.abs(summed - children.output.billing.amountUsd) < 1e-12, 'the total is the sum of its sessions, not a double count');
  for (const [sessionId] of perSession) {
    assert.equal(children.output.sessionGraph.includedSessionIds.filter((id) => id === sessionId).length, 1);
  }

  const noFlag = runJson(fixture.script, fixture.dataDir, [...fixture.config], env);
  assert.equal(noFlag.result.status, 0, noFlag.result.stderr);
  assertContract(noFlag.output);
  // Whatever the no-flag selection lands on, it is an explicit, reported choice, never a
  // silent one: the method is named and the candidates are listed.
  assert.ok(['unique-active-root', 'latest-root-fallback'].includes(noFlag.output.selection.method));
  assert.ok(noFlag.output.sessionId);
  assert.ok(Array.isArray(noFlag.output.selection.candidateIds));

  const fromEnvironment = runJson(fixture.script, fixture.dataDir, fixture.config, { ...env, OPENCODE_SESSION_ID: 'ses_root' });
  assert.equal(fromEnvironment.result.status, 0, fromEnvironment.result.stderr);
  assertContract(fromEnvironment.output);
  assert.equal(fromEnvironment.output.selection.method, 'environment');
  assert.equal(fromEnvironment.output.sessionId, 'ses_root');

  const last = runJson(fixture.script, fixture.dataDir, ['--last', ...fixture.config], env);
  assertContract(last.output);
  assert.equal(last.output.selection.method, 'last');

  const today = runJson(fixture.script, fixture.dataDir, ['--today', ...fixture.config], env);
  assert.equal(today.result.status, 0, today.result.stderr);
  assertContract(today.output);
  assert.deepEqual([...today.output.rootSessionIds].sort(), ['ses_today']);

  const list = runJson(fixture.script, fixture.dataDir, ['--list', '10', ...fixture.config], env);
  assert.equal(list.result.status, 0, list.result.stderr);
  assert.equal(list.output.kind, 'report-list');
  assert.equal(list.output.runtime, 'opencode');
  const listRoots = ['ses_root', 'ses_today', 'ses_free', 'ses_unpriced', 'ses_aggregate', 'ses_empty'];
  assert.equal(list.output.sessions.length, listRoots.length);
  list.output.sessions.forEach((report) => assertContract(report));
  assert.deepEqual(
    list.output.sessions.map((report) => report.sessionId).sort(),
    [...listRoots].sort(),
  );
  // A sub-agent never appears in a list, and it is named as suppressed rather than dropped.
  assert.deepEqual(list.output.duplicateSuppressedSessionIds.sort(), ['ses_child', 'ses_grandchild']);

  const compare = runJson(fixture.script, fixture.dataDir, ['--compare', ...fixture.config], env);
  assert.equal(compare.result.status, 0, compare.result.stderr);
  assert.equal(compare.output.kind, 'report-comparison');
  assertContract(compare.output.comparison.older);
  assertContract(compare.output.comparison.newer);
  assert.ok(compare.output.duplicateSuppressedSessionIds.includes('ses_child'));

  const range = runJson(fixture.script, fixture.dataDir, [
    '--from', fixture.rootDate,
    '--to', fixture.today,
    '--include-children',
    ...fixture.config,
  ], env);
  assert.equal(range.result.status, 0, range.result.stderr);
  assertContract(range.output);

  // This filter spans every session at the provider, including the unmirrored one, so the
  // aggregate it produces is not fully priced and the exit code says so.
  const filteredByProvider = runJson(fixture.script, fixture.dataDir, ['--provider', 'fixture-provider', ...fixture.config], env);
  assert.equal(filteredByProvider.result.status, 2, 'a partially priced aggregate must exit non-zero');
  assertContract(filteredByProvider.output);
  assert.ok(filteredByProvider.output.rootSessionIds.length > 1, 'the filter must aggregate several sessions');
  assert.equal(filteredByProvider.output.billing.rateKnown, false);
  assert.equal(filteredByProvider.output.billing.amountUsd, null);

  const filteredByModel = runJson(fixture.script, fixture.dataDir, ['--model', 'unknown-model', ...fixture.config], env);
  assert.equal(filteredByModel.result.status, 2, 'an unpriceable filtered report still exits non-zero');
  assertContract(filteredByModel.output);
  assert.equal(filteredByModel.output.sessionId, 'ses_unpriced');

  const noCalls = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_empty', ...fixture.config], env);
  assert.equal(noCalls.result.status, 0, noCalls.result.stderr);
  assertContract(noCalls.output);
  assert.equal(noCalls.output.coverage.status, 'no-calls');
  assert.equal(noCalls.output.usage.totalTokens, 0);

  // The shared parser rejects the date before any storage is opened.
  const invalidDate = runJson(fixture.script, fixture.dataDir, ['--from', '2026-13-99', ...fixture.config], env);
  assert.equal(invalidDate.result.status, 2);
  assert.equal(invalidDate.output, null);
  assert.match(invalidDate.result.stderr, /calendar date/);
  assert.doesNotMatch(invalidDate.result.stderr, /sqlite|opencode\.db/i, 'a bad date must not reach storage');
});

test('an unmirrored model reports an unavailable cost with its token counts intact', (t) => {
  const fixture = withFixture(t);
  const result = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_unpriced', ...fixture.config], fixture.environment);
  assert.equal(result.result.status, 2, 'an unknown cost is a non-zero exit');
  assertContract(result.output);

  assert.equal(result.output.billing.amountUsd, null, 'rule 1: an unknown cost is null, never 0');
  assert.equal(result.output.billing.estimatedCostUsd, null);
  assert.equal(result.output.billing.rateKnown, false);
  assert.equal(result.output.billing.classification, 'cost-unavailable');
  assert.equal(result.output.billing.coverage, 'unavailable');
  assert.equal(result.output.coverage.status, 'unavailable');
  assert.ok(result.output.coverage.unknownReasons.length > 0);

  // Token counts are measured facts and survive an unknown price.
  assert.equal(result.output.usage.inputTokens, 400);
  assert.equal(result.output.usage.cacheReadTokens, 900);
  assert.equal(result.output.usage.outputTokens, 40);
  assert.equal(result.output.usage.totalTokens, 1340);
  // The cache-hit denominator is prompt tokens (fresh + cached), never the grand total, so
  // fresh and cached tokens are never conflated into one rate.
  assert.equal(result.output.usage.cacheHitRate, 900 / 1300);

  // The per-model and per-session views say the same thing, and never 0.
  const [model] = result.output.models;
  assert.equal(model.rateKnown, false);
  assert.equal(model.rateCoverage, 'unavailable');
  assert.equal(result.output.perSession.ses_unpriced.totalCost, null);

  const text = runCli(fixture.script, fixture.dataDir, ['--session', 'ses_unpriced', ...fixture.config], fixture.environment);
  assert.equal(text.status, 2);
  assert.match(text.stdout, /COST UNAVAILABLE/);
  assert.match(text.stdout, /unknown, not zero/);
  // The headline check: no dollar amount anywhere for an unpriced model.
  assert.doesNotMatch(text.stdout, /\$\d/, 'an unavailable cost must never render a dollar amount');
  assert.doesNotMatch(text.stdout, /\$0\.0000/);
});

test('a free model is genuinely zero, and a priced one is a real number', (t) => {
  const fixture = withFixture(t);

  const free = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_free', ...fixture.config], fixture.environment);
  assert.equal(free.result.status, 0, 'a genuinely free model is a successful report');
  assertContract(free.output);
  assert.equal(free.output.billing.amountUsd, 0, 'zero is the correct answer for an all-zero rate card');
  assert.equal(free.output.billing.rateKnown, true);
  assert.equal(free.output.billing.coverage, 'complete');
  assert.equal(free.output.usage.totalTokens, 1450, 'a free model still consumed tokens');

  const freeText = runCli(fixture.script, fixture.dataDir, ['--session', 'ses_free', ...fixture.config], fixture.environment);
  assert.equal(freeText.status, 0);
  assert.match(freeText.stdout, /\$0\.000000 \(free model\)/);
  assert.match(freeText.stdout, /genuinely free/);

  const priced = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_root', ...fixture.config], fixture.environment);
  // 300 input @ $1/M + 600 cache read @ $0.10/M + 30 output @ $2/M = $0.00042
  assert.ok(Math.abs(priced.output.billing.amountUsd - 0.00042) < 1e-12);
  assert.notEqual(priced.output.billing.amountUsd, 0);
});

test('aggregate-sourced usage is reported as such instead of implying per-call precision', (t) => {
  const fixture = withFixture(t);
  const result = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_aggregate', ...fixture.config], fixture.environment);
  assert.equal(result.result.status, 0, result.result.stderr);
  assertContract(result.output);
  assert.equal(result.output.usageSources['session-aggregate'], 1);
  assert.equal(result.output.usageFromSessionAggregate, true);
  assert.equal(result.output.usage.totalTokens, 1070, 'the aggregate totals are still exact');
  assert.ok(result.output.warnings.some((warning) => warning.includes('session-aggregate')));

  const text = runCli(fixture.script, fixture.dataDir, ['--session', 'ses_aggregate', ...fixture.config], fixture.environment);
  assert.match(text.stdout, /session-aggregate fallback/);
  assert.match(text.stdout, /per-model split/);
});

test('an unknown session id and an empty ledger both fail loudly', (t) => {
  const fixture = withFixture(t);

  const unknown = runCli(fixture.script, fixture.dataDir, ['--session', 'ses_not_in_this_ledger', ...fixture.config], fixture.environment);
  assert.notEqual(unknown.status, 0, 'an unknown id must not fall back to another session');
  assert.equal(unknown.status, 2);
  assert.equal(unknown.stdout, '', 'no report may be printed for a session that was not found');
  assert.match(unknown.stderr, /unknown OpenCode session id: ses_not_in_this_ledger/);
  assert.doesNotMatch(unknown.stderr, /at [A-Za-z]+ \(.*:\d+:\d+\)|\.mjs:\d+$/m, 'no stack trace may leak');

  // An unknown id from the environment fails the same way: selection is explicit, and the
  // environment is not a licence to report a different session.
  const unknownFromEnv = runCli(fixture.script, fixture.dataDir, fixture.config, { ...fixture.environment, OPENCODE_SESSION_ID: 'ses_not_in_this_ledger' });
  assert.equal(unknownFromEnv.status, 2);
  assert.match(unknownFromEnv.stderr, /unknown OpenCode session id/);

  const empty = runCli(fixture.script, fixture.emptyDataDir, fixture.config, fixture.environment);
  assert.notEqual(empty.status, 0);
  assert.equal(empty.status, 2);
  assert.match(empty.stderr, /OpenCode ledger not found/);
  assert.match(empty.stderr, /--data-dir/);
  assert.doesNotMatch(empty.stderr, /at [A-Za-z]+ \(.*:\d+:\d+\)/, 'no stack trace may leak');

  // A directory that is not an OpenCode ledger at all is named as such.
  const notALedger = fs.mkdtempSync(fixture.dataDir + 'x');
  fs.mkdirSync(`${notALedger}\\.local\\share\\opencode`, { recursive: true });
  fs.writeFileSync(`${notALedger}\\.local\\share\\opencode\\opencode.db`, 'not a database');
  const wrong = runCli(fixture.script, notALedger, fixture.config, fixture.environment);
  assert.equal(wrong.status, 2);
  assert.doesNotMatch(wrong.stderr, /SQLITE_ERROR|at [A-Za-z]+ \(.*:\d+:\d+\)/, 'the raw driver error must not reach the user');
  fs.rmSync(notALedger, { recursive: true, force: true });
});

test('--help and --version name the adapter and the modes it supports', () => {
  const fixture = createOpenCodeFixture();
  try {
    const help = runCli(fixture.script, fixture.dataDir, ['--help']);
    assert.equal(help.status, 0);
    for (const flag of ['--session', '--last', '--today', '--compare', '--from', '--to', '--provider', '--model', '--include-children', '--list', '--json', '--version', '--watch', '--budget']) {
      assert.ok(help.stdout.includes(flag), `--help must document ${flag}`);
    }
    assert.match(help.stdout, /OpenCode/);

    const version = runCli(fixture.script, fixture.dataDir, ['--version']);
    assert.equal(version.status, 0);
    assert.match(version.stdout, /^session-cost \S+ \(opencode adapter\)$/m);
    assert.match(version.stdout, new RegExp(`report contract: ${REPORT_CONTRACT_VERSION}`));
  } finally {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    fs.rmSync(fixture.emptyDataDir, { recursive: true, force: true });
  }
});

test('diagnostics see the configured profile that supplies the rates', (t) => {
  const fixture = withFixture(t);

  const providers = runCli(fixture.script, fixture.dataDir, ['providers', ...fixture.config], fixture.environment);
  assert.equal(providers.status, 0);
  assert.match(providers.stdout, /^fixture-provider@\S+ \[mirrored-rate\]$/m, 'a configured profile must be listed');

  const models = runCli(fixture.script, fixture.dataDir, ['models', 'discover', ...fixture.config], fixture.environment);
  assert.equal(models.status, 0);
  assert.match(models.stdout, /fixture-provider fixture-priced/);
  assert.match(models.stdout, /fixture-provider fixture-free/);

  const explain = runCli(fixture.script, fixture.dataDir, ['config', 'explain', '--provider', 'fixture-provider', '--model', 'fixture-priced', ...fixture.config], fixture.environment);
  assert.equal(explain.status, 0, explain.stderr);
  assert.match(explain.stdout, /provider: fixture-provider \(exact-provider-id\)/);
  assert.match(explain.stdout, /coverage: complete/);

  // An unmirrored model is diagnosed as unresolved, which is a non-zero exit, and it is the
  // documented route for a user whose cost comes back unavailable.
  const unresolved = runCli(fixture.script, fixture.dataDir, ['config', 'explain', '--provider', 'fixture-provider', '--model', 'unknown-model', ...fixture.config], fixture.environment);
  assert.equal(unresolved.status, 2);
  assert.match(unresolved.stdout, /model: unknown-model -> unknown-model \(unknown\)/);
  assert.match(unresolved.stdout, /coverage: unavailable/);
});

test('a bad invocation fails before storage is opened and without a stack trace', (t) => {
  const fixture = withFixture(t);
  for (const args of [['--session'], ['--last', '--today'], ['--list', 'abc'], ['--from', '2026-13-99'], ['--compare', '--last']]) {
    const result = runCli(fixture.script, fixture.dataDir, args);
    assert.equal(result.status, 2, `${args.join(' ')} must exit 2`);
    assert.doesNotMatch(result.stderr, /\.mjs:\d+$/m, `${args.join(' ')} leaked a stack trace`);
    assert.doesNotMatch(result.stderr, /sqlite|opencode\.db/i, `${args.join(' ')} reached storage`);
  }
});
