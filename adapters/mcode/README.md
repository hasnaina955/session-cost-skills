# MCode session-cost adapter

This directory contains the native MiniMax Code session-cost baseline.

Install to:

```text
%USERPROFILE%\.minimax\skills\session-cost\
```

Current capabilities:

- MCode runtime SQLite ledger accounting
- CommandCode and StepFun mirrored provider rates
- Cache-read and cache-write billing rules
- Peak/off-peak CommandCode bands
- Model/provider switching within a session
- Partial or unavailable cost reporting when rates are missing
- Native MCode session and subagent accounting

MCode-specific semantics must remain intact:

- `input_tokens` excludes cached tokens
- Cost is calculated from provider rates, not Cline account fields
- Unknown provider/model rates are never guessed

The shared UX enhancements will be ported in a later phase without replacing this native accounting logic.
