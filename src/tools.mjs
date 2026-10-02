import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, resolve } from 'node:path';
import { guardCommand, guardPath, isSecretPath } from './guard.mjs';
import { redact } from './redact.mjs';

/**
 * The two tools a job gets, and the policy every call passes through before it
 * runs: the guard, the path jail, a cap on what comes back, and redaction. All
 * of it is plain code in this process; the model never sees a way around it.
 */

/** Anthropic-defined, schema-less on the wire: the API knows their shape, so no schema is sent. */
export const BASH_TOOL = { type: 'bash_20250124', name: 'bash' };
export const EDITOR_TOOL = { type: 'text_editor_20250728', name: 'str_replace_based_edit_tool' };

const OUTPUT_CAP_CHARS = 16_000;
const VIEW_CAP_LINES = 400;
const COMMAND_TIMEOUT_MS = 540_000; // the same nine minutes a check gets
const MAX_BUFFER_CHARS = 64 * 1024 * 1024;

/** What a command's output ends with when the user stopped it. */
export const INTERRUPTED = 'stopped: interrupted by the user';

/** Environment names whose values are secrets. The tool's child processes never see them, so `env` cannot print them. */
const SECRET_ENV = /KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL/i;

/** The environment a tool's child process gets: everything except the secrets. */
export function childEnv(env = process.env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !SECRET_ENV.test(name)));
}

/**
 * Keeps both ends of a long output. The head says what ran and the tail is
 * where runners put the failures; the middle is the part worth losing, and the
 * marker says how much went and how to get a narrower answer.
 */
export function cap(text, max = OUTPUT_CAP_CHARS) {
  if (text.length <= max) return text;
  const half = Math.floor(max / 2);
  return `${text.slice(0, half)}\n[cut ${text.length - max} characters from the middle — narrow the command: tail, grep, or a line range]\n${text.slice(-half)}`;
}

/** The real path of the deepest ancestor that exists, so a symlink cannot point a new file outside the jail. */
function realAncestor(path) {
  let probe = path;
  while (!existsSync(probe)) {
    const up = dirname(probe);
    if (up === probe) return probe;
    probe = up;
  }
  return realpathSync(probe);
}

/** An absolute path under one of the roots, or an Error saying which it is outside of. */
export function jailed(path, { cwd, roots }) {
  if (typeof path !== 'string' || !path) throw new Error('a path is required');
  const absolute = isAbsolute(path) ? path : resolve(cwd, path);
  const real = realAncestor(absolute);
  const allowed = roots.map((r) => realpathSync(r)).some((r) => real === r || real.startsWith(`${r}/`));
  if (!allowed) throw new Error(`${path} is outside the project (${roots[0]}) — work only inside it`);
  return absolute;
}

const result = (content, isError = false) => ({ content: redact(String(content)).text, isError });

/**
 * Runs a shell command beside the process, not in front of it, so the screen
 * keeps drawing while it runs. It ends when the command does, when `signal`
 * says stop, or when `timeoutMs` is up — whichever is first. With a `signal`
 * the command gets a process group of its own, so the stop reaches everything
 * it started; without one it stays in the terminal's group, where Ctrl-C finds it.
 */
export function runCommand(command, { cwd, env, signal = null, timeoutMs = null }) {
  return new Promise((resolve) => {
    const grouped = signal !== null;
    const child = spawn(command, { cwd, shell: true, env, stdio: ['ignore', 'pipe', 'pipe'], detached: grouped });
    const streams = { stdout: '', stderr: '' };
    let size = 0;
    let stopped = null;
    let settled = false;
    const interrupt = () => kill('interrupted');
    const timer = timeoutMs === null ? null : setTimeout(() => kill('timeout'), timeoutMs);
    const settle = (status, killedBy) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', interrupt);
      resolve({ ...streams, status, signal: killedBy, stopped });
    };
    // What was stopped is not waited for: a child left in the background can hold the pipes open long after the shell is gone.
    const release = (status, killedBy) => {
      child.stdout.destroy();
      child.stderr.destroy();
      settle(status, killedBy);
    };
    function kill(why) {
      stopped ??= why;
      try {
        if (grouped) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        // Nothing left to kill.
      }
      if (child.exitCode !== null || child.signalCode !== null) release(child.exitCode, child.signalCode);
    }
    for (const name of ['stdout', 'stderr']) {
      child[name].setEncoding('utf8');
      child[name].on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BUFFER_CHARS) kill('overflow');
        else streams[name] += chunk;
      });
    }
    child.on('error', () => settle(null, null));
    child.on('close', settle);
    child.on('exit', (status, killedBy) => {
      if (stopped) release(status, killedBy);
    });
    if (signal?.aborted) interrupt();
    else signal?.addEventListener('abort', interrupt, { once: true });
  });
}

