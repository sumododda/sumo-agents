import { spawn, spawnSync } from 'node:child_process';
import { accessSync, closeSync, constants, existsSync, fstatSync, ftruncateSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { delimiter, dirname, extname, join, relative, resolve, sep } from 'node:path';
import { CREDENTIAL_NAMES } from './auth.mjs';
import { guardCommand, guardPath } from './guard.mjs';
import { SELF } from './paths.mjs';
import { redact } from './redact.mjs';
import { blockedWrite, guardedPlaces, guardedWhy, readOnlyPlaces, sandboxWrap, unsandboxable, writablePlaces } from './sandbox.mjs';

/**
 * The two tools a job gets, and the policy every call passes through before it
 * runs: command guards, the editor's path jail, output caps, and redaction.
 * Shell commands read what the user can; on macOS they write only where the sandbox lets them, and command guards match known patterns.
 */

/** Anthropic-defined, schema-less on the wire: the API knows their shape, so no schema is sent. */
export const BASH_TOOL = { type: 'bash_20250124', name: 'bash' };
export const EDITOR_TOOL = { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' };

/** The chat's own: hands a piece of work to a sub-agent with a fresh context. Its report is the call's answer, or — in the background — comes later. Several in one reply run at once. */
export const DELEGATE_TOOL = {
  name: 'delegate',
  description:
    'Hand a piece of work to a sub-agent with a fresh context: scout looks — at the code or on the web (no edits), worker builds, reviewer judges a change it did not write. ' +
    'It runs on its own route. Its report is this call\'s result — or, when the result says the job is running in the background, it reaches you later ' +
    'as an automated event. Several calls in one reply run at the same time; one worker per project at a time. ' +
    'To continue an open job instead (one from an earlier session), give only `job`.',
  input_schema: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['scout', 'worker', 'reviewer'] },
      project: { type: 'string', description: 'the project slug' },
      title: { type: 'string', description: 'a few words' },
      task: { type: 'string', description: 'the brief, a contract: ## Goal, ## Non-goals, ## Must not change, ## Check (the command that proves it, or why none), ## Report' },
      guide: { type: 'string', enum: ['fix', 'feature', 'none'], description: 'carry guides/<guide>.md into the brief; unsaid, a worker gets the one its title and goal ask for, if any' },
      reviews: { type: 'integer', description: 'reviewer only: the worker job whose change to judge; without it, the uncommitted change' },
      tests_may_change: { type: 'boolean', description: 'worker only: existing tests may be edited' },
      attempts: { type: 'integer', description: 'worker only, for a hard task: 2 or 3 attempts in worktrees of their own, the best verified one kept; costs that many times as much' },
      job: { type: 'integer', description: 'continue this open job; nothing else is given' },
    },
  },
};

/** The chat's own: a question only the user can answer, put to them with options to pick from; the pick, or what they typed instead, is the call's answer. */
export const ASK_TOOL = {
  name: 'ask',
  description:
    'Put a question to the user and wait for the answer. Use it before building, when the request leaves open what to build — scope, behaviour, ' +
    'which approach — and neither memory nor the code settles it; never for what you can look up, or decide and cheaply undo. ' +
    'Give 2–4 options, the one you would pick first; the user picks one, or types an answer of their own. ' +
    'One question a call; several calls in one reply are put one after another.',
  input_schema: {
    type: 'object',
    properties: {
      question: { type: 'string', description: 'the whole question: the user sees this and the options, nothing else' },
      options: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string', description: 'a few words' }, detail: { type: 'string', description: 'what choosing it means, in a line' } },
          required: ['label'],
        },
      },
    },
    required: ['question', 'options'],
  },
};

const OUTPUT_CAP_CHARS = 16_000;
const VIEW_CAP_LINES = 400;
const COMMAND_TIMEOUT_MS = 540_000; // the same nine minutes a check gets
/** How long the model's command may print nothing: one waiting on a prompt or a hung server gives the turn back in two minutes, not nine. */
const IDLE_TIMEOUT_MS = 120_000;
/** The most a `timeout N` in front of a command can ask for. */
const ASKED_MAX_S = 1800;
const MAX_BUFFER_CHARS = 64 * 1024 * 1024;
/** What is held of a command's output at each end: more than any cap keeps, so the cut is always made by the cap, never here. */
const KEPT_EACH_END = 64 * 1024;

/** A stream's first and last KEPT_EACH_END characters, and how many fell between them — never the whole flood. */
function keeper() {
  let head = '';
  let tail = '';
  let total = 0;
  return {
    push(chunk) {
      total += chunk.length;
      const room = KEPT_EACH_END - head.length;
      if (room > 0) {
        head += chunk.slice(0, room);
        chunk = chunk.slice(room);
      }
      if (chunk) tail = (tail + chunk).slice(-KEPT_EACH_END);
    },
    get text() {
      return head + tail;
    },
    get omitted() {
      return total - head.length - tail.length;
    },
  };
}

/** The shell a command runs in: bash, which the tool is named for, where there is one. */
const SHELL = existsSync('/bin/bash') ? '/bin/bash' : true;
/**
 * What is spawned for a command: the shell, or — under a wrapper, the sandbox — the wrapper, which execs into bash in
 * place, so the pid and its process group are the shell's. The sandbox is only on macOS, where there is always a /bin/bash.
 */
function spawnShell(command, wrap, options) {
  return wrap ? spawn(wrap[0], [...wrap.slice(1), '/bin/bash', '-c', command], options) : spawn(command, { ...options, shell: SHELL });
}
/** Why a command never started: the reason, and a directory that is gone is the usual one. */
const unstartedWhy = (cause, cwd) => `the command could not be started: ${cause.message}${cwd && !existsSync(cwd) ? ` — ${cwd} does not exist` : ''}`;
/** How long the pipes are drained once the shell has gone, for output already on its way. */
const DRAIN_MS = 200;
/** `sumo job baseline|verify|finish` run the project's checks, each under its own limit. */
const OWN_LIMITS = /^\s*sumo\s+job\s+(baseline|verify|finish)\b/;

/** The process groups of the commands still running: when this process is told to go, they go first. */
const live = new Set();
let watching = false;
export const killGroup = (pid) => {
  // A spawn that failed reports pid 0, and -0 is 0: the caller's own group.
  if (!(pid > 0)) return;
  try {
    process.kill(-pid, 'SIGKILL');
  } catch {
    // Nothing left to kill.
  }
};
/** A child of this process whose whole group goes when this process does: a command's, or an MCP server's. */
export function trackGroup(pid) {
  live.add(pid);
  if (watching) return;
  watching = true;
  process.on('exit', () => {
    for (const group of live) killGroup(group);
  });
  // A terminal closed, or a kill: leave as the signal would, after the commands — exit runs the line above.
  process.on('SIGHUP', () => process.exit(129));
  process.on('SIGTERM', () => process.exit(143));
  // Ctrl-C too, which a group of its own never hears — unless this process already answers Ctrl-C itself (a job run
  // stops the job and says how it ended). The chat's screen is unchanged: in raw mode Ctrl-C is a key, not a signal.
  if (process.listenerCount('SIGINT') === 0) process.on('SIGINT', () => process.exit(130));
}

/** What a command's output ends with when the user stopped it. */
export const INTERRUPTED = 'stopped: interrupted by the user';

/**
 * The environment a tool's child process gets: the user's own, without Sumo's credential. The tokens the user exported
 * are theirs to use — a smoke test needs one — while the guard refuses printing the lot, and a secret printed is redacted.
 */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !CREDENTIAL_NAMES.includes(name)));
}

/** What keeps git and ssh from waiting on somebody at a keyboard: no password asked, no editor, no pager, ssh in batch mode. */
const NO_PROMPTS = { GIT_TERMINAL_PROMPT: '0', GIT_EDITOR: 'true', GIT_PAGER: 'cat', PAGER: 'cat', GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };

/** Whether git's config where a command runs names an ssh command of its own, asked of git once for each directory. */
const sshCommands = new Map();
function hasSshCommand(cwd, env) {
  if (!sshCommands.has(cwd)) {
    const asked = spawnSync('git', ['config', '--get', 'core.sshCommand'], { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: PARSE_TIMEOUT_MS });
    sshCommands.set(cwd, asked.status === 0 && asked.stdout.trim() !== '');
  }
  return sshCommands.get(cwd);
}

