import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  clineScript,
  createClineFixture,
  createMCodeFixture,
  createOpenCodeFixture,
  mcodeScript,
  opencodeScript,
  runCli,
} from './helpers/contract-fixtures.mjs';

// Every runtime must agree on what a broken standing-summary config means.
//
// The file at `<dataDir>/session-cost.json` carries `includeChildren`, which decides whether
// sub-agent sessions fold into a reported total. A file that exists but cannot be parsed is
// therefore not cosmetic: treating it as empty silently defaults `includeChildren` to false and
// under-reports a task's sub-agent spend. That is a money bug, so all three adapters refuse it.
//
// MCode used to read it as `readJsonFile(configPath) ?? {}`, which conflated "no file" with
// "broken file" and kept going. Cline and OpenCode refused it. The three now behave the same,
// and this test is what stops that drifting apart again.

const RUNTIMES = [
  { id: 'cline', script: clineScript, make: createClineFixture },
  { id: 'mcode', script: mcodeScript, make: createMCodeFixture },
  { id: 'opencode', script: opencodeScript, make: createOpenCodeFixture },
];

/** Runs `fn(dir)` to completion before removing the directory. */
async function withTempDir(fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-config-parity-'));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

function write(dir, name, contents) {
  const file = path.join(dir, name);
  fs.writeFileSync(file, contents, 'utf8');
  return file;
}

for (const { id, script, make } of RUNTIMES) {
  // Exit code 2 is overloaded in this tool: it also means "cost unavailable", which is a
  // legitimate verdict for an unpriceable session. So the tolerated cases assert on the
  // absence of the config error rather than on the exit code, which would otherwise be
  // asserting two unrelated things at once.
  test(`${id}: a config that does not exist is not an error`, () => withTempDir((tmp) => {
    const fixture = make();
    // A named path that does not exist is the common case: the standing summary has not been
    // written yet. It must not block a report.
    const result = runCli(script, fixture.dataDir, ['--config', path.join(tmp, 'absent.json'), '--json'], fixture.environment ?? {});
    assert.doesNotMatch(result.stderr, /invalid config JSON/, 'a missing config is not a broken config');
  }));

  test(`${id}: a config that exists but cannot be parsed is refused`, () => withTempDir((tmp) => {
    const fixture = make();
    const broken = write(tmp, 'broken.json', '{ "includeChildren": true, ');
    const result = runCli(script, fixture.dataDir, ['--config', broken, '--json'], fixture.environment ?? {});
    assert.equal(result.status, 2, 'a config that cannot be parsed must exit 2');
    assert.match(result.stderr, /invalid config JSON/, 'and must say why');
    assert.match(result.stderr, /broken\.json/, 'the message must name the offending file');
  }));

  test(`${id}: a JSON array is not a valid config`, () => withTempDir((tmp) => {
    const fixture = make();
    // An array parses, and `typeof [] === 'object'`, so a naive guard accepts it and it then
    // behaves as an empty config - the same silent under-report one syntax level down.
    const array = write(tmp, 'array.json', '["includeChildren", true]');
    const result = runCli(script, fixture.dataDir, ['--config', array, '--json'], fixture.environment ?? {});
    assert.equal(result.status, 2, 'a JSON array must not be accepted as a config object');
    assert.match(result.stderr, /invalid config JSON/);
  }));

  test(`${id}: a valid config is still honoured`, () => withTempDir((tmp) => {
    const fixture = make();
    const good = write(tmp, 'good.json', JSON.stringify({ includeChildren: false }));
    const result = runCli(script, fixture.dataDir, ['--config', good, '--json'], fixture.environment ?? {});
    assert.doesNotMatch(result.stderr, /invalid config JSON/, 'a valid config must not be rejected');
  }));
}

test('all three runtimes reject a broken config identically', () => withTempDir((tmp) => {
  const broken = write(tmp, 'parity.json', 'not json at all');
  const outcomes = RUNTIMES.map(({ id, script, make }) => {
    const fixture = make();
    const result = runCli(script, fixture.dataDir, ['--config', broken, '--json'], fixture.environment ?? {});
    return { id, status: result.status, refused: /invalid config JSON/.test(result.stderr) };
  });

  for (const outcome of outcomes) {
    assert.equal(outcome.status, 2, `${outcome.id} must exit 2 on a broken config`);
    assert.ok(outcome.refused, `${outcome.id} must name the problem`);
  }
  // The cross-adapter assertion is the point: "all three agree" is exactly the property that
  // drifted, and a per-adapter assertion would not have caught MCode.
  assert.equal(
    new Set(outcomes.map((o) => `${o.status}:${o.refused}`)).size,
    1,
    'the three runtimes must reach the same verdict',
  );
}));
