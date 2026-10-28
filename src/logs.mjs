import { appendFileSync, chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { paths } from './paths.mjs';
import { redact } from './redact.mjs';

/**
 * Sumo's own logs, in ~/.sumo-agents/logs: private like everything else in the home, and never growing without end.
 * A log past LOG_ROTATE_BYTES is moved aside to `<name>.1` (one older generation kept) before the next line is
 * written, so the newest lines are always in the file of that name and a log costs at most twice the limit.
 */
export const LOG_ROTATE_BYTES = 1024 * 1024;
/** How many crash files are kept: the newest. */
const CRASHES_KEPT = 10;

/** A log past the limit, moved aside. Nothing there yet, or a file that cannot be moved, is left as it is: a log never stops the work. */
export function rotate(file, limit = LOG_ROTATE_BYTES) {
  try {
    if (statSync(file).size > limit) renameSync(file, `${file}.1`);
  } catch {
    // Not there yet, or not ours to move.
  }
}

/** The logs this process has made sure are private: looked at once each, on the first line written. */
const madePrivate = new Set();

/**
 * One or more lines added to a log of the home: made private when it is made, moved aside when it has grown too big.
 * A mode is given only to a file being made, so a log from before logs were private is made private here, once.
 */
export function appendLog(name, text) {
  const dir = paths().logs;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  rotate(file);
  if (!madePrivate.has(file)) {
    madePrivate.add(file);
    try {
      if (statSync(file).mode & 0o077) chmodSync(file, 0o600);
    } catch {
      // Not there yet: made private below, when it is made.
    }
  }
  appendFileSync(file, text, { mode: 0o600 });
}

/**
 * A log a long-lived process still holds open, kept in bounds where it lies: past the limit its lines are copied aside
 * to `<name>.1` and the file emptied in place, so the writer — appending — carries on at its new start. A rename would
 * leave the writer filling the moved file until it restarts.
 */
export function trimLog(name, limit = LOG_ROTATE_BYTES) {
  const file = join(paths().logs, name);
  try {
    if (statSync(file).size <= limit) return;
    copyFileSync(file, `${file}.1`);
    truncateSync(file, 0);
  } catch {
    // Not there, or not ours to trim: a log never stops the work.
  }
}

/** A log opened for a child process to write to (llama-server's), moved aside first if it has grown too big. */
export function openLog(name) {
  const dir = paths().logs;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, name);
  rotate(file);
  return openSync(file, 'a', 0o600);
}

const CRASH = /^crash-.+\.log$/;

/** The crash files there are, newest first, by their names, which are the times they were written. */
export function crashFiles() {
  try {
    return readdirSync(paths().logs).filter((name) => CRASH.test(name)).sort().reverse().map((name) => join(paths().logs, name));
  } catch {
    return [];
  }
}

/** The newest crash file written since `since` (a Date), with when and the line that says what failed; null when there is none. */
export function latestCrash(since) {
  const [file] = crashFiles();
  if (!file) return null;
  const at = statSync(file).mtime;
  if (at < since) return null;
  const said = readFileSync(file, 'utf8').split('\n').find((line) => line.startsWith('error: '))?.slice('error: '.length) ?? 'see the file';
  return { file, at, said };
}

/**
 * What a crash leaves behind: the version, the runtime, the command and the stack, every part redacted — an argument or
 * a message may hold a token — in a file only its owner can read. Returns the file, or null when even that failed: a
 * crash report must never be a second crash.
 */
/** The line a crash file names its command with: the command, and only how many words came after it. */
function commandOf(args) {
  const [command = '(none)', ...rest] = args;
  const name = /^[a-z][a-z-]*$/.test(command) ? command : '(not a command)';
  return `command: ${name}${rest.length > 0 ? ` (${rest.length} more argument${rest.length === 1 ? '' : 's'}, not kept)` : ''}`;
}

function writeCrash(error, origin, { version = '', argv = process.argv, now = new Date() } = {}) {
  try {
    const dir = paths().logs;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = join(dir, `crash-${now.toISOString().replace(/[:.]/g, '-')}.log`);
    const stack = error instanceof Error ? (error.stack ?? `${error.name}: ${error.message}`) : String(error);
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    const body = [
      `sumo ${version || 'unknown'} crashed (${origin})`,
      `at: ${now.toISOString()}`,
      `node: ${process.versions.bun ? `bun ${process.versions.bun}` : process.versions.node} · ${process.platform} ${process.arch}`,
      // The command, never what was typed after it: a search, a memory or a message is the user's words, not a bug report's.
      commandOf(argv.slice(2)),
      `error: ${message.split('\n')[0]}`,
      '',
      stack,
      '',
    ].join('\n');
    writeFileSync(file, redact(body).text, { mode: 0o600, flag: 'wx' });
    for (const old of crashFiles().slice(CRASHES_KEPT)) rmSync(old, { force: true });
    return file;
  } catch {
    return null;
  }
}

/**
 * Crashes written down as they happen, the process otherwise left to end as Node ends it: the monitor runs before
 * Node's own handling and changes none of it — the stack still goes to stderr, the exit code is still 1, and the chat
 * screen's own exit hooks still hand the terminal back. A rejection nobody handled reaches it as an uncaught exception.
 */
export function watchForCrashes(version) {
  process.on('uncaughtExceptionMonitor', (error, origin) => {
    const file = writeCrash(error, origin, { version });
    if (file) process.stderr.write(`sumo: crashed — written to ${file} (sumo doctor --report bundles it)\n`);
  });
}

/** The last `count` lines of a file, redacted; empty when it cannot be read. */
export function tailOf(file, count = 50) {
  try {
    const lines = readFileSync(file, 'utf8').split('\n');
    if (lines.at(-1) === '') lines.pop();
    return redact(lines.slice(-count).join('\n')).text;
  } catch {
    return '';
  }
}

/** The logs a report shows: the files directly in the logs folder that are not crash files, oldest generation last. */
export function logFiles() {
  try {
    const dir = paths().logs;
    return readdirSync(dir)
      .filter((name) => !CRASH.test(name) && existsSync(join(dir, name)) && statSync(join(dir, name)).isFile())
      .sort()
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}
