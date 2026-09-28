# Session Cost Skills

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Local-first token, cache, billing, and usage dashboards for the Cline and MiniMax Code (`MCode`) `session-cost` skills.

Current repository version: **0.2.0**. A version in `package.json` is not by itself a published release; the matching `vX.Y.Z` tag and GitHub release are the release authority. See the [release and package contract](docs/release.md).

## Status

- Public MIT-licensed source, documentation, and dashboards
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
- Cache-read and cache-write semantics preserved per runtime
- Self-contained HTML dashboards with no external assets
- Versioned JSON output

## Requirements

| Runtime | Support contract |
| --- | --- |
| Node.js | **22.13.0 or newer** is the project support floor declared by `package.json`. The built-in `node:sqlite` API appeared earlier, but that API introduction is not the project support promise. |
| Bun | **Bun 1.4.2 or newer** is an optional, CI-tested compatibility runtime. CI runs the adapter tests and CLI smoke checks with Bun; Node.js remains the reference runtime and declared engine. |
| Operating systems | Windows, Ubuntu, and macOS are exercised in CI. Windows PowerShell install commands are shown below; use the equivalent home-directory paths on Linux/macOS. |
| Runtimes | Cline CLI or MiniMax Code CLI, depending on the adapter. |

Node.js 22.13.0 is the minimum supported runtime under this repository contract. No npm dependencies are required to run the current verification suite.

## Installation

The source is split into two independently installable skills:

| Adapter source | Windows destination | Linux/macOS destination |
| --- | --- | --- |
| `adapters/cline/skill/` | `%USERPROFILE%\.cline\skills\session-cost\` | `$HOME/.cline/skills/session-cost/` |
| `adapters/mcode/skill/` | `%USERPROFILE%\.minimax\skills\session-cost\` | `$HOME/.minimax/skills/session-cost/` |

Keep installed copies separate. They share the public skill name but use different runtime ledgers and token semantics.

From a Windows checkout:

```powershell
$Repo = "C:\path\to\session-cost-skills"
$ClineSkill = "$env:USERPROFILE\.cline\skills\session-cost"
$MCodeSkill = "$env:USERPROFILE\.minimax\skills\session-cost"

New-Item -ItemType Directory -Force $ClineSkill | Out-Null
New-Item -ItemType Directory -Force $MCodeSkill | Out-Null
Copy-Item -Path "$Repo\adapters\cline\skill\*" -Destination $ClineSkill -Recurse -Force
Copy-Item -Path "$Repo\adapters\mcode\skill\*" -Destination $MCodeSkill -Recurse -Force

