import test from 'node:test';
import assert from 'node:assert/strict';
import { renderBriefText, briefJson, briefCost, briefTopModel } from '../shared/brief.mjs';

test('a complete session reads as a short, correct summary', () => {
  const text = renderBriefText({
    billing: { amountUsd: 0.0005, coverage: 'complete', basis: 'provider-rate-estimate' },
    usage: { totalTokens: 1913, cacheHitRate: 0.65 },
    calls: 4,
    models: [{ modelId: 'big-model', providerKey: 'commandcode', rateKnown: true, totalCost: 0.0004 }, { modelId: 'small-model', providerKey: 'stepfun', rateKnown: true, totalCost: 0.0001 }],
    sessionGraph: { includedSessionIds: ['root', 'child'], excludedSessionIds: [] },
  });
  const lines = text.split('\n');
  assert.ok(lines.length <= 5, `a brief is short, got ${lines.length} lines:\n${text}`);
  assert.match(lines[0], /\$0\.0005/);
  assert.doesNotMatch(lines[0], /partial|unavailable/i, 'a complete total is not hedged');
  assert.match(text, /1,913 tokens/);
  assert.match(text, /65% cache hit/);
  assert.match(text, /top: big-model \(commandcode\)/);
  assert.match(text, /includes 1 sub-agent/);
});

test('a partial session is labelled, and a fully unpriced one says unavailable', () => {
  const partial = renderBriefText({
    billing: { amountUsd: null, coverage: 'partial', basis: 'provider-rate-estimate' },
    usage: { totalTokens: 400, cacheHitRate: 0.1 },
    calls: 2,
    models: [{ modelId: 'm', rateKnown: false }],
    sessionGraph: { includedSessionIds: ['root'], excludedSessionIds: [] },
  });
  assert.match(partial.split('\n')[0], /unavailable/);
  assert.doesNotMatch(partial, /\$0\.(00|000)/, 'a partial total is never shown as a small number');
  assert.match(partial, /lower bound/);

  const unpriced = renderBriefText({
    billing: { amountUsd: null, coverage: 'unavailable' },
    usage: { totalTokens: 100 },
    calls: 1,
    models: [{ modelId: 'unknown-model', rateKnown: false }],
    sessionGraph: { includedSessionIds: ['root'], excludedSessionIds: [] },
  });
  assert.match(unpriced, /unavailable/);
  assert.doesNotMatch(unpriced, /\$0\.00/, 'the silent-zero failure, in the shortest format');
});

test('an excluded subagent is disclosed, so a small total does not look complete', () => {
  const text = renderBriefText({
    billing: { amountUsd: 0.15, coverage: 'complete' },
    usage: { totalTokens: 1650 },
    calls: 2,
    models: [{ modelId: 'm', rateKnown: true, totalCost: 0.15 }],
    sessionGraph: { includedSessionIds: ['root'], excludedSessionIds: ['child', 'grandchild'] },
  });
  assert.match(text, /2 sub-agent session\(s\) not billed/);
  assert.match(text, /add --include-children/);
});

test('a low cache rate is the one warning worth surfacing', () => {
  const text = renderBriefText({
    billing: { amountUsd: 0.5, coverage: 'complete' },
    usage: { totalTokens: 100000, cacheHitRate: 0.2 },
    calls: 8,
    models: [{ modelId: 'm', rateKnown: true, totalCost: 0.5 }],
    sessionGraph: { includedSessionIds: ['root'], excludedSessionIds: [] },
  });
  assert.match(text, /cache hit rate is low/);
  // A healthy cache rate produces no such warning, so it is not noise.
  const quiet = renderBriefText({
    billing: { amountUsd: 0.5, coverage: 'complete' },
    usage: { totalTokens: 100000, cacheHitRate: 0.9 },
    calls: 8,
    models: [{ modelId: 'm', rateKnown: true, totalCost: 0.5 }],
    sessionGraph: { includedSessionIds: ['root'], excludedSessionIds: [] },
  });
  assert.doesNotMatch(quiet, /cache hit rate is low/);
});

