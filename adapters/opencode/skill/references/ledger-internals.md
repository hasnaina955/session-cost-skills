# Session Cost (OpenCode) — ledger semantics and edge cases

Bulk detail behind `SKILL.md`. Read this only when the script's output looks wrong or you
need to extend it.

Every measurement quoted below was taken on a real OpenCode install, not inferred.

## Where the numbers come from

| Fact | Source |
| --- | --- |
| Everything: sessions, per-call usage, aggregates | `<home>/.local/share/opencode/opencode.db` (SQLite, WAL) |
| 1.x session rows | table `session` |
| 1.x per-call usage | table `message`, column `data` (JSON) |
| 2.x session rows | table `session_v2` |
| 2.x per-call usage | table `session_message`, column `data` (JSON) |
| Sub-agent linkage | `parent_id` on the session row |
| Provider rate cards | the user's own provider profile, **not** a bundled table |

`dataDir` is the user home directory by default (overridable with
`SESSION_COST_OPENCODE_DATA_DIR` or `--data-dir`); `ledgerPath()` joins
`.local/share/opencode/opencode.db` onto it. The reader opens the database **read-only**,
because OpenCode is frequently writing to it while the agent runs; a busy database is treated as
transient rather than reported as a number from a half-written state.

## One file, two schema generations

OpenCode is mid-migration from 1.x to 2.x and **both generations are live in the same file at
once**. They are not one detailed store and one summary store — both carry per-call usage, and
they are two projections of the same session history.

A 1.x `message.data`:

```json
{ "role": "assistant", "modelID": "...", "providerID": "...", "cost": 0,
  "finish": "stop", "time": { "created": 0, "completed": 0 },
  "tokens": { "total": 0, "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } } }
```

A 2.x `session_message.data`:

```json
{ "model": { "id": "...", "providerID": "...", "variant": "high" }, "agent": "...", "finish": "stop",
  "providerState": { "completed": true }, "cost": 0,
  "time": { "created": 0, "streamed": 0, "completed": 0 },
  "tokens": { "input": 0, "output": 0, "reasoning": 0, "cache": { "read": 0, "write": 0 } } }
```

Two shape differences matter:

1. The model is at the top level in 1.x (`modelID`, `providerID`) and nested in 2.x
   (`model.id`, `model.providerID`, alongside a `variant`). The reader accepts both, including
   the top-level form in a 2.x row, because a 2.x runtime has been observed writing it.
2. **`tokens.total` is optional in the 2.x shape.** Filtering on it — or requiring it to be
   non-zero — hides every row. That is exactly the mistake that produced the first version of
   this reader, so rows are selected on `data IS NOT NULL` and the per-component fields only.

## Token semantics

| Field | Meaning |
| --- | --- |
| `tokens.input` | fresh input; **excludes** cache reads (same rule as MCode) |
| `tokens.cache.read` | cached prompt reads |
| `tokens.cache.write` | cache writes |
| `tokens.output` | output |
| `tokens.reasoning` | reasoning, reported separately rather than folded into output |
| `cost` | the runtime's own recorded cost for the call, kept but not used for pricing |

Total prompt is `input + cache read + cache write`, so a fresh token and a cached token are
never conflated into one rate. The critical invariant is the same one MCode's ledger obeys:
**never subtract cache reads from `input`**, and never apply Cline's `includes-cache` formula
here.

## Precedence, and why it is not a guess

The two stores overlap, and for three sessions they disagree. Measured on a real install across
the 13 sessions present in both:

```
ses_f356325ebffedEei0kkAJIamvg  v1 411 calls / 27,602,949 in   v2 324 calls / 18,862,280 in
ses_f31b4495bffelIw55JC3FQVPle  v1  40 calls /    250,212 in   v2  26 calls /    145,470 in
ses_f3134e298ffe1JvJc0Go8QynTM  v1  37 calls /    907,793 in   v2  20 calls /    198,109 in
```

Every other shared session agrees exactly. All three disagreements are `version = 1.18.30`, and
in every case the 1.x store retains **more** calls than the 2.x projection. So the 2.x
projection lost history the 1.x store still holds, rather than the 1.x store double-counting.

The `session_v2` aggregate columns are not a separate opinion: checked against the 2.x per-call
rows they match exactly for 48 of 54 sessions, and the six that differ do so by a few hundred
tokens while being written at read time. The aggregate is a faithful roll-up of whatever the 2.x
store holds.

The rule the reader therefore implements:

1. **1.x per-call rows win wherever a session has them** — they are the more complete record.
2. 2.x per-call rows are used for sessions only 2.x has.
3. The session aggregate is a last-resort fallback.

The three sources are never summed, so a session contributes exactly one set of records and
cannot be billed twice. The selected source is carried through to the report.

## What the aggregate fallback is for

On the install measured here, zero sessions need it: all 57 sessions with any usage have
per-call rows in at least one store. It exists because a future OpenCode version could aggregate
without projecting, and a report that silently dropped those sessions would under-report spend.

When it does apply, the report says so. An aggregate-priced session has no per-model split —
there is no per-call record to derive one from — so it must not be presented as if it did.

## Where the cost comes from

There are two bases, and they are not peers: the runtime's own figure wins whenever it exists.

