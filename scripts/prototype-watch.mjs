// PROTOTYPE — not wired into either adapter CLI.
//
// Renders the normalized report as a live terminal view so the shape of `--watch`
// can be evaluated before it is built for real. Every number comes from an actual
// report produced by the real CLI, so nothing here is mocked.
//
//   node scripts/prototype-watch.mjs [--runtime cline|mcode] [--ticks 8]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { createClineFixture, createMCodeFixture } from '../tests/helpers/contract-fixtures.mjs';
import { renderLiveHtml } from './prototype-live-html.mjs';

const args = process.argv.slice(2);
const flag = (name, fallback) => {
  const index = args.indexOf(name);
  return index === -1 ? fallback : args[index + 1];
};
const runtime = flag('--runtime', 'cline');
const ticks = Number(flag('--ticks', 8));
const budget = Number(flag('--budget', 5));
const outputHtml = flag('--html', null);

const WIDTH = 74;
const money = (value) => (value == null ? '     n/a' : `$${Number(value).toFixed(4)}`);
const millions = (value) => `${(Number(value) / 1e6).toFixed(2)} M`;
const clock = (iso) => (iso ? new Date(iso).toISOString().slice(11, 19) : '--:--:--');

function bar(fraction, width = 22) {
  const filled = Math.max(0, Math.min(width, Math.round((Number(fraction) || 0) * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function row(label, right = '') {
  const left = `  ${String(label).slice(0, 24).padEnd(24)}`;
  return `${left}${' '.repeat(Math.max(1, WIDTH - left.length - String(right).length - 1))}${right}`;
}

function delta(previous, current) {
  if (previous == null || current == null) return '';
  const change = current - previous;
  return Math.abs(change) < 1e-9 ? '·' : `+${change.toFixed(4)}`;
}

function line(inner) {
  const text = String(inner);
  return `│ ${text}${' '.repeat(Math.max(1, WIDTH - text.length - 2))} │`;
}

/** Render one frame of the live view from a real normalized report. */
export function renderFrame(report, { previous, elapsedMs, stale }) {
  const usage = report.usage;
  const total = usage.totalTokens || 1;
  const cost = report.billing?.amountUsd ?? null;
  // Burn rate must be the SESSION's own spend rate, not the watcher's uptime.
  // Using elapsed-since-watch would report a 2-day-old session as "$183/minute".
  const start = report.session?.startedAt ? Date.parse(report.session.startedAt) : null;
  const end = report.snapshot?.lastLedgerActivityAt ? Date.parse(report.snapshot.lastLedgerActivityAt) : null;
  const spanMinutes = start != null && end != null && end > start ? (end - start) / 60_000 : null;
  const burn = cost != null && spanMinutes > 0 ? cost / spanMinutes : null;

  const lines = [];
  const title = ' session-cost · live ';
  lines.push(`┌─${title}${'─'.repeat(Math.max(0, WIDTH - title.length - 11))} ${clock(report.snapshot?.capturedAt)} ─┐`);

  const session = `${report.session?.id ?? 'unknown'} · ${(report.session?.title ?? '').slice(0, 24)}`;
  const badge = stale ? 'STALE' : report.snapshot?.active ? 'RUNNING' : 'IDLE';
  lines.push(line(`${session.slice(0, WIDTH - 12).padEnd(WIDTH - 12)}  ${badge}`));
  const last = report.snapshot?.lastLedgerActivityAt
    ? `last ledger activity ${Math.max(0, Math.round((Date.now() - Date.parse(report.snapshot.lastLedgerActivityAt)) / 1000))}s ago`
    : 'no ledger activity recorded';
  lines.push(line(last));
  lines.push(`├${'─'.repeat(WIDTH)}┤`);

  lines.push(line(`TOTAL COST`.padEnd(20) + money(cost) + '   ' + delta(previous?.cost, cost)));
  lines.push(line(burn == null ? '' : `$${burn.toFixed(2)}/min over ${spanMinutes >= 60 ? `${(spanMinutes / 60).toFixed(1)}h` : `${spanMinutes.toFixed(1)}m`} of session`));
  if (budget > 0) {
    const pct = cost == null ? 0 : Math.min(1, cost / budget);
    const over = cost != null && cost > budget ? '!! OVER BUDGET ' : '';
    lines.push(line(`${over}budget $${budget.toFixed(2)}  ${bar(pct, 18)} ${(pct * 100).toFixed(0)}%`));
  }
  lines.push(`├${'─'.repeat(WIDTH)}┤`);

  lines.push(line(`Total tokens  ${millions(usage.totalTokens)}`));
  for (const [label, value] of [
    ['Fresh input', usage.freshInputTokens],
    ['Cached read', usage.cacheReadTokens],
    ['Cache write', usage.cacheWriteTokens],
    ['Output', usage.outputTokens],
  ]) {
    lines.push(line(`${label.padEnd(14)} ${bar(value / total, 20)} ${(value / total * 100).toFixed(0).padStart(3)}%`));
  }
  lines.push(line(`cache hit rate ${(usage.cacheHitRate * 100).toFixed(1)}%`));
  lines.push(`├${'─'.repeat(WIDTH)}┤`);

  lines.push(line('MODELS'));
  const models = Object.values(report.total?.models ?? {})
    .sort((a, b) => (b.cost ?? 0) - (a.cost ?? 0)).slice(0, 4);
  const modelCost = models.reduce((sum, model) => sum + (model.cost ?? 0), 0) || 1;
  for (const model of models) {
    lines.push(row(`${model.provider ?? '?'}/${model.model ?? '?'}`, `${money(model.cost).padStart(10)} ${bar((model.cost ?? 0) / modelCost, 12)}`));
  }

  const included = report.sessionGraph?.includedSessionIds ?? [];
  if (included.length > 1) {
    lines.push(`├${'─'.repeat(WIDTH)}┤`);
    lines.push(line(`SESSION TREE — ${included.length} sessions incl. subagents`));
    for (const id of included.slice(0, 5)) lines.push(line(`  ${id}`));
  }
  lines.push(`├${'─'.repeat(WIDTH)}┤`);
  lines.push(`│${' '.repeat(Math.max(1, WIDTH - 17))}Ctrl-C to stop │`);
  lines.push(`└${'─'.repeat(WIDTH)}┘`);
  return lines.join('\n');
}

// Append a real assistant message so the ledger genuinely grows between polls.
function growClineFixture(fixture) {
  const file = path.join(fixture.dataDir, 'data', 'sessions', 'cline-root.json');
  const payload = JSON.parse(fs.readFileSync(file, 'utf8'));
  payload.messages.push({
    role: 'assistant',
    ts: Date.now(),
    metrics: { inputTokens: 2_800_000, outputTokens: 9_000, cacheReadTokens: 2_400_000, cacheWriteTokens: 120_000, cost: 0.42 },
    modelInfo: { provider: 'cline', id: 'root-model' },
  });
  fs.writeFileSync(file, JSON.stringify(payload, null, 2), 'utf8');
}

async function growMCodeFixture(fixture) {
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(path.join(fixture.dataDir, 'v2', 'sqlite', 'runtime-state.sqlite'));
  db.prepare('INSERT INTO local_runtime_token_usage VALUES (?,?,?,?,?,?,?,?,?,?)')
    .run(900 + Math.floor(performance.now()), 'mcode-root', 'root', `live-${performance.now()}`, Date.now(), 500_000, 9_000, 4_000, 2_600_000, 140_000);
  db.close();
}

const fixture = runtime === 'mcode' ? createMCodeFixture() : createClineFixture();
const target = runtime === 'mcode' ? 'mcode-root' : 'cline-root';
const started = Date.now();
const frames = [];
let previous = null;

for (let tick = 0; tick < ticks; tick += 1) {
  if (tick > 0) (runtime === 'mcode' ? growMCodeFixture : growClineFixture)(fixture);

  const result = spawnSync(process.execPath, [
    fixture.script, '--data-dir', fixture.dataDir,
    '--session', target, '--include-children', '--json',
  ], { encoding: 'utf8' });

  let report = null;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  if (!report) {
    // The live path must degrade, not die: keep the last good frame, marked stale.
    console.log(`\n[live] transient read failure (${result.status}) — showing last known values, marked STALE`);
    console.log(`       ${(result.stderr ?? '').trim().split('\n')[0] ?? 'unknown error'}\n`);
    continue;
  }

  console.log(renderFrame(report, { previous, elapsedMs: Date.now() - started, stale: false }));
  frames.push(report);
  previous = { cost: report.billing?.amountUsd ?? null };
  if (outputHtml) fs.writeFileSync(outputHtml, renderLiveHtml(frames, { budget, runtime, target }), 'utf8');
  if (tick < ticks - 1) await new Promise((resolve) => setTimeout(resolve, 250));
}



