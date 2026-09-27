# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- `docs/principles.md` lists the 16 rules this project does not trade, each linked to the test
  that enforces it. The CHANGELOG had been citing "non-negotiable rule 1" for two releases with no
  document defining the rules, so a contributor or agent could not follow rules they could not
  find. Two rules cannot be test-enforced and say so: no forecasting, and the free-software
  guarantee. `check:docs` now fails if the document cites a `tests/` file that does not exist, so
  a rule cannot claim enforcement it does not have.
- `tests/invariants.test.mjs` checks seven accounting properties over randomly generated ledgers
  rather than fixed ones: the total is exactly the sum of per-model, per-session, and per-component
  costs; an unpriced call never becomes a `0` total; token totals reconcile under each runtime's
  own input semantics; per-model rows sum to the ledger read directly in SQL; `--include-children`
  counts each descendant once; the text, CSV, and JSON reports agree; and reordering ledger rows
  changes no figure. Every wrong-money bug in this project's history produced a plausible number
  rather than an error, and a spot assertion on one fixture misses that class. The ledger-anchored
  test is the one that matters: it caught an injected cache-write double-count that the
  self-consistent reconciliations all missed, because every side of those equalities came from the
  same accumulator. Ledgers are seeded and replayable via `INVARIANT_SEED=<n>`.
- `SESSION_COST_NOW` pins the reported clock: `generatedAt`, snapshot `capturedAt`, and the UTC
  day boundary `--today` uses. With the clock pinned, two runs of the same command produce
  byte-identical output, which is what makes rendered output testable at all. An invalid value
  fails with one readable line naming the variable rather than silently falling back to the real
  clock, because a silent fallback is the failure the hook exists to prevent. This is a test and
  diagnostics hook, not a user setting. The `--watch` poll loop and the live view's "last ledger
  activity Ns ago" line keep the real clock, since elapsed time against a pinned clock means
  nothing. See `docs/configuration.md`.

### Fixed

- The MCode contract fixture could be priced by the bundled rate table, which made one contract
  test a function of the wall clock rather than of the code. `tests/rate-provenance.test.mjs`
  deliberately runs the CLI *without* `SESSION_COST_RATES_PATH` to prove that a session the
  fixture cannot price reports no provenance and a `null` cost rather than `$0.0000`. Its session
  dates are relative to now, and the fixture's stepfun model was named `step-5-preview`, which
  the bundled catalog also publishes. Bundled records with no explicit effective date inherit the
  provider's `fetchedAt`, so that model became priceable the moment the fixture's `now - 2d`
  window crossed the table's `2026-09-25T09:01Z` refresh: `tests/rate-provenance.test.mjs` passed
  on 2026-09-26 and failed on 2026-09-27 on one unchanged commit, and the 0.4.1 CI run of that
  commit is still green today. The fixture's model names are now synthetic, and a new test
  asserts that no fixture model is a key in the bundled table, so the next collision is a test
  failure rather than a surprise the day after a rate refresh moves the boundary. Every other
  `step-5-preview` reference is untouched: those tests deliberately exercise the real StepFun
  parser and the published catalog.
- Every reported timestamp in both adapters read the real clock directly, so output depended on
  the day the report was produced. That is the condition that let the fixture bug above pass on one
  day and fail on the next, and it also blocked the snapshot tests that visual work needs. All
  reporting paths now take the clock from `shared/clock.mjs`, and
  `tests/clock-determinism.test.mjs` fails the build if a reporting path reads the real clock
  without a preceding `// clock: real-time` comment, so the next one has to be a written-down
  choice rather than an oversight. `shared/budget.mjs` keeps its bare `Date.now()` default: that
  module is contractually import-free so that no dependency can be pulled in, and it already
  accepts the clock as an argument.
- The README quoted `session-cost 0.3.0` in its `--version` example, two releases behind the
  published 0.4.1. `check:docs` now asserts the quoted version against `package.json`, so it
  cannot drift again.

- A renamed column in a runtime's own storage no longer reads as zero. A `SELECT` against a
  missing column does not throw: the row carries `undefined` and the aggregate treats it as
  nothing, so a session reports a smaller bill with complete coverage instead of an error - the
  silent-zero failure this project treats as its worst bug class, arriving through storage
  rather than through pricing. Each adapter now declares the columns it reads, compares them
  against `PRAGMA table_info` before computing any figure, and fails with one line naming the
  table and column. An *extra* column is reported as `newer` rather than treated as a failure,
  because a runtime that grows a column is normal. `doctor` carries a `storage` block with the
  observed schema and a stable fingerprint, so a report says which layout it read.
- Bun now runs on Windows in CI as well as Ubuntu. Windows previously failed 11 tests with
  `EBUSY: resource busy or locked, rm '<tmpdir>'`: the fixtures deleted a temp directory while
  its SQLite handle was still open, which POSIX permits and Windows refuses. Directory cleanup
  now goes through `removeDirectory` in `tests/helpers/temp-dir.mjs`, which retries, and
  `tests/temp-cleanup-contract.test.mjs` fails if a new test deletes a directory with a bare
  `fs.rmSync`, so the failure cannot return quietly.

- `tests/fuzz.test.mjs` fuzzes the untrusted-input surfaces with seeded, replayable mutations
  (`FUZZ_SEED=<n>`): a session log torn mid-write, a truncated Cline message file, hostile provider
  pricing pages, and unusable token counts. The invariant is that nothing throws uncaught, nothing
  prints a stack trace or a local path, and nothing exits 0 with unparseable JSON. The in-process
  parser targets run 2,000 mutations each; the two that spawn a real CLI run 100, because a
  suite nobody runs catches nothing. Three findings are recorded in the file as comments rather
  than papered over: `messages.jsonl` is not MCode's money path (the SQLite ledger is, which
  changed what the test could honestly claim), `bandForTimestamp` throws on an unparseable
  timestamp so banded rates cannot silently misprice, and `calculateTokenCost` coerces unusable
  token counts - tracked as #67 and pinned by a `KNOWN GAP` test rather than fixed inside a
  test-only change.

## 0.4.1

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
