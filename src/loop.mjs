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
 * The loop every conversation runs in: one request, the policy pipeline over
 * each tool call, one ledger row per response, until the model stops calling
 * tools. A job's brief is its first and only user turn; a chat adds a turn
 * each time the user speaks. Nothing here rewrites history: the context is
 * edited server-side, and the prefix — tools, then system — stays byte-stable.
 */

const MAX_TURNS = 150;
const MAX_OUTPUT_TOKENS = 16_000;
const REQUEST_TIMEOUT_MS = 600_000;
const BETAS = ['context-management-2025-06-27'];

/** Old tool results are cleared server-side once the context is this big; never rewritten here, so the history stays append-only. */
const CONTEXT_EDITS = [
  { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 60_000 }, keep: { type: 'tool_uses', value: 5 }, clear_at_least: { type: 'input_tokens', value: 10_000 } },
];

export const promptFile = (name) => readFileSync(join(REPO_ROOT, 'prompts', name), 'utf8').trim();
export const systemPrompt = () => promptFile('agent.md');

/** The request for a conversation's first turn. */
export function paramsFor({ model, effort, tools, text, system }) {
  const params = {
    model: modelId(model),
    max_tokens: MAX_OUTPUT_TOKENS,
    system: [{ type: 'text', text: system, cache_control: { type: 'ephemeral' } }],
    tools,
    messages: text === undefined ? [] : [{ role: 'user', content: [{ type: 'text', text }] }],
    betas: BETAS,
    context_management: { edits: CONTEXT_EDITS },
  };
  if (effort && effort !== 'none') params.output_config = { effort };
  return params;
}

/** The request for a job: tools by role, effort by route, the brief as the one user turn. */
export function jobParams({ job, text, system = systemPrompt() }) {
  return paramsFor({ model: job.model, effort: job.effort, tools: job.agent === 'worker' ? [BASH_TOOL, EDITOR_TOOL] : [BASH_TOOL], text, system });
}

/** One cache breakpoint rides on the last block of the last message, so each turn reads everything before it. */
export function markTail(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) delete block.cache_control;
  }
  const last = messages.at(-1);
  if (Array.isArray(last?.content) && last.content.length > 0) last.content.at(-1).cache_control = { type: 'ephemeral' };
}

export const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** The default transport: streamed, so a long turn never trips the HTTP timeout. */
export async function sendToApi(params, { onText } = {}) {
  const client = new Anthropic({ timeout: REQUEST_TIMEOUT_MS });
  const stream = client.beta.messages.stream(params);
  if (onText) stream.on('text', onText);
  return stream.finalMessage();
}

/**
 * Runs one conversation from its current messages until the model stops
 * calling tools. `send` is the transport (canned in tests); `beforeTool` may
 * refuse a call or answer it itself, which is how the workflow gate and the
 * in-process `mem job run` work. Totals and the stop reason come back; the
 * messages are mutated in place, so a chat can keep going from them.
 */
export async function converse(db, params, { send = sendToApi, ctx, ledger, beforeTool = null, onText = null, onTurn = null, now = () => new Date().toISOString() }) {
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, contextTokens: 0 };
  let turns = 0;
  let stop = 'max_turns';
  let text = '';
  const log = (result, note) => logRun(db, { kind: ledger.kind, model: params.model, result, note, now: now(), jobId: ledger.jobId ?? null, sessionId: ledger.sessionId ?? null });

  while (turns < MAX_TURNS) {
    turns++;
    markTail(params.messages);
    let response;
    try {
      response = await send(params, { onText });
    } catch (cause) {
      log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: ${String(cause.message).slice(0, 200)}`);
      return { turns, stop: 'error', error: String(cause.message).slice(0, 300), text, totals };
    }
    const usage = usageOf(params.model, response.usage);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(params.model, response.usage ?? {});
    totals.contextTokens = usage.inputTokens + usage.outputTokens;
    log({ ok: true, usage }, `turn ${turns} ${response.stop_reason}`);

    params.messages.push({ role: 'assistant', content: response.content });
    text = textOf(response.content) || text;
    stop = response.stop_reason;
    onTurn?.(response, totals);
    if (response.stop_reason !== 'tool_use') break;

    const calls = response.content.filter((b) => b.type === 'tool_use');
    totals.toolCalls += calls.length;
    const results = [];
    for (const call of calls) {
      const out = (await beforeTool?.(call)) ?? runTool(call, ctx);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: Boolean(out.isError) });
    }
    params.messages.push({ role: 'user', content: results });
  }

  return { turns, stop, error: null, text, totals };
}

/** The tool context for work inside one project: its directory, the jail around it, and an environment without the secrets. */
export function contextFor(project, { jobId = null } = {}) {
  return { cwd: project.path, roots: [project.path, ...(jobId === null ? [] : [join(paths().jobs, String(jobId))])], env: childEnv() };
}

/**
 * Runs a job to the end of its conversation. Returns what happened, never
 * throws for anything the model did; a job that is not open is refused up front.
 * The job closes itself through `mem job finish` in bash, as its brief says.
 */
export async function runJob(db, id, { send = sendToApi, now } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  const project = getProject(db, job.project);
  const params = jobParams({ job, text: brief(db, id) });
  const outcome = await converse(db, params, { send, now, ctx: contextFor(project, { jobId: id }), ledger: { kind: job.agent, jobId: id, sessionId: job.session_id } });
  return { ...outcome, job: getJob(db, id) };
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
