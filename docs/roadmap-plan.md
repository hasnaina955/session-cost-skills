# Roadmap plan: the most useful, robust, and visually rich session-cost tool

This document is an execution plan. It is written so that an agent or contributor with no prior
context can pick up one work package (WP), finish it in one pull request, and know when it is
done. Read sections 1-3 once; after that, each WP stands alone.

## 0. Status

Delivered and merged, each on its own PR with the full CI matrix green:

| WP | Result |
| --- | --- |
| WP-0.1 | Landed the in-flight work; rebased #61 onto a fixed `main` so its stale-green checks re-ran |
| WP-0.2 | Roadmap checkboxes and the test count synced; the README `--version` example is now asserted against `package.json` |
| WP-0.3 | `docs/principles.md`: 16 rules, each linked to the test that enforces it, and `check:docs` fails on a citation that does not resolve |
| WP-1.1 | `SESSION_COST_NOW` pins the reported clock; a source scan fails the build on a raw `Date.now()` in a reporting path |
| WP-1.2 | Golden tests over ten rendered scenarios, plus a fixture epoch so the corpus cannot expire |
| WP-1.3 | Seven accounting invariants over seeded random ledgers |
| WP-1.4 | Storage schema-drift detection: a renamed column fails by name instead of reading as zero |
| WP-1.5 | Bun runs on Windows; the `EBUSY` cleanup failures are gone |
| WP-1.6 | Seeded fuzzing of session logs, message files, and pricing pages |
| WP-3.0 | A bounded per-call timeline, and MCode `--json` reports that emit it |
| WP-3.1 | A zero-dependency inline-SVG chart module |
| v0.5.0 | Cut, with a cross-platform skill update workflow (`docs/updating.md`) |

Still ahead: WP-2.1-2.4 (the shared CLI kernel), WP-3.2-3.5 (dashboard v2, terminal bars, themes,
share card), WP-4.x (MCP server, installer, perf budget), and Phase 5 adapters.

