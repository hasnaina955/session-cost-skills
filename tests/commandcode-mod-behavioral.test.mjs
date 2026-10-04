import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import {removeDirectory} from './helpers/temp-dir.mjs';

/**
 * Behavioral coverage for the Command Code mod. The static suite (commandcode-mod.test.mjs)
 * reads the source; this file actually RUNS it. The mod is type-strippable TypeScript - only
 * `import type` and interfaces, no runtime TS features - so Node 24's built-in type stripping
 * (and Bun's native TS support) can import it with no build step. On Node 22.15, which cannot,
 * every test here skips rather than fails: the harness says plainly what it could not check.
 *
 * The fixture is a real v3 transcript, the shape the vendor documents and tokscale
 * corroborates: a header line, then assistant message records with a disjoint-bucket usage
 * block (inputTokens excludes cached tokens) and, where the ledger has it, a recorded costUsd.
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'adapters', 'commandcode', 'skill', 'session-cost.ts');

async function loadMod() {
  try {
    return (await import(modPath)).default;
  } catch {
    return null;
  }
}

function harness(factory) {
  const registered = {command: null, tool: null};
  factory({
    addCommand: (command) => { registered.command = command; },
    addTool: (tool) => { registered.tool = tool; },
  });
  return registered;
}

function writeLedger(dir, slug, sessionId, lines) {
  const project = path.join(dir, slug);
  fs.mkdirSync(project, {recursive: true});
  fs.writeFileSync(
    path.join(project, `${sessionId}.jsonl`),
    lines.map((line) => JSON.stringify(line)).join('\n') + '\n',
    'utf8',
  );
}

const HEADER = (id, version = 3) => ({
  type: 'session',
  version,
  id,
  timestamp: '2026-06-15T10:00:00.000Z',
  cwd: '/work/fixture',
});
const ASSISTANT = (id, timestamp, model, usage) => ({
  type: 'message',
  id,
  timestamp,
  message: {role: 'assistant', content: [{type: 'text', text: 'fixture'}]},
  usage,
  model,
});
// deepseek-v4-flash is banded in the embedded table (peak x2, off-peak x1): input .15,
// output .60, cacheRead .003, cacheWrite 0 per 1M off-peak. 2026-06-15 is a Monday, and
// 12:00 UTC is outside every peak window, so off-peak is the CORRECT band for the good call.
const GOOD_CALL_ESTIMATE = (1000 * 0.15 + 500 * 0.6 + 100 * 0.003 + 50 * 0) / 1e6;

async function report(factory, dataDir, args) {
  const {command} = harness(factory);
  assert.ok(command, 'the mod must register its slash command');
  const result = await command.handler({args: `--data-dir ${dataDir} --config ${path.join(dataDir, 'absent-config.json')} ${args}`});
  return result.message;
}

const mod = await loadMod();
const skipReason = mod === null ? 'this Node cannot strip TypeScript types (needs 24+); the static suite covers what it can' : false;

test('a banded call with a missing timestamp is unpriced, never priced at the cheaper band', {skip: skipReason}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mod-'));
  t.after(() => removeDirectory(dir));
  writeLedger(dir, 'fixture', 'sess-1', [
    HEADER('sess-1'),
    ASSISTANT('m1', '2026-06-15T12:00:00.000Z', 'deepseek-v4-flash', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50,
      // The ledger's own figure, matching the vendor arithmetic for this exact call.
      costUsd: GOOD_CALL_ESTIMATE,
    }),
    // The torn call: no timestamp of its own. Before the takeover fix this priced at
    // off-peak - the cheaper band - because new Date('') fails every peak comparison.
    ASSISTANT('m2', '', 'deepseek-v4-flash', {
      inputTokens: 4000, outputTokens: 2000, cacheReadTokens: 400, cacheWriteTokens: 200,
    }),
  ]);

  const out = JSON.parse(await report(mod, dir, '--session sess-1 --json'));
  const [session] = out.sessions;
  assert.equal(out.totals.pricedCostUsd, GOOD_CALL_ESTIMATE, 'only the call with a real timestamp may be priced');
  assert.equal(session.costUsd, null, 'a session with an unpriced call has no total');
  assert.equal(out.coverage.status, 'partial', 'the gap is named');
  // The recorded domain is surfaced separately, never merged into the estimate (rule 3).
  assert.equal(session.recordedCostUsd, GOOD_CALL_ESTIMATE, 'the ledger-recorded figure is disclosed');
  assert.equal(out.billing.recordedCostUsd, null, 'an estimate-basis report keeps billing.recordedCostUsd null');
  assert.equal(out.billing.basis, 'provider-rate-estimate');
  // Estimate and recorded agree here, so the tripwire stays quiet.
  assert.ok(!out.warnings.some((w) => w.includes('disagree')), 'no tripwire when the domains agree');
});

test('a transcript whose schema version the mod does not understand fails by name, not by zero', {skip: skipReason}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mod-'));
  t.after(() => removeDirectory(dir));
  writeLedger(dir, 'fixture', 'sess-new', [
    HEADER('sess-new', 4),
    ASSISTANT('m1', '2026-06-15T12:00:00.000Z', 'deepseek-v4-flash', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50,
    }),
  ]);

  const out = JSON.parse(await report(mod, dir, '--session sess-new --json'));
  const [session] = out.sessions;
  assert.equal(session.schemaDrift, 4, 'the drift is named by version');
  assert.equal(session.costUsd, null, 'a drifted transcript is unpriced, never a zero-sum');
  assert.equal(session.calls, 0, 'its calls are not parsed');
  assert.ok(
    out.warnings.some((w) => w.includes('transcript version 4')),
    'the report warns about the drift instead of reading renamed fields as zeros',
  );
});

test('a flat-rate call does not need a timestamp, and a disagreeing ledger trips the mirror warning', {skip: skipReason}, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-mod-'));
  t.after(() => removeDirectory(dir));
  // glm-5.3 is flat in the embedded table (input 1.4, output 4.4, cacheRead 0.26 per 1M):
  // no band to resolve, so a missing timestamp cannot misprice it.
  writeLedger(dir, 'fixture', 'sess-2', [
    HEADER('sess-2'),
    ASSISTANT('m1', '', 'glm-5.3', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
      costUsd: 0.999, // a figure the mirror cannot reproduce: the tripwire must fire
    }),
  ]);

  const out = JSON.parse(await report(mod, dir, '--session sess-2 --json'));
  const [session] = out.sessions;
  assert.equal(session.costUsd, (1000 * 1.4 + 500 * 4.4) / 1e6, 'a flat call prices without a timestamp');
  assert.equal(session.recordedCostUsd, 0.999, 'the recorded domain is still disclosed');
  assert.ok(
    out.warnings.some((w) => w.includes('disagree') && w.includes('--refresh-rates')),
    'a ledger the mirror cannot reproduce trips the staleness warning',
  );
});
