import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  discoverModels,
  doctorReport,
  explainModelMatch,
  explainProviderMatch,
  renderDiagnostics,
} from '../adapters/mcode/skill/scripts/lib/provider-diagnostics.mjs';
import { readRateTable } from '../adapters/mcode/skill/scripts/lib/rates.mjs';

const table = readRateTable(new URL('../adapters/mcode/skill/references/provider-rates.json', import.meta.url));
const clineScript = fileURLToPath(new URL('../adapters/cline/skill/scripts/session-cost.mjs', import.meta.url));
const mcodeScript = fileURLToPath(new URL('../adapters/mcode/skill/scripts/session-cost.mjs', import.meta.url));
const knownModels = Object.fromEntries(Object.entries(table.providers).map(([id, provider]) => [id, Object.keys(provider.models)]));
const configuration = {
  providers: [{
    id: 'custom-commandcode',
    driverId: 'commandcode',
    match: { providerIds: ['custom-provider'], runtimes: ['mcode', 'cline'] },
  }],
  models: [
    { runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'Vendor/Exact Alias', rateModel: 'qwen-3.7-plus' },
    { runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'vendor/glob-*', rateModel: 'qwen-3.7-plus' },
  ],
};

test('provider diagnostics explain exact, alias, normalized, glob, and unknown rules', () => {
  const known = knownModels.commandcode;
  const exact = explainModelMatch({ runtimeId: 'mcode', providerId: 'commandcode', modelId: 'qwen-3.7-plus', configuration: {}, knownModelIds: known, rateRecords: table.providers.commandcode.rateRecords });
  assert.equal(exact.status, 'matched');
  assert.equal(exact.rule, 'exact-rate-model');
  assert.equal(exact.coverage, 'complete');

  const alias = explainModelMatch({ runtimeId: 'mcode', providerId: 'custom-provider', modelId: 'Vendor/Exact Alias', configuration, knownModelIds: known, rateRecords: table.providers.commandcode.rateRecords });
  assert.equal(alias.rule, 'exact-alias');
  assert.equal(alias.resolvedModel, 'qwen-3.7-plus');

  const normalized = explainModelMatch({ runtimeId: 'mcode', providerId: 'custom-provider', modelId: 'vendor/glob-long', configuration, knownModelIds: known });
  assert.equal(normalized.rule, 'glob-alias');

  const unknown = explainModelMatch({ runtimeId: 'mcode', providerId: 'custom-provider', modelId: 'qwen-3.7-plu', configuration, knownModelIds: known });
  assert.equal(unknown.status, 'unknown');
  assert.ok(unknown.suggestions.length > 0);
  assert.ok(unknown.suggestions.every((suggestion) => suggestion.rule === 'suggestion-only'));
});

test('normalized model collisions are reported as ambiguous and never selected', () => {
  const collision = explainModelMatch({
    runtimeId: 'mcode',
    providerId: 'commandcode',
    modelId: 'same/model',
    configuration: {},
    knownModelIds: ['vendor/model', 'model'],
    rateRecords: [],
  });
  assert.equal(collision.status, 'ambiguous');
  assert.equal(collision.resolvedModel, null);
  assert.deepEqual(collision.candidates, ['vendor/model', 'model']);
});

test('doctor, provider discovery, and rendered diagnostics are secret-safe', () => {
  const report = doctorReport({
    configuration: { ...configuration, sources: { project: { path: '.session-cost.json' } }, profileSources: { 'custom-commandcode': 'project' } },
    runtimeId: 'mcode',
    providerId: 'custom-provider',
    modelId: 'Vendor/Exact Alias',
    knownModelIds: knownModels.commandcode,
    rateRecords: table.providers.commandcode.rateRecords,
  });
  assert.equal(report.providers.some((provider) => provider.id === 'custom-commandcode'), true);
  assert.equal(report.warnings.length, 0);
  const rendered = renderDiagnostics({ ...report, action: 'doctor' });
  assert.match(rendered, /runtime: mcode/);
  const models = discoverModels({ configuration, runtimeId: 'mcode', knownModels: { ...knownModels, 'custom-commandcode': knownModels.commandcode } });
  assert.ok(models.find((entry) => entry.provider === 'custom-commandcode').models.length > 0);
  const json = JSON.stringify(report);
  assert.equal(json.includes('CUSTOM_TOKEN'), false);
  assert.equal(json.includes('accessToken'), false);
});

test('both CLIs expose doctor, providers, models discover, and config explain', () => {
  for (const script of [clineScript, mcodeScript]) {
    const doctor = spawnSync(process.execPath, [script, 'doctor', '--json'], { encoding: 'utf8' });
    assert.equal(doctor.status, 0, doctor.stderr);
    assert.equal(JSON.parse(doctor.stdout).runtime, script === clineScript ? 'cline' : 'mcode');

    const providers = spawnSync(process.execPath, [script, 'providers', '--json'], { encoding: 'utf8' });
    assert.equal(providers.status, 0, providers.stderr);
    assert.ok(JSON.parse(providers.stdout).providers.length >= 2);
  }

  const models = spawnSync(process.execPath, [mcodeScript, 'models', 'discover', '--provider', 'commandcode', '--json'], { encoding: 'utf8' });
  assert.equal(models.status, 0, models.stderr);
  assert.ok(JSON.parse(models.stdout).models[0].models.length > 0);

  const explained = spawnSync(process.execPath, [mcodeScript, 'config', 'explain', '--provider', 'commandcode', '--model', 'qwen-3.7-plus', '--json'], { encoding: 'utf8' });
  assert.equal(explained.status, 0, explained.stderr);
  const output = JSON.parse(explained.stdout);
  assert.equal(output.explanation.rule, 'exact-rate-model');
  assert.equal(output.explanation.coverage, 'complete');

  const unknown = spawnSync(process.execPath, [mcodeScript, 'config', 'explain', '--provider', 'commandcode', '--model', 'qwen-3.7-plu', '--json'], { encoding: 'utf8' });
  assert.equal(unknown.status, 2);
  assert.equal(JSON.parse(unknown.stdout).explanation.status, 'unknown');
  assert.ok(JSON.parse(unknown.stdout).explanation.suggestions.length > 0);
});
