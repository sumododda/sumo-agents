import Anthropic from '@anthropic-ai/sdk';
import { jsonSchemaOutputFormat } from '@anthropic-ai/sdk/helpers/json-schema';
import { spawnSync } from 'node:child_process';
import { accessSync, appendFileSync, constants, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicClientOptions, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { getMeta } from './db.mjs';
import { ensureLocalServer, LOCAL_REASONING_BUDGET, modelIdOf } from './local-server.mjs';
import { paths } from './paths.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';

const TIMEOUT_MS = 180_000;
// Room for a schema'd answer with a sentence of reasoning; a small model cut off mid-string is unparseable JSON.
const MAX_ANSWER_TOKENS = 400;
// A memory pass on the local model thinks first, up to the server's reasoning budget, then lists its operations.
const MAX_LOCAL_PASS_TOKENS = LOCAL_REASONING_BUDGET + 3072;
// A scribe pass answers with a list of operations. Every model but haiku thinks first, and the thinking counts toward this
// limit too: 8k holds both, ends well inside the call's three minutes, and is far below the 21,333 the SDK sends without
// streaming. An answer longer than this is the model rambling, not remembering.
const MAX_API_ANSWER_TOKENS = 8192;
/** What the SDK's beta parse() sent with a schema'd request, kept for the OAuth path that goes through the beta API. */
const STRUCTURED_OUTPUTS_BETA = 'structured-outputs-2025-12-15';

/** The short names the router and `sumo config` use, and the API model each one means. */
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
    // Sent as written. The helper's own rewrite moves every enum into a description, and the API then holds the answer to none of them.
    output_config: { format: jsonSchemaOutputFormat(schema, { transform: false }) },
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
  if (cause instanceof Anthropic.AuthenticationError) return 'the Anthropic credential is missing or invalid — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the shell that runs sumo';
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
export async function callModel(db, { system, prompt, schema, model, kind }) {
  // The passes' default: the same local model that routes jobs, with thinking on; its caller keeps the ledger.
  if (model === 'local') return callLocalModel(db, { system, prompt, schema, kind, think: true, maxTokens: MAX_LOCAL_PASS_TOKENS, log: false });

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
    // Not the SDK's parse(): it throws on an answer that is not JSON before the stop reason or the usage can be read,
    // so a cut-off or refused answer would be misnamed and what it spent never logged. The answer is parsed below instead.
    const response = credential?.type === 'oauth'
      ? await client.beta.messages.create({ ...request, betas: [...request.betas, STRUCTURED_OUTPUTS_BETA] })
      : await client.messages.create(request);
    const usage = usageOf(model, response.usage);
    if (response.stop_reason === 'refusal') return { ...failure(`the model declined to answer (${response.stop_details?.category ?? 'no category'})`), usage };
    if (response.stop_reason === 'max_tokens') return { ...failure(`the answer was cut off at ${MAX_API_ANSWER_TOKENS} tokens`), usage };
    let data = null;
    try {
      data = JSON.parse(response.content.find((b) => b.type === 'text')?.text ?? '');
    } catch {
      // Said below.
    }
    if (data === null) return { ...failure('the answer was not the JSON that was asked for'), usage };
    return { ok: true, data, usage, error: null };
  } catch (cause) {
    return failure(describe(cause));
  }
}
/** llama-server's error body, as one line a person can act on. */
function describeLocal(status, body) {
  const error = body?.error ?? {};
  if (error.type === 'exceed_context_size_error') {
    return `the bundle (${error.n_prompt_tokens} tokens) is larger than the local model's context (${error.n_ctx} tokens)`;
  }
  return `llama-server returned HTTP ${status}: ${String(error.message ?? JSON.stringify(body)).slice(0, 200)}`;
}

/**
 * One call to the local model, through the llama-server that stays up for it (see local-server.mjs).
 * Same envelope as callModel ({ ok, data, usage, error }), so a caller cannot tell which backend
 * answered. The router asks with the defaults: no thinking, a short answer, a ledger row of kind
 * `local`. A memory pass asks with `think`, a longer answer cap and `log: false`, keeping its own
 * ledger; `kind` tells a stand-in which of them is asking. The stand-in path uses spawnSync, exactly
 * like callModel, so tests never wait on a promise that depends on a real server.
 */
export async function callLocalModel(db, { system, prompt, schema, kind = 'local', think = false, maxTokens = MAX_ANSWER_TOKENS, log = true }) {
  const now = new Date().toISOString();
  const modelFile = getMeta(db, 'config.model.file') ?? CONFIG_DEFAULTS['model.file'];
  const modelLabel = `local:${modelFile}`;
  const record = (result) => {
    if (log) logRun(db, { kind: 'local', model: modelLabel, result, note: result.ok ? 'ok' : result.error, now });
    return result;
  };

  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) {
    const run = spawnSync(standIn, [], {
      input: JSON.stringify({ system, prompt, schema, model: 'local', kind, think, maxTokens }),
      encoding: 'utf8',
      timeout: TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return record(envelopeToResult(run, standIn));
  }

  const modelPath = join(paths().models, modelFile);
  if (!existsSync(modelPath)) return record(failure(`model file not found at ${modelPath} — run: sumo setup`));
  const llama = getMeta(db, 'llama.path');
  if (!llama) return record(failure('llama-server is not pinned — run: sumo setup'));
  try {
    accessSync(llama, constants.X_OK);
  } catch {
    return record(failure(`llama-server is no longer at ${llama} — run: sumo setup`));
  }

  try {
    const server = await ensureLocalServer(db, { llama, file: modelFile });
    const res = await fetch(`http://127.0.0.1:${server.port}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      body: JSON.stringify({
        model: modelIdOf(modelFile),
        messages: [
          { role: 'system', content: system },
          { role: 'user', content: prompt },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'answer', schema, strict: true } },
        chat_template_kwargs: { enable_thinking: think },
        temperature: 0,
        max_tokens: maxTokens,
      }),
    });
    const text = await res.text();
    let body = null;
    try {
      body = JSON.parse(text);
    } catch {
      // Said below, with the status.
    }
    if (!res.ok) throw new Error(describeLocal(res.status, body ?? { error: { message: text } }));
    const choice = body.choices[0];
    const usage = {
      inputTokens: body.usage?.prompt_tokens ?? 0,
      outputTokens: body.usage?.completion_tokens ?? 0,
      costUsd: 0,
      cacheReadTokens: null,
      cacheCreationTokens: null,
    };
    if (choice.finish_reason === 'length') return record({ ...failure(`the answer was cut off at ${maxTokens} tokens`), usage });
    let data = null;
    try {
      data = JSON.parse(choice.message.content);
    } catch {
      // Said below.
    }
    if (data === null) return record({ ...failure('the answer was not the JSON that was asked for'), usage });
    return record({ ok: true, data, usage, error: null });
  } catch (cause) {
    return record(failure(cause.message));
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
