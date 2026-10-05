import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getMeta } from './db.mjs';
import { runDream } from './dream.mjs';
import { openJobTab, runHerdr } from './herdr.mjs';
import { clearOutcome, getJob, guideFor, outcomeFile, tell as tellJob } from './jobs.mjs';
import { handleEvent } from './hooks.mjs';
import { contextFor, converse, paramsFor, runJob, runLines, sendToApi, stopReason, textOf } from './loop.mjs';
import { assertOn, MODEL_IDS, MODELS, modelId, usableModels } from './catalog.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { UsageError } from './memory.mjs';
import { openInBrowser, servePage } from './page.mjs';
import { getProject } from './projects.mjs';
import { redact } from './redact.mjs';
import { chooseChatRoute, EFFORTS } from './route.mjs';
import { outcomeLines, runScribe } from './scribe.mjs';
import { currentProject } from './sessions.mjs';
import { BASH_TOOL, cap, capRedacted, EDITOR_TOOL, INTERRUPTED, runCommand } from './tools.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { colourEnabled, createRenderer, header, prompt, renderBlock, styles, widthOf } from './tty.mjs';

/**
 * The conversation the user has with Sumo: the same loop a job runs in, with
 * the session policy raised in process — the memory block first, a project's
 * card when it comes up, a taught workflow before the command it gates, memory
 * before a question goes to the user, the size of the context said once per
 * band — and the scribe woken when a turn ends. A `sumo job run` typed by the
 * model runs here, in this process, so the API key never enters a shell; the
 * job's work is shown as it happens, and the user can talk to it while it runs.
 * Inside Herdr every job gets a tab of its own, listed on the left: without `&`
 * the chat waits for it to close and reads how it ended, with `&` it carries
 * on. Outside Herdr a job runs here, and `&` is refused — Herdr is required.
 */

/** Models that take operator instructions as `role: "system"` messages mid-conversation; the others get them as text in the user turn. */
const SYSTEM_MESSAGES = new Set([MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.fable]);

// The guide comes with the command: from inside a project the tools cannot reach guides/ by a relative path, and the editor is jailed away from it.
const COMMANDS = {
  fix: (args) => `${guideFor('fix')}\n\nFollow that, in order, for this: ${args}`,
  feature: (args) => `${guideFor('feature')}\n\nFollow that, in order, for this: ${args}`,
  review: (args) => `Review this: ${args}\nCode written in this session is never reviewed in this session: create a reviewer job (sumo job new --agent reviewer, what was asked on stdin) and run it with sumo job run <id>; then this is how to treat the findings:\n${guideFor('review').replace(/^[\s\S]*?\*\*Receiving a review\.\*\*\s*/, '')}`,
  dream: () => 'Run `sumo dream run` and tell me, in a few lines, what it changed and what it wants me to confirm.',
};

/** What the command menu shows, in the order it shows it; the models `/model` offers are the ones that are on as it is typed. */
export function commandList(db) {
  const modelChoices = (given) => {
    const usable = usableModels(db);
    return given.length === 0 ? ['auto', ...usable] : given.length === 1 && usable.includes(given[0]) && given[0] !== 'haiku' ? EFFORTS : [];
  };
  return [
    { name: 'fix', hint: 'fix a bug, by guides/fix.md' },
    { name: 'feature', hint: 'build something, by guides/feature.md' },
    { name: 'review', hint: 'have a reviewer job judge something' },
    { name: 'dream', hint: 'tidy the memory and say what changed' },
    { name: 'model', hint: 'the route, or set it: auto, or a model and an effort', choices: modelChoices },
    { name: 'memory', hint: 'see the memory in the browser: say yes or no, edit, forget' },
    { name: 'new', hint: 'start a fresh session' },
    { name: 'exit', hint: 'leave' },
  ];
}

