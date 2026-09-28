# MCode session-cost adapter

This directory contains the native MiniMax Code session-cost baseline.

Install to:

```text
%USERPROFILE%\.minimax\skills\session-cost\
```

Current capabilities:

- MCode runtime SQLite ledger accounting
- CommandCode and StepFun mirrored provider rates with source/parser/fetch provenance
- Explicit cache-write parsing: published zero stays zero; missing stays unknown
- Peak/off-peak, effective-date, context-tier, and promotion-aware rate metadata
- Conservative highest-context-tier fallback when call context is unavailable
- Separate recorded ledger cost, rate-calculated estimate, and API-equivalent cost domains
- Model/provider switching within a session
- Partial or unavailable cost reporting when rates are missing
- Native MCode session and subagent accounting
- Automatic current-session selection
- `--last`, `--today`, `--compare`
- Date/provider/model filters
- `--rates` component-level coverage and freshness view
- Versioned JSON output with rate-card fingerprints and component completeness
- Optional standing-summary configuration

MCode uses `--rates` instead of the Cline-only `--account` API view.

MCode-specific semantics must remain intact:

- `input_tokens` excludes cached tokens
- Cost is calculated from provider rates, not Cline account fields or the ledger's placeholder `cost_usd`
- Rate records carry effective dates, context thresholds, time bands, source versions, and fingerprints
- Missing rate components are `null`/partial, never silently zero
- Unknown provider/model rates are never guessed
- JSON distinguishes recorded cost from rate/API-equivalent estimates and exposes exactness/coverage

The shared UX enhancements will be ported in a later phase without replacing this native accounting logic.
