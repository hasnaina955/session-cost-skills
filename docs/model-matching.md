# Model matching

Resolving a provider/model pair is two ordered stages: first the provider, then the
model. Each stage reports the rule it used, and any stage that cannot decide stops the
match. Nothing is guessed, and no stage falls back to a similar model, a similar
provider, or a runtime-specific price.

The resolver is `resolveDriverModelMatch` in `shared/provider-driver.mjs`; the diagnostic
wrapper is `explainModelMatch` in `shared/provider-diagnostics.mjs`.

## Stage 1: the provider

`explainProviderMatch` collects every discovered manifest whose `match.providerIds`
matches the requested id, preferring a literal match over a normalized one.

| Rule | Status | Meaning |
| --- | --- | --- |
| `exact-provider-id` | `matched` | The requested id is byte-identical to a declared `providerIds` entry |
| `normalized-provider-id` | `matched` | It matches only after normalization |
| `provider-id-collision` | `ambiguous` | Two manifests declare the same literal id |
| `normalized-provider-collision` | `ambiguous` | Two manifests match only after normalization |
| `unknown` | `unknown` | No manifest matches; `candidates` lists every discovered driver id |

`normalizeProviderId` lowercases, strips a leading `custom_provider:` or `custom:`, then
removes every non-alphanumeric character. So `custom_provider:Acme-OpenAI`, `acme-openai`,
and `acmeopenai` are the same key.

A collision is reported, never resolved. The request is refused and both candidates are
listed; nothing is picked. The registry enforces the same rule on the pricing path, where
two matching drivers throw `multiple provider drivers match <id>` rather than letting
one of them win.

## Stage 2: the model

The model is only resolved once the provider has matched, because aliases live on the
driver. The rules are tried in this exact order and the first one that applies wins.

| Order | Rule | Status | Result |
| --- | --- | --- | --- |
| 1 | `exact-rate-model` | `matched` | The id is a known model of this provider, unchanged |
| 2 | `exact-alias` | `matched` | The id is an alias key, resolved to its target |
| 3 | `normalized-alias` | `matched` | The id matches an alias key after normalization |
| 4 | `normalized-rate-model` | `matched` | Exactly one known model normalizes to the same string |
| 5 | `normalized-model-collision` | `ambiguous` | Two or more known models normalize to the same string |
| 6 | `glob-alias` | `matched` | An alias containing `*` matches the id |
| 7 | `unknown` | `unknown` | Nothing matched; the id is returned unchanged and unpriced |

`normalizeModelId` lowercases, drops everything up to and including the first `/`, then
removes every non-alphanumeric character. `Vendor/Alias Model` and `vendor/aliasmodel`
both normalize to `aliasmodel`.

The ordering matters and is deliberate:

- **Exact beats normalized.** A literal alias always wins over a normalized hit, so a
  deliberately configured alias is never shadowed by a rate-table id that merely looks
  similar.
- **The rate table beats a glob.** Glob aliases are the last resort before `unknown`, so
  a broad `vendor/*` pattern can never capture a model the provider actually publishes.
- **Aliases are scanned in sorted key order.** When two glob aliases match, the
  alphabetically first key wins, on every platform, every run.
- **A pattern without `*` is not a glob.** `globMatches` returns false unless the alias
  contains `*`, so a literal alias is only ever applied by the exact and normalized
  rules.

## Where aliases come from

A driver carries `modelAliases`, a map of runtime id to rate id. Built-in drivers ship
with an empty map. Configured `models` entries populate it: every entry whose `provider`
is one of the profile's `match.providerIds` contributes `runtimeModel -> rateModel`, and
profile aliases are merged over the base driver's own aliases.

```json
{ "runtime": "mcode", "provider": "company-openai", "runtimeModel": "Company/Model", "rateModel": "company-model" }
```

