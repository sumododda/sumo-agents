import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { ago } from './card.mjs';
import { getMeta } from './db.mjs';
import { runDream } from './dream.mjs';
import { openWatchTab, runHerdr } from './herdr.mjs';
import { appendLive, endLive, getJob, guideFor, newJob, parseJobId, reportOf, startLive, tell as tellJob } from './jobs.mjs';
import { handleEvent } from './hooks.mjs';
import { contextFor, converse, paramsFor, runJob, runLines, sendToApi, stopReason, textOf, withMcp, withServers } from './loop.mjs';
import { closeMcp, compactInput, gateMcp, isMcpTool, mcpLines, mcpReady, splitMcpName } from './mcp.mjs';
import { assertOn, MODEL_IDS, MODELS, modelId, usableModels } from './catalog.mjs';
import { takeLock } from './lock.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { UsageError } from './memory.mjs';
import { openInBrowser, servePage } from './page.mjs';
import { getProject } from './projects.mjs';
import { redact } from './redact.mjs';
import { chooseChatRoute, EFFORTS } from './route.mjs';
import { outcomeLines, runScribe } from './scribe.mjs';
import { currentProject, describeSaved, findSaved, loadState, lockFile, saveState, savedSessions, sessionLine, shortId } from './sessions.mjs';
import { BASH_TOOL, cap, capRedacted, DELEGATE_TOOL, EDITOR_TOOL, INTERRUPTED, runCommand } from './tools.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { colourEnabled, createRenderer, header, prompt, renderBlock, safeForTerminal, styles, tilde, widthOf } from './tty.mjs';

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

// The guide comes with the command: from inside a project the tools cannot reach guides/ by a relative path, and the editor is jailed away from it.
const COMMANDS = {
  fix: (args) => `${guideFor('fix')}\n\nFollow that, in order, for this: ${args}`,
  feature: (args) => `${guideFor('feature')}\n\nFollow that, in order, for this: ${args}`,
  review: (args) => `Review this: ${args}\nCode written in this session is never reviewed in this session: delegate it to a reviewer (agent "reviewer", the task what was asked); then this is how to treat the findings:\n${guideFor('review').replace(/^[\s\S]*?\*\*Receiving a review\.\*\*\s*/, '')}`,
  dream: () => 'Run `sumo dream run` and tell me, in a few lines, what it changed and what it wants me to confirm.',
};

/**
 * What the command menu shows, in the order it shows it; the models `/model` offers are the ones that are on as it is typed.
 * The effort a model would keep comes first (`effortNow`), so Enter on the open menu keeps it rather than dropping to the lowest.
 */
