# Session Cost Skills

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Local-first token, cache, billing, and usage dashboards for the Cline and MiniMax Code (`MCode`) `session-cost` skills.

This repository keeps runtime-specific accounting adapters separate while sharing the product architecture, release process, documentation, and regression-test conventions.

## Status

- Public MIT-licensed repository
- Cline adapter: local sessions, Cline account limits, cost/credits, and interactive dashboards
- MCode adapter: native ledger accounting, CommandCode/StepFun rates, comparisons, and interactive dashboards
- Shared release and verification workflow
- No credentials, session databases, generated reports, or API keys belong in this repository

## Features

- Current, last, today, compare, list, and date-range modes
- Provider/model/search filters
- Subagent-aware session totals
- ClinePass/free/billed/partial billing classification
- Cline account balance, plan, five-hour/weekly/monthly limits
- Cline daily, weekly, and monthly account periods
- CommandCode and StepFun provider-rate accounting
- Effective-dated, context-aware MCode rates with immutable refresh history and fingerprints
- Versioned built-in and user-installed provider driver manifests
- Layered project/user configuration with safe provider profiles and model aliases
- Secret-safe `doctor`, provider discovery, model discovery, and match explanations
- OpenAI- and Anthropic-compatible providers with manual or imported effective rate cards
- Cache-read and cache-write semantics preserved per runtime
- Self-contained HTML dashboards with no external assets
- Shared normalized JSON report contract with runtime extensions
- Windows and Node.js 22.15+ support

## Installation

The source is split into two installable skills:

- `adapters/cline/skill/` → `%USERPROFILE%\.cline\skills\session-cost\`
- `adapters/mcode/skill/` → `%USERPROFILE%\.minimax\skills\session-cost\`

Keep installed copies separate. They share the public skill name but use different runtime ledgers and token semantics.

## Quick usage

Cline:

```powershell
node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs"
node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs" --account
node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs" --dashboard
```

MiniMax Code:

```powershell
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs"
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --rates
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --dashboard
```

## Runtime differences

| Concern | Cline | MCode |
| --- | --- | --- |
| Primary data | `data/db/sessions.db` and message JSON | `v2/sqlite/runtime-state.sqlite` and session logs |
| `inputTokens` | Includes cached prompt tokens | `input_tokens` excludes cached tokens |
| Cost source | Recorded per-call `metrics.cost` | Provider-rate calculation for BYOK providers |
| Account mode | Optional read-only Cline API view | Not applicable; use rate coverage |
| Providers | Cline/ClinePass/OpenAI-compatible/etc. | Mirrored CommandCode and StepFun rates |

Never use the Cline fresh-input formula on MCode data.

## Development

Install no npm dependencies is required for the current skill tests; Node.js 22.15+ and the built-in `node:sqlite` module are required.

```powershell
npm run verify
```

Or run individual checks:

```powershell
npm test
npm run check:docs
npm run check:artifacts
npm run check:history
npm run check:report-contract
npm run check:provider-driver
npm run check:provider-diagnostics
npm run check:protocol-adapters
npm run check:config
npm run check:contracts
npm run check:cline
npm run check:mcode
```

The verification command performs syntax and generated-copy checks, validates the normalized JSON contract, runs recursively discovered Cline and MCode tests, exercises synthetic ledger fixtures, and checks dashboard safety.

## Free and optional support

The source code, skill installers, dashboards, and documentation are free under the MIT license. Payment is optional and is never required to use the Cline or MCode skill.

A Gumroad product may be offered for voluntary support, compatibility assistance, or sponsored development. Paid support must not unlock features that are already available in the public repository. Commercial terms are separate from the MIT grant and require legal review before publication. See [SUPPORT.md](SUPPORT.md).

## Documentation

- [Cline usage reference](adapters/cline/USAGE.md)
- [MCode usage reference](adapters/mcode/USAGE.md)
- [Architecture](docs/architecture.md)
- [Normalized report contract](contracts/README.md)
- [MCode porting plan](docs/porting-plan.md)
- [Optional support and troubleshooting](SUPPORT.md)
- [Internal optional-support launch checklist](docs/gumroad-selling-guide.html)
- [Cross-platform CI matrix template](docs/ci-matrix.yml)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [History secret and data audit](docs/history-audit.md)
- [Contributing guide](CONTRIBUTING.md)

## Security and privacy

Never commit API keys, OAuth tokens, `secrets.json`, `providers.json`, session databases, generated account reports, or local logs. `.gitignore`, `npm run check:artifacts`, and `npm run check:history` enforce this; the recorded history audit is in [docs/history-audit.md](docs/history-audit.md). Local session reporting is offline. Cline account mode makes read-only API requests using the user's own Cline authentication and never prints the credential.

## License

MIT. See [LICENSE](LICENSE).
