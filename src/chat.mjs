import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { isAdvisorTool } from './advisor.mjs';
import { ago } from './card.mjs';
import { getMeta } from './db.mjs';
import { runDream } from './dream.mjs';
import { openWatchTab, runHerdr } from './herdr.mjs';
import { appendLive, attemptsSettled, endLive, getJob, newJob, parseJobId, reportOf, runFollowed, startLive, tell as tellJob, treeOf } from './jobs.mjs';
import { handleEvent } from './hooks.mjs';
import { contextFor, converse, networkOn, paramsFor, runJob, runLines, sandboxOn, sendToApi, stopReason, TAMPER_REFUSED, tampersMarker, textOf, thinkingFor, withMcp, withServers } from './loop.mjs';
import { closeMcp, compactInput, gateMcp, isMcpTool, mcpLines, mcpReady, splitMcpName } from './mcp.mjs';
import { assertOn, MODEL_IDS, MODELS, modelId, usableModels } from './catalog.mjs';
import { takeLock } from './lock.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { UsageError } from './memory.mjs';
import { openInBrowser, servePage } from './page.mjs';
import { getProject, projectAt, scratchDir } from './projects.mjs';
import { redact } from './redact.mjs';
import { chooseChatRoute, EFFORTS } from './route.mjs';
import { verifyCommands } from './scan.mjs';
import { outcomeLines, runScribe } from './scribe.mjs';
import { currentProject, describeSaved, findSaved, loadState, lockFile, recordTurn, saveState, savedSessions, sessionLine, shortId, withoutThinking } from './sessions.mjs';
import { ASK_TOOL, BASH_TOOL, cap, capRedacted, DELEGATE_TOOL, EDITOR_TOOL, INTERRUPTED, nextUndoTurn, runCommand, undoLast } from './tools.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { estimateTokens, head } from './text.mjs';
import { colourEnabled, createRenderer, header, pathFrom, prompt, renderBlock, safeForTerminal, styles, tilde, toolView, widthOf } from './tty.mjs';
import { hasCommit } from './verify.mjs';
import { sourcesOf, WEB_FETCH_TOOL, WEB_SEARCH_TOOL, WEB_TOOLS } from './web.mjs';

/**
 * The conversation the user has with Sumo: the same loop a job runs in, with
 * the session policy raised in process — the memory block first, a project's
 * card when it comes up, a taught workflow before the command it gates, memory
 * before a question goes to the user, the size of the context said once per
 * band — and the scribe woken when a turn ends. Work is handed to sub-agents
 * with the `delegate` tool: each job runs here, in this process, on its own
 * route and in a context of its own, so the API key never enters a shell; its
 * work is shown as it happens, the user can talk to it while it runs, and its
 * report is the tool's result. Several delegated in one reply run at once.
 */

/** Models that take operator instructions as `role: "system"` messages mid-conversation; the others get them as text in the user turn. */
const SYSTEM_MESSAGES = new Set([MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.fable]);

// The guide comes with the command, by name, through the prompt hook — the same way it comes when the user's words ask for
// it: from inside a project the tools cannot reach guides/ by a relative path, and the editor is jailed away from it.
const COMMANDS = {
  fix: (args) => ({ text: `Fix this: ${args}`, guide: 'fix' }),
  feature: (args) => ({ text: `Build this: ${args}`, guide: 'feature' }),
  review: (args) => ({ text: `Review this: ${args}`, guide: 'review' }),
  dream: () => ({ text: 'Run `sumo dream run` and tell me, in a few lines, what it changed and what it wants me to confirm.' }),
};

/**
 * What the command menu shows, in the order it shows it; the models `/model` offers are the ones that are on as it is typed.
 * The effort a model would keep comes first (`effortNow`), so Enter on the open menu keeps it rather than dropping to the lowest.
 */
export function commandList(db, { effortNow = () => null, saved = () => [], running = () => [] } = {}) {
  const efforts = () => {
    const now = effortNow();
    return EFFORTS.includes(now) ? [now, ...EFFORTS.filter((e) => e !== now)] : EFFORTS;
  };
  const modelChoices = (given) => {
    const usable = usableModels(db);
    return given.length === 0 ? ['auto', ...usable] : given.length === 1 && usable.includes(given[0]) && given[0] !== 'haiku' ? efforts() : [];
  };
  return [
    { name: 'fix', hint: 'fix a bug, by guides/fix.md' },
    { name: 'feature', hint: 'build something, by guides/feature.md' },
    { name: 'review', hint: 'have a reviewer job judge something' },
    { name: 'dream', hint: 'tidy the memory and say what changed' },
    { name: 'model', hint: 'the route, or set it: auto, or a model and an effort', choices: modelChoices },
    { name: 'memory', hint: 'see the memory in the browser: say yes or no, edit, forget' },
    { name: 'mcp', hint: 'the MCP servers: connected or not, their tools, what may run unasked' },
    { name: 'resume', hint: 'pick a saved session up where it stopped', choices: (given) => (given.length === 0 ? saved().map((s) => ({ name: shortId(s.id), hint: s.hint })) : []) },
    { name: 'copy', hint: 'the last reply to the clipboard, as it was written; `code` for its last code block; a number for one further back', choices: (given) => (given.length === 0 ? ['code'] : []) },
    { name: 'undo', hint: "put back the files the editor changed in the last turn that changed any; again for the turn before — bash's changes are not tracked" },
    { name: 'stop', hint: 'stop a job at work in the background', choices: (given) => (given.length === 0 ? running().map((id) => `j${id}`) : []) },
    { name: 'context', hint: 'what this session has used: how full the context is, the tokens and the cost, by model' },
    { name: 'export', hint: 'the conversation as a Markdown file: to a path, or into the home\'s exports folder' },
    { name: 'thinking', hint: 'the model\'s thinking under the working line: on or off', choices: (given) => (given.length === 0 ? ['on', 'off'] : []) },
    { name: 'help', hint: 'the commands and the keys' },
    { name: 'new', hint: 'start a fresh session (/clear does too)' },
    { name: 'exit', hint: 'leave' },
  ];
}

