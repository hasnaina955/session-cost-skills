# Release, version, and package contract

This document defines repository releases. It does not itself create a release or a GitHub Actions release workflow.

## Version identity

There is one software version for the repository, Cline adapter, MCode adapter, and combined bundle:

1. `package.json` `version` is the source value for release `X.Y.Z`.
2. The Git tag is exactly `vX.Y.Z` and points to the release commit.
3. The GitHub release title and attached archives use the same `X.Y.Z` identity.
4. Every customer artifact contains a generated `RELEASE-VERSION.txt` whose only content is `X.Y.Z` followed by a newline.
5. `CHANGELOG.md` moves relevant `Unreleased` entries into an `X.Y.Z` section before tagging.

The current source-tree version is **0.2.0**. The current `Unreleased` work does not create a new version or tag by itself. A source checkout can be identified by `package.json`; a customer archive must use its `RELEASE-VERSION.txt` marker.

A paid-support listing has its own service period and terms. That service version never changes or replaces the MIT software version.

## License boundary

All source, skill files, documentation, and customer artifacts remain under the repository's MIT [LICENSE](../LICENSE). A release must include the unmodified root MIT license.

Optional paid support is a separate service. No release checklist, marketplace listing, or support agreement may instruct a publisher to replace the MIT license with commercial single-user terms or describe the public source as paid-only software.

## npm is not a distribution channel

`npm publish` is not supported. The current `package.json` is development metadata; its `private`/`files` fields must not be interpreted as permission to publish a partial repository to npm.

A future package-manager release would require a separately reviewed `package.json` change setting `private: true` for this repository-only contract, or defining a genuinely npm-ready package with `files`, entry points, included documentation, and tests. Until that happens, CI and maintainers must reject `npm publish`.

## Customer artifact allowlist

Archives are assembled from the tagged Git tree using this explicit allowlist. Do not copy the repository root, a working directory, or all of `adapters/*/skill` without applying the list.

### Common files in every artifact

- `LICENSE`
- `README.md`
- `CHANGELOG.md`
- `SECURITY.md`
- `SUPPORT.md`
- `docs/session-cost-support-pack.html`
- generated `RELEASE-VERSION.txt`

### Cline skill files

- `adapters/cline/skill/SKILL.md`
- `adapters/cline/skill/scripts/session-cost.mjs`
- `adapters/cline/skill/scripts/lib/cline-account.mjs`
- `adapters/cline/skill/scripts/lib/dashboard.mjs`
- `adapters/cline/skill/scripts/lib/session-cost-core.mjs`
- `adapters/cline/skill/references/storage.md`

### MCode skill files

- `adapters/mcode/skill/SKILL.md`
- `adapters/mcode/skill/scripts/session-cost.mjs`
- `adapters/mcode/skill/scripts/lib/dashboard.mjs`
- `adapters/mcode/skill/references/provider-rates.json`
- `adapters/mcode/skill/references/ledger-internals.md`

Tests, CI definitions, development scripts, `package.json`, `.git*`, local configuration, databases, transcripts, reports, logs, archives, checksums, and the operator-only selling guide are excluded. A new runtime file must be reviewed and added here deliberately before it can enter a release.

### Required layouts

Individual archives:

```text
<root>/
├── cline-session-cost/   # Cline allowlist contents only
├── docs/
│   └── session-cost-support-pack.html
├── CHANGELOG.md
├── LICENSE
├── README.md
├── RELEASE-VERSION.txt
├── SECURITY.md
└── SUPPORT.md
```

The MCode archive has the same layout with `mcode-session-cost/`. The combined bundle contains both wrapper directories and the common files.

Those wrappers are staging names only. Installation copies the **contents** of a wrapper to one of these exact destinations:

```text
%USERPROFILE%\.cline\skills\session-cost\
%USERPROFILE%\.minimax\skills\session-cost\
```

CI stages these allowlists into temporary clean homes and asserts both `SKILL.md` paths plus both `--help` commands. Ignore rules are not used as the package boundary.

## Release procedure

1. Start from an up-to-date, reviewed default branch with a clean worktree.
2. Run the full Node matrix, Bun smoke job, documentation/encoding checks, package allowlist smoke, and redacted history scan in CI.
3. Review every runtime-owned `SKILL.md`, usage page, and packaged reference against this contract. In particular, remove stale claims about an assumed-zero MCode cache-write rate, per-provider refresh retention, recursive MCode children, the Node support floor, or incomplete Cline credential precedence. Do not tag while packaged guidance conflicts.
4. Update `package.json`, `CHANGELOG.md`, and version-bearing documentation in one reviewed release-preparation change. This requires approval to edit `package.json`; it is intentionally not performed by documentation-only work.
5. Create annotated tag `vX.Y.Z` only after the release commit passes CI.
6. Build `cline`, `mcode`, and `bundle` archives from the tagged tree using the allowlist above. Normalize archive ordering, permissions, and timestamps so repeated builds from the same tag are byte-for-byte reproducible.
7. Generate SHA-256 checksums for every uploaded archive in a separate `SHA256SUMS` file.
8. Extract each archive into a clean temporary home, assert the exact `SKILL.md` paths, and run both CLI `--help` smoke checks with the floor runtime.
9. Attach only the three archives, `SHA256SUMS`, and the changelog to the GitHub release. Verify tag, package version, artifact version markers, filenames, and checksums against one another.
10. Keep generated archives and checksums ignored; release assets are outputs, not source files.

Expected names:

```text
session-cost-skills-cline-vX.Y.Z.zip
session-cost-skills-mcode-vX.Y.Z.zip
session-cost-skills-bundle-vX.Y.Z.zip
SHA256SUMS
```

## Deferred automation

A deterministic packaging command should eventually be invoked as, for example:

```text
npm run package -- --version X.Y.Z --out dist
```

and a release gate as:

```text
npm run release:check -- --version X.Y.Z
```

Neither command exists today. Adding them requires changes to `package.json` and a release script; this task is not allowed to make those changes. Until they exist, a release owner must follow the manual procedure and retain the rehearsal evidence.

A tag-triggered GitHub release workflow is also deferred. It is a new workflow file, needs least-privilege write permissions only in the release job, and must download/reverify the exact artifacts rather than rebuilding them. It should not be approximated by broadening the read-only verification workflow.

## Pinned action updates

Every third-party action in `.github/workflows/ci.yml` is pinned to a full commit SHA with a human-readable version comment. To update one:

1. Review the action's release notes and tag diff.
2. Resolve the intended tag to a full commit SHA through the trusted repository.
3. Update the SHA and version comment together; never switch to a mutable major/minor tag.
4. Re-run the full Windows/Ubuntu/macOS Node matrix, Bun job, and repository-contract checks.

Renovate/Dependabot may propose SHA updates, but a maintainer must review provenance and the resulting diff before merge.
