# Session Cost — ledger semantics and edge cases

Bulk detail behind `SKILL.md`. Read this only when the script's output looks wrong or you
need to extend it.

## Where the numbers come from

| Fact | Source |
| --- | --- |
| Per-call token counts | `<dataDir>/v2/sqlite/runtime-state.sqlite` → table `local_runtime_token_usage` |
| Per-call **model and provider** | `<dataDir>/v2/sessions/<history_relative_dir>/messages.jsonl` → assistant messages |
| Session default model/provider | the same dir's `llm-call.json` |
| Session → history dir mapping | `local_runtime_sessions.history_relative_dir` |
| Sub-agent linkage | `local_runtime_sessions.parent_session_id` |
| Provider rate tables | `references/provider-rates.json`, keyed `providers.<name>.models` |

`dataDir` is `%USERPROFILE%\.minimax` by default; the script derives it from its own location
(`<dataDir>/skills/session-cost/scripts/`) and accepts `--data-dir` to override.

Mirrored providers and their sources:

| Provider key | Source |
| --- | --- |
| `commandcode` | `https://commandcode.ai/docs/resources/pricing-limits` (79 source cards; incomplete/context-tier cards are excluded) |
| `stepfun` | `https://platform.stepfun.ai/docs/en/guides/pricing/details.md` (10 token-billed source cards; only cards with documented cache-write pricing are published) |

## `local_runtime_token_usage` columns

```
id, session_id, agent_name, framework_type, turn_id, model, ts,
input_tokens, output_tokens, reasoning_tokens,
cache_read_tokens, cache_write_tokens, cost_usd, raw
```

Two properties make this table insufficient on its own — both are why the script exists:

1. **`model` is `NULL` in every row** (verified: 1014/1014 rows on 2026-09-20). The ledger does
   not record which model served a call, so the model has to be recovered from the message log.
   It does not record the **provider** either.
2. **`cost_usd` is `0` in every row** for the BYOK providers (`custom_provider:commandcode`,
   `custom_provider:stepfun`). The runtime has no rates for them, so cost must be computed
   externally from `references/provider-rates.json`.

`raw` holds the upstream usage object, e.g.
`{"input":149,"output":72,"cacheRead":44288,"cacheWrite":0,"totalTokens":44509,"cost":{...all zeros}}`.

## The critical invariant: `input_tokens` EXCLUDES cached tokens

```
totalTokens === input + output + cacheRead + cacheWrite
```

This was verified across rows. Consequences that matter for correctness:

- `input_tokens` is **fresh (uncached) prompt only**. Cached prompt is reported separately in
  `cache_read_tokens`. Do **not** subtract `cache_read_tokens` from `input_tokens` — that would
  double-count the discount and under-bill the session.
- Total prompt tokens (the real context size) = `input_tokens + cache_read_tokens + cache_write_tokens`.
- Total tokens billed (all kinds) = `input + output + cache_read + cache_write`.

This differs from OpenAI's raw `prompt_tokens`, which *includes* cached tokens. If you port this
math to another provider's ledger, re-check which convention that ledger uses before trusting it.

## Provider-aware rate matching

**A session is not necessarily single-model, and not necessarily single-provider.** Measured on
2026-09-20: 7 of 25 sessions with ledger rows used more than one model, and one session
(`mvs_cf77df034ac24ce7ba214fe2da479174`) ran on both `custom_provider:commandcode` and
`custom_provider:stepfun`. Pricing a whole session at `llm-call.json`'s model silently misprices
those sessions — and `llm-call.json` is only a snapshot of the *most recent* call's configuration,
so it describes the end of the session, not its history.

Rate lookup is therefore **provider-first**: the provider is normalised (`custom_provider:stepfun`
→ `stepfun`) and the model id is matched only inside that provider's table. Matching on model id
alone would be unsafe once two providers are mirrored, since the same id can exist at both at
different prices.

Two different assistant-message schemas exist in the message log, which is why timestamp matching
is imperfect:

| Schema | Where | Model field | Usage keys | `timestamp` means |
| --- | --- | --- | --- | --- |
| A (newer) | `messages.jsonl`, top-level `message` | `model`, `responseModel`, `provider` | `input`, `output`, `cacheRead`, `cacheWrite`, `totalTokens`, `cost` | request start — matches ledger `ts` exactly |
| B (older) | `local_runtime_message_rows.data_json` | **absent** | `input_tokens`, `output_tokens`, `cache_read`, `total_tokens`, `request_duration_ms` | completion (seconds after the ledger row) |

Measured join result: schema-A messages match ledger rows by `timestamp === ts` for **952 of 1104
rows (86.2%)**. Schema-B rows carry no model at all, so pairing them by usage triple yields
nothing — the information is simply not persisted.

The script therefore:

1. builds a `ts → {model, provider}` index from schema-A assistant messages in that session's
   `messages.jsonl`;
2. prices each ledger row with the model **and provider** recorded for that exact timestamp;
3. for rows with no recorded model, inherits those of the **nearest recorded call** in the same
   session (chronologically nearest, so a mid-session model or provider switch is followed
   correctly);
