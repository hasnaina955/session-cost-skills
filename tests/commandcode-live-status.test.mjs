// Behavioral coverage for the Command Code live cost line - the footer segment and above-editor
// widget that paint a running estimate while a session is active.
//
// Why a child process: the line's data directory is the runtime default (`~/.commandcode/projects`)
// and its config path is a module-level constant computed at import, so the only honest way to
// exercise the feature - including `"liveStatus": false` - is to run the real module with HOME and
// USERPROFILE pointed at a temporary directory. In-process the module would read the machine's own
// config, and the disabled case would depend on whether the developer happens to have one.
//
// The driver registers the mod against a fake host, fires the same lifecycle events the real TUI
// fires, and reports what reached `setStatus`, `widget`, and the hooks. That is the seam the line
// paints through, so it is the seam worth asserting on.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { removeDirectory } from './helpers/temp-dir.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'adapters', 'commandcode', 'skill', 'session-cost.ts');

// The mod is type-strippable TypeScript, so Node 24 and Bun import it directly. Where they cannot,
// every test skips and says so rather than failing on an environment the feature never runs in.
const canImport = await (async () => {
  try {
    await import(pathToFileURL(modPath).href);
    return true;
  } catch {
    return false;
  }
})();
const skipReason = canImport ? false : `this Node (${process.version}) cannot strip TypeScript types; needs 24+ or Bun`;

const DRIVER = `
import { pathToFileURL } from 'node:url';

const mod = (await import(pathToFileURL(process.argv[2]).href)).default;
const statuses = [];
const widgets = [];
const handlers = new Map();
let hooks = null;

mod({
  addCommand: () => {},
  addTool: () => {},
  on: (event, handler) => {
    if (!handlers.has(event)) handlers.set(event, []);
    handlers.get(event).push(handler);
  },
  hooks: (object) => { hooks = object; },
  ui: {
    setStatus: (text) => statuses.push(text),
    refreshWidgets: () => {},
    widget: (spec) => widgets.push(spec.placement),
  },
});

// The registration-time paint, then the lifecycle events the TUI fires. The sleep crosses the
// 800ms throttle so the second paint is allowed; the first one is not.
const trace = [{ event: 'register', count: statuses.length }];
const fire = (event) => {
  for (const handler of handlers.get(event) ?? []) handler();
  trace.push({ event, count: statuses.length });
};

fire('run_start');
await new Promise((resolve) => setTimeout(resolve, 900));
fire('tool_completed');
if (hooks?.onRunEnd) {
  await hooks.onRunEnd();
  trace.push({ event: 'onRunEnd', count: statuses.length });
}
process.stdout.write(JSON.stringify({ statuses, widgets, trace }));
`;

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
  message: { role: 'assistant', content: [{ type: 'text', text: 'fixture' }] },
  usage,
  model,
});

