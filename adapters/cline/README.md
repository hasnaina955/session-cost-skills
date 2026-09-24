# Cline session-cost adapter

This directory contains the Cline-specific skill package.

Install to:

```text
%USERPROFILE%\.cline\skills\session-cost\
```

Current capabilities:

- Local Cline session token and cache accounting
- ClinePass/free/billed/partial billing classification
- Automatic current-session resolution
- Subagent totals
- `--last`, `--today`, `--compare`
- Date/provider/model filters
- Optional read-only `--account` API view
- Versioned JSON output

The Cline adapter uses `%USERPROFILE%\.cline\data\db\sessions.db` and Cline message history. It must not be modified to use MCode ledger semantics.
