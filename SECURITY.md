# Security Policy

## Supported versions

Security fixes apply to the latest tagged release on the default branch. Older release lines and unsupported runtime versions may require an upgrade before a fix can be applied.

The current support contract is Node.js 22.13.0 or newer on Windows, Ubuntu, and macOS. Bun 1.4.2 or newer receives optional CI compatibility coverage; Node.js remains the reference runtime.

## Reporting a vulnerability

Please open a private security report through the repository host's security advisory feature. Do not open a public issue containing credentials, personal data, session transcripts, or an exploitable proof of concept.

Include:

- affected adapter and version
- runtime, operating system, Node/Bun version, and repository commit
- reproduction steps with redacted data
- impact and suggested mitigation

For non-sensitive installation or usage questions, use the public support route in [SUPPORT.md](SUPPORT.md).

## Data and network handling

The skills are local-first, but “local-first” is not a claim that every command is offline or read-only.

| Operation | Reads | Network | Writes |
| --- | --- | --- | --- |
| Cline local report | Cline SQLite ledger and message JSON | No | Only requested output such as `--json` stdout or `--dashboard` HTML |
| Cline `--account` | Credential plus Cline account API responses | Yes, read-only requests to Cline | Only requested output |
| MCode local report | MCode runtime SQLite ledger and session logs | No | Only requested output |
| MCode `--rates` | Bundled `references/provider-rates.json` | No | Only requested output |
| MCode `--refresh-rates` | Existing mirrored rate file plus provider pricing sources | Yes, CommandCode and StepFun | Atomically rewrites installed `references/provider-rates.json` only after all sources validate; on any failure it retains the whole previous valid table and writes nothing |

Cline account credentials are resolved in this order: `CLINE_API_KEY`, a non-expired `cline` or `cline-pass` OAuth token in `data/settings/providers.json`, then legacy `data/secrets.json` `apiKey`. Credentials are never printed or embedded in dashboards.

Cline opens `data/db/sessions.db` read-only. Reports read Cline and MCode message/session files but do not alter runtime ledgers. Standing-summary config files are read, not rewritten.

Generated HTML is self-contained and loads no external assets, but it can contain session titles, IDs, models, providers, usage, costs, and account identifiers. JSON output can contain the same sensitive metadata. Store and share outputs as private data.

MCode token accounting treats `input_tokens` as fresh input and reports cache reads/writes separately. A provider-supplied cache-write rate is used; an omitted rate remains unknown and is never assumed to be zero. A call with positive cache-write tokens and no published rate makes pricing coverage partial/unknown. StepFun `step-5-preview` cache writes use the input rate. `--include-children` is recursive for Cline descendants but currently includes direct child sessions only for MCode 0.2.0.

## Repository and release hygiene

Do not commit `.env`, `providers.json`, `secrets.json`, Cline/MCode SQLite databases or sidecars, runtime JSON/JSONL transcripts, generated reports, local logs, archives, or checksums containing private artifacts.

`.gitignore` is only a convenience. Customer archives must be assembled from the explicit allowlist in [docs/release.md](docs/release.md), and CI validates that allowlist independently of ignore rules.

### History audit result — 2026-09-25

After a plain `git fetch origin`, all objects reachable from the refs available in the audited clone were enumerated with `git rev-list --objects --all`. The baseline through commit `5110c8b` contained 245 reachable objects, including 73 blobs. A value-suppressing scan checked every reachable blob for high-confidence private-key, AWS access-key, GitHub token, Google API key, Slack token, and OpenAI-style key signatures, and checked object paths for credential files, Cline/MCode databases and sidecars, runtime transcripts, and archives.

Result: **0 findings**. No reachable path was a credential/database/transcript/archive, and no high-confidence live credential signature was found. No rotation was indicated by this audit. This is a point-in-time result, not a substitute for reviewing future commits and refs.

### Re-audit procedure

Before a release or after any reported exposure:

1. Fetch the intended refs and tags with plain `git fetch origin`; do not use a wildcard refspec.
2. Prefer a maintained scanner such as `gitleaks git --redact --no-banner .` so candidate values are not printed. Review its exit status and path-only findings.
3. If a credential may be live, revoke or rotate it **before** rewriting history. Do not paste the value into an issue, chat, log, or commit.
4. Enumerate all reachable objects and sensitive paths as a second check. CI performs a high-confidence version of this check with `fetch-depth: 0` and reports categories/paths, never values.
5. If history must be rewritten, coordinate the rewrite, invalidate old clones/tags as appropriate, and rerun the complete audit before publishing.

An empty result does not authorize committing secrets. If a value is accidentally staged, unstage it, remove it from the working tree, and follow the exposure procedure above.
