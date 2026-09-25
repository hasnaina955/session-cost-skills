import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { REPORT_CONTRACT_VERSION, assertNormalizedReport } from '../adapters/cline/skill/scripts/lib/report-contract.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';
import { createClineFixture, createMCodeFixture, runCli, runJson } from './helpers/contract-fixtures.mjs';

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
  const { result, output } = runJson(fixture.script, fixture.dataDir, [
    '--session',
    fixture.runtimeSession,
    '--include-children',
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

test('both adapters contain the canonical contract implementation and schema', () => {
  for (const adapter of ['cline', 'mcode']) {
    const source = fs.readFileSync(new URL(`../adapters/${adapter}/skill/scripts/lib/report-contract.mjs`, import.meta.url), 'utf8');
    assert.equal(source, contractSource);
  }
  assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
  assert.ok(schema.required.includes('contractVersion'));
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
  assertBatch(list.output, 'mcode', 4);
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

test('schema rejects a report with no contract version or cost basis', () => {
  const report = {
    schemaVersion: 1,
    runtime: { id: 'cline', storageSource: 'test' },
  };
  const errors = validateJsonSchema(report, schema);
  assert.ok(errors.some((error) => error.includes('contractVersion')));
  assert.ok(errors.some((error) => error.includes('costBasis')));
});
