import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_CONTRACT_VERSION, assertNormalizedReport } from '../adapters/cline/skill/scripts/lib/report-contract.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';
import { createClineFixture, createMCodeFixture, createOpenCodeFixture, runCli, runJson } from './helpers/contract-fixtures.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../contracts/normalized-report-v1.schema.json', import.meta.url), 'utf8'));
const contractSource = fs.readFileSync(new URL('../shared/report-contract.mjs', import.meta.url), 'utf8');

function assertContract(report, expectedRuntime) {
  assert.deepEqual(validateJsonSchema(report, schema), []);
  assert.equal(assertNormalizedReport(report), report);
  assert.equal(report.contractVersion, REPORT_CONTRACT_VERSION);
  assert.equal(report.runtime.id, expectedRuntime);
  assert.match(report.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.equal(typeof report.selection.method, 'string');
  assert.ok(report.usage.semantics);
  assert.ok(report.provenance.source);
  assert.ok(Array.isArray(report.sessionGraph.includedSessionIds));
}

function assertBatch(output, expectedRuntime, expectedCount) {
  assert.equal(output.schemaVersion, 1);
  assert.equal(output.contractVersion, REPORT_CONTRACT_VERSION);
  assert.equal(output.runtime, expectedRuntime);
  assert.ok(['report-list', 'report-comparison'].includes(output.kind));
  const reports = output.kind === 'report-list'
    ? output.sessions
    : [output.comparison.older, output.comparison.newer];
  assert.equal(reports.length, expectedCount);
  reports.forEach((report) => assertContract(report, expectedRuntime));
}

function dashboardOutput(fixture) {
  const out = path.join(fixture.dataDir, 'dashboard.html');
  // An adapter that prices from configuration (OpenCode) needs its config passed here too, or
  // the dashboard it writes would describe a session whose cost it could not compute.
  const { result, output } = runJson(fixture.script, fixture.dataDir, [
    '--session',
    fixture.runtimeSession,
    '--include-children',
    ...(fixture.dashboardArgs ?? []),
    '--dashboard',
    '--out',
    out,
  ], fixture.environment);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(output.contractVersion, REPORT_CONTRACT_VERSION);
  assert.equal(output.runtime, fixture.runtimeId);
  assert.equal(output.kind, 'dashboard');
  assertContract(output.report, fixture.runtimeId);
  const html = fs.readFileSync(out, 'utf8');
  assert.ok(html.includes(`"contractVersion":"${REPORT_CONTRACT_VERSION}"`));
  assert.ok(html.includes(`"id":"${fixture.runtimeId}"`));
  return output.report;
}

test('every adapter contains the canonical contract implementation and schema', () => {
  for (const adapter of ['cline', 'mcode', 'opencode']) {
    const source = fs.readFileSync(new URL(`../adapters/${adapter}/skill/scripts/lib/report-contract.mjs`, import.meta.url), 'utf8');
    assert.equal(source, contractSource);
  }
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.ok(schema.required.includes('contractVersion'));
  // A runtime that the schema rejects would make its reports unvalidatable, and a runtime the
  // shared contract rejects would make them unassertable. The two lists must agree.
  const schemaRuntimes = schema.properties.runtime.$ref === '#/$defs/runtime'
    ? schema.$defs.runtime.properties.id.enum
    : null;
  assert.deepEqual([...schemaRuntimes].sort(), ['cline', 'mcode', 'opencode']);
  assert.match(contractSource, /\['cline', 'mcode', 'opencode'\]\.includes\(report\?\.runtime\?\.id\)/);
});

test('Cline CLI satisfies the shared contract across all report modes', (t) => {
  const fixture = { ...createClineFixture(), runtimeId: 'cline', runtimeSession: 'cline-root' };
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));

  const root = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession, '--include-children']);
  assert.equal(root.result.status, 0, root.result.stderr);
  assertContract(root.output, 'cline');
  assert.equal(root.output.runtime.costBasis, 'runtime-recorded');
  assert.equal(root.output.providerDriver.id, 'commandcode');
  assert.match(root.output.providerDriver.fingerprint, /^sha256:/);
  assert.equal(root.output.configuration.config.schemaVersion, 1);
  assert.equal(root.output.configuration.sources.cli.merged, true);
  assert.equal(root.output.usage.semantics.inputTokenMeaning, 'includes-cache');
  assert.deepEqual(root.output.sessionGraph.rootSessionIds, ['cline-root']);
  assert.deepEqual(root.output.sessionGraph.includedSessionIds, ['cline-root', 'cline-child', 'cline-grandchild']);
  assert.equal(root.output.sessionGraph.excludedSessionIds.length, 0);
  assert.ok(Object.keys(root.output.total.models).length >= 2, 'root fixture should preserve its model switch');

  const excluded = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession]);
  assert.equal(excluded.result.status, 0, excluded.result.stderr);
  assertContract(excluded.output, 'cline');
  assert.deepEqual(excluded.output.sessionGraph.excludedSessionIds, ['cline-child', 'cline-grandchild']);
  assert.ok(excluded.output.warnings.some((warning) => warning.includes('descendant session')));

  const current = runJson(fixture.script, fixture.dataDir, []);
  assert.equal(current.result.status, 0, current.result.stderr);
  assertContract(current.output, 'cline');
  assert.equal(current.output.selection.method, 'latest-root-fallback');
  assert.match(current.output.selection.warning, /latest root/);

  const last = runJson(fixture.script, fixture.dataDir, ['--last']);
  assert.equal(last.result.status, 0, last.result.stderr);
  assertContract(last.output, 'cline');
  assert.equal(last.output.selection.method, 'last');

  const today = runJson(fixture.script, fixture.dataDir, ['--today']);
  assert.equal(today.result.status, 0, today.result.stderr);
  assertContract(today.output, 'cline');
  assert.deepEqual([...today.output.rootSessionIds].sort(), ['cline-other', 'cline-partial']);

  const compare = runJson(fixture.script, fixture.dataDir, ['--compare']);
  assert.equal(compare.result.status, 0, compare.result.stderr);
  assertBatch(compare.output, 'cline', 2);
  assert.ok(compare.output.duplicateSuppressedSessionIds.includes('cline-child'));

  const list = runJson(fixture.script, fixture.dataDir, ['--list', '10']);
  assert.equal(list.result.status, 0, list.result.stderr);
  assertBatch(list.output, 'cline', 4);
  assert.ok(list.output.duplicateSuppressedSessionIds.includes('cline-grandchild'));

  const range = runJson(fixture.script, fixture.dataDir, [
    '--from', fixture.rootDate,
    '--to', fixture.today,
    '--include-children',
  ]);
  assert.equal(range.result.status, 0, range.result.stderr);
  assertContract(range.output, 'cline');
  assert.equal(range.output.coverage.status, 'partial');

  const filtered = runJson(fixture.script, fixture.dataDir, ['--provider', 'partial-provider']);
  assert.equal(filtered.result.status, 0, filtered.result.stderr);
  assertContract(filtered.output, 'cline');
  assert.equal(filtered.output.session.id, 'cline-partial');
  assert.equal(filtered.output.coverage.status, 'partial');
  assert.equal(filtered.output.billing.amountUsd, 0.04);

  const truncated = runJson(fixture.script, fixture.dataDir, ['--session', 'cline-truncated']);
  assert.equal(truncated.result.status, 0, truncated.result.stderr);
  assertContract(truncated.output, 'cline');
  assert.equal(truncated.output.coverage.status, 'no-calls');
  assert.equal(truncated.output.billing.amountUsd, 0);

  dashboardOutput(fixture);
});


