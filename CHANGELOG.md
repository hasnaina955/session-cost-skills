# Changelog

All notable changes to this project are documented here.

## Unreleased

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

### Security

- Replaced browser-side dashboard HTML sinks with DOM text construction and locked dashboards to a hash-scoped, offline content security policy.
- Added regression coverage for malicious model, provider, session, title, filter, and rate metadata in both adapters.

### Fixed

- Corrected MCode CommandCode cache-write pricing, made missing rate components fail validation, and made provider refreshes atomic and all-or-nothing.
- Corrected CommandCode rendered-row parsing so non-1M context rows and 50% promo rows are published, including MiniMax M3.
- Made Cline and MCode descendant selection recursive and duplicate-free, with explicit included, excluded, and suppressed session IDs.

### Changed

- Added a formal normalized report contract shared by both CLIs, including token semantics, cost basis, provenance, coverage, warnings, selection, and session-graph state.
- Label MCode rate-derived totals as estimates rather than runtime-recorded charges.
- Discover every adapter and contract test recursively instead of maintaining a partial package script list.
- Generate independently installable Cline and MCode dashboard renderers from one canonical implementation and fail verification when copies drift.

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
