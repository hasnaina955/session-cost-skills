# Architecture

## Design principle

The three runtimes expose different ledgers, but they should share product behavior where the semantics are identical.

```text
shared reporting and UX
├── Cline storage adapter
│   ├── Cline session database
│   ├── Cline message metrics
│   └── optional Cline API account adapter
├── MCode storage adapter
│   ├── MCode runtime SQLite ledger
│   ├── MCode session message logs
│   └── provider-rate catalog
└── OpenCode storage adapter
    ├── OpenCode `opencode.db` ledger
    ├── 1.x `message` and 2.x `session_message` projections
    └── the user's own provider profile (no bundled rate table)
```

## Shared reporting contract

`contracts/normalized-report-v1.schema.json` is the formal cross-adapter report envelope. Every CLI passes its runtime-specific report through `shared/report-contract.mjs`, which requires:

- runtime identity, storage source, and cost basis
- token semantics for cache and reasoning fields
- selection and snapshot metadata
- separate recorded and estimated cost fields
- coverage state and unknown-cost reasons
- session-graph inclusion/exclusion/suppression sets
- provenance and warnings

Runtime-specific report fields remain as schema-approved extensions. The generated adapter copies keep each skill independently installable. The OpenCode adapter carries a deliberately partial set of those copies — it rejects the cost-centre, counterfactual, insights, rollup, setup, and provider-drivers flags as unknown — so "every shared module has a copy in every adapter" is not a rule the OpenCode adapter satisfies, and the generated-copy checks and canonical-copy test loops are scoped per adapter accordingly.

MCode pricing uses `contracts/rate-record-v1.schema.json`. Each input, output, cache-read, and cache-write rate has its own effective interval, context range, time band, source version, raw amount, normalized amount, and fingerprint. Reports include the exact records selected for each call, so estimates can be reproduced after later refreshes.

OpenCode prices through the same record shape but a different rate *source*: the user's own provider profile, converted into the identical effective, fingerprinted records. It ships no rate table, because OpenCode runs against whatever provider the user configured, including local and self-hosted ones, so no single bundled catalog could be correct. A call is priced only when all four rate components are applicable; a partial card yields no number, and an unknown cost is `null`, never `0`.

Provider behavior is isolated behind `contracts/provider-driver-v1.schema.json`. Runtime adapters normalize usage and preserve driver identity/provenance; provider drivers own detection, model discovery, aliases, rate retrieval, and rate selection. Ambiguous provider matches and unsupported capabilities fail explicitly rather than falling back to runtime-specific pricing branches.

Layered configuration is defined by `contracts/session-config-v1.schema.json`. The effective precedence is CLI flags, project config, user config, detected runtime defaults, then built-in defaults. Provider profiles and model mappings retain their winning source in normalized reports; endpoint and credential values remain environment references.

Provider diagnostics use the same resolver as pricing and report the exact/alias/normalized/glob decision, selected rate record, collision candidates, coverage, and suggestion-only aliases. Unknown or ambiguous matches never mutate configuration or select a model automatically.

OpenAI- and Anthropic-compatible usage is normalized by protocol adapters, while endpoint, region, currency, credential, and pricing data stay in the provider profile. Manual and imported rate records are converted into the same effective, fingerprinted records used by built-in providers.

## Shared layer

- Normalized report schema and runtime validator
- Recursive session-graph resolver
- Date/provider/model filters
- Current/last/today/compare modes
- Snapshot metadata
- Common formatting and error types
- Packaging and release validation

## Adapter contract

Each adapter should provide equivalent operations such as:

```text
listSessions()
resolveCurrentSession()
getSessionMetrics()
getChildSessions()
getSessionTitle()
getProvider()
getModel()
getLocalCost()
```

The adapter should expose normalized records to the shared layer, but it owns the runtime-specific interpretation of raw token fields.

## Never merge these values implicitly

- Local Cline recorded session cost
- Cline account reference cost
- Cline account credits used
- MCode rate-calculated session cost
- OpenCode rate-estimated session cost

They are different accounting domains and must remain separately labelled. MCode's
mirrored-rate estimate and OpenCode's profile-based estimate may be equal in number and still
are not the same fact: they come from different catalogs with different lifetimes.