test('MCode CLI satisfies the shared contract across all report modes', (t) => {
  const fixture = { ...createMCodeFixture(), runtimeId: 'mcode', runtimeSession: 'mcode-root' };
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));

  const root = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession, '--include-children'], fixture.environment);
  assert.equal(root.result.status, 0, root.result.stderr);
  assertContract(root.output, 'mcode');
  assert.equal(root.output.runtime.costBasis, 'provider-rate-estimate');
  assert.equal(root.output.usage.semantics.inputTokenMeaning, 'excludes-cache');
  assert.equal(root.output.billing.recordedCostUsd, null);
  assert.ok(Number.isFinite(root.output.billing.estimatedCostUsd));
  assert.ok(root.output.rateProvenance.length > 0);
  assert.equal(root.output.rateProvenance[0].component, 'input');
  assert.match(root.output.rateProvenance[0].fingerprint, /^sha256:/);
  assert.equal(typeof root.output.rateProvenance[0].effectiveFrom, 'string');
  assert.deepEqual(root.output.sessionGraph.rootSessionIds, ['mcode-root']);
  assert.deepEqual(root.output.sessionGraph.includedSessionIds, ['mcode-root', 'mcode-child', 'mcode-grandchild']);
  assert.equal(root.output.configuration.config.schemaVersion, 1);
  assert.equal(root.output.configuration.sources.cli.merged, true);
  assert.equal(root.output.multiProvider, true);
  assert.ok(root.output.models.length >= 2);
  assert.deepEqual(root.output.providerDrivers.map((driver) => driver.id).sort(), ['commandcode', 'stepfun']);
  assert.ok(root.output.providerDrivers.every((driver) => /^sha256:/.test(driver.fingerprint)));

  const excluded = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession], fixture.environment);
  assert.equal(excluded.result.status, 0, excluded.result.stderr);
  assertContract(excluded.output, 'mcode');
  assert.deepEqual(excluded.output.sessionGraph.excludedSessionIds, ['mcode-child', 'mcode-grandchild']);

  const current = runJson(fixture.script, fixture.dataDir, [], {
    ...fixture.environment,
    MCODE_SESSION_ID: fixture.runtimeSession,
  });
  assertContract(current.output, 'mcode');
  assert.equal(current.result.status, current.output.rateKnown ? 0 : 2, current.result.stderr);
  assert.equal(current.output.selection.method, 'environment');
  assert.equal(current.output.sessionId, fixture.runtimeSession);

  const last = runJson(fixture.script, fixture.dataDir, ['--last'], fixture.environment);
  assertContract(last.output, 'mcode');
  assert.equal(last.result.status, last.output.rateKnown ? 0 : 2, last.result.stderr);
  assert.equal(last.output.selection.method, 'last');

  const today = runJson(fixture.script, fixture.dataDir, ['--today'], fixture.environment);
  assert.equal(today.result.status, 2, today.result.stderr);
  assertContract(today.output, 'mcode');
  assert.deepEqual(today.output.rootSessionIds, ['mcode-partial', 'mcode-other']);

  const compare = runJson(fixture.script, fixture.dataDir, ['--compare'], fixture.environment);
  assert.equal(compare.result.status, 2, compare.result.stderr);
  assertBatch(compare.output, 'mcode', 2);
  assert.ok(compare.output.duplicateSuppressedSessionIds.includes('mcode-child'));

  const list = runJson(fixture.script, fixture.dataDir, ['--list', '10'], fixture.environment);
  assert.equal(list.result.status, 0, list.result.stderr);
  // Asserted as membership, not a bare count. A count only says "some number of roots came
  // back"; listing them says which, so a subagent leaking into the list, or a root going
  // missing, fails here instead of quietly changing the total.
  const listRoots = ['mcode-root', 'mcode-other', 'mcode-partial', 'mcode-truncated', 'mcode-unpriced'];
  assertBatch(list.output, 'mcode', listRoots.length);
  assert.deepEqual(
    list.output.sessions.map((entry) => entry.sessionId).sort(),
    [...listRoots].sort(),
  );
  assert.ok(list.output.duplicateSuppressedSessionIds.includes('mcode-grandchild'));

  const range = runJson(fixture.script, fixture.dataDir, [
    '--from', fixture.rootDate,
    '--to', fixture.today,
    '--include-children',
  ], fixture.environment);
  assert.equal(range.result.status, 2, range.result.stderr);
  assertContract(range.output, 'mcode');
  assert.equal(range.output.coverage.status, 'partial');

  const filtered = runJson(fixture.script, fixture.dataDir, [
    '--provider', 'commandcode',
    '--from', fixture.today,
    '--to', fixture.today,
  ], fixture.environment);
  assert.equal(filtered.result.status, 2, filtered.result.stderr);
  assertContract(filtered.output, 'mcode');
  assert.deepEqual([...filtered.output.rootSessionIds].sort(), ['mcode-other', 'mcode-partial']);
  assert.equal(filtered.output.billing.estimatedCostUsd, null);
  assert.equal(filtered.output.billing.recordedCostUsd, null);
  assert.ok(filtered.output.coverage.unknownReasons.length > 0);

  const truncated = runJson(fixture.script, fixture.dataDir, ['--session', 'mcode-truncated'], fixture.environment);
  assert.equal(truncated.result.status, 0, truncated.result.stderr);
  assertContract(truncated.output, 'mcode');
  assert.equal(truncated.output.inferredModelRows, 1);
  assert.ok(truncated.output.warnings.some((warning) => warning.includes('inferred')));

  // The shared parser rejects the date before any storage is opened, and echoes the
  // offending value so the user can see which argument was wrong.
  const invalidDate = runJson(fixture.script, fixture.dataDir, ['--from', '2026-13-99'], fixture.environment);
  assert.equal(invalidDate.result.status, 2);
  assert.equal(invalidDate.output, null);
  assert.match(invalidDate.result.stderr, /calendar date/);
  assert.match(invalidDate.result.stderr, /2026-13-99/);
  assert.doesNotMatch(invalidDate.result.stderr, /ledger|sqlite|sessions\.db/i, 'a bad date must not reach storage');

  dashboardOutput(fixture);
});

