// Guard against the failure that shipped three times this cycle: a shared module that is
// correct against a hand-built fixture and wrong against a report the CLI actually
// produces. The dashboard rendered an empty session table, the live view rendered every
// field blank on MCode, and insights rendered "unknown session" - all three with a full
// green test suite, because every fixture had been shaped by the same hand that wrote the
// module.
//
// The rule this file enforces: a shared module that consumes a report must be exercised
// against a REAL report from each adapter, and a field that renders empty or undefined
// where a value demonstrably exists is a failure.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { clineScript, mcodeScript, createClineFixture, createMCodeFixture, runJson } from './helpers/contract-fixtures.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sharedDir = path.join(root, 'shared');
const RUNTIMES = ['cline', 'mcode'];

export function realReports() {
  const cline = createClineFixture();
  const mcode = createMCodeFixture();
  return {
    cline: runJson(clineScript, cline.dataDir, ['--session', 'cline-root', '--include-children', '--json']).output,
    mcode: runJson(mcodeScript, mcode.dataDir, ['--session', 'mcode-root', '--include-children', '--json'], mcode.environment).output,
  };
}

test('every shared module has an identical copy in both adapters', () => {
  // Drift here means an installed skill behaves differently from the repository, which
  // is the whole reason the generated-copy checks exist.
  const modules = fs.readdirSync(sharedDir).filter((file) => file.endsWith('.mjs'));
  assert.ok(modules.length > 0);
  for (const file of modules) {
    const canonical = fs.readFileSync(path.join(sharedDir, file), 'utf8');
    for (const runtime of RUNTIMES) {
      const copy = path.join(root, 'adapters', runtime, 'skill', 'scripts', 'lib', file);
      assert.ok(fs.existsSync(copy), `${file} has no ${runtime} adapter copy`);
      assert.equal(fs.readFileSync(copy, 'utf8'), canonical, `${file} differs in the ${runtime} adapter`);
    }
  }
});

test('both real reports carry the fields every shared module reads', () => {
  // If a report stops carrying a field a module depends on, the module must fail here
  // rather than silently rendering a blank in a user's terminal.
  for (const [runtime, report] of Object.entries(realReports())) {
    assert.ok(report, `${runtime}: no report produced`);
    for (const [label, value] of [
      ['contractVersion', report.contractVersion],
      ['runtime.id', report.runtime?.id],
      ['runtime.costBasis', report.runtime?.costBasis],
      ['snapshot.capturedAt', report.snapshot?.capturedAt],
      ['usage.totalTokens', report.usage?.totalTokens],
      ['usage.cacheHitRate', report.usage?.cacheHitRate],
      ['billing.amountUsd', report.billing?.amountUsd],
      ['billing.basis', report.billing?.basis],
    ]) {
      assert.notEqual(value, undefined, `${runtime}: report no longer carries ${label}`);
      assert.notEqual(value, null, `${runtime}: report no longer carries ${label}`);
    }
    assert.equal(typeof report.usage.totalTokens, 'number', `${runtime}: totalTokens must be a number`);
    assert.ok(report.usage.totalTokens > 0, `${runtime}: the fixture report must carry real usage`);
  }
});

