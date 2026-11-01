import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  JSONRPC_INVALID_PARAMS,
  JSONRPC_INVALID_REQUEST,
  JSONRPC_METHOD_NOT_FOUND,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SUPPORTED_PROTOCOL_VERSIONS,
  MCP_TOOLS,
  READ_ONLY_FLAGS,
  assertReadOnlyArgv,
  buildToolArgv,
  createMcpSession,
  passthroughArgs,
  validateToolInput,
} from '../shared/mcp.mjs';
import {
  FIXTURE_EPOCH,
  clineScript,
  createClineFixture,
  createMCodeFixture,
  mcodeScript,
  runCli,
} from './helpers/contract-fixtures.mjs';

const TOOL_NAMES = MCP_TOOLS.map((tool) => tool.name);

/** Start a real `--mcp` server on the adapter's own entry point and collect its stdout. */
function openServer(script, args, env = {}) {
  const child = spawn(process.execPath, [script, '--mcp', ...args], {
    env: { ...process.env, SESSION_COST_NOW: FIXTURE_EPOCH, ...env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const done = new Promise((resolve, reject) => {
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  return {
    send(message) { child.stdin.write(`${JSON.stringify(message)}\n`); },
    close() { child.stdin.end(); },
    done,
  };
}

function initialize(id = 1, protocolVersion = MCP_PROTOCOL_VERSION) {
  return { jsonrpc: '2.0', id, method: 'initialize', params: { protocolVersion, capabilities: {}, clientInfo: { name: 'test-client', version: '1.0.0' } } };
}

function callToolMessage(id, name, args) {
  return { jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } };
}

test('each tool maps to the adapter argv an auditor would predict', () => {
  assert.deepEqual(buildToolArgv('session_cost', {}), ['--brief']);
  assert.deepEqual(buildToolArgv('session_cost', { format: 'brief-json' }), ['--brief', '--json']);
  assert.deepEqual(buildToolArgv('session_cost', { format: 'json' }), ['--json']);
  assert.deepEqual(buildToolArgv('session_cost', { format: 'text' }), []);
  assert.deepEqual(buildToolArgv('session_cost', { selection: 'last' }), ['--last', '--brief']);
  assert.deepEqual(buildToolArgv('session_cost', { selection: 'today' }), ['--today', '--brief']);
  assert.deepEqual(buildToolArgv('session_cost', { session: 'cline-root' }), ['--session', 'cline-root', '--brief']);
  assert.deepEqual(buildToolArgv('session_cost', { includeChildren: true }), ['--include-children', '--brief']);
  assert.deepEqual(buildToolArgv('list_sessions', {}), ['--list', '10']);
  assert.deepEqual(buildToolArgv('list_sessions', { count: 3, format: 'json' }), ['--list', '3', '--json']);
  assert.deepEqual(buildToolArgv('cost_rollup', { period: 'weekly' }), ['--list', '30', '--rollup', 'weekly']);
  assert.deepEqual(buildToolArgv('explain_cost', { selection: 'last' }), ['--last', '--explain']);
  assert.deepEqual(buildToolArgv('rate_coverage', {}), ['--rates', '--json']);
});

test('no tool can reach a flag that writes, refreshes, or touches the network', () => {
  // The allowlist is the guarantee; this proves nothing built from the tool surface escapes it.
  for (const tool of TOOL_NAMES) {
    for (const extra of [{}, { selection: 'last' }, { selection: 'today' }, { session: 's' }, { format: 'json' }, { period: 'daily' }, { count: 1 }]) {
      const args = tool === 'cost_rollup' ? { period: 'daily', ...extra } : extra;
      assert.doesNotThrow(() => assertReadOnlyArgv(buildToolArgv(tool, args)), `${tool} ${JSON.stringify(args)}`);
    }
  }
  for (const forbidden of ['--refresh-rates', '--init-config', '--import-config', '--export-config', '--dashboard', '--out', '--watch', '--budget', '--notify', '--setup', '--account']) {
    assert.ok(!READ_ONLY_FLAGS.includes(forbidden), `${forbidden} must not be reachable from a tool`);
    assert.throws(() => assertReadOnlyArgv([forbidden]), /non-report flag/);
  }
  // A bare value with no flag in front of it is not a report either.
  assert.throws(() => assertReadOnlyArgv(['recorded-cost']), /bare value/);
  // locate flags are forwarded, and only when given
  assert.deepEqual(passthroughArgs({}), []);
  assert.deepEqual(passthroughArgs({ dataDir: '/tmp/d', configPath: '/tmp/c.json' }), ['--data-dir', '/tmp/d', '--config', '/tmp/c.json']);
});

test('an argument that does not match the tool schema is named, not shrugged at', () => {
  const sessionCost = MCP_TOOLS.find((tool) => tool.name === 'session_cost');
  assert.deepEqual(validateToolInput(sessionCost.inputSchema, { selection: 'last', format: 'brief' }), []);
  assert.match(validateToolInput(sessionCost.inputSchema, { format: 'yaml' }).join('\n'), /arguments\.format must be one of/);
  assert.match(validateToolInput(sessionCost.inputSchema, { session: 42 }).join('\n'), /arguments\.session must be a string/);
  assert.match(validateToolInput(sessionCost.inputSchema, { nope: 1 }).join('\n'), /arguments\.nope is not a recognised argument/);
  const rollup = MCP_TOOLS.find((tool) => tool.name === 'cost_rollup');
  assert.match(validateToolInput(rollup.inputSchema, {}).join('\n'), /arguments\.period is required/);
  assert.match(validateToolInput(rollup.inputSchema, { period: 'daily', count: 0 }).join('\n'), /must be >= 1/);
  assert.match(validateToolInput(rollup.inputSchema, { period: 'daily', count: 2.5 }).join('\n'), /must be an integer/);
});

test('the handshake, the tool list, and the error codes follow the protocol', async () => {
  const session = createMcpSession({ runtime: 'cline', version: '0.6.0', rateCoverage: false, runner: async () => ({ code: 0, stdout: 'ok\n', stderr: '' }) });

  // Before initialize, a request is refused rather than answered from an unnegotiated contract.
  const early = await session.handleMessage({ jsonrpc: '2.0', id: 9, method: 'tools/list' });
  assert.equal(early.error.code, JSONRPC_INVALID_REQUEST);

  const init = await session.handleMessage(initialize(1));
  assert.equal(init.result.protocolVersion, MCP_PROTOCOL_VERSION);
  assert.equal(init.result.serverInfo.name, MCP_SERVER_NAME);
  assert.equal(init.result.serverInfo.version, '0.6.0');
  assert.deepEqual(init.result.capabilities.tools, { listChanged: false });

  // A client that speaks an older revision keeps the revision it asked for.
  const older = await session.handleMessage(initialize(2, MCP_SUPPORTED_PROTOCOL_VERSIONS.at(-1)));
  assert.equal(older.result.protocolVersion, MCP_SUPPORTED_PROTOCOL_VERSIONS.at(-1));

  // A notification is never answered, including the one every client sends.
  assert.equal(await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), undefined);
  assert.equal(await session.handleMessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: {} }), undefined);

  assert.deepEqual((await session.handleMessage({ jsonrpc: '2.0', id: 3, method: 'ping' })).result, {});
  const list = await session.handleMessage({ jsonrpc: '2.0', id: 4, method: 'tools/list' });
  assert.deepEqual(list.result.tools.map((tool) => tool.name).sort(), [...TOOL_NAMES].sort());
  for (const tool of list.result.tools) {
    assert.equal(tool.inputSchema.type, 'object', `${tool.name} must declare an object input schema`);
    assert.ok(tool.description && tool.description.length > 20, `${tool.name} needs a description an agent can act on`);
  }

  const unknownMethod = await session.handleMessage({ jsonrpc: '2.0', id: 5, method: 'resources/list' });
  assert.equal(unknownMethod.error.code, JSONRPC_METHOD_NOT_FOUND);
  const batch = await session.handleMessage([initialize(6)]);
  assert.equal(batch.error.code, JSONRPC_INVALID_REQUEST);
  const unknownTool = await session.handleMessage(callToolMessage(7, 'drop_database', {}));
  assert.equal(unknownTool.error.code, JSONRPC_INVALID_PARAMS);
  const badArgs = await session.handleMessage(callToolMessage(8, 'cost_rollup', { period: 'monthly' }));
  assert.equal(badArgs.error.code, JSONRPC_INVALID_PARAMS);
  assert.ok(badArgs.error.data.problems.join(' ').includes('arguments.period'));
});

test('an incomplete CLI answer is a successful tool result, and a broken one is not', async () => {
  const runWith = (outcome) => createMcpSession({ runtime: 'mcode', version: '0.6.0', runner: async () => outcome });

  const incomplete = await runWith({ code: 2, stdout: 'cost: unavailable (3 of 40 calls unpriced)\n', stderr: 'note\n' });
  await incomplete.handleMessage(initialize(1));
  const partial = await incomplete.handleMessage(callToolMessage(2, 'session_cost', {}));
  assert.equal(partial.result.isError, false, 'exit 2 means "incomplete", not "failed"');
  assert.match(partial.result.content[0].text, /unavailable/);
  assert.equal(partial.result._meta['session-cost'].coverage, 'incomplete');

  const complete = await runWith({ code: 0, stdout: 'cost: $0.0005\n', stderr: '' });
  await complete.handleMessage(initialize(1));
  const ok = await complete.handleMessage(callToolMessage(2, 'session_cost', {}));
  assert.equal(ok.result.isError, false);
  assert.equal(ok.result._meta['session-cost'].coverage, 'complete');

  // A usage error prints to stderr and writes no stdout: that must not look like an empty answer.
  const broken = await runWith({ code: 2, stdout: '', stderr: 'session-cost: --list expects a whole number\n' });
  await broken.handleMessage(initialize(1));
  const failed = await broken.handleMessage(callToolMessage(2, 'list_sessions', {}));
  assert.equal(failed.result.isError, true);
  assert.match(failed.result.content[0].text, /expects a whole number/);

  const crashed = await runWith({ code: 1, stdout: '', stderr: 'session-cost: unexpected failure: boom\n' });
  await crashed.handleMessage(initialize(1));
  assert.equal((await crashed.handleMessage(callToolMessage(2, 'session_cost', {}))).result.isError, true);

  // A runtime with no rate table says so instead of answering with an empty coverage object.
  const noRates = createMcpSession({ runtime: 'cline', version: '0.6.0', rateCoverage: false, runner: async () => ({ code: 0, stdout: 'should not be used\n', stderr: '' }) });
  await noRates.handleMessage(initialize(1));
  const coverage = await noRates.handleMessage(callToolMessage(2, 'rate_coverage', {}));
  assert.equal(coverage.result.isError, false);
  assert.match(coverage.result.content[0].text, /no rate table/);
  assert.equal(coverage.result._meta['session-cost'].rateCoverage, 'not-applicable');
});

test('a real Cline server answers over stdio, and its figure is the CLI figure', async () => {
  const fixture = createClineFixture({ base: Date.parse(FIXTURE_EPOCH) });
  const dataDir = fixture.dataDir ?? fixture.dir ?? fixture;
  const before = fs.readdirSync(dataDir).sort();

  const server = openServer(clineScript, ['--data-dir', dataDir]);
  server.send(initialize(1));
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  server.send(callToolMessage(3, 'session_cost', { selection: 'last' }));
  server.send(callToolMessage(4, 'list_sessions', { count: 3 }));
  server.send(callToolMessage(5, 'cost_rollup', { period: 'daily', count: 5 }));
  server.send(callToolMessage(6, 'explain_cost', { selection: 'last' }));
  server.send(callToolMessage(7, 'rate_coverage', {}));
  const { code, stdout, stderr } = await (async () => { server.close(); return server.done; })();

  assert.equal(code, 0, `the server must exit cleanly when stdin ends:\n${stderr}`);
  assert.doesNotMatch(stderr, /Unhandled|internal error/, `stderr must not carry a crash:\n${stderr}`);

  // Nothing but protocol messages on stdout, and one answer per request that had an id.
  const lines = stdout.split('\n').filter((line) => line !== '');
  const messages = lines.map((line, index) => {
    try {
      return JSON.parse(line);
    } catch {
      assert.fail(`stdout line ${index + 1} is not JSON, which would break the client's stream: ${JSON.stringify(line)}`);
    }
  });
  const byId = new Map(messages.map((message) => [message.id, message]));
  assert.deepEqual([...byId.keys()].sort(), [1, 2, 3, 4, 5, 6, 7], 'one response per request id, and none for the notification');
  for (const message of messages) assert.equal(message.jsonrpc, '2.0');

  // The parity that makes this trustworthy: the tool text is the CLI's own bytes.
  const cli = runCli(clineScript, dataDir, ['--last', '--brief'], { SESSION_COST_NOW: FIXTURE_EPOCH });
  assert.equal(byId.get(3).result.content[0].text, cli.stdout.trim());
  assert.equal(byId.get(3).result.isError, false);

  const listed = byId.get(4).result.content[0].text;
  assert.match(listed, /cline-/, 'list_sessions returns the fixture sessions');
  assert.match(byId.get(5).result.content[0].text, /total|period/i);
  assert.match(byId.get(6).result.content[0].text, /\$|unavailable|rate/i);

  const coverage = byId.get(7).result;
  assert.equal(coverage.isError, false, 'no rate table is not an error');
  assert.match(coverage.content[0].text, /records cost in its own ledger/);
  assert.equal(coverage._meta['session-cost'].rateCoverage, 'not-applicable');

  assert.deepEqual(fs.readdirSync(dataDir).sort(), before, 'a read-only server must not write into the data directory');
});

test('a real MCode server prices from its rate table and reports coverage as JSON', async () => {
  const fixture = createMCodeFixture({ base: Date.parse(FIXTURE_EPOCH) });
  const dataDir = fixture.dataDir ?? fixture.dir ?? fixture;

  const server = openServer(mcodeScript, ['--data-dir', dataDir]);
  server.send(initialize(1));
  server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
  server.send(callToolMessage(2, 'session_cost', { selection: 'last', format: 'brief-json' }));
  server.send(callToolMessage(3, 'rate_coverage', {}));
  server.close();
  const { code, stdout, stderr } = await server.done;

  assert.equal(code, 0, `the server must exit cleanly:\n${stderr}`);
  const byId = new Map(stdout.split('\n').filter(Boolean).map((line) => JSON.parse(line)).map((message) => [message.id, message]));
  assert.equal(byId.get(1).result.serverInfo.name, MCP_SERVER_NAME);

  const brief = JSON.parse(byId.get(2).result.content[0].text);
  assert.ok(brief && typeof brief === 'object', 'brief-json is JSON an agent can read');
  assert.equal(byId.get(2).result.isError, false);

  const coverage = JSON.parse(byId.get(3).result.content[0].text);
  assert.ok(coverage.rates?.coverage, 'rate_coverage answers with the rate table\'s own coverage');
  assert.ok(coverage.rates.providers && Object.keys(coverage.rates.providers).length > 0);
});

test('a client that hangs up mid-session is not a crash', async () => {
  const fixture = createClineFixture({ base: Date.parse(FIXTURE_EPOCH) });
  const dataDir = fixture.dataDir ?? fixture.dir ?? fixture;
  const child = spawn(process.execPath, [clineScript, '--mcp', '--data-dir', dataDir], {
    env: { ...process.env, SESSION_COST_NOW: FIXTURE_EPOCH },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const closed = new Promise((resolve) => child.on('close', (code) => resolve(code)));
  child.stdin.write(`${JSON.stringify(initialize(1))}\n`);
  child.stdin.write(`${JSON.stringify(callToolMessage(2, 'session_cost', { selection: 'last' }))}\n`);
  // Read one message, then hang up the way an editor does when it restarts the server.
  await new Promise((resolve) => child.stdout.once('data', resolve));
  child.stdout.destroy();
  child.stdin.end();
  const code = await closed;
  assert.doesNotMatch(stderr, /Unhandled 'error' event|EPIPE/, 'a closed pipe is the normal end of a session');
  assert.ok(code === 0 || code === null, `a client hang-up exits quietly, got ${code}`);
});

test('a session id that looks like a flag is refused, not passed to the child', async () => {
  // The session id is caller-controlled. If it reached the child as a flag, an agent could ask for
  // --refresh-rates by naming a session that, which would turn a tool documented as read-only into
  // a network call and a write.
  const session = createMcpSession({ runtime: 'mcode', version: '0.6.0', runner: async () => ({ code: 0, stdout: 'x\n', stderr: '' }) });
  await session.handleMessage(initialize(1));
  const response = await session.handleMessage(callToolMessage(2, 'session_cost', { session: '--refresh-rates' }));
  assert.equal(response.error.code, JSONRPC_INVALID_PARAMS);
  assert.match(response.error.data.problems.join(" "), /must match/);
});
