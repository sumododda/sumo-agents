import Anthropic from '@anthropic-ai/sdk';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { brief, getJob } from './jobs.mjs';
import { UsageError } from './memory.mjs';
import { costOf, logRun, modelId, usageOf } from './model.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { BASH_TOOL, childEnv, EDITOR_TOOL, runTool } from './tools.mjs';

/**
 * The loop a job runs in: one request, the policy pipeline over each tool call,
 * one ledger row per response, until the model stops calling tools. The brief
 * is the first and only user turn; the job closes itself through `mem job
 * finish` in bash, exactly as it does under any harness.
 */

const MAX_TURNS = 150;
const MAX_OUTPUT_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 600_000;
const BETAS = ['context-management-2025-06-27'];

/** Old tool results are cleared server-side once the context is this big; never rewritten here, so the history stays append-only. */
const CONTEXT_EDITS = [
  { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 60_000 }, keep: { type: 'tool_uses', value: 5 }, clear_at_least: { type: 'input_tokens', value: 10_000 } },
];

export const systemPrompt = () => readFileSync(join(REPO_ROOT, 'prompts', 'agent.md'), 'utf8').trim();

/** The request for a job's first turn. The prefix — tools, then system — is byte-stable per role, so it caches across every turn and every job. */
export function paramsFor({ job, text, system = systemPrompt() }) {
  const params = {
    model: modelId(job.model),
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools: job.agent === 'worker' ? [BASH_TOOL, EDITOR_TOOL] : [BASH_TOOL],
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    betas: BETAS,
    context_management: { edits: CONTEXT_EDITS },
  };
  if (job.effort && job.effort !== 'none') params.output_config = { effort: job.effort };
  return params;
}

/** One cache breakpoint rides on the last block of the last message, so each turn reads everything before it. */
function markTail(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) delete block.cache_control;
  }
  const last = messages.at(-1);
  if (Array.isArray(last?.content) && last.content.length > 0) last.content.at(-1).cache_control = { type: 'ephemeral' };
}

const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** The default transport: streamed, so a long turn never trips the HTTP timeout. */
async function sendToApi(params) {
  const client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  return client.beta.messages.stream(params).finalMessage();
}

/**
 * Runs a job to the end of its conversation. `send` is the transport, replaced
 * in tests by canned responses. Returns what happened, never throws for
 * anything the model did; a job that is not open is refused up front.
 */
export async function runJob(db, id, { send = sendToApi, now = () => new Date().toISOString() } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  const project = getProject(db, job.project);

  const params = paramsFor({ job, text: brief(db, id) });
  const ctx = { cwd: project.path, roots: [project.path, join(paths().jobs, String(id))], env: childEnv() };
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0 };
  let turns = 0;
  let stop = 'max_turns';
  let text = '';

  while (turns < MAX_TURNS) {
    turns++;
    markTail(params.messages);
    let response;
    try {
      response = await send(params);
    } catch (cause) {
      logRun(db, { kind: job.agent, model: params.model, result: { ok: false, usage: usageOf(job.model, null) }, note: `turn ${turns}: ${String(cause.message).slice(0, 200)}`, now: now(), jobId: id, sessionId: job.session_id });
      return { job: getJob(db, id), turns, stop: 'error', error: String(cause.message).slice(0, 300), text, totals };
    }
    const usage = usageOf(job.model, response.usage);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(job.model, response.usage ?? {});
    logRun(db, { kind: job.agent, model: params.model, result: { ok: true, usage }, note: `turn ${turns} ${response.stop_reason}`, now: now(), jobId: id, sessionId: job.session_id });

    params.messages.push({ role: 'assistant', content: response.content });
    text = textOf(response.content) || text;
    stop = response.stop_reason;
    if (response.stop_reason !== 'tool_use') break;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    totals.toolCalls += calls.length;
    params.messages.push({
      role: 'user',
      content: calls.map((call) => {
        const out = runTool(call, ctx);
        return { type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: out.isError };
      }),
    });
  }

  return { job: getJob(db, id), turns, stop, error: null, text, totals };
}

/** What `mem job run` prints: whether the job closed itself, and what the run cost. */
export function runLines(outcome) {
  const { job, turns, stop, totals } = outcome;
  const closed = job.status === 'done' ? 'DONE' : job.status === 'failed' ? 'FAILED' : job.status === 'needs_input' ? 'NEEDS_INPUT' : 'never closed';
  const lines = [
    `STATUS: ${closed} — j${job.id}`,
    `${turns} turn${turns === 1 ? '' : 's'}, ${totals.toolCalls} tool calls, ${totals.inputTokens} tokens in, ${totals.outputTokens} out, $${totals.costUsd.toFixed(4)} on ${job.model}/${job.effort}`,
  ];
  if (stop === 'error') lines.push(`stopped: ${outcome.error}`);
  if (stop === 'refusal') lines.push('stopped: the model declined to continue');
  if (stop === 'max_tokens') lines.push('stopped: a reply hit the output limit');
  if (stop === 'max_turns') lines.push(`stopped: ${MAX_TURNS} turns without closing the job`);
  if (closed === 'never closed') lines.push(`close it yourself from its report: mem job show ${job.id}`);
  if (outcome.text) lines.push(...outcome.text.split('\n').slice(-6));
  return lines;
}
