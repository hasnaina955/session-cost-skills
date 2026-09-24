# Session Cost Skills

Private source repository for the Cline and MiniMax Code (MCode) `session-cost` skills.

This repository keeps runtime-specific accounting adapters separate while sharing the product architecture, release process, and regression-test conventions.

## Status

- Private development repository
- Cline adapter: existing enhanced implementation included as the baseline
- MCode adapter: existing provider-rate implementation included as the baseline
- Shared extraction and MCode usability parity: next development phase
- No credentials, session databases, generated reports, or API keys belong in this repository

## Repositories and installation targets

The source is split into two installable skills:

- `adapters/cline/skill/` → install to `%USERPROFILE%\.cline\skills\session-cost\`
- `adapters/mcode/skill/` → install to `%USERPROFILE%\.minimax\skills\session-cost\`

Keep installed copies separate. They have the same public skill name but different runtime ledgers and token semantics.

## Runtime differences that must remain adapter-specific

| Concern | Cline | MCode |
| --- | --- | --- |
| Primary data | `data/db/sessions.db` and message JSON | `v2/sqlite/runtime-state.sqlite` and session logs |
| `inputTokens` | Includes cached prompt tokens | `input_tokens` excludes cached tokens |
| Cost source | Recorded per-call `metrics.cost` | Provider-rate calculation for BYOK providers |
| Account mode | Optional read-only Cline API view | Not applicable; use rate-coverage mode instead |
| Providers | Cline/ClinePass/OpenAI-compatible/etc. | Mirrored CommandCode and StepFun rates |

Never use the Cline fresh-input formula on MCode data without adapting the ledger semantics.

## Development commands

Run the current Cline baseline tests:

```powershell
node --test "adapters/cline/skill/tests/core.test.mjs"
node --test "adapters/cline/skill/tests/account.test.mjs"
```

The MCode baseline remains in its native skill format while the shared adapter is developed.

## Release policy

Releases are generated as separate ZIP packages. Never publish a package containing a user's local data, credentials, session history, generated account reports, or provider secrets.

See [docs/architecture.md](docs/architecture.md), [docs/porting-plan.md](docs/porting-plan.md), and the adapter usage references:

- [adapters/cline/USAGE.md](adapters/cline/USAGE.md)
- [adapters/mcode/USAGE.md](adapters/mcode/USAGE.md)
