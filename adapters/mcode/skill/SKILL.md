---
name: session-cost
description: |
  Compute a MiniMax Code session's real token usage and its cost at the provider's published
  rates — fresh input, cached input (cache read/write), output, the cache-hit rate, and the
  final cost with cached tokens billed at the discounted cache-read rate. Rates are mirrored
  for CommandCode and StepFun (including StepFun's rule that cache writes bill at the input
  rate for step-5-preview). Trigger on "cache rate", "session cost", "cost summary", "token
  usage", "how much did this cost", "cost of this session/task", or any request for a
  token-and-cost breakdown (input/output/cached in millions). Also trigger when a task
  finishes, to append the cost summary. Do NOT use it for plan or subscription questions
  ("what plan am I on", "how many credits are left") or for forecasting future spend. For a
  provider whose rates are not mirrored it reports token counts and says the cost is
  unavailable — guessing another provider's rates produces a wrong number instead of no number.
---

# Session Cost

Report what a session actually consumed and what it cost, from the runtime's own ledger.
`references/ledger-internals.md` holds the schema, the peak/off-peak band rule, and the model-id
matching rules — read it before changing the script or explaining an unexpected number.

## Command modes

Run the bundled script from the installed MCode skill:

```powershell
$SessionCost = "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs"

node $SessionCost
node $SessionCost --last
node $SessionCost --today
node $SessionCost --compare
node $SessionCost --list 10
node $SessionCost --from 2026-09-01 --to 2026-09-30
node $SessionCost --provider commandcode
node $SessionCost --model deepseek
node $SessionCost --session <id> --include-children
node $SessionCost --dashboard
node $SessionCost --dashboard --out <path>
node $SessionCost --rates --dashboard
node $SessionCost --rates
node $SessionCost --json
node $SessionCost --config <path>
node $SessionCost --refresh-rates
```

`--last` selects the latest session that is no longer active. `--today` aggregates sessions whose
first ledger call is on the current UTC date. `--compare` compares the latest two sessions.
Date/provider/model filters produce an aggregate when multiple sessions match. `--rates` reports
mirrored provider coverage and freshness without reading session history.

Natural language mapping:

- `current` → no flag
- `last` → `--last`
- `today` → `--today`
- `compare` → `--compare`
- `this task end to end` → `--include-children`
- `rate coverage` / `are these rates current` → `--rates`

## Inputs to collect

- **Which session.** Default to the current session id from `<agent-context>`. Ask only when the
  user clearly means a different one ("how much did the last session cost") and two or more
  recent sessions are plausible candidates — `--list` shows them.
- **Whether sub-agents belong in the total.** Sub-agent sessions bill to their own `session_id`.
  Add `--include-children` when the user means "this task, end to end" and the task spawned
  sub-agents; keep it off for "this session". The report always names any sub-agent sessions it
  left out, so under-reporting is visible rather than silent.

## Procedure

1. Run the bundled script — never recompute by hand.

   ```powershell
   node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --session mvs_xxxx
   ```

   The script is the only correct path because four facts make hand-calculation wrong: the
   ledger's `model` column is `NULL` for every row (the script recovers the model per call from
   the session's message log), `cost_usd` is `0` for these BYOK providers (the script prices the
   tokens from the mirrored rate table), `input_tokens` **excludes** cached tokens (so cached and
   fresh prompt tokens must be billed at their two different rates — treat `input_tokens` as
   fresh-only and never subtract cache reads from it), and a session can switch models partway
   through (7 of 25 sessions measured) or even switch **provider** — so one rate for the whole
   session is usually wrong.

2. Read the five lines that decide whether the numbers are trustworthy before reporting:
   - the **`Snapshot:`** line — an active session's totals grow between runs, so report them as
     a snapshot, not a final figure;
   - the **`Rates`** block — when it lists more than one model, the session switched models and
     each model's calls are priced at its own rate; quote the per-model split rather than a
     single blended rate, and note that the headline cache rate is session-weighted while each
     model has its own hit rate;
   - the **`band split`** — `peak` is CommandCode's premium window (01–04 and 06–10 UTC, Mon–Fri)
     and `offPeak` is everything else; a split session is normal and both bands are already priced;
   - the **`Note:`/`includes N sub-agent session(s)`** lines — whether sub-agent spend is in or
     out, and whether any call's model had to be inferred;
   - the **`TOTAL`** — if any model shows `rate unknown`, the total understates the session; say so.
   If any of these is missing or looks impossible, do not paper over it; say what looks wrong.

3. When the snapshot says the session is **still active**, take a final run just before you answer
   and quote that later snapshot. The figure at the start of a long analysis is already stale by
   the time you reply, and re-running is cheap; reporting one number and mentioning a different
   one invites the user to trust the wrong figure.

4. Report with the output contract below, keeping the script's digits. Round nothing further: the
   totals are exact sums of per-call costs, and the user asked for maximum accuracy.

5. If the user asks what a different model would have cost, re-price the same token counts against
   that model in `references/provider-rates.json` — `--json` gives the counts to price against.
   Label such a figure as hypothetical, since it was never billed.

## Output contract

Deliver the script's summary as-is. Shape below, from a real run — **illustrative only**: the
numbers are a past snapshot of that session and are certainly stale now, so always run the script
rather than reusing any figure here.

