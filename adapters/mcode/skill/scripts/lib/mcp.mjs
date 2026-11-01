/**
 * A Model Context Protocol server over stdio, so an agent can ask "what did this cost?" as a tool.
 *
 * ## Why this module computes no accounting
 *
 * Every other module in `shared/` exists so that two adapters agree on a number. This one exists
 * for the opposite reason: an MCP client will believe whatever it is told, with no terminal output
 * beside it to sanity-check against, and a wrong figure here would be quoted as fact inside
 * somebody's agent. So this module does not price anything, roll anything up, or render a report.
 * It translates a tool call into the adapter's own command line, runs **the adapter's own entry
 * point as a child process**, and returns that process's output verbatim.
 *
 * The property that buys: the MCP answer and the CLI answer are the same bytes from the same code
 * path, because they are the same code path. A tool call cannot invent a figure, because nothing
 * here computes one. When the CLI exits 2 - "ran fine, the answer is incomplete" - the tool result
 * is still a success carrying the CLI's own caveat, so an agent reads "3 of 40 calls could not be
 * priced" instead of a tidy total.
 *
 * ## Read-only by construction
 *
 * Each tool's argv is built here from a fixed allowlist of report flags. `--init-config`,
 * `--import-config`, `--refresh-rates`, `--dashboard`, `--out`, `--watch` and `--budget` are not
 * reachable from any tool: this server never writes a file, never refreshes a rate table, and never
 * makes a network call. A test asserts that rather than a comment claiming it.
 *
 * ## The protocol
 *
 * JSON-RPC 2.0, one message per line, over stdin/stdout, following the MCP schema for
 * `2025-06-18` (modelcontextprotocol/modelcontextprotocol, `schema/2025-06-18/schema.json` - the
 * revision this was written against, pinned below). Shapes implemented: `InitializeRequest` ->
 * `InitializeResult`, `ListToolsRequest` -> `ListToolsResult`, `CallToolRequest` ->
 * `CallToolResult` including `isError`, and `PingRequest`.
 *
 * Two rules that cost real bugs when missed:
 *
 * - **Nothing but protocol messages may go to stdout.** Not a warning, not a blank line, not a
 *   `console.log` reached during a tool call. Every diagnostic goes to stderr, and a child
 *   process's stdout is captured rather than inherited. The integration test parses every stdout
 *   line as JSON-RPC, because one stray line breaks the whole session.
 * - **JSON-RPC batching was removed in 2025-06-18.** A batch array gets one invalid-request error
 *   instead of being half-processed.
 *
 * Dependency-free so it can be copied verbatim into each adapter and stay independently
 * installable (`npm run sync:mcp`).
 */

import { spawn } from 'node:child_process';

/** The MCP revision this server implements, pinned so a client can tell what it is talking to. */
export const MCP_PROTOCOL_VERSION = '2025-06-18';

/**
 * Revisions this server will speak. The request/result shapes above are stable across these three,
 * so a client asking for an older one keeps working; a client asking for something newer is
 * answered with `MCP_PROTOCOL_VERSION` and decides for itself whether to continue, which is the
 * spec's negotiation rule: the server replies with a version it supports.
 */
export const MCP_SUPPORTED_PROTOCOL_VERSIONS = Object.freeze(['2025-06-18', '2025-03-26', '2024-11-05']);

/** The name this server reports in `serverInfo`. */
export const MCP_SERVER_NAME = 'session-cost';

/** JSON-RPC 2.0 error codes. Reserved values, not ours to invent. */
export const JSONRPC_PARSE_ERROR = -32700;
export const JSONRPC_INVALID_REQUEST = -32600;
export const JSONRPC_METHOD_NOT_FOUND = -32601;
export const JSONRPC_INVALID_PARAMS = -32602;
export const JSONRPC_INTERNAL_ERROR = -32603;

/** One protocol line is capped so a hostile or broken client cannot exhaust memory. */
export const MAX_MESSAGE_BYTES = 4 * 1024 * 1024;

/** How long one tool call may run before it is killed. A report over a large ledger takes seconds. */
export const TOOL_TIMEOUT_MS = 120_000;

/**
 * The flags a tool may pass to the adapter, as an allowlist rather than a blocklist.
 *
 * A blocklist would fail open: the next flag somebody adds to the CLI would be reachable from an
 * agent the moment it shipped. This way a new flag is unreachable until someone adds it here on
 * purpose, which is the review such a flag needs.
 */