if (-not (Test-Path "$ClineSkill\SKILL.md")) { throw "Cline install is incomplete" }
if (-not (Test-Path "$MCodeSkill\SKILL.md")) { throw "MCode install is incomplete" }
node "$ClineSkill\scripts\session-cost.mjs" --help
node "$MCodeSkill\scripts\session-cost.mjs" --help
```

From a Linux/macOS checkout:

```bash
mkdir -p "$HOME/.cline/skills/session-cost" "$HOME/.minimax/skills/session-cost"
cp -R adapters/cline/skill/. "$HOME/.cline/skills/session-cost/"
cp -R adapters/mcode/skill/. "$HOME/.minimax/skills/session-cost/"
test -f "$HOME/.cline/skills/session-cost/SKILL.md"
test -f "$HOME/.minimax/skills/session-cost/SKILL.md"
```

For a release archive, copy the **contents** of `cline-session-cost/` or `mcode-session-cost/` into the exact `session-cost/` destination above. Do not install the wrapper directory under its artifact name.

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
| Ledger access | Database is opened read-only | Database and message logs are read for reports |
| `inputTokens` / `input_tokens` | Includes cached prompt tokens | Excludes cached tokens and is fresh input |
| Cost source | Recorded per-call `metrics.cost` | Provider-rate calculation for mirrored BYOK providers |
| Account mode | Optional read-only Cline API view | Not applicable; use rate coverage |
| Children | `--include-children` recursively includes every descendant | `--include-children` includes direct child sessions only in 0.2.0 |
| Default rate operation | Not applicable | Reads bundled `references/provider-rates.json`; no network request |
| Rate refresh | Not applicable | `--refresh-rates` uses the network and atomically rewrites the installed rate file only after all sources validate |

Never use the Cline fresh-input formula on MCode data. Cached tokens are already included in Cline `inputTokens`, while MCode `input_tokens` is fresh-only.

### MCode cache-write and network details

MCode reports cache-read and cache-write tokens separately. A published cache-write rate is used when the provider supplies one. A missing rate remains **unknown, never an assumed zero**; a call with positive cache-write tokens and no published rate makes pricing coverage partial/unknown. StepFun `step-5-preview` is the explicit exception: its cache writes use that model's input rate. A normal report, including `--rates`, uses the bundled mirrored rate file and does not refresh it.

`--refresh-rates` is the explicit exception: it fetches and validates CommandCode and StepFun rate sources, then atomically writes the installed skill's `references/provider-rates.json` only when all sources succeed. If any source fails or produces an invalid table and a previous valid table exists, the whole previous table is retained and no file is written. Treat that installed skill directory as writable when planning an explicit refresh and keep a backup.

### Cline account credentials and privacy

`--account` is the only Cline operation that uses the account API. Credential precedence is:

1. `CLINE_API_KEY`
2. A non-expired OAuth access token in `data/settings/providers.json` for `cline` or `cline-pass`
3. Legacy `data/secrets.json` `apiKey`

The key is used for read-only requests to Cline and is not printed or embedded in output. Local session reports do not call that API.

Both adapters' HTML dashboards are self-contained and make no network requests when opened. The generated file can still contain sensitive session titles, IDs, model/provider names, token totals, costs, and account identifiers. Treat JSON and HTML output as private data.

## Development

```powershell
npm run verify
```

Or run the current checks individually:

```powershell
npm test
npm run check:cline
npm run check:mcode
```

The verification command performs syntax checks, dashboard safety tests, credential redaction checks, and adapter tests. CI also exercises the supported Node floor, the current Node release, and Bun 1.4 across Windows, Ubuntu, and macOS.

The repository is not published to npm. Do not run `npm publish`; customer delivery uses the allowlisted release archives defined in [docs/release.md](docs/release.md).

## Free and optional support

The source code, skill installers, dashboards, and documentation are free under the MIT license. Payment is optional and is never required to use the Cline or MCode skill.

An optional support listing may provide installation help, compatibility assistance, confirmed bug triage, migration guidance, or sponsored development. Any paid terms cover only the defined service; they do not relicense, rebrand, or remove rights from the MIT source.

## Documentation

- [Cline usage reference](adapters/cline/USAGE.md)
- [MCode usage reference](adapters/mcode/USAGE.md)
- [Architecture](docs/architecture.md)
- [MCode porting plan](docs/porting-plan.md)
- [Release and package contract](docs/release.md)
- [Customer support pack](docs/session-cost-support-pack.html)
- [Optional support listing guide](docs/gumroad-selling-guide.html)
- [Changelog](CHANGELOG.md)
- [Security policy](SECURITY.md)
- [Support policy](SUPPORT.md)
- [Contributing guide](CONTRIBUTING.md)

## Security and privacy

Never commit API keys, OAuth tokens, `providers.json`, `secrets.json`, Cline/MCode session databases or sidecars, runtime transcripts, generated account reports, or local logs. See [SECURITY.md](SECURITY.md) for network/write disclosures, repository history-audit guidance, and the point-in-time audit result.

## License

MIT for the software and documentation. See [LICENSE](LICENSE). Optional paid support is a separate service and is not a commercial software license.