```
Session cost — mvs_495a74d0d51e423fbdf35709b083fe7a
mavis · step-5-preview · custom_provider:stepfun
Task: hi
Window: 2026-09-20 10:00 UTC → 2026-09-20 15:51 UTC · 194 LLM call(s)
Snapshot: 2026-09-20 20:23 UTC (session idle)

TOTAL COST $10.684553 for 29.9196 M tokens — $0.357109/M all-in

What was used, and what it cost
| Token type             | Tokens (M) | Share of prompt | Rate $/M |       Cost |
| ---------------------- | ---------- | --------------- | -------- | ---------- |
| Fresh input (uncached) |     9.4090 |           31.5% |  $1.0000 |  $9.408955 |
| Cached prompt read     |    20.4163 |           68.5% |  $0.0500 |  $1.020813 |
| Cache write            |     0.0000 |            0.0% |        — | $0.000000 |
| Output                 |     0.0944 |               — |  $2.7000 | $0.254785 |
| Total                  |    29.9196 |               — |        — | $10.684553 |
Cache rate 68.5% of prompt — cached prompt was billed at 1/20th the fresh rate,
which is why the all-in $0.357109/M sits far below the sticker input rate.

Rates actually billed
  step-5-preview — flat $1.00 in / $0.05 cache read / $2.70 out / $1.00 cache write per 1M  (194 call(s), $10.684553)
  band split: 0 off-peak · 0 peak · 194 flat

Rates for stepfun mirrored 2026-09-20T20:20:39.124Z from https://platform.stepfun.ai/docs/en/guides/pricing/details.md
```

**One table is the contract.** Token count, the rate it was billed at, and the cost sit on the same
row, so the reader never has to join rows across tables. `Rate $/M` is the *effective* rate (cost ÷
tokens), which blends bands, models and providers automatically — it is what was paid, not a
sticker price. Add nothing that the table already says.

Two optional tables appear only when they carry information the main table cannot:

- `By model` — only when the session used more than one model. It has a `Provider` column, because
  the same model id can exist at two providers at different prices.
- `By session` — only with `--include-children`.

A mixed-provider session labels each rate line with its provider (`commandcode · …`, `stepfun · …`)
and prints one mirror line per provider. When nothing could be priced, the headline reads
`COST UNAVAILABLE` and the cost column is `—` throughout — a `$0.000000` headline would read as
"this session was free", which is false.

Reporting rules that make the number trustworthy:

- State tokens in **millions** and label the cached portion — in agent sessions cached tokens are
  the large majority of the prompt, which is why the all-in rate sits far below the sticker input
  rate.
- Always show the **cache rate** as a percentage of prompt tokens.
- Always state the **rate applied**, including which band, so the user can audit it.
- Always carry the **Snapshot** line through, and say plainly when the session is still active.
- Never present a cost the script did not compute. If the rate is unknown, report the tokens and
  say the cost is unavailable.

## Failure handling

- **`Rates: UNAVAILABLE for "<model>"`** (exit code 2): no call in the session could be priced, so
  the script prints no cost table at all rather than a misleading `$0`. Run `--refresh-rates` in
  case the catalog changed; if the model is still missing, it is served by a provider whose rates
  are not mirrored (only CommandCode and StepFun are). Report the token counts, state that the
  cost is unavailable, and offer to add rates rather than inventing them.
- **`rate unknown` in the Rates table + `TOTAL covers priced calls only` note**: some models were
  priced and others were not. Quote the total as the priced subset, repeat that note, and name the
  unpriced models — a partial total silently presented as the session total is the worst failure
  this skill can have. In `--list` the same case appears as a `*` suffix on the cost.
- **`Provider "<x>" has no mirrored rate table`**: the session ran on a third provider. Token
  counts are still correct; say plainly that only the mirrored providers can be priced.
- **Non-commandcode provider** (e.g. `custom_provider:stepfun`): the script still reports token
  counts correctly and refuses to price them. That is the correct outcome — say so plainly.
- **Totals moving between two runs**: expected for an active session. Report the later snapshot and
  the snapshot time; do not try to reconcile the difference.
- **Empty ledger or unknown session id**: the script exits with a message. Re-check the id, or run
  `--list 10` to find the right session.
- **Rates look stale**: each provider's `fetchedAt` is printed in the report footer and recorded
  in `references/provider-rates.json`. Refresh with `--refresh-rates` when the user doubts a
  rate. It re-reads CommandCode's model catalog and StepFun's pricing page, so it needs network
  access; if one source fails, that provider's previous rates are kept rather than dropped.
- **Node too old**: `node:sqlite` needs Node 22.5+ (verified on Node 24). The script prints the
  running version instead of failing cryptically.

## Standing behaviour after a task

When a task completes, append the cost summary without being asked — the user asked for this as a
standing convention. Keep it to the compact block above; do not repeat the full table mid-task.
Skip it when no provider in the session has mirrored rates, since the report would carry no cost,
and skip it when the user has clearly moved on to an unrelated request.

## Examples

**Input**: "what's the cache rate for this session"
**Output**: run the script with no `--session` (current session) and report the one table, calling
out the `Cached prompt read` row and its `Share of prompt` — e.g. `13.4280 M, 95.2%` — plus the
discount it buys: cached prompt billed at `$0.0030/M` against `$0.1500/M` fresh, which is why the
all-in `$0.0139/M` is a fraction of the sticker input rate. If the session is still active, say the
figure is a snapshot.

**Input**: "how much did that last task cost, including the subagents"
**Output**: `--list 5` to confirm which session the task was, then
`--session <id> --include-children`; report the folded total from the headline and the `By session`
table, and say how many sub-agent sessions were included.

## Windows (win32) platform notes

Node is required; there is no Python dependency. Use PowerShell paths:

```powershell
$SessionCost = "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs"
node $SessionCost --session mvs_xxxx            # one session
node $SessionCost --list 10                     # recent sessions with cost
node $SessionCost --json                        # machine-readable
node $SessionCost --refresh-rates               # re-fetch CommandCode rates
```

`--data-dir <path>` overrides the auto-detected data directory (`%USERPROFILE%\.minimax`, derived
from the script's own location).
