import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicClientOptions, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { tx } from './db.mjs';
import { handleEvent } from './hooks.mjs';
import { brief, getJob, takeInbox } from './jobs.mjs';
import { UsageError } from './memory.mjs';
import { costOf, logRun, modelId, usageOf } from './model.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { BASH_TOOL, childEnv, EDITOR_TOOL, INTERRUPTED, runTool } from './tools.mjs';

/**
 * The loop every conversation runs in: one request, the policy pipeline over
 * each tool call, one ledger row per response, until the model stops calling
 * tools. A job's brief is its first and only user turn; a chat adds a turn
 * each time the user speaks. Nothing here rewrites history: the context is
 * edited server-side, and the prefix — tools, then system — stays byte-stable.
 */

const MAX_TURNS = 150;
/** Every model but haiku always thinks, and the thinking counts toward this: it holds a long turn's thinking and its reply. */
const MAX_OUTPUT_TOKENS = 64_000;
const REQUEST_TIMEOUT_MS = 600_000;
const BETAS = ['context-management-2025-06-27'];
/** What a tool call is answered with when the reply that made it ended before the call was whole. */
const CUT_OFF = 'not run: the reply was cut off before this call was complete';

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

/**
 * One cache breakpoint rides on the last block of the last message that can
 * carry one, so each turn reads everything before it. An operator message at
 * the tail is plain text with nowhere to put it; the turn before it is marked.
 */
export function markTail(messages) {
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) delete block.cache_control;
  }
  const last = messages.findLast((m) => Array.isArray(m.content) && m.content.length > 0);
  if (last) last.content.at(-1).cache_control = { type: 'ephemeral' };
}

export const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** The default transport: streamed, so a long turn never trips the HTTP timeout. */
export async function sendToApi(params, { onText, signal } = {}) {
  const credential = resolveAnthropicCredential();
  const client = new Anthropic(anthropicClientOptions(REQUEST_TIMEOUT_MS, credential));
  const stream = client.beta.messages.stream(authenticatedRequest(params, credential), signal ? { signal } : undefined);
  if (onText) stream.on('text', onText);
  return stream.finalMessage();
}

/**
 * Runs one conversation from its current messages until the model stops
 * calling tools. `send` is the transport (canned in tests); `beforeTool` may
 * refuse a call or answer it itself, which is how the workflow gate and the
 * in-process `sumo job run` work. Totals and the stop reason come back; the
 * messages are mutated in place, so a chat can keep going from them. `signal`
 * is the user saying stop: the request is dropped, a running command is
 * killed, and every tool call still gets a result, so the history stays one
 * the API takes. `inbox` hands over what the user said to this conversation
 * while it worked: it is read with the next request, behind the tool results,
 * and a conversation about to end is given one more request to answer it.
 */
