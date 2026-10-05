import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {test} from 'node:test';

// The Command Code adapter ships as a single self-contained TypeScript mod
// rather than a plain .mjs skill, so these checks read its source instead of
// importing it: the repo's CI matrix runs Node 22.15, which cannot strip
// TypeScript types. Behavioral coverage of the mod itself happens when Command
// Code loads it (the mod gate fails loudly on a load error). The one part that
// does not need an import is the rate mirror: the embedded table is a JSON
// literal, so it is parsed and compared against the upstream reference below.

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const modPath = path.join(root, 'adapters', 'commandcode', 'skill', 'session-cost.ts');
const source = fs.readFileSync(modPath, 'utf8');

test('the mod declares its version and contract version as constants', () => {
  assert.match(source, /const MOD_VERSION = '\d+\.\d+\.\d+'/);
  assert.match(source, /const CONTRACT_VERSION = '\d+\.\d+\.\d+'/);
});

test('the JSON emitter carries every field the normalized contract requires', () => {
  const schema = JSON.parse(
    fs.readFileSync(path.join(root, 'contracts', 'normalized-report-v1.schema.json'), 'utf8'),
  );
  const emitterStart = source.indexOf('function toJson(');
  assert.ok(emitterStart > -1, 'the mod must have a toJson emitter');
  const emitter = source.slice(emitterStart, emitterStart + 12000);
  for (const key of schema.required) {
    assert.ok(
      // `\r?\n` for the same reason as the guard count below: this reads the source as text, so it
      // must not assume LF on a machine that checked the file out with CRLF.
      new RegExp(`\\r?\\n\\s{4}${key}[,:]`).test(emitter),
      `the JSON emitter must set the required contract field "${key}"`,
    );
  }
  assert.ok(emitter.includes("id: 'commandcode'"), 'the emitter must identify as the commandcode runtime');
  assert.ok(emitter.includes("costBasis: 'provider-rate-estimate'"), 'the emitter must label its cost basis');
});

test('an unpriced selection reports a null cost, never a guessed zero', () => {
  // Principle 1: unknown cost is null. The aggregator must keep the null through to the
  // session and totals summaries - including the two edges the takeover added: a drifted
  // transcript (not parsed, so its empty call list must not read as $0) and a selection
  // where no call priced (the sum of zero priced calls is the absence of a figure).
  assert.match(source, /costUsd: data\.schemaDrift !== null \? null : \(hasUnpriced \? null : pricedCostUsd\)/);
  assert.match(source, /estimatedCostUsd = totals\.pricedCallCount > 0 \? totals\.pricedCostUsd : null/);
});

test('a banded call with a missing timestamp is unpriced, never priced at the cheaper band', () => {
  // Upstream #100 applies here too: new Date('') is an invalid date whose NaN getters fail
  // every peak comparison, so an unguarded band lookup prices the off-peak (cheaper) band.
  // The mod must check timestamp usability before banding and mark the call 'unknown-time'.
  assert.match(source, /const tsUsable = ownTs !== '' && Number\.isFinite\(Date\.parse\(ownTs\)\)/);
  assert.match(source, /card\.peak && card\.off && !tsUsable/);
  assert.match(source, /unpricedReason = 'unknown-time'/);
});

test('a transcript whose version the mod does not understand is guarded by name', () => {
  // The schema-drift rule: a renamed field must fail by name, never read as zero. The mod
  // declares the transcript version it understands and refuses to price any other.
  assert.match(source, /const TRANSCRIPT_VERSION = 3;/);
  assert.match(source, /meta\.version !== null && meta\.version !== TRANSCRIPT_VERSION/);
});

