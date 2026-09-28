# MCode porting plan

## Current baseline

The MCode adapter under `adapters/mcode/skill/` is the native implementation. Port shared product behavior without importing Cline credentials, local ledgers, or token formulas. Any change to the following invariants requires MCode-specific tests and documentation updates.

## Non-negotiable MCode accounting

- `input_tokens` is fresh input and excludes cache reads/writes.
- Total prompt = input + cache read + cache write.
- Cost is calculated from mirrored CommandCode/StepFun rates, not the ledger's zero `cost_usd` values.
- Cache reads use the model's published cache-read rate.
- A provider-supplied cache-write rate is used when present. An omitted value remains `null`/unknown, never an assumed zero.
- A call with positive cache-write tokens and no published cache-write rate is partial/unknown rather than silently free.
- StepFun `step-5-preview` cache writes are priced at that model's input rate; other unpublished StepFun cache-write rates are not guessed.
- Unknown provider/model rates produce token counts without a guessed cost.
- Model and provider can switch within one session, so every call is priced using its resolved provider/model.
- Rate timestamps and priced/unpriced coverage remain visible.

These rules are intentionally different from Cline, whose `inputTokens` includes cached prompt tokens.

## Storage and network contract

- Normal reports open the MCode runtime ledger and read session message logs. They do not rewrite the ledger.
- `--rates` reads the bundled `references/provider-rates.json`; it does not need network access.
- `--refresh-rates` explicitly fetches the configured CommandCode and StepFun pricing sources.
- A successful all-source refresh atomically writes `references/provider-rates.json` inside the installed MCode skill.
- If any source fetch or validation fails and a previous valid table exists, the whole previous table is retained and no file is written; without a valid previous table the refresh fails.
- The installed skill directory therefore must be writable for an explicit refresh and should be backed up before one.
- `--dashboard` and `--out` write local HTML. JSON output may expose session titles, IDs, models, providers, tokens, and costs and must be handled as private data.
- There is no developer-owned telemetry service.

## Child-session behavior

MCode subagents are separate session IDs. In 0.2.0, `--include-children` includes sessions whose `parent_session_id` is the selected target (direct children only). Reports name excluded children. Do not describe this as recursive descendant aggregation.

Cline's same flag recursively includes every descendant. Any future MCode recursive implementation must walk descendants safely, preserve each child's provider/model resolution, avoid cycles/duplicates, and add nested-child tests before documentation changes.

## Shared UX to preserve

- Automatic current-session selection
- `--last`
- `--today`
- `--compare`
- UTC date range filters
- Provider/model filters
- Versioned JSON output
- Snapshot metadata
- Optional standing-summary configuration
- Clear included/excluded subagent reporting
- Self-contained dashboard output

The adapters share UX, not raw field interpretation.

## Runtime compatibility

- Node.js 22.13.0 or newer is the repository support floor declared by `package.json` and exercised in CI.
- Windows, Ubuntu, and macOS run the Node verification matrix.
- Bun 1.4.2 or newer is an optional compatibility runtime with separate adapter-test and CLI smoke coverage; it is not a replacement for the declared Node engine.
- Do not add Python or dependency requirements to a port unless the implementation and release contract are deliberately changed.

## Release handoff

The MCode customer package is built from the explicit file allowlist in [release.md](release.md), not by copying the repository root. A release uses the same `X.Y.Z` identity and `vX.Y.Z` tag as Cline and the combined bundle. Each artifact includes `RELEASE-VERSION.txt`, the root MIT license, and support/security documents; the release output also includes checksums and a clean-install smoke result.

Before tagging, run:

```text
npm run verify
bun test adapters
```

The second command is the Bun compatibility check, not a replacement for the Node matrix. Packaging/tagging commands are documented separately because they require an approved release script and `package.json` entry.