Two findings are recorded rather than papered over, both filed as issues:
`calculateTokenCost` coerces unusable token counts into a finite `0` (#67), and `bandForTimestamp`
resolves a `null` timestamp to the off-peak band, which is the cheaper one.

## 1. Direction

### The thesis

Every coding agent burns tokens, and almost none of them tell you honestly what a session cost.
The tools that exist either guess prices, round totals, show `$0.00` when they do not know, or
merge subscription usage with invoice charges. This project's advantage is not features. It is
that **every number it prints can be traced to a ledger row and a fingerprinted rate record, and
when it does not know, it says so.** Do not trade that away for anything below.

The goal: become **the trustworthy cost ledger for every coding agent**, readable by humans
(terminal, HTML) and by agents (JSON, MCP), across runtimes.

### Three pillars, in order

1. **Trust (robustness).** Deterministic tests, an injectable clock, invariant tests, schema-drift
   detection. Without these, every later feature adds new ways to be silently wrong.
2. **Sight (visual richness).** Charts in the dashboard, bars in the terminal, shareable
   summaries. Visuals must never display a figure the accounting did not produce.
3. **Reach (usefulness).** A shared CLI kernel so a new runtime adapter is ~300 lines, not 1,400.
   Then an MCP server, cross-platform install, and the adapters in issues #15-#20.

### Why this order

- **Kernel before adapters.** Today each adapter entry point re-implements orchestration
  (`parseArgs`, `loadConfig`, `runSetup`, `runDiagnostic`, mode dispatch). Adding OpenCode,
  Claude Code, and Codex now would triple that duplication and triple every future bug fix.
- **Timeline contract before charts.** Reports carry aggregate counts (`calls` is a number), not
  per-call events. A cost-over-time chart has nothing to draw until the contract carries a
  bounded per-call timeline.
- **Injectable clock before golden tests.** Fixtures use `Date.now()`, so output changes every
  run and one test already flipped from pass to fail with no code change (see CHANGELOG,
  Unreleased). Snapshot tests of rendered output are impossible until time is injectable.

### Milestones

| Version | Contents | Exit criterion |
| --- | --- | --- |
| 0.5.0 | Phase 0 + Phase 1 (trust) | Full suite deterministic under any wall clock; Bun on Windows green |
| 0.6.0 | Phase 2 (kernel) + WP-3.0 (timeline) | Both adapters on the kernel with byte-identical output; timeline in contract |
| 0.7.0 | Phase 3 (visual) | Dashboard v2 and terminal bars shipped, accessibility checks pass |
| 0.8.0 | Phase 4 (agent usefulness) | MCP server, `--brief`, cross-platform installer |
| 1.0.0 | Phase 5 first two adapters (OpenCode, Claude Code) | Contracts frozen at v1 and a third-party adapter passes the conformance kit |

## 2. Non-negotiable rules

WP-0.3 moves these into `docs/principles.md`. Until then this list is authoritative. A PR that
breaks one is wrong even when every test passes.

1. **Unknown cost is `null`, never `0`.** Not in JSON, text, CSV, charts, or the live view. A
   chart segment for an unknown cost is drawn hatched and labelled, never as zero height.
2. **Totals are exact sums of per-call costs.** Rounding happens only at display time, never
   before a sum.
3. **Accounting domains never merge implicitly.** Cline recorded cost, Cline account reference
   cost, Cline credits, and MCode rate-calculated cost stay separately labelled
   (`docs/architecture.md`).
4. **Token semantics belong to the adapter.** Cline `inputTokens` includes cache; MCode
   `input_tokens` excludes it. Shared code receives normalized fields only.
5. **No silent model or provider matching.** Exact > alias > normalized > glob > unknown
   (`docs/model-matching.md`). Unknown stays unknown.
6. **No secrets, prompts, or transcripts in any output.** Config holds env-var references only.
7. **Animate the chrome, never the figures.** No counting-up numbers, no interpolated values.
8. **Zero runtime dependencies.** Node >= 22.15 built-ins only (`node:sqlite`, `node:test`,
   `node:crypto`, `node:zlib`). No chart libraries, no npm packages in the skills.
9. **Dashboards are single self-contained files** under the existing strict CSP: hashed script,
   `default-src 'none'`, no network. Inline SVG and inline styles are allowed.
10. **Fixtures are hermetic.** Synthetic model names that no bundled catalog publishes, and an
    injected clock (after WP-1.1). Enforced by `tests/rate-provenance.test.mjs`.
11. **No forecasting.** Compare against the user's own history; do not predict spend.
12. **Free means free.** No feature is gated behind payment (`SUPPORT.md`).

## 3. How to execute a work package

### Repository facts you need

- `shared/*.mjs` is the source of truth for shared modules. Each is **copied** into
  `adapters/<runtime>/skill/scripts/lib/` by `scripts/sync-<name>.mjs` so each skill installs on
  its own. Never edit an adapter's `lib/` copy of a shared module. Edit `shared/`, then run
  `npm run sync:<name>`. `npm run verify` fails on drift.
- A **new** shared module needs: `shared/<name>.mjs`, `scripts/sync-<name>.mjs` (copy
  `scripts/sync-live-view.mjs` and change the name), `sync:<name>` and `check:<name>` entries in
  `package.json`, and `npm run check:<name>` added to the `verify` script.
- Entry points: `adapters/cline/skill/scripts/session-cost.mjs` (~870 lines) and
  `adapters/mcode/skill/scripts/session-cost.mjs` (~1,400 lines).
- Tests: `tests/*.test.mjs` (cross-adapter, discovered by `scripts/run-tests.mjs`) and
  `adapters/<runtime>/skill/tests/`. Fixtures: `tests/helpers/contract-fixtures.mjs`
  (`createClineFixture`, `createMCodeFixture`, `runCli`, `runJson`).
- Contracts: `contracts/*.schema.json`, validated by `scripts/validate-json-schema.mjs`. The
  report contract version is exported by `shared/report-contract.mjs`. Adding a field is a minor
  bump; renaming or removing one is major and needs a `docs/migration.md` entry.

### Definition of done (every WP)

1. `npm run verify` exits 0.
2. `npm run rehearse:release` exits 0 when the WP touches anything that ships inside a skill.
3. New behaviour has tests that **fail without the change**. Prove it once by reverting the
   change locally and watching the test fail.
4. `CHANGELOG.md` has an entry under `## Unreleased`, and it explains *why* as well as what.
5. User-visible flags appear in both `--help` texts, both `USAGE.md` files, and both `SKILL.md`
   files where relevant.
6. The PR description lists which non-negotiable rules the change touches and how it keeps them.

### Working rules for agents

- One WP per PR. When a WP turns out bigger than expected, split it and say so in the PR.
- Read every file listed under **Files** before editing.
- Never weaken an existing assertion to make a test pass. When an existing test fails, work out
  whether the test or the code is wrong and write the reason in the PR.
- When the WP text contradicts the code, the code is the truth. Record the discrepancy in the PR.
- Do not add dependencies. Do not change public JSON field names outside a WP that says to.

## 4. Dependency graph

```text
Phase 0  WP-0.1 --- WP-0.2 --- WP-0.3                    (hygiene, parallel)
Phase 1  WP-1.1 (clock) --> WP-1.2 (golden) --> WP-1.3 (invariants)
         WP-1.4 (schema drift)   WP-1.5 (Bun/Windows)   WP-1.6 (fuzz)   (parallel)
Phase 2  WP-2.1 (kernel) --> WP-2.2 (port MCode) --> WP-2.3 (port Cline) --> WP-2.4 (conformance kit)
Phase 3  WP-3.0 (timeline contract) --> WP-3.1 (SVG lib) --> WP-3.2 (dashboard v2)
                                                        \--> WP-3.3 (terminal bars)
         WP-3.4 (theme/a11y), WP-3.5 (share card): after WP-3.1
Phase 4  WP-4.1 (--brief) --> WP-4.2 (MCP server)
         WP-4.3 (installer)  WP-4.4 (notify hooks)  WP-4.5 (perf budget)   (parallel, after Phase 2)
Phase 5  WP-5.1 OpenCode, WP-5.2 Claude Code, WP-5.3 Codex, WP-5.4 Qwen/Goose  (need WP-2.4)
```

WP-1.1 and WP-2.1 are the two critical-path items. Start them first.

---

## Phase 0 - Hygiene (small, parallel, do first)

### WP-0.1 Land the in-flight work

- **Why:** PR #61 (live-view motion) went green on 2026-09-26, but the wall-clock test failure
  fixed on `cline/a80mnkw4` would turn it red on a re-run today. Stale green checks are not
  evidence.
- **Steps:** Merge the fixture fix first. Rebase #61 onto `main`, re-run CI, and merge only on a
  fresh green run.
- **Done when:** `main` contains both and CI on `main` is green on a run started after the merge.

### WP-0.2 Sync tracking with reality

- **Why:** Roadmap issue #21 still has open checkboxes for work that shipped (Phase 1.5 docs and
  driver fixtures) and claims 235 tests; the suite has 335. README says `session-cost 0.3.0` in
  the `--version` example; the package is 0.4.1.
