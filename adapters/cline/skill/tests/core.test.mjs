import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import {
  addUsage,
  classifyBilling,
  combineMetrics,
  descendantIds,
  duplicateSuppressedSessionIds,
  emptyMetrics,
  isActiveSessionStatus,
  resolveSession,
  topLevelRows,
  usageSummary,
} from '../scripts/lib/session-cost-core.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'scripts', 'session-cost.mjs');

function metrics(entries) {
  const result = emptyMetrics();
  for (const entry of entries) addUsage(result, entry.metrics, entry.modelInfo);
  return result;
}

test('Cline input tokens include cache; fresh input is the non-cached remainder', () => {
  const result = usageSummary(metrics([{ metrics: { inputTokens: 1000, outputTokens: 100, cacheReadTokens: 800, cacheWriteTokens: 50 }, modelInfo: { provider: 'x', id: 'x' } }]));
  assert.deepEqual(result, {
    totalTokens: 1100,
    inputTokens: 1000,
    freshInputTokens: 150,
    cacheReadTokens: 800,
    cacheWriteTokens: 50,
    outputTokens: 100,
    cacheHitRate: 0.8,
  });
});

test('classifies ClinePass, free, billed, partial, and unavailable calls', () => {
  const pass = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'cline-pass', id: 'stealth/model' } }]));
  assert.equal(pass.classification, 'cline-pass-included');
  assert.equal(pass.coverage, 'not-recorded');

  const free = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'cline', id: 'poolside/model:free' } }]));
  assert.equal(free.classification, 'free-model');

  const billed = classifyBilling(metrics([{ metrics: { inputTokens: 10, cost: 0.01 }, modelInfo: { provider: 'api', id: 'paid' } }]));
  assert.equal(billed.classification, 'usage-billed');
  assert.equal(billed.recordedCostUsd, 0.01);

  const partial = classifyBilling(metrics([
    { metrics: { inputTokens: 10, cost: 0.01 }, modelInfo: { provider: 'api', id: 'paid' } },
    { metrics: { inputTokens: 10 }, modelInfo: { provider: 'api', id: 'paid' } },
  ]));
  assert.equal(partial.classification, 'partial-cost');
  assert.equal(partial.coverage, 'partial');

  const unavailable = classifyBilling(metrics([{ metrics: { inputTokens: 10 }, modelInfo: { provider: 'unknown', id: 'mystery' } }]));
  assert.equal(unavailable.classification, 'cost-unavailable');
});

test('combines model and call metrics without losing coverage counters', () => {
  const left = metrics([{ metrics: { inputTokens: 100, outputTokens: 10, cacheReadTokens: 50, cost: 0.1 }, modelInfo: { provider: 'p', id: 'm' } }]);
  const right = metrics([{ metrics: { inputTokens: 200, outputTokens: 20, cacheReadTokens: 100 }, modelInfo: { provider: 'p', id: 'm' } }]);
  const result = combineMetrics(emptyMetrics(), left);
  combineMetrics(result, right);
  assert.equal(result.calls, 2);
  assert.equal(result.pricedCalls, 1);
  assert.equal(result.unpricedCalls, 1);
  assert.equal(result.inputTokens, 300);
  assert.equal(result.models.get('p|m').calls, 2);
});

test('descendantIds includes nested subagents', () => {
  const rows = [
    { session_id: 'root', parent_session_id: null },
    { session_id: 'child', parent_session_id: 'root' },
    { session_id: 'grandchild', parent_session_id: 'child' },
    { session_id: 'other', parent_session_id: null },
  ];
  assert.deepEqual([...descendantIds(rows, 'root')], ['root', 'child', 'grandchild']);
});

test('session resolver prioritizes explicit and environment IDs', () => {
  const rows = [{ session_id: 'a', pid: 1, status: 'running' }, { session_id: 'b', pid: 2, status: 'running' }];
  assert.equal(resolveSession(rows, { explicitId: 'b' }).row.session_id, 'b');
  assert.equal(resolveSession(rows, { environment: { CLINE_SESSION_ID: 'a' } }).method, 'environment');
});

