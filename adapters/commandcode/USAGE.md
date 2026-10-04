# Command Code session-cost usage reference

Install location:

```text
%USERPROFILE%\.commandcode\mods\session-cost.ts
```

Load it with `cmd mods add hasnaina955/session-cost-skills` (from the
repository root, once the mod package manifest is published) or by
copying `adapters/commandcode/skill/session-cost.ts` into the mods
directory, then reload mods.

## Quick start

```text
/session-cost
```

The same engine is available to the model as the read-only
`session_cost` tool.

## Command matrix

| Command | Meaning |
| --- | --- |
| `/session-cost` | Current (most recent) session |
| `--session <id>` | Specific session (id substring) |
| `--last` | Latest session |
| `--today` | Sessions started today (UTC), with totals |
| `--compare` | Compare the latest two sessions |
| `--from <date>` / `--to <date>` | UTC date-range filter (`YYYY-MM-DD`) |
| `--provider <name>` | Provider substring filter |
| `--model <name>` | Model substring filter |
| `--include-children` | Fold subagent usage blocks into totals |
| `--list [n]` | Recent sessions, default 10 |
| `--rates` | Rate coverage and freshness |
| `--dashboard` | Write a self-contained HTML session dashboard |
| `--out <path>` | Dashboard output path |
| `--refresh-rates` | Re-fetch mirrored CommandCode rates |
| `--json` | Shared normalized contract JSON |
| `--config <path>` | Alternate config file |
| `--session-config <path>` | Alias of `--config` |
| `--init-config` | Create safe config template |
| `--validate-config` | Validate the config |
| `--export-config` | Print effective config |
| `--import-config <path>` | Import validated config |
| `doctor` | Mod, ledger, rate table, and cache health |
| `providers` | List provider drivers with price ranges |
| `models discover` | List every priced model with per-component rates |
| `config explain --model <m>` | Explain model matching, including aliases |
| `config init` / `validate` / `export` / `import <path>` | Config subcommands |
| `--data-dir <path>` | Override the projects directory |
| `--version` / `-v` | Mod, report-contract, rate-table, and Node versions |
| `--help` / `-h` | Help |

## Session modes

`--json` reports use normalized contract version `1.2.0`. The Command
Code adapter labels its value as a provider-rate estimate, keeps
`recordedCostUsd` null, and exposes token semantics, coverage,
provenance, warnings, and session-graph state, plus Command Code
extension fields (`sessions`, `totals`, `models`).

## Provenance of the ledger facts

The storage layout this mod reads is not guessed. It is verified against the vendor's own
documentation and an independent parser, recorded here so a future schema change is checked
against sources rather than vibes:

- Transcript location and shape: vendor docs, "Sessions & Checkpoints"
  (https://commandcode.ai/docs/sessions) - one append-only JSONL per session under
  `~/.commandcode/projects/<project-slug>/<session-id>.jsonl`, first line a header
  (session id, creation time, working directory), replies carrying "token usage and cost".
- Record schema and token semantics: corroborated against tokscale's `commandcode.rs`,
  which verified against the vendor's own cost arithmetic that v3 assistant records are
  `{type:"message", timestamp, message:{role}, usage:{inputTokens, outputTokens,
  cacheReadTokens, cacheWriteTokens, costUsd}, model}` and that the buckets are disjoint:
  `inputTokens` excludes cached tokens, and input plus cache buckets at the mirrored rates
  reproduce the recorded `costUsd` exactly.
- Mod API: vendor docs, "Mods" (https://commandcode.ai/docs/mods) - one TypeScript file at
  `~/.commandcode/mods/<name>.ts`, a default-export factory receiving `cmd: ModApi`.
- Peak windows: vendor docs, "Pricing & Limits" - 01-04 & 06-10 UTC, Mon-Fri, peak billed at
  twice the off-peak rate on the banded models.

Two guards follow from this:

- A session whose header declares a transcript version other than 3 is reported unpriced
  with the drift named, never parsed into plausible wrong numbers.
- A banded call with a missing or unparseable timestamp is unpriced, never priced at the
  off-peak band (the cheaper one) by accident of `new Date('')` being invalid.

The one unverified claim is the subagent `<usage>` block format; it feeds only an
informational token counter, never a cost, so a wrong guess there cannot misprice.

## Accounting semantics

- `inputTokens` is **fresh** input and excludes cached tokens; the
  prompt total is `input + cacheRead + cacheWrite`.
- An unknown model reports its tokens with a `null` cost — never a
  guessed `$0`.
- The ledger's own recorded `costUsd` is disclosed per session and in totals as a separate,
  labelled domain (`recordedCostUsd`); it is never merged into the estimate, and a material
  disagreement between the two domains warns that the mirrored rate table may be stale.
- A free-tier model (`…-free` / `…:free`) is a *known* `$0`.
- Subagent `<usage>` blocks carry no model, so they are tracked
  separately and folded in only with `--include-children`.
- Peak window (01-04 and 06-10 UTC, Mon-Fri) bills at twice the
  off-peak rate on the four banded models.

## Rate table

The mod embeds the mirrored CommandCode rate table (snapshot dated
2026-09-25, 78 models) from
`adapters/mcode/skill/references/provider-rates.json` in this
repository. `--refresh-rates` re-fetches that file, validates it, and
writes `~/.commandcode/session-cost.rates.json` atomically; the
sidecar then wins over the embedded snapshot. A failed refresh leaves
the previous table intact.

## Configuration

`~/.commandcode/session-cost.json`:

```json
{
  "standingSummary": false,
  "includeChildren": false,
  "defaultFormat": "compact",
  "warnOnCacheRateBelow": 0.6,
  "models": [{ "runtimeModel": "my-model", "rateModel": "deepseek-v4.1-flash" }]
}
```

- `standingSummary` — append today's aggregate to the default report.
- `includeChildren` — default subagent folding on.
- `defaultFormat` — `compact` (default) or `json`.
- `warnOnCacheRateBelow` — cache-read share of prompt tokens below
  which the card and `doctor` warn (0-1, default 0.6).
- `models` — runtime-model → rate-model aliases; `config explain`
  reports the resolution.

Invalid configs are rejected by `--validate-config` and
`--import-config` with one readable line per problem.

## Dashboards

`--dashboard` writes a self-contained HTML file (no external assets,
`default-src 'none'` CSP, no JavaScript) to
`~/.commandcode/reports/session-cost/session-dashboard.html` or
`--out <path>`. `--rates --dashboard` writes the rate-table dashboard.

## Doctor

`doctor` reports the mod and contract versions, the active rate table
and its source, the ledger location with session/call/token counts,
the effective config, the cache-read share against
`warnOnCacheRateBelow`, and the Node version.

## Errors

Every failure path — malformed ledger, corrupt config, invalid
`SESSION_COST_NOW`, unreadable dashboard path — returns one readable
line. No stack traces, local paths beyond the data directory, or
credential material.
