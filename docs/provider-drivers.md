# Provider drivers

A provider driver is the only place provider identity, capabilities, token semantics, and
rate lookup are defined. Both CLIs resolve providers through the same driver registry
rather than branching per provider.

The manifest contract is `contracts/provider-driver-v1.schema.json`. The implementation
is `shared/provider-driver.mjs`, copied into each adapter as
`scripts/lib/provider-driver.mjs`. MCode adds a thin pricing layer in
`scripts/lib/provider-drivers.mjs`.

## What a driver is

A driver is a manifest plus handlers:

```js
{ manifest, handlers: { detect, listModels, normalizeUsage, parseStream, fetchRates, resolveRate } }
```

`defineProviderDriver` is the only supported constructor. It deep-clones the manifest,
rejects serialized secret fields, validates the required fields, requires a handler
function for every entry in `operations`, and returns the manifest frozen with a
`fingerprint` of `sha256:<64 hex>`, computed over the manifest JSON.

Required manifest fields: `schemaVersion` (`1`), `contractVersion` (`1.0.0`), `id`,
`version`, `match`, `capabilities`, `tokenSemantics`, `source`, and a non-empty
`operations` array. `match` needs at least one `providerIds` entry and at least one
entry in `runtimes`, each of which is `cline`, `mcode`, or `opencode`. `source` needs `kind`,
`url`, and a `parserVersion` of at least `1`. `modelAliases` and `credentialEnv` are optional;
`credentialEnv` is a variable name or `null`.

## The four built-in drivers

| Driver | Version | Provider ids | Runtimes | Pricing | Rate retrieval | Operations |
| --- | --- | --- | --- | --- | --- | --- |
| `commandcode` | 3.0.0 | `commandcode`, `custom_provider:commandcode` | cline, mcode, opencode | `mirrored-rate` | `network` | detect, listModels, fetchRates, resolveRate |
| `stepfun` | 2.0.0 | `stepfun`, `custom_provider:stepfun` | cline, mcode, opencode | `mirrored-rate` | `network` | detect, listModels, fetchRates, resolveRate |
| `openai-compatible` | 1.0.0 | `openai-compatible`, `custom_provider:openai-compatible` | cline, mcode, opencode | `mirrored-rate` | `manual` | detect, listModels, normalizeUsage, parseStream, resolveRate |
| `anthropic-compatible` | 1.0.0 | `anthropic-compatible`, `custom_provider:anthropic-compatible` | cline, mcode, opencode | `mirrored-rate` | `manual` | detect, listModels, normalizeUsage, parseStream, resolveRate |

Capability differences that matter: `commandcode` declares `modelDiscovery: true`,
`contextTiers: true`, and `timeBands: true`; `stepfun` declares `contextTiers: false` and
`timeBands: false`; both compatible drivers declare `modelDiscovery: false` because the
protocol does not enumerate models. All four declare all four token components.

Token semantics are declared, not assumed:

| Driver | `inputIncludesCache` | `reasoningIncludedInOutput` | `contextSizeIncludesOutput` |
| --- | --- | --- | --- |
| `commandcode` | false | true | true |
| `stepfun` | false | true | true |
| `openai-compatible` | false | true | true |
| `anthropic-compatible` | false | false | true |

The OpenAI and Anthropic drivers also carry the `normalizeUsage` and `parseStream`
handlers from `shared/protocol-adapters.mjs`, which turn normal, streaming, cached, and
missing-usage responses into the same normalized shape. A response with no usage block
returns `coverage: "unavailable"` and null components instead of zeros.

## Discovery and ordering

There are two sources of drivers, and they are combined in a fixed order.

**Built-in drivers** come from `BUILTIN_PROVIDER_MANIFESTS` in declaration order.

**Configured profiles** come from the session/provider config. Each profile must name a
`driverId` that is one of the four built-in ids. `detectConfiguredProvider` copies that
base manifest, replaces `id` with the profile id, sets `version` to
`<base.version>+profile`, replaces `match` with the profile's `match`, and merges the
`models` entries for the profile's provider ids into `modelAliases`. Because the
manifest content changes, the profile's fingerprint is different from the base driver's
— that is how a report proves which profile priced it.

If a profile names a driver id that is not built in, the failure is explicit:

```text
provider profile company-openai references unsupported driver my-driver
```

`createProviderRegistry` then applies three rules:

- Drivers whose `match.runtimes` does not include the runtime are dropped.
- Two drivers with the same `id` are an error: `duplicate provider driver <id>`.
- `resolve(providerId)` collects every driver whose `match.providerIds` normalizes to the
  requested id. Zero matches returns `null`; more than one throws
  `multiple provider drivers match <id>`.

Discovery for reporting sorts by `id`, so the order does not depend on file layout.

## User-installed driver modules

`loadProviderDrivers(directory)` loads drivers from a directory you choose:

- A missing directory returns `[]`.
- Only files ending in `.mjs` are read, in sorted filename order.
- Each module's `default` export, or the module namespace when there is none, is passed
  through `defineProviderDriver`, so a module gets the same validation as a built-in.
