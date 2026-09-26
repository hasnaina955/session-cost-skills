import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import {
  RATE_PARSER_VERSION,
  RATES_SOURCE,
  SOURCE_PARSER_VERSION,
  calculateTokenCost,
  inspectRateTable,
  parseCommandCodeRates,
  parseStepFunRates,
  prepareProviderRates,
  ratesForBand,
  readRateTable,
  refreshRateTable,
  resolveRate,
  validateRateTable,
} from '../scripts/lib/rates.mjs';

function commandModel(overrides = {}) {
  return {
    id: 'vendor/current-model',
    name: 'Current Model',
    category: 'opensource',
    provider: 'Vendor',
    inputCost: 1,
    outputCost: 2,
    cacheReadCost: 0.1,
    cacheWriteCost: 0.25,
    planBudgetUsd: {},
    ...overrides,
  };
}

function renderedRow(name, { input = '$1.00', output = '$2.00', cacheRead = '$0.10', cacheWrite = '$0.25' } = {}) {
  const cell = (value, extra = '') => `<div class="px-2 py-3 ${extra}">${value}</div>`;
  return `<div class="grid" role="row"><div class="model">${name}</div>${cell('1M')}${cell(input)}${cell(output)}${cell(cacheRead)}${cell(cacheWrite)}<div class="caps">caps</div></div>`;
}

function commandCodeHtml(models, rows = '') {
  const flights = models.map((model) => (
    `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(model))}])</script>`
  )).join('');
  return `<!doctype html><table>${rows}</table>${flights}`;
}

function stepFunMarkdown() {
  return [
    '| Model | Billing unit | Input (cache miss) | Input (cache hit) | Output |',
    '| --- | --- | --- | --- | --- |',
    '| `step-5-preview` | 1M tokens | \\$1.00 | \\$0.05 | \\$2.70 |',
    '| `step-3.7-flash` | 1M tokens | \\$0.20 | \\$0.04 | \\$1.15 |',
    '',
  ].join('\n');
}

function completeStepFunMarkdown() {
  return stepFunMarkdown().replace(/^\| `step-3\.7-flash`.*\n/m, '');
}

function validTable() {
  const refreshedAt = '2026-01-01T00:00:00.000Z';
  const commandcode = prepareProviderRates('commandcode', {
    'vendor/current-model': {
      name: 'Current Model',
      provider: 'Vendor',
      category: 'opensource',
      input: 1,
      output: 2,
      cacheRead: 0.1,
      cacheWrite: 0.25,
      cacheWriteSource: 'commandcode-model',
      sourceAmounts: { input: '1', output: '2', cacheRead: '0.1', cacheWrite: '0.25' },
    },
  }, { refreshedAt });
  const stepfun = prepareProviderRates('stepfun', {
    'step-5-preview': {
      name: 'step-5-preview',
      provider: 'stepfun',
      category: 'stepfun-docs',
      input: 1,
      output: 2.7,
      cacheRead: 0.05,
      cacheWrite: 1,
      cacheWriteSource: 'stepfun-cache-miss-policy',
      sourceAmounts: { input: '1', output: '2.7', cacheRead: '0.05', cacheWrite: '1' },
    },
  }, { refreshedAt });
  return {
    _meta: {
      parserVersion: RATE_PARSER_VERSION,
      sourceParserVersion: { ...SOURCE_PARSER_VERSION },
      currency: 'USD',
      unit: 'per 1M tokens',
      refreshedAt,
      history: [{ versionId: refreshedAt, parserVersion: RATE_PARSER_VERSION }],
      sourceCoverage: {
        commandcode: { sourceModels: 1, publishedModels: 1, excludedModels: 0 },
        stepfun: { sourceModels: 1, publishedModels: 1, excludedModels: 0 },
      },
    },
    providers: {
      commandcode: { source: RATES_SOURCE.commandcode, fetchedAt: refreshedAt, ...commandcode },
      stepfun: { source: RATES_SOURCE.stepfun, fetchedAt: refreshedAt, ...stepfun },
    },
    freeModels: [],
    aliases: {},
  };
}