test('session resolver does not guess among multiple running sessions', () => {
  const rows = [
    { session_id: 'a', pid: 1, status: 'running', started_at: '2026-01-02T00:00:00Z' },
    { session_id: 'b', pid: 2, status: 'running', started_at: '2026-01-01T00:00:00Z' },
  ];
  const result = resolveSession(rows);
  assert.equal(result.method, 'ambiguous-running');
  assert.deepEqual(result.ambiguousCandidates, ['a', 'b']);
  assert.match(result.warning, /multiple running/);
});

test('top-level selection suppresses nested candidates without losing a child-only match', () => {
  const rows = [
    { session_id: 'root', parent_session_id: null },
    { session_id: 'child', parent_session_id: 'root' },
    { session_id: 'grandchild', parent_session_id: 'child' },
    { session_id: 'other', parent_session_id: null },
  ];
  const roots = topLevelRows(rows, rows);
  assert.deepEqual(roots.map((row) => row.session_id), ['root', 'other']);
  assert.deepEqual(duplicateSuppressedSessionIds(rows, rows), ['child', 'grandchild']);
  const childOnly = topLevelRows(rows, [{ session_id: 'grandchild', parent_session_id: 'child' }]);
  assert.deepEqual(childOnly.map((row) => row.session_id), ['grandchild']);
});

test('unknown zero-cost calls are not guessed as included', () => {
  const unknownZero = classifyBilling(metrics([{ metrics: { inputTokens: 10, cost: 0 }, modelInfo: { provider: 'unknown', id: 'mystery' } }]));
  assert.equal(unknownZero.classification, 'cost-unavailable');
  assert.equal(unknownZero.actualChargeUsd, null);
  const mixed = classifyBilling(metrics([
    { metrics: { inputTokens: 10 }, modelInfo: { provider: 'cline-pass', id: 'pass' } },
    { metrics: { inputTokens: 10, cost: 0.25 }, modelInfo: { provider: 'unknown', id: 'mystery' } },
  ]));
  assert.equal(mixed.classification, 'mixed-billing');
  assert.equal(mixed.billingMode, 'mixed-included');
});

test('idle and pending are active statuses, while completed is terminal', () => {
  assert.equal(isActiveSessionStatus('idle'), true);
  assert.equal(isActiveSessionStatus('pending'), true);
  assert.equal(isActiveSessionStatus('completed'), false);
  const result = resolveSession([
    { session_id: 'idle', pid: 1, status: 'idle', started_at: '2026-01-02T00:00:00Z' },
    { session_id: 'old', pid: 2, status: 'completed', started_at: '2026-01-03T00:00:00Z' },
  ]);
  assert.equal(result.method, 'unique-active');
  assert.equal(result.row.session_id, 'idle');
});

function makeFixture() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-session-cost-'));
  fs.mkdirSync(path.join(dataDir, 'data', 'db'), { recursive: true });
  fs.mkdirSync(path.join(dataDir, 'data', 'sessions'), { recursive: true });
  const db = new DatabaseSync(path.join(dataDir, 'data', 'db', 'sessions.db'));
  db.exec('CREATE TABLE sessions (session_id TEXT PRIMARY KEY, pid INTEGER, started_at TEXT, ended_at TEXT, status TEXT, provider TEXT, model TEXT, parent_session_id TEXT, is_subagent INTEGER, prompt TEXT, metadata_json TEXT, messages_path TEXT, updated_at TEXT)');
  const message = (inputTokens, outputTokens, cost) => ({ messages: [{ role: 'assistant', metrics: { inputTokens, outputTokens, ...(cost === undefined ? {} : { cost }) }, modelInfo: { provider: 'p', id: 'm' }, ts: 1 }] });
  const add = (id, startedAt, parent, status, input, output, metadata = '{}', cost) => {
    const messagesPath = path.join(dataDir, 'data', 'sessions', `${id}.json`);
    if (input !== null) fs.writeFileSync(messagesPath, JSON.stringify(message(input, output, cost)));
    db.prepare('INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(id, id.length, startedAt, null, status, 'p', 'm', parent, parent ? 1 : 0, id, metadata, input === null ? null : messagesPath, startedAt);
  };
  return { dataDir, db, add };
}