- **Steps:** Tick the shipped checkboxes in #21, update the test count, and link this plan.
  Fix the README version example.
- **Done when:** Every checkbox in #21 matches the code, and a `check:docs` assertion ties the
  README version example to `package.json` so it cannot drift again.

### WP-0.3 Write the principles down

- **Why:** The CHANGELOG cites "non-negotiable rule 1", but no document lists the rules. Agents
  cannot follow rules they cannot find.
- **Files:** new `docs/principles.md`; `CONTRIBUTING.md`; `scripts/check-docs.mjs`.
- **Steps:** Copy section 2 of this plan into `docs/principles.md`, numbered and stable, with a
  one-line rationale and a link to the enforcing test for each rule. Link it from
  `CONTRIBUTING.md` and `README.md`. Add it to the `documents` list in `check-docs.mjs`.
- **Done when:** Every rule links to at least one test or check, or is explicitly marked
  "review-enforced".

---

## Phase 1 - Trust: make every test deterministic and every number provable

### WP-1.1 Injectable clock (critical path)

- **Why:** About 25 `Date.now()` / `new Date()` calls in shared and entry-point code, plus
  fixtures built from `Date.now()`, make output depend on the day. That is how
  `rate-provenance.test.mjs` flipped from pass to fail with no code change.
- **Design:** Add `shared/clock.mjs`:
  ```js
  export function now() {            // milliseconds since epoch
    const fixed = process.env.SESSION_COST_NOW;
    if (fixed === undefined) return Date.now();
    const ms = Date.parse(fixed);
    if (!Number.isFinite(ms)) throw new Error('SESSION_COST_NOW must be an ISO-8601 timestamp');
    return ms;
  }
  export const nowDate = () => new Date(now());
  ```
  Reject invalid values loudly; never fall back to the real clock. Undocumented for end users
  (tests and debugging only), but listed in `docs/configuration.md` under "Diagnostics".
- **Steps:**
  1. Add the module and its sync script.
  2. Replace every `Date.now()` and argument-less `new Date()` in `shared/` and both entry
     points with `now()` / `nowDate()`. Find them with
     `grep -rn 'Date.now()\|new Date()' shared adapters/*/skill/scripts`.
     Leave `--watch` interval timing on the real clock; only *reported* time uses `now()`.
  3. Give the fixture helpers a fixed epoch (for example `2026-06-15T12:00:00.000Z`) and pass
     `SESSION_COST_NOW` through `runCli`'s environment by default.
  4. Add `tests/clock-determinism.test.mjs` with three tests:
     - Build a fixture, run the same report twice a second apart with the same
       `SESSION_COST_NOW`, and assert byte-identical JSON (no field may be deleted to pass).
     - Run with `SESSION_COST_NOW` one year after the fixture epoch and assert that `--today`
       selects nothing, which proves the reported clock really comes from the variable.
     - A source scan: read every file in `shared/` and both entry points and fail on a raw
       `Date.now()` or argument-less `new Date()` unless the line has the comment
       `// clock: real-time`. That comment is the allow-list for watch-loop timing.
