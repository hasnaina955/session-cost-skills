# Security Policy

## Supported versions

Security fixes are applied to the latest published release on the default branch.

## Reporting a vulnerability

Please open a private security report through the repository host's security advisory feature. Do not open a public issue containing credentials, personal data, session transcripts, or an exploitable proof of concept.

Include:

- affected adapter and version
- runtime and Node versions
- reproduction steps with redacted data
- impact and suggested mitigation

## Data handling

- Local mode reads runtime data already stored on the user's computer.
- Cline account mode uses the user's own Cline authentication and read-only API requests.
- Credentials are never printed or embedded in dashboards.
- Generated dashboards are self-contained local HTML files.
- Do not commit `.env`, `secrets.json`, `providers.json`, SQLite databases, logs, generated reports, or ZIP artifacts containing user data.

## Repository hygiene

- `.gitignore` excludes runtime credential files, session databases, transcripts, reports, and archives.
- `npm run check:artifacts` blocks tracked runtime data and customer archives.
- `npm run check:history` re-runs the history-wide secret and data scan; `npm run audit:history` regenerates the documented result.
- The recorded audit is in [history-audit.md](docs/history-audit.md). It lists rule names and paths only and never prints credential values.
- If a real credential is ever found in reachable history, revoke and rotate it first, then rewrite history; deleting the file in a later commit is not sufficient.
