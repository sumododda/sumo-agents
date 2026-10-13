import Anthropic from '@anthropic-ai/sdk';
import { readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { ADVISOR_BETA, ADVISOR_SPENT, ADVISOR_SPENT_AT, ADVISOR_STOP_AT, advisorIn, advisorLine, advisorOf, advisorResult, advisorRuns, advisorTool, isAdvisorCall, isAdvisorResult } from './advisor.mjs';
import { anthropicClient, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { MODEL_IDS, modelId, MODELS, usableModels } from './catalog.mjs';
import { getMeta, tx } from './db.mjs';
import { handleEvent } from './hooks.mjs';
import { brief, getJob, takeInbox } from './jobs.mjs';
import { isJobTool, jobTools, runJobTool } from './jobtools.mjs';
import { takeLock } from './lock.mjs';
import { gateMcp, isMcpTool, mcpReady, runMcpTool, TOOL_SEARCH } from './mcp.mjs';
import { UsageError } from './memory.mjs';
import { costOf, logRun, usageOf } from './model.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { BASH_TOOL, childEnv, EDITOR_TOOL, INTERRUPTED, runTool } from './tools.mjs';
import { isWebCall, isWebResult, WEB_TOOLS, webResult } from './web.mjs';

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
/**
 * A request sent again after the API or the connection gave way, not the request: how many times, and the wait between
 * tries, doubling from the base to the cap. The SDK itself tries twice more only before the first byte; a stream that
 * breaks half-way, or an overload it has given up on, lands here, and a nine-minute job must not die of one 529.
 */
export const RETRY = { limit: 6, baseMs: 1000, capMs: 30_000 };
/** The same call with the same input and the same answer, over and over: said to the model at the third, and the run stopped at the fifth. */
const REPEAT_NUDGE_AT = 3;
const REPEAT_STOP_AT = 5;
/** Said with the results of the turn before the last: a run that hits the limit still gets to close or sum up. */
const LAST_TURN = 'This is the last request of this run: the turn limit is reached after it. If you have a job, close it with `finish` now — DONE or FAILED, with your report; otherwise say where things stand and what remains.';

/** The beta under which one request summarizes the conversation server-side, in place of answering it. */
const COMPACT_BETA = 'compact-2026-09-04';
/** Where a job sheds its past rather than stop: the "act" band of the context gauge, where quality is already falling. */
export const COMPACT_AT = 150_000;
/** Not again until this many responses after the last summary: a conversation at once too big again is not fixed by another. */
const COMPACT_GAP = 3;
/** What the summary is to keep, told to the summarizer in place of the server's own prompt. */
export const COMPACT_INSTRUCTIONS =
  'Write a hand-off for a model that will carry on this work with nothing else in front of it. Keep, exactly: the task as it was given and what must not change; ' +
  'every decision made and why; what was tried and set aside; what is done, what is in hand, what is blocked; the next step; the files, commands, names, numbers ' +
  'and error text that would be hard to find again; what the user said, close to their words; which checks were run and what they showed. Condense the reasoning to what it concluded.';
const RESUMED = (brief) => `The conversation before this point was summarized above to make room. Carry on from where the summary leaves it: what it says is done is done.${brief ? ` ${brief}` : ''}`;

/**
 * The one compaction request: the same conversation, without the context edits (the API takes one or the other) and
 * without what only shapes a reply, asking for the summary instead of an answer. What comes back is sent first in every
 * later request, in place of everything it summarized.
 */
export function compactionParams(params, instructions = COMPACT_INSTRUCTIONS) {
  const { context_management: _edits, stop_sequences: _stops, ...rest } = params;
  return { ...rest, betas: [...new Set([...(params.betas ?? []), COMPACT_BETA])], compaction: { type: 'summarize', instructions } };
}

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

/**
 * How a model thinks: every model but haiku always does, and is asked to say in summary what it thought, so a turn that
 * runs for minutes is not silent on the screen — the thinking itself, and its price, are the same either way. Haiku takes
 * no thinking setting at all.
 */
export const thinkingFor = (model) => (modelId(model) === MODEL_IDS.haiku ? undefined : { type: 'adaptive', display: 'summarized' });

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
  const thinking = thinkingFor(model);
  if (thinking) params.thinking = thinking;
  return params;
}

/**
 * The request for a job: tools by role — the web for the one that looks — the MCP tools behind them, effort by route, the brief as the one user turn.
 * With an `advisor` it may ask that model: the tool, the beta it is under, and the line that says when asking is worth it.
 */
export function jobParams({ job, text, system = systemPrompt(), mcp = [], advisor = null }) {
  const own = [...(job.agent === 'worker' ? [BASH_TOOL, EDITOR_TOOL] : [BASH_TOOL]), ...jobTools(job.agent), ...(job.agent === 'scout' ? WEB_TOOLS : []), ...(advisor ? [advisorTool(advisor)] : [])];
  const params = paramsFor({ model: job.model, effort: job.effort, tools: withMcp(own, mcp), text, system: advisor ? `${system}\n\n${advisorLine(advisor)}` : system });
  return advisor ? { ...params, betas: [...params.betas, ADVISOR_BETA] } : params;
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
    // An assignment's value is read as a shell reads a word — an escaped character, a quoted string, or a plain character —
    // so a quote means one thing: where it could also be a character of its own, a long run of them was paired every way there is.
    // The same for sudo's flags: one that takes a value takes the next word only when that word is not a flag itself.
    /(?:^|[;&|(`{!\n]|\$\(|\b(?:if|then|else|elif|do|while|until|time|eval|sudo(?:\s+(?:-[ugCDhpRrTt]\s+(?!-\S)\S+|-\S+))*)\s|\b(?:ba|z|da|k)?sh\b[^;&|\n]*\s-c\s+["'])\s*(?:[A-Za-z_]\w*=(?:\\.|"(?:[^"\\]|\\.)*"|'[^']*'|[^\s"'\\])*\s+)*["']?SUMO_JOB=/.source,
    /\b(?:export|env|declare|typeset|readonly|local)\b[^;&|\n]*?\s["']?SUMO_JOB=/.source,
  ].join('|'),
);
/** Whether a command, as written, takes its own work unverified or clears the marker that would stop it; a line continued with `\` is one line. */
export const grantsItself = (command) => SELF_GRANT.test(command.replace(/\\\n/g, ' '));
const SELF_GRANT_REFUSED = "Refused: work is never taken unverified on its author's word. Finish FAILED with what blocks verification, or ask.";

/** Said once to a job that ended its turn with the job still open: it finished the work but never said so. */
const UNCLOSED = 'You ended without closing the job. Call `finish` now — DONE or FAILED, with your report — or `ask` if you are blocked.';

/**
 * A cache breakpoint rides on the last block of the last message that can carry one, so each turn reads everything
 * before it; the one the turn before left stays too, so what was written then is read for certain — the lookup behind a
 * breakpoint walks back some twenty blocks, and a turn of many calls can put the last one further off than that. Older
 * marks go: the API takes four, and the system prompt has one. An operator message at the tail is plain text with
 * nowhere to put a mark; the turn before it is marked.
 */
export function markTail(messages) {
  const marked = [];
  for (const m of messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content) if (block.cache_control) marked.push(block);
  }
  const tail = messages.findLast((m) => Array.isArray(m.content) && m.content.length > 0)?.content.at(-1) ?? null;
  // A tail marked already (the turn is being sent again) keeps the mark before it too; a new tail keeps only the last one.
  const kept = marked.at(-1) === tail ? marked.slice(-2) : marked.slice(-1);
  for (const block of marked) if (!kept.includes(block)) delete block.cache_control;
  if (tail && !tail.cache_control) tail.cache_control = { type: 'ephemeral' };
}

export const textOf = (content) => content.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();

/** The default transport: streamed, so a long turn never trips the HTTP timeout; the text and the thinking said as they come, and each block of the reply as it ends. */
export async function sendToApi(params, { onText, onThinking, onBlock, signal } = {}) {
  const credential = resolveAnthropicCredential();
  const client = anthropicClient({ timeout: REQUEST_TIMEOUT_MS }, credential);
  const stream = client.beta.messages.stream(authenticatedRequest(params, credential), signal ? { signal } : undefined);
  if (onText) stream.on('text', onText);
  if (onThinking) stream.on('thinking', (delta, snapshot) => onThinking(delta, snapshot));
  if (onBlock) stream.on('contentBlock', onBlock);
  return stream.finalMessage();
}

/**
 * Whether a failed request may simply be sent again: the API or the connection gave way, not the request. An error the
 * API sent down an open stream has no status, only a type; a 4xx is the request's own fault, except being told to wait.
 */
export function retryable(cause) {
  if (!(cause instanceof Anthropic.APIError) || cause instanceof Anthropic.APIUserAbortError) return false;
  if (cause instanceof Anthropic.APIConnectionError) return true;
  if (cause.status === undefined) return ['overloaded_error', 'api_error', 'rate_limit_error'].includes(cause.type ?? cause.error?.error?.type);
  return cause.status === 408 || cause.status === 409 || cause.status === 429 || cause.status >= 500;
}

/** How long to wait before the next try: what the API asked for, when it said; else doubling from the base, a quarter of jitter, under the cap. */
export function retryDelay(cause, attempt, { baseMs, capMs } = RETRY, random = Math.random) {
  const header = (name) => cause?.headers?.get?.(name) ?? null;
  const asked = header('retry-after-ms') !== null ? Number(header('retry-after-ms')) : header('retry-after') !== null ? Number(header('retry-after')) * 1000 : NaN;
  if (Number.isFinite(asked) && asked > 0 && asked <= capMs * 2) return Math.round(asked);
  return Math.round(Math.min(capMs, baseMs * 2 ** (attempt - 1)) * (0.75 + random() * 0.5));
}

/** What went wrong with a request, in one short line: the status and the API's own words, not the JSON they came in. */
export function describeFailure(cause) {
  if (cause instanceof Anthropic.APIError && (cause.error?.error?.message || cause.type)) {
    const type = cause.type ?? cause.error?.error?.type ?? null;
    return [cause.status, type, cause.error?.error?.message].filter(Boolean).join(' ');
  }
  return String(cause?.message ?? cause);
}

/** Waits `ms`, or until the signal says stop; true when it was the signal. */
const pause = (ms, signal) =>
  new Promise((resolve) => {
    if (signal?.aborted) return resolve(true);
    const stop = () => {
      clearTimeout(timer);
      resolve(true);
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', stop);
      resolve(false);
    }, ms);
    signal?.addEventListener('abort', stop, { once: true });
  });

/** One tool call and its answer as one string, so a call made again with the same answer is seen to be the same. */
const sameAs = (call, result) => `${call.name}\n${JSON.stringify(call.input ?? {})}\n${result.content}`;
/**
 * What the conversation holds after a reply: what its last pass read and wrote. A reply the API made in several passes —
 * the model asked the advisor, and went on — counts every pass at the top of its usage, and so the conversation more than once.
 */
function contextOf(model, usage) {
  const last = usageOf(model, usage?.iterations?.findLast((entry) => entry.type === 'message') ?? usage);
  return last.inputTokens + last.outputTokens;
}
const repeated = (count) => `\n[sumo: this is the same call with the same answer, ${count} times in a row — doing it again changes nothing. Do something else, or stop and say what blocks you.]`;

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
 * `onOutput` is handed what a shell command prints, as it prints it.
 */
export async function converse(db, params, { send = sendToApi, ctx, ledger, beforeTool = null, concurrent = null, onText = null, onThinking = null, onTool = null, onOutput = null, onResult = null, onTurn = null, onRetry = null, onCompact = null, inbox = null, signal = null, retry = RETRY, compact = null, now = () => new Date().toISOString() }) {
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, contextTokens: 0 };
  let turns = 0;
  let stop = 'max_turns';
  let text = '';
  let compactedAt = -Infinity;
  // The ledger names the model that answered: with a fallback that is not always the one asked for.
  const log = (result, note, model = params.model) => logRun(db, { kind: ledger.kind, model, result, note, now: now(), jobId: ledger.jobId ?? null, sessionId: ledger.sessionId ?? null });
  // What the inbox hands over is the user's words — or, as `{ event }`, something that happened and is nobody's words: said as it is.
  const heard = () => (inbox?.() ?? []).map((said) => ({ type: 'text', text: typeof said === 'string' ? `The user says, while you work: ${said}` : said.event }));
  const interrupted = () => {
    log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: interrupted`);
    return { turns, stop: 'interrupted', error: null, text, totals };
  };
  /** The last call made and answered, and how many times in a row it has been exactly that. */
  const repeat = { key: null, count: 0 };
  // A search, a fetch or a question to the advisor runs on the API's side, inside the request: its call and what came back are blocks of
  // the reply. Each is said as any call and its answer are — as it streams, or from the whole reply when nothing streamed — and once: a
  // paused turn's answer comes with the next reply. One the request ended on is answered here, so nothing is left running on the screen.
  const hosted = { said: new Set(), open: new Map() };
  // Whom this conversation may ask, how many times it has, and whether it was told that is enough.
  const advisor = { name: advisorIn(params.tools), asked: 0, told: false };
  const onBlock = (block) => {
    if ((isWebCall(block) || isAdvisorCall(block)) && !hosted.said.has(block.id)) {
      hosted.said.add(block.id);
      if (isAdvisorCall(block)) advisor.asked++;
      // The advisor's call names nobody: the screen is given who was asked, on a copy — the block itself goes back as it came.
      const call = isAdvisorCall(block) ? { ...block, input: { asked: advisor.name } } : block;
      hosted.open.set(block.id, call);
      totals.toolCalls++;
      onTool?.(call);
    } else if ((isWebResult(block) || isAdvisorResult(block)) && hosted.open.has(block.tool_use_id)) {
      const call = hosted.open.get(block.tool_use_id);
      hosted.open.delete(block.tool_use_id);
      onResult?.(call, isWebResult(block) ? webResult(block) : advisorResult(block));
    }
  };
  const endHosted = () => {
    for (const call of hosted.open.values()) onResult?.(call, { content: 'not finished: the request ended first', isError: true });
    hosted.open.clear();
  };

  while (turns < MAX_TURNS) {
    turns++;
    markTail(params.messages);
    let response;
    // The same request, sent again while the API or the connection is the trouble; nothing of a failed try is kept.
    for (let attempt = 0; ; ) {
      try {
        response = await send(params, { onText, onThinking, onBlock, signal });
        break;
      } catch (cause) {
        endHosted();
        if (signal?.aborted) return interrupted();
        const why = describeFailure(cause).slice(0, 200);
        if (attempt < retry.limit && retryable(cause)) {
          attempt++;
          const delayMs = retryDelay(cause, attempt, retry);
          log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: try ${attempt} of ${retry.limit} again in ${delayMs} ms — ${why}`);
          onRetry?.({ attempt, limit: retry.limit, delayMs, reason: why });
          if (await pause(delayMs, signal)) return interrupted();
          continue;
        }
        log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: ${why}`);
        return { turns, stop: 'error', error: describeFailure(cause).slice(0, 300), status: cause.status ?? null, text, totals };
      }
    }
    const served = response.model ?? params.model;
    const usage = usageOf(served, response.usage);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(served, response.usage ?? {});
    totals.contextTokens = contextOf(served, response.usage);
    log({ ok: true, usage }, `turn ${turns} ${response.stop_reason}`, served);
    // What the advisor read and wrote is not in the reply's own count: it is paid at the advisor's price, and has a row under its name.
    for (const run of advisorRuns(response.usage)) {
      const spent = usageOf(run.model, run);
      totals.inputTokens += spent.inputTokens;
      totals.outputTokens += spent.outputTokens;
      totals.costUsd += spent.costUsd;
      log({ ok: true, usage: spent }, `turn ${turns} advisor`, run.model);
    }

    // A refused reply is not kept: what streamed before the refusal is not an answer, and its calls were never made.
    const refused = response.stop_reason === 'refusal';
    // A reply with nothing in it is not kept either: the API refuses an empty message once anything follows it.
    if (response.content.length > 0 && !refused) params.messages.push({ role: 'assistant', content: response.content });
    if (!refused) text = textOf(response.content) || text;
    for (const block of response.content) onBlock(block);
    onTurn?.(response, totals);
    // The API paused a long turn of its own accord: the reply so far is kept, and the turn simply goes on.
    if (response.stop_reason === 'pause_turn') continue;
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
        out = (await beforeTool?.(call)) ?? (isMcpTool(call.name) ? await runMcpTool(call, { signal }) : await runTool(call, ctx, { signal, onOutput: onOutput && ((chunk) => onOutput(call, chunk)) }));
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
    // A call made again and again with the same answer is going nowhere: the model is told so, and then stopped.
    let looping = false;
    for (const [i, call] of calls.entries()) {
      const key = sameAs(call, results[i]);
      repeat.count = key === repeat.key ? repeat.count + 1 : 1;
      repeat.key = key;
      if (repeat.count >= REPEAT_STOP_AT) looping = true;
      else if (repeat.count >= REPEAT_NUDGE_AT) results[i] = { ...results[i], content: `${results[i].content}${repeated(repeat.count)}` };
    }
    // The advisor asked again and again is the same, and its tool cannot be taken away: the model is told so once, and then stopped.
    if (looping || advisor.asked >= ADVISOR_STOP_AT) {
      params.messages.push({ role: 'user', content: results });
      stop = looping ? 'loop' : 'advisor';
      break;
    }
    const enough = advisor.asked >= ADVISOR_SPENT_AT && !advisor.told ? [{ type: 'text', text: ADVISOR_SPENT }] : [];
    if (enough.length > 0) advisor.told = true;
    params.messages.push({ role: 'user', content: [...results, ...heard(), ...enough, ...(turns === MAX_TURNS - 1 ? [{ type: 'text', text: LAST_TURN }] : [])] });

    // Past the band where the work must either stop or shed its past: the conversation so far is summarized server-side, here, at the
    // end of a tool round, and goes on from the summary. A summary that cannot be had costs nothing but its request: the run goes on as it was.
    if (compact && totals.contextTokens >= compact.at && turns - compactedAt >= COMPACT_GAP) {
      compactedAt = turns;
      try {
        const summary = await send(compactionParams(params, compact.instructions), { signal });
        const block = summary.content.find((b) => b.type === 'compaction' && b.content);
        const by = summary.model ?? params.model;
        const spent = usageOf(by, summary.usage);
        totals.inputTokens += spent.inputTokens;
        totals.outputTokens += spent.outputTokens;
        totals.costUsd += costOf(by, summary.usage ?? {});
        log({ ok: Boolean(block), usage: spent }, `turn ${turns} compaction${block ? '' : ': no summary came back'}`, by);
        if (block) {
          params.messages = [{ role: 'assistant', content: summary.content }, { role: 'user', content: [{ type: 'text', text: RESUMED(compact.brief) }] }];
          onCompact?.({ turns, before: totals.contextTokens, summary: block.content });
        }
      } catch (cause) {
        if (signal?.aborted) return interrupted();
        log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns} compaction: ${describeFailure(cause).slice(0, 200)}`);
      }
    }
  }

  endHosted();
  return { turns, stop, error: null, text, totals };
}

/**
 * The tool context for work inside one project: its directory, the jail around it, an environment without the secrets,
 * and where the whole of a command's output goes when the model is shown only its ends — the job's own folder, or the logs.
 */
export function contextFor(project, { jobId = null } = {}) {
  // A job's commands are marked as its own, so what only the user may grant — taking work unverified — is refused where it is read, however it was spelled.
  const env = jobId === null ? childEnv() : { ...childEnv(), SUMO_JOB: String(jobId) };
  const spill = jobId === null ? join(paths().logs, 'output') : join(paths().jobs, String(jobId), 'output');
  return { cwd: project.path, roots: [project.path, ...(jobId === null ? [] : [join(paths().jobs, String(jobId))])], env, spill };
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
export async function runJob(db, id, { send = sendToApi, now, signal = null, onStart = null, onTool = null, onResult = null, onTurn = null, onThinking = null, onRetry = null, onCompact = null, inbox = null, approve = null } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  if (MODELS.includes(job.model) && !usableModels(db).includes(job.model)) {
    throw new UsageError(`j${id} is routed to ${job.model}, which is off — sumo models enable ${job.model}, or abandon it and create it again`);
  }
  const project = getProject(db, job.project);
  // The MCP servers of this process are the job's too: their tools behind the search tool, their names in its prompt.
  const registry = await mcpReady();
  // Whom this job may ask, by the setting and the switches as they are now: the next model up that is on, or nobody.
  const advisor = (getMeta(db, 'config.jobs.advisor') ?? CONFIG_DEFAULTS['jobs.advisor']) === 'on' ? advisorOf(job.model, usableModels(db)) : null;
  const params = jobParams({ job, text: brief(db, id), system: withServers(systemPrompt(), registry), mcp: registry.tools(), advisor });
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
    // A job that outgrows the context is summarized and goes on; its brief is on disk for whatever the summary left out.
    const compact = { at: COMPACT_AT, instructions: COMPACT_INSTRUCTIONS, brief: `Your brief, whole, is printed by: sumo job brief ${id}` };
    const run = () => converse(db, params, { send, now, signal, onTool, onResult, onTurn, onThinking, onRetry, onCompact, compact, inbox: heard, beforeTool: gate, ctx, ledger: { kind: job.agent, jobId: id, sessionId: job.session_id } });
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
  if (stop === 'loop') return `stopped: the same call was made ${REPEAT_STOP_AT} times with the same answer`;
  if (stop === 'advisor') return `stopped: the advisor was asked ${ADVISOR_STOP_AT} times`;
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
