import { randomUUID } from 'node:crypto';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { cursorKeyIn, cursorSelection, modelId } from './catalog.mjs';
import { isMcpTool, runMcpTool } from './mcp.mjs';
import { costOf, logRun, usageOf } from './model.mjs';
import { paths } from './paths.mjs';
import { BASH_TOOL, EDITOR_TOOL, runTool } from './tools.mjs';
import { WEB_FETCH_TOOL, WEB_SEARCH_TOOL } from './web.mjs';

/**
 * A conversation on a Cursor model — a job's, or a chat turn's — through the Cursor SDK. Cursor runs the loop on its own servers and calls back here
 * for every tool: the agent has none of Cursor's own but its web search and fetch where Sumo's are offered, and Sumo's tools — the shell, the editor,
 * the job's tools, the MCP servers — go to it as custom tools that run in this process, through the same gate and the same
 * sandbox as on Claude. Measured on @cursor/sdk 1.4.1 (Nov 18 2026):
 * - `tools` is not kept with the agent: an agent resumed without it had Cursor's own file tools again. Every send here
 *   creates or resumes with it.
 * - A custom system prompt needs Cursor to enable it for the account; Sumo's prompt goes in the first message instead, with
 *   today's date, which the model otherwise guesses — once as a year gone.
 * - Cursor's web search runs on its servers and nothing of it comes back: a run given it is marked as having read the web up front.
 * - A cancel stops the run, but the calls already sent still arrive: each waits its turn and is refused once the job stops.
 * - The SDK sets up Cursor's own shell and file tools in this process whether or not they are offered; only a `local.fs` tree
 *   locks the host out (its filesystem/host-lockout.d.ts). The tree here is empty.
 * - An agent is stored under the folder it was made in (`local.cwd`); a resume from another folder finds nothing. That folder
 *   is one of Sumo's, the same every time (`cursorFolder`), never the project: see there for what the SDK runs in it.
 * - The SDK keeps a fetch of its own in this process, outside any sandbox, that `local.fs` does not lock out and that cannot
 *   be replaced beside it (`resourceProviderOptions` is refused with `fs`): if Cursor's servers ask it for a URL, it is
 *   fetched from here, `shell.network off` or not. Only the tools named to the server (`cursorTools`) say otherwise.
 *   Measured live (Nov 18 2026): Cursor's webFetch runs on Cursor's own isolated server, not through it — asked for
 *   `http://127.0.0.1:<port>` and for `localtest.me` (which resolves to it), a local server here saw no request, and
 *   Cursor answered that its fetch runs from an isolated server and cannot reach localhost.
 * - Each request to the model reports its usage as it ends (`model-call-completed`, through `onDelta`); the stream's `usage`
 *   is the run's sum. The ledger takes a row per request, and the budget and the clock are held after each.
 */

/**
 * Cursor's own tools the agent is given: the custom-tool path Sumo's tools come by, and its web search and fetch only where the
 * request carries Sumo's — the chat's and a scout's, never a worker's or a reviewer's, as on Claude. Nothing else.
 */
const cursorTools = (params) => [
  ...((params.tools ?? []).some((t) => t.name === WEB_SEARCH_TOOL.name) ? ['webSearch'] : []),
  ...((params.tools ?? []).some((t) => t.name === WEB_FETCH_TOOL.name) ? ['webFetch'] : []),
  'mcp',
];

/** What Sumo's two Anthropic-defined tools take, written out for a model that was never told: the bash and editor schemas. */
const BASH_SCHEMA = {
  description: 'Run a shell command in the project folder and get what it printed. The shell keeps its state between calls; restart: true starts a fresh one.',
  inputSchema: { type: 'object', properties: { command: { type: 'string' }, restart: { type: 'boolean' } } },
};
const EDITOR_SCHEMA = {
  description:
    'View or change a file. view: a file with its line numbers (view_range [first, last] for part of it) or a folder\'s files. create: a new file ' +
    'of file_text. str_replace: replace old_str, which must occur exactly once, with new_str. insert: new_str after line insert_line (0 for the top).',
  inputSchema: {
    type: 'object',
    properties: {
      command: { type: 'string', enum: ['view', 'create', 'str_replace', 'insert'] },
      path: { type: 'string' },
      file_text: { type: 'string' },
      old_str: { type: 'string' },
      new_str: { type: 'string' },
      insert_line: { type: 'integer' },
      view_range: { type: 'array', items: { type: 'integer' }, minItems: 2, maxItems: 2 },
    },
    required: ['command', 'path'],
  },
};