test('CommandCode current rates parse nonzero cache writes and produce the expected cost', () => {
  const raw = commandModel();
  const models = parseCommandCodeRates(commandCodeHtml([raw], renderedRow('Current Model')));
  const model = models[raw.id];

  assert.equal(model.cacheWrite, 0.25);
  assert.equal(model.cacheWriteSource, 'commandcode-model');
  assert.deepEqual(ratesForBand(model), {
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0.25,
  });
  assert.deepEqual(calculateTokenCost({ cacheWriteTokens: 1_000_000 }, model), {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0.25,
  });
  assert.equal(calculateTokenCost({ cacheWriteTokens: 4_000_000 }, model).cacheWrite, 1);
});

test('CommandCode rendered rows support non-1M context windows and promo badges', () => {
  const { cacheWriteCost: _omitted, ...withoutCacheWrite } = commandModel({ name: 'Alternate Context Model' });
  const alternateContext = parseCommandCodeRates(commandCodeHtml(
    [withoutCacheWrite],
    renderedRow('Alternate Context Model', { cacheWrite: '—' }).replace('1M', '200K'),
  ))[withoutCacheWrite.id];
  assert.equal(alternateContext.cacheWrite, 0);
  assert.equal(alternateContext.cacheWriteSource, 'commandcode-no-charge');

  const promo = parseCommandCodeRates(commandCodeHtml(
    [withoutCacheWrite],
    renderedRow('Alternate Context Model', { input: '$0.60$0.30', cacheWrite: '—' })
      .replace('>Alternate Context Model<', '>Alternate Context Model-50%<'),
  ))[withoutCacheWrite.id];
  assert.equal(promo.cacheWrite, 0);
  assert.equal(promo.cacheWriteSource, 'commandcode-no-charge');
  assert.equal(promo.input, 1);
});

test('the bundled CommandCode catalog priceable includes the MiniMax flagship', () => {
  const table = readRateTable(fileURLToPath(new URL('../references/provider-rates.json', import.meta.url)));

  // These counts used to be asserted as exact integers (79/78/1). That made the test a
  // tripwire on a third party's publishing schedule: CommandCode added an 80th model and a
  // perfectly correct `--refresh-rates` turned the suite red, teaching the next person that
  // refreshing rates is a test failure. The counts are data, not behaviour. What has to hold is
  // that the coverage block is internally consistent and that the flagship is inside the
  // priceable set — which is what the test's name actually claims.
  const coverage = table._meta.sourceCoverage.commandcode;
  assert.ok(coverage.sourceModels > 0, 'the source must have contributed at least one model');
  assert.equal(
    coverage.publishedModels + coverage.excludedModels,
    coverage.sourceModels,
    'every source model must be either published or excluded, never lost',
  );

  const commandcode = table.providers.commandcode;
  const excluded = commandcode.excludedModelIds ?? [];
  const flagship = commandcode.models['minimax-m3'];
  assert.ok(flagship, 'the MiniMax flagship must be present in the bundled catalog');
  assert.ok(
    !excluded.includes('minimax-m3'),
    'the flagship must be priceable, not one of the excluded incomplete models',
  );

  const resolved = resolveRate(table, 'commandcode', 'minimax-m3', {
    at: '2026-09-26T00:00:00Z',
    contextTokens: 1_000,
  });
  assert.equal(resolved.rate.cacheWrite, 0);
  assert.equal(resolved.rate.input, 0.3);
  assert.equal(resolved.coverage, 'complete');
});

test('an explicit CommandCode no-charge marker is zero while a missing component stays unknown', () => {
  const { cacheWriteCost: _omitted, ...withoutCacheWrite } = commandModel();
  const explicitFree = parseCommandCodeRates(commandCodeHtml(
    [withoutCacheWrite],
    renderedRow('Current Model', { cacheWrite: '—' }),
  ))[withoutCacheWrite.id];
  assert.equal(explicitFree.cacheWrite, 0);
  assert.equal(explicitFree.cacheWriteSource, 'commandcode-no-charge');
  assert.equal(calculateTokenCost({ cacheWriteTokens: 1_000_000 }, explicitFree).cacheWrite, 0);

  const missing = parseCommandCodeRates(commandCodeHtml([withoutCacheWrite]))[withoutCacheWrite.id];
  assert.equal(missing.cacheWrite, null);
  const table = validTable();
  table.providers.commandcode.models = { [withoutCacheWrite.id]: missing };
  table.providers.commandcode.rateRecords = [];
  assert.equal(resolveRate(table, 'commandcode', withoutCacheWrite.id).rate, null);
  const coverage = inspectRateTable(table);
  assert.equal(coverage.providers.commandcode.components.cacheWrite.complete, false);
  assert.deepEqual(coverage.providers.commandcode.components.cacheWrite.incompleteModels, [withoutCacheWrite.id]);
  assert.throws(() => validateRateTable(table), /missing cacheWrite/);
});

