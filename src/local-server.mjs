import { spawn, spawnSync } from 'node:child_process';
import { closeSync, mkdirSync, openSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join } from 'node:path';
import { getMeta, setMeta, tx } from './db.mjs';
import { paths } from './paths.mjs';

/**
 * The one llama-server behind every local model call. It runs in router mode over the models directory,
 * detached from whichever `sumo` needed it first, so the router and the memory passes share a model that
 * is loaded once; it sleeps after SLEEP_IDLE_SECONDS (a few hundred MB resident, under a second to wake)
 * instead of holding the model between calls. Where it is lives in meta, so every process finds the same one.
 */
const META_KEY = 'llama.server';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
const SLEEP_IDLE_SECONDS = 600;
/** The context the server is given: the largest scribe bundle seen was 24k tokens, dream's 90th percentile 12k. */
export const LOCAL_CONTEXT_TOKENS = 32_768;
/** How long a pass may think. Measured on the scribe probe, the 4B model answers right within this; uncapped, a small model can think until the token limit and answer nothing. */
export const LOCAL_REASONING_BUDGET = 1024;

/** Router mode names a model after its file. */
export const modelIdOf = (file) => basename(file, '.gguf');

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
}

/** Only a process still carrying the port it was started on is ours: a pid can be reused once the server is gone. */
function ours(server) {
  if (!alive(server.pid)) return false;
  const ps = spawnSync('ps', ['-o', 'command=', '-p', String(server.pid)], { encoding: 'utf8' });
  return (ps.stdout ?? '').includes(`--port ${server.port}`);
}

function recorded(db) {
  try {
    return JSON.parse(getMeta(db, META_KEY) ?? 'null');
  } catch {
    return null;
  }
}

async function healthy(port, timeoutMs = HEALTH_POLL_MS * 4) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(timeoutMs) });
    return res.ok && (await res.json())?.status === 'ok';
  } catch {
    return false;
  }
}

/** A TCP port nothing is listening on yet, for llama-server to bind to. */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls /health until it answers {"status":"ok"}, the server dies, or the budget runs out. */
async function waitForHealth(port, dead) {
  const start = Date.now();
  while (Date.now() - start < HEALTH_TIMEOUT_MS) {
    if (dead()) throw new Error(`llama-server exited before it was healthy: ${dead()}`);
    if (await healthy(port)) return;
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(HEALTH_TIMEOUT_MS / 1000)}s`);
}

/** Starts the server for `file`, detached, logging to logs/llama-server.log, and records it. */
function start(db, { llama, file, port }) {
  const logs = paths().logs;
  mkdirSync(logs, { recursive: true, mode: 0o700 });
  const out = openSync(join(logs, 'llama-server.log'), 'a');
  let dead = null;
  let child;
  try {
    child = spawn(llama, [
      '--models-dir', paths().models, '--host', '127.0.0.1', '--port', String(port),
      '--sleep-idle-seconds', String(SLEEP_IDLE_SECONDS), '-c', String(LOCAL_CONTEXT_TOKENS), '-ngl', '99',
      '--jinja', '--reasoning-budget', String(LOCAL_REASONING_BUDGET), '-np', '1',
    ], { detached: true, stdio: ['ignore', out, out] });
  } finally {
    closeSync(out);
  }
  // A binary that vanished between the check and the spawn, or a server that dies on start, must surface as an
  // answer from the health wait, never as an unhandled 'error' event that takes sumo down with it.
  child.on('error', (cause) => { dead = cause.message; });
  child.on('exit', (code, signal) => { dead ??= `exit ${code ?? signal}`; });
  child.unref();
  const server = { pid: child.pid, port, file, llama, startedAt: Date.now() };
  setMeta(db, META_KEY, JSON.stringify(server));
  return { server, dead: () => dead };
}

/**
 * The server to send this call to: the recorded one when it was started for this model and binary and still
 * answers, otherwise a fresh one in its place. Two processes starting at once start one server between them:
 * the check and the spawn are one transaction.
 */
export async function ensureLocalServer(db, { llama, file }) {
  const current = recorded(db);
  if (current && current.file === file && current.llama === llama && ours(current)) {
    if (await healthy(current.port)) return current;
    // Started a moment ago by another sumo and still coming up: wait for it rather than replace it.
    if (Date.now() - current.startedAt < HEALTH_TIMEOUT_MS) {
      await waitForHealth(current.port, () => (ours(current) ? null : 'exited'));
      return current;
    }
  }
  // Only the server judged stale above: another sumo may have replaced it since, and that one is not ours to end.
  if (current) stopLocalServer(db, current);
  const port = await freePort();
  const { server, dead } = tx(db, () => {
    const again = recorded(db);
    if (again && again.file === file && again.llama === llama && ours(again)) return { server: again, dead: () => null };
    return start(db, { llama, file, port });
  });
  await waitForHealth(server.port, dead);
  return server;
}

/**
 * Ends the recorded server, if it is still ours, and forgets it. Setup calls this: the model or the binary may have changed.
 * Given `expected`, only that server: a record that has changed since it was read belongs to someone else's call.
 */
export function stopLocalServer(db, expected) {
  const current = recorded(db);
  if (!current) return;
  if (expected && (current.pid !== expected.pid || current.startedAt !== expected.startedAt)) return;
  if (ours(current)) {
    try {
      process.kill(current.pid, 'SIGTERM');
    } catch {
      // Gone between the check and the signal.
    }
  }
  db.prepare('DELETE FROM meta WHERE key = ?').run(META_KEY);
}

/** One line for `sumo scribe status`: where the server is and what it says about the model. */
export async function localServerStatus(db, { file }) {
  const current = recorded(db);
  if (!current) return 'local server: not running (starts on the first call)';
  if (!ours(current)) return `local server: gone (was pid ${current.pid}); starts again on the next call`;
  try {
    const res = await fetch(`http://127.0.0.1:${current.port}/v1/models`, { signal: AbortSignal.timeout(1000) });
    const model = (await res.json()).data?.find((m) => m.id === modelIdOf(file));
    return `local server: pid ${current.pid}, port ${current.port}, ${file} ${model?.status?.value ?? 'not listed — run: sumo setup'}`;
  } catch {
    return `local server: pid ${current.pid} on port ${current.port} is not answering`;
  }
}
