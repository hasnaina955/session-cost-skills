# Cline session-cost usage reference

Install location:

```text
%USERPROFILE%\.cline\skills\session-cost\
```

## Quick start

```powershell
$SessionCost = "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs"
node $SessionCost
```

## Command matrix

| Command | Meaning |
| --- | --- |
| `node $SessionCost` | Current session, auto-detected |
| `--session <id>` | Specific session |
| `--last` | Latest completed session |
| `--today` | Sessions started today (UTC) |
| `--compare` | Compare the latest two matching sessions |
| `--from <date>` / `--to <date>` | UTC date-range filter |
| `--provider <name>` | Provider filter |
| `--model <name>` | Model substring filter |
| `--include-children` | Include recursive subagent sessions |
| `--list [n]` | Recent-session table, default 10 |
| `--json` | Shared normalized contract JSON |
| `--config <path>` | Standing-summary config |
| `--session-config <path>` | Provider/session config |
| `--init-config` | Create safe config template |
| `--validate-config` | Validate and show effective config |
| `--export-config` | Print effective config |
| `--import-config <path>` | Import validated config |
| `--account` | Live read-only account API view |
| `--account-days <n>` | Account history window, default 45 |
| `--account-user-id <id>` | Must match authenticated account |
| `--dashboard` | Write a self-contained HTML dashboard |
| `--out <path>` | Dashboard output path |
| `--data-dir <path>` | Override Cline data directory |
| `--help` / `-h` | CLI help |


`--json` reports use normalized contract version `1.2.0`. Cline labels its value as a runtime-recorded cost; token semantics, selection, coverage, provider-driver provenance, warnings, and session-graph state are explicit.

## Provider configuration

Project config is `.session-cost.json`; user config uses the platform config directory. Precedence is
CLI flags, project config, user config, detected runtime defaults, then built-in defaults. Use
`--validate-config` or `--export-config` to see the effective values and winning sources. Profiles store
only environment-variable names such as `OPENROUTER_API_KEY`, never credential values.

## Session modes

```powershell
node $SessionCost
node $SessionCost --last
node $SessionCost --today
node $SessionCost --session 1790246615854_qog7g
node $SessionCost --compare
```

`--compare` compares the latest two matching sessions by total tokens, cache-hit rate, and billing
classification.

## Filters

```powershell
node $SessionCost --from 2026-09-01 --to 2026-09-30
node $SessionCost --provider cline-pass
node $SessionCost --model stealth
node $SessionCost --provider cline-pass --model stealth --today
```

When more than one session matches, the command returns a filtered aggregate.

## Subagents

```powershell
node $SessionCost --include-children
node $SessionCost --session <id> --include-children
```

The default excludes subagents but lists their IDs. `--include-children` recursively folds all
descendants into the total. Multi-session list, compare, today, and range modes select top-level
roots before aggregation, so a child is never counted again beneath a selected parent. A selected
root includes descendants even when they start on another UTC date; a child becomes a root only when
its parent is outside the filtered candidate set.

## Account mode

```powershell
node $SessionCost --account
node $SessionCost --account --json
node $SessionCost --account --account-days 90
node $SessionCost --account --account-user-id usr-...
```

Reports:

- Plan and active state
- Balance
- Reference cost
- Credits used
- Total account tokens
- ClinePass and usage-billing request counts
- Five-hour, weekly, and monthly usage limits
- Today, rolling seven-day, and current-month totals
- Recent daily, weekly, and monthly history

Credential precedence:

1. `CLINE_API_KEY`
2. `data/settings/providers.json` OAuth token for `cline` or `cline-pass`
3. Legacy `data/secrets.json` `apiKey`

Re-authenticate with:

```powershell
cline auth --provider cline
```

## Config

`%USERPROFILE%\.cline\session-cost.json`:

```json
{
  "standingSummary": true,
  "includeChildren": true,
  "defaultFormat": "compact",
  "warnOnCacheRateBelow": 0.6
}
```

`includeChildren` is applied unless `--include-children` is explicitly supplied. The CLI never
writes the file.

## Dashboard export

```powershell
node $SessionCost --dashboard
node $SessionCost --account --dashboard
node $SessionCost --dashboard --out C:\path\to\session-dashboard.html
```

The default account dashboard is written to:

```text
%USERPROFILE%\.cline\data\reports\session-cost\account-dashboard.html
```

The default current-session dashboard is written to:

```text
%USERPROFILE%\.cline\data\reports\session-cost\session-dashboard.html
```

The HTML is self-contained and does not load external assets or make network requests.

## Billing semantics

- Local session cost comes from Cline assistant-message `metrics.cost`.
- Account reference cost comes from the Cline API and is reported separately.
- Account credits used are separate from reference cost.
- Cline `inputTokens` includes cached tokens; fresh input subtracts cache read/write.
- Missing recorded cost is reported as not recorded, never guessed.

## Troubleshooting

| Symptom | Action |
| --- | --- |
| Account unauthorized | Run `cline auth --provider cline`, then retry |
| Wrong session auto-selected | Use `--session` or `--list` |
| Multiple running sessions | The report warns; select with `--session` |
| Account call slow | Reduce `--account-days` |
| Missing subagent spend | Use `--include-children` |
| Old Node | Upgrade to Node 22.5+ |
