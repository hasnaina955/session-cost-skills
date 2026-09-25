# Migration

Moving from an older installed skill to the current one, and moving your configuration
into the current schema. The version and packaging rules live in
[docs/release.md](release.md); this document is about what changed for the person running
the CLI.

## Step 1: identify what you are running

Each installed skill reports itself without reading a session ledger:

```powershell
node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs" --version
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --version
```

```text
session-cost 0.3.0 (cline adapter)
report contract: 1.2.0
node: 24.21.0 (requires >= 22.15.0)
```

Three fields matter when you are upgrading:

- `session-cost <version>` is the installed skill version, read from the `VERSION` file in
  the skill root. A missing or malformed `VERSION` file reports `0.0.0-unknown` rather
  than guessing, which tells you the copy is incomplete.
- `report contract: <version>` is the normalized report contract the skill emits. This
  number moves independently of the skill version, so a report can change shape without
  the skill version changing, and vice versa.
- `node:` shows the running Node and the `>= 22.15.0` floor, because both adapters need
  `node:sqlite`.

Run both adapters separately. They share a version number but never a directory and
never a ledger:

| Adapter | Install target |
| --- | --- |
| Cline | `%USERPROFILE%\.cline\skills\session-cost\` |
| MCode | `%USERPROFILE%\.minimax\skills\session-cost\` |

## Step 2: install over the old copy

The whole skill is one unit, including `scripts/lib/`. Unpack over the existing
directory so every file is replaced together; a stale generated copy left behind from
an older release will not match the current `scripts/session-cost.mjs`.

Verify the archive checksum before unpacking:

```powershell
Get-FileHash .\session-cost-mcode-v0.3.0.zip -Algorithm SHA256
```

Then confirm the new banner:

```powershell
node "$env:USERPROFILE\.minimax\skills\session-cost\scripts\session-cost.mjs" --version
```

Nothing outside the skill directory is touched, and no session data is read or
rewritten.

### Back up your MCode rate file first

MCode stores its mirrored provider rates in `references/provider-rates.json`, which
lives **inside** the skill directory. An install therefore overwrites it, discarding any
records you fetched with `--refresh-rates` and resetting the refresh history. Nothing
warns you; the next report just quietly uses the rates bundled with the release.

If you have refreshed rates, copy the file out before installing and put it back after:

```powershell
$Skill = "$env:USERPROFILE\.minimax\skills\session-cost"
Copy-Item "$Skill\references\provider-rates.json" "$env:TEMP\provider-rates.json"
# ... install ...
Copy-Item "$env:TEMP\provider-rates.json" "$Skill\references\provider-rates.json"
```

Or simply run `--refresh-rates` afterwards, which re-fetches both providers and records
a new history entry. The Cline adapter has no equivalent file; its cost comes from the
runtime ledger, so an install cannot lose anything.

## What changed in the normalized report

The report contract is the formal envelope for `--json`. It is currently `1.2.0`, and
the schema pins `contractVersion` with a constant, so a report produced by an older
contract is rejected rather than silently reinterpreted. The required block list has
been stable; what changes between versions is the optional top-level fields:

| Contract | Added top-level fields |
| --- | --- |
| 1.0.0 | the twelve required blocks, plus `session` and `models` |
| 1.1.0 | `rateProvenance` |
| 1.2.0 | `configuration`, `providerDriver`, `providerDrivers` |

If you consume `--json` output, these are the fields to read:

- `runtime.costBasis` is `runtime-recorded` for Cline and `provider-rate-estimate` for
  MCode. It is the field that tells you which cost field carries the number.
- `billing.recordedCostUsd` and `billing.estimatedCostUsd` are separate. A
  `runtime-recorded` report can never carry an estimate, and a `provider-rate-estimate`
  report can never carry a recorded amount; the validator rejects both violations.
- Unknown cost is `null`, never `0`. A session with no calls may report a zero amount
  with `coverage: "no-calls"`, which is a different statement from "priced at zero".
- `coverage.status` and `coverage.unknownReasons` say why a number is missing. Read the
  reasons before treating a total as complete.
- `usage.semantics.inputTokenMeaning` is `includes-cache` for Cline and `excludes-cache`
  for MCode. Do not apply one runtime's fresh-input formula to the other's data.
- `sessionGraph` carries `rootSessionIds`, `includedSessionIds`, `excludedSessionIds`,
  and `duplicateSuppressedSessionIds`, so you can tell a child that was excluded from
  one that was counted.
- `rateProvenance` lists the exact rate records used, each with `effectiveFrom`,
  `effectiveThrough`, `context`, `timeBand`, `source`, and a `sha256` `fingerprint`.
  This is what makes an estimate reproducible after a later rate refresh.
- `configuration` records the config sources, profile sources, and selected defaults
  that produced the report.
- `providerDrivers` lists the driver manifests that priced the report, each with its
  `fingerprint`. A report can therefore be traced to a specific driver version and
  profile, not just a provider name.

The per-adapter `[Cline](../adapters/cline/USAGE.md)` and
[MCode](../adapters/mcode/USAGE.md)` usage references describe the human-readable output
of the current version.