export async function converse(db, params, { send = sendToApi, ctx, ledger, beforeTool = null, onText = null, onTool = null, onResult = null, onTurn = null, inbox = null, signal = null, now = () => new Date().toISOString() }) {
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, contextTokens: 0 };
  let turns = 0;
  let stop = 'max_turns';
  let text = '';
  const log = (result, note) => logRun(db, { kind: ledger.kind, model: params.model, result, note, now: now(), jobId: ledger.jobId ?? null, sessionId: ledger.sessionId ?? null });
  const heard = () => (inbox?.() ?? []).map((said) => ({ type: 'text', text: `The user says, while you work: ${said}` }));

  while (turns < MAX_TURNS) {
    turns++;
    markTail(params.messages);
    let response;
    try {
      response = await send(params, { onText, signal });
    } catch (cause) {
      if (signal?.aborted) {
        log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: interrupted`);
        return { turns, stop: 'interrupted', error: null, text, totals };
      }
      log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: ${String(cause.message).slice(0, 200)}`);
      return { turns, stop: 'error', error: String(cause.message).slice(0, 300), text, totals };
    }
    const usage = usageOf(params.model, response.usage);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(params.model, response.usage ?? {});
    totals.contextTokens = usage.inputTokens + usage.outputTokens;
    log({ ok: true, usage }, `turn ${turns} ${response.stop_reason}`);

    // A refused reply is not kept: what streamed before the refusal is not an answer, and its calls were never made.
    const refused = response.stop_reason === 'refusal';
    // A reply with nothing in it is not kept either: the API refuses an empty message once anything follows it.
    if (response.content.length > 0 && !refused) params.messages.push({ role: 'assistant', content: response.content });
    if (!refused) text = textOf(response.content) || text;
    onTurn?.(response, totals);
    if (response.stop_reason === 'end_turn') {
      const said = heard();
      if (said.length > 0) {
        params.messages.push({ role: 'user', content: said });
        continue;
      }
    }
    const calls = refused ? [] : response.content.filter((b) => b.type === 'tool_use');
    if (response.stop_reason !== 'tool_use') {
      // A reply cut off inside a tool call still carries the call; it is not run, and it is answered like any other.
      if (calls.length > 0) params.messages.push({ role: 'user', content: calls.map((call) => ({ type: 'tool_result', tool_use_id: call.id, content: CUT_OFF, is_error: true })) });
      stop = response.stop_reason;
      break;
    }

    totals.toolCalls += calls.length;
    const results = [];
    for (const call of calls) {
      if (signal?.aborted) {
        results.push({ type: 'tool_result', tool_use_id: call.id, content: 'not run: interrupted by the user', is_error: true });
        continue;
      }
      onTool?.(call);
      let out;
      try {
        out = (await beforeTool?.(call)) ?? (await runTool(call, ctx, { signal }));
      } catch (cause) {
        // A call that is not answered makes the next request invalid; a failure is an answer.
        out = { content: `the tool failed: ${cause.message}`, isError: true };
      }
      onResult?.(call, out);
      results.push({ type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: Boolean(out.isError) });
    }
    if (signal?.aborted) {
      params.messages.push({ role: 'user', content: results });
      stop = 'interrupted';
      break;
    }
    params.messages.push({ role: 'user', content: [...results, ...heard()] });
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
 * The job closes itself through `sumo job finish` in bash, as its brief says.
 * `onStart` is told the job once it is known to be runnable; the other
 * callbacks and `inbox` are the conversation's own, for a caller that watches.
 * What `sumo job tell` left on disk is read with the caller's inbox, so a job
 * can be spoken to from any shell wherever it runs.
 */
export async function runJob(db, id, { send = sendToApi, now, signal = null, onStart = null, onTool = null, onResult = null, onTurn = null, inbox = null } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  const project = getProject(db, job.project);
  const params = jobParams({ job, text: brief(db, id) });
  const lock = tx(db, () => takeRunLock(id));
  const heard = () => [...(inbox?.() ?? []), ...takeInbox(id)];
  // The workflow gate holds a job's commands as it holds the chat's: once per session for this job, which has a context of its own,
  // and with the job's own project in scope whether or not its card came up in the session.
  const gate = (call) => {
    if (call.name !== BASH_TOOL.name || !job.session_id) return null;
    const held = handleEvent(db, 'pre-tool', { session_id: job.session_id, agent_id: `j${id}`, project: job.project, cwd: project.path, tool_name: 'bash', tool_input: { command: String(call.input?.command ?? '') } }, now?.());
    return held ? { content: JSON.parse(held).deny, isError: true } : null;
  };
  try {
    onStart?.(job);
    const outcome = await converse(db, params, { send, now, signal, onTool, onResult, onTurn, inbox: heard, beforeTool: gate, ctx: contextFor(project, { jobId: id }), ledger: { kind: job.agent, jobId: id, sessionId: job.session_id } });
    return { ...outcome, job: getJob(db, id) };
  } finally {
    rmSync(lock, { force: true });
  }
}

/**
 * One run per job: two would drive two agents over the same tree. The lock names the process that holds it, so one
 * left behind by a run that died is seen for what it is and taken over.
 */
function takeRunLock(id) {
  const lock = join(paths().jobs, String(id), 'run.lock');
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(lock, String(process.pid), { flag: 'wx', mode: 0o600 });
      return lock;
    } catch (cause) {
      if (cause.code !== 'EEXIST' || attempt > 0) throw cause;
      const holder = Number(readFileSync(lock, 'utf8'));
      if (holder && alive(holder)) throw new UsageError(`j${id} is already being run (process ${holder}) — wait for it, or stop it there`);
      rmSync(lock, { force: true });
    }
  }
}

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
};

/** Why a conversation ended, when it was neither the model finishing nor the user stopping it nor an error; null otherwise. Said to a chat as to a job. */
export function stopReason(stop) {
  if (stop === 'refusal') return 'stopped: the model declined to continue';
  if (stop === 'max_tokens') return 'stopped: a reply hit the output limit';
  if (stop === 'model_context_window_exceeded') return 'stopped: the conversation no longer fits in the model\'s context';
  if (stop === 'max_turns') return `stopped: ${MAX_TURNS} turns without an end`;
  return null;
}

/** What `sumo job run` prints: whether the job closed itself, and what the run cost. */
export function runLines(outcome) {
  const { job, turns, stop, totals } = outcome;
  const closed = job.status === 'done' ? 'DONE' : job.status === 'failed' ? 'FAILED' : job.status === 'needs_input' ? 'NEEDS_INPUT' : 'never closed';
  const lines = [
    `STATUS: ${closed} — j${job.id}`,
    `${turns} turn${turns === 1 ? '' : 's'}, ${totals.toolCalls} tool calls, ${totals.inputTokens} tokens in, ${totals.outputTokens} out, $${totals.costUsd.toFixed(4)} on ${job.model}/${job.effort}`,
  ];
  if (stop === 'error') lines.push(`stopped: ${outcome.error}`);
  if (stop === 'interrupted') lines.push(INTERRUPTED);
  if (stop === 'max_turns') lines.push(`stopped: ${MAX_TURNS} turns without closing the job`);
  else if (stopReason(stop)) lines.push(stopReason(stop));
  if (closed === 'never closed') lines.push(`close it yourself from its report: sumo job show ${job.id}`);
  if (outcome.text) lines.push(...outcome.text.split('\n').slice(-6));
  return lines;
}
