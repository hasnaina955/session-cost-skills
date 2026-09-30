---
name: session-cost
description: |
  Compute a Command Code session's real token usage and its cost at the
  provider's published rates — fresh input, cached input (cache read/write),
  output, the cache-hit rate, and the final cost with cached tokens billed at
  the discounted cache-read rate. Rates are mirrored from the CommandCode
  provider-rate table, including CommandCode's peak window (01-04 and 06-10
  UTC, Mon-Fri) at twice the off-peak price. Trigger on "cache rate", "session
  cost", "cost summary", "token usage", "how much did this cost", "cost of
  this session/task", or any request for a token-and-cost breakdown. Do NOT
  use it for forecasting future spend. For a model whose rate is not mirrored
  it reports token counts and says the cost is unavailable — guessing a rate
  produces a wrong number instead of no number.
---

# Session Cost (Command Code)

Report what a session actually consumed and what it cost, from Command Code's
own session ledger (`~/.commandcode/projects/<slug>/<session>.jsonl`). The mod
is a single self-contained TypeScript file; install it to
`%USERPROFILE%\.commandcode\mods\session-cost.ts` and reload mods.

## Invocation

As a slash command or through the model-callable `session_cost` tool — both run
the same engine:

```text
/session-cost                  current (most recent) session
/session-cost --last           latest completed session
/session-cost --today          sessions started today (UTC), with totals
/session-cost --list 10        recent sessions
/session-cost --compare        compare the latest two sessions
/session-cost --session <id>   specific session (id substring)
/session-cost --from 2026-09-01 --to 2026-09-30
/session-cost --provider commandcode --model deepseek
/session-cost --include-children
/session-cost --dashboard --out <path>
/session-cost --rates
/session-cost --json
```

Subcommands:

```text
/session-cost doctor                  config, ledger, rate table, cache health
/session-cost providers               provider drivers with price ranges
/session-cost models discover         every priced model with per-component rates
/session-cost config explain --model <m>   how a model string matches a rate card
/session-cost config init | validate | export | import <path>
```

Natural language mapping:

- `current` → no flag
- `last` → `--last`
- `today` → `--today`
- `compare` → `--compare`
- `this task end to end` → `--include-children`
- `rate coverage` / `are these rates current` → `--rates`
- `check my setup` → `doctor`
- `which providers are configured` → `providers`
- `find my model` → `models discover`
- `why was this model selected` → `config explain --model <id>`

## Inputs to collect

- **Which session.** Default to the current session. Ask only when the user
  clearly means a different one and two or more recent sessions are plausible
  candidates — `--list` shows them.
- **Whether sub-agents belong in the total.** Sub-agent `<usage>` blocks are
  tracked separately and never priced (the model is not recorded in the block).
  Add `--include-children` when the user means "this task, end to end"; the
  report always names the subagent blocks it left out, so under-reporting is
  visible rather than silent.

## Procedure

1. Run the command — never recompute by hand. Four facts make hand-calculation
   wrong: `inputTokens` **excludes** cached tokens (fresh and cached prompt
   tokens bill at different rates), a session can switch models partway
   through, CommandCode bills its peak window at twice the off-peak price, and
   only the mirrored models can be priced at all.

2. Read the lines that decide whether the numbers are trustworthy before
   reporting:
   - the **`window`** line — an active session's totals grow between runs, so
     report them as a snapshot, not a final figure;
   - the **per-model split** — when more than one model appears, each model's
     calls are priced at its own rate;
   - the **peak/off-peak split** — `peak` is CommandCode's premium window
     (01-04 and 06-10 UTC, Mon-Fri);
   - the **`cache`** line — cache-read share of prompt tokens; below the
     `warnOnCacheRateBelow` threshold (default 60%) prompts may not be cached;
   - the **`unpriced`** line — when it appears, the total covers priced calls
     only.

3. Report with the script's digits. Round nothing further: totals are exact
   sums of per-call costs.

## Output contract

The text card carries one table's worth of facts: session, project, window,
calls, token split (input / cache read / cache write / output), cost with the
priced/peak/off-peak split, the per-model breakdown, and any subagent note.
`--json` emits the shared normalized report contract
(`contracts/normalized-report-v1.schema.json`, runtime id `commandcode`, cost
basis `provider-rate-estimate`) with Command Code extension fields (`sessions`,
`totals`, `models`).

## Failure handling

- **Unpriced models**: tokens are reported, the cost is `null` (never `$0`),
  and the models are named. Run `--refresh-rates` in case the table changed;
  if the model is still missing, its provider's rates are not mirrored.
- **`Rates: UNAVAILABLE`-equivalent**: when no model in the selection could be
  priced, `--json` reports `billing.amountUsd: null` with
  `coverage: "unavailable"` — a `$0.0000` headline would read as "this session
  was free", which is false.
- **Stale rates**: `--refresh-rates` re-fetches the mirrored table from the
  upstream repo, validates it, and writes it atomically; a failed refresh
  leaves the previous table intact.
- **Bad `SESSION_COST_NOW`**: the pinned clock fails loudly with one readable
  line instead of silently using the real clock.

## Standing behaviour after a task

When a task completes, append the cost summary without being asked. Keep it to
the compact card; skip it when no model in the session has mirrored rates, and
skip it when the user has clearly moved on. Enable `standingSummary` in
`~/.commandcode/session-cost.json` to always append today's aggregate to the
default report.

## Windows (win32) notes

The mod reads the ledger directly and needs no Python or npm dependencies. The
refresh and dashboard paths write under `%USERPROFILE%\.commandcode\`.