test('StepFun current and historical rows expose only the documented cache-write rate', () => {
  const models = parseStepFunRates(stepFunMarkdown());
  assert.equal(models['step-5-preview'].cacheWrite, 1);
  assert.equal(models['step-5-preview'].cacheWriteSource, 'stepfun-cache-miss-policy');
  assert.equal(models['step-3.7-flash'].cacheWrite, null);
  assert.equal(models['step-3.7-flash'].cacheWriteSource, null);
  assert.equal(calculateTokenCost({ cacheWriteTokens: 500_000 }, models['step-5-preview']).cacheWrite, 0.5);

  const table = validTable();
  table.providers.stepfun.models = { 'step-5-preview': models['step-5-preview'] };
  table.providers.stepfun.excludedModelIds = ['step-3.7-flash'];
  table._meta.sourceCoverage.stepfun = { sourceModels: 2, publishedModels: 1, excludedModels: 1 };
  assert.doesNotThrow(() => validateRateTable(table));
  assert.equal(resolveRate(table, 'stepfun', 'step-3.7-flash').rate, null);
});

test('CommandCode historical peak and off-peak cards require every band component', () => {
  const raw = commandModel({
    id: 'vendor/historical-model',
    name: 'Historical Model',
    timeOfDay: {
      effective: '2025-01-01T00:00:00.000Z',
      windows: '01-04 UTC',
      peak: { inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0.5 },
      offPeak: { inputCost: 1, outputCost: 2, cacheReadCost: 0.1, cacheWriteCost: 0.25 },
    },
  });
  const model = parseCommandCodeRates(commandCodeHtml([raw], renderedRow('Historical Model')))[raw.id];
  assert.equal(ratesForBand(model, 'peak').cacheWrite, 0.5);
  assert.equal(ratesForBand(model, 'offPeak').cacheWrite, 0.25);
  assert.equal(model.timeOfDay.effective, '2025-01-01T00:00:00.000Z');

  const prepared = prepareProviderRates('commandcode', { [raw.id]: model }, { refreshedAt: '2025-02-01T00:00:00.000Z' });
  assert.equal(prepared.rateRecords.length, 8);
  assert.equal(prepared.rateRecords.every((record) => record.effectiveFrom === '2025-01-01T00:00:00.000Z'), true);
  const table = validTable();
  table.providers.commandcode.models = prepared.models;
  table.providers.commandcode.rateRecords = prepared.rateRecords;
  assert.doesNotThrow(() => validateRateTable(table));
  const peak = resolveRate(table, 'commandcode', raw.id, {
    at: '2025-01-02T00:00:00.000Z',
    contextTokens: 1_000,
    band: 'peak',
  });
  assert.equal(peak.rate.input, 2);
  assert.equal(peak.rate.cacheWrite, 0.5);
  const incomplete = { ...model, timeOfDay: { ...model.timeOfDay, offPeak: null } };
  const incompletePrepared = prepareProviderRates(
    'commandcode',
    { [raw.id]: incomplete },
    { refreshedAt: '2025-02-01T00:00:00.000Z' },
  );
  assert.deepEqual(incompletePrepared.models, {});
  assert.match(incompletePrepared.excludedModelReasons[raw.id], /peak or offPeak/);
});


