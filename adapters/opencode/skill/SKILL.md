---
name: opencode
description: |
  Report an OpenCode session's real token usage and its cost from OpenCode's own
  SQLite ledger: fresh input, cached input (cache read/write), output, reasoning tokens, the
  cache-hit rate, and the per-model cost split. The cost is taken from the per-call cost the
  OpenCode runtime itself recorded wherever it recorded any; only where it recorded nothing is
  it estimated by applying rate cards from the provider profile in the user's session-cost
  configuration — this adapter ships no bundled rate table, because OpenCode sessions span
  whatever providers the user has configured. Trigger
  on "session cost", "cost summary", "token usage", "cache rate", "how much did this cost",
  "cost of this session/task", or any request for a token-and-cost breakdown. Do NOT use it for
  plan, subscription, or credit-balance questions, or for forecasting future spend. When the
  runtime recorded no cost and no rate applies to a model, it reports exact token counts and
  says the cost is unavailable — a guessed rate produces a wrong number, which is worse than no
  number.
---

# Session Cost (OpenCode)

Report what an OpenCode session consumed and what it cost, read from OpenCode's own
`opencode.db`. `references/ledger-internals.md` holds the storage layout, the 1.x/2.x
precedence rule, and the token semantics — read it before changing the script or explaining an
unexpected number.

## Command modes

Run the bundled script. The ledger is located from your user home directory
(`%USERPROFILE%\.local\share\opencode\opencode.db`), not from the script's own location, so an
installed copy runs correctly from wherever it is unpacked:

```powershell
$SessionCost = "$env:USERPROFILE\.config\opencode\skill\session-cost\scripts\session-cost.mjs"

node $SessionCost
node $SessionCost --session ses_xxxx
node $SessionCost --last
node $SessionCost --today
node $SessionCost --compare
node $SessionCost --list 10
node $SessionCost --from 2026-09-01 --to 2026-09-30
node $SessionCost --provider <provider-id>
node $SessionCost --model <model-id>
node $SessionCost --session ses_xxxx --include-children
node $SessionCost --dashboard
node $SessionCost --dashboard --out <path>
node $SessionCost --explain
node $SessionCost --csv
node $SessionCost --budget 5.00
node $SessionCost --json
node $SessionCost --config <path>
node $SessionCost --session-config <path>
node $SessionCost --init-config
node $SessionCost --validate-config
node $SessionCost --export-config
node $SessionCost --import-config <path>
node $SessionCost doctor
node $SessionCost providers
node $SessionCost models discover
node $SessionCost config explain --provider <id> --model <id>
```

`--last` selects the latest session that is no longer active. `--today` aggregates sessions
started on the current UTC date. `--compare` compares the latest two sessions. Date, provider,
and model filters produce an aggregate when several sessions match.

This adapter has no `--rates` and no `--refresh-rates`: there is no bundled catalog to report
coverage on or refresh. Coverage comes from the provider profiles in your session-cost
configuration, so `doctor` and `config explain` are the diagnostics to reach for.

Natural language mapping:

- `current` → no flag
- `last` → `--last`
- `today` → `--today`
- `compare` → `--compare`
- `this task end to end` → `--include-children`
- `check my setup` → `doctor`
- `which providers are configured` → `providers`
- `find my model` → `models discover`
- `why was this model selected` → `config explain --provider <id> --model <id>`
- `I use a custom endpoint` → add a provider profile with a manual or imported rate card, then run `doctor`

## Inputs to collect

- **Which session.** Default to the session named in `<agent-context>`. Ask only when the user
  clearly means a different one and two or more recent sessions are plausible candidates —
  `--list` shows them.
- **Whether sub-agent sessions belong in the total.** A sub-agent is its own `ses_...` id
  parented to the session that spawned it. Add `--include-children` when the user means "this
  task, end to end"; keep it off for "this session". The report always names any sub-agent
  sessions it left out, so under-reporting is visible rather than silent.
- **Whether a rate profile exists.** If the report says `COST UNAVAILABLE`, that is a
  configuration gap, not a runtime failure. Do not invent a rate; offer to add one.

## Procedure

