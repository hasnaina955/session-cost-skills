import test from 'node:test';
import assert from 'node:assert/strict';
import { BUILTIN_PROVIDER_MANIFESTS } from '../adapters/mcode/skill/scripts/lib/provider-driver.mjs';
import {
  REQUIRED_RATE_COMPONENTS,
  parseCommandCodeRates,
  parseStepFunRates,
} from '../adapters/mcode/skill/scripts/lib/rates.mjs';

// Offline rate fixtures for the built-in drivers that mirror a pricing page over the network.
//
// The generic protocol drivers already have this guard: `driver-fixtures.test.mjs` asserts
// `Object.keys(USAGE_FIXTURES)` equals the protocol driver list, so a new protocol driver
// cannot be added without offline fixtures. The built-in network drivers had no equivalent.
// Their parser tests lived in the MCode adapter's suite as inline cases, with nothing tying
// them to the manifest list, so a new `rateRetrieval: 'network'` driver could ship with a
// parser that had never been exercised without a network call — and the three wrong-money
// bugs fixed in v0.4.0 were all found exactly that way, in parsers that had no offline case.
//
// This file closes the asymmetry: the fixture set is keyed by driver id and asserted equal to
// the set of built-in drivers that fetch their rates, so the gap is a test failure rather than
// something a reviewer has to notice.

const BUILTIN_IDS = BUILTIN_PROVIDER_MANIFESTS.map((manifest) => manifest.id);

/** Built-in drivers whose rates are mirrored from a network source and therefore need a parser fixture. */
const NETWORK_RATE_DRIVER_IDS = BUILTIN_PROVIDER_MANIFESTS
  .filter((manifest) => manifest.capabilities?.rateRetrieval === 'network')
  .map((manifest) => manifest.id)
  .sort();

const PARSERS = {
  commandcode: parseCommandCodeRates,
  stepfun: parseStepFunRates,
};

function commandCodeHtml(model, row) {
  const flight = `<script>self.__next_f.push([1,${JSON.stringify(JSON.stringify(model))}])</script>`;
  return `<!doctype html><table>${row}</table>${flight}`;
}

function commandCodeRow(name, { input, output, cacheRead, cacheWrite }) {
  const cell = (value) => `<div class="px-2 py-3 ">$0.00</div>`.replace('$0.00', value);
  return [
    '<div class="grid" role="row">',
    `<div class="model">${name}</div>`,
    cell('1M'), cell(input), cell(output), cell(cacheRead), cell(cacheWrite),
    '<div class="caps">caps</div>',
    '</div>',
  ].join('');
}

const stepFunDocument = [
  '| Model | Billing unit | Input (cache miss) | Input (cache hit) | Output |',
  '| --- | --- | --- | --- | --- |',
  '| `step-5-preview` | 1M tokens | \\$1.00 | \\$0.05 | \\$2.70 |',
  '',
].join('\n');

/**
 * One offline rate document per network-rate built-in driver, with the rates the real parser
 * must produce from it. `expected` is asserted field by field, so a parser that silently
 * returns 0, drops a component, or flips cache-read and fresh-input prices fails here.
 */
const BUILTIN_RATE_FIXTURES = {
  commandcode: [
    {
      name: 'rendered-row-with-an-explicit-no-charge-cache-write',
      text: commandCodeHtml(
        {
          id: 'vendor/current-model',
          name: 'Current Model',
          category: 'opensource',
          provider: 'Vendor',
          inputCost: 1,
          outputCost: 2,
          cacheReadCost: 0.1,
          cacheWriteCost: 0,
          planBudgetUsd: {},
        },
        commandCodeRow('Current Model', {
          input: '$1.00', output: '$2.00', cacheRead: '$0.10', cacheWrite: '$0.00',
        }),
      ),
      model: 'vendor/current-model',
      expected: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    },
  ],
  stepfun: [
    {
      name: 'documented-cache-write-bills-at-the-input-rate',
      text: stepFunDocument,
      model: 'step-5-preview',
      // StepFun publishes no cache-write column. The documented policy is that a cache write
      // bills at the input rate, and that rule is the one thing a future parser change would
      // most easily break, so it is pinned here rather than left to the adapter suite.
      expected: { input: 1, output: 2.7, cacheRead: 0.05, cacheWrite: 1 },
    },
  ],
};

test('every network-rate built-in driver ships an offline rate fixture', () => {
  assert.ok(NETWORK_RATE_DRIVER_IDS.length > 0, 'the manifest must declare at least one network-rate driver');
  assert.deepEqual(
    Object.keys(BUILTIN_RATE_FIXTURES).sort(),
    [...NETWORK_RATE_DRIVER_IDS],
    'a built-in driver that fetches its rates over the network must have an offline rate '
    + 'fixture, and a fixture must not outlive the driver it was written for',
  );
  for (const id of NETWORK_RATE_DRIVER_IDS) {
    assert.ok(PARSERS[id], `${id} declares network rate retrieval but no parser is reachable for it`);
    const fixtures = BUILTIN_RATE_FIXTURES[id];
    assert.ok(Array.isArray(fixtures) && fixtures.length > 0, `${id} needs at least one rate document`);
    assert.equal(
      new Set(fixtures.map((fixture) => fixture.name)).size,
      fixtures.length,
      `${id} rate fixture names must be unique`,
    );
  }
});

test('every offline rate fixture parses to the rates it declares', () => {
  for (const [id, fixtures] of Object.entries(BUILTIN_RATE_FIXTURES)) {
    for (const fixture of fixtures) {
      const parsed = PARSERS[id](fixture.text);
      const model = parsed[fixture.model];
      assert.ok(model, `${id}/${fixture.name}: the parser must return the declared model ${fixture.model}`);
      for (const component of REQUIRED_RATE_COMPONENTS) {
        assert.equal(
          model[component],
          fixture.expected[component],
          `${id}/${fixture.name}: ${component} must parse to its documented value`,
        );
      }
    }
  }
});

test('a driver manifest cannot claim network rates without declaring its source', () => {
  // The manifest is the contract a new driver is written against. If it says it mirrors a
  // pricing page it must name that page, because the offline fixture is built from it.
  for (const id of NETWORK_RATE_DRIVER_IDS) {
    const manifest = BUILTIN_PROVIDER_MANIFESTS.find((candidate) => candidate.id === id);
    assert.ok(manifest.source?.url, `${id} mirrors a source and must declare source.url`);
    assert.ok(
      manifest.operations.includes('fetchRates'),
      `${id} declares network rate retrieval and must expose the fetchRates operation`,
    );
  }
});

test('the built-in driver list is not empty and stays unique', () => {
  assert.equal(new Set(BUILTIN_IDS).size, BUILTIN_IDS.length, 'built-in driver ids must be unique');
});