test('CommandCode duplicate IDs fail and context tiers select by call context', () => {
  const raw = commandModel();
  assert.throws(
    () => parseCommandCodeRates(commandCodeHtml([raw, { ...raw }])),
    /duplicate model id/,
  );

  const tiered = commandModel({
    id: 'vendor/tiered-model',
    contextTiers: [
      { maxContext: 200_000, inputCost: 2, outputCost: 4, cacheReadCost: 0.2, cacheWriteCost: 0.5 },
      { inputCost: 3, outputCost: 6, cacheReadCost: 0.3, cacheWriteCost: 0.75 },
    ],
  });
  const models = parseCommandCodeRates(commandCodeHtml([tiered], renderedRow('Current Model')));
  const prepared = prepareProviderRates('commandcode', models, { refreshedAt: '2026-02-01T00:00:00.000Z' });
  const table = validTable();
  table.providers.commandcode.models = prepared.models;
  table.providers.commandcode.rateRecords = prepared.rateRecords;
  assert.doesNotThrow(() => validateRateTable(table));
  const firstTier = resolveRate(table, 'commandcode', tiered.id, {
    at: '2026-02-02T00:00:00.000Z',
    contextTokens: 200_000,
  });
  const secondTier = resolveRate(table, 'commandcode', tiered.id, {
    at: '2026-02-02T00:00:00.000Z',
    contextTokens: 200_001,
  });
  assert.equal(firstTier.rate.input, 2);
  assert.equal(firstTier.rate.cacheWrite, 0.5);
  assert.equal(secondTier.rate.input, 3);
  assert.equal(secondTier.rate.cacheWrite, 0.75);
  assert.deepEqual(firstTier.rate.rateRecords[0].context, { minTokens: 0, maxTokens: 200_000 });
  assert.deepEqual(secondTier.rate.rateRecords[0].context, { minTokens: 200_001, maxTokens: null });

  const incomplete = commandModel({
    id: 'vendor/incomplete-tier',
    contextTiers: [{ maxContext: 100_000, inputCost: 2 }],
  });
  const incompletePrepared = prepareProviderRates(
    'commandcode',
    parseCommandCodeRates(commandCodeHtml([incomplete], renderedRow('Current Model'))),
    { refreshedAt: '2026-02-01T00:00:00.000Z' },
  );
  assert.deepEqual(incompletePrepared.models, {});
  assert.deepEqual(incompletePrepared.excludedModelIds, ['vendor/incomplete-tier']);
});

test('expiring promotions are represented and do not reprice later calls', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-rate-promotion-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ratesPath = path.join(directory, 'provider-rates.json');
  const promotionModel = {
    name: 'Current Model',
    provider: 'Vendor',
    category: 'opensource',
    input: 1,
    output: 2,
    cacheRead: 0.1,
    cacheWrite: 0.25,
    cacheWriteSource: 'commandcode-model',
    endsWhen: '2026-03-01T00:00:00.000Z',
  };
  const promotion = prepareProviderRates('commandcode', {
    'vendor/current-model': promotionModel,
  }, { refreshedAt: '2026-02-01T00:00:00.000Z' });
  const table = validTable();
  table.providers.commandcode.models = promotion.models;
  table.providers.commandcode.rateRecords = promotion.rateRecords;
  validateRateTable(table);
  fs.writeFileSync(ratesPath, JSON.stringify(table, null, 2) + '\n', 'utf8');

  assert.equal(resolveRate(table, 'commandcode', 'vendor/current-model', {
    at: '2026-02-15T00:00:00.000Z',
  }).rate.input, 1);
  assert.equal(resolveRate(table, 'commandcode', 'vendor/current-model', {
    at: '2026-03-15T00:00:00.000Z',
  }).rate, null);
  assert.equal(promotion.rateRecords[0].effectiveThrough, '2026-03-01T00:00:00.000Z');

  const refreshed = await refreshRateTable({
    ratesPath,
    refreshedAt: '2026-03-01T00:00:00.000Z',
    fetchImpl: async (_url, providerKey) => (
      providerKey === 'commandcode' ? commandCodeHtml([commandModel({ inputCost: 1.75 })]) : completeStepFunMarkdown()
    ),
  });
  assert.equal(resolveRate(refreshed, 'commandcode', 'vendor/current-model', {
    at: '2026-03-15T00:00:00.000Z',
  }).rate.input, 1.75);
  assert.equal(promotion.rateRecords[0].effectiveThrough, '2026-03-01T00:00:00.000Z');
});

test('rate table loading rejects parser-version drift', () => {
  const table = validTable();
  table._meta.parserVersion = RATE_PARSER_VERSION - 1;
  assert.throws(() => validateRateTable(table), /parserVersion must be/);
});

