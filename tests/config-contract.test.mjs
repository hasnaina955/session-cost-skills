import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_PRECEDENCE,
  configPaths,
  emptyConfig,
  exportConfig,
  initConfig,
  loadEffectiveConfig,
  migrateConfig,
  readConfigFile,
  readSecretReference,
  validateConfig,
} from '../adapters/mcode/skill/scripts/lib/config.mjs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../contracts/session-config-v1.schema.json', import.meta.url), 'utf8'));
const clineScript = fileURLToPath(new URL('../adapters/cline/skill/scripts/session-cost.mjs', import.meta.url));
const mcodeScript = fileURLToPath(new URL('../adapters/mcode/skill/scripts/session-cost.mjs', import.meta.url));

function writeConfig(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

test('configuration layers merge in deterministic precedence with winning sources', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const cwd = path.join(root, 'project');
  const home = path.join(root, 'home');
  fs.mkdirSync(cwd, { recursive: true });
  const paths = configPaths({ cwd, home, env: {} });
  const user = {
    ...emptyConfig(),
    runtimeDefaults: { provider: 'user-provider', includeChildren: true },
    providers: [{
      id: 'custom',
      driverId: 'commandcode',
      match: { providerIds: ['custom-provider'], runtimes: ['mcode'] },
      endpointEnv: 'CUSTOM_ENDPOINT',
      credentialEnv: 'CUSTOM_TOKEN',
      region: 'us',
      currency: 'USD',
      pricingMode: 'manual',
    }],
    models: [{ runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'Vendor/Alias', rateModel: 'user-model' }],
  };
  const project = {
    ...emptyConfig(),
    providers: [{
      id: 'custom',
      driverId: 'commandcode',
      match: { providerIds: ['custom-provider', 'custom-provider-2'], runtimes: ['mcode'] },
      region: 'eu',
      currency: 'EUR',
    }],
    models: [{ runtime: 'mcode', provider: 'custom-provider', runtimeModel: 'Vendor/Alias', rateModel: 'project-model' }],
  };
  writeConfig(paths.user, user);
  writeConfig(path.join(cwd, '.session-cost.json'), project);

  const effective = loadEffectiveConfig({
    cwd,
    home,
    env: {},
    detected: { includeChildren: true },
    cli: { includeChildren: false, provider: 'cli-provider' },
  });
  const profile = effective.config.providers.find((item) => item.id === 'custom');
  assert.deepEqual(CONFIG_PRECEDENCE, ['cli', 'project', 'user', 'detected-runtime', 'built-in']);
  assert.equal(profile.endpointEnv, 'CUSTOM_ENDPOINT');
  assert.equal(profile.region, 'eu');
  assert.equal(profile.currency, 'EUR');
  assert.equal(profile.match.providerIds.length, 2);
  assert.equal(effective.config.models[0].rateModel, 'project-model');
  assert.equal(effective.selected.provider.source, 'cli');
  assert.equal(effective.selected.includeChildren.source, 'cli');
  assert.equal(effective.profileSources.custom, 'project');
  assert.deepEqual(validateJsonSchema(effective.config, schema), []);
});

test('config init, migration, import, export, and validation are deterministic', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-config-io-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, '.session-cost.json');
  const initialized = initConfig(target);
  assert.equal(initialized.config.schemaVersion, 1);
  assert.equal(readConfigFile(target).config.providers.length, 0);
  assert.equal(exportConfig(initialized.config), fs.readFileSync(target, 'utf8'));
  assert.throws(() => initConfig(target), /already exists/);
  const migrated = migrateConfig({ version: 1, providers: { legacy: { driverId: 'fixture' } }, models: [] });
  assert.equal(migrated.providers[0].id, 'legacy');
  assert.throws(() => validateConfig({ schemaVersion: 2 }), /unsupported/);
});

test('configuration and reports never serialize secret values', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-config-secret-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const invalid = {
    ...emptyConfig(),
    providers: [{
      id: 'unsafe',
      driverId: 'fixture',
      match: { providerIds: ['unsafe'], runtimes: ['mcode'] },
      apiKey: 'literal-secret',
    }],
  };
  assert.throws(() => validateConfig(invalid), /credential reference/);
  assert.equal(readSecretReference('CUSTOM_TOKEN', { env: { CUSTOM_TOKEN: 'runtime-only' } }), 'runtime-only');
  assert.equal(readSecretReference('credential://provider/token', { credentialReader: (name) => `store:${name}` }), 'store:provider/token');
  const exported = exportConfig({
    ...emptyConfig(),
    providers: [{
      id: 'safe',
      driverId: 'fixture',
      match: { providerIds: ['safe'], runtimes: ['mcode'] },
      credentialEnv: 'CUSTOM_TOKEN',
    }],
  });
  assert.equal(exported.includes('literal-secret'), false);
  assert.equal(exported.includes('CUSTOM_TOKEN'), true);
});

test('both CLIs expose safe config init, validate, export, and import actions', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'session-cost-config-cli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projectConfig = path.join(root, '.session-cost.json');
  const importedConfig = path.join(root, 'imported.json');

  for (const script of [mcodeScript, clineScript]) {
    const initialized = spawnSync(process.execPath, [script, '--init-config', '--session-config', projectConfig], { cwd: root, encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    assert.equal(JSON.parse(initialized.stdout).action, 'init');
    fs.rmSync(projectConfig);
  }

  writeConfig(projectConfig, {
    ...emptyConfig(),
    runtimeDefaults: { includeChildren: true },
    providers: [{
      id: 'custom',
      driverId: 'commandcode',
      match: { providerIds: ['custom-provider'], runtimes: ['cline', 'mcode'] },
      credentialEnv: 'CUSTOM_TOKEN',
      endpointEnv: 'CUSTOM_ENDPOINT',
      currency: 'USD',
      pricingMode: 'manual',
    }],
  });
  for (const script of [mcodeScript, clineScript]) {
    const validated = spawnSync(process.execPath, [script, '--validate-config', '--session-config', projectConfig], { cwd: root, encoding: 'utf8' });
    assert.equal(validated.status, 0, validated.stderr);
    const output = JSON.parse(validated.stdout);
    assert.equal(output.action, 'validate');
    assert.equal(output.configuration.selected.includeChildren.source, 'project');
    assert.equal(validated.stdout.includes('literal-secret'), false);
  }

  const imported = spawnSync(process.execPath, [mcodeScript, '--import-config', projectConfig, '--session-config', importedConfig], { cwd: root, encoding: 'utf8' });
  assert.equal(imported.status, 0, imported.stderr);
  assert.equal(JSON.parse(imported.stdout).action, 'import');
  assert.equal(readConfigFile(importedConfig).config.providers[0].credentialEnv, 'CUSTOM_TOKEN');
});