With that entry, `--model 'Company/Model'` resolves to `company-model` by `exact-alias`.
Through the CLI, note the caveat in [known gaps](#known-gaps) before relying on
`config explain` to show you that.

## Collisions are never auto-selected

A normalized collision returns `modelId: null`, `status: "ambiguous"`, and the full
candidate list. Nothing downstream treats it as resolved:

- `resolveDriverModel` — the convenience wrapper used by the pricing path — returns the
  caller's original string when the match is unknown or ambiguous, so the unresolved id
  goes to rate lookup unchanged.
- Rate lookup for an id with no applicable record returns `coverage: "unavailable"` and
  no rate, so the calls are reported as tokens with a `null` cost.
- `config explain` exits `2` for both `unknown` and `ambiguous`.

There is no "closest match" selection anywhere in the pricing path. The only near-match
mechanism in the system is the `suggestions` list, which is advisory output printed by
`config explain` and never consumed by pricing.

## Reading `config explain`

```powershell
node $SessionCost config explain --provider commandcode --model qwen-3.7-plus
node $SessionCost config explain --provider commandcode --model qwen-3.7-plus --json
```

A resolved model:

```text
runtime: mcode
provider: commandcode (exact-provider-id)
model: qwen-3.7-plus -> qwen-3.7-plus (exact-rate-model)
coverage: complete
```

An unresolvable model, which exits `2`:

```text
runtime: mcode
provider: commandcode (exact-provider-id)
model: qwen-3.7-plu -> qwen-3.7-plu (unknown)
coverage: unavailable
suggestion: qwen-3.7-plus (suggestion-only)
```

The five lines are `runtime`, `provider` with the provider-stage rule, `model` with the
requested id, the resolved id, and the model-stage rule, then `coverage`, then one
`suggestion` line per near match. Running `config explain` with neither `--provider` nor
`--model` has nothing to explain and prints the `doctor` summary instead.

### JSON fields

`--json` puts the same facts under `explanation`:

| Field | Meaning |
| --- | --- |
| `provider` | The full stage-1 object: `requestedProvider`, `status`, `rule`, `providerId`, `matchedOn`, `candidates`, and the winning `manifest` |
| `requestedModel` / `resolvedModel` | What you asked for and what it resolved to, or `null` |
| `status` | `matched`, `unknown`, or `ambiguous` |
| `rule` | Which model rule fired |
| `alias` / `matchedOn` | The alias that applied, when one did |
| `candidates` | The colliding candidates for `normalized-model-collision`; empty otherwise |
| `rateCard` | The selected card summary: `effectiveFrom`, `effectiveThrough`, `fingerprint`, `source` |
| `currency` | The record currency, or `USD` when the record omits it |
| `coverage` | See below |
| `suggestions` | Near misses, each tagged `suggestion-only` |

### Coverage values

| Coverage | Meaning |
| --- | --- |
| `complete` | The model matched and a rate record was selected |
| `model-known-rate-unavailable` | The model matched but no rate record was supplied |
| `unavailable` | The model or provider did not resolve |

Cline passes an empty rate-record list to `config explain`, so a model that resolves
there always reports `model-known-rate-unavailable`; it never reports `complete`. Its
known-model list is built from the `rateCards` and `importedRateRecords` of your own
provider profiles, so a model that exists only in a rate table is `unknown` and exits
`2`. Only MCode, which ships `references/provider-rates.json`, can report `complete` for
a built-in model. An MCode model that exists only in a configured profile also reports
`model-known-rate-unavailable`, because `config explain` selects records from the bundled
table.

### Suggestions

A suggestion is produced only for `status: "unknown"`. Candidates are compared by edit
distance on their normalized forms, kept when the distance is at most the larger of `2`
and a quarter of the requested id's normalized length, sorted by distance and then by
name, and capped at three. Every suggestion carries `rule: "suggestion-only"`, which is
the code's own name for "not a decision".

## Listing what is available

```powershell
node $SessionCost providers
node $SessionCost models discover
node $SessionCost models discover --provider commandcode
```

`providers` prints `id@version` and the pricing capability per line.
`models discover` prints `provider model-id` per line, adding ` aliases=a,b` when the
model has aliases, and `--provider` narrows it to one driver. The JSON form is
`{ "action": "models", "models": [{ "provider": "...", "models": [{ "id": "...", "aliases": [...] }] }] }`.

## Known gaps

Two behaviours of the current CLI build are worth knowing before you rely on these
commands with custom providers. Neither one guesses a price: both refuse.

**Configured profiles are not visible to the diagnostic commands.** `doctor`, `providers`,
`models discover`, and `config explain` receive the object returned by
`loadEffectiveConfig` and read `configuration.providers` from it, but the profiles live
under `configuration.config.providers`. The result is that those commands list only the
four built-in drivers, and a custom provider id reports `unknown` with exit `2` — while
the pricing path, which reads `effectiveConfiguration.config.providers`, does honour the
same profile. Verify a profile with `--validate-config` and a real report, not with
`providers`. The fix is to pass `configuration.config` instead of the wrapper to
`doctorReport`, `explainModelMatch`, and `discoverModels` at the `runDiagnostic` call
sites in both CLIs.

**Two profiles that share a provider id collapse to the first one.**
`discoverProviderManifests` resolves each profile through its own first `providerIds`
entry, and that lookup returns the first matching profile in the file. With two profiles
claiming the same id, the second never gets its own manifest, and a
`provider-id-collision` is reported as `unknown` instead. Give each configured provider
id exactly one profile.

## Related

- [Provider drivers](provider-drivers.md) — how profiles become driver manifests
- [Configuration](configuration.md) — the `models` array and precedence
- [MCode usage](../adapters/mcode/USAGE.md) — rate coverage and refreshing