- **Pitfalls:** `--today` means "today in UTC" and must use `now()`. Do not change the meaning of
  UTC day boundaries.
- **Done when:** The source-scan test passes, and the whole suite passes with `SESSION_COST_NOW`
  unset *and* with it set to a date a year in the future.

### WP-1.2 Golden output tests

- **Depends on:** WP-1.1.
- **Why:** Text, CSV, and HTML are asserted with `includes()` spot checks, so layout regressions
  (misaligned tables, a lost row) pass. Every visual WP in Phase 3 needs a safety net.
- **Design:** `tests/golden/<adapter>-<scenario>.<txt|csv|json|html>` checked in.
  `tests/golden.test.mjs` renders each scenario with a fixed `SESSION_COST_NOW` and compares.
  `UPDATE_GOLDEN=1 npm test` rewrites the files. Normalize only what is truly nondeterministic:
  temp-directory paths (replace with `<DATA_DIR>`) and the HTML script hash.
- **Scenarios (minimum):** single session, `--include-children`, `--list 5`, `--compare`,
  `--rollup daily`, `--explain`, `--csv`, `--rates` (MCode), partial coverage, fully unpriced,
  and `--dashboard`.
- **Done when:** Deliberately misaligning one table column fails a golden test with a readable
  diff (print the first differing line with line numbers).

### WP-1.3 Accounting invariant tests

- **Depends on:** WP-1.1.
- **Why:** The worst bugs in this repo's history produced plausible numbers, not crashes: peak
  calls priced off-peak, cache writes double-counted in CSV, `$0.0000` for unknown cost.
  Invariants catch that class generically.
- **Design:** `tests/invariants.test.mjs` generates many random synthetic ledgers with a seeded
  PRNG (write a 10-line mulberry32; no dependencies) and asserts, for every report:
  1. `billing.amountUsd` equals the sum of per-model costs, which equals the sum of per-session
     costs, exactly or within 1e-12 for floating-point sums.
  2. When any contributing call is unpriced, `billing.amountUsd` is `null` or coverage is
     `partial` with named reasons. Never `0` with calls present.
  3. Token totals reconcile: `total = input + output` under the adapter's own semantics.
  4. `--include-children` counts each descendant exactly once (compare against a set union).
  5. JSON, CSV, and text report the same total for the same selection.
  6. Reordering ledger rows does not change any figure.
- **Pitfalls:** Print the seed on failure so the case can be replayed with `INVARIANT_SEED=<n>`.
- **Done when:** Reintroducing any one of the three historical bugs listed in the CHANGELOG
  (for example, pricing an ISO timestamp as off-peak) fails at least one invariant.

### WP-1.4 Runtime schema-drift detection

- **Why:** Both runtimes can change their SQLite schema or JSON layout on any release. Today a
  renamed column most likely reads as missing data, which is the silent-zero failure mode.
- **Design:** Each adapter declares the columns and fields it reads, in one place, as data. At
  open time it compares them with `PRAGMA table_info(<table>)` and the first parsed record.
  - Missing required column: fail with one readable line naming the table, the column, and the
    detected runtime version if available.
  - Unknown extra columns: allowed, and surfaced in `doctor` as "schema newer than tested".
  - Add a `schema` block to `doctor --json` with the fingerprint of the observed schema.
- **Done when:** A fixture with a renamed column fails loudly in both adapters, and `doctor`
  reports schema evidence.

### WP-1.5 Bun on Windows

- **Why:** `CONTRIBUTING.md` records 11 tests failing on Bun/Windows with `EBUSY` because fixtures
  delete a directory whose SQLite handle is still open.
- **Steps:** Audit every `DatabaseSync` open in the adapters and make sure each is closed on all
  paths (`try { ... } finally { db.close(); }`). In tests, remove temp directories in `t.after`
  with `fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })`.
  Add a `bun (windows-latest)` job to `.github/workflows/ci.yml`, SHA-pinned like the others.
- **Done when:** The new job is green, and the paragraph in `CONTRIBUTING.md` about the known
  failure is removed.

### WP-1.6 Parser fuzzing for hostile input

