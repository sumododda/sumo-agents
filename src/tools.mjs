import { spawn } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { CREDENTIAL_NAMES } from './auth.mjs';
import { guardCommand, guardPath } from './guard.mjs';
import { redact } from './redact.mjs';

/**
 * The two tools a job gets, and the policy every call passes through before it
 * runs: command guards, the editor's path jail, output caps, and redaction.
 * Shell commands run with the user's filesystem access; command guards match known patterns.
 */

/** Anthropic-defined, schema-less on the wire: the API knows their shape, so no schema is sent. */
export const BASH_TOOL = { type: 'bash_20250124', name: 'bash' };
export const EDITOR_TOOL = { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' };

/** The chat's own: hands a piece of work to a sub-agent with a fresh context and waits for its report. Several in one reply run at once. */
export const DELEGATE_TOOL = {
  name: 'delegate',
  description:
    'Hand a piece of work to a sub-agent with a fresh context: scout looks (no edits), worker builds, reviewer judges a change it did not write. ' +
    'It runs on its own route and returns its report. Several calls in one reply run at the same time; one worker per project at a time. ' +
    'To continue an open job instead (one from an earlier session), give only `job`.',
  input_schema: {
    type: 'object',
    properties: {
      agent: { type: 'string', enum: ['scout', 'worker', 'reviewer'] },
      project: { type: 'string', description: 'the project slug' },
      title: { type: 'string', description: 'a few words' },
      task: { type: 'string', description: 'the brief, a contract: ## Goal, ## Non-goals, ## Must not change, ## Check (the command that proves it, or why none), ## Report' },
      guide: { type: 'string', enum: ['fix', 'feature'], description: 'carry guides/<guide>.md into the brief' },
      reviews: { type: 'integer', description: 'reviewer only: the worker job whose change to judge; without it, the uncommitted change' },
      tests_may_change: { type: 'boolean', description: 'worker only: existing tests may be edited' },
      job: { type: 'integer', description: 'continue this open job; nothing else is given' },
    },
  },
};

const OUTPUT_CAP_CHARS = 16_000;
const VIEW_CAP_LINES = 400;
const COMMAND_TIMEOUT_MS = 540_000; // the same nine minutes a check gets
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
  const half = Math.floor(max / 2);
  const head = redact(text.slice(0, half + max)).text.slice(0, half);
  const tail = redact(text.slice(-(half + max))).text.slice(-half);
  return `${head}\n${cutMark(text.length - 2 * half + omitted, kept)}\n${tail}`;
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
  return realpathSync(probe);
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
  const allowed = roots.map((r) => realpathSync(r)).some((r) => real === r || real.startsWith(`${r}/`));
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
 * output already on its way is drained and the command is over.
 */
export function runCommand(command, { cwd, env, signal = null, timeoutMs = null }) {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: SHELL, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
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
    const settle = (status, killedBy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
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
          kept[name].push(chunk);
          kept.output.push(chunk);
        }
      });
    }
    child.on('error', (cause) => {
      // Never started, so there is no output and no exit to report: the reason is the answer, and a directory that is gone is the usual one.
      unstarted = `the command could not be started: ${cause.message}${cwd && !existsSync(cwd) ? ` — ${cwd} does not exist` : ''}`;
      settle(null, null);
    });
    child.on('close', settle);
    child.on('exit', (status, killedBy) => {
      if (stopped) release(status, killedBy);
      else drain = setTimeout(() => release(status, killedBy), DRAIN_MS);
    });
    if (signal?.aborted) interrupt();
    else signal?.addEventListener('abort', interrupt, { once: true });
  });
}

