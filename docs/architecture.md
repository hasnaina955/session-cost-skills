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
