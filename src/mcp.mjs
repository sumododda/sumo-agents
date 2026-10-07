import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { delimiter, dirname, join } from 'node:path';
import { UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { redact } from './redact.mjs';
import { capRedacted, childEnv, killGroup, trackGroup } from './tools.mjs';

/**
 * MCP servers: the user names them in ~/.sumo-agents/mcp.json — the shape
 * Claude Code uses, a `command` with `args` and `env`, or a `url` with
 * `headers`; `${NAME}` in a value is filled from the shell, so no token is ever
 * in the file — and every chat and job in this process reaches them through
 * one registry, connected once. Their tools go to the model deferred, behind
 * Anthropic's tool search, so none of their schemas sits in the cached prefix.
 * Every call is held to an allow list: a tool not on it asks the user, and the
 * user's "always" is written back to the file. Two transports, written here
 * rather than taken from the MCP SDK and its seventeen dependencies: stdio, a
 * line of JSON each way with a child process, and streamable HTTP.
 */

/** Anthropic's tool search, GA on every model Sumo runs: the one tool through which the deferred ones are found. */
export const TOOL_SEARCH = { type: 'tool_search_tool_regex_20251119', name: 'tool_search_tool_regex' };
const PREFIX = 'mcp__';
const SEP = '__';
const PROTOCOL_VERSION = '2025-06-18';
const CLIENT = { name: 'sumo-agents', version: '1' };
/** An `npx` server is fetched the first time: the handshake gets longer than a call. */
const CONNECT_TIMEOUT_MS = 60_000;
const CALL_TIMEOUT_MS = 120_000;
const NOTIFY_TIMEOUT_MS = 10_000;
/** A server name: part of every tool's name on the wire, which the API holds to letters, digits, _ and -. */
const NAME = /^[A-Za-z0-9_-]+$/;
const MAX_TOOL_NAME = 128;
const MAX_DESCRIPTION = 4_000;
const STDERR_KEPT = 2_000;
/** How long a closed stdio server is given to leave on its own before its group is killed. */
const CLOSE_GRACE_MS = 1_000;
/** What a call is shown as on the screen: this much of its input. */
const INPUT_SHOWN = 100;

export const DECLINED = 'not run: the user declined this call. Do not call it again; ask the user, or carry on another way.';

export const isMcpTool = (name) => typeof name === 'string' && name.startsWith(PREFIX);
export const configFile = () => join(paths().home, 'mcp.json');

/** The server and tool a name on the wire stands for, as far as the name itself says; the registry knows for sure. */
export function splitMcpName(name) {
  const rest = String(name).slice(PREFIX.length);
  const at = rest.indexOf(SEP);
  return at === -1 ? { server: rest, tool: '' } : { server: rest.slice(0, at), tool: rest.slice(at + SEP.length) };
}

/** A call's input in one line, cut where the screen would stop reading it. */
export function compactInput(input, max = INPUT_SHOWN) {
  const text = JSON.stringify(input ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** The configuration as written: `{ mcpServers: { <name>: spec } }`; none is no servers, and a file that is not JSON is an error that names it. */
export function readConfig() {
  const file = configFile();
  if (!existsSync(file)) return { mcpServers: {} };
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    throw new UsageError(`${file} is not valid JSON: ${cause.message.split('\n')[0]}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new UsageError(`${file} should hold an object with "mcpServers" in it`);
  const servers = parsed.mcpServers ?? {};
  if (!servers || typeof servers !== 'object' || Array.isArray(servers)) throw new UsageError(`"mcpServers" in ${file} should be an object: a server per name`);
  return { ...parsed, mcpServers: servers };
}

/** Written whole and then put in place, private: the file carries the allow list, and a run that dies half-way must not leave half of it. */
export function writeConfig(config) {
  const file = configFile();
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const staged = `${file}.${process.pid}.tmp`;
  writeFileSync(staged, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  renameSync(staged, file);
}

/** `${NAME}` in a configured value, filled from the environment. One nothing fills is refused: a server must not start with a blank where its token should be. */
export function expand(value, env = process.env) {
  return String(value).replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_, name) => {
    if (env[name] === undefined) throw new UsageError(`\${${name}} is not set in the environment`);
    return env[name];
  });
}

/**
 * What a stdio server runs with: the user's environment without Sumo's own credential, the node that runs Sumo
 * first on PATH (so `npx` beside it is the one found), and the entries the configuration names, filled from the shell.
 */
export function serverEnv(spec, env = process.env) {
  const base = childEnv(env);
  const nodeBin = dirname(process.execPath);
  const path = [nodeBin, ...(base.PATH ?? '').split(delimiter).filter((d) => d && d !== nodeBin)].join(delimiter);
  const given = Object.fromEntries(Object.entries(spec.env ?? {}).map(([k, v]) => [k, expand(v, env)]));
  return { ...base, PATH: path, ...given };
}

const serverName = (name) => {
  if (!NAME.test(String(name)) || String(name).includes(SEP)) throw new UsageError(`"${name}" is not a server name — letters, digits, _ and -, and not two underscores together`);
  return String(name);
};

/** A server joins the file; one that is already there is left as it is, so an allow list is never lost to a retyped add. */
export function addServer(name, spec) {
  serverName(name);
  const config = readConfig();
  if (config.mcpServers[name]) throw new UsageError(`${name} is already configured — sumo mcp remove ${name} first`);
  if (!spec.url && !spec.command) throw new UsageError('a server is a command (after --) or a --url');
  config.mcpServers[name] = spec;
  writeConfig(config);
  return spec;
}

export function removeServer(name) {
  const config = readConfig();
  if (!config.mcpServers[name]) throw new UsageError(`no MCP server called ${name} — sumo mcp lists them`);
  delete config.mcpServers[name];
  writeConfig(config);
}

/** Whether a server's configuration lets a tool run without asking: every tool, or that one. */
export function allowedBy(spec, tool) {
  const allow = spec?.allow;
  return allow === 'all' || (Array.isArray(allow) && allow.includes(tool));
}

/** The allow list in the file, changed: one tool, or `all`; off again, one tool or everything. */
export function setAllow(name, tool, on) {
  const config = readConfig();
  const spec = config.mcpServers[name];
  if (!spec) throw new UsageError(`no MCP server called ${name} — sumo mcp lists them`);
  if (tool === 'all') {
    if (on) spec.allow = 'all';
    else delete spec.allow;
  } else {
    const list = Array.isArray(spec.allow) ? spec.allow : [];
    spec.allow = on ? [...new Set([...list, tool])] : list.filter((t) => t !== tool);
  }
  writeConfig(config);
  return spec.allow;
}

/** One MCP tool as the API takes it: named for its server, deferred, its schema an object; none when the name would be too long. */
export function apiTool(server, tool) {
  const name = `${PREFIX}${server}${SEP}${String(tool.name).replace(/[^A-Za-z0-9_-]/g, '_')}`;
  if (name.length > MAX_TOOL_NAME) return null;
  const schema = tool.inputSchema && typeof tool.inputSchema === 'object' && !Array.isArray(tool.inputSchema) ? { ...tool.inputSchema } : {};
  delete schema.$schema;
  if (schema.type === undefined) schema.type = 'object';
  return { name, description: String(tool.description ?? tool.title ?? tool.name).slice(0, MAX_DESCRIPTION), input_schema: schema, defer_loading: true };
}

const bytesOf = (data) => Buffer.byteLength(String(data ?? ''), 'base64');

/** What a call came back with, as text: its text as it is, anything else described; structured content alone as JSON. */
export function resultText(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const parts = blocks.map((b) => {
    if (b.type === 'text') return String(b.text ?? '');
    if (b.type === 'image' || b.type === 'audio') return `[${b.type} ${b.mimeType ?? 'unknown type'}, ${bytesOf(b.data)} bytes]`;
    if (b.type === 'resource_link') return `[resource ${b.uri ?? ''}${b.name ? ` — ${b.name}` : ''}]`;
    if (b.type === 'resource') {
      const r = b.resource ?? {};
      return typeof r.text === 'string' ? r.text : `[resource ${r.uri ?? ''}${r.mimeType ? `, ${r.mimeType}` : ''}${r.blob ? `, ${bytesOf(r.blob)} bytes` : ''}]`;
    }
    return `[${b.type ?? 'unknown'}]`;
  });
  if (parts.length === 0 && result?.structuredContent !== undefined) return JSON.stringify(result.structuredContent);
  return parts.join('\n');
}

const rpcError = (error) => new Error(`${error?.message ?? 'unknown error'}${error?.code !== undefined ? ` (code ${error.code})` : ''}`);

/** The stdio transport: the server a child process, a line of JSON each way; its stderr kept to explain an end. */
function stdioTransport(spec, env) {
  const child = spawn(spec.command, spec.args ?? [], { env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
  if (child.pid) trackGroup(child.pid);
  /** Each request waiting for its answer, by id: settled by the answer, or failed by the end of the server. */
  const pending = new Map();
  let buffer = '';
  let stderr = '';
  let ended = null;
  const over = (why) => {
    if (ended) return;
    ended = why;
    for (const wait of [...pending.values()]) wait.fail(new Error(why));
    pending.clear();
  };
  const send = (message) => {
    if (ended) throw new Error(ended);
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  function deliver(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return;
    if (message.method === undefined) return pending.get(message.id)?.settle(message);
    // A request from the server: nothing here answers one, and it is told so rather than left waiting.
    try {
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: 'not supported by this client' } });
    } catch {
      // Over already.
    }
  }
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, at).trim();
      buffer = buffer.slice(at + 1);
      if (line) deliver(line);
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr = (stderr + chunk).slice(-STDERR_KEPT);
  });
  child.stdin.on('error', () => {});
  child.on('error', (cause) => over(`could not start ${spec.command}: ${cause.message}`));
  child.on('exit', (code, signal) => over(`the server exited (${code ?? signal})${stderr.trim() ? `: ${stderr.trim()}` : ''}`));
  return {
    get ended() {
      return ended;
    },
    setVersion() {},
    /** Answered, failed, out of time, or interrupted — whichever is first; the rest is let go. */
    request(message, { signal = null, timeoutMs }) {
      return new Promise((resolve, reject) => {
        if (ended) return reject(new Error(ended));
        const done = (fn) => (value) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', stop);
          pending.delete(message.id);
          fn(value);
        };
        const fail = done(reject);
        const stop = () => fail(new Error('interrupted by the user'));
        const timer = setTimeout(() => fail(new Error(`did not answer within ${timeoutMs} ms`)), timeoutMs);
        pending.set(message.id, { settle: done(resolve), fail });
        if (signal?.aborted) return stop();
        signal?.addEventListener('abort', stop, { once: true });
        send(message);
      });
    },
    async notify(message) {
      send(message);
    },
    async close() {
      ended ??= 'closed';
      child.stdin.end();
      setTimeout(() => killGroup(child.pid), CLOSE_GRACE_MS).unref();
    },
  };
}

/** The messages of an SSE stream, until the answer to `id` comes; the rest of the stream is let go with it. */
async function readSse(body, id) {
  const decoder = new TextDecoder();
  let buffer = '';
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    let at;
    while ((at = buffer.indexOf('\n\n')) !== -1) {
      const data = buffer
        .slice(0, at)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trim())
        .join('\n');
      buffer = buffer.slice(at + 2);
      if (!data) continue;
      let message;
      try {
        message = JSON.parse(data);
      } catch {
        continue;
      }
      if (message.id === id && message.method === undefined) return message;
    }
  }
  throw new Error('the stream ended without an answer');
}

/** The streamable-HTTP transport: every message a POST, the answer JSON or a stream, the session the server gave carried on every request after the first. */
function httpTransport(spec, env) {
  const url = expand(spec.url, env);
  const headers = Object.fromEntries(Object.entries(spec.headers ?? {}).map(([k, v]) => [k, expand(v, env)]));
  let sessionId = null;
  let version = null;
  let ended = null;
  const session = () => ({ ...(sessionId ? { 'mcp-session-id': sessionId } : {}), ...(version ? { 'mcp-protocol-version': version } : {}) });
  async function post(message, { signal = null, timeoutMs }) {
    if (ended) throw new Error(ended);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { ...headers, ...session(), 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
        body: JSON.stringify(message),
        signal: AbortSignal.any([AbortSignal.timeout(timeoutMs), ...(signal ? [signal] : [])]),
      });
    } catch (cause) {
      if (signal?.aborted) throw new Error('interrupted by the user');
      if (cause.name === 'TimeoutError' || cause.name === 'AbortError') throw new Error(`did not answer within ${timeoutMs} ms`);
      throw new Error(`could not reach ${url}: ${cause.cause?.message ?? cause.message}`);
    }
    const given = res.headers.get('mcp-session-id');
    if (given) sessionId = given;
    // The server has forgotten the session: this transport is over, and the next call starts another.
    if (res.status === 404 && sessionId && message.method !== 'initialize') {
      ended = 'the server forgot the session';
      throw Object.assign(new Error(ended), { lost: true });
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).trim();
      throw new Error(`HTTP ${res.status} from ${url}${body ? `: ${body.slice(0, 200)}` : ''}`);
    }
    if (message.id === undefined) return null;
    if ((res.headers.get('content-type') ?? '').includes('text/event-stream')) return readSse(res.body, message.id);
    const text = await res.text();
    return text.trim() ? JSON.parse(text) : null;
  }
  return {
    get ended() {
      return ended;
    },
    setVersion(v) {
      version = v;
    },
    request: (message, options) => post(message, options),
    notify: (message) => post(message, { timeoutMs: NOTIFY_TIMEOUT_MS }),
    async close() {
      ended ??= 'closed';
      if (!sessionId) return;
      await fetch(url, { method: 'DELETE', headers: { ...headers, ...session() }, signal: AbortSignal.timeout(NOTIFY_TIMEOUT_MS) }).catch(() => {});
    },
  };
}

/**
 * One server, connected: the handshake done, every page of its tools read. `call` makes one tool call and returns
 * what the server answered, as it answered it — a tool that failed says so in the result, a protocol error throws.
 * `alive` goes false when the transport is over; the registry starts another in its place.
 */
export async function connect(name, spec, { env = process.env, timeoutMs } = {}) {
  serverName(name);
  if (!spec?.url && !spec?.command) throw new UsageError(`${name} has neither "command" nor "url"`);
  const callLimit = timeoutMs ?? spec.timeout ?? CALL_TIMEOUT_MS;
  const connectLimit = timeoutMs ?? spec.timeout ?? CONNECT_TIMEOUT_MS;
  const transport = spec.url ? httpTransport(spec, env) : stdioTransport(spec, serverEnv(spec, env));
  let nextId = 1;
  const ask = async (method, params, { signal = null, timeoutMs: limit = callLimit } = {}) => {
    const answer = await transport.request({ jsonrpc: '2.0', id: nextId++, method, params }, { signal, timeoutMs: limit });
    if (!answer) throw new Error(`no answer to ${method}`);
    if (answer.error) throw rpcError(answer.error);
    return answer.result ?? {};
  };
  try {
    const init = await ask('initialize', { protocolVersion: PROTOCOL_VERSION, capabilities: {}, clientInfo: CLIENT }, { timeoutMs: connectLimit });
    transport.setVersion(typeof init.protocolVersion === 'string' ? init.protocolVersion : PROTOCOL_VERSION);
    await transport.notify({ jsonrpc: '2.0', method: 'notifications/initialized' });
    const tools = [];
    let cursor;
    do {
      const page = await ask('tools/list', cursor ? { cursor } : {}, { timeoutMs: connectLimit });
      tools.push(...(Array.isArray(page.tools) ? page.tools : []));
      cursor = typeof page.nextCursor === 'string' && page.nextCursor ? page.nextCursor : null;
    } while (cursor);
    return {
      name,
      spec,
      tools,
      get alive() {
        return !transport.ended;
      },
      call: (tool, args, { signal = null } = {}) => ask('tools/call', { name: tool, arguments: args ?? {} }, { signal }),
      close: () => transport.close(),
    };
  } catch (cause) {
    await transport.close();
    throw cause;
  }
}

/** The one registry of this process: every configured server, connected at once, the first time anything asks. */
let current = null;

export async function mcpReady() {
  const home = paths().home;
  if (current?.home === home) return current.promise;
  const entry = { home, promise: null, registry: null };
  current = entry;
  entry.promise = buildRegistry().then((registry) => {
    entry.registry = registry;
    return registry;
  });
  return entry.promise;
}

/** The registry, once it is connected; null before that, and in a process that never asked for it. */
export const mcpNow = () => (current?.home === paths().home ? current.registry : null);

export async function closeMcp() {
  const entry = current;
  current = null;
  if (!entry) return;
  const registry = await entry.promise.catch(() => null);
  await registry?.close();
}

async function buildRegistry() {
  let config = { mcpServers: {} };
  let error = null;
  try {
    config = readConfig();
  } catch (cause) {
    error = cause.message;
  }
  const names = Object.keys(config.mcpServers);
  const sessions = new Map();
  const failures = new Map();
  const open = async (name) => {
    const session = await connect(name, config.mcpServers[name]);
    sessions.set(name, session);
    failures.delete(name);
    return session;
  };
  await Promise.all(
    names.map(async (name) => {
      try {
        await open(name);
      } catch (cause) {
        failures.set(name, cause.message);
      }
    }),
  );
  /** Each tool as the API sees it, and which server's which it is. */
  const targets = new Map();
  const tools = [];
  for (const name of names) {
    for (const tool of sessions.get(name)?.tools ?? []) {
      const def = apiTool(name, tool);
      if (!def || targets.has(def.name)) continue;
      targets.set(def.name, { server: name, tool: tool.name });
      tools.push(def);
    }
  }
  tools.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));

  const failed = (message) => ({ content: redact(`mcp ${message}`).text, isError: true });
  /** The answer to a name no tool here goes by: the server is not connected, or has no such tool. */
  const missing = (apiName) => {
    const { server } = splitMcpName(apiName);
    return sessions.has(server) ? failed(`no tool called ${apiName}`) : failed(`${server} is not connected${failures.has(server) ? `: ${failures.get(server)}` : ''}`);
  };
  /** The spec as the file says it now: the allow list may have been edited since the servers were connected. */
  const specOf = (server) => {
    try {
      return readConfig().mcpServers[server] ?? config.mcpServers[server];
    } catch {
      return config.mcpServers[server];
    }
  };

  return {
    error,
    tools: () => tools,
    get hasTools() {
      return tools.length > 0;
    },
    /** Each server as the file says it now — its allow list may have changed since it connected — and how connecting went. */
    servers: () => names.map((name) => ({ name, spec: specOf(name), transport: config.mcpServers[name].url ? 'http' : 'stdio', ok: sessions.has(name), error: failures.get(name) ?? null, tools: sessions.get(name)?.tools.length ?? 0 })),
    targetOf: (apiName) => targets.get(apiName) ?? null,
    missing,
    /** One line for the system prompt: which servers there are, how to find their tools, and that a call may be refused. */
    describe() {
      if (tools.length === 0) return '';
      const count = (name) => sessions.get(name)?.tools.length ?? 0;
      const listed = names.filter((n) => count(n) > 0).map((n) => `${n} (${count(n)} tool${count(n) === 1 ? '' : 's'})`);
      return `Tools from MCP servers, found with ${TOOL_SEARCH.name} (their names start with ${PREFIX}<server>${SEP}): ${listed.join(', ')}. A call may need the user's approval first; one they decline is final — do not call it again.`;
    },
    allowed: (apiName) => {
      const target = targets.get(apiName);
      return Boolean(target) && allowedBy(specOf(target.server), target.tool);
    },
    allow(apiName) {
      const target = targets.get(apiName);
      if (target) setAllow(target.server, target.tool, true);
    },
    /** One call, answered the way every tool answers: text without secrets, capped; a failure is an error the model can read. */
    async call(apiName, input, { signal = null } = {}) {
      const target = targets.get(apiName);
      if (!target) return missing(apiName);
      const make = (session) => session.call(target.tool, input ?? {}, { signal });
      try {
        const session = sessions.get(target.server);
        // A server that is gone is started again; one that forgot the session before the call ran is given a new one.
        const result = await make(session.alive ? session : await open(target.server)).catch(async (cause) => {
          if (!cause.lost) throw cause;
          return make(await open(target.server));
        });
        return { content: capRedacted(resultText(result)), isError: Boolean(result?.isError) };
      } catch (cause) {
        return failed(`${target.server}: ${cause.message}`);
      }
    },
    async close() {
      await Promise.all([...sessions.values()].map((s) => s.close().catch(() => {})));
      sessions.clear();
    },
  };
}

const NOT_CONNECTED = () => ({ content: 'mcp: no server is connected', isError: true });

/** The loop's way in: one MCP call, on the registry of this process. */
export async function runMcpTool(call, { signal = null } = {}) {
  const registry = mcpNow();
  return registry ? registry.call(call.name, call.input ?? {}, { signal }) : NOT_CONNECTED();
}

const aborted = (signal) =>
  new Promise((resolve) => {
    if (!signal) return;
    if (signal.aborted) resolve('no');
    else signal.addEventListener('abort', () => resolve('no'), { once: true });
  });

/**
 * The allow list, before a call: a tool on it passes; one not on it is put to the user — `approve` answers `once`,
 * `always` or `no` — and `always` is written to the file. Nobody to ask is a refusal that says how to allow it. Null
 * lets the call run; anything else is the result it gets instead.
 */
export async function gateMcp(call, { approve = null, signal = null, job = null } = {}) {
  const registry = mcpNow();
  if (!registry) return NOT_CONNECTED();
  const target = registry.targetOf(call.name);
  if (!target) return registry.missing(call.name);
  if (registry.allowed(call.name)) return null;
  if (!approve) return { content: `not run: ${call.name} needs the user's approval, and nobody is here to ask. The user allows it with: sumo mcp allow ${target.server} ${target.tool}`, isError: true };
  const answer = await Promise.race([approve({ name: call.name, server: target.server, tool: target.tool, input: call.input ?? {}, job, signal }), aborted(signal)]);
  if (signal?.aborted) return { content: DECLINED, isError: true };
  if (answer === 'always') registry.allow(call.name);
  if (answer === 'always' || answer === 'once') return null;
  return { content: DECLINED, isError: true };
}

/** What `sumo mcp` prints: each server, where it is and what it is given (names, never values), its tools or why it failed, and what may run unasked. */
export function mcpLines(registry) {
  if (registry.error) throw new UsageError(registry.error);
  const servers = registry.servers();
  if (servers.length === 0) return ['no MCP servers configured — sumo mcp add <name> -- <command> [args…]   (or: sumo mcp add <name> --url <url>)'];
  const wide = Math.max(...servers.map((s) => s.name.length)) + 2;
  return servers.flatMap((s) => {
    const { spec } = s;
    const where = spec.url ? `http: ${spec.url}` : `stdio: ${[spec.command, ...(spec.args ?? [])].join(' ')}`;
    const given = Object.keys((spec.url ? spec.headers : spec.env) ?? {});
    const allowed = spec.allow === 'all' ? 'all' : Array.isArray(spec.allow) && spec.allow.length > 0 ? spec.allow.join(', ') : 'none';
    const state = s.ok ? `${s.tools} tool${s.tools === 1 ? '' : 's'} · allowed: ${allowed}` : `failed: ${s.error}`;
    return [redact(`${s.name.padEnd(wide)}${where}${given.length > 0 ? `   ${spec.url ? 'headers' : 'env'}: ${given.join(', ')}` : ''}`).text, `${''.padEnd(wide)}${redact(state).text}`];
  });
}