/** A job is run with `delegate`, never from the shell: there it would be an agent in a shell of its own, holding no credential. */
const JOB_RUN = /(?:^|[\n;&|(`]|\$\()\s*(?:\w+=\S*\s+|nohup\s+|exec\s+)*sumo\s+job\s+(run|new)\b/;
/** A cheap-model pass the model asks for: run here too, since the shell it would start in holds no credential. */
const PASS_RUN = /^\s*sumo\s+(scribe|dream)\s+run\s*$/;

/**
 * Operator text for the model, placed so the cached prefix is untouched: a
 * system message where the model takes one, a text block otherwise. The API
 * accepts a mid-conversation system message only right after a user message,
 * so one that would follow the assistant's own turn goes as text too.
 */
export function injection(text, model, messages = []) {
  const afterUser = messages.at(-1)?.role === 'user';
  return SYSTEM_MESSAGES.has(model) && afterUser ? { role: 'system', content: text } : asText(text);
}

const asText = (text) => ({ role: 'user', content: [{ type: 'text', text: `<sumo>\n${text}\n</sumo>` }] });
/** Something that happened — a background job's report — as a block of a user turn: labelled as an event, never wrapped as operator text. */
const eventBlock = (text) => ({ type: 'text', text: `<event>\n${text}\n</event>` });

/** Automated turns in a row — a report read, which delegates, which reports — before the reports wait for the user's next message instead. */
const MAX_WOKEN = 3;
/** Jobs at work here at once: each report can start a turn, and each turn can delegate again. */
const MAX_JOBS = 4;
/** About how much of a job's report the chat's model is given; the rest is a command away, and the screen shows it whole. */
const REPORT_TOKENS = 1500;
/** The sections code adds at the end of a report: the checks' verdict, and where a worktree's change went. */
const ADDED_BY_CODE = /\n## (?:Verified by code|Accepted without verification|Worktree|Attempts)\b/;

/**
 * A job's report as the chat's model is given it: whole when it fits in REPORT_TOKENS; otherwise the head of what its
 * author wrote, what code added after it whole — the verdict, whether the change was brought back — and a last line
 * that says where the whole report is.
 */
function reportForModel(report, id) {
  if (estimateTokens(report) <= REPORT_TOKENS) return report;
  const at = report.search(ADDED_BY_CODE);
  const added = at === -1 ? '' : report.slice(at);
  const last = `The report is cut to fit; the whole of it: sumo job show ${id}`;
  const room = Math.max(0, REPORT_TOKENS * 4 - added.length - last.length - 40);
  return `${head(at === -1 ? report : report.slice(0, at), room).trimEnd()}\n[… cut]${added}\n${last}`;
}

/** One line per tool call, so the user can watch the work: the command, or the edit and its file. */
export function describeCall(call) {
  if (call.name === BASH_TOOL.name) return `$ ${String(call.input?.command ?? '').split('\n')[0].slice(0, 120)}`;
  if (call.name === DELEGATE_TOOL.name) return call.input?.job !== undefined ? `delegate j${call.input.job}` : `delegate ${call.input?.agent ?? 'worker'} — ${call.input?.title ?? ''}`;
  if (call.name === EDITOR_TOOL.name) return `${call.input?.command ?? 'edit'} ${tilde(call.input?.path ?? '')}${Array.isArray(call.input?.view_range) ? `:${call.input.view_range.join('-')}` : ''}`;
  if (isMcpTool(call.name)) {
    const { server, tool } = splitMcpName(call.name);
    return `${server} · ${tool}(${compactInput(call.input)})`;
  }
  if (call.name === WEB_SEARCH_TOOL.name) return `search: ${String(call.input?.query ?? '').slice(0, 120)}`;
  if (call.name === WEB_FETCH_TOOL.name) return `fetch: ${String(call.input?.url ?? '').slice(0, 120)}`;
  if (isAdvisorTool(call)) return `advisor: ${call.input?.asked ?? ''}`;
  return call.name;
}

/**
 * The branch a directory's repository is on, read from its HEAD — no process is started for it. A worktree's `.git` is a
 * file that names where its HEAD is. A detached head is the start of its commit; a directory in no repository has none.
 */
export function branchOf(dir) {
  for (let at = resolve(dir); ; at = dirname(at)) {
    const git = join(at, '.git');
    try {
      const home = statSync(git).isDirectory() ? git : resolve(at, /^gitdir: (.+)$/m.exec(readFileSync(git, 'utf8'))[1]);
      const head = readFileSync(join(home, 'HEAD'), 'utf8').trim();
      return /^ref: refs\/heads\/(.+)$/.exec(head)?.[1] ?? head.slice(0, 8);
    } catch {
      if (dirname(at) === at) return null;
    }
  }
}

/** The session's route for the screen's margins: `opus · high`, `haiku`, or on auto what the router last chose. */
export function routeLine(session) {
  const dot = ({ model, effort }) => (effort && effort !== 'none' ? `${model} · ${effort}` : model);
  if (session.model !== 'auto') return dot(session);
  return session.routed ? `auto → ${dot(session.routed)}` : 'auto';
}

/** A route as the screen says it: the model, and the effort when it has one. */
export const routeOf = ({ model, effort }) => (effort && effort !== 'none' ? `${model}/${effort}` : model);

/**
 * What `/model` was given: a model that is on, a model and an effort, or `auto`. The model alone keeps
 * the effort in hand; haiku takes none. Anything else is said back, and nothing changes.
 */
export function parseRoute(args, current, db) {
  const [model, effort, ...rest] = args.split(/\s+/).filter(Boolean);
  if (model === 'auto') {
    if (effort) throw new UsageError('auto takes no effort — the router picks it each turn');
    return { model: 'auto', effort: null };
  }
  if (!MODELS.includes(model)) throw new UsageError(`no such model "${model}" — one of: auto, ${usableModels(db).join(', ')}`);
  assertOn(db, model);
  if (rest.length > 0) throw new UsageError(`/model takes a model and an effort, not "${args}"`);
  if (model === 'haiku') {
    if (effort) throw new UsageError('haiku takes no effort setting');
    return { model, effort: 'none' };
  }
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new UsageError(`no such effort "${effort}" — one of: ${EFFORTS.join(', ')}`);
  const kept = current.effort && current.effort !== 'none' ? current.effort : CONFIG_DEFAULTS['chat.effort'];
  return { model, effort: effort ?? kept };
}

/**
 * What a job looks like while it works — on the terminal of `sumo job run`, and in the record `sumo job watch` shows:
 * the job's line, each call with the first line of what came back under it, and what the job says drawn as the chat
 * draws a reply, set in under its line. `clean` is done to the words before they are drawn: a wrapped line must not
 * break a secret apart where the redaction after it would no longer see it whole.
 */
export function jobPrinter(write, s, { width = 98, clean = (text) => text, cwd = null } = {}) {
  // Each call as the chat names it — Bash(npm test), Read(src/cart.js) — a file from the project the job works in.
  const at = () => (typeof cwd === 'function' ? cwd() : cwd);
  return {
    onStart: (job) => write(`⏺ ${s.bold(`j${job.id}`)} ${job.agent} · ${routeOf(job)} — ${job.title}\n`),
    onTool: (call) => {
      const view = toolView(call, null, { cwd: at() });
      // One line, and where more was cut away, the ellipsis that says so.
      const [first, ...rest] = clean(view.detail).split('\n');
      const line = first.length > 160 ? `${first.slice(0, 159)}…` : rest.length > 0 && !first.endsWith('…') ? `${first} …` : first;
      write(`  ⏺ ${s.bold(view.title)}(${line})\n`);
    },
    onRetry: (r) => write(`  ${s.dim(retryLine(r))}\n`),
    onCompact: (c) => write(`  ${s.dim(compactLine(c))}\n`),
    onResult: (call, result) => {
      // The line that says how it went, as the chat's screen would show it: what a command printed first, a read's size, an edit's first change.
      const first = toolView(call, { content: String(result.content ?? ''), isError: Boolean(result.isError), edit: result.edit }, { cwd: at() }).lines[0]?.text ?? '';
      write(`    ⎿  ${s.dim(clean(first).slice(0, 160))}\n`);
    },
    onTurn: (response) => {
      const text = textOf(response.content);
      if (!text) return;
      const drawn = [];
      const reply = createRenderer((t) => drawn.push(t), s, { width });
      reply.write(clean(text));
      reply.flush();
      write(`${drawn.join('').split('\n').map((l) => (l ? `  ${l}` : l)).join('\n')}\n`);
    },
  };
}

/** A request being sent again, in one line: which try, how long until it, and why. */
export const retryLine = ({ attempt, limit, delayMs, reason }) => `retrying in ${Math.max(1, Math.round(delayMs / 1000))}s (${attempt} of ${limit}) — ${reason}`;
/** A conversation summarized to make room, in one line: how big it had grown. */
export const compactLine = ({ before }) => `the conversation was summarized at ${Math.round(before / 1000)}k tokens to make room, and goes on from the summary`;
const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/**
 * `/context`: how full the context is — against the size where it is time to start afresh, with the word for its band — and
 * what the session has used, by who asked and on which model. Markdown, drawn as a reply is.
 */
export function contextReport({ contextTokens = 0, rows = [], turns = 0, calls = 0 }) {
  const full = Math.min(1, contextTokens / CONTEXT_FULL);
  const bar = `${'█'.repeat(Math.round(full * 20))}${'░'.repeat(20 - Math.round(full * 20))}`;
  const band = contextTokens >= CONTEXT_FULL ? 'very large — /new now; the memory brings the thread back' : contextTokens >= CONTEXT_LARGE ? 'large — quality drops from here; finish the piece in hand, then /new' : 'room to spare';
  const cost = rows.reduce((sum, row) => sum + row.cost, 0);
  const lines = [`**Context** ${kilo(contextTokens)} tokens · \`${bar}\` ${Math.round(full * 100)}% of ${kilo(CONTEXT_FULL)} · ${band}`, '', `**This session** ${turns} turn${turns === 1 ? '' : 's'} · ${calls} tool call${calls === 1 ? '' : 's'} · $${cost.toFixed(2)}`];
  if (rows.length === 0) return [...lines, '', 'No request has been made yet.'].join('\n');
  return [...lines, '', '| Who | Model | Requests | In | Cached | Out | Cost |', '|---|---|--:|--:|--:|--:|--:|', ...rows.map((row) => `| ${row.kind} | ${row.model} | ${row.requests} | ${kilo(row.input)} | ${kilo(row.cached)} | ${kilo(row.output)} | $${row.cost.toFixed(2)} |`)].join('\n');
}

/** A session past its budget, in one line: what it has cost, how to start afresh, and how to move the line. */
export const budgetLine = (cost) => `this session has cost $${cost.toFixed(2)} — /new starts a fresh one; sumo config chat.budget changes when this is said`;

/** Where the context is large enough that quality drops, and where it is time for /new: the bands the session is told about. */
const CONTEXT_LARGE = 60_000;
const CONTEXT_FULL = 150_000;

/** The session log, one JSON line per message, the shape the scribe reads assistant replies from and the gauge reads usage from. */
function logLine(file, entry) {
  appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

function configured(db, key) {
  return getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key];
}

/** The chat's own tools, in a fixed order so its cached prefix never moves; the MCP servers' come after them. */
export const CHAT_TOOLS = [BASH_TOOL, EDITOR_TOOL, DELEGATE_TOOL, ASK_TOOL, ...WEB_TOOLS];
/**
 * The chat's system prompt: AGENTS.md. The guides it names are read from wherever the chat was started: their paths are
 * made absolute, or the model goes looking for them.
 */
export const chatSystem = () => readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8').trim().replaceAll(/(?<![\w/])guides\//g, `${join(REPO_ROOT, 'guides')}/`);

/**
 * One chat session's state and policy, apart from the terminal, so it can be
 * driven by tests with canned responses. `say(text)` is one user turn;
 * `interrupt()` stops the one in progress. `watch` is told each tool call, its
 * result, and the running totals, for a screen that shows the work — and, for
 * a job run here, the job as it starts, its calls and results (marked with its
 * id), what it says, and its end. `tell(text)` talks to the job running here;
 * `tell(text, id)` to any open job, through its inbox on disk if it runs
 * elsewhere. Inside Herdr (`env`), each job also gets a tab that shows its work,
 * opened through `herdr` — both swapped in tests. `route` is the router asked
 * for each turn's model when the model is `auto`. `approve` puts an MCP call
 * that is not on the allow list to the user — the chat's own, or a job's run
 * here — and answers `once`, `always` or `no`; without it such a call is refused.
 * `ask` puts a question of the model's to the user, with its options, and
 * answers `{ label }` for the one picked or `{ text }` for words of their own —
 * anything else is no answer; without it the model is told nobody is there.
 * With `background`, a delegated job does not hold the turn: `delegate` answers
 * at once, the job runs beside the conversation with a stop of its own, and its
 * report reaches the model later as an automated event — with its next request
 * if it is at work, else in a turn of its own (`wake`), which whoever watches
 * starts when told `job-report`.
 */
export function createChat(db, { model, effort, cwd = process.cwd(), send = sendToApi, out = () => {}, activity = () => {}, watch = () => {}, herdr = runHerdr, env = process.env, route = chooseChatRoute, approve = null, ask = null, background = false, now = () => new Date().toISOString() } = {}) {
  // A route the chat was started with holds through a resumed session; one it was not, the saved session brings back.
  const given = { model: model !== undefined, effort: effort !== undefined };
  model ??= configured(db, 'chat.model');
  // A model the user turned off is not chatted on, however the chat came to be on it; auto reads the switches each turn.
  // A full API id is that model too (claude-opus-5-5 is opus), switched off or on with it.
  const named = MODELS.find((name) => MODEL_IDS[name] === model) ?? model;
  if (named !== 'auto' && MODELS.includes(named)) assertOn(db, named, 'sumo config chat.model <name>');
  effort ??= model === 'auto' ? null : configured(db, 'chat.effort');
  // Haiku takes no effort setting, however the chat came to be on it: by flag, by configuration, or by /model.
  if (modelId(model) === MODEL_IDS.haiku) effort = 'none';
  /** On auto, the route the last turn ran on; null otherwise. */
  let routed = null;
  const system = chatSystem();
  const own = CHAT_TOOLS;
  /** The MCP servers of this process, once connected: their tools join the request, deferred, and their names the system prompt. */
  let registry = null;
  /** Whether the servers' tools have joined the requests: once, at the first turn after they connected. */
  let joined = false;
  const connecting = mcpReady().then((r) => {
    registry = r;
  });
  const toolsNow = () => withMcp(own, registry?.tools() ?? []);
  const systemNow = () => withServers(system, registry);
  let sessionId;
  let params;
  let transcript;
  let lastContext = 0;
  let project = null;
  let stopper = null;
  /** The file that says this session is open here, until it ends. */
  let lock = null;
  /** Whether there is anything to save yet: a session nobody has spoken to is not kept. */
  let spoken = false;
  /** Said to the model with the next turn: that the session was picked up again, or that /undo put files back. */
  let note = null;
  /** The files the model has viewed or written in this session, as they stood then: an edit to one changed on disk since says so. */
  let seen = new Map();
  /** Whether the screen has said what this session cost: once a session, when it first passes `chat.budget`. */
  let costSaid = false;
  /** The jobs running here, each with what the user has said to it that it has not read yet. */
  const jobs = new Map();
  /** The projects a worker is running in: two in one working tree overwrite each other. */
  const workers = new Set();
  /** What the user said to the chat while it worked, not read yet: it goes in with the model's next request of the same turn. */
  const steers = [];
  /** The jobs at work in the background, each with the stop that is its own: Esc stops the chat's turn, not the work handed off. */
  const stops = new Map();
  /** The background jobs' runs, so a chat that closes can wait for the ones it stopped to let go. */
  const runs = new Set();
  /** The jobs the user stopped: their end is said, and wakes nothing. */
  const stoppedByUser = new Set();
  /** What background jobs reported and the model has not read yet: `{ id, text, quiet }`. */
  const reports = [];
  /** Turns nobody typed since the user last did: past MAX_WOKEN, what the jobs report waits for the user. */
  let woken = 0;
  /** The memory page, once /memory has asked for it: the promise of its address. */
  let page = null;
  const ledger = { kind: 'chat', sessionId: null };
  // What /model with a model and no effort keeps: the effort in hand, or the configured one.
  // Worked out as setRoute and parseRoute do: off auto, the effort kept is the user's configured one.
  const others = () => savedSessions(db, { now: now(), except: sessionId ?? null });
  const commands = commandList(db, {
    effortNow: () => {
      const kept = effort ?? configured(db, 'chat.effort');
      return kept && kept !== 'none' ? kept : CONFIG_DEFAULTS['chat.effort'];
    },
    saved: () => others().map((s) => ({ id: s.id, hint: describeSaved(s, now()) })),
    running: () => [...stops.keys()],
  });

  const emit = (text) => out(text);
  /** The conversation as the model in hand can take it: one that takes no operator messages is sent them as text. The history itself is left alone, so a model that does take them still reads it from its cache. */
  const sendAs = (p, options) => send(SYSTEM_MESSAGES.has(p.model) ? p : { ...p, messages: p.messages.map((m) => (m.role === 'system' ? asText(m.content) : m)) }, options);

  const busy = (id) => (holder) => `session ${shortId(id)} is open in another terminal (process ${holder})`;

  /**
   * A fresh session, or a saved one picked up again (`saved`, with its lock already `held`). A fresh one carries
   * nothing over but the route: it has read nothing yet, and no card has named a project in it. A resumed one carries
   * its whole conversation, the size it had reached, and its route unless the chat was started with one; the memory
   * block it opened with is already its first turn, so the one made now is not sent again.
   */
  function start(source, saved = null, held = null) {
    sessionId = saved?.id ?? randomUUID();
    mkdirSync(join(paths().logs, 'sessions'), { recursive: true, mode: 0o700 });
    lock = held ?? takeLock(lockFile(sessionId), busy(sessionId));
    ledger.sessionId = sessionId;
    lastContext = saved?.contextTokens ?? 0;
    costSaid = false;
    project = null;
    seen = new Map();
    spoken = Boolean(saved);
    transcript = join(paths().logs, 'sessions', `${sessionId}.jsonl`);
    const block = handleEvent(db, 'session-start', { session_id: sessionId, cwd, transcript_path: transcript, source }, now());
    if (saved && !given.model) {
      model = saved.model;
      routed = saved.routed ?? null;
      if (!given.effort) effort = saved.effort;
      if (modelId(model) === MODEL_IDS.haiku) effort = 'none';
    }
    params = paramsFor({ model: model === 'auto' ? (routed?.model ?? CONFIG_DEFAULTS['chat.model']) : model, effort: model === 'auto' ? routed?.effort : effort, tools: toolsNow(), system: systemNow(), text: saved ? undefined : block });
    // What jobs reported that this session had not read comes back with it; a fresh session has read nothing, and is owed nothing.
    reports.splice(0, reports.length, ...(saved?.pending ?? []));
    if (saved) {
      params.messages = withoutThinking(saved.messages);
      note = `resumed: this session was saved ${ago(saved.savedAt, now())} and picked up again now, in ${cwd}. Carry on where it stopped; memory may have changed since this session's first block — search it before assuming.`;
    }
    return block;
  }

  /**
   * `/resume <id>`: a saved session picked up where it stopped, in place of this one, which ends. Everything is checked
   * before anything changes: the id names one session, it can be read, its model is on, and no other terminal has it.
   */
  function resume(ref) {
    const found = findSaved(db, ref, { now: now(), except: sessionId ?? null });
    const saved = loadState(found.id);
    if (!saved) throw new UsageError(`the saved session ${shortId(found.id)} is gone`);
    // Its model is checked as the chat's own was: a full API id is that model too, and one turned off since is not chatted on.
    const named = MODELS.find((name) => MODEL_IDS[name] === saved.model) ?? saved.model;
    if (!given.model && named !== 'auto' && MODELS.includes(named)) assertOn(db, named, '/model <name>');
    const held = takeLock(lockFile(found.id), busy(found.id));
    if (sessionId) end();
    start('resume', saved, held);
    return `resumed ${sessionLine(found, now())} — the first reply pays one uncached turn`;
  }

  /** The session kept where nothing can say a failure: a save that fails here is tried again after the next turn. */
  function keepQuietly() {
    try {
      persist();
    } catch {
      // Said, if it still fails, by the save after the next turn.
    }
  }

  /** The session as it stands, kept after every turn. A save that fails is said as the turn's error: the turn itself went fine. */
  function persist() {
    if (!spoken) return;
    try {
      saveState({ id: sessionId, messages: params.messages, model, effort, routed, cwd, contextTokens: lastContext, now: now(), pending: reports.map(({ id, quiet, text }) => ({ id, quiet, text })) });
    } catch (cause) {
      throw new UsageError(`the session could not be saved: ${cause.message}`);
    }
  }

  /** The request from here on goes to this model at this effort, thinking as that model does; the conversation so far stays. */
  function apply({ model: m, effort: e }) {
    params.model = modelId(m);
    if (e && e !== 'none') params.output_config = { effort: e };
    else delete params.output_config;
    const thinking = thinkingFor(m);
    if (thinking) params.thinking = thinking;
    else delete params.thinking;
  }

  /**
   * `/model`: with nothing, says the route; with `auto`, a model, or a model and an effort,
   * sets it for the turns from here on and says what it is now. A bad one is thrown and changes nothing.
   */
  function setRoute(args) {
    if (args.trim()) {
      // Off auto there is no effort in hand: the one kept is the user's configured one.
      const next = parseRoute(args.trim(), { model, effort: effort ?? configured(db, 'chat.effort') }, db);
      ({ model, effort } = next);
      routed = null;
      if (model !== 'auto') apply(next);
      persist();
    }
    return model === 'auto' ? `auto${routed ? ` → ${routeOf(routed)}` : ''}` : routeOf({ model, effort });
  }

  const event = (name, payload) => handleEvent(db, name, { session_id: sessionId, cwd, transcript_path: transcript, ...payload }, now());

  /** Where this session's turns keep what the editor changed, for /undo. */
  const undoDir = () => join(paths().logs, 'undo', sessionId);

  /**
   * The project the work is in: the one whose card came in last; before any has, the one the chat was started in; else none
   * (tools then run in scratch).
   */
  function workspace() {
    const slug = currentProject(db, sessionId) ?? projectAt(db, cwd);
    if (slug && project?.slug !== slug) project = getProject(db, slug);
    return contextFor(project ?? { path: scratchDir() }, { sandbox: sandboxOn(db), network: networkOn(db) });
  }

  /**
   * A question for the user. Memory is read first, and holds it back once if it may hold the answer. Then it waits on
   * the user: a pick is kept as their decision, with the question; what they typed instead is their words, kept as a turn is.
   */
  async function askUser(input) {
    const line = (v) => safeForTerminal(String(v ?? '')).replace(/\s+/g, ' ').trim();
    const question = safeForTerminal(String(input.question ?? '')).trim();
    const options = (Array.isArray(input.options) ? input.options : []).map((o) => ({ label: line(o?.label ?? o), ...(line(o?.detail) ? { detail: line(o.detail) } : {}) }));
    if (!question || options.length < 2 || options.length > 4 || options.some((o) => !o.label)) return { content: 'not asked: give `question` and 2–4 `options`, each with a `label`.', isError: true };
    const gate = event('pre-tool', { tool_name: ASK_TOOL.name, tool_input: { question } });
    if (gate) return { content: JSON.parse(gate).deny, isError: true };
    if (!ask) return { content: 'not asked: nobody is here to answer. Decide it yourself and say what you assumed, or end your turn on the question.', isError: true };
    const stopped = new Promise((resolve) => stopper.signal.addEventListener('abort', () => resolve('no'), { once: true }));
    const answer = await Promise.race([ask({ question, options, signal: stopper.signal }), stopped]);
    const picked = options.find((o) => o.label === answer?.label);
    if (picked) {
      // A pick is the user's decision in the model's wording: kept beside what they typed, with the question it answers.
      recordTurn(db, { sessionId, text: `${question} → ${picked.label}`, now: now() });
      return { content: `The user chose: ${picked.label}` };
    }
    const text = typeof answer?.text === 'string' ? answer.text.trim() : '';
    if (!text) return { content: 'no answer: the user turned the question away. Do not ask it again; decide it yourself and say what you assumed, or carry on another way.', isError: true };
    const brought = event('prompt', { prompt: text, context_tokens: lastContext });
    noteGuides(brought);
    logLine(transcript, { type: 'user', message: { role: 'user', content: redact(text).text } });
    return { content: `The user answered: ${text}${brought ? `\n<sumo>\n${brought}\n</sumo>` : ''}` };
  }

  /** The workflow gate, the cheap-model passes, `delegate` and `ask`; anything else is the tool's own business. */
  async function beforeTool(call) {
    if (call.name === DELEGATE_TOOL.name) return delegate(call.input ?? {}, call.id);
    if (call.name === ASK_TOOL.name) return askUser(call.input ?? {});
    if (isMcpTool(call.name)) return gateMcp(call, { approve, signal: stopper.signal });
    if (call.name !== BASH_TOOL.name) return null;
    const command = String(call.input?.command ?? '');
    if (tampersMarker(command)) return { content: TAMPER_REFUSED, isError: true };
    const gate = event('pre-tool', { tool_name: 'bash', tool_input: { command } });
    if (gate) return { content: JSON.parse(gate).deny, isError: true };
    const pass = PASS_RUN.exec(command);
    if (pass) {
      activity(`running the ${pass[1]} pass…`);
      return { content: outcomeLines(pass[1] === 'dream' ? await runDream(db, { force: true }) : await runScribe(db)).join('\n') };
    }
    const job = JOB_RUN.exec(command);
    if (job) return { content: `jobs are not ${job[1] === 'new' ? 'made' : 'run'} from the shell: use the delegate tool${job[1] === 'run' ? ' (only `job` for one already made)' : ''}`, isError: true };
    return null;
  }

  /**
   * `delegate`: a job is made from the brief, or an open one picked up, and run here on its own route. The chat waits
   * for its report — or, working in the background, is answered at once and reads the report when it comes. Calls in
   * one reply run side by side, but a worker has its project's working tree to itself — in a git project, a second one
   * is given a worktree of its own. Several `attempts` run side by side too, and are answered for once, together.
   * `callId` is the delegate call's own, so a screen can show the job under the call that started it.
   */
  async function delegate(input, callId = null) {
    const asked = (input.job === undefined || input.job === null) && [2, 3].includes(input.attempts) ? input.attempts : 1;
    // Counted where a run begins, before anything is awaited: five calls in one reply are judged one after another, not all at once.
    if (jobs.size + asked > MAX_JOBS) throw new UsageError(`${[...jobs.keys()].map((j) => `j${j}`).join(', ')} are at work already — ${MAX_JOBS} at once is the most; wait for a report`);
    const own = background ? new AbortController() : null;
    const signal = own?.signal ?? stopper.signal;
    let claimed = null;
    const claim = (agent, slug, shared) => {
      if (agent !== 'worker' || !shared) return;
      if (workers.has(slug)) throw new UsageError(`a worker is already running in ${slug} — two in one working tree overwrite each other; wait for its report`);
      workers.add(slug);
      claimed = slug;
    };
    const release = () => {
      if (claimed) workers.delete(claimed);
    };
    let id;
    /** The other attempts made beside the first, when several were asked for. */
    let siblings = [];
    let warnings = [];
    try {
      if (input.job !== undefined && input.job !== null) {
        const job = getJob(db, parseJobId(input.job));
        claim(job.agent, job.project, treeOf(db, job.id) === null);
        id = job.id;
      } else {
        const agent = input.agent ?? 'worker';
        const project = getProject(db, input.project ?? '');
        if (!project) throw new UsageError(`no project "${input.project ?? ''}" — the delegate call names one by its slug`);
        claim(agent, project.slug, !hasCommit(project.path));
        activity(`briefing a ${agent}…`);
        const made = await newJob(db, { project: project.slug, title: input.title, agent, task: input.task, guide: input.guide, reviews: input.reviews ?? undefined, testsMayChange: Boolean(input.tests_may_change), attempts: input.attempts ?? 1, now: now() });
        ({ job: { id }, warnings } = made);
        siblings = (made.jobs ?? []).slice(1).map((job) => job.id);
      }
    } catch (cause) {
      release();
      throw cause;
    }
    let begun;
    const started = new Promise((resolve) => (begun = resolve));
    const ids = [id, ...siblings];
    // A job made to follow this one — its retry, or its review — is at work under the same call, and stopped with it.
    const follow = (next) => {
      ids.push(next);
      if (own) stops.set(next, own);
    };
    const work = (siblings.length === 0 ? runFollowedHere(id, warnings, { signal, callId, begun }, follow) : runAttempts(ids, warnings, { signal, callId, begun })).finally(release);
    if (!own) return work;

    // In the background. A job that cannot start says so as the call's own answer; one that has started answers later.
    // Attempts share one stop: stopping one stops them all.
    for (const each of ids) stops.set(each, own);
    const first = await Promise.race([started, work.then(() => null, (cause) => ({ cause }))]);
    if (first?.cause) {
      for (const each of ids) stops.delete(each);
      throw first.cause;
    }
    const run = work
      .then((result) => result, (cause) => ({ content: `j${id} stopped on an error: ${cause.message}`, isError: true }))
      .then((result) => {
        for (const each of ids) stops.delete(each);
        runs.delete(run);
        const quiet = ids.filter((each) => stoppedByUser.delete(each)).length > 0;
        reports.push({ id, quiet, text: `An automated event, not a message from the user: ${ids.map((each) => `j${each}`).join(', ')} ${ids.length === 1 ? 'has' : 'have'} reported.\n${result.content}` });
        // Kept with the session as soon as it comes: a chat closed before the next message still has it when picked up again.
        keepQuietly();
        watch({ type: 'job-report', job: id, result, quiet });
      });
    runs.add(run);
    const job = getJob(db, id);
    const beside = siblings.length === 0 ? '' : `, with ${siblings.map((each) => `j${each}`).join(' and ')} beside it: attempts at the same task, reported on together`;
    return {
      content:
        `j${id} is running in the background (${job.agent} · ${routeOf(job)} — ${job.title})${beside}. Its report will reach you later, as an automated event marked as ` +
        'not from the user: with your next request if you are still at work, otherwise in a turn of its own. Until then you know nothing of what it found — ' +
        'do not guess its result, and do not do its work yourself. Carry on with what does not depend on it, or end your turn and say it is running.',
    };
  }

  /** Attempts at one task, run side by side and answered for once, when all have ended: what was kept first, then how each went. */
  async function runAttempts(ids, warnings, options) {
    const ended = await Promise.allSettled(ids.map((each) => runHere(each, [], options)));
    const kept = attemptsSettled(db, ids[0]) ?? ['Not every attempt closed, so none was picked or brought back yet.'];
    const each = ended.map((e, i) => (e.status === 'fulfilled' ? e.value.content : `j${ids[i]} stopped on an error: ${e.reason?.message}`));
    return { content: capRedacted([[...warnings, `Attempts ${ids.map((j) => `j${j}`).join(', ')}:`, ...kept].join('\n'), ...each].join('\n\n')) };
  }

  /**
   * One job run here, and what follows it unasked — a retry one step up of a first attempt that failed, a review of
   * risky work done (`runFollowed`, src/jobs.mjs) — answered for once. A retry stands in for the attempt that failed,
   * after the line that says so; a review comes after the work it judged. `onFollow` hears each job made, before it runs.
   */
  async function runFollowedHere(id, warnings, options, onFollow) {
    const ran = await runFollowed(db, id, (each, said = warnings) => runHere(each, said, options), { signal: options.signal, onFollow, now });
    if (ran.length === 1) return ran[0].result;
    let parts = [];
    let shown = [];
    let job = null;
    for (const step of ran) {
      // The attempt that failed is one line now; its report is a command away.
      if (step.kind === 'retry') [parts, shown, job] = [[], [], null];
      parts.push([step.line, step.result?.content ?? (step.error ? `j${step.id} stopped on an error: ${step.error}` : '')].filter(Boolean).join('\n'));
      shown.push([step.line, step.result?.job?.report].filter(Boolean).join('\n'));
      job ??= step.result?.job ?? null;
    }
    return { content: parts.join('\n\n'), job: job && { ...job, report: shown.join('\n\n') } };
  }

  /** One job, run here to its end: watched as it works, written down for `sumo job watch`, and answered with how it went and what it reported. */
  async function runHere(id, warnings, { signal, callId, begun }) {
    const inbox = [];
    jobs.set(id, inbox);
    const began = Date.now();
    // Its work is written down as it happens, for `sumo job watch` — in a Herdr tab of its own, or any terminal —
    // and without its secrets, through the same redaction as what the model sees.
    const record = (t) => appendLive(id, redact(t).text);
    const live = jobPrinter(record, styles(false), { clean: (t) => redact(t).text, cwd: () => getProject(db, getJob(db, id)?.project ?? '')?.path ?? null });
    let ended = [];
    try {
      const outcome = await runJob(db, id, {
        send: (p) => send(p, { signal }),
        signal,
        approve,
        inbox: () => inbox.splice(0),
        onStart: (job) => {
          startLive(id);
          live.onStart(job);
          watch({ type: 'job', job, call: callId, tab: env.HERDR_ENV ? watchTab(job) : null });
          begun();
        },
        onTool: (call) => {
          live.onTool(call);
          activity(`j${id} ${describeCall(call)}`);
          watch({ type: 'tool', call, job: id });
        },
        onResult: (call, result) => {
          live.onResult(call, result);
          watch({ type: 'result', call, result, job: id });
        },
        onTurn: (response, totals) => {
          live.onTurn(response, totals);
          overBudget();
        },
        onThinking: (_delta, snapshot) => watch({ type: 'thinking', job: id, text: snapshot }),
        onRetry: (r) => {
          live.onRetry(r);
          watch({ type: 'retry', job: id, ...r });
        },
        onCompact: (c) => {
          live.onCompact(c);
          watch({ type: 'compact', job: id, ...c });
        },
      });
      ended = runLines(outcome);
      const report = reportOf(id);
      // Model-written, like any tool output: redacted before it reaches the chat's context, and cut to fit there. `job` is how it went, for the screen only.
      const { job, turns, totals } = outcome;
      return {
        content: capRedacted([...warnings, ...ended, ...(report ? ['', reportForModel(report, id)] : [])].join('\n')),
        job: { id, status: job.status, seconds: Math.round((Date.now() - began) / 1000), turns, toolCalls: totals.toolCalls, costUsd: totals.costUsd, model: job.model, effort: job.effort, report: report ? redact(report).text : '' },
      };
    } catch (cause) {
      ended = [cause.message];
      throw cause;
    } finally {
      jobs.delete(id);
      endLive(id, ended.map((l) => redact(l).text));
      watch({ type: 'job-end', job: id });
    }
  }

  /** Stops a job at work in the background, for the user: it ends where it is, and its end is said to the model with whatever comes next. */
  function stop(id) {
    const own = stops.get(id);
    if (!own) return false;
    stoppedByUser.add(id);
    own.abort();
    return true;
  }

  /** The chat is closing: the jobs still at work are stopped — each can be picked up again from its notes — and waited for, so none is cut off mid-write. */
  async function settle() {
    for (const id of [...stops.keys()]) stop(id);
    await Promise.allSettled([...runs]);
  }

  /**
   * A turn nobody typed: what background jobs have reported since the model last looked, put to it as an automated event.
   * Null when nothing is waiting — a job the user stopped waits for the next message instead.
   */
  async function wake() {
    if (waiting() === 0) return null;
    woken++;
    return say(reports.splice(0).map((r) => r.text).join('\n\n'), '', [], { automated: true });
  }

  /** How many reports wait for a turn of their own: none once MAX_WOKEN automated turns have run in a row — they wait for the user's next message. */
  const waiting = () => (woken >= MAX_WOKEN ? 0 : reports.filter((r) => !r.quiet).length);

  /** The job's tab in Herdr, showing its work: its pane, or why there is none — the job runs here either way. A watcher that never starts in it is said when it gives up. */
  function watchTab(job) {
    try {
      return { pane: openWatchTab(herdr, { job, project: getProject(db, job.project), env, onFail: (reason) => watch({ type: 'tab-failed', job: job.id, reason }) }) };
    } catch (cause) {
      return { error: cause.message };
    }
  }

  /**
   * Something for a job. Without an id: the one job running here, or false when there is none, so the caller can
   * treat the words as its own; with several running, it must be named. With an id: that job, through its inbox on
   * disk if it is not running here; a job that is not open is refused. What comes back is the job it reached.
   */
  function tell(text, id) {
    if (id === undefined || id === null) {
      if (jobs.size === 0) return false;
      if (jobs.size > 1) throw new UsageError(`${[...jobs.keys()].map((j) => `j${j}`).join(', ')} are running — name the one: @j<id> …`);
      [id] = jobs.keys();
    }
    if (jobs.has(id)) jobs.get(id).push(text);
    else tellJob(db, id, text, now());
    return id;
  }

  /** A turn that ended before the model answered left its operator message at the tail; the API takes one only where the model answers next, so before anything follows it, it becomes text. */
  function settleTail() {
    const tail = params.messages.at(-1);
    if (tail?.role === 'system') params.messages[params.messages.length - 1] = asText(tail.content);
  }

  /**
   * One turn. `text` is what the model is sent; `said` is what the user typed of it — for a slash command, the words after the command — and is all that memory keeps as theirs.
   * `images` go before the words, each under the label the text names it by: `{ label, mediaType, data }`, the data in base64.
   * `guide` is the one a slash command named, which rides in whether or not the words would have brought it.
   */
  async function say(text, said = text, images = [], { automated = false, guide = null } = {}) {
    try {
      const outcome = await turn(text, said, images, automated, guide);
      persist();
      return outcome;
    } finally {
      // What was said too late to be read in this turn is the caller's to send as a turn of its own, not this one's to keep.
      steers.length = 0;
    }
  }

  /**
   * What was said while the turn worked, handed to the model with its next request. Each is the user's own words, so it is
   * kept as a turn is — stored, logged, and able to bring a project's card in with it — and whoever watches is told it was read.
   */
  function heard() {
    const said = steers.splice(0);
    if (said.length > 0) watch({ type: 'heard', said });
    return [
      ...said.map((text) => {
        const brought = event('prompt', { prompt: text, context_tokens: lastContext });
        noteGuides(brought);
        logLine(transcript, { type: 'user', message: { role: 'user', content: redact(text).text } });
        return brought ? `${text}\n<sumo>\n${brought}\n</sumo>` : text;
      }),
      // What a background job reported while the model worked: read now, as something that happened, not as the user's words.
      ...reports.splice(0).map((report) => ({ event: report.text })),
    ];
  }

  /** Takes back something said while the turn worked, if the model has not read it yet. */
  function unsteer(text) {
    const at = steers.lastIndexOf(text);
    if (at === -1) return false;
    steers.splice(at, 1);
    return true;
  }

  /** The screen is told which guide rode in: one dim line, so the user knows the model was handed a way of working. */
  function noteGuides(brought) {
    for (const [, name] of brought.matchAll(/^<guide (\w+)>/gm)) watch({ type: 'guide', name });
  }

  async function turn(text, said, images, automated = false, guide = null) {
    stopper = new AbortController();
    // Edits nothing has checked: an editor call that writes adds its file; one of the project's declared checks running
    // clears them — any command does when the project declares none. The gate at the end of the turn is told what is
    // left. The shell can edit too (`sed -i`, a redirect); that is not seen.
    const unchecked = new Set();
    const declared = () => verifyCommands(workspace().cwd).map((c) => c.command);
    const noteCall = (call) => {
      if (call.name === EDITOR_TOOL.name && call.input?.command !== 'view' && call.input?.path) unchecked.add(resolve(workspace().cwd, String(call.input.path)));
      if (call.name !== BASH_TOOL.name) return;
      const checks = declared();
      if (checks.length === 0 || checks.some((c) => String(call.input?.command ?? '').includes(c))) unchecked.clear();
    };
    // The servers connect while the first turn is typed; the first request waits for them, and Esc does not. Their tools
    // join the request then — even when something else, /mcp, already waited for them to connect.
    if (!joined) {
      const stopped = new Promise((resolve) => stopper.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
      if ((await Promise.race([connecting, stopped])) === 'stopped') return { stop: 'interrupted', error: null, text: '' };
      params.tools = toolsNow();
      params.system[0].text = systemNow();
      joined = true;
      if (registry.servers().length > 0 || registry.error) watch({ type: 'mcp', servers: registry.servers(), error: registry.error });
    }
    // On auto the router names this turn's model first; a router that cannot answer refuses the turn, and nothing of it reaches the conversation.
    // A turn nobody typed runs on the route the last one had: there is no message to size it by.
    if (model === 'auto' && !(automated && routed)) {
      let chosen;
      try {
        workspace();
        // Esc is heard while the router thinks: the turn ends now, and the router's late answer is let go unread.
        const routing = route(db, { project, text });
        routing.catch(() => {});
        const stopped = new Promise((resolve) => stopper.signal.addEventListener('abort', () => resolve(null), { once: true }));
        chosen = await Promise.race([routing, stopped]);
      } catch (cause) {
        return { stop: 'error', error: cause.message, text: '' };
      }
      // Stopped while the router was still choosing: nothing has been sent, and nothing of the turn is kept.
      if (stopper.signal.aborted) return { stop: 'interrupted', error: null, text: '' };
      routed = chosen;
      apply(routed);
      logLine(transcript, { type: 'route', ...routed });
      watch({ type: 'route', ...routed });
    }
    settleTail();
    // A resumed session is told so with its first turn. An automated turn is a report itself: nothing in it is the user's, so nothing of it is kept as theirs.
    const injected = [note, ...(automated ? [] : [event('prompt', { prompt: said, context_tokens: lastContext, guide })])].filter(Boolean).join('\n');
    noteGuides(injected);
    note = null;
    if (!automated) woken = 0;
    const pictures = images.flatMap(({ label, mediaType, data }) => [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: mediaType, data } }]);
    // What background jobs reported while nobody was looking rides in with the message, as blocks of its own: an event in the user's turn,
    // never operator text — a report repeats what a page or a file said, and that is nobody's instruction.
    const events = reports.splice(0).map((r) => eventBlock(r.text));
    const at = params.messages.push(automated ? { role: 'user', content: [eventBlock(text)] } : { role: 'user', content: [...pictures, { type: 'text', text }, ...events] }) - 1;
    spoken = true;
    if (injected) params.messages.push(injection(injected, params.model, params.messages));
    // The log keeps what memory keeps: the user's words without their secrets — and an event as an event.
    logLine(transcript, automated ? { type: 'event', text: redact(text).text } : { type: 'user', message: { role: 'user', content: redact(text).text } });

    // What the editor changes in this turn is kept for /undo in one folder, however many requests the turn takes.
    const undoFolder = nextUndoTurn(undoDir());
    let continued = false;
    for (;;) {
      const outcome = await converse(db, params, {
        send: sendAs,
        // A command the sandbox kept from writing is put to the user as an MCP call off the allow list is, for one run outside it.
        ctx: { ...workspace(), seen, undo: undoFolder, approve },
        ledger,
        beforeTool,
        concurrent: (call) => call.name === DELEGATE_TOOL.name,
        signal: stopper.signal,
        inbox: heard,
        onOutput: (call, chunk) => watch({ type: 'output', call, chunk }),
        onText: emit,
        onThinking: (_delta, snapshot) => watch({ type: 'thinking', text: snapshot }),
        onRetry: (r) => {
          activity(retryLine(r));
          watch({ type: 'retry', ...r });
        },
        onTool: (call) => {
          activity(describeCall(call));
          watch({ type: 'tool', call });
          noteCall(call);
        },
        onResult: (call, result) => watch({ type: 'result', call, result }),
        onTurn: (response, totals) => {
          lastContext = totals.contextTokens;
          logLine(transcript, { type: 'assistant', message: { role: 'assistant', model: response.model ?? params.model, usage: response.usage, content: response.content } });
          watch({ type: 'usage', totals });
          overBudget();
          // What the reply rests on, said under it: the pages it cites.
          const sources = sourcesOf(response.content);
          if (sources.length > 0) watch({ type: 'sources', sources });
        },
      });
      // Pictures the API refused would ride along with every later turn and be refused again: a turn refused before the model saw it keeps only its words.
      // Only a refusal of the request itself (a 4xx); a rate limit, an overload or a dropped connection says nothing against the pictures.
      const rejected = outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429;
      if (outcome.stop === 'error' && rejected && pictures.length > 0 && !params.messages.slice(at + 1).some((m) => m.role === 'assistant')) params.messages[at].content = [{ type: 'text', text }, ...events];
      // Stopped by the user: the turn still ended, so the scribe is woken, but nothing is asked of memory and nothing continues.
      if (outcome.stop === 'interrupted') {
        event('stop', { stop_hook_active: true });
        return outcome;
      }
      // The check before the user, and memory before the user: a turn ending on an edit nothing checked, or on a question
      // memory can answer, is told so and continued, once. Only a turn the model ended itself: after an error or a cut-off
      // reply the turn is simply over, and the scribe still hears of it.
      const asked = outcome.stop === 'end_turn';
      const edited = [...unchecked].map((path) => relative(workspace().cwd, path));
      const checks = declared();
      const held = continued ? '' : event('stop', asked ? { last_assistant_message: outcome.text, stop_hook_active: false, edited, checks } : { stop_hook_active: true });
      if (!held) return outcome;
      const { context } = JSON.parse(held);
      if (context.includes('<check>')) watch({ type: 'check', edited, checks });
      params.messages.push(injection(context, params.model, params.messages));
      continued = true;
    }
  }

  /**
   * `/undo`: the files the editor changed in the last turn that changed any, put back as they were before it — one it
   * created is deleted — and the model told so with its next turn. Another walks back one turn more. The shell's changes
   * are not seen, so they are not undone.
   */
  function undo() {
    const done = undoLast(undoDir());
    if (!done) return 'nothing to undo: the editor has changed no file in this session — changes made through bash are not tracked';
    const { cwd: at } = workspace();
    const names = (list) => {
      const shown = list.map((path) => pathFrom(path, at));
      return shown.length === 1 ? shown[0] : `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
    };
    const what = [done.restored.length > 0 && `restored ${names(done.restored)}`, done.deleted.length > 0 && `deleted ${names(done.deleted)}, which that turn created`].filter(Boolean).join('; ');
    note = [note, `the user ran /undo: ${what}. View a file again before you edit it.`].filter(Boolean).join('\n');
    return `undid the last turn that changed files: ${what} — changes made through bash are not tracked, so they stay`;
  }

  /** `! <command>`: the user runs it themselves, where the model would be refused; the model sees what it printed. */
  async function shell(command) {
    stopper = new AbortController();
    const run = await runCommand(command, { cwd: workspace().cwd, env: process.env, signal: stopper.signal });
    const stopped = run.stopped === 'interrupted' ? `\n(${INTERRUPTED})` : '';
    const output = run.error ?? cap(run.output.trimEnd(), undefined, run.omitted).toWellFormed() + stopped;
    // The user sees what their command printed; the model is given what a tool would have given it — without secrets, and well-formed.
    const told = run.error ?? capRedacted(run.output.trimEnd(), undefined, run.omitted).toWellFormed() + stopped;
    settleTail();
    params.messages.push({ role: 'user', content: [{ type: 'text', text: `I ran \`${redact(command).text}\` myself:\n${told || '(no output)'}` }] });
    spoken = true;
    persist();
    return output;
  }

  /** A slash command is a sentence the user did not have to type; unknown ones are said back. A path is not one: the word after the slash stands alone. */
  function expand(line) {
    const m = /^\/(\w+)(?:\s+(.*))?$/s.exec(line);
    if (!m) return { text: line };
    const [, name, args = ''] = m;
    if (name === 'exit' || name === 'quit') return { control: 'quit' };
    if (name === 'new' || name === 'clear') return { control: 'new' };
    if (name === 'memory' || name === 'undo' || name === 'context') return { control: name };
    if (name === 'model' || name === 'resume' || name === 'mcp' || name === 'copy' || name === 'help' || name === 'stop' || name === 'export' || name === 'thinking') return { control: name, args: args.trim() };
    const make = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    return make ? { ...make(args.trim()), said: args.trim() } : { error: `no such command /${name} — one of: ${commands.map((c) => `/${c.name}`).join(' ')}` };
  }

  /** `/mcp`: the servers as `sumo mcp` lists them. They connect once, while the first turn is typed, so an early look waits for them. */
  async function mcp() {
    await connecting;
    return mcpLines(registry);
  }

  /** `/memory`: one page per chat, on this chat's store, gone when the chat is; asked for again, it is opened again. */
  async function memoryPage() {
    page ??= servePage(db, { unref: true }).catch((cause) => {
      page = null;
      throw cause;
    });
    const { url } = await page;
    openInBrowser(url);
    return `your memory, in the browser: ${url}`;
  }

  /** Where the work is, for the screen's margin: the directory the tools run in, the project's name for it, and the branch it is on. */
  function where() {
    const { cwd: at } = workspace();
    return { cwd: at, name: project?.slug ?? basename(at), branch: branchOf(at) };
  }

  /** What this session's requests have used so far, the jobs it delegated included: by the kind of conversation and the model, dearest first. */
  const usage = () =>
    sessionId
      ? db
          .prepare(
            `SELECT kind, model, COUNT(*) AS requests, COALESCE(SUM(input_tokens), 0) AS input, COALESCE(SUM(output_tokens), 0) AS output,
                    COALESCE(SUM(cache_read_tokens), 0) AS cached, COALESCE(SUM(cost_usd), 0) AS cost
               FROM model_runs WHERE session_id = ? GROUP BY kind, model ORDER BY cost DESC`,
          )
          .all(sessionId)
      : [];

  /** What this session's requests have cost so far, the jobs it delegated included: the ledger's own sum. */
  const spent = () => (sessionId ? db.prepare('SELECT COALESCE(SUM(cost_usd), 0) AS cost FROM model_runs WHERE session_id = ?').get(sessionId).cost : 0);

  /**
   * The session's cost said to the user the first time it passes `chat.budget` — on the screen, where a retry is said,
   * and never to the model: what to spend is the user's to weigh. Asked after every reply, a delegated job's included.
   */
  function overBudget() {
    const budget = Number(configured(db, 'chat.budget'));
    if (costSaid || !(budget > 0)) return;
    const cost = spent();
    if (cost < budget) return;
    costSaid = true;
    activity(budgetLine(cost));
    watch({ type: 'budget', text: budgetLine(cost) });
  }

  function end() {
    // Kept as it stands, reports not yet read with it, before the session is let go.
    if (sessionId) keepQuietly();
    event('session-end', {});
    if (lock) rmSync(lock, { force: true });
    lock = null;
  }

  return {
    start,
    say,
    interrupt: () => stopper?.abort(),
    /** Said to the chat while it works: read with the model's next request of this turn. */
    steer: (text) => void steers.push(text),
    unsteer,
    wake,
    stop,
    settle,
    /** The jobs at work in the background, by id. */
    running: () => [...stops.keys()],
    /** How many background jobs have reported and wait for a turn to read them. */
    waiting,
    where,
    spent,
    usage,
    tell,
    shell,
    undo,
    expand,
    memoryPage,
    mcp,
    route: setRoute,
    resume,
    /** The sessions that can be picked up, one line each, newest first. */
    saved: () => others().map((s) => sessionLine(s, now())),
    end,
    commands,
    get sessionId() {
      return sessionId;
    },
    /** Whether anything has been said in this session: one nobody spoke to is not kept, and there is nothing to pick up again. */
    get spoken() {
      return spoken;
    },
    get model() {
      return model;
    },
    get effort() {
      return effort;
    },
    get routed() {
      return routed;
    },
    get params() {
      return params;
    },
    get contextTokens() {
      return lastContext;
    },
  };
}