/** A shell command, in the project directory, without the secrets, refused when the guard says so. */
export async function runBash({ command, restart }, ctx, { signal = null, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  // The tool is specified as one session the model may restart; here every call is its own shell, so there is nothing to restart.
  if (restart) return result('Bash session restarted: every command already runs in a fresh shell, in the project directory');
  if (typeof command !== 'string' || !command.trim()) return result('bash needs a command', true);
  const refused = guardCommand(command, { cwd: ctx.cwd });
  if (refused) return result(refused, true);
  // The commands that run the project's checks give each check its own limit; one limit over all of them would cut a verdict off half-way.
  const limit = OWN_LIMITS.test(command) ? null : timeoutMs;
  const run = await runCommand(command, { cwd: ctx.cwd, env: ctx.env ?? childEnv(), signal, timeoutMs: limit });
  if (run.error) return result(run.error, true);
  const failed = run.stopped !== null || run.status !== 0;
  const output = run.output.trimEnd();
  const tail =
    run.stopped === 'timeout' ? `\n(stopped: it ran past ${timeoutMs / 60_000} minutes)`
    : run.stopped === 'interrupted' ? `\n(${INTERRUPTED})`
    : run.stopped === 'overflow' ? `\n(stopped: it printed more than ${MAX_BUFFER_CHARS / 1024 / 1024} MB — narrow the command: tail, grep, or a line range)`
    : failed ? `\n(exit ${run.status ?? run.signal})` : '';
  // Output the model is shown only the ends of is kept whole — as much as was held — where it can read a range of it.
  const kept = ctx.spill && (output.length > OUTPUT_CAP_CHARS || run.omitted > 0) ? spill(ctx.spill, output, run.omitted) : null;
  return result(capRedacted(output, OUTPUT_CAP_CHARS, run.omitted, kept) + tail, failed);
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
  // with a hole in it and the next view carries on from a line. Only a first line too long for the cap is cut inside.
  const shown = [];
  let size = 0;
  for (const [i, line] of lines.slice(from - 1, Math.min(to, from - 1 + VIEW_CAP_LINES)).entries()) {
    const numbered = `${from + i}\t${line}`;
    if (shown.length > 0 && size + numbered.length + 1 > OUTPUT_CAP_CHARS) break;
    shown.push(shown.length === 0 ? cap(numbered) : numbered);
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

/** The text editor's four commands, each inside the jail; secret files are neither shown nor written. */
export function runEditor(input, ctx) {
  let path;
  try {
    path = jailed(input.path, ctx);
  } catch (cause) {
    return result(cause.message, true);
  }
  try {
    const secret = guardPath(path) ?? guardPath(realAncestor(path));
    // Every root can be read; only the project (the first) can be written. A job's own folder holds what judges it.
    if (input.command !== 'view' && ctx.roots.length > 1) {
      try {
        jailed(input.path, { cwd: ctx.cwd, roots: ctx.roots.slice(0, 1) });
      } catch {
        return result(`${path} can be read, not changed — only files in the project (${ctx.roots[0]}) are edited`, true);
      }
    }
    switch (input.command) {
      case 'view':
        if (secret) return result(secret, true);
        if (!existsSync(path)) return result(`${path} does not exist`, true);
        return view(path, input.view_range);
      case 'create':
        if (secret) return result(secret, true);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(input.file_text ?? ''), { flag: 'wx' });
        return result(`created ${path}`);
      case 'str_replace': {
        if (secret) return result(secret, true);
        if (!input.old_str) return result('str_replace needs old_str', true);
        if (input.new_str !== undefined && input.old_str === input.new_str) return result('old_str and new_str are the same — nothing would change', true);
        const text = readFileSync(path, 'utf8');
        const where = locate(text, input.old_str);
        if (!where) return result(`old_str was not found in ${path}`, true);
        if (where.hits !== 1) return result(`old_str appears ${where.hits} times in ${path} — include more context so it is unique`, true);
        let replacement = String(input.new_str ?? '');
        if (where.how) {
          if (text.includes('\r\n')) replacement = replacement.replace(/\r?\n/g, '\r\n');
          if (where.reindent) replacement = where.reindent(replacement);
        }
        writeFileSync(path, `${text.slice(0, where.start)}${replacement}${text.slice(where.end)}`);
        return result(`edited ${path}${where.how ? ` (old_str matched ${where.how})` : ''}`);
      }
      case 'insert': {
        if (secret) return result(secret, true);
        const lines = readFileSync(path, 'utf8').split('\n');
        const line = Number(input.insert_line ?? 0);
        if (!Number.isInteger(line)) return result('insert needs insert_line: the number of the line to insert after, 0 for the top of the file', true);
        // The tool sends the text as insert_text, a line with its newline; new_str is what an earlier version of the tool sent.
        const text = input.insert_text ?? input.new_str;
        if (typeof text !== 'string') return result('insert needs insert_text: the text to insert', true);
        // A file ending in a newline splits to a last empty piece, which is not a line to insert after.
        const at = Math.max(0, Math.min(lines.at(-1) === '' ? lines.length - 1 : lines.length, line));
        lines.splice(at, 0, text.replace(/\n$/, ''));
        writeFileSync(path, lines.join('\n'));
        return result(`inserted into ${path} after line ${at}`);
      }
      default:
        return result(`unknown command ${input.command}`, true);
    }
  } catch (cause) {
    return result(cause.message, true);
  }
}

/** One tool call, whichever tool it names; a name nothing answers to is an error the model can read. */
export function runTool(block, ctx, { signal = null } = {}) {
  if (block.name === BASH_TOOL.name) return runBash(block.input ?? {}, ctx, { signal });
  if (block.name === EDITOR_TOOL.name) return runEditor(block.input ?? {}, ctx);
  return result(`no tool called ${block.name}`, true);
}
