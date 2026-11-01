# The MCP server

`session-cost --mcp` serves the same reports over the [Model Context Protocol](https://modelcontextprotocol.io)
so an agent can ask "what did this session cost?" as a tool instead of shelling out and parsing text.

```bash
node ~/.cline/skills/session-cost/scripts/session-cost.mjs --mcp      # Cline
node <skill>/scripts/session-cost.mjs --mcp --data-dir /path/to/ledger # any runtime, explicit ledger
```

The server speaks JSON-RPC 2.0, one message per line, on stdin/stdout, per the MCP specification
revision pinned in `shared/mcp.mjs` (`2025-06-18`; the previous two revisions are also accepted).
It exits when stdin closes, and a client that hangs up is not an error.

## The property this design buys

**A tool call cannot report a number the CLI would not.** The server prices nothing, rolls nothing
up, and renders nothing: each tool call re-runs that runtime's own entry point as a child process
and returns its output verbatim. The MCP answer and the terminal answer are the same bytes from the
same code path, and a test asserts exactly that (`tests/mcp-server.test.mjs`). A second accounting
implementation living in a protocol adapter is exactly how a tool ends up quoting a figure the
ledger never supported.

Two consequences worth knowing:

- A whole MCP session is one child process per tool call (roughly 100-400 ms on a real ledger),
  processed one call at a time so two reports never interleave on one pipe.
- An incomplete answer is still a successful tool result. The CLI's exit code `2` means "ran fine,
  part of the total could not be priced"; the result carries `isError: false` and
  `_meta['session-cost'].coverage: "incomplete"`, and the text names how many calls are missing.
  Only a crash (`1`) or a non-zero exit with no output is `isError: true`.

## Read-only, by construction

No tool writes config, refreshes rates, or touches the network. The argv for each tool is built from
an allowlist of report flags (`shared/mcp.mjs`, `READ_ONLY_FLAGS`), so `--init-config`,
`--import-config`, `--refresh-rates`, `--dashboard`, `--out`, `--watch` and `--budget` are not
reachable from any tool. The only flags forwarded from the server's own command line are the ones
that locate the ledger: `--data-dir`, `--session-config`, `--config`. Without that, a server
pointed at one directory would answer with another directory's sessions - real numbers about the
wrong machine.

Reports never contain prompts, transcripts, or credentials, so neither do tool results.

## Tools

| Tool | Arguments | Answers |
| --- | --- | --- |
| `session_cost` | `session`, `selection` (`current`/`last`/`today`), `includeChildren`, `format` (`brief` default, `brief-json`, `json`, `text`) | What one session cost: the figure with its coverage, tokens, cache-read rate, per-model split |
| `list_sessions` | `count` (1-1000, default 10), `includeChildren`, `format` (`text` default, `json`) | The most recent sessions, newest first |
| `cost_rollup` | `period` (`daily`/`weekly`, required), `count` (default 30), `includeChildren` | Spend per day or week |
| `explain_cost` | `session`, `selection`, `includeChildren` | The rate records behind a figure, the cache split, and the coverage gaps |
| `rate_coverage` | none | Which models the rate table can price, when it was refreshed, and the free-tier list |

`rate_coverage` on a runtime that records cost in its own ledger (Cline) answers honestly that there
is no rate table, rather than returning an empty coverage object a client could read as "no gaps".

## Client configuration

### Cline

Cline reads MCP servers from its MCP settings file (`mcpServers`):

```json
{
  "mcpServers": {
    "session-cost": {
      "command": "node",
      "args": ["~/.cline/skills/session-cost/scripts/session-cost.mjs", "--mcp"],
      "disabled": false,
      "autoApprove": ["session_cost", "list_sessions", "cost_rollup", "explain_cost", "rate_coverage"]
    }
  }
}
```

### Claude Code

```bash
claude mcp add session-cost -- node ~/.cline/skills/session-cost/scripts/session-cost.mjs --mcp
```

Or, project-scoped in `.mcp.json`:

```json
{
  "mcpServers": {
    "session-cost": {
      "command": "node",
      "args": ["/absolute/path/to/scripts/session-cost.mjs", "--mcp"]
    }
  }
}
```

Any other MCP client that starts a stdio server works the same way: command `node`, argument
`<path to session-cost.mjs>`, then `--mcp`. The path may be an installed skill
(`~/.cline/skills/session-cost/scripts/session-cost.mjs` or
`~/.minimax/skills/session-cost/scripts/session-cost.mjs`) or a checkout. Add
`--data-dir <path>` to point it at a specific ledger; without it the server answers for the same
default ledger the CLI would use.

## Protocol details

| Concern | Behaviour |
| --- | --- |
| Framing | Newline-delimited JSON-RPC 2.0 on stdin/stdout |
| Version | Requests `2025-06-18`; accepts `2025-06-18`, `2025-03-26`, `2024-11-05` and answers with the revision the client asked for |
| Methods | `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call` |
| Batching | Rejected (`-32600`); JSON-RPC batching was removed in `2025-06-18` |
| Unknown method | `-32601` |
| Unknown tool, or arguments that fail the tool's JSON Schema | `-32602`, with the offending path in `error.data.problems` |
| Unparseable line | `-32700`, `id: null` |
| `initialize` not sent first | `-32600`, naming the handshake |
| stdout | Protocol messages only. Every diagnostic goes to stderr |
| stdin | Closing it ends the session; a half-sent line is still answered |

## Limitations

- No progress notifications or streaming: one request, one answer.
- No resources or prompts, only tools: the figures are the product, and a resource tree would be a
  second way to publish them.
- The server does not cache. Every call re-reads the ledger, so a figure is never stale, and a
  write in progress is reported the same way the CLI reports it.
