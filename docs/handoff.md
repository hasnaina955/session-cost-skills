# Handoff: continuing this project

A starting brief for a contributor or agent picking this up with no prior context. Read this first,
then `docs/roadmap-plan.md` (section 0 is a status table).

## What this is

Local-first token and cost reporting for coding-agent CLIs. Today it reads session ledgers for
**Cline** and **MiniMax Code (MCode)** and reports what each session cost, with the exact rate
records behind every figure. MIT, **zero runtime dependencies**, Node >= 22.15.

The project's whole claim is that its numbers can be trusted. Everything else bends around that: an
unknown cost is `null`, never `0`; totals are exact sums; accounting domains are never merged.
`docs/principles.md` lists the 16 rules, each linked to the test that enforces it.

## State

| | |
| --- | --- |
| `main` | **v0.6.0, released and published**, 497 tests passing |
| Gates | `npm run verify` and `npm run rehearse:release` must both pass |
| Open PRs | none |
| Bench | `npm run bench` (regression gate), `npm run bench:quick` |
| Release | tag `v0.6.0`, three archives plus `SHA256SUMS.txt` on the GitHub release |

**Phases 0, 1, 2 and 3 are complete.** Phase 4 has three of four items done. Phase 5 (new runtimes)
is the bulk of what remains, and it is blocked on knowledge rather than code.

Note: **`v0.5.0` was merged but never tagged.** There is no release or archive for it, so the tag
history has a gap between `v0.4.1` and `v0.6.0`. Decide whether to back-tag it or leave it.

## Architecture: the one rule that bites

`shared/*.mjs` is the **source of truth**. Each module is *copied* into
`adapters/<runtime>/skill/scripts/lib/` by `npm run sync:<module>`, so each skill installs
standalone with no build step.

**Never edit an adapter's `lib/` copy.** Edit `shared/`, then run `npm run sync:<module>`. Every
`npm run check:<module>` asserts the copies match and is wired into `verify`, so drift fails the
build. A new shared module needs the module, a `scripts/sync-<name>.mjs` (copy an existing one),
and a `sync:`/`check:` pair in `package.json` with the `check:` added to `verify`.

The two entry points are ~12 lines each. The orchestrator is `shared/kernel.mjs`; a runtime's own
logic lives in `adapters/<runtime>/skill/scripts/lib/runtime.mjs`. A new runtime implements the
interface in `shared/runtime-adapter.mjs` and must pass the conformance kit.

Exception: `adapters/mcode/skill/scripts/lib/rates.mjs` is MCode-specific and is *not* synced.

## Process rules

- **One work package per PR.** Never commit to `main`. Merge only when the full CI matrix is green.
- **Never force-push an already-pushed branch** without pinning the expected SHA:
  `git push --force-with-lease=<ref>:<sha>`. An unpinned lease silently overwrites whatever is there.
- **`.github/workflows/*.yml` cannot be pushed** from an environment whose token lacks the
  `workflows` permission. The patch adding Windows to the Bun job is still unapplied; it is in the
  body of PR #65. Apply it from an account that can write workflows.
- Add a `CHANGELOG.md` entry under `## Unreleased` explaining **why**, not just what. The changelog
  is the project's memory and its entries are arguments, not bullet points.
- When a change alters printed output the golden corpus will fail. **Read every diff before
  regenerating** with `UPDATE_GOLDEN=1`. Regenerating blind is how a regression ships.

## The failure mode that has caught every serious bug

Almost every real defect here was invisible to the test suite and surfaced only by **rendering the
awkward case and reading the output**. None of these were found by a passing test:

- A fully unpriced session drawn as `$0.0000` in a chart.
- A card whose "could not be priced" note was nested inside a block that only rendered when
  something *had* been priced, so it vanished in exactly the case it existed for.
- An `unavailable` placeholder that overflowed its column at narrow widths.
- A `--list` that was quadratic in the session count: every answer correct, eleven seconds to
  produce.

So: render the unpriced, partial, empty, and narrow-width cases, and **read them**. A green suite
is not evidence that the page or the terminal output is right.

## Three more habits worth keeping