/**
 * The environment of a command of the model's, which nobody answers — its stdin is closed — so it never waits on a
 * prompt: each of NO_PROMPTS where the environment has not set it already. An ssh command of the user's own, in the
 * environment or in git's config, is theirs: it stands, and is not replaced by one in batch mode.
 */
function unprompted(env, cwd) {
  const ownSsh = env.GIT_SSH !== undefined || env.GIT_SSH_COMMAND !== undefined || hasSshCommand(cwd, env);
  const { GIT_SSH_COMMAND, ...rest } = NO_PROMPTS;
  return { ...rest, ...(ownSsh ? {} : { GIT_SSH_COMMAND }), ...env };
}

/**
 * Keeps both ends of a long output. The head says what ran and the tail is
 * where runners put the failures; the middle is the part worth losing, and the
 * marker says how much went and how to get a narrower answer.
 */
export function cap(text, max = OUTPUT_CAP_CHARS, omitted = 0) {
  if (text.length <= max && omitted === 0) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n${cutMark(text.length - 2 * half + omitted)}\n${text.slice(-half)}`;
}

/** The cut, and the way to what was cut: the file holding the output when there is one, else a narrower command. */
const cutMark = (cut, kept = null) =>
  `[cut ${cut} characters from the middle — ${kept ? `the first and last ${KEPT_EACH_END / 1024} KB of the output are in ${kept}: read a range of it, or ` : ''}narrow the command: tail, grep, or a line range]`;

/**
 * cap(), with the secrets taken out of what survives it. They are looked for before the cut, in a margin around each
 * end that is kept, so a key the cut would split is still whole when it is found — and a flood of output is never
 * scanned whole. `kept` names the file the whole of it went to, when it went somewhere.
 */
export function capRedacted(text, max = OUTPUT_CAP_CHARS, omitted = 0, kept = null) {
  // Capped after redacting too: what redaction adds — a marker for each hidden character — counts against the cap.
  if (text.length <= max && omitted === 0) {
    const out = redact(text).text;
    return out.length <= max ? out : cap(out, max);
  }
  return cutBetween(text, text, text.length - 2 * Math.floor(max / 2) + omitted, max, kept);
}

/** The start of `head` and the end of `tail`, half the cap each and without their secrets, and the cut between them said. */
function cutBetween(head, tail, cut, max, kept) {
  const half = Math.floor(max / 2);
  return `${redact(head.slice(0, half + max)).text.slice(0, half)}\n${cutMark(cut, kept)}\n${redact(tail.slice(-(half + max))).text.slice(-half)}`;
}

/** The longest a line of output or of a viewed file is shown whole: a minified bundle or a line of JSON past it is its start, and how much was cut. */
const LINE_CAP_CHARS = 2_000;

/** A line no longer than LINE_CAP_CHARS. Its secrets go before the cut, which could otherwise leave the start of one that is no longer recognised. */
function cutLine(line) {
  if (line.length <= LINE_CAP_CHARS) return line;
  const clean = redact(line).text;
  return clean.length <= LINE_CAP_CHARS ? clean : `${clean.slice(0, LINE_CAP_CHARS)}[… ${clean.length - LINE_CAP_CHARS} chars cut]`;
}

/** A line a progress bar rewrote in place with carriage returns, as it was left: its last state that is not blank. One ending in \r\n keeps its ending. */
function lastState(line) {
  const end = line.endsWith('\r') ? '\r' : '';
  const body = end ? line.slice(0, -1) : line;
  return body.includes('\r') ? `${body.split('\r').findLast((state) => state.trim() !== '') ?? ''}${end}` : line;
}

/**
 * What the model is shown of a command's output, before the cap, so the cap keeps more of what was said: each line a
 * progress bar rewrote as it was left, a run of three or more of the same line as the line and how many more there
 * were — where that is shorter — and a line too long to read cut to its start. `cut` counts the lines cut short: what
 * they held is in the spill file only.
 */
export function tidy(output) {
  const lines = output.split('\n').map(lastState);
  const shown = [];
  let cut = 0;
  for (let i = 0; i < lines.length; ) {
    let end = i + 1;
    while (end < lines.length && lines[end] === lines[i]) end++;
    const fold = `[… the same line ${end - i - 1} more times]`;
    const folded = end - i >= 3 && fold.length < (end - i - 1) * (lines[i].length + 1);
    const times = folded ? 1 : end - i;
    if (lines[i].length > LINE_CAP_CHARS) cut += times;
    shown.push(...Array(times).fill(cutLine(lines[i])), ...(folded ? [fold] : []));
    i = end;
  }
  return { text: shown.join('\n'), cut };
}

/**
 * A command's output as the model is shown it: tidied, then capped, the cut said and the way to what was cut — `kept`,
 * the spill file, when there is one. Of a flood only the two ends were held: each is tidied on its own, and the cut
 * between them stays where it was. `cut` counts the lines cut short; `capped` is whether the cap cuts too.
 */
function shownOf(output, omitted) {
  const ends = omitted > 0 ? [tidy(output.slice(0, KEPT_EACH_END)), tidy(output.slice(KEPT_EACH_END))] : [tidy(output)];
  const capped = omitted > 0 || ends[0].text.length > OUTPUT_CAP_CHARS;
  const show = (kept) => {
    if (ends.length === 1) return capRedacted(ends[0].text, OUTPUT_CAP_CHARS, 0, kept) + (kept && !capped ? `\n[a line cut short is whole in ${kept}]` : '');
    const [head, tail] = ends.map((end) => end.text);
    const half = Math.floor(OUTPUT_CAP_CHARS / 2);
    return cutBetween(head, tail, Math.max(0, head.length - half) + omitted + Math.max(0, tail.length - half), OUTPUT_CAP_CHARS, kept);
  };
  return { cut: ends.reduce((n, end) => n + end.cut, 0), capped, show };
}

/** How long a saved output is kept: long enough to be read back by a run picked up tomorrow, not a disk full of old logs. */
const SPILL_KEEP_MS = 7 * 24 * 3_600_000;
let spilled = 0;

/**
 * What was kept of an output too long to show — its two ends, the gap between them said — written where the model can
 * read a range of it instead of running the command again: the job's folder, or the logs. Without its secrets, like
 * everything that leaves a command; older files there go. Nowhere to write it is no file, and the cut says so.
 */
function spill(dir, output, omitted) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    for (const name of readdirSync(dir)) {
      const old = join(dir, name);
      if (Date.now() - statSync(old).mtimeMs > SPILL_KEEP_MS) rmSync(old, { force: true });
    }
    const file = join(dir, `${Date.now()}-${process.pid}-${spilled++}.txt`);
    const text = omitted > 0 ? `${output.slice(0, KEPT_EACH_END)}\n[… ${omitted} characters between here and the end were not kept …]\n${output.slice(KEPT_EACH_END)}` : output;
    writeFileSync(file, redact(text).text.toWellFormed(), { mode: 0o600 });
    return file;
  } catch {
    return null;
  }
}

/**
 * The real path of the deepest ancestor that exists, so a symlink cannot point a new file outside the jail. A link
 * whose target does not exist yet is judged by where it points, not by the directory it sits in.
 */
function realAncestor(path, hops = 0) {
  let probe = path;
  while (!existsSync(probe)) {
    if (hops < 40 && isLink(probe)) return realAncestor(resolve(dirname(probe), readlinkSync(probe)), hops + 1);
    const up = dirname(probe);
    if (up === probe) return probe;
    probe = up;
  }
  return realpathSync.native(probe);
}

const isLink = (path) => {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
};

/** An absolute path under one of the roots, or an Error saying which it is outside of. */
export function jailed(path, { cwd, roots }) {
  if (typeof path !== 'string' || !path) throw new Error('a path is required');
  // resolve() also tidies an absolute path: a .. after a directory that does not exist yet must not climb past the check.
  const absolute = resolve(cwd, path);
  const real = realAncestor(absolute);
  const allowed = roots.map((r) => realpathSync.native(r)).some((r) => real === r || real.startsWith(`${r}/`));
  if (!allowed) throw new Error(`${path} is outside the project (${roots[0]}) — work only inside it`);
  return absolute;
}

/** What goes back to the model: without secrets, and well-formed — a cut that fell inside an emoji must not leave half of it in every later request. */
const result = (content, isError = false) => ({ content: redact(String(content)).text.toWellFormed(), isError });

/**
 * Runs a shell command beside the process, not in front of it, so the screen
 * keeps drawing while it runs. It ends when the shell does, when `signal`
 * says stop, or when `timeoutMs` is up — whichever is first. The command
 * always gets a process group of its own, so a stop or the time limit reaches
 * everything it started, and so does this process being told to go. A child
 * left in the background does not hold the call: once the shell has gone, the
 * output already on its way is drained and the command is over. `onOutput` is
 * handed each piece as it is printed, for a screen that shows the work.
 * `idleMs` stops a command that has printed nothing for that long; `wrap` is
 * what the shell runs under — the sandbox.
 */
export function runCommand(command, { cwd, env, signal = null, timeoutMs = null, idleMs = null, onOutput = null, wrap = null }) {
  return new Promise((resolve) => {
    const child = spawnShell(command, wrap, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    if (child.pid) trackGroup(child.pid);
    let drain = null;
    // Each stream, and both together in the order they came, so an error stays beside the step that printed it.
    const kept = { stdout: keeper(), stderr: keeper(), output: keeper() };
    let size = 0;
    let stopped = null;
    let unstarted = null;
    let settled = false;
    const interrupt = () => kill('interrupted');
    const timer = timeoutMs === null ? null : setTimeout(() => kill('timeout'), timeoutMs);
    // The silence is counted again from every piece of output.
    let idle = null;
    const heard = () => {
      if (idleMs === null) return;
      clearTimeout(idle);
      idle = setTimeout(() => kill('idle'), idleMs);
    };
    heard();
    const settle = (status, killedBy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(idle);
      clearTimeout(drain);
      signal?.removeEventListener('abort', interrupt);
      live.delete(child.pid);
      resolve({ stdout: kept.stdout.text, stderr: kept.stderr.text, output: kept.output.text, omitted: kept.output.omitted, status, signal: killedBy, stopped, error: unstarted });
    };
    // What was stopped is not waited for: a child left in the background can hold the pipes open long after the shell is gone.
    const release = (status, killedBy) => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle(status, killedBy);
    };
    function kill(why) {
      stopped ??= why;
      killGroup(child.pid);
      if (child.exitCode !== null || child.signalCode !== null) release(child.exitCode, child.signalCode);
    }
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BUFFER_CHARS) kill('overflow');
        else {
          heard();
          kept[name].push(chunk);
          kept.output.push(chunk);
          onOutput?.(chunk);
        }
      });
    }
    child.on('error', (cause) => {
      // Never started, so there is no output and no exit to report: the reason is the answer, and a directory that is gone is the usual one.
      unstarted = unstartedWhy(cause, cwd);
      settle(null, null);
    });
    child.on('close', settle);
    child.on('exit', (status, killedBy) => {
      // The shell is gone: what is still draining is not a silence to stop.
      clearTimeout(idle);
      if (stopped) release(status, killedBy);
      else drain = setTimeout(() => release(status, killedBy), DRAIN_MS);
    });
    if (signal?.aborted) interrupt();
    else signal?.addEventListener('abort', interrupt, { once: true });
  });
}

/** Said once in a process whose shell cannot be sandboxed: with the first result that would have been. */
let toldUnsandboxed = false;

/**
 * The sandbox a command of the model's runs under: on unless the context turns it off (`sandbox: false`, from the
 * user's `shell.sandbox off`), where there is one, and with the network past this machine closed when the context says
 * so (`network: false`, from `shell.network off`). `wrap` is null when it runs without; `note` says why, the first time.
 */
function jailOf(ctx) {
  if (ctx.sandbox === false) return { wrap: null, writable: [], readOnly: [], note: '' };
  const why = unsandboxable();
  if (why) {
    const note = toldUnsandboxed ? '' : `\n(the shell is not sandboxed: ${why} — a command can write wherever the user can)`;
    toldUnsandboxed = true;
    return { wrap: null, writable: [], readOnly: [], note };
  }
  const writable = writablePlaces(ctx.roots, { opened: ctx.opened ?? [] });
  const readOnly = [...new Set([...readOnlyPlaces(ctx.roots), ...guardedPlaces(ctx.roots)])];
  const offline = ctx.network === false;
  return { wrap: sandboxWrap(writable, { readOnly, network: !offline }), writable, readOnly, offline, note: '' };
}

/** What a job's own tools run the project's checks under: the sandbox its shell is in, or nothing where the shell has none. */
export const checksWrap = (ctx) => (ctx.sandbox === false || unsandboxable() ? null : jailOf(ctx).wrap);

/** `timeout <N> ` in front of a command, N in seconds or with a unit, in its plainest spelling only: flags are the binary's business. */
const ASKED = /^\s*timeout\s+(\d+)([smh]?)\s+(?=\S)/;
const UNIT_S = { '': 1, s: 1, m: 60, h: 3600 };

/**
 * The limit a command asks for with `timeout N` in front, at most half an hour: both how long it may run and how long
 * it may be silent. macOS has no `timeout`: without one on the PATH the prefix is taken off, and the limit is kept here
 * alone. Null for a command that asks for nothing.
 */
export function askedLimit(command, path) {
  const asked = ASKED.exec(command);
  if (!asked) return null;
  const seconds = Math.min(Number(asked[1]) * UNIT_S[asked[2]] || ASKED_MAX_S, ASKED_MAX_S);
  return { ms: seconds * 1000, command: onPath('timeout', path) ? command : command.slice(asked[0].length) };
}

/** Whether a program is on a PATH, looked for once for each PATH. */
const found = new Map();
function onPath(name, path = '') {
  const key = `${name}\0${path}`;
  if (!found.has(key)) {
    const runnable = (file) => {
      try {
        accessSync(file, constants.X_OK);
        return statSync(file).isFile();
      } catch {
        return false;
      }
    };
    found.set(key, path.split(delimiter).some((dir) => dir && runnable(join(dir, name))));
  }
  return found.get(key);
}

/**
 * The command without its last `&`, when it ends in one that stands alone — not `&&`, `|&` or `>&`, and not quoted,
 * escaped or in a comment: the model asking for it to run in the background. Read conservatively — one line, no
 * here-document — so a command that only might mean it runs as it always has. Null otherwise.
 */
export function backgrounded(command) {
  const text = command.trimEnd();
  if (!text.endsWith('&') || text.includes('\n') || text.includes('<<')) return null;
  let quote = null;
  for (let i = 0; i < text.length - 1; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === '\\' && quote === '"') i++;
    } else if (c === '\\') i++;
    else if (c === "'" || c === '"') quote = c;
    // A comment runs to the end of the line, and the & with it.
    else if (c === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) return null;
  }
  const rest = text.slice(0, -1);
  return quote || /[&|<>\\]$/.test(rest) || !rest.trim() ? null : rest.trimEnd();
}

/**
 * A command left to run in the background: in a process group of its own, under the same sandbox, its output to a log
 * beside the outputs kept for reading, and the call answered at once. Its group goes when this process does, and with
 * the job that started it (`ctx.background`); a `timeout N` it asked for still stops it.
 */
async function runInBackground(command, ctx, { env, jail }) {
  const asked = askedLimit(command, env.PATH);
  const dir = ctx.spill ?? tmpdir();
  let log;
  let fd;
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    log = join(dir, `${Date.now()}-${process.pid}-${spilled++}.log`);
    fd = openSync(log, 'a', 0o600);
  } catch (cause) {
    return result(`the command could not be started in the background: there is nowhere to write its log (${cause.message})`, true);
  }
  let child;
  try {
    child = spawnShell(asked?.command ?? command, jail.wrap, { cwd: ctx.cwd, env, stdio: ['ignore', fd, fd], detached: true });
  } finally {
    closeSync(fd);
  }
  const unstarted = await new Promise((resolve) => {
    child.once('spawn', () => resolve(null));
    child.once('error', resolve);
  });
  if (unstarted) return result(unstartedWhy(unstarted, ctx.cwd), true);
  const { pid } = child;
  trackGroup(pid);
  ctx.background?.add(pid);
  const timer = asked ? setTimeout(() => killGroup(pid), asked.ms).unref() : null;
  child.on('exit', () => {
    clearTimeout(timer);
    live.delete(pid);
    ctx.background?.delete(pid);
  });
  // Nothing here waits on it: it runs until it ends, is stopped, or what started it goes.
  child.unref();
  return result(`started in the background (pid ${pid}); its output goes to ${log} — read it with \`tail -n 50 ${log}\`. It is stopped when the job or the chat that started it ends.${jail.note}`);
}