/** The chat on a real terminal: the screen in ui.mjs, loaded only here so no other `sumo` command pays for it. */
async function screen(db, { model, effort, resume }) {
  const { runUi } = await import('./ui.mjs');
  const events = new EventEmitter();
  const session = createChat(db, {
    model,
    effort,
    // On the screen a delegated job does not hold the turn: the user goes on working, and the report is read when it comes.
    background: true,
    out: (t) => events.emit('text', t),
    watch: (e) => events.emit(e.type, e),
    // A call waiting on the user's word goes to the screen, which answers it with a key.
    approve: (ask) => new Promise((resolve) => events.emit('approve', { ...ask, resolve })),
    // So does a question of the model's: its options are shown, and a pick or what is typed in the box answers it.
    ask: (question) => new Promise((resolve) => events.emit('ask', { ...question, resolve })),
  });
  try {
    await runUi({ session, events, resume, notify: configured(db, 'chat.notify') !== 'off', motion: configured(db, 'chat.motion') !== 'off' }).waitUntilExit();
    // The way back in, said as the screen closes: the command that picks this session up again, and what it cost.
    if (session.spoken) {
      const s = styles(colourEnabled());
      const cost = session.spent();
      process.stdout.write(`\n${s.dim(`  sumo chat --resume ${shortId(session.sessionId)} picks this session up again${cost >= 0.005 ? ` · it cost $${cost.toFixed(2)}` : ''}`)}\n\n`);
    }
  } finally {
    // Jobs still at work in the background are stopped with the chat, and let go of what they hold before it closes.
    await session.settle();
    session.end();
    await closeMcp();
  }
  return 0;
}

