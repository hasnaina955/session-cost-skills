# Configuration

Provider, model, and runtime-default configuration for the Cline and MCode `session-cost` skills.
The schema is `contracts/session-config-v1.schema.json`; the loader is
`shared/config.mjs`, copied verbatim into each adapter as `scripts/lib/config.mjs`.

## Two different config files

The skills read two unrelated files. They are not interchangeable.

| File | Flag | Contents |
| --- | --- | --- |
| Session/provider config | `--session-config <path>` | `schemaVersion`, `runtimeDefaults`, `providers`, `models` |
| Standing summary | `--config <path>` | Presentation defaults such as `includeChildren` |

The standing-summary file defaults to `<data-dir>/session-cost.json`
(`%USERPROFILE%\.cline\session-cost.json` or `%USERPROFILE%\.minimax\session-cost.json`).
In both CLIs the only key read from it is `includeChildren`, and only when
`--include-children` was not passed on the command line. Provider profiles, model
aliases, and rate cards belong in the session/provider config, never in the standing
summary. See [migration](migration.md) if you have provider settings in the wrong file.

### A missing standing summary and a broken one are not the same

A standing-summary file that does not exist is normal and means "no overrides". A file that
exists but cannot be parsed is refused: the CLI exits 2 and names the path.

That distinction matters because `includeChildren` decides whether sub-agent sessions fold into
a reported total. Reading a broken file as an empty one silently defaults it to false and
under-reports a task's sub-agent spend, so all three runtimes refuse it rather than guess. A
JSON array is refused too, even though it parses: `typeof [] === 'object'`, so it would
otherwise pass a naive object check and then behave as an empty config.

The two files are treated the same way when the path is named but absent: neither errors, since
a standing summary that has not been written yet is the normal state, and the project config is
optional. The refusal is specifically for a file that exists and cannot be read.

## Precedence

`CONFIG_PRECEDENCE` in `shared/config.mjs` is the contract, highest priority first:

```text
cli > project > user > detected-runtime > built-in
```

`loadEffectiveConfig` builds the layers in the opposite order and merges them in that
order, so the last writer wins:

1. `built-in` — the `builtIn` argument, empty by default.
2. `detected-runtime` — runtime defaults supplied by the caller. The layer is only
   added when the detected object is non-empty. Neither CLI passes detected defaults
   today, so this layer is absent from CLI runs.
3. `user` — the platform user config file.
4. `project` — `<cwd>/.session-cost.json`, or the `--session-config <path>` you passed.
   Passing `--session-config` replaces the project path; it does not add a layer.
5. `cli` — `provider`, `model`, and `includeChildren` from the command line. Only
   explicitly supplied values enter this layer, and it is always present, even empty.

### Merge rules

- `runtimeDefaults` is a shallow assign; a higher layer replaces the same key and
  leaves the other keys alone.
- `providers` merge by `id`. Two layers with the same profile id produce one profile
  whose fields are object-merged, with `match` merged one level deep. A project
  profile can therefore override `region` in a user profile while keeping the user
  `match.providerIds` and adding to it.
- `models` merge by `runtime:provider:runtimeModel`. The higher layer replaces the
  whole mapping; it is never partially merged.

## File locations

`configPaths()` returns the two on-disk paths.

| Layer | Platform | Path |
| --- | --- | --- |
| Project | Any | `<cwd>/.session-cost.json` |
| User | Windows | `%APPDATA%\session-cost\config.json` |
| User | macOS | `~/Library/Application Support/session-cost/config.json` |
| User | Linux/other | `$XDG_CONFIG_HOME/session-cost/config.json`, defaulting to `~/.config/session-cost/config.json` |

On Windows, `%APPDATA%` falls back to `<home>\AppData\Roaming` when the variable is
unset. A missing file is not an error; the layer is simply skipped. A file that exists
but does not parse fails the run, and the error names the file.

## Schema

```json
{
  "schemaVersion": 1,
  "runtimeDefaults": { "provider": "", "model": "", "includeChildren": false },
  "providers": [],
  "models": []
}
```

All four keys are required by the schema. `runtimeDefaults` accepts only `provider`,
`model`, and `includeChildren`, and no other keys. Every provider profile requires
`id`, `driverId`, and `match` with a non-empty `providerIds` array and a non-empty
`runtimes` array whose entries are `cline` or `mcode`. `currency`, when present, must
be three uppercase letters. Profile ids must be unique within a file.