- **Why:** Session files can be torn mid-write, and pricing pages are untrusted network input.
- **Design:** `tests/fuzz.test.mjs` with a seeded PRNG mutates valid inputs (truncate at every
  byte offset for small files, flip bytes, inject huge numbers, NaN strings, negative tokens) for:
  MCode `messages.jsonl`, Cline message JSON, the CommandCode and StepFun rate parsers, and
  config files. Assert: no uncaught exception, no stack trace on stderr, and never a finite cost
  derived from a corrupt field.
- **Done when:** 2,000 iterations per target run in under 10 seconds in CI.

---

## Phase 2 - Reach foundation: a shared CLI kernel

### WP-2.1 Define the runtime-adapter interface and kernel (critical path)

- **Why:** Both entry points define `parseArgs`, `loadConfig`, `parseDate`, `runSetup`,
  `runDiagnostic`, and `handleConfigAction`, and each has its own `main()` dispatching the same
  modes (`--list`, `--compare`, `--rollup`, `--csv`, `--budget`, `--watch`, `--dashboard`, and
  others). Every new mode is written twice, and every new runtime would add a third copy.
- **Design:** Add `shared/kernel.mjs`. The kernel owns argument parsing (through the existing
  `shared/cli-args.mjs`), selection, mode dispatch, rendering, and exit codes. A runtime adapter
  becomes a plain object:
  ```js
  /** @typedef {object} RuntimeAdapter */
  export default {
    id: 'mcode',                       // stable, lowercase
    displayName: 'MiniMax Code',
    costBasis: 'rate-calculated',      // or 'runtime-recorded'
    defaultDataDir(env) {},            // string
    open(dataDir, options) {},         // returns a handle; must be closable
    close(handle) {},
    listSessions(handle) {},           // [{ id, parentId, startedAt, title, provider, model }]
    resolveCurrent(handle, env) {},    // { sessionId, method, candidates } - never guesses
    buildReport(handle, sessionId, { includeChildren }) {},  // normalized report v1
    aggregate(reports, context) {},    // normalized aggregate report
    extraModes: {},                    // runtime-only modes, e.g. { rates, account }
    helpLines: [],                     // runtime-specific help lines
  };
  ```
  `buildReport` must return a report that passes `shared/report-contract.mjs` validation. The
  kernel rejects an adapter object with missing members before it runs anything.
- **Steps:**
  1. Write `shared/kernel.mjs` with `runCli(adapter, argv, env, io)`, where
     `io = { stdout, stderr }` so tests can capture output without spawning a process.
  2. Write `tests/kernel.test.mjs` against a tiny in-memory fake adapter (no SQLite). Cover every
     mode and every exit code.
  3. Do **not** port a real adapter in this WP.
- **Done when:** The fake adapter supports every shared mode, and the kernel is below 600 lines.

### WP-2.2 Port MCode onto the kernel

- **Depends on:** WP-2.1 and WP-1.2 (golden tests are the safety net).
- **Steps:** Move MCode-specific logic (ledger reads, pricer, `--rates`, `--refresh-rates`) into
  `adapters/mcode/skill/scripts/lib/runtime.mjs` implementing the interface. Reduce
  `session-cost.mjs` to about 20 lines: import the kernel and the adapter, then call `runCli`.
- **Done when:** Every golden file is byte-identical before and after, with no golden update in
  the diff. Any intended output change belongs in a separate PR.

### WP-2.3 Port Cline onto the kernel

- Same as WP-2.2, with `--account` as a Cline `extraModes` entry. The accounting-domain
  separation (rule 3) must stay visible in the code: account data never flows into `billing`.

### WP-2.4 Adapter conformance kit

- **Depends on:** WP-2.3.
- **Why:** Issue #21 says "an adapter must pass the shared usage, selection, session-graph, and
  cost-domain contracts before it is accepted". Make that one runnable command.
- **Design:** `tests/conformance/run-conformance.mjs <adapter-module> <fixture-factory>` runs a
  fixed battery against any adapter: contract validity, explicit and current selection, ambiguity
  refusal, child inclusion exactly once, unknown cost stays `null`, torn final record tolerated,
  CSV/JSON/text totals agree, and the invariants from WP-1.3. Both existing adapters must pass it.
  Document it in `docs/adapter-authoring.md` with a worked example.
- **Done when:** A new adapter's acceptance test is one line calling the kit.

---

## Phase 3 - Sight: visually rich, still exact

The dashboard today is a styled page with KPI cards and tables: no charts (0 `<svg>`, 0
`<canvas>` in generated output). The terminal report is plain text. The live view got motion in
PR #61. This phase adds real visualization without dependencies and without breaking rule 1.

### Visual rules for this phase