test('CLI aggregate uses one global set for nested children and discloses duplicates', () => {
  const fixture = makeFixture();
  fixture.add('root', '2026-01-01T00:00:00Z', null, 'completed', 100, 10, JSON.stringify({ title: 'root' }));
  fixture.add('child', '2026-01-02T00:00:00Z', 'root', 'completed', 20, 2);
  fixture.add('grandchild', '2026-01-02T01:00:00Z', 'child', 'completed', 10, 1);
  fixture.add('other', '2026-01-04T00:00:00Z', null, 'idle', 50, 5);
  fixture.db.close();
  const result = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--from', '2026-01-01', '--to', '2026-01-04', '--include-children', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.deepEqual(report.rootSessionIds.sort(), ['other', 'root']);
  assert.deepEqual(report.includedSessionIds.sort(), ['child', 'grandchild', 'other', 'root']);
  assert.deepEqual(report.duplicateSuppressedSessionIds.sort(), ['child', 'grandchild']);
  assert.equal(report.usage.totalTokens, 198);
  assert.equal(new Set(report.includedSessionIds).size, report.includedSessionIds.length);
  const listResult = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--list', '10', '--include-children', '--json'], { encoding: 'utf8' });
  assert.equal(listResult.status, 0, listResult.stderr);
  const list = JSON.parse(listResult.stdout);
  assert.deepEqual(list.selection.rootSessionIds.sort(), ['other', 'root']);
  assert.equal(new Set(list.selection.includedSessionIds).size, list.selection.includedSessionIds.length);
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
});

test('CLI validates explicit IDs and distinguishes a known zero-call session', () => {
  const fixture = makeFixture();
  fixture.add('zero', '2026-01-01T00:00:00Z', null, 'completed', 0, 0);
  fs.writeFileSync(path.join(fixture.dataDir, 'data', 'sessions', 'zero.json'), JSON.stringify({ messages: [] }));
  fixture.db.close();
  const unknown = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--session', 'missing', '--json'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.match(unknown.stderr, /unknown session id: missing/);
  const known = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--session', 'zero', '--json'], { encoding: 'utf8' });
  assert.equal(known.status, 0, known.stderr);
  assert.equal(JSON.parse(known.stdout).billing.classification, 'no-calls');
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
});

test('CLI uses end-to-end aggregate only when a descendant ledger is unavailable and preserves its cost', () => {
  const fixture = makeFixture();
  fixture.add('root', '2026-01-01T00:00:00Z', null, 'completed', 100, 10, JSON.stringify({
    title: 'root',
    totalCost: 0.75,
    usage: { inputTokens: 100, outputTokens: 10, totalCost: 0.1 },
    aggregateUsage: { inputTokens: 300, outputTokens: 30, totalCost: 0.75 },
  }), 0.1);
  fixture.add('missing-child', '2026-01-01T00:01:00Z', 'root', 'completed', null, null);
  fixture.db.close();
  const result = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--session', 'root', '--include-children', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.usage.inputTokens, 300);
  assert.equal(report.total.cost, 0.75);
  assert.equal(report.total.callsKnown, false);
  assert.equal(report.total.calls, null);
  assert.equal(report.billing.billingMode, 'recorded-charge');
  assert.equal(report.aggregateFallbacks[0].scope, 'end-to-end');
  const rootOnly = spawnSync(process.execPath, [script, '--data-dir', fixture.dataDir, '--session', 'root', '--json'], { encoding: 'utf8' });
  assert.equal(rootOnly.status, 0, rootOnly.stderr);
  const rootOnlyReport = JSON.parse(rootOnly.stdout);
  assert.equal(rootOnlyReport.usage.inputTokens, 100);
  assert.equal(rootOnlyReport.total.cost, 0.1);
  assert.equal(rootOnlyReport.aggregateFallbacks.length, 0);
  fs.rmSync(fixture.dataDir, { recursive: true, force: true });
});
