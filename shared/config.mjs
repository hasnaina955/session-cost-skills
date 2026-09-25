import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const SESSION_CONFIG_SCHEMA_VERSION = 1;
export const CONFIG_PRECEDENCE = Object.freeze([
  'cli',
  'project',
  'user',
  'detected-runtime',
  'built-in',
]);

const SECRET_KEYS = new Set(['apiKey', 'secret', 'password', 'token', 'accessToken', 'refreshToken']);
const VALID_PROFILES = new Set(['endpointEnv', 'credentialEnv']);

function clone(value) {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value));
}

function assertSafeObject(value, location = 'config') {
  if (!value || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeObject(item, `${location}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SECRET_KEYS.has(key) && !VALID_PROFILES.has(key)) {
      throw new Error(`${location}.${key} must be a credential reference, not a secret value`);
    }
    assertSafeObject(child, `${location}.${key}`);
  }
}

export function emptyConfig() {
  return { schemaVersion: SESSION_CONFIG_SCHEMA_VERSION, runtimeDefaults: {}, providers: [], models: [] };
}

export function configPaths({ cwd = process.cwd(), env = process.env, home = os.homedir() } = {}) {
  const xdg = env.XDG_CONFIG_HOME ? path.resolve(env.XDG_CONFIG_HOME) : path.join(home, '.config');
  return {
    project: path.join(cwd, '.session-cost.json'),
    user: process.platform === 'win32'
      ? path.join(env.APPDATA ?? path.join(home, 'AppData', 'Roaming'), 'session-cost', 'config.json')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'session-cost', 'config.json')
        : path.join(xdg, 'session-cost', 'config.json'),
  };
}

export function migrateConfig(raw) {
  if (raw?.schemaVersion === SESSION_CONFIG_SCHEMA_VERSION) return raw;
  if (raw?.providers && !Array.isArray(raw.providers)) {
    return {
      schemaVersion: 1,
      runtimeDefaults: raw.runtimeDefaults ?? {},
      providers: Object.entries(raw.providers).map(([id, value]) => ({ id, ...value })),
      models: raw.models ?? [],
    };
  }
  if (raw?.version === 1 && !raw.schemaVersion) return { ...raw, schemaVersion: 1 };
  throw new Error('unsupported or missing session-cost config schemaVersion');
}

export function validateConfig(config) {
  const migrated = migrateConfig(config);
  assertSafeObject(migrated);
  if (migrated.schemaVersion !== SESSION_CONFIG_SCHEMA_VERSION) throw new Error('config schemaVersion must be 1');
  if (!Array.isArray(migrated.providers) || !Array.isArray(migrated.models)) throw new Error('config providers and models must be arrays');
  const providerIds = new Set();
  for (const provider of migrated.providers) {
    if (!provider?.id || providerIds.has(provider.id)) throw new Error(`config provider ids must be unique: ${provider?.id ?? 'missing'}`);
    providerIds.add(provider.id);
    if (!provider.driverId || !Array.isArray(provider.match?.providerIds) || !Array.isArray(provider.match?.runtimes)) {
      throw new Error(`provider profile ${provider.id} requires driverId, match.providerIds, and match.runtimes`);
    }
    if (provider.currency && !/^[A-Z]{3}$/.test(provider.currency)) throw new Error(`provider profile ${provider.id} has invalid currency`);
    for (const card of provider.rateCards ?? []) {
      if (!card.model || !Number.isFinite(Date.parse(card.effectiveFrom))) throw new Error(`provider profile ${provider.id} has an invalid manual rate card`);
      for (const component of ['input', 'output', 'cacheRead', 'cacheWrite']) {
        if (!Number.isFinite(card[component]) || card[component] < 0) throw new Error(`provider profile ${provider.id} rate card is missing ${component}`);
      }
    }
    for (const record of provider.importedRateRecords ?? []) {
      if (!record.model || !['input', 'output', 'cacheRead', 'cacheWrite'].includes(record.component) || !Number.isFinite(record.amount) || record.amount < 0) {
        throw new Error(`provider profile ${provider.id} has an invalid imported rate record`);
      }
    }
  }
  const modelKeys = new Set();
  for (const model of migrated.models) {
    const key = `${model.runtime}:${model.provider}:${model.runtimeModel}`;
    if (modelKeys.has(key)) throw new Error(`config model mappings must be unique: ${key}`);
    modelKeys.add(key);
  }
  return migrated;
}

export function readConfigFile(filePath) {
  if (!filePath || !fs.existsSync(filePath)) return null;
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''));
  } catch (error) {
    throw new Error(`could not parse config ${filePath}: ${error.message}`);
  }
  return { path: filePath, config: validateConfig(raw) };
}

function mergeNamedArray(base, incoming, keyFor, mergeObject = false) {
  const merged = new Map();
  for (const item of base ?? []) merged.set(keyFor(item), item);
  for (const item of incoming ?? []) {
    const key = keyFor(item);
    const previous = merged.get(key);
    merged.set(key, mergeObject && previous ? {
      ...previous,
      ...item,
      ...(previous.match || item.match ? { match: { ...previous.match, ...item.match } } : {}),
    } : item);
  }
  return [...merged.values()];
}

export function mergeConfigLayers(layers) {
  const effective = emptyConfig();
  const sources = {};
  for (const layer of layers) {
    if (!layer) continue;
    const config = validateConfig(layer.config);
    Object.assign(effective.runtimeDefaults, config.runtimeDefaults ?? {});
    effective.providers = mergeNamedArray(effective.providers, config.providers, (item) => item.id, true);
    effective.models = mergeNamedArray(effective.models, config.models, (item) => `${item.runtime}:${item.provider}:${item.runtimeModel}`);
    sources[layer.source] = { path: layer.path ?? null, merged: true };
  }
  return { config: effective, sources, layers: layers.filter(Boolean) };
}

export function loadEffectiveConfig({ cwd = process.cwd(), env = process.env, home = os.homedir(), cli = {}, detected = {}, configPath = null, builtIn = emptyConfig() } = {}) {
  const paths = configPaths({ cwd, env, home });
  const layers = [{ source: 'built-in', config: builtIn, path: null }];
  if (detected && Object.keys(detected).length) layers.push({ source: 'detected-runtime', config: { ...emptyConfig(), runtimeDefaults: detected }, path: null });
  const user = readConfigFile(paths.user);
  if (user) layers.push({ source: 'user', ...user });
  const project = readConfigFile(configPath ?? paths.project);
  if (project) layers.push({ source: 'project', ...project });
  layers.push({
    source: 'cli',
    path: null,
    config: { ...emptyConfig(), runtimeDefaults: Object.fromEntries(Object.entries(cli).filter(([, value]) => value !== undefined && value !== null)) },
  });
  const ordered = layers;
  const merged = mergeConfigLayers(ordered);
  const effective = merged.config;
  const selected = Object.fromEntries(Object.entries(effective.runtimeDefaults).map(([key, value]) => [key, { value, source: findWinningSource(ordered, key, value) }]));
  const profileSources = {};
  for (const layer of ordered) {
    for (const profile of layer.config?.providers ?? []) profileSources[profile.id] = layer.source;
    for (const mapping of layer.config?.models ?? []) profileSources[`${mapping.runtime}:${mapping.provider}:${mapping.runtimeModel}`] = layer.source;
  }
  return { config: effective, sources: merged.sources, profileSources, selected, paths, layers: ordered };
}

function findWinningSource(layers, key, value) {
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    if (layer.config?.runtimeDefaults?.[key] === value) return layer.source;
  }
  return 'built-in';
}

export function publicConfigResult(effective) {
  return {
    config: effective.config,
    selected: effective.selected,
    profileSources: effective.profileSources,
    sources: effective.sources,
    paths: effective.paths,
  };
}

export function initConfig(targetPath, { overwrite = false } = {}) {
  if (fs.existsSync(targetPath) && !overwrite) throw new Error(`config already exists: ${targetPath}`);
  const config = emptyConfig();
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, JSON.stringify(config, null, 2) + '\n', { encoding: 'utf8', flag: overwrite ? 'w' : 'wx' });
  return { path: targetPath, config };
}

export function exportConfig(config) {
  return JSON.stringify(validateConfig(config), null, 2) + '\n';
}

export function importConfig(sourcePath, targetPath, { overwrite = false } = {}) {
  const imported = readConfigFile(sourcePath);
  if (!imported) throw new Error(`config import source does not exist: ${sourcePath}`);
  if (fs.existsSync(targetPath) && !overwrite) throw new Error(`config already exists: ${targetPath}`);
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, exportConfig(imported.config), 'utf8');
  return { path: targetPath, config: imported.config, sourcePath };
}

export function readSecretReference(reference, { env = process.env, credentialReader = null } = {}) {
  if (!reference) return null;
  if (typeof reference !== 'string') throw new Error('secret reference must be a string');
  if (reference.startsWith('credential://')) {
    const name = reference.slice('credential://'.length);
    if (typeof credentialReader !== 'function') throw new Error(`credential store lookup unavailable for ${name}`);
    return credentialReader(name);
  }
  if (!/^[A-Z][A-Z0-9_]*$/.test(reference)) throw new Error(`invalid environment secret reference: ${reference}`);
  return env[reference] ?? null;
}