- Charts are **inline SVG generated in Node** at render time, not drawn in the browser. Static
  SVG needs no extra script, works with JavaScript disabled, prints well, and is covered by the
  existing CSP (`style-src 'unsafe-inline'`, and inline SVG needs no `img-src`).
- Every chart has: a `<title>` and `<desc>`, a visible text label for every figure it encodes,
  and a data table next to it (inside `<details>`) with the same numbers. A chart is never the
  only place a number appears.
- Unknown cost is drawn as a hatched segment (an SVG `<pattern>`) labelled "unpriced", with
  zero-height bars forbidden for unknown values. Partial coverage gets a visible badge.
- Colour is never the only channel: pair colour with a pattern, a label, or a position. Use the
  existing CSS custom properties (`--accent`, `--accent-2`, `--warning`, `--danger`) so themes
  work. Minimum contrast 4.5:1 for text and 3:1 for chart marks against the background.
- Respect `prefers-reduced-motion`; hover highlights are fine, entry animations are not.

### WP-3.0 Per-call timeline in the report contract

- **Why:** Reports expose `calls` as a count. A cost-over-time chart, a cache-rate trend, or a
  "where did the money go in this session" view needs time-ordered events.
- **Design:** Add an optional `timeline` array to `contracts/normalized-report-v1.schema.json`
  (minor version bump):
  ```json
  { "t": "2026-06-15T12:00:01.000Z", "sessionId": "...", "model": "...", "provider": "...",
    "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "costUsd": 0.0012 }
  ```
  `costUsd` is `null` when that call is unpriced. Bound the array: when a report has more than
  2,000 calls, emit fixed-width time buckets instead, with `"bucketed": true` and the bucket
  width in a `timelineMeta` object. Never silently drop calls: bucket sums must equal the totals.
  Only `--json` and `--dashboard` emit it; the text report is unchanged.
- **Done when:** Both adapters emit it, a test asserts that the sum of `costUsd` equals
  `billing.amountUsd` whenever coverage is complete, and the WP-1.3 invariants include the
  timeline.

### WP-3.1 Zero-dependency SVG chart module

- **Depends on:** WP-3.0.
- **Design:** `shared/charts.mjs` exporting pure functions that return SVG strings:
  - `barChart({ rows: [{ label, value, unknown }], width, height, format })`, horizontal bars;
  - `stackedBar({ segments: [{ label, value, className }] })` for the token mix;
  - `lineChart({ points: [{ t, value }], width, height })` for cumulative cost over time;
  - `heatmap({ days: [{ date, value }] })` for a calendar of daily spend;
  - `donut({ segments })` for model share, limited to 8 segments with the rest as "other".
  Every string that goes into the SVG passes through one `escapeXml()`. The module never
  computes money: it receives already-computed figures.
- **Tests:** Golden SVG output for each function; an XSS test that feeds `<script>` and
  `"onload=` through every label; all-zero, single-point, empty, and all-unknown inputs render
  a labelled "no data" state instead of throwing or drawing a misleading shape.
- **Done when:** Under 500 lines, with no `innerHTML`, no `eval`, and no network.

### WP-3.2 Dashboard v2

- **Depends on:** WP-3.1.
- **Layout, top to bottom:**
  1. Hero: total cost (or "unavailable" with the reason), coverage badge, tokens, cache-hit
     rate, call count, snapshot time. Exact figures, as in the text report.
  2. Cumulative cost over time (line chart from `timeline`), with model switches as vertical
     markers.
  3. Token mix stacked bar: fresh input, cache read, cache write, output. Each segment shows its
     share and its cost.
  4. Cost by model (bar chart) and share of spend (donut) side by side.
  5. Subagent tree: the session graph as a nested list with a cost per node and a bar for its
     share, showing excluded children in muted style with "excluded".
  6. For range and aggregate dashboards: a daily spend heatmap and a top-10 sessions bar chart.
  7. Rate provenance: collapsible, with fingerprints.
- **Also:** A print stylesheet (`@media print`) so the page prints to a clean PDF report.
- **Done when:** Golden HTML updated; the existing CSP and DOM-sink safety checks still pass;
  the generated file for a 2,000-call session stays below 500 KB.

### WP-3.3 Terminal visuals

- **Depends on:** WP-3.1 only for shared formatting helpers; it can run alongside WP-3.2.
- **Design:** Add Unicode bars to the default text report:
  - token mix as a one-line stacked bar (`█▓▒░`) with a legend;
  - a per-model cost bar using eighth-blocks (`▏▎▍▌▋▊▉█`) for sub-character precision;
  - `--list` gets a cost bar column and a sparkline of each session's cumulative cost.
  Colour only when `stdout.isTTY` and `NO_COLOR` is unset; honour `FORCE_COLOR`. Width comes
  from `process.stdout.columns`, clamped to 60..120, falling back to 80. Reuse `visibleLength`
  from `shared/live-view.mjs` for padding (it ignores escape codes).
  `--plain` disables all bars and colour for screen readers and for pasting into issues.