/**
 * The terminal. With a keyboard and a screen it is the full-screen chat; piped,
 * it is plain lines: a header, the prompt with the model in it, the reply
 * rendered as it streams, tool lines dim, errors red, a rule between turns.
 */
export async function chat(db, { model, effort, resume = null, send, input = process.stdin, output = process.stdout } = {}) {
  if (input.isTTY && output.isTTY) return screen(db, { model, effort, resume });
  const rl = createInterface({ input, output });
  // Every line is a turn. Lines that arrive while one is being answered wait here for theirs; a question would hear only the next.
  const lines = rl[Symbol.asyncIterator]();
  const s = styles(colourEnabled(output));
  const width = widthOf(output);
  // Piped in is not piped out: what the model or a command prints may reach a terminal, and only colour gets through to it.
  // A carriage return redraws a progress bar in place; as plain lines each redraw is a line of its own, not run into the next.
  const write = (t) => output.write(safeForTerminal(String(t).replace(/\r(?!\n)/g, '\n')));
  const reply = createRenderer(write, s, { width });
  const session = createChat(db, {
    model,
    effort,
    send,
    out: (t) => reply.write(t),
    activity: (line) => {
      reply.flush();
      write(`\n${s.dim(`  › ${line}`)}\n`);
    },
    // Piped, nobody answers a question: one of the model's is not asked, an MCP call not on the allow list is refused, and a server that failed is said.
    watch: (e) => {
      if (e.type === 'retry' && e.job === undefined) return write(`${s.dim(`  › ${retryLine(e)}`)}\n`);
      if (e.type === 'sources') return write(`\n${e.sources.map((page) => s.dim(`  ⎿  ${safeForTerminal(`${page.title} — ${page.url}`).replace(/\s+/g, ' ')}`)).join('\n')}\n`);
      if (e.type !== 'mcp') return;
      if (e.error) write(`${s.red(`mcp: ${e.error}`)}\n`);
      for (const server of e.servers.filter((x) => !x.ok)) write(`${s.red(`mcp ${server.name}: ${server.error}`)}\n`);
    },
  });
  const rule = () => write(`\n${s.dim('─'.repeat(width))}\n\n`);
  /** A line under what the user typed, as a tool's result is drawn: what a command did. */
  const result = (text) => write(`${s.dim(`  ⎿  ${text}`)}\n`);
  /** The header, then the memory block of a fresh session or the line that says what a resumed one is. */
  const show = (block, after = '') => {
    write(`${header({ route: routeLine(session), cwd: process.cwd() }, s)}\n\n`);
    if (block) write(`${renderBlock(block, s, { width })}\n`);
    if (after) result(after);
    rule();
  };
  if (resume) show('', session.resume(resume));
  else show(session.start('startup'));
  try {
    for (;;) {
      write(prompt({ route: routeLine(session), contextTokens: session.contextTokens }, s));
      const next = await lines.next();
      if (next.done) break;
      const line = next.value.trim();
      if (!line) continue;
      // What a line cannot do is said in red, and the next line is read: a refused command does not end the chat.
      try {
        if (line.startsWith('!')) {
          write(`${s.dim(await session.shell(line.slice(1).trim()))}\n`);
          rule();
          continue;
        }
        const { text, said, guide, control, args, error } = session.expand(line);
        if (error) {
          write(`${s.red(error)}\n`);
          continue;
        }
        if (control === 'quit') break;
        if (control === 'new') {
          session.end();
          write('\n');
          show(session.start('new'));
          continue;
        }
        if (control === 'resume') {
          if (!args) {
            const saved = session.saved();
            write(`${s.dim(saved.length > 0 ? saved.map((l) => `  ${l}`).join('\n') : '  no saved sessions')}\n`);
            continue;
          }
          const resumed = session.resume(args);
          write('\n');
          show('', resumed);
          continue;
        }
        if (control === 'model' || control === 'memory' || control === 'mcp' || control === 'undo') {
          result(control === 'model' ? session.route(args) : control === 'undo' ? session.undo() : control === 'mcp' ? (await session.mcp()).join('\n     ') : await session.memoryPage());
          continue;
        }
        if (control === 'context') {
          reply.write(contextReport({ contextTokens: session.contextTokens, rows: session.usage() }));
          reply.flush();
          write('\n');
          continue;
        }
        // The rest belong to the screen — a clipboard, a pager, jobs under the box — and are never sent to the model as words.
        if (control) {
          result(`/${control} is for the chat on a terminal screen`);
          continue;
        }
        write('\n');
        const outcome = await session.say(text, said, [], { guide });
        reply.flush();
        if (outcome.stop === 'error') write(`\n${s.red(`error: ${outcome.error}`)}\n`);
        if (stopReason(outcome.stop)) write(`\n${s.dim(stopReason(outcome.stop))}\n`);
        rule();
      } catch (cause) {
        reply.flush();
        write(`${s.red(cause.message)}\n`);
      }
    }
  } finally {
    session.end();
    rl.close();
    await closeMcp();
  }
  return 0;
}