- **Measure before attributing a cause.** A performance bug was confidently explained in an issue as
  "builds a full report per session". Measuring the phases showed the cost was elsewhere entirely,
  in a quadratic scan in `shared/session-graph.mjs`. A plausible attribution in a bug report is a
  guess wearing a lab coat.
- **Anchor a test to an independent witness.** Comparing two values that come from the same
  accumulator proves nothing: a doubled cache-write count appeared on both sides and passed. Read
  the ledger in SQL instead. `tests/invariants.test.mjs` shows the pattern.
- **Bump `CACHE_VERSION`** in `shared/rollup-cache.mjs` whenever a cached value's shape changes, or
  code expecting the new shape reads old entries.

## Features that exist

`--brief` (short answer; `--json` gives a stable `session-brief` shape), `--card` (a shareable
SVG summary, private unless `--card-include-title`), `--list`, `--rollup`, `--top`, `--explain`,
`--csv`, `--budget`, `--counterfactual`, `--insights`, `--watch`, `--dashboard`, `--rates`,
`--refresh-rates`, `doctor`, `providers`, `models discover`, `config explain`, plus
date/provider/model filters and `--include-children`.

An MCode `--json` report also carries a bounded `timeline` of per-call events. The dashboard renders
server-side inline SVG (cost over time, token mix, cost by model, session tree) and the plain-text
report carries token-mix and per-model bars.

## Actionable now, no external knowledge needed

1. **WP-4.4: budget notifications.** `--notify` on `--budget` and `--watch`, emitting a terminal
   bell and, where available, a desktop notification through the platform's own command
   (`osascript` on macOS, `notify-send` on Linux, a PowerShell toast on Windows), called with
   argument arrays rather than a shell string. A missing notifier warns once and continues, and an
   unknown cost never triggers an alert because it has no severity. Test it by injecting a fake
   notifier and asserting exactly one alert per threshold crossing.
2. **The range-path cache: measured, and deliberately not done.** `--list N --rollup` is
   already cached and runs ~8x faster warm (8.8s to 1.1s over 200 sessions). The range mode -
   `--from/--to`, `--today`, dashboards over a range - is not cached, and measured at 1.4s cold
   *and* warm over a 30-day window, because the quadratic fixed in #87 was the dominant cost there
   too. Wiring the cache in would add invalidation complexity to a path that already answers in
   under two seconds, so it stays unwired. Revisit only if `npm run bench` shows the range path
   regressing.
3. **Someone should look at the redesigned dashboard.** It was rebuilt as a modern flat report -
   bento grid, hairline borders, no shadows, collapsed raw data - and verified *structurally* (both
   themes contrast-clean, the no-JS path renders its figures, 497 tests pass). Nobody has judged
   how it looks. Open a generated `session-dashboard.html` and tune the tokens or the grid spans if
   the aesthetic is off; that is the one part of this work no test can settle.
4. Anything in `docs/roadmap-plan.md` under WP-4.x that needs no external facts.

## Blocked, and what unblocks it

Every remaining major item needs knowledge that cannot be inferred from this repository. Guessing a
storage schema produces *plausible, wrong* numbers, which is the failure this project exists to
prevent - so these stay blocked rather than guessed.

| Item | Needs |
| --- | --- |
| **#77** CommandCode CLI/desktop adapter | Session storage path per OS, format, per-call fields, whether a stored cost is a charge or needs pricing, parent/child linkage, whether `input` includes cached tokens, and the mod/plugin API |
| **#15** OpenCode | Same class of facts. A branch `feature/opencode-adapter` holds ~7,300 lines of implementation that is now ~10 releases stale; decide whether to rebase it onto the kernel or start fresh |
| **#16-#20** Qwen, Goose, Codex, Claude Code, others | Per-runtime storage layout |
| **WP-4.2** MCP server | Verification of the MCP spec against the real specification. A wrong implementation fails to connect rather than reporting a wrong number, so it is lower risk than an adapter, but it still needs the spec read properly |

A `PRAGMA table_info` dump or one redacted session file settles most of the adapter questions.

## Branches on origin that are not mine

`archive/stale-clone-2026-09-28`, `feature/opencode-adapter`, `wp-2-close-phase-2` and
`wp-2.4-conformance-kit` came from outside work. Leave them unless their owner says otherwise.
