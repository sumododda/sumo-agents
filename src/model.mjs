import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { anthropicClientOptions, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { getMeta } from './db.mjs';
import { paths } from './paths.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';

const TIMEOUT_MS = 180_000;
const HEALTH_TIMEOUT_MS = 60_000;
const HEALTH_POLL_MS = 250;
// Room for a schema'd answer with a sentence of reasoning; a small model cut off mid-string is unparseable JSON.
const MAX_ANSWER_TOKENS = 400;
// A scribe pass answers with a list of operations; a longer one than this is the model rambling, not remembering.
const MAX_API_ANSWER_TOKENS = 4096;

/** The short names the router and `mem config` use, and the API model each one means. */
export const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};

/** US dollars per million tokens: input, output, and what a cache read costs relative to input. */
const PRICES = {
  'claude-haiku-4-5-20251001': { input: 1, output: 5, cacheRead: 0.1 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.1 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 },
};
const CACHE_WRITE = 1.25;

export const modelId = (model) => MODEL_IDS[model] ?? model;

/** What one response cost, from its usage and the price list; 0 for a model the list does not know. */
export function costOf(model, usage) {
  const price = PRICES[modelId(model)];
  if (!price) return 0;
  const plain = usage.input_tokens ?? 0;
  const read = usage.cache_read_input_tokens ?? 0;
  const written = usage.cache_creation_input_tokens ?? 0;
  const out = usage.output_tokens ?? 0;
  return (plain * price.input + read * price.input * price.cacheRead + written * price.input * CACHE_WRITE + out * price.output) / 1_000_000;
}

/** The request one cheap-model call sends: a frozen system prompt, the bundle as the one user turn, the answer shape enforced by the API. */
export function requestFor({ system, prompt, schema, model }) {
  return {
    model: modelId(model),
    max_tokens: MAX_API_ANSWER_TOKENS,
    system,
    messages: [{ role: 'user', content: prompt }],
    output_config: { format: jsonSchemaOutputFormat(schema) },
  };
}

/** The usage of an API response in the shape every caller gets back: inputTokens is the total, the cache split rides beside it. */
export function usageOf(model, usage) {
  const cacheReadTokens = usage?.cache_read_input_tokens ?? null;
  const cacheCreationTokens = usage?.cache_creation_input_tokens ?? null;
  return {
    inputTokens: (usage?.input_tokens ?? 0) + (cacheReadTokens ?? 0) + (cacheCreationTokens ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    costUsd: costOf(model, usage ?? {}),
    cacheReadTokens,
    cacheCreationTokens,
  };
}

/** The stand-in's JSON envelope (the shape Claude Code printed, kept so recorded answers still replay), turned into a result. */
function envelopeToResult(run, command) {
  if (run.error) return failure(`could not run ${command}: ${run.error.message}`);
  let envelope;
  try {
    envelope = JSON.parse(run.stdout);
  } catch {
    return failure(`unreadable answer (exit ${run.status}): ${(run.stderr || run.stdout).slice(0, 300)}`);
  }

  const usage = { ...usageOf(null, envelope.usage), costUsd: envelope.total_cost_usd ?? 0 };
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

/** What went wrong with an API call, in one line a person can act on. */
function describe(cause) {
  if (cause instanceof Anthropic.AuthenticationError) return 'the Anthropic credential is missing or invalid — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the shell that runs mem';
  if (cause instanceof Anthropic.RateLimitError) return 'the API is rate-limiting this key — try again in a minute';
  if (cause instanceof Anthropic.APIError) return `the API answered ${cause.status ?? 'an error'}: ${String(cause.message).slice(0, 300)}`;
  return String(cause?.message ?? cause).slice(0, 300);
}

/**
 * One call to the cheap model, outside any conversation.
 *
 * It goes straight to the Messages API with an API key or Claude Code OAuth token: a
 * system prompt, one user turn, and a JSON schema the API itself enforces on
 * the answer. No tools, no thinking, nothing loaded from disk — so it costs the
 * prompt and the answer, and nothing else.
 *
 * SUMO_AGENTS_MODEL_CMD swaps the call for a stand-in that reads the same
 * request and prints a recorded envelope; the tests use it to replay answers
 * without spending anything.
 */
export async function callModel(db, { system, prompt, schema, model }) {
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) {
    const run = spawnSync(standIn, [], {
      input: JSON.stringify({ system, prompt, schema, model }),
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return envelopeToResult(run, standIn);
  }

  try {
    const credential = resolveAnthropicCredential();
    const client = new Anthropic(anthropicClientOptions(TIMEOUT_MS, credential));
    const request = authenticatedRequest(requestFor({ system, prompt, schema, model }), credential);
    const response = credential?.type === 'oauth'
      ? await client.beta.messages.parse(request)
      : await client.messages.parse(request);
    const usage = usageOf(model, response.usage);
    if (response.stop_reason === 'refusal') return { ...failure(`the model declined to answer (${response.stop_details?.category ?? 'no category'})`), usage };
    if (response.stop_reason === 'max_tokens') return { ...failure(`the answer was cut off at ${MAX_API_ANSWER_TOKENS} tokens`), usage };
    if (response.parsed_output === null || response.parsed_output === undefined) return { ...failure('the answer was not the JSON that was asked for'), usage };
    return { ok: true, data: response.parsed_output, usage, error: null };
  } catch (cause) {
    return failure(describe(cause));
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
 * One call to the router model, run locally through llama-server instead of the API.
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
      cacheReadTokens: null,
      cacheCreationTokens: null,
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
  return { ok: false, data: null, usage: { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: null, cacheCreationTokens: null }, error };
}

/**
 * The one `model_runs` row every cheap-model call leaves behind, whichever backend answered it.
 * The cache split comes from result.usage and the job and session from the options; any of them
 * missing is written as NULL.
 */
export function logRun(db, { kind, model, result, note, now, jobId = null, sessionId = null }) {
  db.prepare(
    `INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, note, cache_read_tokens, cache_creation_tokens, job_id, session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    now, kind, model, result.usage.inputTokens, result.usage.outputTokens, result.usage.costUsd, result.ok ? 1 : 0, note,
    result.usage.cacheReadTokens ?? null, result.usage.cacheCreationTokens ?? null, jobId, sessionId,
  );
  mkdirSync(paths().logs, { recursive: true, mode: 0o700 });
  appendFileSync(
    join(paths().logs, 'scribe.log'),
    `${now} ${kind} ${model} ${result.ok ? 'ok' : 'FAILED'} in=${result.usage.inputTokens} out=${result.usage.outputTokens} $${result.usage.costUsd.toFixed(4)} ${note}\n`,
  );
}