1. Run the bundled script — never recompute by hand.

   ```powershell
   node "$env:USERPROFILE\.config\opencode\skill\session-cost\scripts\session-cost.mjs" --session ses_xxxx
   ```

   The script is the only correct path because three facts make hand-calculation wrong.
   OpenCode's database carries two generations of message store at once (`message` for 1.x and
   `session_message` for 2.x) and for some sessions they disagree on how many calls were made;
   which store is authoritative is a measured rule, not an obvious one. `tokens.input` excludes
   cached tokens, so fresh and cached prompt must be billed at their two different rates — never
   subtract cache reads from `input`. And a session can switch model or provider partway through,
   so one rate for the whole session is usually wrong.

2. Read the lines that decide whether the numbers are trustworthy before reporting:
   - the **`Snapshot:`** line — an active session's totals grow between runs, so report them as
     a snapshot, not a final figure;
   - the **`Rates actually billed`** block — one entry per model, each with the rate card that
     priced it, the source of that card, its effective date, and the driver fingerprint. When it
     lists more than one model, the session switched models; quote the split rather than blending
     it;
   - the **`priced calls N of M`** line and any **`!` unpriced** warning — whether the total is
     the whole session or only the priced subset;
   - the **`Note:`** lines — whether sub-agent spend is in or out, and whether the session came
     from the aggregate fallback and therefore has no per-call split;
   - the headline — `TOTAL COST` for a priced session, `COST UNAVAILABLE` when no applicable
     rate exists. If any of these is missing or looks impossible, say what looks wrong rather
     than papering over it.

3. When the snapshot says the session is **still active**, take a final run just before you
   answer and quote that later snapshot. The figure from the start of a long analysis is already
   stale by the time you reply.

4. Report with the output contract below, keeping the script's digits. Round nothing further.

## Output contract

Deliver the script's summary as-is. The shape below is from a real run against a synthetic
ledger — **illustrative only**: the numbers are a past snapshot and are certainly stale, so
always run the script rather than reusing any figure here.

```
Session cost — ses_root
build · 1.18.30 · fixture-priced · fixture-provider
Task: Root contract fixture
Window: 2026-09-24 18:10 UTC → 2026-09-24 18:10 UTC · 3 LLM call(s)
Snapshot: 2026-09-26 18:10 UTC (session idle)

TOTAL COST $0.000420 for 0.0009 M tokens — $0.451613/M all-in

What was used, and what it cost
| Token type             | Tokens (M) | Share of prompt | Rate $/M |      Cost |
| ---------------------- | ---------- | --------------- | -------- | --------- |
| Fresh input (uncached) |     0.0003 |           33.3% |  $1.0000 | $0.000300 |
| Cached prompt read     |     0.0006 |           66.7% |  $0.1000 | $0.000060 |
| Cache write            |     0.0000 |            0.0% |        — | $0.000000 |
| Output                 |     0.0000 |               — |  $2.0000 | $0.000060 |
| Total                  |     0.0009 |               — |        — | $0.000420 |
Cache rate 66.7% of prompt.

Rates actually billed
  fixture-priced — $1.00 in / $2.00 out / $0.1 cache read / $1.25 cache write per 1M
    3 call(s), 0.0009 M tokens, $0.000420
    rate source: config profile "fixture-provider" (USD)
    effective from: 2020-01-01T00:00:00.000Z
  priced calls 3 of 3
```

**One table is the contract.** Token count, the rate it was billed at, and the cost sit on the
same row, so the reader never has to join rows across tables. `Rate $/M` is the *effective*
rate (cost ÷ tokens), which blends models and providers automatically. Add nothing the table
already says.

A `By model` table appears only when the session used more than one model, and a `By session`
table only with `--include-children`.

### The three zero-shaped cases are different statements

This is the failure mode worth getting right, because all three can be reached by an ordinary
session and a reader who conflates them either invents money or denies spend:

