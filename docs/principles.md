# Principles

The rules this project does not trade. They exist because each one was learned the expensive
way: a plausible wrong number that nobody could trace. Every rule below links to the test or
check that enforces it. A change that breaks one of them is wrong even when the whole suite
passes — if a rule cannot be enforced by a test, it is marked review-enforced and a reviewer is
the enforcement.

Read this before changing anything in `shared/` or an adapter's `scripts/`.

## Money

### 1. Unknown cost is `null`, never `0`

Not in JSON, text, CSV, the live view, or a chart. A tool that prints `$0.0000` for a session it
could not price is worse than one that prints nothing, because the reader takes it as "this was
free".

Enforced by `tests/real-report-shapes.test.mjs` ("an unmeasurable session cost stays null rather
than becoming $0.00"), `tests/rate-provenance.test.mjs`, and
`tests/budget-contract.test.mjs` ("an unpriceable spend is never reported as under budget").

### 2. Totals are exact sums of per-call costs

Rounding happens at display time only, never before a sum. The live view may not animate a
figure: a cost counting up from $0.39 to $0.42 shows three numbers, and the middle ones are not
the session's cost.

Enforced by `tests/live-view-contract.test.mjs` (the only money figure permitted on a frame is
the report's own `billing.amountUsd`) and `tests/csv-contract.test.mjs`.

### 3. Accounting domains never merge implicitly

Cline recorded session cost, Cline account reference cost, Cline credits used, and MCode
rate-calculated cost are four different things. They stay separately labelled and separately
reported. `--account` never merges with the local session total.

Enforced by `tests/aggregate-contract.test.mjs` and `tests/budget-contract.test.mjs` ("an
estimate is never phrased as a charge, and a charge is never phrased as an estimate").

### 4. No silent model or provider matching

Precedence is exact ID, then configured alias, then normalized exact ID, then configured glob,
then unknown. The tool must never quietly choose a similar model, and an unknown or ambiguous
match is reported as unknown rather than resolved.

Enforced by `tests/provider-diagnostics.test.mjs` and `tests/provider-driver-contract.test.mjs`
("unknown providers and undeclared runtimes never resolve to a driver").

### 5. An unknown rate produces tokens, not a guessed cost

Enforced by `tests/rate-record-contract.test.mjs` ("an unknown model is unavailable, never
extrapolated") and `tests/budget-contract.test.mjs` ("a profile with banded records and no
declared calendar is unpriced, not guessed").

### 6. No forecasting

Compare a session against the user's own history. Do not predict what it will cost, and do not
present an estimate as a charge. Review-enforced, with `tests/insights-contract.test.mjs`
covering the "no forecasting" claims in the insights copy.

## Accounting semantics

### 7. Token semantics belong to the adapter

Cline's `inputTokens` includes cached prompt tokens. MCode's `input_tokens` does not. Shared code
receives normalized fields only, and the fresh-input formula is never shared between the two.
The two runtimes also have different cache-write semantics.

Enforced by `tests/normalized-contract.test.mjs` and `docs/architecture.md`.

### 8. Subagent sessions are counted exactly once

`--include-children` unions the descendant set; it never sums overlapping rows.

Enforced by `tests/aggregate-contract.test.mjs` ("root aggregate is end-to-end, preserves stored
cost, and is not double-counted") and `tests/cost-centres-contract.test.mjs` ("a cost centre
expands only real descendants").

## Privacy and safety

### 9. No secrets, prompts, or transcripts in any output

Configuration files hold environment-variable references, never values. Reports, dashboards, and
CSV never carry credentials, prompt text, or private transcript content.

Enforced by `tests/config-contract.test.mjs` ("configuration and reports never serialize secret
values"), `tests/cost-centres-contract.test.mjs`, and `tests/csv-contract.test.mjs` ("no
credential, prompt, or transcript content reaches any column").

### 10. A bad invocation is one readable line

No stack trace, no local path, no credential, on any error path, including a malformed ledger or
a corrupt config.

Enforced by `tests/cli-args.test.mjs` ("the parser never leaks credentials or local paths
into a usage error") and `tests/error-boundaries.test.mjs`.

### 11. Dashboards are one self-contained file under a strict CSP

No external assets, no network requests, `default-src 'none'`, script allow-listed by hash. Any
new visualisation is inline SVG or CSS, and every number a chart shows also appears as text.

Enforced by `tests/dashboard-security.test.mjs` and `npm run check:artifacts`.

## Engineering

### 12. Zero runtime dependencies

Node >= 22.15 built-ins only (`node:sqlite`, `node:test`, `node:crypto`, `node:zlib`). No npm
package may be imported by anything shipped inside a skill, including a charting library.

Enforced by `tests/budget-contract.test.mjs` ("the evaluator ships with no dependencies") and
`npm run check:artifacts`.

### 13. `shared/` is the source of truth; adapter copies are generated

Edit `shared/<module>.mjs`, then run `npm run sync:<module>`. Never hand-edit a generated copy
under `adapters/*/skill/scripts/lib/`; `npm run check:<module>` fails on drift.

Enforced by the `check:*` steps inside `npm run verify`.

### 14. The reported clock is injectable, and fixtures are hermetic

Every reported timestamp comes from `shared/clock.mjs`. A test pins it with `SESSION_COST_NOW`, so
output does not depend on the day it was produced. Fixture model names are synthetic and must not
be keys in the bundled rate table.

Enforced by `tests/clock-determinism.test.mjs` and `tests/rate-provenance.test.mjs` ("no MCode
fixture model can be priced by the bundled rate table").

### 15. Tests are discovered, never registered by hand

`scripts/run-tests.mjs` walks the test directories. A new test file runs in CI without being
listed anywhere.

Enforced by `npm test` and `scripts/check-artifacts.mjs`.

### 16. The suite is free and complete

No feature is gated behind payment, and the free software is not a reduced build. See
`SUPPORT.md`.

Review-enforced.

## Adding or changing a rule

A new rule needs a test that fails without it, added in the same pull request. If that is not
possible, say so in the pull request and mark the rule review-enforced rather than leaving it
unenforced and unexplained.
