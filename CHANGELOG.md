# Changelog

All notable changes to this project are documented here.

## Unreleased

### Added

- Added fingerprinted effective-dated rate records with context thresholds, time bands, source metadata, and immutable refresh history.
- Added a versioned provider-driver contract with deterministic detection, aliases, capability declarations, and safe user-module loading.
- Added layered project/user configuration, provider profiles, safe secret references, and config lifecycle commands.

### Security

- Replaced browser-side dashboard HTML sinks with DOM text construction and locked dashboards to a hash-scoped, offline content security policy.
- Added regression coverage for malicious model, provider, session, title, filter, and rate metadata in both adapters.

### Fixed

- Corrected MCode CommandCode cache-write pricing, made missing rate components fail validation, and made provider refreshes atomic and all-or-nothing.
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

- Node.js 22.5 or newer
- Windows 10/11
- Cline CLI and MiniMax Code CLI have separate adapters and installation targets
