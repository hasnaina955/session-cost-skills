# Normalized report contract v1

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

## Validation

The canonical runtime validator is `shared/report-contract.mjs`. It is generated into each independently installable adapter and is also checked against the JSON Schema by `tests/normalized-contract.test.mjs`.

Run:

```powershell
npm run check:report-contract
npm test
```

The test command recursively discovers every `*.test.mjs` file, so new contract or fixture tests cannot be omitted from `package.json` manually.
