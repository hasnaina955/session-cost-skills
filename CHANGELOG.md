# Changelog

All notable changes to this project are documented here.

## Unreleased

Nothing yet. The next batch of changes lands here before it is cut into a release.

## 0.3.0

### Added

- Added fingerprinted effective-dated rate records with context thresholds, time bands, source metadata, and immutable refresh history.
- Added a versioned provider-driver contract with deterministic detection, aliases, capability declarations, and safe user-module loading.
- Added layered project/user configuration, provider profiles, safe secret references, and config lifecycle commands.
- Added secret-safe doctor/provider/model discovery and deterministic match explanations with suggestion-only aliases.
- Added OpenAI/Anthropic-compatible protocol drivers, custom endpoint profiles, and manual or imported effective rate cards.
- Made explicit, runtime-provided, active-root, ambiguous, and zero-call session selection explicit across both adapters.
- Separated Cline end-to-end aggregates from reconstructed session scope and made billing classification provider-aware.
- Made Cline account history windows exact, period completeness explicit, and malformed API pages fail deterministically.
- Reconciled MIT and optional-support terms, corrected install paths, and added UTF-8/legal-copy documentation checks.
- Added cross-platform/Bun CI matrix templates, artifact allowlist checks, and a Node.js 22.15 runtime floor.
- Added repository secret/data ignore rules, a history-wide audit, and a documented audit result.
- Added a release version contract: a single semantic version shared by the repository, both adapter skills, and every archive.
- Added a `VERSION` file and `--version` flag to both skills so an installed copy identifies itself without the repository.
- Added reproducible Cline, MCode, and combined release archives with published SHA-256 checksums.

### Security

- Replaced browser-side dashboard HTML sinks with DOM text construction and locked dashboards to a hash-scoped, offline content security policy.
- Added regression coverage for malicious model, provider, session, title, filter, and rate metadata in both adapters.
- Set the package to `private` so no npm publication can leak a skill source as an unintended package.

### Fixed

- Corrected MCode CommandCode cache-write pricing, made missing rate components fail validation, and made provider refreshes atomic and all-or-nothing.
- Corrected CommandCode rendered-row parsing so non-1M context rows and 50% promo rows are published, including MiniMax M3.
- Made Cline and MCode descendant selection recursive and duplicate-free, with explicit included, excluded, and suppressed session IDs.

### Changed

- Added a formal normalized report contract shared by both CLIs, including token semantics, cost basis, provenance, coverage, warnings, selection, and session-graph state.
- Label MCode rate-derived totals as estimates rather than runtime-recorded charges.
- Discover every adapter and contract test recursively instead of maintaining a partial package script list.
- Generate independently installable Cline and MCode dashboard renderers from one canonical implementation and fail verification when copies drift.
- Documented the relationship between release, adapter, report-contract, and optional-support versions in [docs/release.md](docs/release.md).

### Also in this release

### Fixed
- A corrupt or unreadable session database no longer prints a raw Node stack trace quoting
  the full local install path. Both adapters now report one readable line, for example
  `Cline session database could not be read (sessions.db): the file is not a readable database`.
  `node:sqlite` opens lazily, so the schema is now probed inside the guard.
- A database whose schema lacks the expected table now fails instead of reading as an empty
  ledger. An empty successful report was indistinguishable from a genuine "no sessions" result.
- Rate refreshes now have a request deadline, a response-size cap, and a content-type check.
  A hung socket previously left the refresh running indefinitely and a hostile endpoint could
  stream until the process died.
- Rate fetch failures no longer echo the offending URL or a local path back to the user.
- Dashboard writes are now atomic: a temp file plus rename, so an interrupted write can no
  longer leave a half-written HTML file that is indistinguishable from a good one. A failed
  write removes its temp file and names the target by basename only.
- MCode no longer prints a stack trace for an unexpected failure. Set `SESSION_COST_DEBUG=1`
  to opt back in to the full trace when diagnosing a defect.

### Fixed (accounting)
- Corrected peak/off-peak pricing for OpenAI- and Anthropic-compatible provider profiles.
  `bandForTimestamp` did `new Date(Number(timestamp))`, and `Number()` of an ISO-8601 string is
  `NaN`, so every ISO timestamp resolved to off-peak and **silently under-reported cost** during
  peak windows. An ISO `at` now prices identically to the same instant as epoch milliseconds.
- Stopped applying CommandCode/StepFun's peak calendar to arbitrary third-party providers. A
  profile that declares both peak and off-peak records but no time-of-day policy now reports
  `coverage: unavailable` instead of guessing a band.
- `bandForTimestamp` now throws on an unparseable timestamp rather than falling through to
  off-peak, and returns `flat` for an empty time-of-day policy.
- Fixed the Anthropic-compatible stream parser. The Messages API emits server-sent events, but
  the parser treated every line as bare JSON and threw on the first `event:` line, so no
  Anthropic-compatible streaming usage could ever be read.
- `doctor` and `providers` now report the manifest `fingerprint` the provider-driver contract
  requires. Built-in manifests were surfaced raw and never passed through the registry, so
  `doctor --json` listed driver identities the pricing path could not reproduce.
- Replaced two hand-rolled argument parsers with one shared option schema, so both adapters
  accept, reject, and explain the same flags identically.
- `--list` no longer consumes the following flag as its count. `--list --json` used to
  silently discard `--json` and return a single-session report instead of a list.
- Every value-taking flag now requires a value. `--session` with no value used to swallow
  the next flag and report it as a session id.
- Conflicting flags are rejected instead of silently overridden. `--last --today` used to
  discard `--last` and run `--today`.
- Numeric ranges (`--list`, `--account-days`) and calendar dates are validated before any
  storage is opened, so a bad invocation fails immediately instead of after loading a ledger.
- `--account-days abc` no longer crashes MCode with a raw stack trace.

### Added
- Documented the configuration system, provider-driver contract, model-matching precedence,
  and skill migration in `docs/configuration.md`, `docs/provider-drivers.md`,
  `docs/model-matching.md`, and `docs/migration.md`.
- Added offline fixtures covering every built-in provider driver in both adapters plus the
  generic OpenAI- and Anthropic-compatible protocol drivers.

### Changed
- Both help texts now document the `--models-discover` and `--config-explain` spellings, which
  the schema accepted but the help text never mentioned.
- `--help` and `--version` answer immediately even when combined with invalid flags.

## 0.2.0

### Added

- Public MIT-licensed Cline and MCode skill sources
- Cline OAuth credential resolution and live account mode
- Cline daily, weekly, monthly, and account-limit reporting
- MCode command parity with Cline
- MCode rate-coverage view
- Interactive self-contained HTML dashboards
- Provider/model/search filters and dynamic dashboard statistics
- Subagent-aware aggregation
- Versioned JSON output
- Cline and MCode usage references
- Gumroad selling guide
- Free software with optional paid support policy
- Security, contribution, changelog, and CI documentation

### Compatibility

- Node.js 22.15 or newer
- Windows 10/11
- Cline CLI and MiniMax Code CLI have separate adapters and installation targets
