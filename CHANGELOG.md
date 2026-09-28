# Changelog

All notable changes to this project are documented here. `Unreleased` is a staging section, not a package version; the current package version remains **0.2.0** until a release commit and matching `vX.Y.Z` tag are created.

## Unreleased

### Changed

- Define one repository/adapter/bundle software version, matching `vX.Y.Z` tag, generated installed-version marker, and GitHub release contract in the [release contract](docs/release.md)
- Prohibit npm publication and clarify that optional paid support is separate from the MIT software license
- Raise the documented support floor to Node.js 22.13.0; document Bun 1.4.2+ as an optional CI-tested runtime
- Exercise Node floor/current and Bun smoke tests on Windows, Ubuntu, and macOS with read-only workflow permissions and commit-pinned actions
- Add documentation encoding, local-link, license-contract, history-secret, package-allowlist, and clean-install checks to CI

### Fixed

- Repair the customer support pack encoding and replace commercial-relicense instructions with the MIT/service boundary
- Correct Cline and MCode install destinations and add a clean `SKILL.md` assertion
- Document MCode cache-write billing, network rate refresh and rate-file writes, direct-child folding, Cline recursive child folding, credential precedence, and output privacy
- Replace orphaned private selling text with a public [optional-support listing guide](docs/gumroad-selling-guide.html)
- Link the [customer support pack](docs/session-cost-support-pack.html), [release contract](docs/release.md), [support policy](SUPPORT.md), [security policy](SECURITY.md), and optional-support guide from the README

### Security

- Ignore Cline `providers.json`, `secrets.json`, `*.db` sidecars, MCode SQLite files, copied runtime transcripts, generated archives, and checksums
- Require customer archives to be built from an explicit allowlist rather than repository-root copying
- Document a redacted, all-reachable-objects history audit and ongoing audit procedure

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
- Optional-support listing guide
- Free software with optional paid support policy
- Security, contribution, changelog, and CI documentation

### Compatibility

- Node.js 22.5 or newer in the 0.2.0 baseline; the Unreleased support floor is 22.13.0
- Windows 10/11 baseline, with Windows/Ubuntu/macOS CI coverage added in Unreleased
- Cline CLI and MiniMax Code CLI have separate adapters and installation targets