test('refresh validates both providers and atomically publishes a complete table', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-rates-refresh-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ratesPath = path.join(directory, 'provider-rates.json');
  fs.writeFileSync(ratesPath, JSON.stringify(validTable(), null, 2) + '\n', 'utf8');

  const commandHtml = commandCodeHtml([commandModel()]);
  const refreshed = await refreshRateTable({
    ratesPath,
    refreshedAt: '2026-02-01T00:00:00.000Z',
    fetchImpl: async (_url, providerKey) => (
      providerKey === 'commandcode' ? commandHtml : completeStepFunMarkdown()
    ),
  });

  assert.equal(refreshed.providers.commandcode.models['vendor/current-model'].cacheWrite, 0.25);
  assert.equal(refreshed.providers.stepfun.models['step-5-preview'].cacheWrite, 1);
  assert.equal(readRateTable(ratesPath)._meta.parserVersion, RATE_PARSER_VERSION);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('refresh preserves immutable history and selects rates by call timestamp', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-rate-history-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ratesPath = path.join(directory, 'provider-rates.json');
  fs.writeFileSync(ratesPath, JSON.stringify(validTable(), null, 2) + '\n', 'utf8');

  const fetchImpl = async (_url, providerKey) => (
    providerKey === 'commandcode' ? commandCodeHtml([commandModel()]) : completeStepFunMarkdown()
  );
  const february = await refreshRateTable({
    ratesPath,
    refreshedAt: '2026-02-01T00:00:00.000Z',
    fetchImpl,
  });
  const firstFingerprint = february.providers.commandcode.rateRecords[0].fingerprint;
  const march = await refreshRateTable({
    ratesPath,
    refreshedAt: '2026-03-01T00:00:00.000Z',
    fetchImpl: async (url, providerKey) => (
      providerKey === 'commandcode'
        ? commandCodeHtml([commandModel({ inputCost: 1.5, outputCost: 3, cacheReadCost: 0.15, cacheWriteCost: 0.5 })])
        : completeStepFunMarkdown()
    ),
  });

  assert.equal(resolveRate(march, 'commandcode', 'vendor/current-model', {
    at: '2025-12-31T00:00:00.000Z',
  }).rate, null);
  assert.equal(resolveRate(march, 'commandcode', 'vendor/current-model', {
    at: '2026-01-15T00:00:00.000Z',
  }).rate.input, 1);
  assert.equal(resolveRate(march, 'commandcode', 'vendor/current-model', {
    at: '2026-02-15T00:00:00.000Z',
  }).rate.input, 1);
  assert.equal(resolveRate(march, 'commandcode', 'vendor/current-model', {
    at: '2026-03-15T00:00:00.000Z',
  }).rate.input, 1.5);
  assert.equal(march.providers.commandcode.rateRecords.length, 12);
  assert.equal(march._meta.history.length, 3);
  assert.equal(march.providers.commandcode.rateRecords[0].fingerprint, firstFingerprint);
  assert.equal(march.providers.commandcode.rateRecords[0].effectiveThrough, '2026-02-01T00:00:00.000Z');
});

test('an incomplete refresh fails loudly and preserves the last valid table byte-for-byte', async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-rates-invalid-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const ratesPath = path.join(directory, 'provider-rates.json');
  const previous = JSON.stringify(validTable(), null, 2) + '\n';
  fs.writeFileSync(ratesPath, previous, 'utf8');

  const { cacheWriteCost: _omitted, ...incompleteCommandCodeModel } = commandModel();
  await assert.rejects(
    () => refreshRateTable({
      ratesPath,
      refreshedAt: '2026-02-01T00:00:00.000Z',
      fetchImpl: async (_url, providerKey) => (
        providerKey === 'commandcode'
          ? commandCodeHtml([incompleteCommandCodeModel])
          : stepFunMarkdown()
      ),
    }),
    /incomplete .*cacheWrite/,
  );

  assert.equal(fs.readFileSync(ratesPath, 'utf8'), previous);
  assert.deepEqual(
    fs.readdirSync(directory).filter((name) => name.endsWith('.tmp')),
    [],
  );
});

