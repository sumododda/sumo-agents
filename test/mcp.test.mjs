// MCP servers: the configuration that names them, the two transports that reach them, what their tools look like to
// the model, the allow list every call is held to, and the `sumo mcp` commands that manage all of it.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { describeCall } from '../src/chat.mjs';
import { allowedBy, closeMcp, connect, DECLINED, gateMcp, isMcpTool, mcpReady, readConfig, setAllow, TOOL_SEARCH, writeConfig } from '../src/mcp.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { toolView } from '../src/tty.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const FIXTURE = join(REPO_ROOT, 'test', 'fixtures', 'fake-mcp-server.mjs');
/** The fake server over stdio, with whatever else the spec needs. */
const stdioSpec = (extra = {}) => ({ command: process.execPath, args: [FIXTURE], ...extra });
const ALL_TOOLS = ['die', 'echo', 'env', 'flood', 'hang', 'leak', 'picture', 'shout', 'structured'];

/** Writes ~/.sumo-agents/mcp.json for the home in hand. */
function configure(servers) {
  mkdirSync(paths().home, { recursive: true, mode: 0o700 });
  writeConfig({ mcpServers: servers });
}

test('a stdio server: the handshake, every page of its tools, and each shape of answer a call can come back with', async () => {
  const session = await connect('demo', stdioSpec());
  try {
    assert.deepEqual(session.tools.map((t) => t.name).sort(), ALL_TOOLS, 'both pages of the list were read');
    assert.equal((await session.call('echo', { text: 'hi' })).content[0].text, 'you said: hi');
    const shout = await session.call('shout', {});
    assert.equal(shout.isError, true);
    await assert.rejects(session.call('nothing', {}), /Unknown tool: nothing/, 'a protocol error is an error');
  } finally {
    await session.close();
  }
});

test('a stdio server is given the environment the configuration names, expanded from the shell, and never a credential of the chat\'s', async () => {
  const env = { ...process.env, DEMO_SECRET: 's3cr3t', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' };
  const session = await connect('demo', stdioSpec({ env: { DEMO_TOKEN: 'token ${DEMO_SECRET}' } }), { env });
  try {
    const seen = JSON.parse((await session.call('env', { names: ['DEMO_TOKEN', 'ANTHROPIC_API_KEY', 'PATH'] })).content[0].text);
    assert.equal(seen.DEMO_TOKEN, 'token s3cr3t', 'the value comes from the environment, through the placeholder');
    assert.equal(seen.ANTHROPIC_API_KEY, null, 'the chat\'s own credential never reaches a server');
    assert.ok(seen.PATH, 'a server can find its tools');
  } finally {
    await session.close();
  }
  await assert.rejects(connect('demo', stdioSpec({ env: { T: '${NOPE_NOT_SET}' } }), { env: { PATH: process.env.PATH } }), /NOPE_NOT_SET\} is not set/, 'a placeholder nothing fills is said, not passed on empty');
});

test('a server that cannot start, one that never answers, and one that dies mid-call each say so; a call can be stopped by the user', async () => {
  await assert.rejects(connect('nope', { command: '/no/such/server' }), /ENOENT|no such/i);
  const session = await connect('demo', stdioSpec({ timeout: 300 }));
  try {
    await assert.rejects(session.call('hang', {}), /did not answer within 300 ms/);
    const stopper = new AbortController();
    setTimeout(() => stopper.abort(), 30);
    await assert.rejects(session.call('hang', {}, { signal: stopper.signal }), /interrupted/);
    await assert.rejects(session.call('die', {}), /exited \(3\)[\s\S]*dying as asked/, 'what the server wrote to stderr explains its end');
    assert.equal(session.alive, false);
  } finally {
    await session.close();
  }
});

