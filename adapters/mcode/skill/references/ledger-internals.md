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
| `commandcode` | `https://commandcode.ai/docs/resources/pricing-limits` (79 parsed model records, with source context/time/promotion metadata where published) |
| `stepfun` | `https://platform.stepfun.ai/docs/en/guides/pricing/details.md` (10 token-billed models, flat) |

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

## Cache-write billing and missing components

The rate parser reads CommandCode's structured `cacheWriteCost` field. A published numeric `0` is
kept as an explicit zero; an omitted field is stored as JSON `null` and is **not** converted to
zero. Each generated rate-card component retains both its source/raw amount and normalized numeric
value. This distinction is exposed per component in `componentCompleteness` and in the `--rates`
coverage output. A call with cache-write tokens and a null write rate is partial/unknown pricing:
the known input/read/output components may be shown as a diagnostic subset, but the session cost
is not presented as complete. The affected component's cost field is `null` and its known-rate
status is exposed; it is not rendered as `$0.000000`.

StepFun is different because its official pricing page explicitly says that, for
`step-5-preview`, the cache-miss input price includes writing new content to the cache. The parser
therefore records `cacheWrite = input` (currently `$1.00/M`) for that model. The other StepFun
rows do not publish a write component, so their value remains `null`; it is not guessed to be
zero.

The ledger's token arithmetic is unchanged: `cacheWriteTokens` is a separate prompt component and
is included in `promptTokens` and `totalTokens`. Only its *rate* is conditional on published
coverage.

## Effective dates, context bands, and promotions

The mirrored table is a rate-card catalog, not an undated price list. Each model can carry:

- `effectiveFrom` / `effectiveThrough` and an ISO timestamp on each generated `rateCards` entry;
- `contextTiers` with an inclusive `maxContext` threshold;
- UTC `timeOfDay` peak/off-peak bands and their source effective date;
- `promotions` with `starts`, `ends`, discount metadata, and explicit `listRates` when the source
  publishes a revert rate; and
- `source`, `sourceVersion`, `fetchedAt`, and a SHA-256 `rateCardFingerprint`; each card's
  `components` entries carry `tokenComponent`, raw/value, and status fields.

A call at an explicit context length selects the matching tier. The MCode ledger does not expose
a reliable historical context-length field for every call, so when context is unavailable the
script takes the **highest published rate for each component as a conservative upper bound** and
sets `pricingExact: false`; it never labels that fallback as an exact invoice. A call before a known
effective date, or outside a promotion window without a published list rate, is unknown rather
than silently repriced with today's value.

Promotion windows are selected by the call timestamp. A current promotional rate and its explicit
list/revert rate remain separate records. If the source gives no start/end date, the rate is marked
as observed/approximate; a missing future or historical rate is not inferred from a discount
percentage.

## Peak / off-peak bands

DeepSeek V4 models (and a few others) bill differently by UTC time of day:

- peak: 7h/day, `01–04` and `06–10` UTC, Mon–Fri
- off-peak: the other 17h/day

The script resolves the band **per call** from each row's `ts` (epoch ms), not per session, so a
session that spans a boundary is handled on both sides. The `04:00` / `10:00` boundaries are
reads of the published window `01–04 & 06–10`; a session exactly on the boundary can differ by
one call. If a time-band component is absent, it remains null and makes that call partial; it is
not filled with a zero or an unrelated base rate.

Verified by hand on a synthetic ledger: one peak call (`2026-09-21T02:00Z`, Monday) plus one
off-peak call (`2026-09-21T05:00Z`), 100k fresh in / 1M cache read / 10k out each, must total
`0.048 + 0.024 = $0.072000` when the applicable card has all four components.

## Model-id matching

The provider model id and the rate-table key are different strings
(`deepseek/deepseek-v4.1-flash` vs `deepseek-v4.1-flash`). Matching normalizes both by:
lowercasing, dropping the `vendor/` prefix, and removing every non-alphanumeric character.
`MiniMaxAI/MiniMax-M3` → `minimaxm3`, matching table key `minimax-m3`; `Qwen/Qwen3.7-Flash` →
`qwen3.7flash`, matching `qwen-3.7-flash`; `step-5-preview` → `step5preview`, matching
`step-5-preview`. Free-tier models (`poolside/laguna-s-2.1-free`,
`inclusionai/ling-3.0-flash-sante:free`) are listed under `freeModels` and bill at `$0`.

If a model matches nothing inside its provider's table, the report lists it as `rate unknown` with
its call count, keeps it out of the priced total, and exits with code `2`. A recognized model can
also be **partially covered** when a required component is null or when a context/promotion
selection is unavailable. JSON exposes `pricingCoverage`, `pricingExact`, component completeness,
rate-card fingerprints, and the partial known-component value. The script never invents a rate or
turns an unknown component into zero.

## Cost domains in JSON

MCode's ledger `cost_usd` and the provider-rate calculation are different domains. The normalized
JSON keeps them separate:

- `billing.recordedCostUsd`: the sum of numeric ledger `cost_usd` values (an explicit zero remains
  zero); it is `null` when any row is missing/unparseable, with coverage and known-row counts;
- `billing.rateCalculatedCostUsd`: the provider-rate estimate, or `null` when no complete priced
  subset exists;
- `billing.apiEquivalentCostUsd`: the same estimate only when pricing coverage is complete,
  explicitly labelled API-equivalent rather than charged; and
- `billing.pricingCoverage` / `pricingExact`: `complete`, `partial`, `unknown`, and whether the
  selected card is exact or conservative/estimated.

`cost_usd` in the current BYOK ledger is commonly a runtime placeholder zero. A zero there must
not be substituted for the rate estimate, and the rate estimate must not be called a recorded
charge.

## Known limits

- Only sessions that actually made LLM calls appear in the ledger. A session with no rows costs
  `$0` and is reported as such, not as an error.
- Sub-agent sessions are separate `session_id`s. `--include-children` folds in sessions whose
  `parent_session_id` is the target, one level deep, and each keeps its own model and provider
  resolution.
- `reasoning_tokens` is tracked but is already included in `output_tokens` for billing by the
  upstream provider, so the script never adds it again. StepFun states this explicitly for its
  models ("output tokens include both the model's reasoning process and final answer").
- A session that is still running yields a snapshot, not a final figure: the report states the
  snapshot instant and warns when the last call is recent. Reading the same session twice will
  legitimately give different totals.
- Rates drift. Each provider's `fetchedAt`, parser version, and rate-card fingerprint are recorded
  in the rate file and printed in the report footer. `--refresh-rates` parses structured source
  data, validates required components and duplicate model ids, then writes through a temporary
  file and atomic rename. If any source is incomplete or fails, the refresh is rejected and the
  previous valid table is kept; the CLI reports the rejection with a nonzero status and never
  publishes a partial refresh.
- A current rate snapshot is not proof of historical pricing when the source does not publish an
  effective date. Such calls are labelled estimates and carry the source/fetch provenance.
- CommandCode's open-source table says prices are provider means and that actual upstream cost
  can vary. The report preserves that caveat instead of calling the result an invoice amount.
