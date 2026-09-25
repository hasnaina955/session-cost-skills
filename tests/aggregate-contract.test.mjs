import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { createClineFixture, clineScript, runCli, runJson } from './helpers/contract-fixtures.mjs';

function database(fixture) {
  return new DatabaseSync(`${fixture.dataDir}/data/db/sessions.db`);
}

function messagesPath(fixture, sessionId) {
  const db = database(fixture);
  try {
    return db.prepare('SELECT messages_path FROM sessions WHERE session_id = ?').get(sessionId).messages_path;
  } finally {
    db.close();
  }
}

test('root aggregate is end-to-end, preserves stored cost, and is not double-counted', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  fs.writeFileSync(messagesPath(fixture, 'cline-root'), '{"messages":[', 'utf8');
  const db = database(fixture);
  db.prepare('UPDATE sessions SET metadata_json = ? WHERE session_id = ?').run(JSON.stringify({
    title: 'Aggregate root',
    aggregateUsage: { inputTokens: 100_000, outputTokens: 10_000, cacheReadTokens: 0, cacheWriteTokens: 0 },
    totalCost: 1.25,
  }), 'cline-root');
  db.close();

  const rootOnly = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root']);
  assert.equal(rootOnly.result.status, 0, rootOnly.result.stderr);
  assert.equal(rootOnly.output.usageScope, 'end-to-end');
  assert.equal(rootOnly.output.totalSource, 'root-aggregate');
  assert.equal(rootOnly.output.rootCallCountKnown, false);
  assert.equal(rootOnly.output.total.calls, 0);
  assert.equal(rootOnly.output.billing.classification, 'aggregate-usage');
  assert.equal(rootOnly.output.billing.amountUsd, 1.25);
  assert.equal(rootOnly.output.provenance.kind, 'runtime-aggregate');
  assert.ok(rootOnly.output.warnings.some((warning) => /already includes descendant sessions/.test(warning)));

  const included = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children']);
  assert.equal(included.result.status, 0, included.result.stderr);
  assert.equal(included.output.usage.totalTokens, 110_000);
  assert.equal(included.output.totalSource, 'root-aggregate');
});

test('null aggregate cost never overwrites valid per-message cost', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  fs.writeFileSync(messagesPath(fixture, 'cline-child'), '{"messages":[', 'utf8');
  fs.writeFileSync(messagesPath(fixture, 'cline-grandchild'), '{"messages":[', 'utf8');
  const db = database(fixture);
  db.prepare('UPDATE sessions SET metadata_json = ? WHERE session_id = ?').run(JSON.stringify({ totalCost: null }), 'cline-root');
  db.close();

  const result = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--include-children']);
  assert.equal(result.result.status, 0, result.result.stderr);
  assert.ok(Math.abs(result.output.total.cost - 0.15) < 1e-12);
  assert.equal(result.output.billing.classification, 'usage-billed');
  assert.equal(result.output.totalSource, 'partial-messages');
  assert.deepEqual(result.output.missingChildSessionIds, ['cline-child', 'cline-grandchild']);
});

test('Cline text and JSON expose the same aggregate scope and billing classification', (t) => {
  const fixture = createClineFixture();
  t.after(() => fs.rmSync(fixture.dataDir, { recursive: true, force: true }));
  fs.writeFileSync(messagesPath(fixture, 'cline-root'), '{"messages":[', 'utf8');
  const db = database(fixture);
  db.prepare('UPDATE sessions SET metadata_json = ? WHERE session_id = ?').run(JSON.stringify({
    aggregateUsage: { inputTokens: 100_000, outputTokens: 10_000 },
    totalCost: 1.25,
  }), 'cline-root');
  db.close();

  const json = runJson(clineScript, fixture.dataDir, ['--session', 'cline-root', '--json']);
  const text = runCli(clineScript, fixture.dataDir, ['--session', 'cline-root']);
  assert.equal(text.status, 0, text.stderr);
  assert.match(json.result.stdout, /"usageScope": "end-to-end"/);
  assert.match(json.result.stdout, /"classification": "aggregate-usage"/);
  assert.match(json.result.stdout, /"amountUsd": 1.25/);
  assert.match(text.stdout, /Usage scope: end-to-end/);
  assert.match(text.stdout, /Aggregate usage/);
});