- **Pitfalls:** Golden tests render with `NO_COLOR=1` and a fixed width. Add one golden with
  colour forced so escape sequences are also pinned. Windows Terminal renders these glyphs;
  legacy `cmd.exe` code pages may not, so `--plain` is the documented fallback.
- **Done when:** The bar for a model is exactly proportional to its share of *known* cost, and
  an unpriced model shows `unpriced` instead of a bar.

### WP-3.4 Themes and accessibility audit

- **Depends on:** WP-3.2.
- **Steps:** The dashboard already has a theme toggle. Add a light theme that passes the contrast
  requirements above, a high-contrast theme, and default to `prefers-color-scheme`. Add a test
  that parses the CSS custom properties for each theme and computes WCAG contrast ratios for
  text/background and chart/background pairs. Make every interactive control keyboard-reachable
  with a visible focus ring.
- **Done when:** The contrast test passes for all three themes.

### WP-3.5 Shareable summary card

- **Depends on:** WP-3.1.
- **Why:** People share what they can screenshot. A tidy summary card spreads the tool.
- **Design:** `--card` writes a standalone SVG (1200x630, the Open Graph size) with the total,
  token mix bar, cache rate, top models, date, and the tool name. **Privacy by default:** no
  session title, prompt, path, or ID unless `--card-include-title` is passed.
- **Done when:** Golden SVG, a test that fixture titles never appear without the flag, and the
  card opens correctly in a browser and in an SVG viewer.

---

## Phase 4 - Usefulness: meet agents and users where they are

### WP-4.1 `--brief` agent-oriented output

- **Why:** The skill's main consumer is an agent answering "what did this cost?". The full report
  is long and full of fingerprints, so agents spend tokens reading it and sometimes misquote it.
- **Design:** `--brief` prints at most 6 lines: cost with coverage, tokens, cache rate, top
  model, subagent inclusion, and one warning if any. `--brief --json` returns a stable,
  documented subset of the report. Update both `SKILL.md` procedures to use `--brief` first and
  the full report only when the user asks for detail. This also cuts `SKILL.md` length; the
  MCode one is 13.5 KB, which costs tokens every time an agent loads it.
- **Done when:** A golden test pins the brief format, and both `SKILL.md` files are shorter.

### WP-4.2 MCP server

- **Depends on:** WP-2.3 (the kernel) and WP-4.1.
- **Why:** MCP lets every MCP-capable agent (Cline, Claude Code, Cursor, and others) query cost as
  a tool, which reaches far more users than per-runtime skills.
- **Design:** `mcp/server.mjs` implementing MCP over stdio (JSON-RPC 2.0, newline-delimited)
  with Node built-ins only. Tools: `session_cost` (brief by default), `list_sessions`,
  `cost_rollup`, `explain_cost`, `rate_coverage`. Each tool's input is validated against a JSON
  schema; each result carries the normalized report fields. Read-only: no tool writes config,
  refreshes rates, or makes a network call.
- **Pitfalls:** Nothing but protocol messages may go to stdout, so all logging goes to stderr.
  Follow the current MCP specification for the initialize handshake and the `tools/list` and
  `tools/call` methods, and pin the protocol version you implement in a constant.
- **Done when:** An integration test spawns the server, performs the handshake, lists tools,
  and calls each one against fixtures; the README has copy-paste config for at least two clients.

### WP-4.3 Cross-platform installer and paths

- **Why:** The README only documents Windows paths and PowerShell `Copy-Item`. macOS and Linux
  are in the CI matrix but have no install story.
- **Design:** `scripts/install.mjs --runtime cline|mcode [--target <dir>] [--dry-run]`,
  resolving the default skill directory per platform with `os.homedir()`. It keeps MCode's
  refreshed rate file across updates (the step `docs/migration.md` currently describes by hand),
  verifies the archive checksum when installing from a release, and prints what it changed.
  Document POSIX paths in the README and both `USAGE.md` files.
- **Done when:** The release rehearsal runs the installer on ubuntu and windows, and an update
  keeps refreshed rates.

### WP-4.4 Budget notifications