## Moving your configuration

Provider settings belong in the session/provider config, which is `.session-cost.json` in
your project directory or the path you pass to `--session-config`. The older standing
summary file (`<data-dir>/session-cost.json`, or whatever `--config` points at) is a
different file, and the only key either CLI reads from it is `includeChildren`. If you
put provider profiles there, they are being ignored.

Start from a clean, valid file rather than editing in place:

```powershell
node $SessionCost --init-config --session-config .\.session-cost.json
```

`--init-config` refuses to overwrite, so it is safe to run on a fresh directory. To
convert an existing file without hand-editing it, validate it first and then rewrite it
through the import path, which normalizes the JSON as it writes:

```powershell
node $SessionCost --validate-config --session-config .\.session-cost.json
node $SessionCost --import-config .\.old-session-cost.json --session-config .\.session-cost.json
```

### Legacy shapes that are accepted

`migrateConfig` converts three older shapes without any hand-editing:

- `providers` written as an object keyed by id, with no version field. The keys become
  each entry's `id`.
- `version: 1` with no `schemaVersion`. `schemaVersion: 1` is added.
- `schemaVersion: 1` already, used as is.

```json
{
  "version": 1,
  "runtimeDefaults": { "provider": "legacy-provider", "includeChildren": true },
  "providers": { "legacy": { "driverId": "commandcode", "match": { "providerIds": ["legacy-provider"], "runtimes": ["mcode"] }, "credentialEnv": "LEGACY_TOKEN" } },
  "models": []
}
```

`--validate-config` accepts that file and prints it back in the current shape, with
`providers` as an array and `schemaVersion: 1`. Use the `result.config` block of that
output as the starting point for your new file.

### Shapes that are rejected

Anything else fails, and the run stops rather than guessing:

```text
unsupported or missing session-cost config schemaVersion
```

That covers `schemaVersion: 2`, a file with no version field and no object-shaped
`providers`, and any future version. Fix the file by hand; the skill will not migrate
across a version it does not know.

A file that is not valid JSON names the file and the parse position:

```text
could not parse config bad.json: Expected property name or '}' in JSON at position 1 (line 1 column 2)
```

A leading UTF-8 BOM is stripped before parsing, so a config saved by a Windows editor
that adds one still loads.

### Reconfiguring a provider profile

The session/provider config is new in 0.3.0. An installation from 0.2.0 has no provider
schema to carry over, so there is no automatic upgrade path for provider settings: what
you had was the standing-summary file, and provider profiles are written from scratch
against the schema above. A profile holds a credential *reference*, never a value:

```json
{
  "schemaVersion": 1,
  "runtimeDefaults": {},
  "providers": [
    {
      "id": "company-openai",
      "driverId": "openai-compatible",
      "match": { "providerIds": ["company-openai"], "runtimes": ["cline", "mcode"] },
      "baseUrlEnv": "COMPANY_OPENAI_BASE_URL",
      "credentialEnv": "COMPANY_OPENAI_API_KEY",
      "region": "eu-west",
      "currency": "EUR",
      "pricingMode": "manual",
      "rateCards": [
        {
          "model": "company-model",
          "effectiveFrom": "2026-01-01T00:00:00Z",
          "input": 1.5,
          "output": 6,
          "cacheRead": 0.15,
          "cacheWrite": 1.5
        }
      ]
    }
  ],
  "models": [
    { "runtime": "mcode", "provider": "company-openai", "runtimeModel": "Company/Model", "rateModel": "company-model" }
  ]
}
```

