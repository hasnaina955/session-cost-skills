# Session Cost contracts

## Normalized report contract v1.1

`normalized-report-v1.schema.json` defines the common report envelope shared by the Cline and MCode session-cost CLIs.

Every normalized report includes:

- `schemaVersion` and `contractVersion`
- runtime identity, storage source, and cost basis
- token totals with explicit token semantics
- snapshot and selection metadata
- recorded or estimated billing fields kept separate
- coverage status and unknown-cost reasons
- root, included, excluded, and duplicate-suppressed session IDs
- provenance, warnings, and runtime-specific extension fields

## Cost bases

- Cline uses `runtime-recorded`; `recordedCostUsd` contains the runtime-recorded amount.
- MCode uses `provider-rate-estimate`; `estimatedCostUsd` contains the mirrored-rate estimate and `recordedCostUsd` is `null`.

Unknown cost is `null`, never zero. A known zero-cost session with no calls may report a zero recorded amount with `coverage: "no-calls"`.

## Effective rate records

`rate-record-v1.schema.json` defines one immutable component rate. Every record preserves:

- provider, model, and token component
- raw source amount and normalized numeric amount
- currency and per-million-token unit
- effective-from and effective-through timestamps
- inclusive context-token range
- flat, peak, or off-peak time band
- source URL, source parser version, and fetch time
- a SHA-256 rate-card fingerprint

MCode selects the four component records that apply to each call timestamp, context size, and time band. Refreshes retain previous records and close open intervals at the next effective snapshot. Calls before the earliest trustworthy effective date remain unpriced.

## Validation

The canonical runtime validator is `shared/report-contract.mjs`. It is generated into each independently installable adapter and is also checked against the JSON Schema by `tests/normalized-contract.test.mjs`. Rate records are validated across the complete bundled catalog by `tests/rate-record-contract.test.mjs`.

Run:

```powershell
npm run check:report-contract
npm test
```

The test command recursively discovers every `*.test.mjs` file, so new contract or fixture tests cannot be omitted from `package.json` manually.