test('the ledger-recorded cost is surfaced as a separate labelled domain, never merged', () => {
  // Rule 3: the recorded figure and the estimate are different domains. The v3 transcript
  // carries a per-call costUsd; the mod discloses it per session and in totals, keeps
  // billing.recordedCostUsd null on an estimate-basis report, and warns when the two
  // domains disagree materially (a stale mirror trips the wire).
  assert.match(source, /recordedCostUsd = typeof u\.costUsd === 'number' && Number\.isFinite\(u\.costUsd\) \? u\.costUsd : null/);
  assert.match(source, /recordedCostUsd: totals\.recordedCostUsd/);
  assert.match(source, /recordedCostUsd: null,/);
  assert.match(source, /disagree; the mirrored rate table may be stale/);
});

test('commandcode token semantics exclude cached input tokens', () => {
  // Principle 7: never copy the Cline fresh-input formula blindly. The v3
  // ledger's inputTokens is the TOTAL prompt and includes the cache buckets
  // (settled call-by-call against a live install's recorded costUsd, #107),
  // so the mod deducts them and reports the fresh input. The declared
  // meaning must stay 'excludes-cache': the reported buckets are disjoint,
  // like MCode's input_tokens, and a consumer summing them gets the true
  // prompt once.
  assert.ok(source.includes("inputTokenMeaning: 'excludes-cache'"));
  assert.ok(!source.includes("inputTokenMeaning: 'includes-cache'"));
});

test('dashboards are script-free and carry a strict CSP', () => {
  // Principle 11: no external assets, no network requests, default-src 'none'.
  // The Command Code dashboards go further and ship no JavaScript at all.
  // The CSP is written with escaped quotes inside the TypeScript string
  // literals, so the escaped form is what the source carries.
  assert.ok(source.includes("default-src \\'none\\'"), 'dashboards must carry a default-src none CSP');
  const templates = functionSpan('dashboardHtml') + functionSpan('ratesDashboardHtml');
  assert.ok(templates.length > 0, 'both dashboard template functions must exist');
  assert.ok(!templates.includes('<script'), 'dashboard templates must not contain script tags');
  assert.ok(!templates.includes('http://'), 'dashboard templates must not reference network URLs');
  assert.ok(!templates.includes('https://'), 'dashboard templates must not reference network URLs');
});

test('the mod imports only Node builtins at runtime', () => {
  // Principle 12: zero runtime dependencies. The @commandcode/harness import
  // is type-only and erased when the mod loads.
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('import ') || trimmed.startsWith('import type ')) continue;
    assert.match(trimmed, /from 'node:/, 'runtime imports must be Node builtins');
  }
});

test('every reported timestamp comes from the injectable clock', () => {
  // Principle 14: SESSION_COST_NOW pins the reported clock. Strip the
  // clock function and assert no bare "now" read survives anywhere
  // else. Parsing a recorded instant (new Date(ts)) is deterministic
  // given the ledger and is not a clock read.
  assert.ok(source.includes('SESSION_COST_NOW'), 'the clock must honor SESSION_COST_NOW');
  const withoutClock = source.replace(/function clockNow\(\): string \{[\s\S]*?\n\}/, '');
  assert.ok(
    !/new Date\(\)/.test(withoutClock),
    'every "now" read must go through clockNow so SESSION_COST_NOW can pin it',
  );
});