test('OpenCode CLI satisfies the shared contract across all report modes', (t) => {
  const fixture = { ...createOpenCodeFixture(), runtimeId: 'opencode', runtimeSession: 'ses_root' };
  const config = ['--session-config', fixture.configPath];
  fixture.dashboardArgs = config;
  t.after(() => {
    fs.rmSync(fixture.dataDir, { recursive: true, force: true });
    fs.rmSync(fixture.emptyDataDir, { recursive: true, force: true });
  });

  const root = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession, '--include-children', ...config], fixture.environment);
  assert.equal(root.result.status, 0, root.result.stderr);
  assertContract(root.output, 'opencode');
  assert.equal(root.output.runtime.costBasis, 'provider-rate-estimate');
  assert.equal(root.output.usage.semantics.inputTokenMeaning, 'excludes-cache');
  assert.equal(root.output.billing.recordedCostUsd, null);
  assert.ok(Number.isFinite(root.output.billing.estimatedCostUsd));
  assert.deepEqual(root.output.sessionGraph.rootSessionIds, ['ses_root']);
  assert.deepEqual(root.output.sessionGraph.includedSessionIds, ['ses_root', 'ses_child', 'ses_grandchild']);
  assert.equal(root.output.sessionGraph.excludedSessionIds.length, 0);
  assert.equal(root.output.configuration.config.schemaVersion, 1);
  assert.equal(root.output.configuration.sources.cli.merged, true);
  // The reader's 1.x-over-2.x precedence is observable from the CLI: the root session exists in
  // both stores with three 1.x calls against one 2.x call, and the report must show the 1.x one.
  assert.equal(root.output.usageSources['v1-per-call'], 3);
  assert.equal(root.output.usageSources['v2-per-call'], 2);
  assert.ok(root.output.models.length >= 1);
  assert.ok(root.output.providerDrivers.every((driver) => /^sha256:/.test(driver.fingerprint)));
  // Contract rule 4: a descendant is billed at most once.
  const billed = Object.entries(root.output.perSession);
  assert.equal(billed.length, 3);
  assert.ok(Math.abs(billed.reduce((total, [, entry]) => total + entry.totalCost, 0) - root.output.billing.amountUsd) < 1e-12);

  const excluded = runJson(fixture.script, fixture.dataDir, ['--session', fixture.runtimeSession, ...config], fixture.environment);
  assert.equal(excluded.result.status, 0, excluded.result.stderr);
  assertContract(excluded.output, 'opencode');
  assert.deepEqual(excluded.output.sessionGraph.excludedSessionIds, ['ses_child', 'ses_grandchild']);

  const current = runJson(fixture.script, fixture.dataDir, config, {
    ...fixture.environment,
    OPENCODE_SESSION_ID: fixture.runtimeSession,
  });
  assert.equal(current.result.status, 0, current.result.stderr);
  assertContract(current.output, 'opencode');
  assert.equal(current.output.selection.method, 'environment');
  assert.equal(current.output.sessionId, fixture.runtimeSession);

  const last = runJson(fixture.script, fixture.dataDir, ['--last', ...config], fixture.environment);
  assertContract(last.output, 'opencode');
  assert.equal(last.output.selection.method, 'last');

  const today = runJson(fixture.script, fixture.dataDir, ['--today', ...config], fixture.environment);
  assert.equal(today.result.status, 0, today.result.stderr);
  assertContract(today.output, 'opencode');
  assert.deepEqual([...today.output.rootSessionIds].sort(), ['ses_today']);

  const compare = runJson(fixture.script, fixture.dataDir, ['--compare', ...config], fixture.environment);
  assert.equal(compare.result.status, 0, compare.result.stderr);
  assertBatch(compare.output, 'opencode', 2);
  assert.ok(compare.output.duplicateSuppressedSessionIds.includes('ses_child'));

  const list = runJson(fixture.script, fixture.dataDir, ['--list', '10', ...config], fixture.environment);
  assert.equal(list.result.status, 0, list.result.stderr);
  const listRoots = ['ses_root', 'ses_today', 'ses_free', 'ses_unpriced', 'ses_aggregate', 'ses_empty'];
  assertBatch(list.output, 'opencode', listRoots.length);
  assert.deepEqual(
    list.output.sessions.map((entry) => entry.sessionId).sort(),
    [...listRoots].sort(),
  );
  assert.ok(list.output.duplicateSuppressedSessionIds.includes('ses_grandchild'));

  const range = runJson(fixture.script, fixture.dataDir, [
    '--from', fixture.rootDate,
    '--to', fixture.today,
    '--include-children',
    ...config,
  ], fixture.environment);
  assert.equal(range.result.status, 0, range.result.stderr);
  assertContract(range.output, 'opencode');

  // An unmirrored model: tokens intact, cost unavailable, and never a zero.
  const filtered = runJson(fixture.script, fixture.dataDir, ['--model', 'unknown-model', ...config], fixture.environment);
  assert.equal(filtered.result.status, 2, 'an unknown cost is a non-zero exit');
  assertContract(filtered.output, 'opencode');
  assert.equal(filtered.output.sessionId, 'ses_unpriced');
  assert.equal(filtered.output.billing.estimatedCostUsd, null);
  assert.equal(filtered.output.billing.recordedCostUsd, null);
  assert.equal(filtered.output.coverage.status, 'unavailable');
  assert.ok(filtered.output.coverage.unknownReasons.length > 0);
  assert.equal(filtered.output.usage.totalTokens, 1340, 'measured tokens survive an unknown price');

  // A session whose only source is the session aggregate reports that, rather than claiming
  // a per-model split it cannot have.
  const aggregateOnly = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_aggregate', ...config], fixture.environment);
  assert.equal(aggregateOnly.result.status, 0, aggregateOnly.result.stderr);
  assertContract(aggregateOnly.output, 'opencode');
  assert.equal(aggregateOnly.output.usageFromSessionAggregate, true);
  assert.ok(aggregateOnly.output.warnings.some((warning) => warning.includes('session-aggregate')));

  const noCalls = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_empty', ...config], fixture.environment);
  assert.equal(noCalls.result.status, 0, noCalls.result.stderr);
  assertContract(noCalls.output, 'opencode');
  assert.equal(noCalls.output.coverage.status, 'no-calls');
  assert.equal(noCalls.output.billing.amountUsd, 0);

  // Selection is explicit: an unknown id and an empty ledger both fail, and neither prints a report.
  const unknown = runJson(fixture.script, fixture.dataDir, ['--session', 'ses_not_in_this_ledger', ...config], fixture.environment);
  assert.equal(unknown.result.status, 2);
  assert.equal(unknown.output, null);
  assert.match(unknown.result.stderr, /unknown OpenCode session id/);

  const emptyLedger = runCli(fixture.script, fixture.emptyDataDir, config, fixture.environment);
  assert.equal(emptyLedger.status, 2);
  assert.equal(emptyLedger.stdout, '');
  assert.match(emptyLedger.stderr, /OpenCode ledger not found/);

  const invalidDate = runJson(fixture.script, fixture.dataDir, ['--from', '2026-13-99', ...config], fixture.environment);
  assert.equal(invalidDate.result.status, 2);
  assert.equal(invalidDate.output, null);
  assert.match(invalidDate.result.stderr, /calendar date/);
  assert.match(invalidDate.result.stderr, /2026-13-99/);
  assert.doesNotMatch(invalidDate.result.stderr, /sqlite|opencode\.db/i, 'a bad date must not reach storage');

  dashboardOutput(fixture);
});

test('schema rejects a report with no contract version or cost basis', () => {
  const report = {
    schemaVersion: 1,
    runtime: { id: 'cline', storageSource: 'test' },
  };
  const errors = validateJsonSchema(report, schema);
  assert.ok(errors.some((error) => error.includes('contractVersion')));
  assert.ok(errors.some((error) => error.includes('costBasis')));
});