- **Depends on:** Phase 2.
- **Design:** Extend `--budget` and `--watch` with `--notify`: when a threshold is crossed during
  `--watch`, emit a terminal bell and, when available, a desktop notification through the
  platform's own command (`osascript` on macOS, `notify-send` on Linux, a PowerShell toast on
  Windows), called with argument arrays, never a shell string. Missing notifier: warn once and
  continue. Unknown cost never triggers a budget alert (it has no severity; see rule 1).
- **Done when:** Tests inject a fake notifier and assert exactly one alert per threshold
  crossing.

### WP-4.5 Performance budget

- **Why:** Heavy users have thousands of sessions. `--list`, `--rollup`, and `--dashboard` over a
  large history must stay fast, and `shared/rollup-cache.mjs` exists but has no benchmark.
- **Design:** `scripts/bench.mjs` generates a synthetic ledger (10,000 sessions and 500,000
  calls), then times `--list 20`, `--rollup daily`, a range `--dashboard`, and a single session.
  Record budgets in the script: single session < 300 ms, `--list 20` < 1 s, rollup < 2 s with a
  warm cache. Run it in CI on ubuntu as a non-blocking job that posts timings to the job summary.
- **Done when:** Budgets are met or each miss has an issue with a profile attached.

---

## Phase 5 - Reach: more runtimes

Each adapter is one WP, requires WP-2.4 (conformance kit), and follows the existing issue's
acceptance criteria. Every adapter must: implement the Phase 2 interface, pass the conformance
kit, ship synthetic fixtures (never real transcripts), label its cost basis honestly, and install
under a unique skill ID (for example `session-cost-opencode`) so it cannot collide with another
runtime's skill directory.

| WP | Issue | Runtime | Main risk to handle |
| --- | --- | --- | --- |
| WP-5.1 | #15 | OpenCode | Plugin path versus SQLite fallback; validate the schema before querying |
| WP-5.2 | #19 | Claude Code (experimental) | Duplicate assistant records; subscription versus API cost modes |
| WP-5.3 | #18 | Codex CLI | Never sum cumulative fields; `.jsonl.zst` needs a decoder |
| WP-5.4 | #16, #17 | Qwen Code, Goose | Coverage-aware fallbacks; explicit cost provenance |
| WP-5.5 | #20 | Others | Decision records only; no adapter without a "go" decision |

Order: OpenCode first (it has an official API, so the risk is lowest), then Claude Code (largest
user base), then Codex. WP-5.3 note: `node:zlib` provides `zstdDecompressSync` (confirmed on Node 24;
believed backported to 22.15, the project floor, but verify that first), and it is marked
experimental. Feature-detect
it with `typeof zlib.zstdDecompressSync === 'function'`, add a CI assertion on Node 22.15 that it
exists, and if it is ever missing, report `.zst` files as "unsupported on this Node version"
instead of adding a dependency (rule 8). Also decode streaming, because rollouts can be large.

---

## 5. Risk register

| Risk | Impact | Mitigation |
| --- | --- | --- |
| A runtime changes its storage schema | Silent wrong totals | WP-1.4 drift detection; the conformance kit; fixtures per schema version |
| Kernel port changes output | Users see different numbers | WP-1.2 goldens must be byte-identical in WP-2.2 and WP-2.3 |
| Charts show a figure the ledger does not support | Loss of the core trust advantage | Charts receive only computed figures; WP-1.3 invariants cover the timeline |
| Scope creep into forecasting and "AI insights" | Guessed numbers | Rule 11 |
| Dashboard file grows too large | Slow or unusable | Timeline bucketing (WP-3.0); size budget in WP-3.2 |
| Too many adapters to maintain | Stale adapters produce wrong totals | WP-5.5 go/defer records; drift detection turns breakage into loud failures |
| MCP spec changes | Server stops working with clients | Pin the protocol version; one integration test per method |

## 6. Ready-to-run task queue

Hand these to agents in order. Items on the same line can run in parallel.

1. WP-0.1, WP-0.2, WP-0.3
2. WP-1.1 | WP-1.4 | WP-1.5 | WP-1.6
3. WP-1.2 | WP-1.3
4. WP-2.1 | WP-3.0 (the contract addition does not depend on the kernel)
5. WP-2.2, then WP-2.3 | WP-3.1
6. WP-2.4 | WP-3.2 | WP-3.3 | WP-4.1
7. WP-3.4 | WP-3.5 | WP-4.2 | WP-4.3 | WP-4.4 | WP-4.5
8. WP-5.1, then WP-5.2, then WP-5.3 and WP-5.4

When you hand a WP to an agent, give it: this file, the WP's section, `docs/principles.md` (after
WP-0.3), and the instruction "Follow section 3. Stop and report if the code contradicts the WP."
