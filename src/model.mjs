import { spawn, spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { getMeta } from './db.mjs';
import { paths } from './paths.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';

const TIMEOUT_MS = 180_000;
const MAX_SPEND_USD = '0.25';
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
// Room for a schema'd answer with a sentence of reasoning; a small model cut off mid-string is unparseable JSON.
const MAX_ANSWER_TOKENS = 400;

/** The path setup pinned, unless it has since vanished — then whatever PATH offers, which may still be nothing. */
function pinnedOrOnPath(db) {
  const pinned = getMeta(db, 'claude.path');
  if (pinned) {
    try {
      accessSync(pinned, constants.X_OK);
      return pinned;
    } catch {
      // Pinned before a reinstall or a move; fall through.
    }
  }
  return 'claude';
}

/** Claude Code's own JSON envelope, whichever binary produced it, turned into the shape every caller gets back. */
function envelopeToResult(run, command) {
  if (run.error) return failure(`could not run ${command}: ${run.error.message}`);
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    return failure(`unreadable answer (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 300)}`);
  }

  const usage = {
    inputTokens: (envelope.usage?.input_tokens ?? 0) + (envelope.usage?.cache_read_input_tokens ?? 0) + (envelope.usage?.cache_creation_input_tokens ?? 0),
    outputTokens: envelope.usage?.output_tokens ?? 0,
    costUsd: envelope.total_cost_usd ?? 0,
  };
  if (envelope.is_error) return { ...failure(`model call failed: ${String(envelope.result ?? envelope.subtype).slice(0, 300)}`), usage };

  let data = envelope.structured_output;
  if (data === undefined || data === null) {
    try {
      data = JSON.parse(String(envelope.result).replace(/^```(?:json)?\s*|\s*```$/g, ''));
    } catch {
      return { ...failure('the answer was not the JSON that was asked for'), usage };
    }
  }
  return { ok: true, data, usage, error: null };
}

/**
 * One call to the cheap model, outside any conversation.
 *
 * It runs Claude Code headless with its tools off, its system prompt replaced
 * and the user's own hooks skipped, from an empty directory — so it loads no
 * project instructions, cannot touch anything, and costs a few thousand tokens
 * instead of a session's worth. SUMO_AGENTS_SCRIBE marks the process so this
 * repo's hooks ignore it: the call must never be recorded as something the
 * user said, or trigger another call.
 *
 * SUMO_AGENTS_MODEL_CMD swaps the binary for a stand-in that reads the same
 * request and prints the same envelope; the tests use it to replay recorded
 * answers without spending anything.
 */
export function callModel(db, { system, prompt, schema, model }) {
  const cwd = join(paths().home, 'scribe');
  mkdirSync(cwd, { recursive: true, mode: 0o700 });

  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  const command = standIn ?? pinnedOrOnPath(db);
  const args = standIn
    ? []
    : [
        '-p', '--model', model, '--tools', '', '--setting-sources', 'project', '--no-session-persistence',
        '--output-format', 'json', '--max-budget-usd', MAX_SPEND_USD,
        '--system-prompt', system, '--json-schema', JSON.stringify(schema),
      ];
  const input = standIn ? JSON.stringify({ system, prompt, schema, model }) : prompt;

  const run = spawnSync(command, args, {
    cwd,
    input,
    encoding: 'utf8',
    timeout: TIMEOUT_MS,
    maxBuffer: 16 * 1024 * 1024,
    // Extended thinking is off on purpose. Measured on the same input it took 6,426 output tokens and 65 s
    // to find 2 memories; without it, 479 tokens and 4 s to find 5. Labelling text is not a reasoning task.
    env: { ...process.env, SUMO_AGENTS_SCRIBE: '1', MAX_THINKING_TOKENS: '0' },
  });

  return envelopeToResult(run, command);
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

/** Polls llama-server's /health until it answers {"status":"ok"}, the child dies, or the budget runs out. */
async function waitForHealth(port, dead, deadlineMs = HEALTH_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < deadlineMs) {
    if (dead()) throw new Error(`llama-server exited before it was healthy: ${dead()}`);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, { signal: AbortSignal.timeout(HEALTH_POLL_MS * 4) });
      if (res.ok && (await res.json())?.status === 'ok') return;
    } catch {
      // Not listening yet.
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(`llama-server did not become healthy within ${Math.round(deadlineMs / 1000)}s`);
}

