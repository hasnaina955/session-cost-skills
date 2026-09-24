# Cline session-cost storage

## Sources

| Fact | Source |
| --- | --- |
| Session list, status, parent/subagent links | `%USERPROFILE%\.cline\data\db\sessions.db`, table `sessions` |
| Per-call model and metrics | `sessions.messages_path`, assistant message `modelInfo` and `metrics` |
| Fallback aggregate/title | `sessions.metadata_json` |

The script reads the database read-only. It prefers message-level metrics because the aggregate in
`metadata_json` may lag while a session is active. JSON output is versioned with
`schemaVersion: 1`; list output wraps reports in `{ generatedAt, sessions }`.

## Current-session selection

The default resolver uses this precedence:

1. `--session <id>`
2. `CLINE_SESSION_ID`, `CLINE_SESSION_ULID`, or `CLINE_ULID`
3. An exact Cline process-ancestry PID match
4. The most recent `task.tool_used` event with a session ULID in the local CLI log
5. The unique running session
6. The newest session, with an ambiguity warning when multiple sessions are plausible

A warning is preferable to silently selecting a teammate's session. Use `--session` to resolve it.

## Message metrics

An assistant message can contain:

```json
{
  "modelInfo": { "id": "model-id", "provider": "provider-id" },
  "metrics": {
    "inputTokens": 1000,
    "outputTokens": 100,
    "cacheReadTokens": 800,
    "cacheWriteTokens": 0,
    "cost": 0.00123
  }
}
```

`cost` is optional. Numeric costs are summed as Cline recorded them. Models with no cost field are
reported as not priced from an external table. The report also classifies billing as usage-billed,
ClinePass included, free model, mixed included/free, partial cost, or unavailable; the evidence and
coverage are included in JSON output.

## Token convention

Cline's `inputTokens` is the provider's total input count and includes cached prompt tokens. Thus:

- total prompt = `inputTokens`
- cache-read subset = `cacheReadTokens`
- cache-write subset = `cacheWriteTokens`
- fresh input = `max(0, inputTokens - cacheReadTokens - cacheWriteTokens)`
- total tokens = `inputTokens + outputTokens`

This differs from the MiniMax Code ledger targeted by the original skill, where `input_tokens`
excludes cached tokens. Keeping the calculations separate prevents double-discounting cache reads.

## Subagents

Subagent rows have `parent_session_id` and `is_subagent = 1`. Their message path can live in the
parent session directory rather than a directory named after the subagent id, so always use the
database's `messages_path` instead of reconstructing it.

`--include-children` recursively folds all descendants into the task total. Every child keeps its
own model/cost metrics. Without the flag, child ids are listed as excluded.

## Account API view

`--account` is intentionally separate from local session accounting. It uses the Cline API's
`/users/me`, `/balance`, `/plan`, `/plan/usage-limits`, and paginated `/usages` endpoints. The
account response normalizes API money units as follows:

- `balance` and `creditsUsed`: millionths of USD (`/ 1_000_000`)
- `costUsd`: hundred-millionths of USD (`/ 100_000_000`)

The account view reports `referenceCostUsd` separately from `creditsUsedUsd`; it must not be added to
a local session's recorded `metrics.cost`. API credentials are read at runtime and are never emitted.
An unauthorized response means the stored Cline authentication is expired or invalid; re-authenticate
Cline and retry.
- Older Cline versions can have aggregate usage without per-message `cost`; the script reports that
  limitation rather than guessing.
- A missing or malformed message file falls back to `metadata_json.aggregateUsage`/`usage` when
  available and marks the source as aggregate.
- Local recorded cost is not the same as ClinePass subscription value or account credit balance.