/** A shell command, in the project directory, without the secrets, refused when the guard says so. */
export async function runBash({ command }, ctx, { signal = null, timeoutMs = COMMAND_TIMEOUT_MS } = {}) {
  if (typeof command !== 'string' || !command.trim()) return result('bash needs a command', true);
  const refused = guardCommand(command);
  if (refused) return result(refused, true);
  const run = await runCommand(command, { cwd: ctx.cwd, env: ctx.env ?? childEnv(), signal, timeoutMs });
  const failed = run.stopped !== null || run.status !== 0;
  const output = `${run.stdout}${run.stderr}`.trimEnd();
  const tail = run.stopped === 'timeout' ? `\n(stopped: it ran past ${timeoutMs / 60_000} minutes)` : run.stopped === 'interrupted' ? `\n(${INTERRUPTED})` : failed ? `\n(exit ${run.status ?? run.signal})` : '';
  return result(cap(output) + tail, failed);
}

function view(path, range) {
  if (statSync(path).isDirectory()) return result(cap(readdirSync(path).join('\n')));
  const lines = readFileSync(path, 'utf8').split('\n');
  let [from, to] = Array.isArray(range) && range.length === 2 ? range : [1, lines.length];
  from = Math.max(1, from);
  to = to === -1 ? lines.length : Math.min(lines.length, to);
  const shown = lines.slice(from - 1, Math.min(to, from - 1 + VIEW_CAP_LINES));
  const cut = to - (from - 1 + shown.length);
  const body = shown.map((l, i) => `${from + i}\t${l}`).join('\n');
  return result(cut > 0 ? `${body}\n[${cut} more lines up to ${to} — view a smaller range]` : body);
}

/** The text editor's four commands, each inside the jail; secret files are neither shown nor written. */
export function runEditor(input, ctx) {
  let path;
  try {
    path = jailed(input.path, ctx);
  } catch (cause) {
    return result(cause.message, true);
  }
  const secret = guardPath(path);
  try {
    switch (input.command) {
      case 'view':
        if (secret) return result(secret, true);
        if (!existsSync(path)) return result(`${path} does not exist`, true);
        return view(path, input.view_range);
      case 'create':
        if (isSecretPath(path)) return result(`Refused: ${path} is a secret file — a change never adds one`, true);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, String(input.file_text ?? ''));
        return result(`created ${path}`);
      case 'str_replace': {
        if (secret) return result(secret, true);
        const text = readFileSync(path, 'utf8');
        const hits = text.split(input.old_str ?? '').length - 1;
        if (!input.old_str) return result('str_replace needs old_str', true);
        if (hits !== 1) return result(hits === 0 ? `old_str was not found in ${path}` : `old_str appears ${hits} times in ${path} — include more context so it is unique`, true);
        writeFileSync(path, text.replace(input.old_str, () => String(input.new_str ?? '')));
        return result(`edited ${path}`);
      }
      case 'insert': {
        if (secret) return result(secret, true);
        const lines = readFileSync(path, 'utf8').split('\n');
        const at = Math.max(0, Math.min(lines.length, Number(input.insert_line ?? 0)));
        lines.splice(at, 0, String(input.new_str ?? ''));
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