/** The request's tools as Cursor takes them, by name: Sumo's own with their schemas; the API's server tools (search, the tool finder, the advisor) are left out. */
function toolsOf(params) {
  const wanted = {};
  for (const tool of params.tools ?? []) {
    if (tool.name === BASH_TOOL.name) wanted[tool.name] = BASH_SCHEMA;
    else if (tool.name === EDITOR_TOOL.name) wanted[tool.name] = EDITOR_SCHEMA;
    else if (tool.input_schema) wanted[tool.name] = { description: tool.description ?? '', inputSchema: tool.input_schema };
  }
  return wanted;
}

/**
 * The model as Cursor takes it: its id, the standard variant, and the effort where the model takes one — the nearest it has at
 * or below the one asked (Grok's top is xhigh), as `cursorSelection` (src/catalog.mjs) reads Discover's listing.
 */
export function cursorModel(model, effort) {
  const selection = cursorSelection(model, effort);
  if (!selection) throw new Error(`${model} is not a Cursor model Sumo knows — API models › Discover, on the settings page (sumo config), lists them again`);
  return selection;
}

/** A message's words: its text blocks, without the tool calls, results and pictures beside them. */
const wordsOf = (m) => (typeof m.content === 'string' ? m.content : m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n\n')).trim();

/**
 * What Cursor is sent of the messages from `from` on. What the user side said since the last send, as it is; where the
 * conversation went on without this agent — the start of a chat that moves to it, turns answered on Claude — it is told what was
 * said on both sides, in words: the tool calls and what came back are not carried over.
 */
function textFrom(messages, from, fresh) {
  const since = messages.slice(from).filter((m) => m.role === 'user' || m.role === 'assistant').filter((m) => wordsOf(m));
  const replied = since.findLastIndex((m) => m.role === 'assistant');
  if (replied === -1) return since.map(wordsOf).join('\n\n');
  const before = since.slice(0, replied + 1).map((m) => `${m.role === 'user' ? 'The user' : 'You'}: ${wordsOf(m)}`);
  const now = since.slice(replied + 1).map(wordsOf);
  const told = fresh ? 'The conversation so far' : 'What was said since you last answered';
  return [`${told}, in words (the tool calls in it are not carried over):\n\n${before.join('\n\n')}`, ...now].join('\n\n');
}

/**
 * Each conversation's Cursor agent: its id, and the last message of the conversation it has been told. Kept beside the request,
 * never in it — the request is what Claude is sent too, and the API refuses a field it does not take. A new conversation is a
 * new request, and so a new agent; one whose history was rewritten under it (the message it knew is gone) is a new agent too,
 * told the conversation whole.
 */
const agents = new WeakMap();

/** A tool's result as Cursor takes it: its words, and a picture as a picture rather than as text. */
const forCursor = (content) =>
  typeof content === 'string'
    ? [{ type: 'text', text: content }]
    : content.map((b) => (b.type === 'image' && b.source?.type === 'base64' ? { type: 'image', data: b.source.data, mimeType: b.source.media_type } : { type: 'text', text: b.text ?? JSON.stringify(b) }));

/** Cursor's usage of one turn in the shape the ledger prices: its input counts what was read from the cache and written to it. */
const anthropicUsage = (u) => ({
  input_tokens: Math.max(0, (u.inputTokens ?? 0) - (u.cacheReadTokens ?? 0) - (u.cacheWriteTokens ?? 0)),
  cache_read_input_tokens: u.cacheReadTokens ?? 0,
  cache_creation_input_tokens: u.cacheWriteTokens ?? 0,
  output_tokens: u.outputTokens ?? 0,
});

/**
 * What went wrong with Cursor, in a line a person can act on. A refused key comes thrown as an AuthenticationError, or as the
 * error a run ended on, which carries only its message and code (`unauthenticated`, the SDK's for a Connect Unauthenticated).
 */
function describeCursorError(cause) {
  const message = String(cause?.message ?? cause).replace(/\s+/g, ' ');
  if (cause?.name === 'AuthenticationError' || cause?.code === 'unauthenticated') return `Cursor refused CURSOR_API_KEY: ${message.slice(0, 200)}`;
  return message.slice(0, 300);
}

/** A folder as it really is on disk (macOS's /tmp is /private/tmp), or as given when it cannot be read. */
function realFolder(path) {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Where Cursor's agents are kept and where the SDK runs what it runs for itself: a folder of Sumo's, the same every time,
 * so an agent is found again whatever folder the conversation is in. After each run the SDK looks for a pull request of
 * that folder's branch — `git rev-parse`, then `gh pr list` and a command named `origin` — found on the PATH and handed
 * this process's environment, keys and all; in a project, a program the shell put on a PATH folder there would be run
 * outside the sandbox. Here there is no repository, and a `.git` that leads nowhere stops git looking above it, so the
 * first step finds no branch and the others never run. The model is told the project's folder (`reportedWorkspacePath`).
 */
function cursorFolder() {
  const dir = join(paths().home, 'cursor');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stop = join(dir, '.git');
  try {
    writeFileSync(stop, 'gitdir: /dev/null/none\n', { mode: 0o600, flag: 'wx' });
  } catch (cause) {
    if (cause.code !== 'EEXIST') throw cause;
  }
  return realFolder(dir);
}

/**
 * @cursor/sdk, set to run its agents' streams over HTTP/1.1 with server-sent events. Left to itself the SDK opens them over
 * HTTP/2, and a network that will not agree to HTTP/2 — a VPN or proxy that drops it in the TLS handshake (ALPN) — ends
 * every Cursor chat, job and Discover try on a session error; HTTP/1.1 goes through. Its other requests (the model list,
 * the key exchange) are HTTP/1.1 already. Loaded only where a model runs or Discover asks, as before. `load` stands in for
 * the import in tests.
 */
export async function loadCursorSdk(load = () => import('@cursor/sdk')) {
  const sdk = await load();
  sdk.configureCursorSdk({ local: { useHttp1ForAgent: true } });
  return sdk;
}

/** The pictures the user put in the messages Cursor is about to be told — those after its last answer — as the SDK takes them on a send. */
const picturesIn = (messages) =>
  messages
    .slice(messages.findLastIndex((m) => m.role === 'assistant') + 1)
    .filter((m) => m.role === 'user' && Array.isArray(m.content))
    .flatMap((m) => m.content.filter((b) => b.type === 'image' && b.source?.type === 'base64').map((b) => ({ data: b.source.data, mimeType: b.source.media_type })));

/**
 * Tries a model once, as Discover does each model Cursor lists: a one-word question to an agent with none of Cursor's tools
 * and an empty tree. `{ ok: true }` when it answers; `{ ok: false, refused }` with Cursor's reason when the run is refused (a
 * model the key's plan leaves out is, at no cost); `{ ok: false, error }` when Cursor could not be asked. What it cost is a
 * ledger row. `sdk` stands in for @cursor/sdk in tests.
 */
export async function tryCursorModel(db, name, { sdk = null, now = () => new Date().toISOString() } = {}) {
  const { Agent, emptyFs } = sdk ?? (await loadCursorSdk());
  const apiKey = cursorKeyIn() ? process.env.CURSOR_API_KEY.trim() : null;
  if (!apiKey) return { ok: false, error: 'no CURSOR_API_KEY in this shell' };
  let agent;
  try {
    agent = await Agent.create({ apiKey, model: cursorModel(name, null), tools: [], local: { cwd: cursorFolder(), fs: emptyFs(), settingSources: [] } });
    const run = await agent.send('Reply with the single word: ok');
    for await (const _ of run.stream());
    const result = await run.wait();
    const ok = result.status !== 'error';
    logRun(db, { kind: 'discover', model: modelId(name), result: { ok, usage: usageOf(modelId(name), result.usage ? anthropicUsage(result.usage) : null) }, note: 'tried by Discover', now: now() });
    return ok ? { ok: true } : { ok: false, refused: describeCursorError(result.error ?? 'the run failed') };
  } catch (cause) {
    return { ok: false, error: describeCursorError(cause) };
  } finally {
    agent?.close?.();
  }
}

/**
 * Runs the job's conversation on Cursor until the model stops, the budget or the clock runs out, or `signal` aborts — and
 * answers as `converse` does (src/loop.mjs): `{ turns, stop, error, text, totals, toldLast }`. Called again on the same
 * `params` (a job told to close), it sends what was added since, to the same agent. Each result is watched as on Claude
 * (`roundWatch`): what `inbox` hands over and the warnings near the budget, the clock and the turn limit ride on it, and the
 * same brakes stop a run that goes round or is declined. The calls `concurrent` picks run beside the others. Nothing the run
 * started outlives it: a call still at work when it ends is cut off and answered before this returns. `sdk` stands in for
 * @cursor/sdk in tests.
 */
export async function converseCursor(db, params, { ctx, ledger, beforeTool = null, concurrent = null, onText = null, onTool = null, onResult = null, onOutput = null, onUsage = null, inbox = null, signal = null, budget = null, clock = null, circling = null, remind = null, now = () => new Date().toISOString(), sdk = null } = {}) {
  const { Agent, emptyFs } = sdk ?? (await loadCursorSdk());
  const apiKey = cursorKeyIn() ? process.env.CURSOR_API_KEY.trim() : null;
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, contextTokens: 0 };
  const log = (result, note) => logRun(db, { kind: ledger.kind, model: params.model, result, note, now: now(), jobId: ledger.jobId ?? null, sessionId: ledger.sessionId ?? null });
  const failed = (error) => {
    log({ ok: false, usage: usageOf(params.model, null) }, error);
    return { turns: 0, stop: 'error', error, text: '', totals, toldLast: false };
  };
  if (!apiKey) return failed('no CURSOR_API_KEY in this shell — export it in the shell sumo starts from');

  // The run's own stop: it ends when the run does, and with it whatever the run started; the caller's stop ends it too.
  const own = new AbortController();
  const runSignal = signal ? AbortSignal.any([signal, own.signal]) : own.signal;
  // The loop's own watch, loaded when a run begins: loop.mjs imports this module, and an import back from here at load time
  // was a cycle the standalone binary's bundle spun on for ever, before any job could start.
  const { heardFrom, roundWatch } = await import('./loop.mjs');
  const heard = () => heardFrom(inbox);
  const watch = roundWatch({ ctx, budget, clock, circling, remind, now });
  const spent = () => (budget?.spent ?? 0) + totals.costUsd;
  // The job's clock runs from when the job began (`clock.from`), not from this send: a job told to close is still on it.
  const overTime = () => clock !== null && Date.parse(now()) - clock.from >= clock.ms;
  let turns = 0;
  let stop = null;
  let stopped = null;
  let run = null;
  /** The request a result was last watched at: the local model's look and the plan come once a request, not once a call. */
  let watchedAt = -1;
  const cancel = (why) => {
    stop ??= why;
    stopped ??= why === 'budget' ? 'reached its budget' : why === 'time' ? 'reached its time limit' : 'was stopped';
    own.abort();
    run?.cancel().catch(() => {});
  };

  // One call: refused once the run is stopping; else through the gate and the tool as on Claude, under the run's own signal,
  // its result watched as a round on Claude is, and the call and its answer joined to the conversation together.
  const answer = async (call) => {
    if (stopped || runSignal.aborted) return { content: [{ type: 'text', text: `not run: the ${ledger.kind === 'chat' ? 'turn' : 'job'} ${stopped ?? 'was stopped'}` }], isError: true };
    totals.toolCalls++;
    onTool?.(call);
    let out;
    try {
      out = (await beforeTool?.(call, { signal: runSignal })) ?? (isMcpTool(call.name) ? await runMcpTool(call, { signal: runSignal }) : await runTool(call, ctx, { signal: runSignal, onOutput: onOutput && ((chunk) => onOutput(call, chunk)) }));
    } catch (cause) {
      out = { content: `the tool failed: ${cause.message}`, isError: true };
    }
    onResult?.(call, out);
    const results = [{ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: Boolean(out.isError) }];
    const marked = watch.mark([call], results);
    let after = [];
    if (marked.looping || marked.declined) cancel(marked.looping ? 'loop' : 'declined');
    else {
      const fresh = turns !== watchedAt;
      watchedAt = turns;
      if (fresh) await watch.circles(turns, results, runSignal);
      after = [...heard(), ...watch.notes(turns, spent, { past: true })];
      const reminder = fresh ? watch.reminder(turns) : null;
      if (reminder) after.push({ type: 'text', text: reminder });
    }
    // The call and what came back join the conversation as a call on Claude does, so a turn on Claude after this one
    // knows what was done and read — told only the reply, Claude once denied having made the file Composer made.
    params.messages.push(
      { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
      { role: 'user', content: [...results, ...after] },
    );
    return { content: [...forCursor(results[0].content), ...after], isError: results[0].is_error };
  };

  // Sumo's tools, one at a time as on Claude: Cursor may send several at once, and two edits racing over one file is no answer.
  // The calls `concurrent` picks — delegated jobs — run beside them. Every call is kept until it is answered.
  let queue = Promise.resolve();
  const working = new Set();
  const customTools = Object.fromEntries(
    Object.entries(toolsOf(params)).map(([name, { description, inputSchema }]) => [
      name,
      {
        description,
        inputSchema,
        execute: (args) => {
          // An id the API takes (letters, digits, _ and -) and that no other call in the conversation has: the call joins it.
          const call = { id: `cursor_${randomUUID().replaceAll('-', '')}`, name, input: args ?? {} };
          const beside = Boolean(concurrent?.(call));
          const turn = beside ? answer(call) : queue.then(() => answer(call));
          if (!beside) queue = turn.catch(() => {});
          working.add(turn);
          turn.then(
            () => working.delete(turn),
            () => working.delete(turn),
          );
          return turn;
        },
      },
    ]),
  );
  // The run is over: what it started is cut off, by its own signal, and answered before anything else is said or returned.
  const drain = async () => {
    stopped ??= 'ended';
    own.abort();
    while (working.size > 0) await Promise.allSettled([...working]);
  };

  const model = cursorModel(params.model, params.output_config?.effort);
  const known = agents.get(params);
  const from = known ? params.messages.lastIndexOf(known.last) + 1 : 0;
  const first = from === 0;
  // Cursor keeps its agents in one folder of Sumo's (`cursorFolder`), never the project's: a chat that moves to a project goes on
  // with the same agent, and the model is told where its tools work now. Cursor's own file and shell tools, offered or not, are
  // set up in this process: they get an empty tree, never the disk. The project is told by what it really is: the SDK refuses a
  // folder under /tmp, its scratch space, and a project there is /private/tmp.
  const local = { cwd: cursorFolder(), fs: emptyFs(), reportedWorkspacePath: realFolder(ctx.cwd), settingSources: [], customTools };
  const day = now().slice(0, 10);
  const system = (params.system ?? []).map((b) => (typeof b === 'string' ? b : b.text)).join('\n\n');
  /** What an agent is sent: told the conversation whole when it is new, else what was said since `start`; with the pictures the user pasted. */
  const toSend = (start, fresh) => {
    const moved = !fresh && known.workspace !== ctx.cwd ? `Your tools work in ${ctx.cwd} now.\n\n` : '';
    const words = fresh ? `${system}\n\nToday is ${day}.\n\n${textFrom(params.messages, 0, true)}` : `${moved}${textFrom(params.messages, start, false)}`;
    const pictures = picturesIn(params.messages.slice(start));
    return pictures.length > 0 ? { text: words, images: pictures } : words;
  };

  // One request to the model ended: its row in the ledger, and the budget, the clock and the turn limit held against the job.
  const onDelta = ({ update }) => {
    if (update?.type !== 'model-call-completed' || !update.usage) return;
    turns++;
    const shaped = anthropicUsage(update.usage);
    const usage = usageOf(params.model, shaped);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(params.model, shaped);
    totals.contextTokens = update.usage.inputTokens ?? 0;
    log({ ok: true, usage }, `turn ${turns} on Cursor`);
    onUsage?.(totals);
    if (budget && spent() >= budget.usd) cancel('budget');
    if (overTime()) cancel('time');
    if (watch.outOfTurns(turns)) cancel('max_turns');
  };

  let agent;
  const send = async (said) => {
    const told = params.messages.at(-1);
    run = await agent.send(said, { onDelta });
    agents.set(params, { agentId: agent.agentId, last: told, workspace: ctx.cwd });
  };
  const tools = cursorTools(params);
  const made = () => Agent.create({ apiKey, model, tools, local });
  try {
    let message = toSend(from, first);
    if (first) agent = await made();
    else {
      try {
        agent = await Agent.resume(known.agentId, { apiKey, model, tools, local });
      } catch {
        // An agent that cannot be picked up again — gone from Cursor's store, or refused — is let go, and a new one is told the
        // whole conversation: kept, it would be asked for again, and refused again, on every turn after this one.
        agents.delete(params);
        agent = await made();
        message = toSend(0, true);
      }
    }
    await send(message);
  } catch (cause) {
    agent?.close?.();
    return failed(describeCursorError(cause));
  }
  // The job's deadline aborts the signal too (runJob arms it, so a request in flight is cut off): said as the time limit.
  const onAbort = () => cancel(overTime() ? 'time' : 'interrupted');
  if (signal?.aborted) onAbort();
  else signal?.addEventListener('abort', onAbort, { once: true });

  let text = '';
  let reply = '';
  try {
    for (;;) {
      if (stop) run.cancel().catch(() => {});
      let ran = '';
      for await (const m of run.stream()) {
        if (m.type === 'assistant') {
          const said = (m.message?.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('');
          if (said) {
            ran += said;
            text += said;
            onText?.(said);
          }
        }
      }
      const result = await run.wait();
      if (result.status === 'error' && !stop) {
        await drain();
        const why = describeCursorError(result.error ?? 'the run failed');
        log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns + 1}: ${why}`);
        return { turns, stop: 'error', error: why, text, totals, toldLast: watch.toldLast };
      }
      reply = (typeof result.result === 'string' && result.result) || ran;
      // What the user said after the last call was answered is answered too, by the same agent, as a reply on Claude is followed.
      const said = stop ? [] : heard();
      if (said.length === 0) break;
      if (reply.trim()) params.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      params.messages.push({ role: 'user', content: said });
      await send(said.map((b) => b.text).join('\n\n'));
    }
    await drain();
    // The reply joins the conversation Sumo keeps, in words: what a later turn on Claude reads, and what a saved session holds.
    if (reply.trim()) {
      params.messages.push({ role: 'assistant', content: [{ type: 'text', text: reply }] });
      agents.set(params, { agentId: agent.agentId, last: params.messages.at(-1), workspace: ctx.cwd });
    }
    return { turns, stop: stop ?? 'end_turn', error: null, text: reply, totals, toldLast: watch.toldLast };
  } catch (cause) {
    await drain();
    if (stop) return { turns, stop, error: null, text, totals, toldLast: watch.toldLast };
    const why = describeCursorError(cause);
    log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns + 1}: ${why}`);
    return { turns, stop: 'error', error: why, text, totals, toldLast: watch.toldLast };
  } finally {
    signal?.removeEventListener('abort', onAbort);
    await drain();
    agent.close?.();
  }
}