4. counts those rows as `inferredModelRows` and prints a note whenever the count is non-zero.

Step 3 is an estimate, and the report says so rather than hiding it. The exposure is bounded: for
the 7 multi-model sessions the minority model is usually a handful of cheap calls, so an
interpolation error moves the total by fractions of a cent.

Cross-check performed: on session `mvs_495a74d0d51e423fbdf35709b083fe7a` (194 pure `step-5-preview`
calls), an independent hand computation from the message log plus the ledger gives
**$10.684553**, and the script reports **$10.684553** — exact agreement, with 194/194 rows matched
by timestamp.

## Cache-write billing differs by provider

The table stores a per-model `cacheWrite` rate and refuses to convert a missing component to zero:

- **CommandCode** publishes nonzero `cacheWriteCost` values for supported cards. A rendered `—` is
  recorded as an explicit no-charge zero; a card with no cache-write value is incomplete and blocks
  the entire refresh. The bundled snapshot publishes only complete cards and lists the remaining
  source IDs as excluded rather than treating them as free.
- **StepFun** states *"For `step-5-preview`, the cache-miss input price includes writing new content
  to the cache."* That model uses the input rate (`$1.00/M` in the current snapshot). The other
  StepFun cards do not publish a cache-write component, so the bundled snapshot excludes them rather
  than assuming they are free.

Each published component is a fingerprinted rate record with provider/model, raw and normalized amount,
currency, effective interval, context range, time band, and source metadata. Refreshes validate both
providers and retain earlier records; the next snapshot closes the previous open interval. A fetch or
validation failure leaves the last valid table untouched, and a call before the earliest effective
record remains unpriced.

## Context tiers

CommandCode cards may publish several context ranges. The parser preserves every numeric threshold and
creates records such as `0-256000` and `256001-unbounded`. Selection uses the call's full MCode context
size (`input + output + cache read + cache write`), so long-context calls cannot silently use the flat
base rate. A tier missing any required component is excluded rather than partially priced.

## Peak / off-peak bands
## Peak / off-peak bands

DeepSeek V4 models (and a few others) bill differently by UTC time of day:

- peak: 7h/day, `01–04` and `06–10` UTC, Mon–Fri
- off-peak: the other 17h/day

The script resolves the band **per call** from each row's `ts` (epoch ms), not per session, so a
session that spans a boundary is billed correctly on both sides. Band rule implemented:

```
peak  ⇔  UTC weekday ∈ Mon..Fri  AND  (1 ≤ utcHour < 4  OR  6 ≤ utcHour < 10)
```

The `04:00` / `10:00` boundaries are reads of the published window `01–04 & 06–10`; a session
exactly on the boundary can differ by one call. Models without a `timeOfDay` block in the rate
table have a single flat rate — StepFun models all fall here.

Verified by hand on a synthetic ledger: one peak call (`2026-09-21T02:00Z`, Monday) plus one
off-peak call (`2026-09-21T05:00Z`), 100k fresh in / 1M cache read / 10k out each, must total
`0.048 + 0.024 = $0.072000`. The script reports exactly `$0.072000`.

## Model-id matching

The provider model id and the rate-table key are different strings
(`deepseek/deepseek-v4.1-flash` vs `deepseek-v4.1-flash`). Matching normalizes both by:
lowercasing, dropping the `vendor/` prefix, and removing every non-alphanumeric character.
`MiniMaxAI/MiniMax-M3` → `minimaxm3`, matching table key `minimax-m3`; `Qwen/Qwen3.7-Flash` →
`qwen3.7flash`, matching `qwen-3.7-flash`; `step-5-preview` → `step5preview`, matching
`step-5-preview`. Free-tier models (`poolside/laguna-s-2.1-free`,
`inclusionai/ling-3.0-flash-sante:free`) are listed under `freeModels` and bill at `$0`.

If a model matches nothing inside its provider's table, the report lists it as `rate unknown` with
its call count, keeps it out of the priced total, and exits with code `2`. It never invents a rate
— report the unknown model to the user and offer `--refresh-rates`, then add an alias if the
catalog renamed it.

## Known limits

- Only sessions that actually made LLM calls appear in the ledger. A session with no rows costs
  `$0` and is reported as such, not as an error.
- Sub-agent sessions are separate `session_id`s. `--include-children` recursively folds in every
  descendant, each keeping its own model and provider resolution. Multi-session modes choose
  top-level roots first, so a child is never billed again when its parent is also selected.
- `reasoning_tokens` is tracked but is already included in `output_tokens` for billing by the
  upstream provider, so the script never adds it again. StepFun states this explicitly for its
  models ("output tokens include both the model's reasoning process and final answer").
- A session that is still running yields a snapshot, not a final figure: the report states the
  snapshot instant and warns when the last call is recent. Reading the same session twice will
  legitimately give different totals.
- Rates drift. Each provider's `fetchedAt` is recorded in the rate file and printed in the report
  footer. `--refresh-rates` fetches and validates both sources before one atomic replacement.
- Calls older than the first retained effective rate snapshot remain unpriced; the current catalog does not retroactively invent historical rates.