test('MCode CLI reports a nonzero CommandCode cache-write cost end to end', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'mcode-cache-write-cli-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const sqliteDirectory = path.join(directory, 'v2', 'sqlite');
  const historyDirectory = path.join(directory, 'v2', 'sessions', 'session-1');
  fs.mkdirSync(sqliteDirectory, { recursive: true });
  fs.mkdirSync(historyDirectory, { recursive: true });

  const database = new DatabaseSync(path.join(sqliteDirectory, 'runtime-state.sqlite'));
  database.exec(`
    CREATE TABLE local_runtime_sessions (
      session_id TEXT PRIMARY KEY,
      agent_name TEXT,
      title TEXT,
      parent_session_id TEXT,
      history_relative_dir TEXT
    );
    CREATE TABLE local_runtime_token_usage (
      id INTEGER PRIMARY KEY,
      session_id TEXT,
      agent_name TEXT,
      turn_id TEXT,
      ts INTEGER,
      input_tokens INTEGER,
      output_tokens INTEGER,
      reasoning_tokens INTEGER,
      cache_read_tokens INTEGER,
      cache_write_tokens INTEGER
    );
  `);
  const timestamp = Date.parse('2026-02-01T00:00:00.000Z');
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)').run(
    'mvs_test',
    'agent',
    'Cache write fixture',
    null,
    'session-1',
  );
  database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(
    1,
    'mvs_test',
    'agent',
    'turn-1',
    timestamp,
    0,
    0,
    0,
    0,
    1_000_000,
  );
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)').run('mvs_child', 'child', 'Child', 'mvs_test', null);
  database.prepare('INSERT INTO local_runtime_sessions VALUES (?, ?, ?, ?, ?)').run('mvs_grandchild', 'grandchild', 'Grandchild', 'mvs_child', null);
  database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(2, 'mvs_child', 'child', 'turn-2', timestamp + 1, 0, 0, 0, 0, 0);
  database.prepare('INSERT INTO local_runtime_token_usage VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)').run(3, 'mvs_grandchild', 'grandchild', 'turn-3', timestamp + 2, 0, 0, 0, 0, 0);
  database.close();

  fs.writeFileSync(path.join(historyDirectory, 'llm-call.json'), JSON.stringify({
    provider: 'custom_provider:commandcode',
    model: 'vendor/current-model',
  }));
  fs.writeFileSync(path.join(historyDirectory, 'messages.jsonl'), JSON.stringify({
    message: {
      role: 'assistant',
      timestamp,
      model: 'vendor/current-model',
      provider: 'custom_provider:commandcode',
      usage: { input_tokens: 0, output_tokens: 0, cache_write_tokens: 1_000_000 },
    },
  }) + '\n');

  const ratesPath = path.join(directory, 'provider-rates.json');
  fs.writeFileSync(ratesPath, JSON.stringify(validTable(), null, 2) + '\n', 'utf8');
  const script = fileURLToPath(new URL('../scripts/session-cost.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [script, '--data-dir', directory, '--session', 'mvs_test', '--json'], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_COST_RATES_PATH: ratesPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.usage.cacheWriteTokens, 1_000_000);
  assert.equal(report.costCacheWrite, 0.25);
  assert.equal(report.billing.classification, 'rate-estimated');
  assert.equal(report.billing.basis, 'provider-rate-estimate');
  assert.equal(report.billing.recordedCostUsd, null);
  assert.equal(report.billing.estimatedCostUsd, 0.25);
  assert.equal(report.models[0].rateKnown, true);
  assert.equal(report.rateCoverage.complete, true);
  assert.deepEqual(report.excludedSessionIds, ['mvs_child', 'mvs_grandchild']);

  const recursiveResult = spawnSync(process.execPath, [
    script,
    '--data-dir',
    directory,
    '--session',
    'mvs_test',
    '--include-children',
    '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_COST_RATES_PATH: ratesPath },
  });
  assert.equal(recursiveResult.status, 2, recursiveResult.stderr);
  const recursiveReport = JSON.parse(recursiveResult.stdout);
  assert.deepEqual(recursiveReport.includedSessionIds, ['mvs_test', 'mvs_child', 'mvs_grandchild']);
  assert.deepEqual(recursiveReport.excludedSessionIds, []);

  const date = new Date(timestamp).toISOString().slice(0, 10);
  const aggregateResult = spawnSync(process.execPath, [
    script,
    '--data-dir',
    directory,
    '--from',
    date,
    '--to',
    date,
    '--include-children',
    '--json',
  ], {
    encoding: 'utf8',
    env: { ...process.env, SESSION_COST_RATES_PATH: ratesPath },
  });
  assert.equal(aggregateResult.status, 2, aggregateResult.stderr);
  const aggregateReport = JSON.parse(aggregateResult.stdout);
  assert.deepEqual(aggregateReport.rootSessionIds, ['mvs_test']);
  assert.deepEqual(aggregateReport.includedSessionIds, ['mvs_test', 'mvs_child', 'mvs_grandchild']);
  assert.deepEqual([...aggregateReport.duplicateSuppressedSessionIds].sort(), ['mvs_child', 'mvs_grandchild']);
});
