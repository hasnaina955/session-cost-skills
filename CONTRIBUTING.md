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

`.github/workflows/ci.yml` is the single source of truth for what CI runs. It runs `npm run verify` on ubuntu, windows, and macos against Node 22.15 and 24 (fail-fast disabled, so one broken pair still reports the others), the full test suite under Bun on ubuntu, and a release rehearsal on ubuntu and windows. Every action is pinned to a full commit SHA. `.github/workflows/release.yml` is tag-triggered and publishes the three archives with `SHA256SUMS.txt`, so a release is no longer cut by hand. Do not copy a matrix from anywhere else in this repository; edit the workflow itself.

Bun on Windows is not covered and is known to fail: 11 tests error on temp-directory cleanup with `EBUSY: resource busy or locked, rm '<tmpdir>'`, because the fixtures delete a directory whose SQLite handle is still open. POSIX permits that and Windows does not. The same tests pass under Node on the same machine.

`npm run check:workflows` fails if any workflow pins an action to a mutable tag instead of a
full 40-character commit SHA, and requires `ci.yml` to declare least-privilege
`contents: read` permissions. It is part of `npm run verify`.

### Generated adapter modules

Edit `shared/dashboard.mjs`, `shared/session-graph.mjs`, `shared/report-contract.mjs`, `shared/provider-driver.mjs`, `shared/provider-diagnostics.mjs`, `shared/protocol-adapters.mjs`, or `shared/config.mjs`, then run the matching sync command:

```powershell
npm run sync:dashboard
npm run sync:session-graph
npm run sync:report-contract
npm run sync:provider-driver
npm run sync:provider-diagnostics
npm run sync:protocol-adapters
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
