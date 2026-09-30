# Updating an installed skill

How to move an installed `session-cost` skill to a newer release, on Windows, macOS, or Linux,
without losing anything. For what changed in a given version, read [CHANGELOG.md](../CHANGELOG.md);
for the report shape, read [migration.md](migration.md).

## The short version

```bash
# 1. See what would change. Writes nothing.
node scripts/update-skill.mjs

# 2. Do it.
node scripts/update-skill.mjs --apply

# 3. Confirm.
node "$HOME/.cline/skills/session-cost/scripts/session-cost.mjs" --version
```

Both adapters are updated independently. Pass `--runtime cline` or `--runtime mcode` to handle one.

## Why a script rather than a copy command

An install replaces the whole skill directory, including `scripts/lib/`. Two consequences that a
plain copy gets wrong:

- **MCode's refreshed rates are destroyed.** MCode mirrors provider rates into
  `references/provider-rates.json` *inside* the skill directory. Overwriting the directory
  discards every table fetched with `--refresh-rates` and resets the refresh history, and nothing
  warns you: the next report simply uses the rates bundled with the release, so your numbers move
  without any explanation. The script backs that file up and puts it back.
- **Files the new release no longer ships survive.** A generated copy left over from an older
  release will not match the current `scripts/session-cost.mjs`, which is exactly the state
  `docs/migration.md` warns about. The script removes what the release dropped.

The Cline adapter has no such file — its cost comes from the runtime's own ledger — so a Cline
install cannot lose anything.

## What the script guarantees

- **Read-only by default.** Without `--apply` it only reports. It is safe to run in CI or as a
  pre-flight check.
- **Verified after install.** It re-reads `VERSION` and runs the installed `--version`, and
  reports a `PROBLEM` line (and a non-zero exit) if either disagrees with the release.
- **Idempotent.** A second run over an up-to-date install changes nothing and reports `up to date`.
- **It never reads or writes a session ledger**, and never writes outside the skill directory.

## Installing a specific release

By default the script installs from this repository's working tree, which is what you want when
you are building from source. To install a published archive instead, unpack it and point at it:

```bash
node scripts/update-skill.mjs --from ./dist/session-cost-mcode-v0.6.0/ --apply
```

Verify the archive before unpacking it, against the published `SHA256SUMS.txt`:

```bash
sha256sum -c SHA256SUMS.txt          # Linux, macOS
Get-FileHash .\session-cost-mcode-v0.6.0.zip -Algorithm SHA256   # Windows PowerShell
```

## Where it installs

| Adapter | Windows | macOS / Linux |
| --- | --- | --- |
| Cline | `%USERPROFILE%\.cline\skills\session-cost\` | `~/.cline/skills/session-cost/` |
| MCode | `%USERPROFILE%\.minimax\skills\session-cost\` | `~/.minimax/skills/session-cost/` |

The two share a skill name but never a directory and never a ledger, so updating one cannot
affect the other. Override the location with `--target-dir <path>` when testing an install.

## Using it as a CI gate

`--check` exits non-zero unless the installed skill is exactly this release, so a machine that is
supposed to be pinned to a version fails a pipeline instead of printing a warning. An absent
skill counts as a failure: a missing skill is not a pinned skill.

```bash
node scripts/update-skill.mjs --check
```

## If something goes wrong

- **`PROBLEM: VERSION reads ...`** — the install did not complete. Re-run with `--apply`.
- **`PROBLEM: the installed CLI exited ...`** — the copy is incomplete or the Node floor is not
  met. Both adapters need Node 22.15 or newer for `node:sqlite`; `--version` prints the running
  version.
- **Numbers changed after updating** — check whether your MCode rates were preserved. Run
  `--apply` again, or `--refresh-rates`, and compare the `ratesRefreshedAt` field in `--json`.
