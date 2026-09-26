# Release, version, and package contract

This document defines what gets released, how it is versioned, and how a customer verifies
what they installed. It is the answer to "which version am I running?" for this repository.

## Version relationships

| Version | Where it lives | Rules |
| --- | --- | --- |
| Release version | `package.json` `version` | The single semantic version for the whole repository. |
| Adapter version | `adapters/<runtime>/skill/VERSION` | Must equal the release version exactly. |
| Archive version | Archive file name | `session-cost-<runtime>-v<version>.zip`; must equal the release version. |
| Report contract version | `REPORT_CONTRACT_VERSION` in `report-contract.mjs` | Independent. Changes only when the normalized report schema changes. |
| Optional support | The published support offering | Separate and commercial. Never gates a repository feature. |

There is exactly one version number in this project: the release version. The repository,
every adapter skill, and every archive always agree. A skill installed from an older
archive keeps reporting its own older version; it never inherits a newer number.

The report contract version is deliberately independent. A release can ship a new report
contract without changing adapter behavior, and an adapter can be patched without
invalidating the contract. `npm run check:version` enforces that these two never drift
into the same number by accident.

Optional paid support is a separate commercial product with its own terms. It never changes
a code version, never unlocks a repository feature, and never appears in a version banner.

## Identifying an installed version

Every installed skill answers `--version` without touching session storage:

```powershell
node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs" --version
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --version
node "$env:USERPROFILE\.config\opencode\skill\session-cost\scripts\session-cost.mjs" --version
```

```text
session-cost 0.3.0 (cline adapter)
report contract: 1.2.0
node: 24.21.0 (requires >= 22.15.0)
```

The `VERSION` file in the skill root carries the same number for tools that read files
rather than run commands. If the file is missing or malformed the banner reports
`0.0.0-unknown` instead of guessing.

## Distribution

npm is **not** a distribution channel. `package.json` is `private: true` and defines no
`files` allowlist, so an accidental `npm publish` cannot ship a skill as a package. The
repository is the source of truth; GitHub releases are the artifact channel.

| Archive | Contents | Install target |
| --- | --- | --- |
| `session-cost-cline-v<version>.zip` | `cline/` — the installable Cline skill | `%USERPROFILE%\.cline\skills\session-cost\` |
| `session-cost-mcode-v<version>.zip` | `mcode/` — the installable MCode skill | `%USERPROFILE%\.minimax\skills\session-cost\` |
| `session-cost-opencode-v<version>.zip` | `opencode/` — the installable OpenCode skill | `%USERPROFILE%\.config\opencode\skill\session-cost\` |
| `session-cost-bundle-v<version>.zip` | Every skill plus README, LICENSE, CHANGELOG, SUPPORT | Choose one skill directory |

`SHA256SUMS.txt` accompanies every release. Verify an archive before installing it:

```powershell
Get-FileHash .\session-cost-cline-v0.3.0.zip -Algorithm SHA256
```

The skills are versioned together but installed separately. They share a version number,
never a directory, and never a ledger.

## What never ships

Packaging refuses to build rather than silently including local data. Rejected paths include
`secrets.json`, `providers.json`, `.env` files, `*.db`/`*.sqlite` session databases, message
transcripts, generated reports and dashboards, runtime state directories, and local
`.session-cost` state. Adapter regression tests are also excluded: they are repository
coverage, not part of an installed skill.

## Reproducible archives

`npm run build:release` produces byte-identical archives from the same commit on any
operating system. Entries are sorted by path, stored without compression so no zlib version
can alter the bytes, and stamped with a fixed timestamp so the build clock never leaks in.
The implementation is dependency-free (`scripts/lib/release-pkg.mjs`).

```powershell
npm run build:release     # writes dist/*.zip and dist/SHA256SUMS.txt
npm run check:release     # confirms dist/ matches what this commit should produce
```

## Release process

1. Land the change on a branch and open a pull request. `npm run verify` must pass, including
   the version contract, the generated-copy checks, and the full test suite.
2. Update `CHANGELOG.md`. Keep work under `## Unreleased`; move it into a `## <version>`
   section when cutting the release.
3. Bump `package.json` `version` and every `adapters/<runtime>/skill/VERSION` file together.
   `npm run check:version` fails if they disagree, if the changelog has no matching section,
   or if the package would become publishable.
4. Run the rehearsal. It builds the archives, extracts them the way a customer would, and
   runs `--version`, `--help`, a report, and a dashboard from each extracted copy:

   ```powershell
   npm run rehearse:release
   ```

5. Tag `v<version>` and push the tag. The release workflow rebuilds the archives, verifies
   their checksums, re-runs the rehearsal, and attaches them to the GitHub release.
6. Confirm the GitHub release for the tag contains exactly one archive per adapter, the
   bundle, and `SHA256SUMS.txt`, and that the checksums match a local `npm run build:release`.

`npm run check:release` intentionally is **not** part of `npm run verify`: it compares
against a built `dist/`, which does not exist in a fresh checkout. The release workflow and
`npm run rehearse:release` are what verify artifacts.

## Supported runtime matrix

Node.js 22.15 or newer. 22.15 is the floor because `node:sqlite` is required by every
adapter; CI exercises that exact floor alongside the current release. Windows, Ubuntu, and
macOS are all covered. `.github/workflows/ci.yml` is the single source of truth for the
matrix, and every action is pinned to a full commit SHA.

| Adapter | Ledger | `runtime.costBasis` |
| --- | --- | --- |
| Cline | `data/db/sessions.db` plus message JSON | `runtime-recorded` |
| MCode | `v2/sqlite/runtime-state.sqlite` plus session logs | `provider-rate-estimate` |
| OpenCode | `.local/share/opencode/opencode.db`, both message stores | `provider-rate-estimate` |