| Case | What the script says | What it means |
| --- | --- | --- |
| A session whose **runtime recorded a cost** | `TOTAL COST $x (recorded by OpenCode)`; `--json` gives `costBasis: "runtime-recorded"` and a non-null `recordedCostUsd` | A real billed figure, taken from the ledger's own per-call costs. This is the primary basis and needs no provider profile at all. |
| A session with **no calls** | `priced calls 0 of 0`; `--json` gives `coverage: "no-calls"`, `amountUsd: 0`, `rateKnown: true` | A known zero. Nothing was spent because nothing ran. The text headline still reads `COST UNAVAILABLE`, so use `--json` or the call count to tell this apart. |
| A session with **calls but no recorded cost and no applicable rate** | `COST UNAVAILABLE`, every cost cell `—`, exit code `2`, and a `! N of M call(s) are unpriced` warning | An unknown cost, not a zero. Report the exact token counts and say the cost is unavailable. |
| A **genuinely free model** — a rate card whose four components are all `0` | `TOTAL COST $0.000000 (free model)`, and the rate line says every rate component is 0 | A priced zero. The card really is free; the number is known. |

Never report an unknown cost as `0`, and never report a known zero as "unavailable". No code
path in this adapter collapses the three.

Note the fourth row's evidence. A model whose name ends in `-free` is **not** a free total here:
the ledger has no free flag, and a recorded `cost: 0` cannot be told apart from a call the
runtime failed to price — the same `step-5-preview` sessions contain both. A zero is only
reported as a priced zero when a configured rate card says zero, or as the recorded basis in a
session that has real recorded spend alongside it. Otherwise it is `cost unavailable`, and a
fresh install needs a provider profile (`--init-config`, then `doctor`) for exactly those
sessions.

### When no rate applies

This adapter ships **no rate table**. Every rate it applies comes from a provider profile in the
session-cost configuration, matched on the provider id and model the ledger recorded — and only
for the sessions whose runtime recorded no cost of its own. So:

- `COST UNAVAILABLE` with `no rate is configured for model <m> at provider <p>` means the model
  is real but unconfigured. Report the tokens, name the missing profile, and offer to add one
  (see `--init-config` and `doctor`).
- `no provider driver matches <p>` means no configured profile or built-in driver claims that
  provider id at all. Same remedy, and it is a configuration problem rather than a rate problem.
  A profile whose `match.providerIds` collides with a built-in driver is refused outright
  ("multiple provider drivers match") — pick a distinct provider id, or a `models` alias onto a
  rate the tool already knows.
- Never substitute another provider's published rate. A different provider's card produces a
  confident wrong number, which is the one outcome this skill exists to prevent.

## Failure handling

- **`COST UNAVAILABLE`** (exit code `2`): at least one call had no applicable rate. The token
  counts are exact and complete. Report them, name the unpriced model(s), and offer to configure
  a rate.
- **`! N of M call(s) are unpriced`**: a partial total. Quote it as the priced subset, repeat the
  warning, and name the unpriced models. A partial total presented as the session total is the
  worst failure this skill can have.
- **Session-aggregate note**: the session had token totals but no per-call rows in either
  message store, so there is no per-model split behind the figure. Say so; do not present it as
  per-call precision.
- **Totals moving between two runs**: expected for an active session. Report the later snapshot
  and its time; do not try to reconcile the difference.
- **Empty or missing ledger**: the script exits with a message naming the path it looked for.
  Re-check the id with `--list 10`, or set `SESSION_COST_OPENCODE_DATA_DIR` / pass `--data-dir`
  if the ledger is not under your home directory.
- **Ledger locked or half-written**: OpenCode may be writing to the database while the agent
  runs. The reader opens it read-only and treats a busy database as transient; re-run rather than
  reporting a number from a partial read.
- **Node too old**: `node:sqlite` needs Node 22.15+ (verified on Node 24). The script prints the
  running version instead of failing cryptically.

## Windows (win32) platform notes

Node is required; there is no Python dependency. Use PowerShell paths:

```powershell
$SessionCost = "$env:USERPROFILE\.config\opencode\skill\session-cost\scripts\session-cost.mjs"
node $SessionCost --session ses_xxxx            # one session
node $SessionCost --list 10                     # recent sessions with cost
node $SessionCost --json                        # machine-readable, with coverage status
node $SessionCost --dashboard --out report.html # self-contained dashboard
```

`--data-dir <path>` overrides the data root that `.local/share/opencode/opencode.db` is resolved
against. The default is the user home directory.