- Only the validated manifest is returned. Handlers are never serialized.

Sorted filenames make load order deterministic, but note that `createProviderRegistry`
rejects two drivers with the same `id`, so a user module must use a unique id. Be aware
that neither CLI currently passes a directory to `loadProviderDrivers`: today the
bundled skills build their registry from the built-in manifests plus the configured
profiles. The loader is the supported API for embedding a driver in a host program and
is covered by `tests/provider-driver-contract.test.mjs`.

## Writing a custom driver module

```js
import { defineProviderDriver } from './lib/provider-driver.mjs';

const manifest = {
  schemaVersion: 1,
  contractVersion: '1.0.0',
  id: 'acme-compatible',
  version: '1.0.0',
  match: { providerIds: ['acme', 'custom_provider:acme'], runtimes: ['cline', 'mcode', 'opencode'] },
  capabilities: {
    pricing: 'mirrored-rate',
    modelDiscovery: false,
    rateRetrieval: 'manual',
    effectiveDates: true,
    contextTiers: false,
    timeBands: false,
    supportedComponents: ['input', 'output', 'cacheRead', 'cacheWrite'],
  },
  tokenSemantics: {
    inputIncludesCache: false,
    cacheReadSeparate: true,
    cacheWriteSeparate: true,
    reasoningIncludedInOutput: 'unknown',
    contextSizeIncludesOutput: true,
  },
  source: { kind: 'docs', url: 'https://example.test/pricing', parserVersion: 1 },
  operations: ['detect', 'listModels', 'resolveRate'],
  modelAliases: {},
  credentialEnv: 'ACME_API_KEY',
};

export default defineProviderDriver({
  manifest,
  handlers: {
    detect: () => true,
    listModels: () => [],
    resolveRate: (context) => ({ key: context.model, rate: null, coverage: 'unavailable', missingComponents: ['input', 'output', 'cacheRead', 'cacheWrite'] }),
  },
});
```

Rules the constructor enforces, all of them fatal:

- `contractVersion` must be exactly `1.0.0`, and `schemaVersion` exactly `1`.
- A key named `apiKey`, `secret`, `password`, `authorization`, `accessToken`, or
  `refreshToken` anywhere in the manifest raises `contains a serialized secret field`.
  `credentialEnv` is the only way to name a credential.
- Every id in `operations` must have a matching function in `handlers`.

Declare what you do not support rather than pretending. `capabilities.pricing` is `none`
or `mirrored-rate`; `rateRetrieval` is `none`, `network`, `manual`, or `bundled`; a
missing rate component must be reported in `missingComponents`, not as `0`.

## Unsupported states

These are the states a driver can be in that the system refuses to paper over.

| State | Result |
| --- | --- |
| No driver matches the provider id | `coverage: "unavailable"`, all four components listed as missing, `providerDriver: null` |
| Two drivers match one provider id | `multiple provider drivers match <id>`; diagnostics report `provider-id-collision` or `normalized-provider-collision` with both candidates (see the caveat below) |
| Profile names an unknown `driverId` | `provider profile <id> references unsupported driver <driverId>` |
| Some rate components are missing | `coverage: "partial"` with `missingComponents` naming exactly which |
| No rate record applies | `coverage: "unavailable"`; tokens are still reported, cost stays `null` |
| Protocol response has no usage block | `coverage: "unavailable"` with null token components |

`capabilities` is declarative metadata. It is validated against the schema and surfaced
in `doctor` and `providers` output; the pricing path decides coverage from the rate
records that actually exist, not from a capability guess. A driver that declares
`fetchRates` gets the rate-refresh handler wired in; a driver that does not never has
that handler attached.

### Caveat on collisions

The collision rules are enforced on the pricing path by `createProviderRegistry`, which
throws as soon as two registered drivers claim one provider id. In the diagnostics path
the collision rules exist but are currently harder to reach than they look:
`discoverProviderManifests` resolves each configured profile through its own first
`providerIds` entry, and that lookup returns the first profile in the file that matches.
Two profiles claiming the same provider id therefore collapse into the first one, and
the request is reported as `unknown` rather than as a collision. Both outcomes refuse the
request; neither picks a driver. See
[model matching](model-matching.md#known-gaps) for what this means in practice.

## Inspecting drivers

```powershell
node $SessionCost providers
node $SessionCost providers --json
node $SessionCost doctor --json
```

Text output is one line per driver, `id@version` and the pricing capability in brackets:

```text
anthropic-compatible@1.0.0 [mirrored-rate]
commandcode@3.0.0 [mirrored-rate]
openai-compatible@1.0.0 [mirrored-rate]
stepfun@2.0.0 [mirrored-rate]
```

`doctor --json` lists each driver with `id`, `version`, `fingerprint`, `match`,
`capabilities`, and `credentialEnv` — the variable name, never its value.

## Related

- [Model matching](model-matching.md) — resolving a model against a driver's aliases
- [Configuration](configuration.md) — provider profiles and the `driverId` field
- [Normalized report contract](../contracts/README.md) — where driver identity appears in a report