/**
 * The sumo commands the model's shell runs as sumo itself, outside the sandbox — the sandbox keeps sumo's memory,
 * settings and MCP servers read-only, so from inside it they could not be read or written at all. The CLI refuses there
 * what only the user does (settings, MCP servers, models), and a job's shell what only the chat does. Never routed:
 * what installs or starts things — setup, a job's run, a hook, the chat.
 */
const SUMO_ROUTED = new Set(['search', 'add', 'learn', 'show', 'history', 'gate', 'supersede', 'forget', 'confirm', 'reject', 'prime', 'memory', 'project', 'cost', 'config', 'mcp', 'models', 'export', 'doctor', 'job', 'help', 'version', '--version', '-v', '--help', '-h']);
/** Of a job's commands, only those that read: verify and finish run the project's checks, which belong in the sandbox. */
const ROUTED_JOB = new Set(['show', 'list', 'stats']);

/**
 * A command's words when it is plain words alone — quoted or not — with nothing the shell would expand, redirect, pipe,
 * glob or run besides; null for anything else. Only such a command is what it looks like before the shell reads it.
 */
function shellWords(text) {
  const words = [];
  let word = null;
  let quote = null;
  for (const c of String(text).trim()) {
    if (quote === "'") {
      if (c === "'") quote = null;
      else word += c;
    } else if (quote === '"') {
      if (c === '"') quote = null;
      else if ('$`\\'.includes(c)) return null;
      else word += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      word ??= '';
    } else if (c === ' ' || c === '\t') {
      if (word !== null) words.push(word);
      word = null;
    } else if (/[;&|<>$`(){}*?[\]~!#\\\n\r]/.test(c)) {
      return null;
    } else word = (word ?? '') + c;
  }
  if (quote) return null;
  if (word !== null) words.push(word);
  return words;
}

const quoted = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replaceAll("'", "'\\''")}'`);

/** A plain `sumo …` command, spelled to run this very sumo by its path; null for any other command. */
function sumoCall(command) {
  // `sumo learn` reads its steps on stdin, written as a here-document: taken as it is when its delimiter is quoted (nothing
  // in it expands) and no line inside it ends it early — bash would run what came after that line, outside the sandbox.
  const heredoc = /^([^\n]*?)\s*<<-?\s*(['"])([A-Za-z_]\w*)\2[ \t]*\n([\s\S]*)\n\3[ \t]*$/.exec(String(command).trim());
  const words = shellWords(heredoc ? heredoc[1] : command);
  if (!words || words[0] !== 'sumo' || !SUMO_ROUTED.has(words[1] ?? 'help')) return null;
  if (words[1] === 'job' && !ROUTED_JOB.has(words[2])) return null;
  const call = [...SELF, ...words.slice(1)].map(quoted).join(' ');
  if (!heredoc) return call;
  const [, , , end, body] = heredoc;
  if (words[1] !== 'learn' || body.split('\n').some((line) => line.replace(/^\t+/, '').replace(/\r$/, '') === end)) return null;
  return `${call} <<'${end}'\n${body}\n${end}`;
}

/** A limit as it is said: in minutes when it is whole minutes, else in seconds. */
const span = (ms) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} minute${ms === 60_000 ? '' : 's'}` : `${ms / 1000} second${ms === 1000 ? '' : 's'}`);

/**
 * A shell command, in the project directory, without the secrets, refused when the guard says so, and in the sandbox
 * where there is one. It is stopped when it runs past its limit or prints nothing for two minutes — a `timeout N` in
 * front sets both — and one ending in a lone `&` is left running in the background, with a log.
 */
export async function runBash({ command, restart }, ctx, { signal = null, timeoutMs = COMMAND_TIMEOUT_MS, idleMs = IDLE_TIMEOUT_MS, onOutput = null } = {}) {
  // The tool is specified as one session the model may restart; here every call is its own shell, so there is nothing to restart.
  if (restart) return result('Bash session restarted: every command already runs in a fresh shell, in the project directory');
  if (typeof command !== 'string' || !command.trim()) return result('bash needs a command', true);
  const refused = guardCommand(command, { cwd: ctx.cwd });
  if (refused) return result(refused, true);
  const env = unprompted(ctx.env ?? childEnv(), ctx.cwd);
  let jail = jailOf(ctx);
  // sumo's own files are read-only to the sandbox: a plain sumo command runs as sumo itself, outside it, where the CLI's own
  // rules decide what the model may change — never the settings, the MCP servers or the models.
  const asSumo = jail.wrap ? sumoCall(command) : null;
  if (asSumo) {
    command = asSumo;
    jail = { ...jail, wrap: null, note: '' };
  }
  const behind = backgrounded(command);
  if (behind !== null) return runInBackground(behind, ctx, { env, jail });
  // The commands that run the project's checks give each check its own limit; one limit over all of them would cut a verdict off half-way.
  // A check may work for minutes without a word, so they are not held to a silence either.
  const own = OWN_LIMITS.test(command);
  const asked = own ? null : askedLimit(command, env.PATH);
  const limit = own ? null : (asked?.ms ?? timeoutMs);
  // A silence as long as the whole limit can never come first: a command that asked for its limit has only the one.
  const quiet = own || asked ? null : idleMs;
  const run = await runCommand(asked?.command ?? command, { cwd: ctx.cwd, env, signal, timeoutMs: limit, idleMs: quiet, onOutput, wrap: jail.wrap });
  if (run.error) return result(run.error + jail.note, true);
  const failed = run.stopped !== null || run.status !== 0;
  const output = run.output.trimEnd();
  const tail =
    run.stopped === 'timeout' ? `\n(stopped: it ran past ${span(limit)})`
    : run.stopped === 'idle' ? `\n(stopped: it printed nothing for ${span(quiet)} — to wait longer, run it again as \`timeout 600 ${command}\`, or in the background with a trailing \`&\` and read its log)`
    : run.stopped === 'interrupted' ? `\n(${INTERRUPTED})`
    : run.stopped === 'overflow' ? `\n(stopped: it printed more than ${MAX_BUFFER_CHARS / 1024 / 1024} MB — narrow the command: tail, grep, or a line range)`
    : failed ? `\n(exit ${run.status ?? run.signal})` : '';
  // Output the model is shown only the ends of, or with a line cut short, is kept as it was printed — as much as was
  // held — where it can read a range of it.
  const tidied = shownOf(output, run.omitted);
  const kept = ctx.spill && (tidied.capped || tidied.cut > 0) ? spill(ctx.spill, output, run.omitted) : null;
  const shown = tidied.show(kept) + tail;
  if (jail.wrap && run.stopped === null && run.status !== 0 && blockedWrite(output)) return blocked(command, shown, ctx, jail, { signal, timeoutMs, idleMs, onOutput });
  return result(shown + changedBy(ctx) + jail.note, failed);
}

/** The most files a command is said to have changed by name. */
const CHANGED_NAMED = 20;

/**
 * The files the model has viewed that this command changed or removed — a formatter, codegen, a checkout — said after
 * it, so the model views those again and not the rest. What it saw of them stays as it was: an edit made without a
 * fresh view is still said to be against what it remembers.
 */
function changedBy(ctx) {
  const changed = [];
  for (const [path, was] of ctx.seen ?? []) {
    try {
      const now = stampOf(path);
      // Said once for each change: what it was told of is kept beside what it saw, which stays.
      if ((now.mtimeMs !== was.mtimeMs || now.size !== was.size) && (now.mtimeMs !== was.told?.mtimeMs || now.size !== was.told?.size)) {
        was.told = now;
        changed.push(path);
      }
    } catch {
      ctx.seen.delete(path);
      changed.push(`${path} (gone)`);
    }
  }
  if (changed.length === 0) return '';
  const named = changed.slice(0, CHANGED_NAMED);
  const more = changed.length - named.length;
  return `\n(this command changed files you had viewed: ${named.join(', ')}${more > 0 ? ` and ${more} more` : ''} — view one again before editing it)`;
}

/**
 * A command the sandbox kept from writing: what it printed, and where it may write. Somebody there (`ctx.approve`, the
 * question an MCP call off the allow list is put with) may let that exact command run once more, outside the sandbox —
 * the guard has passed it already. With nobody there, the model is told to report it.
 */
async function blocked(command, shown, ctx, jail, options) {
  const except = jail.readOnly.length > 0 ? `, except what is read later outside it — git's hooks and config, the shell's and the tools' own files: ${jail.readOnly.join(', ')}` : '';
  const offline = jail.offline ? ' — and nothing past this machine can be reached: the user turned the network off (shell.network)' : '';
  const said = `${shown}\n(the sandbox blocked a write outside the project — only these can be written: ${jail.writable.join(', ')}${except}${offline})`;
  if (!ctx.approve) return result(`${said}\n(nobody is here to allow it outside the sandbox: report it, with the command, so the user can run it themselves)`, true);
  const { signal } = options;
  const stopped = new Promise((resolve) => signal?.addEventListener('abort', () => resolve('no'), { once: true }));
  // Asked as what it is — this one run outside the sandbox, yes or no — never as an MCP call that could be allowed always.
  // With what the sandbox refused, so the question says why it is asked: the first line that names a refused write.
  const refusal = String(shown).split('\n').find((line) => /operation not permitted|read-only file system|permission denied/i.test(line));
  const blockedLine = refusal ? redact(refusal.trim()).text.slice(0, 300) : null;
  const answer = signal?.aborted ? 'no' : await Promise.race([ctx.approve({ name: BASH_TOOL.name, server: 'bash', tool: 'outside the sandbox', input: { command }, unsandboxed: true, blocked: blockedLine, signal }), stopped]);
  // Always is once here: what is allowed is this one run, never the sandbox off.
  if (answer !== 'once' && answer !== 'always') {
    return { ...result(`${said}\n(the user declined running it outside the sandbox: do not run it again; carry on another way, or ask the user)${saidWhy(answer)}`, true), shown: redact(`${shown}\n${declinedShown('the sandbox kept it from writing outside the project, and it was not run outside it', answer)}`).text };
  }
  const again = await runBash({ command }, { ...ctx, sandbox: false }, options);
  return { ...again, content: `(the sandbox blocked a write outside the project; the user let it run again outside the sandbox)\n${again.content}` };
}

/** How much of a file is looked at to tell a binary from text: a NUL byte in its first pages is one. */
const BINARY_PROBE_BYTES = 8192;

function view(path, range) {
  if (statSync(path).isDirectory()) return result(cap(readdirSync(path).join('\n')));
  const bytes = readFileSync(path);
  // A binary shown as text is pages of nonsense, every page billed: say what it is instead.
  if (bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return result(`${path} is a binary file (${bytes.length} bytes) — not shown; use a tool that reads its kind, or \`file\` and \`xxd | head\` for a look`, true);
  const lines = bytes.toString('utf8').split('\n');
  let [from, to] = Array.isArray(range) && range.length === 2 ? range : [1, lines.length];
  from = Math.max(1, from);
  to = to === -1 ? lines.length : Math.min(lines.length, to);
  // The window ends at the last whole line that fits the cap a command's output has, so a long file is never shown
  // with a hole in it and the next view carries on from a line. Only a line too long to read — a minified file's — is cut inside.
  const shown = [];
  let size = 0;
  for (const [i, line] of lines.slice(from - 1, Math.min(to, from - 1 + VIEW_CAP_LINES)).entries()) {
    const numbered = `${from + i}\t${cutLine(line)}`;
    if (shown.length > 0 && size + numbered.length + 1 > OUTPUT_CAP_CHARS) break;
    shown.push(numbered);
    size += numbered.length + 1;
  }
  const cut = to - (from - 1 + shown.length);
  const body = shown.join('\n');
  return result(cut > 0 ? `${body}\n[${cut} more lines up to ${to} — view a smaller range]` : body);
}

/**
 * Where old_str is in a file: exactly; else with the file's own line endings; else line by line without trailing spaces;
 * else without the indentation too, in which case the replacement is set in at the file's indentation. One place, with how
 * it was found, or how many places it was found in — a looser match is still held to being the only one. A model that
 * copies a line with a space missing at its end, or at the wrong depth, otherwise spends a turn on "not found".
 */
function locate(text, oldStr) {
  const exact = (needle, how = null) => {
    const hits = [];
    for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) hits.push(at);
    return hits.length === 0 ? null : { hits: hits.length, start: hits[0], end: hits[0] + needle.length, how };
  };
  const found = exact(oldStr) ?? (text.includes('\r\n') && !oldStr.includes('\r') ? exact(oldStr.replaceAll('\n', '\r\n'), "with the file's line endings") : null);
  if (found) return found;
  const lines = text.split('\n');
  const starts = [];
  for (let at = 0, i = 0; i < lines.length; i++) {
    starts.push(at);
    at += lines[i].length + 1;
  }
  const wanted = oldStr.replace(/\r\n/g, '\n').split('\n');
  const byLines = (same, how) => {
    const hits = [];
    for (let i = 0; i + wanted.length <= lines.length; i++) if (wanted.every((w, j) => same(lines[i + j], w))) hits.push(i);
    if (hits.length === 0) return null;
    const [i] = hits;
    const last = i + wanted.length - 1;
    // The span ends before a carriage return the line keeps: the replacement is given the file's line endings itself.
    return { hits: hits.length, start: starts[i], end: starts[last] + lines[last].replace(/\r$/, '').length, how, line: i };
  };
  const trimmed = byLines((a, b) => a.trimEnd() === b.trimEnd(), 'without trailing spaces');
  if (trimmed) return trimmed;
  const loose = byLines((a, b) => a.trim() === b.trim(), 'without its indentation');
  if (!loose) return null;
  // The depth the model wrote at, moved to the depth the file has: every line of the replacement indented like the old one is re-indented.
  const indentOf = (line) => /^[ \t]*/.exec(line)[0];
  const was = indentOf(wanted[0]);
  const is = indentOf(lines[loose.line]);
  if (was !== is) loose.reindent = (replacement) => replacement.split('\n').map((l) => (l.startsWith(was) ? `${is}${l.slice(was.length)}` : l)).join('\n');
  return loose;
}

/**
 * An edit for the screen, which draws it as a diff: the line the change begins on, and the whole lines it touched as
 * the file had them and as it has them now — what was matched and written, not what the model sent. The model is told none of it.
 */
function changeOf(text, { start, end }, replacement) {
  const from = text.lastIndexOf('\n', start - 1) + 1;
  // A span that ends on a newline took whole lines: the line after it is not part of the change.
  const whole = end > start && text[end - 1] === '\n';
  const to = whole ? end : text.indexOf('\n', end) === -1 ? text.length : text.indexOf('\n', end);
  // For the screen the line endings are plain, whatever the file's are.
  const lines = (t) => redact(t.replace(/\r\n/g, '\n').replace(whole ? /\n$/ : /\r$/, '')).text;
  return { line: text.slice(0, from).split('\n').length, old: lines(text.slice(from, to)), new: lines(`${text.slice(from, start)}${replacement}${text.slice(end, to)}`) };
}

/** A file as it stood when the model last looked: a change on disk since moves one or the other. */
const stampOf = (path) => {
  const { mtimeMs, size } = statSync(path);
  return { mtimeMs, size };
};

/** What the model has seen of each file in this context — viewed, or written by the editor — kept for as long as the context is. */
const seenIn = (ctx) => (ctx.seen ??= new Map());

/** The line an edit opens with when its file changed on disk since the model saw it: the edit was made against what it remembers. */
function changedSince(path, ctx) {
  const was = ctx.seen?.get(path);
  if (!was) return null;
  const now = stampOf(path);
  return now.mtimeMs !== was.mtimeMs || now.size !== was.size ? `${path} changed on disk since you last viewed it; view it again if this edit depends on the rest of it.` : null;
}

/** How long a parse check may take before it is let go unanswered. */
const PARSE_TIMEOUT_MS = 5_000;
/** How many lines of a parse error are shown: where it is and what it is, not a stack. */
const PARSE_ERROR_LINES = 5;
/**
 * Python's own parser, its error without a traceback; isolated, so a file in the project named like a module is not run,
 * and writing no bytecode. The bytes are parsed, so the file's own coding line decides how they read, not the locale.
 */
const PY_PARSE = 'import ast,sys,traceback\ntry: ast.parse(open(sys.argv[1], "rb").read(), sys.argv[1])\nexcept Exception as e: sys.exit("".join(traceback.format_exception_only(type(e), e)))';

/**
 * Why a file does not parse, as its parser says it in a few lines — or null: it parses, it is of no kind checked here,
 * or the parser is missing or too slow to say. `.js .mjs .cjs` by `node --check`, `.json` here, `.py` and `.go` by
 * their own tools when they are on the PATH.
 */
function parseError(path, ctx) {
  const env = ctx.env ?? childEnv();
  const ext = extname(path);
  let run;
  if (ext === '.json') {
    try {
      JSON.parse(readFileSync(path, 'utf8'));
      return null;
    } catch (cause) {
      return cause.message;
    }
  }
  // The binary Bun builds is no node to check a script with: it asks the node on PATH, if there is one.
  if (['.js', '.mjs', '.cjs'].includes(ext) && (!process.versions.bun || onPath('node', env.PATH))) run = [process.versions.bun ? 'node' : process.execPath, ['--check', path]];
  else if (ext === '.py' && onPath('python3', env.PATH)) run = ['python3', ['-I', '-B', '-c', PY_PARSE, path]];
  else if (ext === '.go' && onPath('gofmt', env.PATH)) run = ['gofmt', ['-e', '-l', path]];
  else return null;
  const out = spawnSync(run[0], run[1], { env, encoding: 'utf8', timeout: PARSE_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'] });
  if (out.error || out.status === null || out.status === 0) return null;
  const lines = `${out.stderr}\n${out.stdout}`.split('\n').filter((l) => l.trim());
  return lines.length > 0 ? lines.slice(0, PARSE_ERROR_LINES).map((l) => l.slice(0, 200)).join('\n') : `the parser stopped with status ${out.status}`;
}

/** How many of a session's turns /undo can walk back through; older ones are let go as new ones are kept. */
const UNDO_TURNS = 20;
/** How long the undo of a session nothing has touched is kept: as long as the session can be resumed. */
const UNDO_KEEP_MS = 30 * 24 * 3_600_000;
const MANIFEST = 'manifest.json';

/** A session's kept turns, oldest first: folders named by their number. */
function undoTurns(sessionDir) {
  try {
    return readdirSync(sessionDir).filter((name) => /^\d+$/.test(name)).map(Number).sort((a, b) => a - b);
  } catch {
    return [];
  }
}

/** The folder the coming turn's undo goes in — made only when the editor first changes a file in it. */
export const nextUndoTurn = (sessionDir) => join(sessionDir, String((undoTurns(sessionDir).at(-1) ?? 0) + 1));

const readManifest = (turnDir) => {
  try {
    return JSON.parse(readFileSync(join(turnDir, MANIFEST), 'utf8'));
  } catch {
    return null;
  }
};

/**
 * After the editor's first change to a file in a turn: what the file held before it (`before`, its bytes), or that it
 * was not there (null), kept in the turn's folder for /undo, readable by the user alone. A later change to it in the same
 * turn keeps nothing — /undo goes back to before the turn. The turn that starts a folder lets go of the oldest beyond
 * UNDO_TURNS, and of the undo of sessions long untouched.
 */
function keepForUndo(turnDir, path, before) {
  const manifest = readManifest(turnDir) ?? [];
  if (manifest.some((entry) => entry.path === path)) return;
  if (manifest.length === 0) {
    const sessionDir = dirname(turnDir);
    mkdirSync(turnDir, { recursive: true, mode: 0o700 });
    for (const old of undoTurns(sessionDir).slice(0, -UNDO_TURNS)) rmSync(join(sessionDir, String(old)), { recursive: true, force: true });
    const home = dirname(sessionDir);
    for (const name of readdirSync(home)) {
      const other = join(home, name);
      if (other !== sessionDir && Date.now() - statSync(other).mtimeMs > UNDO_KEEP_MS) rmSync(other, { recursive: true, force: true });
    }
  }
  const kept = before === null ? null : String(manifest.length);
  if (kept !== null) writeFileSync(join(turnDir, kept), before, { mode: 0o600 });
  manifest.push({ path, kept, mode: kept === null ? null : statSync(path).mode & 0o777 });
  writeFileSync(join(turnDir, MANIFEST), JSON.stringify(manifest), { mode: 0o600 });
}

/**
 * /undo: every file the session's last kept turn changed, put back as it was before that turn — a file it created is
 * deleted — and the turn let go, so the next /undo reaches the one before. Null when there is none to undo.
 */
export function undoLast(sessionDir) {
  for (const n of undoTurns(sessionDir).reverse()) {
    const turnDir = join(sessionDir, String(n));
    const manifest = readManifest(turnDir);
    if (!manifest) {
      rmSync(turnDir, { recursive: true, force: true });
      continue;
    }
    const done = { restored: [], deleted: [] };
    for (const { path, kept, mode } of manifest) {
      if (kept === null) {
        rmSync(path, { force: true });
        done.deleted.push(path);
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, readFileSync(join(turnDir, kept)), { mode: mode ?? 0o644 });
        done.restored.push(path);
      }
    }
    rmSync(turnDir, { recursive: true, force: true });
    return done;
  }
  return null;
}

/**
 * One change to a file by the editor, and what is owed around it: what the file held is kept for /undo (`ctx.undo`, the
 * chat's turn folder), a change on disk since the model saw it is said first, and a parse the change broke — one that held
 * before it — is said after. `created`: the file was not there, so it parsed before as far as anyone is concerned.
 */
function change(path, ctx, write, { created = false } = {}) {
  const stale = created ? null : changedSince(path, ctx);
  const before = ctx.undo && !created ? readFileSync(path) : null;
  const broken = created ? null : parseError(path, ctx);
  write();
  // Kept once the write has gone through: a change refused — a create of a file already there — has nothing to undo. A keep
  // that fails is said, not thrown: the change is made, and a model told it failed would make it twice.
  let unkept = null;
  try {
    if (ctx.undo) keepForUndo(ctx.undo, path, before);
  } catch (cause) {
    unkept = `(this change could not be kept for /undo: ${cause.message})`;
  }
  if (created || ctx.seen?.has(path)) seenIn(ctx).set(path, stampOf(path));
  const now = broken === null ? parseError(path, ctx) : null;
  return (said) => [stale, said, unkept, now && `The file no longer parses:\n${now}`].filter(Boolean).join('\n');
}

/** A whole line that is one comment — `//`, `#`, `/* *\/`, `<!-- -->`, `--`, JSX's `{/* *\/}` — and what it says. */
const COMMENT_LINE = /^(?:\/\/+|#+|\/\*+|<!--|--|\{\/\*+)\s*(.*?)\s*(?:\*+\/\}?|-->)?$/;
/** The block comments that close on their line: only dots in one is a gap left in the code, where `// ...` alone may be a deliberate stub. */
const CLOSED_COMMENT = /(?:\*\/\}?|-->)$/;
const DOTS = /\.{3,}|…/g;
/** That what was left out stays as it was: optional after `rest of the code`; needed after `other methods` with no dots around it, which could be a heading. */
const STAYS = String.raw`(?:\s+(?:is\s+|are\s+|stays\s+|remains\s+|goes\s+)?(unchanged|the same|as before|as is|omitted|here|goes here|follows|not shown))?`;
/** What a gap stands for. */
const STUFF = String.raw`(?:code|file|function|functions|method|methods|class|implementation|component|module|body|content|contents|imports?|tests?|logic|lines?|cases|fields|properties|props|styles)`;
const REST_OF = new RegExp(String.raw`^(?:(?:the|and|all)\s+)?(?:rest|remainder)\s+of\s+(?:the\s+|this\s+|your\s+)?(?:\w+\s+)?${STUFF}${STAYS}$`);
const KEPT_AS_IS = new RegExp(String.raw`^(?:(?:the|all)\s+)?(?:existing|previous|original|other|remaining|unchanged|same)\s+(?:\w+\s+)?${STUFF}${STAYS}$`);
const UNCHANGED = /^(?:unchanged|no changes|as before|same as before)$/;
/** Files whose text is prose for a reader: an example in one shows code with its gaps on purpose. */
const PROSE = ['.md', '.mdx', '.markdown', '.txt', '.rst', '.adoc'];
/** The longest a line that stands for code is: a gap is said in a few words, and a longer line is never read for one. */
const GAP_MAX_CHARS = 200;

/**
 * Whether a line stands for code instead of holding it — `// ... rest of the code unchanged`, `# ... existing code ...`,
 * `/* rest of file *\/`, `// (unchanged)`, `<!-- ... -->` — as a model writes one when it means "keep what is there".
 * Gemini CLI refuses the same; read narrowly here: a whole line, a comment or dots around it, and nothing in it but the gap. A
 * `...` in code or prose, a comment that only mentions the rest of something, and `// ...` alone are never one.
 */
function standsForCode(line) {
  const trimmed = line.trim();
  if (trimmed.length > GAP_MAX_CHARS) return false;
  const comment = COMMENT_LINE.exec(trimmed);
  const said = comment ? comment[1] : trimmed;
  const dotted = /^(?:\.{3}|…)|(?:\.{3}|…)$/.test(said);
  const words = said.replace(DOTS, ' ').replace(/^[\s([{]+|[\s)\]}.,;:]+$/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  const kept = KEPT_AS_IS.exec(words);
  // Bare, only dots around the words make it one: `...existing code...`; a spread such as `...rest,` never reads as words.
  if (!comment) return dotted && (REST_OF.test(words) || kept !== null);
  if (words === '') return dotted && CLOSED_COMMENT.test(trimmed);
  return REST_OF.test(words) || UNCHANGED.test(words) || (kept !== null && (dotted || kept[1] !== undefined));
}

/** Why an edit's new text is not written: a line of it stands for code, and the file — `had`, as it is — does not already hold that line. Null when none does. */
function placeholderIn(path, field, text, had = '') {
  if (PROSE.includes(extname(path).toLowerCase())) return null;
  const lines = String(text ?? '').split('\n').filter(standsForCode);
  if (lines.length === 0) return null;
  const there = new Set(had.split('\n').map((l) => l.trim()));
  const gap = lines.find((l) => !there.has(l.trim()));
  return gap === undefined ? null : `not written: ${field} has a line that stands for code instead of holding it — ${JSON.stringify(gap.trim())} — and the file would hold that line, not the code. Write the code out in full; to leave code as it is, leave it out of the edit.`;
}

/** The longest reason a refusal carries: a sentence or two, not a document. */
const REASON_MAX_CHARS = 500;

/**
 * What the user said when they refused a call — an answer of `{ no: 'their words' }` — as the line the model reads
 * after the refusal; empty for a plain no. Their words are their direction for what to do instead.
 */
export function saidWhy(answer) {
  const words = wordsOf(answer);
  return words ? `\n(the user declined it and said: "${words}" — do what they said instead)` : '';
}
/** The user's words with a no, redacted, on one line; empty for a plain no. */
const wordsOf = (answer) => (answer && typeof answer === 'object' && typeof answer.no === 'string' ? redact(answer.no).text.replace(/\s+/g, ' ').trim().slice(0, REASON_MAX_CHARS) : '');
/**
 * A refusal as the screen says it: what was declined, in a line, and the user's own words — not the paths and the
 * instructions the model is given. The model's text stays whole in `content`; the full view shows it.
 */
export const declinedShown = (what, answer) => {
  const words = wordsOf(answer);
  return `declined: ${what}${words ? ` · you said: "${words}"` : ''}`;
};

/** The most lines an ambiguous old_str is said to start on. */
const HITS_NAMED = 10;

/** Where an old_str found more than once starts, as ` (lines 4, 18, 40)`, so one view of those lines makes it unique; empty when it matched only loosely. */
function linesOf(text, old) {
  const lines = [];
  for (let at = text.indexOf(old); at !== -1 && lines.length <= HITS_NAMED; at = text.indexOf(old, at + 1)) lines.push(text.slice(0, at).split('\n').length);
  if (lines.length < 2) return '';
  const more = lines.length > HITS_NAMED ? ', …' : '';
  return ` (lines ${lines.slice(0, HITS_NAMED).join(', ')}${more})`;
}

/** Why a file with another name is asked about each time. */
const HARD_LINK = 'it has another name elsewhere (a hard link), and a change here changes that file too';

/**
 * A file the editor writes, written where its checks found it lands: through no link swapped in since — the last name
 * is opened without following one — and only when the file opened is the one that was checked. Nothing is truncated
 * before that. (A folder above it swapped for a link between the check and the open is not caught: Node has no openat.)
 */
function writeTo(path, data, { create = false } = {}) {
  const target = landsAt(path) ?? path;
  const before = create ? null : statSync(target);
  const fd = openSync(target, constants.O_WRONLY | constants.O_NOFOLLOW | (create ? constants.O_CREAT | constants.O_EXCL : 0), 0o666);
  try {
    const opened = fstatSync(fd);
    if (before && (opened.ino !== before.ino || opened.dev !== before.dev)) throw new Error(`${path} was replaced while it was being changed; nothing was written — view it again`);
    ftruncateSync(fd, 0);
    writeFileSync(fd, data);
  } finally {
    closeSync(fd);
  }
}

/** The text editor's four commands, each inside the jail; secret files are neither shown nor written. */
/** Whether the user opened a place for the session that holds this path (`ctx.opened`, kept by real path: a file, or a directory with everything under it). */
function openedIn(ctx, path) {
  for (const place of ctx.opened ?? []) if (path === place || path.startsWith(`${place}${sep}`)) return true;
  return false;
}

/**
 * Where a write to a path lands, by real path: through every link on the way, to a file not there yet below the deepest
 * directory that is. Null for a link that points at nothing yet — a write there goes where the link says, which no
 * question has shown.
 */
function landsAt(path) {
  if (existsSync(path)) return realpathSync.native(path);
  let probe = path;
  while (!existsSync(probe)) {
    if (isLink(probe)) return null;
    const up = dirname(probe);
    if (up === probe) return null;
    probe = up;
  }
  return join(realpathSync.native(probe), relative(probe, path));
}

/** The directory a file's question may open for the session: never the home, what is above it, or the top of the disk — the shell would write there too. */
function directoryFor(path) {
  const dir = dirname(path);
  const home = landsAt(homedir()) ?? homedir();
  return dir === home || `${home}${sep}`.startsWith(`${dir}${sep}`) || dirname(dir) === dir ? null : dir;
}

/** A refusal the model reads, with the question for the user on it: where the write lands, whether that is outside the project, why it is guarded, and what directory may be opened. */
function askFirst(message, path, { outside, guarded }) {
  return { ...result(message, true), ask: { path, outside, guarded, directory: outside && !guarded ? directoryFor(path) : null } };
}

export function runEditor(input, ctx) {
  let path;
  /** Whether the user let this file, outside the project, be changed: for the session, or this once. */
  let opened = false;
  try {
    path = jailed(input.path, ctx);
  } catch (cause) {
    // Outside the project: read as the shell reads, anywhere; written only where the user has said so — else refused
    // with the path on it, for whoever runs the tool to put to the user. A guarded file is never opened for the session.
    // Judged by where the write lands, so a link in an opened directory cannot carry it somewhere else.
    const absolute = typeof input.path === 'string' && input.path ? resolve(ctx.cwd, input.path) : null;
    if (absolute === null) return result(cause.message, true);
    const lands = landsAt(absolute);
    if (input.command !== 'view') {
      if (lands === null) return result(`${absolute} is a link to something not there yet, outside the project — not written: say in your report what it needs`, true);
      const guarded = guardedWhy(absolute, { roots: ctx.roots }) ?? guardedWhy(lands, { roots: ctx.roots });
      opened = ctx.granted === lands || (!guarded && openedIn(ctx, lands));
      // macOS's own /var, /tmp and /etc are links into /private: no link worth naming.
      const shown = lands === absolute || lands === `/private${absolute}` ? absolute : `${absolute} (a link to ${lands})`;
      if (!opened) return guarded ? askFirst(`${shown} is changed only when the user says so: ${guarded}`, lands, { outside: true, guarded }) : askFirst(`${shown} is outside the project (${ctx.roots[0]})`, lands, { outside: true, guarded: null });
    }
    path = lands ?? absolute;
  }
  try {
    const secret = guardPath(path) ?? guardPath(realAncestor(path));
    // Every root can be read; only the project (the first) can be written. A job's own folder holds what judges it.
    if (input.command !== 'view' && !opened && ctx.roots.length > 1) {
      try {
        jailed(input.path, { cwd: ctx.cwd, roots: ctx.roots.slice(0, 1) });
      } catch {
        return result(`${path} can be read, not changed — only files in the project (${ctx.roots[0]}) are edited`, true);
      }
    }
    // What git runs by itself — a hook on the next commit, a command its config names — runs outside the sandbox: the shell cannot write it, nor can this.
    if (input.command !== 'view') {
      const at = realAncestor(path);
      const kept = readOnlyPlaces(ctx.roots).find((place) => path === place || path.startsWith(`${place}${sep}`) || at === place || at.startsWith(`${place}${sep}`));
      if (kept) return result(`${path} is git's own hooks or configuration: not changed here — what git runs by itself would run outside the sandbox. Say in your report what it needs.`, true);
      // What something else reads later — the shell at its start, a tool before it runs, an editor — is changed only when the user says so, this once.
      const guarded = guardedWhy(path, { roots: ctx.roots }) ?? guardedWhy(at, { roots: ctx.roots });
      if (guarded && ctx.granted !== path) return askFirst(`${path} is changed only when the user says so: ${guarded}`, path, { outside: false, guarded });
      // A hard link is the same file under another name, perhaps one outside the project or guarded: no path check sees it.
      if (existsSync(path) && lstatSync(path).isFile() && lstatSync(path).nlink > 1 && ctx.granted !== path) return askFirst(`${path} is changed only when the user says so: ${HARD_LINK}`, path, { outside: false, guarded: HARD_LINK });
    }
    switch (input.command) {
      case 'view': {
        if (secret) return result(secret, true);
        if (!existsSync(path)) return result(`${path} does not exist`, true);
        const shown = view(path, input.view_range);
        if (!shown.isError && statSync(path).isFile()) seenIn(ctx).set(path, stampOf(path));
        return shown;
      }
      case 'create': {
        if (secret) return result(secret, true);
        const gap = placeholderIn(path, 'file_text', input.file_text);
        if (gap) return result(gap, true);
        // The write below refuses a file that is there anyway; said here in words that tell the model what to do instead.
        if (existsSync(path) && statSync(path).isFile()) {
          const held = readFileSync(path, 'utf8');
          const lines = held.split('\n').length - (held.endsWith('\n') ? 1 : 0);
          return result(`${path} already exists (${lines} line${lines === 1 ? '' : 's'}): change the lines that change with str_replace or insert — a file is never rewritten whole`, true);
        }
        mkdirSync(dirname(path), { recursive: true });
        const said = change(path, ctx, () => writeTo(path, String(input.file_text ?? ''), { create: true }), { created: true });
        return result(said(`created ${path}`));
      }
      case 'str_replace': {
        if (secret) return result(secret, true);
        if (!input.old_str) return result('str_replace needs old_str', true);
        if (input.new_str !== undefined && input.old_str === input.new_str) return result('old_str and new_str are the same — nothing would change', true);
        const text = readFileSync(path, 'utf8');
        const gap = placeholderIn(path, 'new_str', input.new_str, text);
        if (gap) return result(gap, true);
        const where = locate(text, input.old_str);
        if (!where) return result(`old_str was not found in ${path}`, true);
        if (where.hits !== 1) return result(`old_str appears ${where.hits} times in ${path}${linesOf(text, input.old_str)} — include more context so it is unique`, true);
        let replacement = String(input.new_str ?? '');
        if (where.how) {
          if (text.includes('\r\n')) replacement = replacement.replace(/\r?\n/g, '\r\n');
          if (where.reindent) replacement = where.reindent(replacement);
        }
        const said = change(path, ctx, () => writeTo(path, `${text.slice(0, where.start)}${replacement}${text.slice(where.end)}`));
        return { ...result(said(`edited ${path}${where.how ? ` (old_str matched ${where.how})` : ''}`)), edit: changeOf(text, where, replacement) };
      }
      case 'insert': {
        if (secret) return result(secret, true);
        const lines = readFileSync(path, 'utf8').split('\n');
        const line = Number(input.insert_line ?? 0);
        if (!Number.isInteger(line)) return result('insert needs insert_line: the number of the line to insert after, 0 for the top of the file', true);
        // The tool sends the text as insert_text, a line with its newline; new_str is what an earlier version of the tool sent.
        const text = input.insert_text ?? input.new_str;
        if (typeof text !== 'string') return result('insert needs insert_text: the text to insert', true);
        const gap = placeholderIn(path, input.insert_text === undefined ? 'new_str' : 'insert_text', text, lines.join('\n'));
        if (gap) return result(gap, true);
        // A file ending in a newline splits to a last empty piece, which is not a line to insert after.
        const at = Math.max(0, Math.min(lines.at(-1) === '' ? lines.length - 1 : lines.length, line));
        lines.splice(at, 0, text.replace(/\n$/, ''));
        const said = change(path, ctx, () => writeTo(path, lines.join('\n')));
        return { ...result(said(`inserted into ${path} after line ${at}`)), edit: { line: at + 1, old: '', new: redact(text.replace(/\n$/, '')).text } };
      }
      default:
        return result(`unknown command ${input.command}`, true);
    }
  } catch (cause) {
    return result(cause.message, true);
  }
}

/**
 * A change the editor refused — a file outside the project, or a guarded one — put to whoever is there (`ctx.approve`,
 * the question a blocked command is put with): the file and the change, to make once; or, outside the project and not
 * guarded, this file or its directory for the rest of the session (`ctx.opened`), which the shell then writes too.
 * With nobody there, the model is told to report it.
 */
async function askUser(input, refused, ctx, signal) {
  const { ask } = refused;
  if (!ctx.approve) return result(`${refused.content}\n(nobody is here to allow it: report it, with the path and the change, so the user can make it themselves)`, true);
  const stopped = new Promise((resolve) => signal?.addEventListener('abort', () => resolve('no'), { once: true }));
  const answer = signal?.aborted ? 'no' : await Promise.race([ctx.approve({ name: EDITOR_TOOL.name, server: 'editor', tool: ask.guarded ? 'a guarded file' : 'outside the project', input, ...ask, signal }), stopped]);
  const session = !ask.guarded && (answer === 'always' || answer === 'directory');
  if (answer !== 'once' && !session) return { ...result(`${refused.content}\n(the user declined changing it: do not try again; carry on another way, or ask the user)${saidWhy(answer)}`, true), shown: declinedShown('not changed', answer) };
  if (session) ctx.opened?.add(answer === 'directory' && ask.directory ? ask.directory : ask.path);
  const again = runEditor(input, { ...ctx, granted: ask.path });
  const why = ask.guarded ? 'is a guarded file' : 'is outside the project';
  return { ...again, content: `(${ask.path} ${why}; the user allowed this change)\n${again.content}` };
}

/** One tool call, whichever tool it names; a name nothing answers to is an error the model can read. */
export async function runTool(block, ctx, { signal = null, onOutput = null } = {}) {
  if (block.name === BASH_TOOL.name) return runBash(block.input ?? {}, ctx, { signal, onOutput });
  if (block.name === EDITOR_TOOL.name) {
    const out = runEditor(block.input ?? {}, ctx);
    return out.ask ? askUser(block.input ?? {}, out, ctx, signal) : out;
  }
  return result(`no tool called ${block.name}`, true);
}