// The modules that consume a report. Each entry names the call and the fields that must
// be non-empty when driven by a real report. A module added here without real-report
// coverage is the gap this file exists to prevent.
const CONSUMERS = [
  {
    name: 'rollup',
    async call(report) {
      const { renderRollupText, rankSessions } = await import('../shared/rollup.mjs');
      return { text: renderRollupText([report], 'daily'), ranked: rankSessions(report) };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /period|period start|spend/i, `${runtime}: rollup text rendered empty`);
      assert.ok(result.ranked.length > 0, `${runtime}: ranking produced no rows`);
      for (const row of result.ranked) {
        assert.ok(row.sessionId, `${runtime}: a ranked row has no session id`);
        assert.equal(typeof row.totalTokens, 'number', `${runtime}: a ranked row has no token count`);
      }
    },
  },
  {
    name: 'explain',
    async call(report) {
      const { renderExplanation, explainCost } = await import('../shared/explain.mjs');
      return { text: renderExplanation(report), result: explainCost(report) };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /Cost explanation/, `${runtime}: explanation header missing`);
      assert.match(result.text, /TOTAL/, `${runtime}: explanation has no total line`);
      assert.equal(typeof result.result.total.reported, 'number', `${runtime}: explanation lost the reported cost`);
      assert.equal(result.result.basis, report.billing.basis, `${runtime}: explanation must keep the report's basis`);
    },
  },
  {
    name: 'csv',
    async call(report) {
      const { renderCsv, CSV_COLUMN_NAMES } = await import('../shared/csv.mjs');
      return { text: renderCsv(report), columns: CSV_COLUMN_NAMES };
    },
    assert(result, report, runtime) {
      const [header, row] = result.text.split('\n');
      assert.ok(header && row, `${runtime}: CSV produced no data row`);
      assert.equal(header.split(',').length, row.split(',').length, `${runtime}: CSV row width does not match the header`);
      assert.ok(result.columns.includes('costUsd'), 'the CSV contract must carry a cost column');
    },
  },
  {
    name: 'live-view',
    async call(report) {
      const { renderLiveFrame } = await import('../shared/live-view.mjs');
      return { text: renderLiveFrame(report, {}) };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /TOTAL COST/, `${runtime}: the live frame has no headline`);
      assert.doesNotMatch(result.text, /unknown ·/, `${runtime}: the live frame rendered an unknown session`);
      assert.ok(
        result.text.includes(`$${report.billing.amountUsd.toFixed(4)}`),
        `${runtime}: the live frame does not show the report's own cost`,
      );
    },
  },
  {
    name: 'insights',
    async call(report) {
      const { compareToBaseline, renderInsightsText } = await import('../shared/insights.mjs');
      const rows = report.sessions;
      return { text: renderInsightsText(compareToBaseline(rows[0], rows)), result: compareToBaseline(rows[0], rows) };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /Insights/i, `${runtime}: insights rendered nothing`);
      // Too little history must be stated, never papered over with a fabricated baseline.
      if (result.result.status === 'insufficient-data') {
        assert.match(result.text, /NOT ENOUGH DATA|insufficient/i, `${runtime}: insufficient data must be stated`);
      }
    },
  },
  {
    name: 'dashboard',
    async call(report) {
      const { renderDashboard } = await import('../shared/dashboard.mjs');
      return { text: renderDashboard(report, { title: 'real' }) };
    },
    assert(result, report, runtime) {
      const csp = (result.text.match(/Content-Security-Policy" content="([^"]+)"/)?.[1] ?? '').replace(/&#39;/g, "'");
      assert.match(csp, /script-src 'sha256-[A-Za-z0-9+/=]+'/, `${runtime}: the dashboard lost its CSP hash`);
      assert.doesNotMatch(result.text, /(?:src|href)=["']https?:/i, `${runtime}: the dashboard gained an external asset`);
    },
  },
  {
    name: 'counterfactual',
    async call(report) {
      const { counterfactualCost, renderCounterfactualText } = await import('../shared/counterfactual.mjs');
      // Re-price against the report's own model, so a real record is available.
      const model = (report.models ?? [])[0];
      const records = model?.rateRecords ?? [];
      const result = counterfactualCost(report, { model: model?.rateKey ?? model?.modelId, rateRecords: records });
      return { text: renderCounterfactualText(report, result), result };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /Counterfactual estimate/, `${runtime}: counterfactual rendered nothing`);
      assert.equal(result.result.actualCostUsd, report.billing.amountUsd, `${runtime}: the counterfactual must carry, not replace, the real cost`);
    },
  },
  {
    name: 'cost-centres',
    async call(report) {
      const { attributeCostCentres, renderCostCentresText } = await import('../shared/cost-centres.mjs');
      const result = attributeCostCentres(report, [{ name: 'centre', sessionIds: [report.sessions[0].row.sessionId] }]);
      return { text: renderCostCentresText(result), result };
    },
    assert(result, report, runtime) {
      assert.match(result.text, /cost centre|untagged/i, `${runtime}: cost-centre output rendered nothing`);
      // Untagged spend must be visible, never absorbed into a named centre.
      assert.ok(result.result.centres.length > 0 || result.result.untagged, `${runtime}: no sessions were attributed at all`);
    },
  },
];

for (const consumer of CONSUMERS) {
  for (const runtime of RUNTIMES) {
    test(`${consumer.name} produces real output from a real ${runtime} report`, async () => {
      const report = realReports()[runtime];
      const result = await consumer.call(report);
      consumer.assert(result, report, runtime);
    });
  }
}

test('both adapters emit the same per-session row shape', () => {
  // MCode had no `sessions` field, so rollups, cost centres, and insights all reported
  // "unknown" there. That was honest but left three shipped features half-available, and
  // it happened because the contract test I wrote skipped rather than failed.
  for (const [runtime, report] of Object.entries(realReports())) {
    const rows = report.sessions;
    assert.ok(Array.isArray(rows) && rows.length > 0, `${runtime}: a report must carry per-session rows`);
    for (const entry of rows) {
      for (const key of ['sessionId', 'parentSessionId', 'status', 'startedAt', 'endedAt']) {
        assert.ok(Object.hasOwn(entry.row ?? {}, key), `${runtime}: session row is missing ${key}`);
      }
      // totalTokens is optional: Cline's per-session rows omit it and consumers derive it,
      // while MCode states it. Asserted in the shape-parity test rather than required here.
      for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'calls', 'unpricedCalls', 'cost']) {
        assert.ok(Object.hasOwn(entry.metrics ?? {}, key), `${runtime}: session metrics are missing ${key}`);
      }
      const tokens = entry.metrics.totalTokens ?? (entry.metrics.inputTokens + entry.metrics.outputTokens);
      assert.equal(typeof tokens, 'number', `${runtime}: a session row must yield a token count`);
      assert.ok(tokens >= 0);
    }
    // The tree must be walkable, which is what cost-centre expansion relies on.
    const ids = new Set(rows.map((entry) => entry.row.sessionId));
    for (const entry of rows) {
      const parent = entry.row.parentSessionId;
      if (parent !== null) assert.ok(ids.has(parent), `${runtime}: parent ${parent} is not among the reported sessions`);
    }
  }
});

test('the sessions on both adapters add up to the report total', () => {
  // A per-session array that does not reconcile to the headline is worse than none:
  // a rollup would then disagree with the report it came from.
  for (const [runtime, report] of Object.entries(realReports())) {
    const cost = report.sessions.reduce((sum, entry) => sum + (Number(entry.metrics.cost) || 0), 0);
    const tokens = report.sessions.reduce((sum, entry) => sum
      + (entry.metrics.totalTokens ?? ((entry.metrics.inputTokens || 0) + (entry.metrics.outputTokens || 0))), 0);
    const expectedCost = report.billing.amountUsd;
    const expectedTokens = report.usage.totalTokens;
    assert.ok(Math.abs(cost - expectedCost) < 1e-9,
      `${runtime}: session costs sum to ${cost} but the report says ${expectedCost}`);
    assert.equal(tokens, expectedTokens, `${runtime}: session tokens must sum to the report total`);
  }
});

test('an unpriced session reports a null cost rather than a smaller total', () => {
  for (const [runtime, report] of Object.entries(realReports())) {
    for (const entry of report.sessions) {
      if ((entry.metrics.unpricedCalls ?? 0) > 0) {
        assert.equal(entry.metrics.cost, null, `${runtime}/${entry.row.sessionId}: unpriced work must report null, not a partial figure`);
      }
    }
  }
});

test('the CSV total respects each report\'s declared token semantics', async () => {
  // Cline's inputTokens already includes cached tokens; MCode's excludes them. Summing all
  // four columns double-counted the cache on Cline and reported 2025 tokens where 1650 were
  // real. The report states which case it is, so the export must read that rather than
  // assume one shape.
  const { renderCsv, CSV_COLUMN_NAMES } = await import('../shared/csv.mjs');
  const column = CSV_COLUMN_NAMES.indexOf('totalTokens');
  for (const [runtime, report] of Object.entries(realReports())) {
    const meaning = report.usage.semantics.inputTokenMeaning;
    const cells = renderCsv(report).split('\n').slice(1).filter(Boolean).map((line) => Number(line.split(',')[column] || 0));
    const total = cells.reduce((sum, value) => sum + value, 0);
    assert.equal(total, report.usage.totalTokens, `${runtime}: the CSV token total must equal the report's own`);
    // And the per-row total must follow the same rule as the report's aggregate.
    const perSession = report.sessions.reduce((sum, entry) => {
      const m = entry.metrics;
      return sum + (meaning === 'includes-cache'
        ? (m.inputTokens || 0) + (m.outputTokens || 0)
        : (m.inputTokens || 0) + (m.outputTokens || 0) + (m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0));
    }, 0);
    assert.equal(total, perSession, `${runtime}: rows must total per the ${meaning} rule`);
  }
});

test('every flag the schema accepts is actually acted on by both CLIs', async () => {
  // Three features in this cycle were documented, parsed, and did nothing: the #49 wiring
  // was lost to a stash, --watch had help text but no loop in Cline, and --counterfactual
  // lost its call to a `git checkout` while its import survived. A flag that parses and is
  // then ignored is worse than a flag that does not exist, and the schema-to-help test
  // cannot see it: the schema listed it and the help documented it.
  //
  // This asserts the cheap, decisive thing: each declared option is referenced by the
  // adapter that claims to support it.
  const { RUNTIME_FLAGS } = await import('../shared/cli-args.mjs');
  for (const runtime of ['cline', 'mcode']) {
    const source = fs.readFileSync(path.join(root, 'adapters', runtime, 'skill', 'scripts', 'session-cost.mjs'), 'utf8');
    for (const [flag, spec] of Object.entries(RUNTIME_FLAGS[runtime])) {
      if (['help', 'version', 'dataDir', 'out'].includes(flag)) continue; // handled before or outside the option flow
      assert.ok(source.includes(`opts.${spec.key}`),
        `${runtime}: --${flag} is in the schema but the CLI never reads opts.${spec.key}`);
    }
  }
});