Then export the variable in the shell that runs the skill:

```powershell
$env:COMPANY_OPENAI_API_KEY = "..."
node $SessionCost --validate-config --session-config .\.session-cost.json
```

The rules to check against:

- `driverId` must be one of `commandcode`, `stepfun`, `openai-compatible`, or
  `anthropic-compatible`. Any other value fails with
  `provider profile <id> references unsupported driver <driverId>`.
- `match.runtimes` entries are `cline` and/or `mcode`. A profile that lists only one
  runtime is invisible to the other.
- `currency` is three uppercase letters, and it is the currency the rates are in. It
  flows into `billing.currency` in the report; a wrong value is a wrong number, not a
  display issue.
- Every rate card needs all four components. A card missing `cacheWrite` is rejected at
  load rather than priced as zero.
- Aliases come from the `models` array, not from the profile. `runtimeModel` is what the
  runtime recorded, `rateModel` is what the rate card is keyed by.

A literal secret left in the file is rejected on load, and the error names the exact
path, so you can find it without guessing:

```text
config.providers[0].apiKey must be a credential reference, not a secret value
```

If you previously kept the key out of the config entirely, nothing changes: set the
environment variable and leave `credentialEnv` null.

## Post-upgrade checklist

Run these in order. Each one has a definite exit code, so a script can rely on them.

| Command | Expect |
| --- | --- |
| `--version` | Exit `0`, with the intended version, contract, and a Node at or above `22.15.0` |
| `--validate-config --session-config <path>` | Exit `0` and `action: "validate"` |
| `--export-config --session-config <path>` | Exit `0`, with `selected` showing the layer that won each default |
| `doctor` | Exit `0`, with a configuration sources line listing the layers that merged |
| A normal report | Exit `0`, with `runtime.costBasis` matching the adapter |
| MCode only: `--rates` | Exit `0`, with rate coverage and freshness for the mirrored providers |

Then re-check anything you were working around before:

- A provider or model that previously priced and now does not: run
  `config explain --provider <id> --model <id>`. It reports the rule that fired and
  exits `2` if the id is unknown or ambiguous. See
  [model matching](model-matching.md).
- A profile you added during the upgrade: read the 0.3.0 caveats in
  [model matching](model-matching.md#known-gaps) before trusting `providers` or
  `config explain` output. Those commands currently do not see configured profiles; the
  pricing path does, and `--validate-config` plus a real report is the reliable check.
- Cline account mode: the report labels plan, balance, reference cost, and credits used
  as separate values. The credential precedence is the one documented in
  [Cline usage](../adapters/cline/USAGE.md#account-mode): `CLINE_API_KEY`, then the
  `data/settings/providers.json` OAuth token, then the legacy `data/secrets.json`
  `apiKey`.

## Troubleshooting

| Symptom | Cause | Action |
| --- | --- | --- |
| `0.0.0-unknown` in the banner | `VERSION` file missing or malformed | Reinstall the archive; the copy is incomplete |
| `unsupported or missing session-cost config schemaVersion` | Unknown or future `schemaVersion` | Convert the file by hand; see the legacy shapes above |
| `could not parse config <path>` | Invalid JSON | Fix the syntax; the message gives the position |
| `... must be a credential reference, not a secret value` | A literal secret in the config | Replace it with the environment-variable name |
| `provider profile <id> references unsupported driver <driverId>` | Unknown `driverId` | Use one of the four built-in driver ids |
| `config already exists: <path>` | `--init-config` over an existing file | Remove or rename the file, or use `--import-config` |
| `config not found: <path>` | `--validate-config` with no file at the target | Create it with `--init-config` or pass the right `--session-config` |
| Provider settings appear to be ignored | They are in the standing-summary file | Move them to `.session-cost.json` and use `--session-config` |
| Report shows `coverage: "partial"` | Some calls or models have no applicable rate | Read `coverage.unknownReasons`; add the rate, do not infer one |
| `multiple provider drivers match <id>` | Two drivers claim one provider id | Remove the duplicate; the request is refused on purpose |
| Old Node | Below the `22.15.0` floor | Upgrade Node; `node:sqlite` is required |

