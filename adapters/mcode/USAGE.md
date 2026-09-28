# MCode session-cost usage reference

Install location:

```text
%USERPROFILE%\.minimax\skills\session-cost\
```

## Quick start

```powershell
$SessionCost = "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs"
node $SessionCost
```

## Command matrix

| Command | Meaning |
| --- | --- |
| `node $SessionCost` | Current/latest ledger session |
| `--session <id>` | Specific `mvs_...` session |
| `--last` | Latest completed session |
| `--today` | Sessions started today (UTC) |
| `--compare` | Compare the latest two sessions |
| `--from <date>` / `--to <date>` | UTC date-range filter |
| `--provider <name>` | Provider substring filter |
| `--model <name>` | Model substring filter |
| `--include-children` | Bill subagent sessions |
| `--list [n]` | Recent sessions, default 10 |
| `--rates` | Rate coverage and freshness |
| `--dashboard` | Write a self-contained HTML dashboard |
| `--out <path>` | Dashboard output path |
| `--refresh-rates` | Re-fetch mirrored provider rates |
| `--json` | Versioned JSON |
| `--config <path>` | Standing-summary config |
| `--data-dir <path>` | Override MCode data directory |
| `--help` / `-h` | CLI help |

## Session modes

```powershell
node $SessionCost
node $SessionCost --last
node $SessionCost --today
node $SessionCost --compare
node $SessionCost --session mvs_xxxx
```

## Filters

```powershell
node $SessionCost --from 2026-09-01 --to 2026-09-30
node $SessionCost --provider commandcode
node $SessionCost --model deepseek
node $SessionCost --provider stepfun --model step-5-preview
```

When several sessions match, the command returns an aggregate priced by the same rate engine.

## Rate coverage

```powershell
node $SessionCost --rates
node $SessionCost --rates --json
node $SessionCost --refresh-rates
```

`--rates` reports mirrored providers, model counts, sources, parser/fetch timestamps, component
completeness, and free-model entries without reading the session ledger. A numeric zero is shown as
an explicit published rate; a missing component is shown as `missing`/`null`, never as a free rate.
`--refresh-rates` parses structured source payloads, validates required components and duplicate
ids, and writes the complete replacement table with a temporary file plus atomic rename. If any
source is incomplete or fails, the command reports the rejection, exits nonzero, and keeps the
previous valid table.

## Rate cards and cost domains

The mirrored table is a versioned rate-card catalog. Records include the source URL/version,
fetch timestamp, rate-card fingerprint, currency/unit, effective dates, UTC time band, and context
threshold when the provider publishes them. CommandCode context thresholds are selected when a
call has reliable context tokens; otherwise the highest published rate for each component is used
as a conservative bound and the result is marked `pricingExact: false`. Promotions are selected
by call timestamp and retain explicit list/revert rates when available.

`--json` keeps these values separate:

```json
{
  "billing": {
    "rateCalculatedCostUsd": 4.75,
    "apiEquivalentCostUsd": 4.75,
    "recordedCostUsd": 0,
    "pricingCoverage": "complete",
    "pricingExact": false
  }
}
```

`recordedCostUsd` is the numeric `cost_usd` stored in the MCode ledger (an explicit zero remains
zero); it is not replaced with the estimate. `rateCalculatedCostUsd` and `apiEquivalentCostUsd`
are public-rate/API-equivalent estimates, not an invoice or provider charge. If a model or token
component is missing, the complete estimate is `null`; any known-component subtotal is exposed
separately as `partialRateCalculatedCostUsd` with partial coverage metadata.

## Subagents

```powershell
node $SessionCost --include-children
node $SessionCost --session mvs_xxxx --include-children
```

## Config

`%USERPROFILE%\.minimax\session-cost.json`:

```json
{
  "standingSummary": true,
  "includeChildren": true,
  "defaultFormat": "compact",
  "warnOnCacheRateBelow": 0.6
}
```

## Accounting semantics that must not change

- `input_tokens` is fresh input and excludes cached tokens.
- Total prompt = input + cache read + cache write.
- Cost is calculated from mirrored provider rates, never from the ledger's placeholder `cost_usd`.
- `cacheWrite` is parsed from the source; explicit `0` and missing `null` are different states.
- StepFun `step-5-preview` uses its explicitly documented input-rate cache-write rule; other
  unpublished write rates remain unknown.
- CommandCode peak/off-peak bands, context thresholds, effective dates, and promotions are selected
  per call. Unknown context uses a conservative highest-tier estimate, not an exact claim.
- Unknown provider/model rates or incomplete token-rate components produce tokens plus explicit
  partial/unknown coverage, never a guessed zero.
- A session can change model or provider midway.

## Dashboard export

```powershell
node $SessionCost --dashboard
node $SessionCost --rates --dashboard
node $SessionCost --dashboard --out C:\path\to\mcode-dashboard.html
```

Default outputs:

```text
%USERPROFILE%\.minimax\reports\session-cost\session-dashboard.html
%USERPROFILE%\.minimax\reports\session-cost\rates-dashboard.html
```

The HTML is self-contained and does not load external assets.

## Account API

MCode has no Cline account API mode. Use `--rates` for provider coverage instead. Cline’s
`--account` values are not applicable to MCode sessions.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| `cost unavailable` | Run `--rates`; add or refresh the provider rate; unknown cost is `null` |
| `rate unknown` or `partial-rate-estimate` | Read `pricingCoverage`, `missingRateComponents`, and `componentCompleteness` in JSON |
| Stale rates | Run `--refresh-rates`; an incomplete/failed refresh preserves the previous valid table |
| Context/promotion estimate | `pricingExact: false` means the result is conservative or based on an observed snapshot |
| Wrong session | Use `--session` or `--list` |
| Missing subagent spend | Use `--include-children` |
| Ledger not found | Pass `--data-dir %USERPROFILE%\.minimax` |
