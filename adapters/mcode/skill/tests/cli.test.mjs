import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const script = path.resolve(here, '..', 'scripts', 'session-cost.mjs');

test('MCode CLI documents parity modes in --help', () => {
  const result = spawnSync(process.execPath, [script, '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0);
  for (const flag of ['--last', '--today', '--compare', '--from', '--to', '--provider', '--model', '--rates', '--config', '--include-children']) {
    assert.match(result.stdout, new RegExp(flag.replace(/[-]/g, '\\-')));
  }
});

test('MCode --rates works without reading the session ledger and emits versioned JSON', () => {
  const result = spawnSync(process.execPath, [script, '--rates', '--json'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.schemaVersion, 1);
  assert.equal(typeof output.rates.refreshedAt, 'string');
  assert.ok(output.rates.providers.commandcode.models > 0);
  assert.ok(output.rates.providers.stepfun.models > 0);
  assert.equal(output.rates.coverage.complete, true);
  assert.ok(output.rates.coverage.providers.commandcode.excludedModels.length > 0);
  assert.ok(output.rates.coverage.providers.stepfun.excludedModels.length > 0);
  assert.ok(output.rates.coverage.providers.commandcode.rateRecords > 0);
  assert.equal(typeof output.rates.coverage.providers.commandcode.effectiveFrom, 'string');
  assert.equal(
    output.rates.coverage.providers.commandcode.excludedModels.length,
    output.rates.coverage.sourceCoverage.commandcode.excludedModels,
  );
  for (const provider of Object.values(output.rates.coverage.providers)) {
    assert.deepEqual(Object.values(provider.components).map((component) => component.complete), [true, true, true, true]);
  }
});

test('MCode rates dashboard writes a self-contained HTML file', () => {
  const out = path.join(os.tmpdir(), `mcode-rates-dashboard-${process.pid}.html`);
  const result = spawnSync(process.execPath, [script, '--rates', '--dashboard', '--out', out], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  const html = fs.readFileSync(out, 'utf8');
  assert.match(html, /MCode Rate Coverage Dashboard/);
  assert.doesNotMatch(html, /<(?:script|link|img)[^>]+(?:src|href)=["']https?:\/\//i);
  fs.rmSync(out, { force: true });
});
