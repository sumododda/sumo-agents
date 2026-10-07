import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { anthropicClientOptions, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { modelId, MODELS, usableModels } from './catalog.mjs';
import { tx } from './db.mjs';
import { handleEvent } from './hooks.mjs';
import { brief, getJob, takeInbox } from './jobs.mjs';
import { isJobTool, jobTools, runJobTool } from './jobtools.mjs';
import { takeLock } from './lock.mjs';
import { gateMcp, isMcpTool, mcpReady, runMcpTool, TOOL_SEARCH } from './mcp.mjs';
import { UsageError } from './memory.mjs';
import { costOf, logRun, usageOf } from './model.mjs';
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
/**
 * A sub-agent works by the user's coding rules as the chat does: the Coding section of AGENTS.md, read from its one
 * home, without the lines that point at guides — a job is handed its guide in the brief.
 */
export function codingRules() {
  const agents = readFileSync(join(REPO_ROOT, 'AGENTS.md'), 'utf8');
  const section = /^## Coding\n([\s\S]*?)(?=^## |(?![\s\S]))/m.exec(agents)?.[1] ?? '';
  return section.split('\n').filter((l) => l.trim() && !/guides\//.test(l)).join('\n');
}
export const systemPrompt = () => [promptFile('agent.md'), `## How the user wants code changed\n${codingRules()}`].join('\n\n');

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

/** The request for a job: tools by role, the MCP tools behind them, effort by route, the brief as the one user turn. */
export function jobParams({ job, text, system = systemPrompt(), mcp = [] }) {
  return paramsFor({ model: job.model, effort: job.effort, tools: withMcp([...(job.agent === 'worker' ? [BASH_TOOL, EDITOR_TOOL] : [BASH_TOOL]), ...jobTools(job.agent)], mcp), text, system });
}

/** A conversation's own tools with the MCP ones after them, behind the search tool that finds them; just its own when there are none. */
export const withMcp = (own, mcp) => (mcp.length > 0 ? [...own, TOOL_SEARCH, ...mcp] : own);
/** A system prompt with the line that names the MCP servers, when there are any to name. */
export const withServers = (system, registry) => (registry?.hasTools ? `${system}\n\n${registry.describe()}` : system);

/**
 * The first of two guards on a job taking its own work unverified: the command as written — `--accept` on a finish,
 * or clearing or setting the SUMO_JOB marker the second guard reads (reading code that names it is fine). `sumo job finish` refuses `--accept` under that marker
 * however the command was spelled. Both stop mistakes, not a shell set on getting round them: a job's shell runs
 * with the user's own access.
 */
// Each part is held to one command, and the marker to where a shell would set it, so a search through code that names
// them (`grep -rn "SUMO_JOB=" src`, `rg "job finish" && grep -- --accept`) is reading, not granting.
const SELF_GRANT = new RegExp(
  [
    /\bjob\s+finish\b[^;&|\n]*--accept\b/.source,
    // Clearing the marker, however a shell spells it.
    /\bunset\b[^;&|\n]*\bSUMO_JOB\b/.source,
    /\benv\b[^;&|\n]*(?:\s-u\s*|\s--unset=)["']?SUMO_JOB\b/.source,
    /\b(?:export\s+-n|declare\s+\+x|typeset\s+\+x)\b[^;&|\n]*\bSUMO_JOB\b/.source,
    // Setting it where a command starts: after a separator, a keyword, sudo or eval, inside `sh -c "…"`, behind other assignments.
    /(?:^|[;&|(`{!\n]|\$\(|\b(?:if|then|else|elif|do|while|until|time|eval|sudo(?:\s+(?:-[ugCDhpRrTt]\s*\S+|-\S+))*)\s|\b(?:ba|z|da|k)?sh\b[^;&|\n]*\s-c\s+["'])\s*(?:[A-Za-z_]\w*=(?:"[^"]*"|'[^']*'|\S)*\s+)*["']?SUMO_JOB=/.source,
    /\b(?:export|env|declare|typeset|readonly|local)\b[^;&|\n]*?\s["']?SUMO_JOB=/.source,
  ].join('|'),
);
/** Whether a command, as written, takes its own work unverified or clears the marker that would stop it; a line continued with `\` is one line. */
export const grantsItself = (command) => SELF_GRANT.test(command.replace(/\\\n/g, ' '));
const SELF_GRANT_REFUSED = "Refused: work is never taken unverified on its author's word. Finish FAILED with what blocks verification, or ask.";

/** Said once to a job that ended its turn with the job still open: it finished the work but never said so. */
const UNCLOSED = 'You ended without closing the job. Call `finish` now — DONE or FAILED, with your report — or `ask` if you are blocked.';

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
 * chat's `delegate` work; the calls `concurrent` picks run at the same time. Totals and the stop reason come back; the
 * messages are mutated in place, so a chat can keep going from them. `signal`
 * is the user saying stop: the request is dropped, a running command is
 * killed, and every tool call still gets a result, so the history stays one
 * the API takes. `inbox` hands over what the user said to this conversation
 * while it worked: it is read with the next request, behind the tool results,
 * and a conversation about to end is given one more request to answer it.
 */
export async function converse(db, params, { send = sendToApi, ctx, ledger, beforeTool = null, concurrent = null, onText = null, onTool = null, onResult = null, onTurn = null, inbox = null, signal = null, now = () => new Date().toISOString() }) {
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
      return { turns, stop: 'error', error: String(cause.message).slice(0, 300), status: cause.status ?? null, text, totals };
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
    const answer = async (call) => {
      if (signal?.aborted) return { type: 'tool_result', tool_use_id: call.id, content: 'not run: interrupted by the user', is_error: true };
      onTool?.(call);
      let out;
      try {
        out = (await beforeTool?.(call)) ?? (isMcpTool(call.name) ? await runMcpTool(call, { signal }) : await runTool(call, ctx, { signal }));
      } catch (cause) {
        // A call that is not answered makes the next request invalid; a failure is an answer.
        out = { content: `the tool failed: ${cause.message}`, isError: true };
      }
      onResult?.(call, out);
      return { type: 'tool_result', tool_use_id: call.id, content: out.content, is_error: Boolean(out.isError) };
    };
    // Calls that may overlap (delegated jobs) all start now; the rest run one at a time, in order, beside them.
    const started = new Map(calls.filter((call) => concurrent?.(call)).map((call) => [call.id, answer(call)]));
    const pending = [];
    for (const call of calls) pending.push(started.get(call.id) ?? (await answer(call)));
    const results = await Promise.all(pending);
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
  // A job's commands are marked as its own, so what only the user may grant — taking work unverified — is refused where it is read, however it was spelled.
  const env = jobId === null ? childEnv() : { ...childEnv(), SUMO_JOB: String(jobId) };
  return { cwd: project.path, roots: [project.path, ...(jobId === null ? [] : [join(paths().jobs, String(jobId))])], env };
}

/**
 * Runs a job to the end of its conversation. Returns what happened, never
 * throws for anything the model did; a job that is not open is refused up front.
 * The job closes itself with its `finish` tool; one that stops with the job
 * still open is told so once.
 * `onStart` is told the job once it is known to be runnable; the other
 * callbacks and `inbox` are the conversation's own, for a caller that watches.
 * What `sumo job tell` left on disk is read with the caller's inbox, so a job
 * can be spoken to from any shell wherever it runs. `approve` is how an MCP
 * call not on the allow list reaches the user; without one, such a call is
 * refused with the way to allow it.
 */
export async function runJob(db, id, { send = sendToApi, now, signal = null, onStart = null, onTool = null, onResult = null, onTurn = null, inbox = null, approve = null } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  if (MODELS.includes(job.model) && !usableModels(db).includes(job.model)) {
    throw new UsageError(`j${id} is routed to ${job.model}, which is off — sumo models enable ${job.model}, or abandon it and create it again`);
  }
  const project = getProject(db, job.project);
  // The MCP servers of this process are the job's too: their tools behind the search tool, their names in its prompt.
  const registry = await mcpReady();
  const params = jobParams({ job, text: brief(db, id), system: withServers(systemPrompt(), registry), mcp: registry.tools() });
  const lock = tx(db, () => takeRunLock(id));
  const heard = () => [...(inbox?.() ?? []), ...takeInbox(id)];
  const ctx = contextFor(project, { jobId: id });
  // The workflow gate holds a job's commands as it holds the chat's: once per session for this job, which has a context of its own,
  // and with the job's own project in scope whether or not its card came up in the session.
  const gate = (call) => {
    if (isJobTool(call)) return runJobTool(call, { job, ctx, signal });
    if (isMcpTool(call.name)) return gateMcp(call, { approve, signal, job: id });
    if (call.name !== BASH_TOOL.name) return null;
    if (grantsItself(String(call.input?.command ?? ''))) return { content: SELF_GRANT_REFUSED, isError: true };
    // A job created where no session had begun is still gated, under a session of its own: it holds no turns, only what was shown.
    const held = handleEvent(db, 'pre-tool', { session_id: job.session_id ?? `job:j${id}`, agent_id: `j${id}`, project: job.project, cwd: project.path, tool_name: 'bash', tool_input: { command: String(call.input?.command ?? '') } }, now?.());
    return held ? { content: JSON.parse(held).deny, isError: true } : null;
  };
  try {
    onStart?.(job);
    const run = () => converse(db, params, { send, now, signal, onTool, onResult, onTurn, inbox: heard, beforeTool: gate, ctx, ledger: { kind: job.agent, jobId: id, sessionId: job.session_id } });
    let outcome = await run();
    if (outcome.stop === 'end_turn' && getJob(db, id).status === 'running') {
      params.messages.push({ role: 'user', content: [{ type: 'text', text: UNCLOSED }] });
      const more = await run();
      const totals = Object.fromEntries(Object.keys(more.totals).map((k) => [k, k === 'contextTokens' ? more.totals[k] : outcome.totals[k] + more.totals[k]]));
      outcome = { ...more, turns: outcome.turns + more.turns, text: more.text || outcome.text, totals };
    }
    return { ...outcome, job: getJob(db, id) };
  } finally {
    rmSync(lock, { force: true });
  }
}

/** One run per job: two would drive two agents over the same tree. */
const takeRunLock = (id) => takeLock(join(paths().jobs, String(id), 'run.lock'), (holder) => `j${id} is already being run (process ${holder}) — wait for it, or stop it there`);

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
