# Contributing

Thanks for helping improve the session-cost skills.

## Development workflow

1. Fork the repository and create a focused feature branch.
2. Read the relevant adapter `SKILL.md` and `references/` documentation.
3. Preserve runtime-specific accounting semantics.
4. Run `npm run verify`.
5. Open a pull request describing the behavior and compatibility impact.

## Required checks

```powershell
npm run verify
```

This checks JavaScript syntax, verifies generated adapter modules, validates the shared report contract, runs every discovered adapter/fixture test, and checks dashboard CSP and DOM-sink safety.

### Generated adapter modules

Edit `shared/dashboard.mjs`, `shared/session-graph.mjs`, `shared/report-contract.mjs`, `shared/provider-driver.mjs`, `shared/provider-diagnostics.mjs`, or `shared/config.mjs`, then run the matching sync command:

```powershell
npm run sync:dashboard
npm run sync:session-graph
npm run sync:report-contract
npm run sync:provider-driver
npm run sync:provider-diagnostics
npm run sync:config
```

Each adapter keeps its own generated copy so it remains independently installable. The corresponding `check:*` script fails when an adapter copy drifts.

## Adapter boundaries

- Cline adapter: `adapters/cline`
- MCode adapter: `adapters/mcode`
- Shared documentation: `docs`
- Shared release rules: `README.md` and `SECURITY.md`

Do not copy Cline's input-token formula into MCode code. The two runtimes use different cache semantics.

## Reporting bugs

Include runtime version, Node version, command, redacted error output, and expected behavior. Never include API keys, OAuth tokens, `secrets.json`, session databases, or private transcripts.