/**
 * One call to the router model, run locally through llama-server instead of Claude Code.
 * Same envelope as callModel ({ ok, data, usage, error }), so a caller cannot tell which
 * backend answered. Async, because there is no synchronous way to poll a health endpoint
 * or stream a chat completion without blocking the event loop; the stand-in path below
 * still uses spawnSync, exactly like callModel, so tests never wait on a promise that
 * depends on a real server.
 */
export async function callLocalModel(db, { system, prompt, schema }) {
  const now = new Date().toISOString();
  const modelFile = getMeta(db, 'config.model.file') ?? CONFIG_DEFAULTS['model.file'];
  const modelLabel = `local:${modelFile}`;
  const log = (result) => logRun(db, { kind: 'local', model: modelLabel, result, note: result.ok ? 'ok' : result.error, now });

  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) {
    const run = spawnSync(standIn, [], {
      input: JSON.stringify({ system, prompt, schema, model: 'local' }),
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    const result = envelopeToResult(run, standIn);
    log(result);
    return result;
  }

  const modelPath = join(paths().models, modelFile);
  if (!existsSync(modelPath)) {
    const result = failure(`model file not found at ${modelPath} — run: mem setup`);
    log(result);
    return result;
  }
  const llama = getMeta(db, 'llama.path');
  if (!llama) {
    const result = failure('llama-server is not pinned — run: mem setup');
    log(result);
    return result;
  }
  try {
    accessSync(llama, constants.X_OK);
  } catch {
    const result = failure(`llama-server is no longer at ${llama} — run: mem setup`);
    log(result);
    return result;
  }

  const port = await freePort();
  const child = spawn(llama, ['-m', modelPath, '--host', '127.0.0.1', '--port', String(port), '-c', '8192', '-ngl', '99', '--reasoning-budget', '0'], {
    stdio: 'ignore',
    detached: false,
  });
  // A binary that vanished between the check and the spawn, or a server that dies on start (port taken,
  // bad model), must surface as an answer, never as an unhandled 'error' event that takes mem down with it.
  let dead = null;
  child.on('error', (cause) => { dead = cause.message; });
  child.on('exit', (code, signal) => { dead ??= `exit ${code ?? signal}`; });
  try {
    await waitForHealth(port, () => dead);
    const res = await fetch(`http://127.0.0.1:${port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
        chat_template_kwargs: { enable_thinking: false },
        temperature: 0,
        max_tokens: MAX_ANSWER_TOKENS,
      }),
    });
    if (!res.ok) throw new Error(`llama-server returned HTTP ${res.status}`);
    const body = await res.json();
    const data = JSON.parse(body.choices[0].message.content);
    const usage = {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      costUsd: 0,
    };
    const result = { ok: true, data, usage, error: null };
    log(result);
    return result;
  } catch (cause) {
    const result = failure(cause.message);
    log(result);
    return result;
  } finally {
    child.kill();
  }
}

function failure(error) {
  return { ok: false, data: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 }, error };
}

/** The one `model_runs` row every cheap-model call leaves behind, whichever backend answered it. */
export function logRun(db, { kind, model, result, note, now }) {
  db.prepare('INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, note) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').run(
    now, kind, model, result.usage.inputTokens, result.usage.outputTokens, result.usage.costUsd, result.ok ? 1 : 0, note,
  );
  mkdirSync(paths().logs, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(paths().logs, 'scribe.log'),
    `${now} ${kind} ${model} ${result.ok ? 'ok' : 'FAILED'} in=${result.usage.inputTokens} out=${result.usage.outputTokens} $${result.usage.costUsd.toFixed(4)} ${note}\n`,
  );
}