**1. `runtime-recorded` (primary).** Every OpenCode message row carries a `cost` field, and
for a paid model it holds what the provider actually billed. When any call in scope carries a
positive recorded cost, the report headlines the **sum of the recorded costs** and performs no
rate arithmetic at all: `runtime.costBasis` is `runtime-recorded`, `billing.recordedCostUsd`
is that sum, `billing.estimatedCostUsd` is `null`, and `provenance.kind` names the ledger.
This is the case a fresh install gets for free — no provider profile is needed for a session
the runtime already priced.

**2. `provider-rate-estimate` (fallback).** Only where the ledger recorded nothing does the
report fall back to pricing from a rate card. Unlike the MCode adapter this adapter **ships
no rate table** and has no `--rates` or `--refresh-rates`. OpenCode runs against whatever
provider the user configured, including local and self-hosted endpoints, so there is no single
catalog that could be bundled and be correct. The rate source is the user's own provider
profile: its `rateCards` and `importedRateRecords`, validated by the shared config module and
already carrying effective dates, context tiers, and currency. Everything that decides *which*
driver a call belongs to — the built-in manifests, deterministic provider matching, alias
resolution, and the duplicate/ambiguity failures — is the shared machinery, unchanged.

A recorded total is a *total*, not a sample of one: a call inside such a session that records
`cost: 0` contributes `0` to the sum and is not a reason to fall back. Measured on a real
ledger, `step-5-preview` has 3 zero-cost calls among 258 and 4 among 293, and those zeros are
part of the sessions' recorded spend. Every token-bearing message row also carries a `cost`
key, so the sum covers every call in scope rather than only the priced ones.

The rule that shapes the fallback path:

> A call is priced only when **every one** of input / output / cacheRead / cacheWrite has an
> applicable rate record. A partial card yields no number at all. Zero is a legitimate answer
> (a genuinely free model) and is reported as a number; "no rate" is reported as `null` and
> never as `0`.

That distinction is the difference between "we priced this and it was free" and "we cannot price
this", and the two must never be collapsed. The zero-shaped outcomes, as they appear in
`--json`:

| Situation | `billing.amountUsd` | `runtime.costBasis` | Text headline |
| --- | --- | --- | --- |
| Recorded cost in the ledger | the recorded sum | `runtime-recorded` | `TOTAL COST $x (recorded by OpenCode)` |
| No calls at all | `0` | `provider-rate-estimate` | `COST UNAVAILABLE` (see note) |
| Calls, no applicable rate | `null` | `provider-rate-estimate` | `COST UNAVAILABLE` |
| Rate card whose four components are all `0` | `0` | `provider-rate-estimate` | `TOTAL COST $0.000000 (free model)` |

Note on the third row: a session with no calls is a **known zero** — nothing was spent because
nothing ran — and the contract says so (`rateKnown: true`, `coverage: "no-calls"`,
`amountUsd: 0`). The text renderer prints the same `COST UNAVAILABLE` headline for it as for an
unpriceable session, so to tell a no-calls session from an unpriced one you must read
`coverage.status` from `--json`, or the `priced calls 0 of 0` line. No code path renders an
unknown cost as `0`, and none renders a known zero as "unknown" in the contract.

### Why a recorded zero is never read as "free"

A session whose every call records `cost: 0` is **not** reported as a free total unless a rate
card says so. The ledger has no free flag, and a recorded zero is indistinguishable from a
call the runtime could not price: the paid `step-5-preview` sessions contain both, in the same
store, in the same session. The only other candidate signal is the provider id, and that is an
external pricing assumption rather than a fact in the ledger — the same provider carries both
`-free` and non-free models — so inferring free from it is the same guess as inferring it from
a model name suffix, just with a longer reach.

So the conservative reading is the one implemented: no recorded cost and no card means
`cost unavailable`, exit code `2`, exact token counts, models named. **A fresh install still
needs a provider profile to price a session whose runtime recorded nothing** — a free-model
session on a fresh install reports unavailable, not `$0.00`, and the remedy is
`--init-config` plus `doctor`.

Because the runtime records a per-call total and never a per-token split, the per-row costs in
the "What was used, and what it cost" table are `—` on the recorded basis, with the basis
stated in a note beneath it, rather than a rate breakdown of a number that was not derived
that way.

## Session selection

`session` and `session_v2` are both read, and a session present in both contributes one row
(the 2.x row wins, since it carries the newer fields). Sessions that exist only in `session` are
kept; dropping them would silently lose spend.

`--last` picks the latest non-active session, `--today` the sessions started on the current UTC
date, and `--compare` the latest two. Sub-agent sessions are separate `ses_...` ids linked by
`parent_id`. `--include-children` folds in every descendant, each keeping its own
model/provider resolution, and multi-session modes prefer top-level roots so a child is never
billed twice. The report names any excluded sub-agent sessions, so under-reporting is visible
rather than silent.

## Known limits

- A session that is still running yields a snapshot, not a final figure. The report states the
  snapshot instant, and re-reading the same session legitimately gives different totals.
- `time.completed` is preferred over `time.created` so a call is billed against the moment it
  finished, which matters when a session spans a billing boundary.
- Reasoning tokens are tracked and reported separately; they are not added to output a second
  time.
- Rates drift, and unlike MCode there is no bundled snapshot to compare against. A model whose
  card predates the session is priced at whatever the configured card says for that effective
  interval; the report prints the card's `effective from` and its fingerprints so the figure can
  be audited after a config change.
- A call before the earliest applicable effective record, or from a model with no card at all, is
  unpriced. The script never invents a historical rate to fill the gap.
