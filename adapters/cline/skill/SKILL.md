---
name: session-cost
description: Report a Cline session's real token usage and Cline-recorded cost from Cline's local session ledger. Use for "session cost", "cost summary", "token usage", "cache rate", "how much did this cost", or a request for input/output/cache token totals. Supports recent-session lists and optional subagent totals. Never guess a price when Cline did not record one.
---

# Session Cost

Report what a Cline session consumed and what Cline recorded it as costing. Read
`references/storage.md` before changing the script or investigating unexpected totals.

## Procedure

1. Identify the session. Let the script resolve it automatically; if its output reports multiple plausible
   candidates, run `--list 10` and ask which one. Use `--session <id>` when the user names a session.
2. Decide whether subagents count. Keep them out for "this session". Add `--include-children` for
   "this task end to end" when the task spawned subagents. The report names excluded children so
   the total is not silently incomplete.
3. The resolver uses an explicit `--session`, supported `CLINE_SESSION_ID`/`CLINE_SESSION_ULID`/`CLINE_ULID`
   environment variables, the Cline process ancestry, the current CLI event-log context, then a unique
   running session. If several active sessions remain plausible, pass `--session` rather than guessing.
4. Run the bundled script; never calculate cost by hand:

   ```powershell
   node "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs"
   ```

   Map natural requests to flags: `current` → no flag, `last` → `--last`, `today` →
   `--today`, `compare` → `--compare`, `this task end to end` → add `--include-children`.
   Use `--from YYYY-MM-DD --to YYYY-MM-DD`, `--provider <name>`, and `--model <name>` for
   filtered aggregates. Use `doctor`, `providers`, `models discover`, and `config explain` for setup and
   model/provider diagnostics. Cline cost remains runtime-recorded; compatible provider drivers supply
   model and provider identity but do not replace recorded cost with an API estimate.

5. Read the report's **Snapshot**, **Token totals**, **Recorded cost**, **Cost coverage**, and
   **By model** lines before answering.
6. Return a compact block containing:
   - billing classification and its evidence;
   - recorded cost and whether it is complete, partial, included/free, or not recorded;
   - total, fresh input, cached input, cache-write, and output tokens;
   - cache-hit rate;
   - model count and call count;
   - whether subagents were included.

## Cost rules

- Use `metrics.cost` from assistant messages. It is the only local cost source; never substitute a
  guessed provider/model price.
- If every call has a numeric cost, the sum is complete. If only some do, label the sum **partial**
  and state how many calls lack cost data.
- If no call has a numeric cost, say **not recorded**. A stored `$0.00` for Cline Pass or a free
  model means no separate usage charge was recorded, not that a subscription has no marginal value.
- Cline's `inputTokens` already includes cached prompt tokens. Report fresh input as
  `inputTokens - cacheReadTokens - cacheWriteTokens`, floored at zero. Do not subtract cache reads
  from Cline input the way MiniMax Code's ledger requires.
- Active-session totals are snapshots and can grow between runs.

## Optional modes

```powershell
$SessionCost = "$env:USERPROFILE\.cline\skills\session-cost\scripts\session-cost.mjs"
node $SessionCost
node $SessionCost --last
node $SessionCost --today
node $SessionCost --compare
node $SessionCost --list 10
node $SessionCost --from 2026-09-01 --to 2026-09-30
node $SessionCost --provider cline-pass
node $SessionCost --model deepseek
node $SessionCost --session <id> --include-children
node $SessionCost --json
node $SessionCost --data-dir <path>
node $SessionCost --config <path>
node $SessionCost --account
node $SessionCost --account --json
node $SessionCost --account --account-days 90
node $SessionCost --account --account-user-id usr-...
```

`--last` selects the newest completed session. `--today` aggregates sessions started on the current
UTC date. `--compare` compares the latest two matching sessions. Date, provider, and model filters
produce an aggregate when multiple sessions match.

`--account` is a separate read-only account view. It reports Cline API balance, plan, five-hour/weekly/monthly usage limits, reference cost, credits used, total account tokens, ClinePass request count, and live period totals for today, the rolling last seven days, the current calendar month, plus recent daily/weekly/monthly history. It does not replace or silently merge with the current session's local `metrics.cost`. The command reads `CLINE_API_KEY` or the authenticated `data/secrets.json` apiKey, never prints the credential, and requires a currently valid Cline API authentication.

## Standing-summary configuration

The optional config file is `%USERPROFILE%\.cline\session-cost.json` (or pass `--config <path>`):

```json
{
  "standingSummary": true,
  "includeChildren": true,
  "defaultFormat": "compact",
  "warnOnCacheRateBelow": 0.6
}
```

`includeChildren` is applied when the command line does not explicitly set it. The other fields are
reserved for the agent's standing-summary behavior; the CLI never writes this file automatically.