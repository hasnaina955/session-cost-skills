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
| `--json` | Shared normalized contract JSON |
| `--config <path>` | Standing-summary config |
| `--session-config <path>` | Provider/session config |
| `--init-config` | Create safe config template |
| `--validate-config` | Validate and show effective config |
| `--export-config` | Print effective config |
| `--import-config <path>` | Import validated config |
| `doctor` | Inspect effective config/providers |
| `providers` | List provider drivers |
| `models discover` | List rate models and aliases |
| `config explain` | Explain provider/model matching |
| `--data-dir <path>` | Override MCode data directory |
| `--help` / `-h` | CLI help |

## Session modes

`--json` reports use normalized contract version `1.2.0`. MCode labels its value as a provider-rate estimate, keeps `recordedCostUsd` null, and exposes token semantics, coverage, provenance, warnings, and session-graph state.

## Provider configuration

Project config is `.session-cost.json`; user config uses the platform config directory. Precedence is
CLI flags, project config, user config, detected runtime defaults, then built-in defaults. Provider
profiles map custom provider names and model aliases to a supported driver. Use `--validate-config` or
`--export-config` to inspect effective values and winning sources. Profiles store environment-variable
names such as `OPENROUTER_API_KEY`, never credential values.

```json
{
  "schemaVersion": 1,
  "runtimeDefaults": {},
  "providers": [{
    "id": "company-openai",
    "driverId": "openai-compatible",
    "match": { "providerIds": ["company-openai"], "runtimes": ["mcode"] },
    "baseUrlEnv": "COMPANY_OPENAI_BASE_URL",
    "credentialEnv": "COMPANY_OPENAI_API_KEY",
    "region": "eu-west",
    "currency": "EUR",
    "pricingMode": "manual",
    "rateCards": [{
      "model": "company-model",
      "effectiveFrom": "2026-01-01T00:00:00Z",
      "input": 1.5,
      "output": 6,
      "cacheRead": 0.15,
      "cacheWrite": 1.5
    }]
  }],
  "models": [{
    "runtime": "mcode",
    "provider": "company-openai",
    "runtimeModel": "Company/Model",
    "rateModel": "company-model"
  }]
}
```

The compatible drivers normalize standard usage and streaming responses. Missing usage or rate components remain unknown. Use `importedRateRecords` instead of `rateCards` when importing already-fingerprinted effective records.

```powershell
node $SessionCost doctor
node $SessionCost providers
node $SessionCost models discover
node $SessionCost config explain --provider commandcode --model qwen-3.7-plus
```

Unknown models return a non-zero status with suggestion-only aliases; they are never applied automatically.

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

`--rates` reports mirrored providers, model counts, sources, effective intervals, record counts,
component completeness, source exclusions, and free-model entries without reading the session ledger.
`--refresh-rates` fetches CommandCode and StepFun together, validates every component and context/time
range, and atomically publishes only when both providers are complete. Refreshes retain prior rate
records and close their intervals at the next effective snapshot. A failed refresh leaves the previous
valid table byte-for-byte unchanged. Calls before the earliest trustworthy rate date remain unpriced.
Rate lookup runs through the versioned provider driver selected for the call, so provider matching and
capabilities are shared across runtimes rather than duplicated in each CLI.

## Subagents

```powershell
node $SessionCost --include-children
node $SessionCost --session mvs_xxxx --include-children
```

`--include-children` recursively includes every descendant. Multi-session modes select top-level roots
before aggregation, preventing a child from being counted again beneath a selected parent. A selected
root includes descendants across UTC dates; a child becomes a root only when its parent is outside
the filtered candidate set.

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
- Cost is calculated from mirrored provider rates.
- Published `cacheWrite` rates are used for every provider, including nonzero CommandCode rates.
- CommandCode uses peak and off-peak bands.
- Unknown provider/model rates produce tokens without a guessed cost.
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
| `cost unavailable` | Run `--rates`; add or refresh the provider rate |
| `rate unknown` with a total | Total covers priced calls only; unpriced models are named |
| Stale rates | Run `--refresh-rates` |
| Refresh rejected | Read the reported component/parser issue; the previous valid table was preserved |
| Wrong session | Use `--session` or `--list` |
| Missing subagent spend | Use `--include-children` |
| Ledger not found | Pass `--data-dir %USERPROFILE%\.minimax` |
