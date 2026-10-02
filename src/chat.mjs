import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { appendFileSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { getMeta } from './db.mjs';
import { handleEvent } from './hooks.mjs';
import { contextFor, converse, paramsFor, runJob, runLines, sendToApi } from './loop.mjs';
import { MODEL_IDS } from './model.mjs';
import { ENTRY, paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { BASH_TOOL, cap, EDITOR_TOOL, INTERRUPTED, runCommand } from './tools.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { colourEnabled, createRenderer, header, prompt, renderBlock, styles, widthOf } from './tty.mjs';

/**
 * The conversation the user has with Sumo: the same loop a job runs in, with
 * the session policy raised in process — the memory block first, a project's
 * card when it comes up, a taught workflow before the command it gates, memory
 * before a question goes to the user, the size of the context said once per
 * band — and the scribe woken when a turn ends. A `mem job run` typed by the
 * model runs here, in this process, so the API key never enters a shell.
 */

/** Models that take operator instructions as `role: "system"` messages mid-conversation; the others get them as text in the user turn. */
const SYSTEM_MESSAGES = new Set([MODEL_IDS.opus, MODEL_IDS.sonnet, MODEL_IDS.fable]);

const COMMANDS = {
  fix: (args) => `Read guides/fix.md and follow it, in order, for this: ${args}`,
  feature: (args) => `Read guides/feature.md and follow it, in order, for this: ${args}`,
  review: (args) => `Review this: ${args}\nCode written in this session is never reviewed in this session: create a reviewer job (mem job new --agent reviewer, what was asked on stdin) and run it with mem job run <id>; then guides/review.md says how to treat the findings.`,
  dream: () => 'Run `mem dream run` and tell me, in a few lines, what it changed and what it wants me to confirm.',
};

/** What the command menu shows, in the order it shows it. */
export const COMMAND_LIST = [
  { name: 'fix', hint: 'fix a bug, by guides/fix.md' },
  { name: 'feature', hint: 'build something, by guides/feature.md' },
  { name: 'review', hint: 'have a reviewer job judge something' },
  { name: 'dream', hint: 'tidy the memory and say what changed' },
  { name: 'new', hint: 'start a fresh session' },
  { name: 'quit', hint: 'leave' },
];

const JOB_RUN = /^\s*mem\s+job\s+run\s+j?(\d+)\s*(&?)\s*$/;

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
 * result, and the running totals, for a screen that shows the work.
 */
export function createChat(db, { model, effort, cwd = process.cwd(), send = sendToApi, out = () => {}, activity = () => {}, watch = () => {}, now = () => new Date().toISOString() } = {}) {
  model ??= configured(db, 'chat.model');
  effort ??= configured(db, 'chat.effort');
  const system = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8').trim();
  const tools = [BASH_TOOL, EDITOR_TOOL];
  let sessionId;
  let params;
  let transcript;
  let lastContext = 0;
  let project = null;
  let stopper = null;
  const ledger = { kind: 'chat', sessionId: null };

  const emit = (text) => out(text);

  function start(source) {
    sessionId = randomUUID();
    ledger.sessionId = sessionId;
    mkdirSync(join(paths().logs, 'sessions'), { recursive: true, mode: 0o700 });
    transcript = join(paths().logs, 'sessions', `${sessionId}.jsonl`);
    const block = handleEvent(db, 'session-start', { session_id: sessionId, cwd, transcript_path: transcript, source }, now());
    params = paramsFor({ model, effort, tools, system, text: block });
    return block;
  }

  const event = (name, payload) => handleEvent(db, name, { session_id: sessionId, cwd, transcript_path: transcript, ...payload }, now());

  /** The project the work is in: the one whose card came in last, else none (tools then run where the chat was started). */
  function workspace() {
    const slug = db.prepare(`SELECT slug FROM session_injections WHERE session_id = ? AND slug NOT LIKE '%:%' ORDER BY ts DESC LIMIT 1`).get(sessionId)?.slug ?? null;
    if (slug && project?.slug !== slug) project = getProject(db, slug);
    return project ? contextFor(project) : contextFor({ path: cwd });
  }

  /** The workflow gate and the in-process job run; anything else is the tool's own business. */
  async function beforeTool(call) {
    if (call.name !== BASH_TOOL.name) return null;
    const command = String(call.input?.command ?? '');
    const gate = event('pre-tool', { tool_name: 'bash', tool_input: { command } });
    if (gate) return { content: JSON.parse(gate).deny, isError: true };
    const run = JOB_RUN.exec(command);
    if (!run) return null;
    const id = Number(run[1]);
    if (run[2] === '&') {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'job', 'run', String(id)], { detached: true, stdio: 'ignore', env: process.env });
      child.unref();
      return { content: `started j${id} in the background — mem job show ${id} for progress; it reports when it closes` };
    }
    activity(`running j${id}…`);
    return { content: runLines(await runJob(db, id, { send: (p) => send(p, { signal: stopper.signal }), signal: stopper.signal })).join('\n') };
  }

  async function say(text) {
    // A turn that ended before the model answered left its operator message at the tail; the API takes one only where the model answers next, so it becomes text.
    const tail = params.messages.at(-1);
    if (tail?.role === 'system') params.messages[params.messages.length - 1] = asText(tail.content);
    const injected = event('prompt', { prompt: text, context_tokens: lastContext });
    params.messages.push({ role: 'user', content: [{ type: 'text', text }] });
    if (injected) params.messages.push(injection(injected, params.model, params.messages));
    logLine(transcript, { type: 'user', message: { role: 'user', content: text } });

    stopper = new AbortController();
    let continued = false;
    for (;;) {
      const outcome = await converse(db, params, {
        send,
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
      // Stopped by the user: the turn still ended, so the scribe is woken, but nothing is asked of memory and nothing continues.
      if (outcome.stop === 'interrupted') {
        event('stop', { stop_hook_active: true });
        return outcome;
      }
      // Memory before the user: a turn ending on a question memory can answer is given the answer and continued, once.
      const held = continued ? '' : event('stop', { last_assistant_message: outcome.text, stop_hook_active: false });
      if (!held) return outcome;
      params.messages.push(injection(JSON.parse(held).context, params.model, params.messages));
      continued = true;
    }
  }

  /** `! <command>`: the user runs it themselves, where the model would be refused; the model sees what it printed. */
  async function shell(command) {
    stopper = new AbortController();
    const run = await runCommand(command, { cwd: workspace().cwd, env: process.env, signal: stopper.signal });
    const output = cap(`${run.stdout}${run.stderr}`.trimEnd()) + (run.stopped === 'interrupted' ? `\n(${INTERRUPTED})` : '');
    params.messages.push({ role: 'user', content: [{ type: 'text', text: `I ran \`${command}\` myself:\n${output || '(no output)'}` }] });
    return output;
  }

  /** A slash command is a sentence the user did not have to type; unknown ones are said back. */
  function expand(line) {
    const m = /^\/(\w+)\s*(.*)$/s.exec(line);
    if (!m) return { text: line };
    const [, name, args] = m;
    if (name === 'new' || name === 'quit') return { control: name };
    const make = COMMANDS[name];
    return make ? { text: make(args.trim()) } : { error: `no such command /${name} — one of: /fix /feature /review /dream /new /quit` };
  }

  function end() {
    event('session-end', {});
  }

  return {
    start,
    say,
    interrupt: () => stopper?.abort(),
    shell,
    expand,
    end,
    get sessionId() {
      return sessionId;
    },
    get model() {
      return model;
    },
    get effort() {
      return effort;
    },
    get params() {
      return params;
    },
    get contextTokens() {
      return lastContext;
    },
  };
}

/** The chat on a real terminal: the screen in ui.mjs, loaded only here so no other `mem` command pays for it. */
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
export async function chat(db, { model, effort } = {}) {
  if (process.stdin.isTTY && process.stdout.isTTY) return screen(db, { model, effort });
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const s = styles(colourEnabled());
  const width = widthOf();
  const write = (t) => process.stdout.write(t);
  const reply = createRenderer(write, s, { width });
  // A closed stdin never answers a question; the close event is the answer.
  const closed = new Promise((resolve) => rl.once('close', () => resolve(null)));
  const session = createChat(db, {
    model,
    effort,
    out: (t) => reply.write(t),
    activity: (line) => {
      reply.flush();
      write(`\n${s.dim(`  › ${line}`)}\n`);
    },
  });
  const rule = () => write(`\n${s.dim('─'.repeat(width))}\n\n`);
  const show = (block) => {
    write(`${header({ model: session.model, effort: session.effort, cwd: process.cwd() }, s)}\n\n${renderBlock(block, s, { width })}\n`);
    rule();
  };
  show(session.start('startup'));
  try {
    for (;;) {
      const answer = await Promise.race([rl.question(prompt({ model: session.model, effort: session.effort, contextTokens: session.contextTokens }, s)).catch(() => null), closed]);
      if (answer === null) break;
      const line = answer.trim();
      if (!line) continue;
      if (line.startsWith('!')) {
        write(`${s.dim(await session.shell(line.slice(1).trim()))}\n`);
        rule();
        continue;
      }
      const { text, control, error } = session.expand(line);
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
      write('\n');
      const outcome = await session.say(text);
      reply.flush();
      if (outcome.stop === 'error') write(`\n${s.red(`error: ${outcome.error}`)}\n`);
      rule();
    }
  } finally {
    session.end();
    rl.close();
  }
  return 0;
}