export const READ_ONLY_FLAGS = Object.freeze([
  '--session', '--last', '--today', '--list', '--rollup', '--explain', '--brief', '--json',
  '--include-children', '--rates', '--data-dir', '--config', '--session-config',
]);

// A selection names the session to report. `--session` is not part of this enum because it is a
// value; combining it with --last is a usage error the CLI already rejects, and the schema says so
// by leaving only one of them expressible per call.
const SELECTION = Object.freeze({
  type: 'string',
  enum: ['current', 'last', 'today'],
  description: 'current = the session this agent is running in (default), last = the most recent session, today = aggregate today.',
});

const FORMAT_BRIEF = Object.freeze({
  type: 'string',
  enum: ['brief', 'brief-json', 'json', 'text'],
  description: 'brief = a few lines (default); brief-json = the stable brief subset as JSON; json = the full normalized report contract; text = the full human report.',
});

/**
 * The tool surface.
 *
 * Five tools, and why these five: an agent needs one session's cost (1), what else ran (2), what a
 * period cost (3), why a number is what it is (4), and whether the rate table can price the models
 * at all (5). Anything more - widgets, dashboards, comparisons chosen by the server - would make
 * the server opinionated about a question nobody asked.
 */
export const MCP_TOOLS = Object.freeze([
  {
    name: 'session_cost',
    title: 'Session cost',
    description: 'What one session cost, from its own ledger: the figure with its coverage, tokens, '
      + 'cache-read rate, and per-model split. An unknown cost is reported as unknown, never as $0.',
    inputSchema: {
      type: 'object',
      properties: {
        // A leading '-' is refused at the schema: a session id is caller-controlled text, and one
        // that looked like a flag would reach the child's argument parser as a flag.
        session: { type: 'string', pattern: '^[^-]', description: 'Session id or unique prefix (must not start with "-"). Omit to use the selection.' },
        selection: SELECTION,
        includeChildren: { type: 'boolean', description: 'Fold sub-agent sessions into the total (default false).' },
        format: FORMAT_BRIEF,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    title: 'List sessions',
    description: 'The most recent sessions, newest first, one line each: id, cost domain, tokens, calls, '
      + 'title. Use format "json" for the full normalized reports.',
    inputSchema: {
      type: 'object',
      properties: {
        count: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many sessions (default 10).' },
        includeChildren: { type: 'boolean', description: 'Fold sub-agent sessions into each total.' },
        format: { type: 'string', enum: ['text', 'json'], description: 'text = one line per session (default), json = normalized reports.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'cost_rollup',
    title: 'Cost rollup',
    description: 'Spend per day or per week across recent sessions. A period containing an unpriced call is '
      + 'reported as unknown rather than as the sum of the priced ones.',
    inputSchema: {
      type: 'object',
      properties: {
        period: { type: 'string', enum: ['daily', 'weekly'], description: 'Bucket size.' },
        count: { type: 'integer', minimum: 1, maximum: 1000, description: 'How many recent sessions to roll up (default 30).' },
        includeChildren: { type: 'boolean', description: 'Fold sub-agent sessions in.' },
      },
      required: ['period'],
      additionalProperties: false,
    },
  },
  {
    name: 'explain_cost',
    title: 'Explain a cost',
    description: 'Why a session cost what it did: the rate records selected per call, the cache split, and '
      + 'the coverage gaps, traced back to the ledger rows.',
    inputSchema: {
      type: 'object',
      properties: {
        // A leading '-' is refused at the schema: a session id is caller-controlled text, and one
        // that looked like a flag would reach the child's argument parser as a flag.
        session: { type: 'string', pattern: '^[^-]', description: 'Session id or unique prefix (must not start with "-"). Omit to use the selection.' },
        selection: SELECTION,
        includeChildren: { type: 'boolean', description: 'Fold sub-agent sessions in.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'rate_coverage',
    title: 'Rate coverage',
    description: 'Which models the rate table can price, when it was refreshed, and the free-tier list. A '
      + 'runtime that records cost directly has no rate table, and this tool says so.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
]);

const TOOLS_BY_NAME = new Map(MCP_TOOLS.map((tool) => [tool.name, tool]));

/**
 * Validate a tool's arguments against the JSON Schema subset its `inputSchema` uses.
 *
 * A deliberate subset - object, string, integer, number, boolean, array, plus required, enum,
 * minimum, maximum, pattern, items and additionalProperties - because those are the keywords the
 * definitions above actually use, and a validator that silently ignored an unknown keyword would be
 * a validator that approves anything. A missing `required` property is named with its path, because
 * "invalid arguments" with no path is the message that makes an agent retry the same call.
 */
export function validateToolInput(schema, value, path = 'arguments') {
  const problems = [];
  const actual = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;

  const matches = (expected) => {
    if (expected === 'integer') return typeof value === 'number' && Number.isInteger(value);
    if (expected === 'number') return typeof value === 'number' && Number.isFinite(value);
    if (expected === 'array') return Array.isArray(value);
    if (expected === 'object') return actual === 'object';
    return actual === expected;
  };

  if (schema?.type !== undefined && !matches(schema.type)) {
    problems.push(`${path} must be ${schema.type === 'integer' ? 'an integer' : `a ${schema.type}`}, but was ${actual === 'null' ? 'null' : `${actual} ${JSON.stringify(value)}`}`);
    return problems;
  }
  if (schema?.enum !== undefined && !schema.enum.includes(value)) {
    problems.push(`${path} must be one of ${schema.enum.map((entry) => JSON.stringify(entry)).join(', ')}, but was ${JSON.stringify(value)}`);
  }
  if (typeof value === 'number') {
    if (schema?.minimum !== undefined && value < schema.minimum) problems.push(`${path} must be >= ${schema.minimum}, but was ${value}`);
    if (schema?.maximum !== undefined && value > schema.maximum) problems.push(`${path} must be <= ${schema.maximum}, but was ${value}`);
  }
  if (typeof value === 'string' && schema?.pattern !== undefined && !new RegExp(schema.pattern).test(value)) {
    problems.push(`${path} must match ${schema.pattern}, but was ${JSON.stringify(value)}`);
  }
  if (actual === 'object') {
    const properties = schema?.properties ?? {};
    for (const required of schema?.required ?? []) {
      if (value[required] === undefined) problems.push(`${path}.${required} is required`);
    }
    for (const [key, child] of Object.entries(value)) {
      if (properties[key] === undefined) {
        if (schema?.additionalProperties === false) problems.push(`${path}.${key} is not a recognised argument`);
        continue;
      }
      problems.push(...validateToolInput(properties[key], child, `${path}.${key}`));
    }
  }
  return problems;
}

/**
 * Build the adapter argv for one tool call.
 *
 * Pure and separate from the transport so the mapping is testable without a process, and readable
 * by someone auditing what an agent can actually ask for. Nothing here decides whether an answer is
 * right; it decides which question to ask.
 */
export function buildToolArgv(tool, args = {}) {
  const argv = [];
  const selection = args.selection ?? 'current';
  if (args.session !== undefined) argv.push('--session', args.session);
  else if (selection === 'last') argv.push('--last');
  else if (selection === 'today') argv.push('--today');
  if (args.includeChildren === true) argv.push('--include-children');

  switch (tool) {
    case 'session_cost':
      if (args.format === 'json') argv.push('--json');
      else if (args.format === 'brief-json') argv.push('--brief', '--json');
      else if (args.format === 'text') { /* the default full report */ }
      else argv.push('--brief');
      return argv;
    case 'list_sessions':
      // The count is always explicit, even when it equals the CLI default, so a trace of the call
      // shows what was asked for instead of relying on a default that could change.
      argv.push('--list', String(args.count ?? 10));
      if (args.format === 'json') argv.push('--json');
      return argv;
    case 'cost_rollup':
      argv.push('--list', String(args.count ?? 30), '--rollup', args.period);
      return argv;
    case 'explain_cost':
      argv.push('--explain');
      return argv;
    case 'rate_coverage':
      return ['--rates', '--json'];
    default:
      throw new Error(`unknown tool: ${tool}`);
  }
}

/** The flags in the allowlist that take a value, so a value token is not mistaken for a flag. */
const VALUE_FLAGS = new Set(['--session', '--list', '--rollup', '--data-dir', '--config', '--session-config']);

/**
 * The arguments the server must forward to every child process.
 *
 * Without this a server started with `--data-dir X` would answer from the default ledger, which is
 * the worst kind of bug: the numbers would be real, correctly priced, and about a different
 * machine's sessions. Only the three locating flags are forwarded, and only when they were given,
 * so the child recomputes the same defaults the parent would have.
 */
export function passthroughArgs({ dataDir, sessionConfigPath, configPath } = {}) {
  const argv = [];
  if (dataDir) argv.push('--data-dir', dataDir);
  if (sessionConfigPath) argv.push('--session-config', sessionConfigPath);
  if (configPath) argv.push('--config', configPath);
  return argv;
}


/**
 * Assert an argv contains only allowlisted flags and their values.
 *
 * `buildToolArgv` is the only caller today, so this looks redundant - but it is the check that
 * keeps a future edit to `buildToolArgv` (or a tool definition reachable from a client's arguments)
 * from turning into `--refresh-rates` or `--init-config`. The guard costs nothing and it fails
 * closed.
 */
export function assertReadOnlyArgv(argv) {
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token.startsWith('--')) {
      if (!READ_ONLY_FLAGS.includes(token)) throw new Error(`refusing to pass a non-report flag to the adapter: ${token}`);
      if (VALUE_FLAGS.has(token)) index += 1;
      continue;
    }
    const owner = argv[index - 1];
    if (!VALUE_FLAGS.has(owner)) throw new Error(`refusing to pass a bare value to the adapter: ${token}`);
  }
  return argv;
}

/**
 * Run one tool call and shape it as a `CallToolResult`.
 *
 * `runner` is injected so the tests can drive the whole server without a second Node process; the
 * default spawns the real adapter entry point, which is the behaviour that matters.
 */
export async function callTool(toolName, args, { runner, runtime, rateCoverage = true } = {}) {
  const definition = TOOLS_BY_NAME.get(toolName);
  if (!definition) {
    return { protocolError: { code: JSONRPC_INVALID_PARAMS, message: `unknown tool: ${toolName}` } };
  }
  const problems = validateToolInput(definition.inputSchema, args ?? {});
  if (problems.length > 0) {
    return {
      protocolError: {
        code: JSONRPC_INVALID_PARAMS,
        message: `invalid arguments for ${toolName}`,
        data: { problems },
      },
    };
  }

  // A runtime with no rate table answers honestly instead of running a command it does not have.
  // This is the tool-level form of "unknown cost is null, never 0": the absence of a rate table is
  // stated, not papered over with an empty object a client could read as "no gaps".
  if (toolName === 'rate_coverage' && rateCoverage === false) {
    return {
      content: [{
        type: 'text',
        text: `The ${runtime} adapter records cost in its own ledger (billing.recordedCostUsd) and holds no rate `
          + 'table, so there is no rate coverage to report. Ask session_cost for that ledger\'s figure.',
      }],
      isError: false,
      _meta: { 'session-cost': { runtime, exitCode: 0, rateCoverage: 'not-applicable' } },
    };
  }

  // A session id is caller-controlled text, so a value that looks like a flag must be refused
  // rather than reaching the child as one. Failing closed turns a hostile argument into the
  // protocol's own "invalid params" instead of an internal error.
  let argv;
  try {
    argv = assertReadOnlyArgv(buildToolArgv(toolName, args ?? {}));
  } catch (argumentError) {
    return {
      protocolError: {
        code: JSONRPC_INVALID_PARAMS,
        message: `invalid arguments for ${toolName}`,
        data: { problems: [argumentError.message] },
      },
    };
  }
  const { code, stdout, stderr } = await runner(argv);
  const text = stdout.trim();

  // Exit 2 is the CLI contract for "the answer is incomplete and the output says how" - a valid
  // answer, not a failure. A non-zero exit with no output (a usage error prints to stderr only) or
  // exit 1 is a failure the agent must not mistake for a figure.
  if (code === 1 || text === '') {
    const detail = stderr.trim() || `the ${runtime} adapter produced no output (exit ${code})`;
    return {
      content: [{ type: 'text', text: detail }],
      isError: true,
      _meta: { 'session-cost': { runtime, exitCode: code } },
    };
  }
  return {
    content: [{ type: 'text', text }],
    isError: false,
    _meta: { 'session-cost': { runtime, exitCode: code, coverage: code === 2 ? 'incomplete' : 'complete' } },
  };
}

/**
 * Spawn the adapter entry point and capture its output. Its stdout is never inherited: the only
 * writer to this process's stdout is the protocol.
 *
 * A timeout kills the child rather than leaving a stuck report holding the session open. A tool
 * call that never returns is worse than one that fails, because the client has no way to tell which
 * is happening.
 */
export function createChildRunner({ execPath = process.execPath, entry, env = process.env, timeoutMs = TOOL_TIMEOUT_MS, extraArgs = [] } = {}) {
  if (!entry) throw new Error('an MCP server needs the adapter entry point to run');
  return (argv) => new Promise((resolve) => {
    const child = spawn(execPath, [entry, ...extraArgs, ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const finish = (outcome) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish({ code: 1, stdout, stderr: `${stderr}\nthe adapter did not answer within ${timeoutMs}ms` });
    }, timeoutMs);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => finish({ code: 1, stdout, stderr: `could not start the adapter: ${error.message}` }));
    child.on('close', (code) => finish({ code: code ?? 1, stdout, stderr }));
  });
}

/**
 * The protocol state machine, with no I/O.
 *
 * `handleMessage` takes one parsed message and returns the response to send, or `undefined` when the
 * message was a notification (which by definition has no response). Keeping it pure is what lets
 * the tests cover the handshake, the error codes and version negotiation without a pipe.
 */
export function createMcpSession({ runtime, version = '0.0.0', runner, rateCoverage = true, log = () => {} } = {}) {
  if (typeof runner !== 'function') throw new Error('createMcpSession needs a runner');
  let initialized = false;
  let negotiatedVersion = null;

  const result = (id, payload) => ({ jsonrpc: '2.0', id, result: payload });
  const error = (id, code, message, data) => ({
    jsonrpc: '2.0',
    id: id ?? null,
    error: data === undefined ? { code, message } : { code, message, data },
  });

  async function handleMessage(message) {
    if (Array.isArray(message)) {
      // Removed from the protocol in 2025-06-18, and a batch has no single id to answer against.
      return error(null, JSONRPC_INVALID_REQUEST, 'JSON-RPC batching is not supported by MCP 2025-06-18');
    }
    if (message === null || typeof message !== 'object') {
      return error(null, JSONRPC_INVALID_REQUEST, 'a message must be a JSON object');
    }
    const { id, method, params } = message;
    const isNotification = id === undefined && typeof method === 'string';
    if (message.jsonrpc !== '2.0' || typeof method !== 'string') {
      // A malformed notification still gets no response: writing one would answer a message that
      // has no id, and a client that sent a broken message is not waiting for a reply to it.
      return isNotification ? undefined : error(id, JSONRPC_INVALID_REQUEST, 'not a JSON-RPC 2.0 request: jsonrpc must be "2.0" and method a string');
    }

    if (method === 'initialize') {
      const requested = params?.protocolVersion;
      if (typeof requested !== 'string' || params?.clientInfo === undefined) {
        return error(id, JSONRPC_INVALID_PARAMS, 'initialize requires protocolVersion and clientInfo');
      }
      initialized = true;
      negotiatedVersion = MCP_SUPPORTED_PROTOCOL_VERSIONS.includes(requested) ? requested : MCP_PROTOCOL_VERSION;
      if (negotiatedVersion !== requested) {
        log(`client asked for protocol ${requested}; answering with ${negotiatedVersion}, the newest this server implements`);
      }
      return result(id, {
        protocolVersion: negotiatedVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_SERVER_NAME, title: 'Session cost', version },
        instructions: 'Cost and token accounting for coding-agent sessions, read from the runtime\'s own ledger. '
          + 'Call session_cost for one session, list_sessions to find one, cost_rollup for a period, explain_cost for '
          + 'the rate records behind a figure, and rate_coverage to see which models can be priced. A figure the '
          + 'ledger cannot support is reported as unknown, never as zero; where a result says coverage is incomplete, '
          + 'part of the total is missing and the text names what.',
      });
    }

    // A notification is never answered, even an unknown one: a response requires an id, and a
    // client is not waiting for one. `notifications/initialized` is the one every client sends.
    if (isNotification) {
      if (method === 'notifications/initialized') log('client completed the initialization handshake');
      else log(`ignoring notification: ${method}`);
      return undefined;
    }

    if (!initialized) {
      // This server's own rule rather than a spec-mandated code: the shapes above are only
      // guaranteed after `initialize`, so answering early would be guessing at the contract.
      return error(id, JSONRPC_INVALID_REQUEST, 'the client must send initialize before any other request');
    }
    if (method === 'ping') return result(id, {});
    if (method === 'tools/list') return result(id, { tools: MCP_TOOLS });
    if (method === 'tools/call') {
      const name = params?.name;
      if (typeof name !== 'string') return error(id, JSONRPC_INVALID_PARAMS, 'tools/call requires params.name');
      const args = params.arguments ?? {};
      if (args === null || typeof args !== 'object' || Array.isArray(args)) {
        return error(id, JSONRPC_INVALID_PARAMS, 'tools/call params.arguments must be an object');
      }
      const outcome = await callTool(name, args, { runner, runtime, rateCoverage });
      if (outcome.protocolError) {
        const { code, message, data } = outcome.protocolError;
        return error(id, code, message, data);
      }
      return result(id, outcome);
    }
    return error(id, JSONRPC_METHOD_NOT_FOUND, `unknown method: ${method}`);
  }

  return {
    handleMessage,
    get initialized() { return initialized; },
    get protocolVersion() { return negotiatedVersion; },
  };
}

/**
 * Serve the protocol on a pair of streams until stdin ends.
 *
 * Both streams are injected so a test can drive the real framing without a real pipe, and so the
 * adapter can hand in its own. Diagnostics go to `stderr` only: `stdout` carries nothing but
 * newline-delimited protocol messages.
 */
export async function runMcpServer({
  runtime,
  entry,
  version = '0.0.0',
  rateCoverage = true,
  env = process.env,
  stdin = process.stdin,
  stdout = process.stdout,
  stderr = process.stderr,
  timeoutMs = TOOL_TIMEOUT_MS,
  execPath = process.execPath,
  extraArgs = [],
  runner,
} = {}) {
  const session = createMcpSession({
    runtime,
    version,
    rateCoverage,
    runner: runner ?? createChildRunner({ execPath, entry, env, timeoutMs, extraArgs }),
    log: (message) => stderr.write(`session-cost mcp: ${message}\n`),
  });

  // A client that closes the pipe is the normal end of an MCP session: an editor restarts the
  // server, or a one-shot caller reads what it needs and hangs up. Writing to the closed socket
  // raises EPIPE asynchronously, and an unhandled 'error' on stdout kills the process with a stack
  // trace - a crash in the log for something that is not a failure. Stop writing and let the
  // process exit quietly.
  let clientGone = false;
  stdout.on?.('error', (error) => {
    clientGone = true;
    if (error?.code !== 'EPIPE' && error?.code !== 'ERR_STREAM_DESTROYED') {
      stderr.write(`session-cost mcp: stdout failed: ${error?.message ?? error}\n`);
    }
  });

  const send = (payload) => {
    if (payload === undefined || clientGone) return;
    try {
      stdout.write(`${JSON.stringify(payload)}\n`);
    } catch (writeError) {
      clientGone = true;
      if (writeError?.code !== 'EPIPE') stderr.write(`session-cost mcp: could not answer: ${writeError?.message ?? writeError}\n`);
    }
  };

  // Requests are handled one at a time, in arrival order. A tool call runs a child process, so
  // answering concurrently would interleave two reports through one pipe; JSON-RPC permits
  // out-of-order replies, but a deterministic order is worth more here than parallelism nobody is
  // waiting on. The queue also keeps a slow report from being reordered behind a fast ping.
  let queue = Promise.resolve();
  const handleLine = (line) => {
    queue = queue.then(async () => {
      const trimmed = line.replace(/\r$/, '').trim();
      if (trimmed === '') return;
      if (Buffer.byteLength(trimmed, 'utf8') > MAX_MESSAGE_BYTES) {
        send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_INVALID_REQUEST, message: `message exceeds ${MAX_MESSAGE_BYTES} bytes` } });
        return;
      }
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch (parseError) {
        send({ jsonrpc: '2.0', id: null, error: { code: JSONRPC_PARSE_ERROR, message: `parse error: ${parseError.message}` } });
        return;
      }
      try {
        send(await session.handleMessage(message));
      } catch (internalError) {
        // A bug in this server must surface as a protocol error the client can read, not as a dead
        // pipe with no explanation. The stack goes to stderr, never into the response: it names
        // local paths.
        stderr.write(`session-cost mcp: internal error: ${internalError?.stack ?? internalError}\n`);
        send({ jsonrpc: '2.0', id: message?.id ?? null, error: { code: JSONRPC_INTERNAL_ERROR, message: 'internal error' } });
      }
    });
  };

  await new Promise((resolve) => {
    let buffer = '';
    stdin.setEncoding?.('utf8');
    stdin.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        handleLine(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
    });
    stdin.on('end', () => {
      // A client that closed the pipe mid-line still gets that message answered, because the line
      // may be a complete request whose newline simply never arrived.
      if (buffer.trim() !== '') handleLine(buffer);
      resolve();
    });
    stdin.on('error', () => resolve());
    stdin.resume?.();
  });
  await queue;
  return 0;
}