export function commandList(db, { effortNow = () => null, saved = () => [] } = {}) {
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
    { name: 'new', hint: 'start a fresh session' },
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

/** One line per tool call, so the user can watch the work: the command, or the edit and its file. */
export function describeCall(call) {
  if (call.name === BASH_TOOL.name) return `$ ${String(call.input?.command ?? '').split('\n')[0].slice(0, 120)}`;
  if (call.name === DELEGATE_TOOL.name) return call.input?.job !== undefined ? `delegate j${call.input.job}` : `delegate ${call.input?.agent ?? 'worker'} — ${call.input?.title ?? ''}`;
  if (call.name === EDITOR_TOOL.name) return `${call.input?.command ?? 'edit'} ${tilde(call.input?.path ?? '')}${Array.isArray(call.input?.view_range) ? `:${call.input.view_range.join('-')}` : ''}`;
  if (isMcpTool(call.name)) {
    const { server, tool } = splitMcpName(call.name);
    return `${server} · ${tool}(${compactInput(call.input)})`;
  }
  return call.name;
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
export function jobPrinter(write, s, { width = 98, clean = (text) => text } = {}) {
  return {
    onStart: (job) => write(`⏺ ${s.bold(`j${job.id}`)} ${job.agent} · ${routeOf(job)} — ${job.title}\n`),
    onTool: (call) => write(`  ⏺ ${describeCall(call)}\n`),
    onResult: (call, result) => {
      const first = String(result.content ?? '').split('\n').find((l) => l.trim()) ?? '';
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

/** The session log, one JSON line per message, the shape the scribe reads assistant replies from and the gauge reads usage from. */
function logLine(file, entry) {
  appendFileSync(file, `${JSON.stringify({ timestamp: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}

function configured(db, key) {
  return getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key];
}

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
 */
export function createChat(db, { model, effort, cwd = process.cwd(), send = sendToApi, out = () => {}, activity = () => {}, watch = () => {}, herdr = runHerdr, env = process.env, route = chooseChatRoute, approve = null, now = () => new Date().toISOString() } = {}) {
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
  // The guides it names are read from wherever the chat was started: their paths are made absolute, or the model goes looking for them.
  const system = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8').trim().replaceAll(/(?<![\w/])guides\//g, `${join(REPO_ROOT, 'guides')}/`);
  const own = [BASH_TOOL, EDITOR_TOOL, DELEGATE_TOOL];
  /** The MCP servers of this process, once connected: their tools join the request, deferred, and their names the system prompt. */
  let registry = null;
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
  /** Said to the model with the next turn: that the session was picked up again. */
  let note = null;
  /** The jobs running here, each with what the user has said to it that it has not read yet. */
  const jobs = new Map();
  /** The projects a worker is running in: two in one working tree overwrite each other. */
  const workers = new Set();
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
    project = null;
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
    if (saved) {
      params.messages = saved.messages;
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

  /** The session as it stands, kept after every turn. A save that fails is said as the turn's error: the turn itself went fine. */
  function persist() {
    if (!spoken) return;
    try {
      saveState({ id: sessionId, messages: params.messages, model, effort, routed, cwd, contextTokens: lastContext, now: now() });
    } catch (cause) {
      throw new UsageError(`the session could not be saved: ${cause.message}`);
    }
  }

  /** The request from here on goes to this model at this effort; the conversation so far stays. */
  function apply({ model: m, effort: e }) {
    params.model = modelId(m);
    if (e && e !== 'none') params.output_config = { effort: e };
    else delete params.output_config;
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

  /** The project the work is in: the one whose card came in last, else none (tools then run where the chat was started). */
  function workspace() {
    const slug = currentProject(db, sessionId);
    if (slug && project?.slug !== slug) project = getProject(db, slug);
    return project ? contextFor(project) : contextFor({ path: cwd });
  }

  /** The workflow gate, the cheap-model passes and `delegate`; anything else is the tool's own business. */
  async function beforeTool(call) {
    if (call.name === DELEGATE_TOOL.name) return delegate(call.input ?? {}, call.id);
    if (isMcpTool(call.name)) return gateMcp(call, { approve, signal: stopper.signal });
    if (call.name !== BASH_TOOL.name) return null;
    const command = String(call.input?.command ?? '');
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
   * `delegate`: a job is made from the brief, or an open one picked up, and run here on its own route; the chat waits
   * for its report. Calls in one reply run side by side, but a worker has its project's working tree to itself.
   * `callId` is the delegate call's own, so a screen can show the job under the call that started it.
   */
  async function delegate(input, callId = null) {
    const { signal } = stopper;
    let claimed = null;
    const claim = (agent, slug) => {
      if (agent !== 'worker') return;
      if (workers.has(slug)) throw new UsageError(`a worker is already running in ${slug} — two in one working tree overwrite each other; wait for its report`);
      workers.add(slug);
      claimed = slug;
    };
    try {
      let id;
      let warnings = [];
      if (input.job !== undefined && input.job !== null) {
        const job = getJob(db, parseJobId(input.job));
        claim(job.agent, job.project);
        id = job.id;
      } else {
        const agent = input.agent ?? 'worker';
        const project = getProject(db, input.project ?? '');
        if (!project) throw new UsageError(`no project "${input.project ?? ''}" — the delegate call names one by its slug`);
        claim(agent, project.slug);
        activity(`briefing a ${agent}…`);
        ({ job: { id }, warnings } = await newJob(db, { project: project.slug, title: input.title, agent, task: input.task, guide: input.guide, reviews: input.reviews ?? undefined, testsMayChange: Boolean(input.tests_may_change), now: now() }));
      }
      const inbox = [];
      jobs.set(id, inbox);
      // Its work is written down as it happens, for `sumo job watch` — in a Herdr tab of its own, or any terminal —
      // and without its secrets, through the same redaction as what the model sees.
      const record = (t) => appendLive(id, redact(t).text);
      const live = jobPrinter(record, styles(false), { clean: (t) => redact(t).text });
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
          onTurn: live.onTurn,
        });
        ended = runLines(outcome);
        const report = reportOf(id);
        // Model-written, like any tool output: redacted before it reaches the chat's context. `job` is how it went, for the screen only.
        const { job, turns, totals } = outcome;
        return {
          content: capRedacted([...warnings, ...ended, ...(report ? ['', report] : [])].join('\n')),
          job: { id, status: job.status, turns, toolCalls: totals.toolCalls, costUsd: totals.costUsd, model: job.model, effort: job.effort, report: report ? redact(report).text : '' },
        };
      } catch (cause) {
        ended = [cause.message];
        throw cause;
      } finally {
        jobs.delete(id);
        endLive(id, ended.map((l) => redact(l).text));
        watch({ type: 'job-end', job: id });
      }
    } finally {
      if (claimed) workers.delete(claimed);
    }
  }

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
   */
  async function say(text, said = text, images = []) {
    const outcome = await turn(text, said, images);
    persist();
    return outcome;
  }

  async function turn(text, said, images) {
    stopper = new AbortController();
    // The servers connect while the first turn is typed; the first request waits for them, and Esc does not.
    if (!registry) {
      const stopped = new Promise((resolve) => stopper.signal.addEventListener('abort', () => resolve('stopped'), { once: true }));
      if ((await Promise.race([connecting, stopped])) === 'stopped') return { stop: 'interrupted', error: null, text: '' };
      params.tools = toolsNow();
      params.system[0].text = systemNow();
      if (registry.servers().length > 0 || registry.error) watch({ type: 'mcp', servers: registry.servers(), error: registry.error });
    }
    // On auto the router names this turn's model first; a router that cannot answer refuses the turn, and nothing of it reaches the conversation.
    if (model === 'auto') {
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
    // A resumed session is told so with its first turn, ahead of whatever else the turn brings in.
    const injected = [note, event('prompt', { prompt: said, context_tokens: lastContext })].filter(Boolean).join('\n');
    note = null;
    const pictures = images.flatMap(({ label, mediaType, data }) => [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: mediaType, data } }]);
    const at = params.messages.push({ role: 'user', content: [...pictures, { type: 'text', text }] }) - 1;
    spoken = true;
    if (injected) params.messages.push(injection(injected, params.model, params.messages));
    // The log keeps what memory keeps: the user's words without their secrets.
    logLine(transcript, { type: 'user', message: { role: 'user', content: redact(text).text } });

    let continued = false;
    for (;;) {
      const outcome = await converse(db, params, {
        send: sendAs,
        ctx: workspace(),
        ledger,
        beforeTool,
        concurrent: (call) => call.name === DELEGATE_TOOL.name,
        signal: stopper.signal,
        onText: emit,
        onTool: (call) => {
          activity(describeCall(call));
          watch({ type: 'tool', call });
        },
        onResult: (call, result) => watch({ type: 'result', call, result }),
        onTurn: (response, totals) => {
          lastContext = totals.contextTokens;
          logLine(transcript, { type: 'assistant', message: { role: 'assistant', model: response.model ?? params.model, usage: response.usage, content: response.content } });
          watch({ type: 'usage', totals });
        },
      });
      // Pictures the API refused would ride along with every later turn and be refused again: a turn refused before the model saw it keeps only its words.
      // Only a refusal of the request itself (a 4xx); a rate limit, an overload or a dropped connection says nothing against the pictures.
      const rejected = outcome.status >= 400 && outcome.status < 500 && outcome.status !== 429;
      if (outcome.stop === 'error' && rejected && pictures.length > 0 && !params.messages.slice(at + 1).some((m) => m.role === 'assistant')) params.messages[at].content = [{ type: 'text', text }];
      // Stopped by the user: the turn still ended, so the scribe is woken, but nothing is asked of memory and nothing continues.
      if (outcome.stop === 'interrupted') {
        event('stop', { stop_hook_active: true });
        return outcome;
      }
      // Memory before the user: a turn ending on a question memory can answer is given the answer and continued, once.
      // Only a turn the model ended itself: after an error or a cut-off reply the turn is simply over, and the scribe still hears of it.
      const asked = outcome.stop === 'end_turn';
      const held = continued ? '' : event('stop', asked ? { last_assistant_message: outcome.text, stop_hook_active: false } : { stop_hook_active: true });
      if (!held) return outcome;
      params.messages.push(injection(JSON.parse(held).context, params.model, params.messages));
      continued = true;
    }
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
    if (name === 'new' || name === 'memory') return { control: name };
    if (name === 'model' || name === 'resume' || name === 'mcp') return { control: name, args: args.trim() };
    const make = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    return make ? { text: make(args.trim()), said: args.trim() } : { error: `no such command /${name} — one of: ${commands.map((c) => `/${c.name}`).join(' ')}` };
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

  function end() {
    event('session-end', {});
    if (lock) rmSync(lock, { force: true });
    lock = null;
  }

  return {
    start,
    say,
    interrupt: () => stopper?.abort(),
    tell,
    shell,
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
    out: (t) => events.emit('text', t),
    watch: (e) => events.emit(e.type, e),
    // A call waiting on the user's word goes to the screen, which answers it with a key.
    approve: (ask) => new Promise((resolve) => events.emit('approve', { ...ask, resolve })),
  });
  try {
    await runUi({ session, events, resume }).waitUntilExit();
  } finally {
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
    // Piped, nobody answers a question: an MCP call not on the allow list is refused, and a server that failed is said.
    watch: (e) => {
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
        const { text, said, control, args, error } = session.expand(line);
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
        if (control === 'model' || control === 'memory' || control === 'mcp') {
          result(control === 'model' ? session.route(args) : control === 'mcp' ? (await session.mcp()).join('\n     ') : await session.memoryPage());
          continue;
        }
        write('\n');
        const outcome = await session.say(text, said);
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