const JOB_RUN = /^\s*sumo\s+job\s+run\s+j?(\d+)\s*(&?)\s*$/;
/** The same command anywhere inside a longer one — piped, chained, under nohup: there it would start in the shell, which is given no credential. */
const JOB_RUN_INSIDE = /\bsumo\s+job\s+run\b/;
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
  if (call.name === EDITOR_TOOL.name) return `${call.input?.command ?? 'edit'} ${call.input?.path ?? ''}${Array.isArray(call.input?.view_range) ? `:${call.input.view_range.join('-')}` : ''}`;
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

/** What `sumo job run` prints on a terminal while it works — the lines the chat draws, one per thing, for a Herdr pane. */
export function jobPrinter(write, s) {
  return {
    onStart: (job) => write(`⏺ ${s.bold(`j${job.id}`)} ${job.agent} · ${routeOf(job)} — ${job.title}\n`),
    onTool: (call) => write(`  ⏺ ${describeCall(call)}\n`),
    onTurn: (response) => {
      const text = textOf(response.content);
      if (text) write(`${s.dim(text.split('\n').map((l) => `  ${l}`).join('\n'))}\n`);
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
 * `tell(text, id)` to any open job, through its inbox on disk. `herdr` runs
 * the Herdr CLI and `env` says whether this is a Herdr pane — both swapped in
 * tests; `poll` is how often a pane job is checked for its end. `route` is the
 * router asked for each turn's model when the model is `auto`.
 */
export function createChat(db, { model, effort, cwd = process.cwd(), send = sendToApi, out = () => {}, activity = () => {}, watch = () => {}, herdr = runHerdr, env = process.env, poll = 500, route = chooseChatRoute, now = () => new Date().toISOString() } = {}) {
  model ??= configured(db, 'chat.model');
  // A model the user turned off is not chatted on, however the chat came to be on it; auto reads the switches each turn.
  if (model !== 'auto' && MODELS.includes(model)) assertOn(db, model, 'sumo config chat.model <name>');
  effort ??= model === 'auto' ? null : configured(db, 'chat.effort');
  // Haiku takes no effort setting, however the chat came to be on it: by flag, by configuration, or by /model.
  if (modelId(model) === MODEL_IDS.haiku) effort = 'none';
  /** On auto, the route the last turn ran on; null otherwise. */
  let routed = null;
  const system = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8').trim();
  const tools = [BASH_TOOL, EDITOR_TOOL];
  let sessionId;
  let params;
  let transcript;
  let lastContext = 0;
  let project = null;
  let stopper = null;
  /** What the user has said to the job running here that it has not read yet; null while no job runs. */
  let inbox = null;
  let running = null;
  /** The memory page, once /memory has asked for it: the promise of its address. */
  let page = null;
  const ledger = { kind: 'chat', sessionId: null };
  const commands = commandList(db);

  const emit = (text) => out(text);
  /** The conversation as the model in hand can take it: one that takes no operator messages is sent them as text. The history itself is left alone, so a model that does take them still reads it from its cache. */
  const sendAs = (p, options) => send(SYSTEM_MESSAGES.has(p.model) ? p : { ...p, messages: p.messages.map((m) => (m.role === 'system' ? asText(m.content) : m)) }, options);

  function start(source) {
    sessionId = randomUUID();
    ledger.sessionId = sessionId;
    // A session carries nothing over but the route: it has read nothing yet, and no card has named a project in it.
    lastContext = 0;
    project = null;
    mkdirSync(join(paths().logs, 'sessions'), { recursive: true, mode: 0o700 });
    transcript = join(paths().logs, 'sessions', `${sessionId}.jsonl`);
    const block = handleEvent(db, 'session-start', { session_id: sessionId, cwd, transcript_path: transcript, source }, now());
    params = paramsFor({ model: model === 'auto' ? (routed?.model ?? CONFIG_DEFAULTS['chat.model']) : model, effort: model === 'auto' ? routed?.effort : effort, tools, system, text: block });
    return block;
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

  /** The workflow gate and the in-process job run; anything else is the tool's own business. */
  async function beforeTool(call) {
    if (call.name !== BASH_TOOL.name) return null;
    const command = String(call.input?.command ?? '');
    const gate = event('pre-tool', { tool_name: 'bash', tool_input: { command } });
    if (gate) return { content: JSON.parse(gate).deny, isError: true };
    const pass = PASS_RUN.exec(command);
    if (pass) {
      activity(`running the ${pass[1]} pass…`);
      return { content: outcomeLines(pass[1] === 'dream' ? await runDream(db, { force: true }) : await runScribe(db)).join('\n') };
    }
    const run = JOB_RUN.exec(command);
    if (!run) {
      if (!JOB_RUN_INSIDE.test(command)) return null;
      return { content: '`sumo job run <id>` goes alone in its command, nothing before or after it (append & for a pane the chat does not wait for): anywhere else it would start in the shell, which holds no API credential', isError: true };
    }
    const id = Number(run[1]);
    if (run[2] === '&' || env.HERDR_ENV) {
      const job = getJob(db, id);
      clearOutcome(id);
      const pane = openJobTab(herdr, { job, project: getProject(db, job.project), env });
      if (run[2] === '&') return { content: `started j${id} in a Herdr tab of its own (on the left, "j${id} ${job.agent}") — it reports when it closes; @j${id} <message> talks to it` };
      return waitForPane(job, pane);
    }
    activity(`running j${id}…`);
    inbox = [];
    running = id;
    try {
      const outcome = await runJob(db, id, {
        send: (p) => send(p, { signal: stopper.signal }),
        signal: stopper.signal,
        inbox: () => inbox.splice(0),
        onStart: (job) => watch({ type: 'job', job }),
        onTool: (call) => {
          activity(`j${id} ${describeCall(call)}`);
          watch({ type: 'tool', call, job: id });
        },
        onResult: (call, result) => watch({ type: 'result', call, result, job: id }),
        onTurn: (response) => {
          const text = textOf(response.content);
          if (text) watch({ type: 'said', job: id, text });
        },
      });
      return { content: runLines(outcome).join('\n') };
    } finally {
      inbox = null;
      running = null;
      watch({ type: 'job-end', job: id });
    }
  }

  /**
   * The job is in its tab; the chat waits here, as it would for a run of its own, until the run leaves its
   * outcome on disk. Esc ends the wait, not the job — it is another process, and the tab keeps it.
   */
  async function waitForPane(job, pane) {
    activity(`j${job.id} running in its Herdr tab…`);
    running = job.id;
    watch({ type: 'job', job, pane });
    try {
      while (!existsSync(outcomeFile(job.id))) {
        if (stopper.signal.aborted) {
          return { content: `stopped waiting for j${job.id} — it is still running in its Herdr tab ("j${job.id} ${job.agent}", on the left); sumo job show ${job.id} when it closes`, isError: true };
        }
        await new Promise((r) => setTimeout(r, poll));
      }
      return { content: readFileSync(outcomeFile(job.id), 'utf8').trimEnd() };
    } finally {
      running = null;
      watch({ type: 'job-end', job: job.id });
    }
  }

  /**
   * Something for a job. Without an id: the job this chat is on — here, or in the pane it is waiting on — or
   * false when there is none, so the caller can treat the words as its own. With an id: that job, through its
   * inbox on disk if it is not the one running here; a job that is not open is refused.
   */
  function tell(text, id) {
    const target = id ?? running;
    if (target === null || target === undefined) return false;
    if (inbox && target === running) {
      inbox.push(text);
      return true;
    }
    tellJob(db, target, text, now());
    return true;
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
    // On auto the router names this turn's model first; a router that cannot answer refuses the turn, and nothing of it reaches the conversation.
    stopper = new AbortController();
    if (model === 'auto') {
      let chosen;
      try {
        workspace();
        chosen = await route(db, { project, text });
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
    const injected = event('prompt', { prompt: said, context_tokens: lastContext });
    const pictures = images.flatMap(({ label, mediaType, data }) => [{ type: 'text', text: label }, { type: 'image', source: { type: 'base64', media_type: mediaType, data } }]);
    const at = params.messages.push({ role: 'user', content: [...pictures, { type: 'text', text }] }) - 1;
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
    const output = run.error ?? cap(`${run.stdout}${run.stderr}`.trimEnd()).toWellFormed() + stopped;
    // The user sees what their command printed; the model is given what a tool would have given it — without secrets, and well-formed.
    const told = run.error ?? capRedacted(`${run.stdout}${run.stderr}`.trimEnd()).toWellFormed() + stopped;
    settleTail();
    params.messages.push({ role: 'user', content: [{ type: 'text', text: `I ran \`${command}\` myself:\n${told || '(no output)'}` }] });
    return output;
  }

  /** A slash command is a sentence the user did not have to type; unknown ones are said back. A path is not one: the word after the slash stands alone. */
  function expand(line) {
    const m = /^\/(\w+)(?:\s+(.*))?$/s.exec(line);
    if (!m) return { text: line };
    const [, name, args = ''] = m;
    if (name === 'exit' || name === 'quit') return { control: 'quit' };
    if (name === 'new' || name === 'memory') return { control: name };
    if (name === 'model') return { control: name, args: args.trim() };
    const make = Object.hasOwn(COMMANDS, name) ? COMMANDS[name] : undefined;
    return make ? { text: make(args.trim()), said: args.trim() } : { error: `no such command /${name} — one of: ${commands.map((c) => `/${c.name}`).join(' ')}` };
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
  }

  return {
    start,
    say,
    interrupt: () => stopper?.abort(),
    tell,
    shell,
    expand,
    memoryPage,
    route: setRoute,
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
async function screen(db, { model, effort }) {
  const { runUi } = await import('./ui.mjs');
  const events = new EventEmitter();
  const session = createChat(db, { model, effort, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e) });
  try {
    await runUi({ session, events }).waitUntilExit();
  } finally {
    session.end();
  }
  return 0;
}

/**
 * The terminal. With a keyboard and a screen it is the full-screen chat; piped,
 * it is plain lines: a header, the prompt with the model in it, the reply
 * rendered as it streams, tool lines dim, errors red, a rule between turns.
 */
export async function chat(db, { model, effort, send, input = process.stdin, output = process.stdout } = {}) {
  if (input.isTTY && output.isTTY) return screen(db, { model, effort });
  const rl = createInterface({ input, output });
  // Every line is a turn. Lines that arrive while one is being answered wait here for theirs; a question would hear only the next.
  const lines = rl[Symbol.asyncIterator]();
  const s = styles(colourEnabled(output));
  const width = widthOf(output);
  const write = (t) => output.write(t);
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
  });
  const rule = () => write(`\n${s.dim('─'.repeat(width))}\n\n`);
  const show = (block) => {
    write(`${header({ route: routeLine(session), cwd: process.cwd() }, s)}\n\n${renderBlock(block, s, { width })}\n`);
    rule();
  };
  show(session.start('startup'));
  try {
    for (;;) {
      write(prompt({ route: routeLine(session), contextTokens: session.contextTokens }, s));
      const next = await lines.next();
      if (next.done) break;
      const line = next.value.trim();
      if (!line) continue;
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
      if (control === 'model' || control === 'memory') {
        try {
          write(`${s.dim(`  ⎿  ${control === 'model' ? session.route(args) : await session.memoryPage()}`)}\n`);
        } catch (cause) {
          write(`${s.red(cause.message)}\n`);
        }
        continue;
      }
      write('\n');
      const outcome = await session.say(text, said);
      reply.flush();
      if (outcome.stop === 'error') write(`\n${s.red(`error: ${outcome.error}`)}\n`);
      if (stopReason(outcome.stop)) write(`\n${s.dim(stopReason(outcome.stop))}\n`);
      rule();
    }
  } finally {
    session.end();
    rl.close();
  }
  return 0;
}