Optional profile fields: `endpointEnv`, `baseUrlEnv`, `credentialEnv`, `region`,
`currency`, `pricingMode` (`bundled`, `network`, `manual`, or `none`), `rateSource`
(`{ kind: "manual" | "imported", url }`), `rateCards`, and `importedRateRecords`.

Each `models` entry requires `runtime`, `provider`, `runtimeModel`, and `rateModel`.
The triple `runtime:provider:runtimeModel` must be unique within a file. `runtimeModel`
is the id the runtime recorded; `rateModel` is the id the rate table uses.

## Lifecycle commands

Both CLIs accept the same four actions. They print one JSON envelope to stdout and exit
`0` on success:

```json
{
  "schemaVersion": 1,
  "action": "init",
  "result": { "path": "...", "config": {} },
  "configuration": {
    "config": {},
    "selected": { "provider": { "value": "cli-provider", "source": "cli" } },
    "profileSources": { "company-openai": "project" },
    "sources": { "built-in": { "path": null, "merged": true } },
    "paths": { "project": "...", "user": "..." }
  }
}
```

| Command | Action | Behavior |
| --- | --- | --- |
| `--init-config` | `init` | Writes a valid empty template at the target path |
| `--validate-config` | `validate` | Validates the file at the target path and echoes it |
| `--export-config` | `export` | Prints the merged effective configuration |
| `--import-config <path>` | `import` | Validates `<path>` and writes it to the target |

The target is `--session-config <path>` when given, otherwise the project path. Only
`--init-config` and `--import-config` write files, and only to that target.

```powershell
node $SessionCost --init-config --session-config .\.session-cost.json
node $SessionCost --validate-config --session-config .\.session-cost.json
node $SessionCost --export-config --session-config .\.session-cost.json --provider cli-provider
node $SessionCost --import-config .\.shared-config.json --session-config .\.session-cost.json
```

`--init-config` refuses to overwrite an existing file. `--validate-config` fails when the
target does not exist. `--export-config` shows the result of the whole precedence chain,
so a `--provider` flag appears in `result.config.runtimeDefaults` and in `selected` with
`"source": "cli"`, while a value that only exists in a file keeps its file's source.
`--import-config` runs the imported document through the same validation before writing,
so an invalid import never lands on disk; the written file is the normalized,
two-space-indented JSON plus a trailing newline.

Exit codes are not identical between the two adapters, and both are deliberate. Cline
routes every failure through its `die()` helper and exits `2`. MCode throws a `CostError`
for usage and not-found problems and exits `2`, and lets a validation failure — a
rejected secret field, a duplicate `--init-config`, an unparsable file, an unknown
`schemaVersion` — surface as an ordinary error and exit `1`. Either way nothing is
written and no report is produced.

## Reading the winners

`selected` maps each `runtimeDefaults` key to its value and the layer that won it.
`profileSources` maps each profile id and each `runtime:provider:runtimeModel` mapping
to the highest layer that declared it. `sources` lists the layers that were merged and
the file each came from. All three appear in the `configuration` object of every `--json`
report, so a stored report records where its settings came from.

## Secrets are references, never values

A provider profile points at a credential; it never contains one.

```json
{
  "id": "company-openai",
  "driverId": "openai-compatible",
  "match": { "providerIds": ["company-openai"], "runtimes": ["mcode"] },
  "baseUrlEnv": "COMPANY_OPENAI_BASE_URL",
  "credentialEnv": "COMPANY_OPENAI_API_KEY",
  "currency": "EUR",
  "pricingMode": "manual"
}
```

`endpointEnv`, `baseUrlEnv`, and `credentialEnv` hold the *name* of an environment
variable. `readSecretReference` accepts either an uppercase name matching
`^[A-Z][A-Z0-9_]*$` and returns the process value, or a `credential://<name>` reference
that is handed to a caller-supplied credential reader; anything else is rejected.

The loader refuses to load a config that carries a value in a secret-named key. The
rejected keys are `apiKey`, `secret`, `password`, `token`, `accessToken`, and
`refreshToken`, at any depth, and the error names the offending path:

```text
config.providers[0].apiKey must be a credential reference, not a secret value
```

Because the check runs on load, `--validate-config`, `--export-config`, `--import-config`,
`doctor`, and every `--json` report refuse to echo a secret value. The same rule applies
to provider driver manifests, which reject the serialized fields `apiKey`, `secret`,
`password`, `authorization`, `accessToken`, and `refreshToken` before a driver is
registered. Set the environment variable in your shell, not in the config file.

## Manual and imported rate cards

A profile prices a model with either `rateCards` or `importedRateRecords`.

`rateCards` is the hand-written form. Every card needs `model`, an ISO-8601
`effectiveFrom`, and all four components as non-negative numbers: `input`, `output`,
`cacheRead`, `cacheWrite`. `effectiveThrough`, `currency`, `context`
(`{ minTokens, maxTokens }`), and `timeBand` (`flat`, `peak`, `offPeak`) are optional.
A card missing any of the four components is rejected by `--validate-config`, so a
partial price can never be stored and silently treated as zero.

`importedRateRecords` is the fingerprinted form for rates you already hold as effective
records. Each record keeps its `sourceAmount`, `amount`, `currency`, `effectiveFrom`,
`effectiveThrough`, `context`, `timeBand`, `source`, and `fingerprint`, and is converted
into the same records the bundled catalog uses, so provenance survives.

Rate selection per call filters on model, effective interval, time band, and context
range, and picks the most recent `effectiveFrom` per component. When some components are
missing the result is `coverage: "partial"` naming `missingComponents`; when none apply it
is `coverage: "unavailable"`. There is no branch that substitutes a different model, a
different provider, or a runtime-specific price for a missing rate.

### You can add rates for a new provider id, not for one that is already known

A profile whose `match.providerIds` overlaps a built-in driver's is refused: the registry
raises "multiple provider drivers match \<id\>" rather than pick one, because choosing
between two drivers that both claim a provider id is exactly the silent guess this tool
exists to avoid. The refusal is correct; it is also a cliff, and it surprises people who
are only trying to correct a price.

So a profile can supply rates for a provider id the tool has never heard of, and cannot
override or extend the rate cards of a built-in one. To price a model the built-in
catalog does not already cover, use a distinct profile id whose `match.providerIds` names
the provider; to change the rates of a known provider, mirror the model as a `models` alias
onto a rate the tool does know instead of colliding with the built-in driver.

This bites OpenCode hardest. An OpenCode session names whatever provider the user
configured, and the common case is a provider id that a built-in driver already claims, so
`--doctor` reports the overlap where the same config would have been accepted for MCode.
Run `providers` and `config explain` to see which drivers currently claim an id, and note
that the OpenCode adapter no longer needs a profile for sessions whose cost the runtime
itself recorded (see `adapters/opencode/skill/SKILL.md`).

## Validation rules

`validateConfig` rejects, in order: an unsupported or missing `schemaVersion`; a
secret-valued key; a `schemaVersion` other than `1`; non-array `providers` or `models`; a
duplicate or empty profile `id`; a profile missing `driverId`, `match.providerIds`, or
`match.runtimes`; a malformed `currency`; a manual card without a model, a parsable
`effectiveFrom`, or all four components; an imported record without a model, a valid
`component`, or a non-negative `amount`; and a duplicate `runtime:provider:runtimeModel`.

## Older config shapes

`migrateConfig` accepts three shapes and rejects everything else:

- `schemaVersion: 1` — used as is.
- `providers` as an object keyed by id — converted to an array, with the key copied into
  each entry's `id`.
- `version: 1` with no `schemaVersion` — `schemaVersion: 1` is added.

Anything else, including `schemaVersion: 2`, fails with
`unsupported or missing session-cost config schemaVersion`. A leading UTF-8 BOM is
stripped before parsing. See [migration](migration.md) for the step-by-step upgrade.

## Related

- [Provider drivers](provider-drivers.md) — what `driverId` may name and what a driver declares
- [Model matching](model-matching.md) — how `models` entries become aliases
- [Migration](migration.md) — upgrading an installed skill
- [Cline usage](../adapters/cline/USAGE.md) and [MCode usage](../adapters/mcode/USAGE.md)

