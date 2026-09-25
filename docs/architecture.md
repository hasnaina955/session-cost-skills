# Architecture

## Design principle

The two runtimes expose different ledgers, but they should share product behavior where the semantics are identical.

```text
shared reporting and UX
├── Cline storage adapter
│   ├── Cline session database
│   ├── Cline message metrics
│   └── optional Cline API account adapter
└── MCode storage adapter
    ├── MCode runtime SQLite ledger
    ├── MCode session message logs
    └── provider-rate catalog
```

## Shared reporting contract

`contracts/normalized-report-v1.schema.json` is the formal cross-adapter report envelope. Both CLIs pass their runtime-specific report through `shared/report-contract.mjs`, which requires:

- runtime identity, storage source, and cost basis
- token semantics for cache and reasoning fields
- selection and snapshot metadata
- separate recorded and estimated cost fields
- coverage state and unknown-cost reasons
- session-graph inclusion/exclusion/suppression sets
- provenance and warnings

Runtime-specific report fields remain as schema-approved extensions. The generated adapter copies keep each skill independently installable.

MCode pricing uses `contracts/rate-record-v1.schema.json`. Each input, output, cache-read, and cache-write rate has its own effective interval, context range, time band, source version, raw amount, normalized amount, and fingerprint. Reports include the exact records selected for each call, so estimates can be reproduced after later refreshes.

Provider behavior is isolated behind `contracts/provider-driver-v1.schema.json`. Runtime adapters normalize usage and preserve driver identity/provenance; provider drivers own detection, model discovery, aliases, rate retrieval, and rate selection. Ambiguous provider matches and unsupported capabilities fail explicitly rather than falling back to runtime-specific pricing branches.

Layered configuration is defined by `contracts/session-config-v1.schema.json`. The effective precedence is CLI flags, project config, user config, detected runtime defaults, then built-in defaults. Provider profiles and model mappings retain their winning source in normalized reports; endpoint and credential values remain environment references.

Provider diagnostics use the same resolver as pricing and report the exact/alias/normalized/glob decision, selected rate record, collision candidates, coverage, and suggestion-only aliases. Unknown or ambiguous matches never mutate configuration or select a model automatically.

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

They are different accounting domains and must remain separately labelled.