/** Write a ledger into a relocated home, run the driver against it, and return what it painted. */
function runLive(t, { lines, config }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cc-live-'));
  t.after(() => removeDirectory(dir));
  const home = path.join(dir, 'home');
  const projects = path.join(home, '.commandcode', 'projects', 'fixture');
  fs.mkdirSync(projects, { recursive: true });
  fs.writeFileSync(
    path.join(projects, 'sess-live.jsonl'),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
    'utf8',
  );
  if (config !== undefined) {
    fs.writeFileSync(path.join(home, '.commandcode', 'session-cost.json'), JSON.stringify(config), 'utf8');
  }
  const driver = path.join(dir, 'driver.mjs');
  fs.writeFileSync(driver, DRIVER, 'utf8');

  const result = spawnSync(process.execPath, [driver, modPath], {
    encoding: 'utf8',
    env: { ...process.env, HOME: home, USERPROFILE: home },
  });
  assert.equal(result.status, 0, `the live driver must run:\n${result.stderr}`);
  assert.doesNotMatch(result.stderr, /Error|throw/, `the mod must not throw while painting:\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

// One priced call: deepseek-v4-flash off-peak, 1000 fresh input (the ledger's 1150 total minus the
// 100 cache-read and 50 cache-write it includes), 500 output, 100 cache read.
const PRICED = [HEADER('sess-live'), ASSISTANT('m1', '2026-06-15T12:00:00.000Z', 'deepseek-v4-flash', {
  inputTokens: 1150, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50,
})];

test('the live line paints a running estimate when the session has usage', { skip: skipReason }, (t) => {
  const { statuses, widgets, trace } = runLive(t, { lines: PRICED });
  assert.ok(statuses.length >= 1, 'the line must paint at registration');
  const line = statuses[0];
  assert.match(line, /session-cost/);
  assert.match(line, /\$0\.0005/, 'the same arithmetic the report uses: 1000 fresh input, not 1150');
  assert.match(line, /1 calls/);
  assert.match(line, /1\.6K tok/, 'the prompt total of 1650: 1000 fresh input + 500 output + 100 read + 50 write');
  assert.match(line, /deepseek-v4-flash/);
  // The TUI prints footer text verbatim and collapses whitespace, so the line is one row.
  assert.doesNotMatch(line, /[\n\t]/, 'a footer line carries no newline or tab');
  // Styling is the line's own: dim brand, bold figure, a magnitude colour.
  assert.match(line, /\u001b\[2m/, 'the brand and separators are dim');
  assert.match(line, /\u001b\[1m/, 'the figure is bold');
  assert.match(line, /\u001b\[3[123]m/, 'the figure is coloured by magnitude');
  assert.deepEqual(widgets, ['above-editor'], 'the above-editor widget is registered once');
  assert.equal(trace[0].count, 1, 'registration paints immediately rather than waiting for an event');
});

test('the footer is throttled to one paint per 800ms, and the run end forces the last one', { skip: skipReason }, (t) => {
  const { trace } = runLive(t, { lines: PRICED });
  const count = (event) => trace.find((entry) => entry.event === event).count;
  assert.equal(count('register'), 1);
  assert.equal(count('run_start'), 1, 'an event moments after registration is inside the throttle window');
  assert.equal(count('tool_completed'), 2, 'past 800ms the next event paints again');
  assert.equal(count('onRunEnd'), 3, 'the run end forces a final paint so the last cost is never withheld');
});

test('a session nothing could price never paints a zero', { skip: skipReason }, (t) => {
  // Principle 1: unknown cost is null, never 0 - and the live view is named in the rule. A trailing
  // marker is not enough when the whole figure is unknown; the line has to say so.
  const { statuses } = runLive(t, {
    lines: [HEADER('sess-live'), ASSISTANT('m1', '2026-06-15T12:00:00.000Z', 'model-not-in-the-mirror', {
      inputTokens: 1000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0,
    })],
  });
  assert.match(statuses[0], /unpriced/, 'the figure is named as unknown');
  assert.doesNotMatch(statuses[0], /\$0\.0/, 'an unpriced running total is never drawn as $0.0000');
});

test('an unpriced call beside a priced one marks the figure instead of hiding the call', { skip: skipReason }, (t) => {
  const { statuses } = runLive(t, {
    lines: [
      ...PRICED,
      ASSISTANT('m2', '2026-06-15T12:01:00.000Z', 'model-not-in-the-mirror', {
        inputTokens: 2000, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0,
      }),
    ],
  });
  assert.match(statuses[0], /\$0\.0005/, 'the priced part of the total is still shown');
  assert.match(statuses[0], /\u001b\[35m\+\u001b\[0m/, 'a magenta + marks a total that excludes unpriced calls');
  assert.match(statuses[0], /2 calls/, 'the call count includes the call it could not price');
});

test('a transcript version the mod does not understand is named, never parsed into zeros', { skip: skipReason }, (t) => {
  const { statuses } = runLive(t, {
    lines: [HEADER('sess-live', 4), ASSISTANT('m1', '2026-06-15T12:00:00.000Z', 'deepseek-v4-flash', {
      inputTokens: 1150, outputTokens: 500, cacheReadTokens: 100, cacheWriteTokens: 50,
    })],
  });
  assert.match(statuses[0], /transcript v4, expected v3/, 'the drift is named with both versions');
  assert.match(statuses[0], /unpriced/);
  assert.doesNotMatch(statuses[0], /\$/, 'a drifted transcript has no figure at all');
});

test('"liveStatus": false turns the line off entirely', { skip: skipReason }, (t) => {
  const { statuses, widgets, trace } = runLive(t, { lines: PRICED, config: { liveStatus: false } });
  assert.deepEqual(statuses, [], 'no footer paint');
  assert.deepEqual(widgets, [], 'no widget registration');
  for (const entry of trace) assert.equal(entry.count, 0, `${entry.event} must not paint when disabled`);
});
