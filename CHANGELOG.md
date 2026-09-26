# Changelog

All notable changes to this project are documented here.

## Unreleased

### Fixed

- `--watch` reported `$0.0000` for a session it could not price. Non-negotiable rule 1 says an
  unknown cost is `null`, never `0`, and both adapters keep a legacy `totalCost` aggregate that
  is `0` - not `null` - when nothing could be priced, so the guard fell through to it and turned
  "we do not know what this cost" into a figure a reader takes as "this session was free". The
  same trap applied to every model row. Found by watching a live MCode session on a model with
  no mirrored rate, where the text report correctly said `COST UNAVAILABLE` while the live view
  showed `$0.0000` for the same session. The report's own declared verdict now wins, and the
  legacy aggregate is only consulted when nothing contradicts it.
- `--refresh-rates` could never succeed. `RATES_SOURCE.stepfun` is a raw `.md` document that
  correctly answers `content-type: text/markdown`, and `text/markdown` was missing from the
  allowlist, so `fetchText` rejected the skill's own configured URL. Because the refresh is
  transactional, the successful CommandCode fetch was discarded with it, so rate tables silently
  froze while the tool kept reporting plausible numbers. The allowlist and `RATES_SOURCE` are two
  independent declarations of one fact and had drifted; `adapters/mcode/skill/tests/rates-refresh-source.test.mjs`
  now asserts they agree, and still refuses genuinely hostile content types.
- The bundled-catalog test pinned the live provider's exact model counts (`79/78/1`), so a correct
  `--refresh-rates` turned the suite red when CommandCode published an 80th model - teaching the
  next person that refreshing rates is a test failure. Those numbers are data, not behaviour. The
  test now asserts the coverage block is internally consistent and that the MiniMax flagship is
  inside the priceable set, which is what its name claims.

### Added

- `tests/builtin-rate-fixtures.test.mjs` closes the asymmetry between the two driver families. The
  generic protocol drivers already assert that their offline usage, stream and pricing fixtures
  cover the protocol driver list, so a protocol driver cannot be added without them. The built-in
  drivers that mirror a pricing page over the network - commandcode and stepfun - had no such
  guard: their parser cases lived in the MCode adapter's suite as inline assertions with nothing
  tying them to the manifest list, so a new `rateRetrieval: 'network'` driver could ship with a
  parser that had never run without a network call and CI would stay green. All three wrong-money
  bugs fixed in 0.4.0 lived in exactly such parsers.

## 0.4.0

### Added

- CI now runs the full matrix: `npm run verify` on ubuntu, windows, and macos against Node 22.15
  and 24 with fail-fast disabled, the full test suite under Bun on ubuntu, and a release
  rehearsal on ubuntu and windows. The declared Node 22.15 floor and the ubuntu/macos runners
  were claimed but never exercised before this; a regression on either now fails a push.
- `.github/workflows/release.yml` is new. A tag push verifies the tree, rehearses the install
  from the archives, rebuilds them, confirms the published checksums and that the tag matches
  `package.json`, then publishes the archives with `SHA256SUMS.txt`. Releases were cut by hand
  until now, which is why `docs/release.md` referred to a release workflow that did not exist.

### Fixed

- `tests/release-contract.test.mjs` derived the repository root from
  `new URL(import.meta.url).pathname`, which yields a `/C:/...` path on Windows and resolved to
  `C:\C:\...`. The file threw while being imported, so all ten of its tests - including the
  published-checksum verification - never ran, and `npm run verify` failed on `windows-latest`.
  It now uses `fileURLToPath`, as the rest of the repository does.
- `CONTRIBUTING.md` and `docs/ci-matrix.yml` described a CI matrix (ubuntu/windows/macos against
  Node 22.15 and 24, plus Bun and release-rehearsal jobs) that no workflow implemented. Both now
  describe what CI actually runs.
- `scripts/run-tests.mjs` invokes Bun's runner correctly. It spawned `process.execPath --test`,
  which under Bun is `bun --test` - not Bun's runner, so every file ran as a plain script and
  each suite threw `Cannot use test outside of the test runner`, exiting 1. It now uses
  `bun test` and raises Bun's 5000ms default per-test timeout, which `node:test` does not impose
  and which the slowest CLI end-to-end test exceeds.

### Security

- `ci.yml` now pins `actions/checkout` and `actions/setup-node` to full commit SHAs instead of
  mutable `@v4` tags, and declares least-privilege `contents: read` permissions. A moved tag
  previously let a third party change what release CI executed with no pull request.
- `npm run check:workflows` is now part of `npm run verify`, so the pin policy is enforced on
  every push rather than only when run by hand.

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