test('the JSON brief is a small, stable, documented shape', () => {
  const brief = briefJson({
    billing: { amountUsd: 0.0005, coverage: 'complete', basis: 'provider-rate-estimate' },
    usage: { totalTokens: 1913, cacheHitRate: 0.65 },
    calls: 4,
    models: [{ modelId: 'm', providerKey: 'commandcode', rateKnown: true, totalCost: 0.0004 }],
    sessionGraph: { includedSessionIds: ['root', 'child'], excludedSessionIds: ['excluded'] },
  });
  assert.equal(brief.kind, 'session-brief');
  assert.equal(brief.costUsd, 0.0005);
  assert.equal(brief.coverage, 'complete');
  assert.equal(brief.tokens, 1913);
  assert.equal(brief.cacheHitRate, 0.65);
  assert.equal(brief.topModel.model, 'm');
  assert.equal(brief.includedSubagents, 1, 'the root is not a subagent of itself');
  assert.equal(brief.excludedSubagents, 1);
  // Every field has a usable value or an explicit null; nothing is `undefined`.
  for (const [key, value] of Object.entries(brief)) {
    assert.notEqual(value, undefined, `field ${key} must never be undefined`);
  }
});

test('the JSON brief keeps an unknown cost as null, and a partial one labelled', () => {
  const brief = briefJson({ billing: { amountUsd: null, coverage: 'partial' }, usage: { totalTokens: 400 }, calls: 2, models: [], sessionGraph: { includedSessionIds: ['root'] } });
  assert.equal(brief.costUsd, null);
  assert.equal(brief.coverage, 'partial');
  assert.equal(brief.topModel, null, 'no priced model means no top model');
});

test('the brief is never longer than six lines even on a rich report', () => {
  const text = renderBriefText({
    billing: { amountUsd: 0.5, coverage: 'partial' },
    usage: { totalTokens: 999999, cacheHitRate: 0.1 },
    calls: 200,
    models: [{ modelId: 'a', rateKnown: true, totalCost: 0.3 }, { modelId: 'b', rateKnown: true, totalCost: 0.2 }],
    sessionGraph: { includedSessionIds: ['root', 'a', 'b'], excludedSessionIds: ['c', 'd'] },
  });
  assert.ok(text.split('\n').length <= 6);
});

// --- End to end: the flag works in both adapters ---

test('--brief produces the short answer in both adapters, text and JSON', async () => {
  const { mcodeScript, clineScript, createMCodeFixture, createClineFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const mcode = createMCodeFixture();
  const cline = createClineFixture();

  const text = runCli(mcodeScript, mcode.dataDir, ['--session', 'mcode-root', '--include-children', '--brief'], { ...mcode.environment, NO_COLOR: '1' });
  assert.equal(text.status, 0, text.stderr);
  assert.ok(text.stdout.split('\n').filter(Boolean).length <= 6, 'text brief is short');
  assert.doesNotMatch(text.stdout, /\x1b\[/, 'no colour escapes in a piped brief');

  const json = runCli(mcodeScript, mcode.dataDir, ['--session', 'mcode-root', '--include-children', '--brief', '--json'], { ...mcode.environment, NO_COLOR: '1' });
  assert.equal(json.status, 0, json.stderr);
  const brief = JSON.parse(json.stdout);
  assert.equal(brief.kind, 'session-brief');
  assert.ok(brief.costUsd > 0);

  const clineJson = runCli(clineScript, cline.dataDir, ['--session', 'cline-root', '--brief', '--json'], { NO_COLOR: '1' });
  assert.equal(clineJson.status, 0, clineJson.stderr);
  assert.equal(JSON.parse(clineJson.stdout).kind, 'session-brief');
});

test('--brief --json on an unpriced session keeps the cost null, never zero', async () => {
  const { mcodeScript, createMCodeFixture, runCli } = await import('./helpers/contract-fixtures.mjs');
  const fixture = createMCodeFixture();
  const result = runCli(mcodeScript, fixture.dataDir, ['--session', 'mcode-unpriced', '--brief', '--json'], { ...fixture.environment, NO_COLOR: '1' });
  // An unpriceable session exits 2 and still answers.
  assert.equal(result.status, 2);
  const brief = JSON.parse(result.stdout);
  assert.equal(brief.costUsd, null);
  assert.doesNotMatch(result.stdout, /"costUsd": 0/, 'no zero stands in for an unknown cost');
});
