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

This checks JavaScript syntax, verifies generated dashboard copies, runs Cline and MCode tests, validates dashboard CSP and DOM-sink safety, and checks MCode CLI modes.

### Dashboard changes

Edit `shared/dashboard.mjs`, the canonical dashboard renderer, then run:

```powershell
npm run sync:dashboard
```

Each adapter must retain its own generated renderer so it remains independently installable. `npm run check:dashboard` fails when an adapter copy drifts.

## Adapter boundaries

- Cline adapter: `adapters/cline`
- MCode adapter: `adapters/mcode`
- Shared documentation: `docs`
- Shared release rules: `README.md` and `SECURITY.md`

Do not copy Cline's input-token formula into MCode code. The two runtimes use different cache semantics.

## Reporting bugs

Include runtime version, Node version, command, redacted error output, and expected behavior. Never include API keys, OAuth tokens, `secrets.json`, session databases, or private transcripts.