test('failure paths return one readable line', () => {
  // Principle 10: no stack trace, no local path, no credential on any error.
  // `\r?` so the assertion holds on a CRLF checkout too. A literal \n here once made this the only
  // test red on Windows: the guards were present in the file, the regex could not see them, and the
  // count came back 0 - an assertion about not leaking stack traces failing on a build that leaked
  // nothing. `.gitattributes` now pins LF for `*.ts` as well; this keeps the test honest if the
  // file is ever read from an archive or a tree where those attributes are not applied.
  const wrappers = source.match(/try \{\r?\n\s+(?:const argv|return \{ok)/g) || [];
  assert.equal(wrappers.length, 2, 'the command handler and the tool run must both guard runReport');
  assert.equal((source.match(/catch \(error\)/g) || []).length, 2);
});

test('every embedded rate card carries the four priced components', () => {
  const rates = extractEmbeddedRates();
  assert.ok(Object.keys(rates).length > 0, 'the embedded rate table must not be empty');
  for (const [id, card] of Object.entries(rates)) {
    for (const component of ['i', 'o', 'cr', 'cw']) {
      assert.ok(
        typeof card[component] === 'number' && Number.isFinite(card[component]) && card[component] >= 0,
        `rate card ${id} must have a finite nonnegative "${component}" component`,
      );
    }
    for (const band of ['peak', 'off']) {
      if (card[band]) {
        for (const component of ['i', 'o', 'cr', 'cw']) {
          assert.ok(
            typeof card[band][component] === 'number' && Number.isFinite(card[band][component]) && card[band][component] >= 0,
            `rate card ${id} ${band} band must have a finite nonnegative "${component}" component`,
          );
        }
      }
    }
  }
});

test('the embedded rate table mirrors the upstream CommandCode reference exactly', () => {
  // The mod's pricing is only as trustworthy as its mirror. Every embedded
  // model must exist upstream with identical flat and banded components, and
  // every upstream model must be embedded, so a refresh cannot silently drop
  // or invent a rate.
  const rates = extractEmbeddedRates();
  const upstream = JSON.parse(
    fs.readFileSync(path.join(root, 'adapters', 'mcode', 'skill', 'references', 'provider-rates.json'), 'utf8'),
  );
  const reference = upstream.providers.commandcode.models;
  assert.ok(reference && Object.keys(reference).length > 0, 'the upstream reference must carry commandcode models');
  for (const [id, card] of Object.entries(rates)) {
    const expected = reference[id];
    assert.ok(expected, `embedded rate ${id} is not in the upstream reference table`);
    assert.equal(card.i, expected.input, `${id} input rate drifted from the reference`);
    assert.equal(card.o, expected.output, `${id} output rate drifted from the reference`);
    assert.equal(card.cr, expected.cacheRead, `${id} cache-read rate drifted from the reference`);
    assert.equal(card.cw, expected.cacheWrite, `${id} cache-write rate drifted from the reference`);
    const banded = Boolean(card.peak) || Boolean(card.off) || Boolean(expected.timeOfDay);
    if (banded) {
      assert.ok(card.peak && card.off && expected.timeOfDay, `${id} banding must exist on both sides of the mirror`);
      assert.equal(card.peak.i, expected.timeOfDay.peak.input, `${id} peak input drifted`);
      assert.equal(card.peak.o, expected.timeOfDay.peak.output, `${id} peak output drifted`);
      assert.equal(card.peak.cr, expected.timeOfDay.peak.cacheRead, `${id} peak cache-read drifted`);
      assert.equal(card.peak.cw, expected.timeOfDay.peak.cacheWrite, `${id} peak cache-write drifted`);
      assert.equal(card.off.i, expected.timeOfDay.offPeak.input, `${id} off-peak input drifted`);
      assert.equal(card.off.o, expected.timeOfDay.offPeak.output, `${id} off-peak output drifted`);
      assert.equal(card.off.cr, expected.timeOfDay.offPeak.cacheRead, `${id} off-peak cache-read drifted`);
      assert.equal(card.off.cw, expected.timeOfDay.offPeak.cacheWrite, `${id} off-peak cache-write drifted`);
    }
  }
  for (const id of Object.keys(reference)) {
    assert.ok(rates[id], `upstream model ${id} is missing from the embedded table`);
  }
});

function functionSpan(name) {
  const start = source.indexOf(`function ${name}(`);
  if (start < 0) return '';
  const next = source.indexOf('\nfunction ', start + 1);
  return source.slice(start, next > -1 ? next : undefined);
}

function extractEmbeddedRates() {
  const match = source.match(/const RATES: Record<string, RateCard> = (\{.*\});/);
  assert.ok(match, 'the embedded rate table literal must be extractable');
  return JSON.parse(match[1]);
}
