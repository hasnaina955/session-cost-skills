import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { validateJsonSchema } from '../scripts/validate-json-schema.mjs';
import schema from '../contracts/session-config-v1.schema.json' with { type: 'json' };
import { SETUP_DRIVERS, buildProviderProfile, renderSetupText, validationCommand } from '../shared/setup.mjs';

const canonical = fs.readFileSync(new URL('../shared/setup.mjs', import.meta.url), 'utf8');
const RATE = { model: 'm1', effectiveFrom: '2026-01-01T00:00:00.000Z', input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 };
const GOOD = { id: 'my-endpoint', driverId: 'openai-compatible', baseUrlEnv: 'MY_BASE_URL', rateCards: [RATE] };

test('both adapters ship the same setup implementation', () => {
  for (const runtime of ['cline', 'mcode']) {
    assert.equal(fs.readFileSync(new URL(`../adapters/${runtime}/skill/scripts/lib/setup.mjs`, import.meta.url), 'utf8'), canonical);
  }
});

test('a complete set of answers produces a profile the config schema accepts', () => {
  const result = buildProviderProfile(GOOD);
  assert.equal(result.ok, true, result.problems.join('; '));
  const config = { schemaVersion: 1, runtimeDefaults: {}, providers: [result.profile], models: [] };
  assert.deepEqual(validateJsonSchema(config, schema), [], 'the generated profile must satisfy the contract');
  assert.equal(result.profile.pricingMode, 'manual');
  assert.equal(result.profile.currency, 'USD', 'a lowercase currency must be normalised');
});

test('a secret value is refused where an environment variable NAME is required', () => {
  // The rule the whole flow exists to protect. A value here would put a live key in a file.
  for (const [key, leak] of [['credentialEnv', 'sk-ant-REALSECRETKEY'], ['baseUrlEnv', 'https://real-secret-host'], ['endpointEnv', 'Bearer LEAKYVALUE']]) {
    const result = buildProviderProfile({ ...GOOD, [key]: leak });
    assert.equal(result.ok, false, `${key} accepted a literal value`);
    assert.equal(result.profile, null, 'nothing may be produced from a rejected config');
    assert.ok(result.problems.some((problem) => problem.includes('environment variable NAME')), `${key}: ${result.problems}`);
  }
});

test('the generated profile never contains a value that could be a secret', () => {
  const result = buildProviderProfile({ ...GOOD, credentialEnv: 'MY_API_KEY' });
  const text = JSON.stringify(result.profile);
  assert.match(text, /MY_API_KEY/, 'the env NAME is expected');
  assert.doesNotMatch(text, /sk-|Bearer /, 'no secret-shaped value may appear');
});

test('a provider with no rate card is reported now, not at the first report', () => {
  const result = buildProviderProfile({ ...GOOD, rateCards: [] });
  assert.equal(result.ok, false);
  assert.ok(result.problems.some((problem) => problem.includes('unavailable cost')),
    'the no-rates failure must be named explicitly');
});

test('an incomplete rate card is refused rather than partially applied', () => {
  // A half-priced model is the same failure as an unpriced one, only harder to notice.
  const result = buildProviderProfile({ ...GOOD, rateCards: [{ ...RATE, cacheWrite: undefined }] });
  assert.equal(result.ok, false);
  assert.equal(result.profile, null);
  assert.ok(result.problems.some((problem) => problem.includes('cacheWrite')));
});

test('every field is validated with an actionable message', () => {
  const cases = [
    [{ id: '', driverId: 'openai-compatible', baseUrlEnv: 'A_B', rateCards: [RATE] }, /id is required/],
    [{ id: 'Bad Id', driverId: 'openai-compatible', baseUrlEnv: 'A_B', rateCards: [RATE] }, /not a usable id/],
    [{ ...GOOD, driverId: 'not-a-driver' }, /not a driver a custom endpoint can use/],
    [{ ...GOOD, baseUrlEnv: undefined, endpointEnv: undefined }, /endpoint is required/],
    [{ ...GOOD, currency: 'DOLLARS' }, /three-letter currency/],
    [{ ...GOOD, rateCards: [{ ...RATE, effectiveFrom: 'yesterday' }] }, /effectiveFrom as an ISO timestamp/],
    [{ ...GOOD, runtimes: [] }, /at least one runtime/],
  ];
  for (const [answers, pattern] of cases) {
    const result = buildProviderProfile(answers);
    assert.equal(result.ok, false, JSON.stringify(answers));
    assert.ok(result.problems.some((problem) => pattern.test(problem)),
      `expected ${pattern} in ${JSON.stringify(result.problems)}`);
  }
});

test('the flow ends by printing the command that validates the result', () => {
  const result = buildProviderProfile(GOOD);
  const text = renderSetupText({ result, configPath: '.session-cost.json', runtimeId: 'cline' });
  assert.match(text, /--validate-config --session-config \.session-cost\.json/);
  assert.equal(validationCommand('p.json'), 'node session-cost.mjs --validate-config --session-config p.json');
});

test('a rejected configuration writes nothing and says so', () => {
  const result = buildProviderProfile({ id: 'x' });
  const text = renderSetupText({ result, configPath: '.session-cost.json', runtimeId: 'cline' });
  assert.match(text, /Nothing was written/);
  assert.match(text, /not ready yet/);
});

test('the setup driver list is the one a custom endpoint can actually use', () => {
  assert.ok(SETUP_DRIVERS.length > 0);
  for (const driver of SETUP_DRIVERS) {
    assert.ok(driver.id && driver.label && driver.protocol, 'each entry must be complete');
  }
  const result = buildProviderProfile({ ...GOOD, driverId: 'commandcode' });
  assert.equal(result.ok, false, 'a bundled driver is not a custom endpoint choice');
});