/** A streamable-HTTP MCP server in this process: JSON for most answers, an SSE stream for a call, a session it can forget. */
function fakeHttpMcp() {
  const seen = [];
  let forgetting = false;
  let sessions = 0;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      seen.push({ method: req.method, headers: req.headers, body: body ? JSON.parse(body) : null });
      if (req.method === 'DELETE') return res.writeHead(200).end();
      const msg = JSON.parse(body);
      const sid = req.headers['mcp-session-id'];
      if (msg.method !== 'initialize' && (forgetting || !sid)) return res.writeHead(404).end('session unknown');
      if (msg.id === undefined) return res.writeHead(202).end();
      const reply = (result, headers = {}) => res.writeHead(200, { 'content-type': 'application/json', ...headers }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result }));
      if (msg.method === 'initialize') {
        forgetting = false;
        return reply({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'web', version: '0' } }, { 'mcp-session-id': `s${++sessions}` });
      }
      if (msg.method === 'tools/list') return reply({ tools: [{ name: 'greet', description: 'Greets by name.', inputSchema: { type: 'object', properties: { name: { type: 'string' } } } }] });
      if (msg.method === 'tools/call') {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        res.write('event: message\ndata: {"jsonrpc":"2.0","method":"notifications/message","params":{"level":"info","data":"working"}}\n\n');
        res.write(`event: message\ndata: ${JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `hello ${msg.params.arguments.name}` }] } })}\n\n`);
        return res.end();
      }
      return res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: 'no' } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${server.address().port}/mcp`, seen, forget: () => (forgetting = true), close: () => new Promise((r) => server.close(r)) });
    });
  });
}

test('a streamable-HTTP server: the session id and protocol version ride on every request after the first, headers are expanded from the environment, an SSE answer is read to the response, and the session is ended on close', async () => {
  const web = await fakeHttpMcp();
  const session = await connect('web', { url: web.url, headers: { Authorization: 'Bearer ${DEMO_SECRET}' } }, { env: { DEMO_SECRET: 'tok' } });
  try {
    assert.deepEqual(session.tools.map((t) => t.name), ['greet']);
    assert.equal((await session.call('greet', { name: 'sumo' })).content[0].text, 'hello sumo');
    const [init, initialized, list, call] = web.seen;
    assert.equal(init.body.method, 'initialize');
    assert.equal(init.headers.authorization, 'Bearer tok');
    assert.match(init.headers.accept, /application\/json/);
    assert.match(init.headers.accept, /text\/event-stream/);
    assert.equal(initialized.body.method, 'notifications/initialized');
    for (const later of [initialized, list, call]) {
      assert.equal(later.headers['mcp-session-id'], 's1');
      assert.equal(later.headers['mcp-protocol-version'], '2025-06-18');
    }
  } finally {
    await session.close();
  }
  assert.equal(web.seen.at(-1).method, 'DELETE', 'the session is ended when the client is done with it');
  assert.equal(web.seen.at(-1).headers['mcp-session-id'], 's1');
  await web.close();
});

test('the registry: every configured server connected at once, a failed one named and the rest usable; tools deferred, sorted, named for the model, schemas made valid; results capped and redacted; a lost session reconnected', async () => {
  const web = await fakeHttpMcp();
  try {
    await withHome(freshHome(), { ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }, async () => {
      configure({ demo: stdioSpec({ timeout: 2000 }), web: { url: web.url }, broken: { command: '/no/such/server' } });
      try {
        const registry = await mcpReady();
        const servers = Object.fromEntries(registry.servers().map((s) => [s.name, s]));
        assert.equal(servers.demo.ok, true);
        assert.equal(servers.demo.tools, ALL_TOOLS.length);
        assert.equal(servers.web.ok, true);
        assert.equal(servers.broken.ok, false);
        assert.match(servers.broken.error, /ENOENT|no such/i);

        const tools = registry.tools();
        assert.deepEqual(tools.map((t) => t.name), [...ALL_TOOLS.map((t) => `mcp__demo__${t}`), 'mcp__web__greet'], 'one API tool per MCP tool, sorted so the request never moves');
        assert.ok(tools.every((t) => t.defer_loading === true), 'none of them sits in the context until the model searches for it');
        const picture = tools.find((t) => t.name === 'mcp__demo__picture');
        assert.equal(picture.input_schema.type, 'object', 'a schema without a type is still an object');
        assert.equal('$schema' in picture.input_schema, false);
        assert.match(picture.description, /A picture and a caption/);
        assert.equal(registry.hasTools, true);
        assert.match(registry.describe(), /demo \(9 tools\)/);
        assert.match(registry.describe(), /web \(1 tool\)/);
        assert.doesNotMatch(registry.describe(), /broken/, 'a server that is not there is the user\'s to see, not the model\'s');
        assert.match(registry.describe(), /tool_search_tool_regex/);

        assert.deepEqual(await registry.call('mcp__demo__echo', { text: 'hi' }), { content: 'you said: hi', isError: false });
        assert.deepEqual(await registry.call('mcp__demo__shout', {}), { content: 'TOO LOUD', isError: true });
        const picture_ = await registry.call('mcp__demo__picture', {});
        assert.match(picture_.content, /\[image image\/png, \d+ bytes\]\na cat\nnotes/, 'what is not text is described; a resource\'s text is shown');
        assert.equal((await registry.call('mcp__demo__structured', {})).content, '{"answer":42}', 'structured content alone is shown as JSON');
        assert.match((await registry.call('mcp__demo__leak', {})).content, /the key is \[redacted\] and that is all/);
        const flood = await registry.call('mcp__demo__flood', {});
        assert.ok(flood.content.length < 17_000, `capped: ${flood.content.length}`);
        assert.match(flood.content, /^S[\s\S]*\[cut \d+ characters from the middle[\s\S]*E$/);
        const unknown = await registry.call('mcp__demo__nothing', {});
        assert.equal(unknown.isError, true);
        assert.match(unknown.content, /no tool called mcp__demo__nothing/);
        const gone = await registry.call('mcp__broken__x', {});
        assert.equal(gone.isError, true);
        assert.match(gone.content, /broken is not connected/);

        // The web server forgets the session: the call is made again on a new one, and the model never knows.
        web.forget();
        assert.equal((await registry.call('mcp__web__greet', { name: 'again' })).content, 'hello again');
        assert.equal(web.seen.filter((r) => r.body?.method === 'initialize').length, 2, 'one new session, taken when the old one was refused');
        // The stdio server dies: that call fails, and the next one finds the server started again.
        const died = await registry.call('mcp__demo__die', {});
        assert.equal(died.isError, true);
        assert.match(died.content, /exited \(3\)/);
        assert.equal((await registry.call('mcp__demo__echo', { text: 'back' })).content, 'you said: back');
      } finally {
        await closeMcp();
      }
    });
  } finally {
    await web.close();
  }
});

test('with nothing configured there are no tools, nothing to describe, and nothing to connect to; a file that is not JSON is a named error, not a crash', async () => {
  await withHome(freshHome(), {}, async () => {
    try {
      const registry = await mcpReady();
      assert.deepEqual(registry.tools(), []);
      assert.equal(registry.hasTools, false);
      assert.equal(registry.describe(), '');
      assert.deepEqual(registry.servers(), []);
      assert.equal(registry.error, null);
    } finally {
      await closeMcp();
    }
  });
  await withHome(freshHome(), {}, async () => {
    mkdirSync(paths().home, { recursive: true });
    writeFileSync(join(paths().home, 'mcp.json'), '{ not json');
    try {
      const registry = await mcpReady();
      assert.match(registry.error, /mcp\.json/);
      assert.deepEqual(registry.tools(), []);
      assert.throws(() => readConfig(), /mcp\.json/);
    } finally {
      await closeMcp();
    }
  });
});

test('the allow list: nothing is allowed until the user says so; a tool, or a whole server; it is kept in the file and read fresh', async () => {
  await withHome(freshHome(), {}, async () => {
    configure({ demo: stdioSpec() });
    try {
      const registry = await mcpReady();
      assert.equal(registry.allowed('mcp__demo__echo'), false);
      registry.allow('mcp__demo__echo');
      assert.equal(registry.allowed('mcp__demo__echo'), true);
      assert.equal(registry.allowed('mcp__demo__shout'), false);
      assert.deepEqual(readConfig().mcpServers.demo.allow, ['echo'], 'written to the file, for the next session');
      assert.equal(statSync(join(paths().home, 'mcp.json')).mode & 0o777, 0o600);
      // Edited outside the chat meanwhile: what the file says now is what holds.
      setAllow('demo', 'all', true);
      assert.equal(registry.allowed('mcp__demo__shout'), true);
      setAllow('demo', 'all', false);
      assert.equal(registry.allowed('mcp__demo__shout'), false);
      assert.equal(registry.allowed('mcp__demo__echo'), false, 'revoking the server revokes every tool of it');
      setAllow('demo', 'echo', true);
      setAllow('demo', 'echo', false);
      assert.deepEqual(readConfig().mcpServers.demo.allow, []);
      assert.equal(allowedBy({ allow: 'all' }, 'anything'), true);
      assert.equal(allowedBy({}, 'anything'), false);
      assert.throws(() => setAllow('nowhere', 'x', true), /no MCP server called nowhere/);
    } finally {
      await closeMcp();
    }
  });
});

test('the gate: an allowed tool passes; one that is not asks the user once, and their answer holds — for the call, for good, or not at all; nobody to ask is a refusal that says how to allow it', async () => {
  await withHome(freshHome(), {}, async () => {
    configure({ demo: stdioSpec() });
    try {
      await mcpReady();
      const call = { type: 'tool_use', id: 't1', name: 'mcp__demo__echo', input: { text: 'hi' } };
      const nobody = await gateMcp(call);
      assert.equal(nobody.isError, true);
      assert.match(nobody.content, /mcp__demo__echo needs the user's approval[\s\S]*sumo mcp allow demo echo/);

      const asked = [];
      const approve = (answer) => async (ask) => {
        asked.push(ask);
        return answer;
      };
      assert.equal(await gateMcp(call, { approve: approve('once'), job: 7 }), null, 'allowed for this call');
      const { name, server, tool, input, job } = asked[0];
      assert.deepEqual({ name, server, tool, input, job }, { name: 'mcp__demo__echo', server: 'demo', tool: 'echo', input: { text: 'hi' }, job: 7 });
      assert.equal(readConfig().mcpServers.demo.allow, undefined, 'once is not kept');
      const declined = await gateMcp(call, { approve: approve('no') });
      assert.equal(declined.isError, true);
      assert.equal(declined.content, DECLINED);
      assert.equal(await gateMcp(call, { approve: approve('always') }), null);
      assert.deepEqual(readConfig().mcpServers.demo.allow, ['echo'], 'always is kept');
      asked.length = 0;
      assert.equal(await gateMcp(call, { approve: approve('no') }), null, 'an allowed tool is not asked about again');
      assert.equal(asked.length, 0);

      // Esc while the question stands: the answer is no, and nothing waits on the user.
      const stopper = new AbortController();
      const hanging = gateMcp({ ...call, name: 'mcp__demo__shout', input: {} }, { approve: () => new Promise(() => {}), signal: stopper.signal });
      stopper.abort();
      assert.equal((await hanging).isError, true);
      const unknown = await gateMcp({ ...call, name: 'mcp__nowhere__x' }, { approve: approve('once') });
      assert.equal(unknown.isError, true);
      assert.match(unknown.content, /nowhere is not connected/);
    } finally {
      await closeMcp();
    }
  });
});

test('an MCP call on the screen: the server and the tool with what it was given, and what came back under it', () => {
  const call = { type: 'tool_use', id: 't1', name: 'mcp__slack__post_message', input: { channel: '#dev', text: 'deploy done' } };
  assert.equal(isMcpTool(call.name), true);
  assert.equal(isMcpTool('bash'), false);
  assert.equal(describeCall(call), 'slack · post_message({"channel":"#dev","text":"deploy done"})');
  const view = toolView(call, { content: 'ok\nposted', isError: false });
  assert.equal(view.title, 'slack');
  assert.equal(view.detail, 'post_message({"channel":"#dev","text":"deploy done"})');
  assert.deepEqual(view.lines.map((l) => l.text), ['ok', 'posted']);
  const long = toolView({ ...call, input: { text: 'x'.repeat(300) } });
  assert.ok(long.detail.length < 140, 'a long input is cut on the screen');
  assert.deepEqual(TOOL_SEARCH, { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' });
});

test('sumo mcp: servers are added without their secrets, listed with their tools or why they failed, allowed, and removed', () => {
  const s = sandbox();
  const run = (args, extra) => {
    const r = s.sumo(['mcp', ...args], extra);
    return { ...r, text: r.out + r.err };
  };
  /** The shell a server starts from, with the token its placeholder names. */
  const secret = { extraEnv: { DEMO_SECRET: 'tok' } };
  assert.match(run([]).out, /no MCP servers configured/);
  assert.match(run([]).out, /sumo mcp add/);

  const added = run(['add', 'demo', '--env', 'DEMO_TOKEN=${DEMO_SECRET}', '--', process.execPath, FIXTURE]);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /added demo/);
  const file = join(s.home, 'mcp.json');
  assert.equal(statSync(file).mode & 0o777, 0o600);
  const stored = JSON.parse(readFileSync(file, 'utf8')).mcpServers.demo;
  assert.deepEqual(stored, { command: process.execPath, args: [FIXTURE], env: { DEMO_TOKEN: '${DEMO_SECRET}' } }, 'the placeholder is stored, never the value');

  const again = run(['add', 'demo', '--', 'x']);
  assert.equal(again.code, 2);
  assert.match(again.err, /demo is already configured/);
  assert.equal(run(['add', 'bad name', '--', 'x']).code, 2);
  assert.equal(run(['add', 'nothing']).code, 2, 'a server needs a command or a URL');
  assert.match(run(['add', 'nothing']).err, /--url|command/);
  const web = run(['add', 'web', '--url', 'http://127.0.0.1:1/mcp', '--header', 'Authorization=Bearer ${DEMO_SECRET}']);
  assert.equal(web.code, 0, web.err);

  const listed = run([], secret);
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /demo\s+stdio: .*fake-mcp-server\.mjs/);
  assert.match(listed.out, /env: DEMO_TOKEN/, 'the names the server is given');
  assert.doesNotMatch(listed.text, /tok\b|DEMO_SECRET\}/, 'never a value');
  assert.match(listed.out, /9 tools · allowed: none/);
  assert.match(listed.out, /web\s+http: http:\/\/127\.0\.0\.1:1\/mcp/);
  assert.match(listed.out, /failed: /);

  const tools = run(['tools', 'demo'], secret);
  assert.equal(tools.code, 0, tools.err);
  assert.match(tools.out, /^\s+echo\s+Says the text back\. Use it to test the connection\./m);
  assert.match(run(['tools', 'nowhere']).err, /no MCP server called nowhere/);

  assert.match(run(['allow', 'demo', 'echo']).out, /demo: echo may run without asking/);
  assert.match(run(['allow', 'demo', 'all']).out, /demo: every tool may run without asking/);
  assert.match(run([], secret).out, /allowed: all/);
  assert.match(run(['revoke', 'demo', 'all']).out, /demo: every call asks first/);
  assert.match(run(['allow', 'demo', 'echo']).out, /echo may run/);
  assert.match(run(['tools', 'demo'], secret).out, /^\s+echo\s+\(allowed\)/m);
  assert.match(run(['revoke', 'demo', 'echo']).out, /demo: echo asks first/);
  assert.equal(run(['allow', 'demo']).code, 2, 'allow needs a tool, or all');

  assert.match(run(['remove', 'web']).out, /removed web/);
  assert.match(run(['remove', 'web']).err, /no MCP server called web/);
  assert.doesNotMatch(run([]).out, /web/);
  assert.equal(run(['frobnicate']).code, 2);
  assert.match(s.sumo(['help']).out, /sumo mcp/);
});
