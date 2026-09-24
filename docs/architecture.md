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

## Shared layer candidates

- Report schema and versioning
- Date/provider/model filters
- Current/last/today/compare modes
- Snapshot metadata
- Subagent aggregation orchestration
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
