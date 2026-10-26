import Anthropic from '@anthropic-ai/sdk';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { ADVISOR_BETA, ADVISOR_SPENT, ADVISOR_SPENT_AT, ADVISOR_STOP_AT, advisorIn, advisorLine, advisorOf, advisorResult, advisorRuns, advisorTool, isAdvisorCall, isAdvisorResult } from './advisor.mjs';
import { anthropicClient, authenticatedRequest, resolveAnthropicCredential } from './auth.mjs';
import { MODEL_IDS, modelId, MODELS, usableModels } from './catalog.mjs';
import { getMeta, tx } from './db.mjs';
import { handleEvent } from './hooks.mjs';
import { brief, getJob, planOf, readState, runLockFile, settle, takeInbox, toldToClose, treeOf } from './jobs.mjs';
import { isJobTool, jobTools, runJobTool } from './jobtools.mjs';
import { takeLock } from './lock.mjs';
import { DECLINED, gateMcp, isMcpTool, mcpReady, runMcpTool, TOOL_SEARCH } from './mcp.mjs';
import { UsageError } from './memory.mjs';
import { callLocalModel, costOf, logRun, usageOf } from './model.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { ASK_TOOL, BASH_TOOL, childEnv, EDITOR_TOOL, INTERRUPTED, killGroup, runTool } from './tools.mjs';
import { changesSince, diffStat, verdictLines } from './verify.mjs';
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
/** A round of two to four calls gone round with the same input and the same answers is a loop too: said and stopped at the same counts. */
const ROUND_SIZES = [2, 3, 4];
/** The calls kept to find a round in: the longest round, gone round as often as it takes to stop it. */
const TRAIL_LENGTH = ROUND_SIZES.at(-1) * REPEAT_STOP_AT;
/** The editor's commands that change a file, and how many changes to one file in a run are enough before the model is told to step back. */
const CHANGES = ['str_replace', 'insert', 'create'];
const EDITS_NOTE_AFTER = 10;
/** Calls the user declined in one conversation: a model that keeps asking, or asks for the same thing another way, is stopped here. */
const DECLINE_STOP_AT = 3;
/**
 * Said with the results three requests before the limit: a run that hits it still gets to close or sum up — and a worker
 * room for both of its `finish` calls, the first of which is answered with the check against the task.
 */
const CLOSING_TURNS = 3;
const LAST_TURN = 'This run has three requests left: the turn limit is reached after them. If you have a job, close it with `finish` now — DONE or FAILED, with your report; a worker\'s first DONE is answered with a check against the task, and calling `finish` again goes on to verification. Otherwise say where things stand and what remains.';
/** Said the same way, once, to a job that has spent this much of its budget: it still gets to close before the cap stops it. */
const BUDGET_WARN_AT = 0.8;
const BUDGET_LOW = (spent, usd) =>
  `This job has spent $${spent.toFixed(2)} of its $${usd.toFixed(2)} budget, and is stopped when it reaches it. Close it with \`finish\` now: DONE only if the work is verified, otherwise FAILED with where it stands and what remains. A worker's first DONE is answered with a check against the task; call \`finish\` again to go on.`;
/** Said the same way, once, to a job that has run this much of its time: it still gets to close before the limit stops it. */
const TIME_WARN_AT = 0.8;
const TIME_LOW = (ranMs, limitMs) =>
  `This job has run ${Math.floor(ranMs / 60_000)} of its ${Math.round(limitMs / 60_000)} minutes, and is stopped when it reaches them. Close it with \`finish\` now: DONE only if the work is verified, otherwise FAILED with where it stands and what remains. A worker's first DONE is answered with a check against the task; call \`finish\` again to go on.`;
/**
 * A line of a failed command's output that reads as an error, and how many times the same one comes back in a run before the model
 * is told to look for its cause. What changes from one try to the next — an absolute path, a hex id, a number — does not make it another.
 */
const ERROR_LINE = /error|Error|ERR!|FAIL|failed|Traceback|panic:/;
const ERROR_NOTE_AT = 4;
const ABSOLUTE_PATH = /(?<![\w.~-])\/[^\s'"`:,;()[\]{}<>]+/g;
const HEX_ID = /\b0x[0-9a-f]+\b|\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b/gi;
/**
 * Every thirty requests a job's last twelve calls — the tool and its input, cut to 200 characters each — are put to the local model,
 * which says whether they go round in circles; a yes is said to the model with why. It costs nothing, and holds the turn for twenty
 * seconds at most: a check that is slower, fails, or has no local model to ask is skipped without a word.
 */
export const CIRCLES = { every: 30, calls: 12, chars: 200, ms: 20_000 };
const CIRCLES_SYSTEM =
  "You watch a coding agent at work. You are shown its last tool calls, oldest first, one a line: the tool, then its input. Answer with JSON only. stuck: true when the calls go round in circles — the same things tried again and again, or in other words, with nothing new learned and nothing changed — and false when they move forward, however slowly. why: one sentence on what keeps coming back, or on what moves.";
const CIRCLES_SCHEMA = { type: 'object', properties: { stuck: { type: 'boolean' }, why: { type: 'string', maxLength: 200 } }, required: ['stuck', 'why'], additionalProperties: false };

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
/** The lines of what a job changed that ride after its summary: git's stat of the tracked files, then the new ones. */
const CHANGED_LINES = 20;

/**
 * The one compaction request: the same conversation, without the context edits (the API takes one or the other) and
 * without what only shapes a reply, asking for the summary instead of an answer. What comes back is sent first in every
 * later request, in place of everything it summarized.
 */
export function compactionParams(params, instructions = COMPACT_INSTRUCTIONS) {
  const { context_management: _edits, stop_sequences: _stops, ...rest } = params;
  return { ...rest, betas: [...new Set([...(params.betas ?? []), COMPACT_BETA])], compaction: { type: 'summarize', instructions } };
}

/** What a job's `state` says of its work, for the line after its summary; nothing when it has nothing to say or fails to. */
function recordedBy(compact) {
  try {
    return compact.state?.() ?? '';
  } catch {
    return '';
  }
}

/**
 * Old tool results are cleared server-side once the context is this big; never rewritten here, so the history stays append-only.
 * Rarely and in big chunks: each clear breaks the cache after the system prompt, and the whole conversation is written to it
 * again at the write price — a small clear that comes back every few requests costs more than the tokens it saves. The last
 * five tool uses stay: the model is working from them. What the user answered stays always: the chat's `ask` and a job's
 * (jobtools.mjs) go by the same name, and a result of either is never cleared.
 */
const CONTEXT_EDITS = [
  { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 100_000 }, keep: { type: 'tool_uses', value: 5 }, clear_at_least: { type: 'input_tokens', value: 40_000 }, exclude_tools: [ASK_TOOL.name] },
];

/** What the API cleared before it answered, for the ledger row: how many tool uses, and how many tokens they held. */
function clearedBy(response) {
  const edits = (response.context_management?.applied_edits ?? []).filter((edit) => edit.cleared_tool_uses > 0);
  if (edits.length === 0) return '';
  const uses = edits.reduce((n, edit) => n + edit.cleared_tool_uses, 0);
  const tokens = edits.reduce((n, edit) => n + (edit.cleared_input_tokens ?? 0), 0);
  return ` cleared ${uses} tool use${uses === 1 ? '' : 's'} (${Math.round(tokens / 1000)}k)`;
}

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
 * however the command was spelled. The chat's commands carry a marker of their own, SUMO_TOOL, under which `sumo` refuses what only the
 * user does — the allow list, the configuration, memory written as the user's word — and the same patterns hold it. All of this stops
 * mistakes, not a shell set on getting round them: the shell runs with the user's own access.
 */
// Each part is held to one command, and the marker to where a shell would set it, so a search through code that names
// them (`grep -rn "SUMO_JOB=" src`, `rg "job finish" && grep -- --accept`) is reading, not granting.
const MARKER = 'SUMO_(?:JOB|TOOL)';
/** Clearing or setting a marker, however a shell spells it. */
const MARKER_PATTERNS = [
  // Clearing the marker, however a shell spells it.
  `\\bunset\\b[^;&|\\n]*\\b${MARKER}\\b`,
  `\\benv\\b[^;&|\\n]*(?:\\s-u\\s*|\\s--unset=)["']?${MARKER}\\b`,
  `\\b(?:export\\s+-n|declare\\s+\\+x|typeset\\s+\\+x)\\b[^;&|\\n]*\\b${MARKER}\\b`,
  // Setting it where a command starts: after a separator, a keyword, sudo or eval, inside `sh -c "…"`, behind other assignments.
  // An assignment's value is read as a shell reads a word — an escaped character, a quoted string, or a plain character —
  // so a quote means one thing: where it could also be a character of its own, a long run of them was paired every way there is.
  // The same for sudo's flags: one that takes a value takes the next word only when that word is not a flag itself.
  `(?:^|[;&|(\`{!\\n]|\\$\\(|\\b(?:if|then|else|elif|do|while|until|time|eval|sudo(?:\\s+(?:-[ugCDhpRrTt]\\s+(?!-\\S)\\S+|-\\S+))*)\\s|\\b(?:ba|z|da|k)?sh\\b[^;&|\\n]*\\s-c\\s+["'])\\s*(?:[A-Za-z_]\\w*=(?:\\\\.|"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^\\s"'\\\\])*\\s+)*["']?${MARKER}=`,
  `\\b(?:export|env|declare|typeset|readonly|local)\\b[^;&|\\n]*?\\s["']?${MARKER}=`,
];
const TAMPERS = new RegExp(MARKER_PATTERNS.join('|'));
const SELF_GRANT = new RegExp([/\bjob\s+finish\b[^;&|\n]*--accept\b/.source, ...MARKER_PATTERNS].join('|'));
/** Whether a command, as written, takes its own work unverified or clears the marker that would stop it; a line continued with `\` is one line. */
export const grantsItself = (command) => SELF_GRANT.test(command.replace(/\\\n/g, ' '));
/** Whether a command, as written, clears or sets the marker that says it is the model's. */
export const tampersMarker = (command) => TAMPERS.test(command.replace(/\\\n/g, ' '));
export const TAMPER_REFUSED = 'Refused: the marker that says this shell is the model\'s is not yours to clear or set. What it holds back, the user does themselves.';
const SELF_GRANT_REFUSED = "Refused: work is never taken unverified on its author's word. Finish FAILED with what blocks verification, or ask.";

/** How many requests apart a job is shown its own plan again, and how. */
const PLAN_EVERY = 10;
const PLAN_AGAIN = (plan) => `Your plan, as your latest checklist note has it — when a step is done, note the list again with it ticked:\n${plan}`;

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
 * How many times the last calls went round the same two to four calls, in the same order with the same input and the same
 * answers, when a round has just come to an end; null otherwise. A round whose answers change is work going on — a wait and a
 * look, again — and is not one. Nor is one call made again, or a shorter round twice: that is the repeat's to count.
 */
function roundOf(trail) {
  for (const size of ROUND_SIZES) {
    const round = trail.slice(-size);
    if (round.length < size || [1, 2].some((d) => d < size && size % d === 0 && round.every((key, i) => key === round[i % d]))) continue;
    let run = size;
    while (run < trail.length && trail.at(-1 - run) === trail.at(-1 - run + size)) run++;
    if (run >= 2 * size && run % size === 0) return { size, rounds: run / size };
  }
  return null;
}
/**
 * What the conversation holds after a reply: what its last pass read and wrote. A reply the API made in several passes —
 * the model asked the advisor, and went on — counts every pass at the top of its usage, and so the conversation more than once.
 */
function contextOf(model, usage) {
  const last = usageOf(model, usage?.iterations?.findLast((entry) => entry.type === 'message') ?? usage);
  return last.inputTokens + last.outputTokens;
}
const repeated = (count) => `\n[sumo: this is the same call with the same answer, ${count} times in a row — doing it again changes nothing. Do something else, or stop and say what blocks you.]`;
const roundAgain = ({ size, rounds }) => `\n[sumo: these ${size} calls, with the same input and the same answers in the same order, ${rounds} times in a row — going round them again changes nothing. Do something else, or stop and say what blocks you.]`;
const editedOften = (path, count) => `\n[sumo: this is change ${count} to ${path} in this run — step back: view the whole region you are changing, then make it right in one edit.]`;
const errorAgain = (count, line) => `\n[sumo: this error has come back ${count} times in this run: "${line.slice(0, 200)}" — step back and find its cause rather than trying another variation.]`;
const inCircles = (count, why) => `\n[sumo: your last ${count} calls look to be going round in circles: ${why.slice(0, 200)} — step back and find what blocks you, or stop and say so.]`;

/** The first line of a command's output that reads as an error, as it came and with what changes from one try to the next taken out; null when none does. */
function errorOf(output) {
  const line = String(output).split('\n').find((l) => ERROR_LINE.test(l))?.trim();
  if (!line) return null;
  return { line, key: line.replace(ABSOLUTE_PATH, '<path>').replace(HEX_ID, '<id>').replace(/\d+/g, 'N').replace(/\s+/g, ' ') };
}

/** What `promise` comes to, or null when it fails, takes longer than `ms`, or the user says stop first; no timer is left behind either way. */
function within(promise, ms, signal) {
  return new Promise((resolve) => {
    const done = (value) => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', skip);
      resolve(value);
    };
    const skip = () => done(null);
    const timer = setTimeout(skip, ms);
    signal?.addEventListener('abort', skip, { once: true });
    if (signal?.aborted) skip();
    promise.then(done, skip);
  });
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
 * `onOutput` is handed what a shell command prints, as it prints it.
 * `budget` is a job's cap in dollars — `usd`, what an earlier run of the
 * same job `spent`, and whether it was `warned`: told once near it, and
 * nothing more is sent once it is reached. The chat has none. `clock` is a
 * job's limit in time the same way — `ms`, the run's start `from` by the
 * conversation's own `now`, and `warned`. `circling` is a job's look, every
 * `every` requests, at whether its last calls go round in circles: `ask` is
 * handed them and answers why, or null. `remind` is asked, with the request
 * count, at each round of tool results, for a text to say after them — or nothing.
 * `toldLast` comes back true when the conversation was told it had three requests left.
 */
export async function converse(db, params, { send = sendToApi, ctx, ledger, beforeTool = null, concurrent = null, onText = null, onThinking = null, onTool = null, onOutput = null, onResult = null, onTurn = null, onRetry = null, onCompact = null, inbox = null, signal = null, retry = RETRY, compact = null, budget = null, clock = null, circling = null, remind = null, now = () => new Date().toISOString() }) {
  const totals = { inputTokens: 0, outputTokens: 0, costUsd: 0, toolCalls: 0, contextTokens: 0 };
  let turns = 0;
  let stop = 'max_turns';
  let text = '';
  let compactedAt = -Infinity;
  let toldLast = false;
  // The ledger names the model that answered: with a fallback that is not always the one asked for.
  const log = (result, note, model = params.model) => logRun(db, { kind: ledger.kind, model, result, note, now: now(), jobId: ledger.jobId ?? null, sessionId: ledger.sessionId ?? null });
  // What the inbox hands over is the user's words — or, as `{ event }`, something that happened and is nobody's words: said as it is.
  const heard = () => (inbox?.() ?? []).map((said) => ({ type: 'text', text: typeof said === 'string' ? `The user says, while you work: ${said}` : said.event }));
  const interrupted = () => {
    log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns}: interrupted`);
    return { turns, stop: 'interrupted', error: null, text, totals, toldLast };
  };
  /** The last call made and answered, and how many times in a row it has been exactly that. */
  const repeat = { key: null, count: 0 };
  /** The last calls made, by name and input, to find a round in; and how many times the editor changed each file. */
  const trail = [];
  const edited = new Map();
  /** How many times each error has come back from a failed command, and the last calls made, as the local model is shown them. */
  const errors = new Map();
  const recent = [];
  let declined = 0;
  // What a job has spent, over this run and the one before it.
  const costSoFar = () => (budget?.spent ?? 0) + totals.costUsd;
  const overBudget = () => budget !== null && costSoFar() >= budget.usd;
  // How long a job has run, from the start of its run.
  const ranMs = () => Date.parse(now()) - clock.from;
  const overTime = () => clock !== null && ranMs() >= clock.ms;
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
    // A job that has spent its budget sends nothing more: the last round it made is answered, and the run ends there.
    if (overBudget()) {
      stop = 'budget';
      break;
    }
    // So does one that has run its time.
    if (overTime()) {
      stop = 'time';
      break;
    }
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
        return { turns, stop: 'error', error: describeFailure(cause).slice(0, 300), status: cause.status ?? null, text, totals, toldLast };
      }
    }
    const served = response.model ?? params.model;
    const usage = usageOf(served, response.usage);
    totals.inputTokens += usage.inputTokens;
    totals.outputTokens += usage.outputTokens;
    totals.costUsd += costOf(served, response.usage ?? {});
    totals.contextTokens = contextOf(served, response.usage);
    log({ ok: true, usage }, `turn ${turns} ${response.stop_reason}${clearedBy(response)}`, served);
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
    // A call made again and again with the same answer is going nowhere: the model is told so, and then stopped. So is a round of
    // a few calls gone round with the same answers. A file changed again and again is said once, and the run goes on; so is the
    // same error back from failed commands, try after try, whatever else the commands did.
    let looping = false;
    for (const [i, call] of calls.entries()) {
      const key = sameAs(call, results[i]);
      const error = call.name === BASH_TOOL.name && results[i].is_error ? errorOf(results[i].content) : null;
      repeat.count = key === repeat.key ? repeat.count + 1 : 1;
      repeat.key = key;
      if (repeat.count >= REPEAT_STOP_AT) looping = true;
      else if (repeat.count >= REPEAT_NUDGE_AT) results[i] = { ...results[i], content: `${results[i].content}${repeated(repeat.count)}` };
      trail.push(key);
      if (trail.length > TRAIL_LENGTH) trail.shift();
      const round = roundOf(trail);
      if (round && round.rounds >= REPEAT_STOP_AT) looping = true;
      else if (round && round.rounds >= REPEAT_NUDGE_AT) results[i] = { ...results[i], content: `${results[i].content}${roundAgain(round)}` };
      if (call.name === EDITOR_TOOL.name && CHANGES.includes(call.input?.command) && !results[i].is_error) {
        const path = resolve(ctx?.cwd ?? '', String(call.input.path));
        const count = (edited.get(path) ?? 0) + 1;
        edited.set(path, count);
        if (count === EDITS_NOTE_AFTER + 1) results[i] = { ...results[i], content: `${results[i].content}${editedOften(path, count)}` };
      }
      if (error) {
        const count = (errors.get(error.key) ?? 0) + 1;
        errors.set(error.key, count);
        if (count === ERROR_NOTE_AT) results[i] = { ...results[i], content: `${results[i].content}${errorAgain(count, error.line)}` };
      }
      if (circling) {
        recent.push(`${call.name} ${JSON.stringify(call.input ?? {})}`.slice(0, circling.chars));
        if (recent.length > circling.calls) recent.shift();
      }
    }
    // The advisor asked again and again is the same, and its tool cannot be taken away: the model is told so once, and then stopped.
    // So is a model the user has said no to, again and again: each no is final, and three of them end the conversation.
    declined += results.filter((r) => r.content === DECLINED).length;
    if (looping || advisor.asked >= ADVISOR_STOP_AT || declined >= DECLINE_STOP_AT) {
      params.messages.push({ role: 'user', content: results });
      stop = looping ? 'loop' : declined >= DECLINE_STOP_AT ? 'declined' : 'advisor';
      break;
    }
    // Every so many requests a job's last calls are put to the local model — free, and never for longer than its cap; a yes rides on the last answer, with why.
    if (circling && turns % circling.every === 0 && recent.length > 0) {
      const why = await within(Promise.resolve().then(() => circling.ask([...recent])), circling.ms, signal);
      if (typeof why === 'string' && why.trim()) results[results.length - 1] = { ...results.at(-1), content: `${results.at(-1).content}${inCircles(recent.length, why.trim())}` };
    }
    const enough = advisor.asked >= ADVISOR_SPENT_AT && !advisor.told ? [{ type: 'text', text: ADVISOR_SPENT }] : [];
    if (enough.length > 0) advisor.told = true;
    const low = budget !== null && !budget.warned && costSoFar() >= budget.usd * BUDGET_WARN_AT ? [{ type: 'text', text: BUDGET_LOW(costSoFar(), budget.usd) }] : [];
    if (low.length > 0) budget.warned = true;
    const late = clock !== null && !clock.warned && ranMs() >= clock.ms * TIME_WARN_AT ? [{ type: 'text', text: TIME_LOW(ranMs(), clock.ms) }] : [];
    if (late.length > 0) clock.warned = true;
    const last = turns === MAX_TURNS - CLOSING_TURNS ? [{ type: 'text', text: LAST_TURN }] : [];
    if (last.length > 0) toldLast = true;
    params.messages.push({ role: 'user', content: [...results, ...heard(), ...enough, ...low, ...late, ...last] });

    // What the caller keeps in the model's view — a job's plan, from runJob — goes last with these results, when it has something to say.
    const reminder = remind?.(turns);
    if (reminder) params.messages.at(-1).content.push({ type: 'text', text: reminder });

    // Past the band where the work must either stop or shed its past: the conversation so far is summarized server-side, here, at the
    // end of a tool round, and goes on from the summary. A summary that cannot be had costs nothing but its request: the run goes on as it was.
    if (compact && !overBudget() && !overTime() && totals.contextTokens >= compact.at && turns - compactedAt >= COMPACT_GAP) {
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
          // A job's own record of its work rides after the line, from code and not from the summary; whatever cannot be read is left out.
          params.messages = [{ role: 'assistant', content: summary.content }, { role: 'user', content: [{ type: 'text', text: [RESUMED(compact.brief), recordedBy(compact)].filter(Boolean).join('\n\n') }] }];
          onCompact?.({ turns, before: totals.contextTokens, summary: block.content });
        }
      } catch (cause) {
        if (signal?.aborted) return interrupted();
        log({ ok: false, usage: usageOf(params.model, null) }, `turn ${turns} compaction: ${describeFailure(cause).slice(0, 200)}`);
      }
    }
  }

  endHosted();
  return { turns, stop, error: null, text, totals, toldLast };
}

/**
 * The tool context for work inside one project: its directory, the jail around it, an environment without the secrets,
 * where the whole of a command's output goes when the model is shown only its ends — the job's own folder, or the logs —
 * and whether its shell runs in the OS sandbox, and reaches past this machine there. A job given a worktree of its own (`tree`)
 * works there and only there: the project's own files belong to another worker.
 */
export function contextFor(project, { jobId = null, sandbox = true, network = true, tree = null } = {}) {
  // Every command is marked as the model's, and a job's as its own: what only the user may do — change the allow list or the
  // configuration, take work unverified, write memory as if they had said it — is refused where it is read, however it was spelled.
  const env = { ...childEnv(), SUMO_TOOL: '1', ...(jobId === null ? {} : { SUMO_JOB: String(jobId) }) };
  const spill = jobId === null ? join(paths().logs, 'output') : join(paths().jobs, String(jobId), 'output');
  const root = tree ?? project.path;
  return { cwd: root, roots: [root, ...(jobId === null ? [] : [join(paths().jobs, String(jobId))])], env, spill, sandbox, network };
}

/**
 * The user's switches for the model's shell, read once a process and kept. The database stays writable from that shell —
 * the sumo commands the model runs write it — so a model could change them there: a change takes effect at the next
 * start, never in the session that is running — nor in the jobs a chat already open starts, which run in its process.
 */
let shellSwitches = null;
const shellSwitch = (db, key) => {
  shellSwitches ??= Object.fromEntries(['shell.sandbox', 'shell.network'].map((k) => [k, getMeta(db, `config.${k}`) ?? CONFIG_DEFAULTS[k]]));
  return shellSwitches[key];
};

/** Whether the model's shell runs in the OS sandbox: on, unless the user turned it off. */
export const sandboxOn = (db) => shellSwitch(db, 'shell.sandbox') !== 'off';
/** Whether the sandboxed shell reaches past this machine: on, unless the user turned it off. */
export const networkOn = (db) => shellSwitch(db, 'shell.network') !== 'off';

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
 * refused with the way to allow it. It also puts a command the sandbox kept
 * from writing to them, for one run outside it. What the job left running in
 * the background ends with it, before anything is settled. A job that closed has its worktree, if it
 * was given one, settled before the run returns (`settle`, src/jobs.mjs): what
 * became of it is in `settled`, and in the report.
 */
export async function runJob(db, id, { send = sendToApi, now, signal = null, onStart = null, onTool = null, onResult = null, onTurn = null, onThinking = null, onRetry = null, onCompact = null, inbox = null, approve = null } = {}) {
  const job = getJob(db, id);
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — only a running job can be run`);
  if (!job.model) throw new UsageError(`j${id} has no route — it was created before routing existed; create it again`);
  if (MODELS.includes(job.model) && !usableModels(db).includes(job.model)) {
    throw new UsageError(`j${id} is routed to ${job.model}, which is off — sumo models enable ${job.model}, or abandon it and create it again`);
  }
  const project = getProject(db, job.project);
  const tree = treeOf(db, id);
  if (tree && !existsSync(tree.path)) throw new UsageError(`j${id}'s worktree, ${tree.path}, no longer exists — abandon it and create it again`);
  // The MCP servers of this process are the job's too: their tools behind the search tool, their names in its prompt.
  const registry = await mcpReady();
  // Whom this job may ask, by the setting and the switches as they are now: the next model up that is on, or nobody.
  const advisor = (getMeta(db, 'config.jobs.advisor') ?? CONFIG_DEFAULTS['jobs.advisor']) === 'on' ? advisorOf(job.model, usableModels(db)) : null;
  // What this job may spend, by the setting as it is now; shared by both runs, so the second goes on from what the first spent.
  const usd = jobBudget(db);
  const budget = usd === null ? null : { usd, spent: 0, warned: false };
  // How long it may run, the same way: from the start of this run, which both of its conversations share. A job run again — resumed
  // with an answer, say — counts from its own start, as its budget does: nothing of an earlier `sumo job run` is carried over.
  const minutes = jobMinutes(db);
  const clock = minutes === null ? null : { ms: minutes * 60_000, from: Date.parse(now?.() ?? new Date().toISOString()), warned: false };
  const params = jobParams({ job, text: brief(db, id), system: withServers(systemPrompt(), registry), mcp: registry.tools(), advisor });
  const lock = tx(db, () => takeRunLock(id));
  const heard = () => [...(inbox?.() ?? []), ...takeInbox(id)];
  // A command the sandbox blocked is put to the user with the job named, as its MCP calls are; its background commands are its own to end.
  const ctx = { ...contextFor(project, { jobId: id, sandbox: sandboxOn(db), network: networkOn(db), tree: tree?.path }), approve: approve && ((ask) => approve({ ...ask, job: id })), background: new Set() };
  // The workflow gate holds a job's commands as it holds the chat's: once per session for this job, which has a context of its own,
  // and with the job's own project in scope whether or not its card came up in the session.
  const gate = (call) => {
    if (isJobTool(call)) return runJobTool(call, { job, ctx, signal });
    if (isMcpTool(call.name)) return gateMcp(call, { approve, signal, job: id });
    if (call.name !== BASH_TOOL.name) return null;
    if (grantsItself(String(call.input?.command ?? ''))) return { content: SELF_GRANT_REFUSED, isError: true };
    // A job created where no session had begun is still gated, under a session of its own: it holds no turns, only what was shown.
    const held = handleEvent(db, 'pre-tool', { session_id: job.session_id ?? `job:j${id}`, agent_id: `j${id}`, project: job.project, cwd: ctx.cwd, tool_name: 'bash', tool_input: { command: String(call.input?.command ?? '') } }, now?.());
    return held ? { content: JSON.parse(held).deny, isError: true } : null;
  };
  try {
    onStart?.(job);
    // A job that outgrows the context is summarized and goes on; its brief is on disk for whatever the summary left out, and what code
    // recorded of its work is said after the summary.
    const compact = { at: COMPACT_AT, instructions: COMPACT_INSTRUCTIONS, brief: `Your brief, whole, is printed by: sumo job brief ${id}`, state: () => jobWork(db, id, ctx.cwd) };
    const circling = { ...CIRCLES, ask: (calls) => circlingWhy(db, calls) };
    // The job's plan — the latest checklist among its notes — is put back in front of it every so often, as the notes have it then.
    const remind = (turns) => {
      const plan = turns % PLAN_EVERY === 0 ? planOf(id) : null;
      return plan && PLAN_AGAIN(plan);
    };
    const run = () => converse(db, params, { send, now, signal, onTool, onResult, onTurn, onThinking, onRetry, onCompact, compact, budget, clock, circling, remind, inbox: heard, beforeTool: gate, ctx, ledger: { kind: job.agent, jobId: id, sessionId: job.session_id } });
    let outcome = await run();
    if (outcome.stop === 'end_turn' && getJob(db, id).status === 'running') {
      params.messages.push({ role: 'user', content: [{ type: 'text', text: UNCLOSED }] });
      if (budget) budget.spent = outcome.totals.costUsd;
      const more = await run();
      const totals = Object.fromEntries(Object.keys(more.totals).map((k) => [k, k === 'contextTokens' ? more.totals[k] : outcome.totals[k] + more.totals[k]]));
      outcome = { ...more, turns: outcome.turns + more.turns, text: more.text || outcome.text, totals, toldLast: outcome.toldLast || more.toldLast };
    }
    // Kept for what follows the job: one told here to close near a limit is not retried past it (`followUp`, src/jobs.mjs).
    toldToClose(db, id, budget?.warned ? 'budget' : clock?.warned ? 'time' : outcome.toldLast ? 'turns' : null);
    // What it left running in the background goes before its worktree is settled: still running, it would write into a tree being
    // brought back and removed, or be there when the change lands in the project.
    for (const group of ctx.background) killGroup(group);
    const settled = await settle(db, id, now?.());
    return { ...outcome, job: getJob(db, id), settled };
  } finally {
    for (const group of ctx.background) killGroup(group);
    rmSync(lock, { force: true });
  }
}

/** What one job may spend, in dollars, by the setting: none at 0, the default for anything that is not a number. */
export function jobBudget(db) {
  const raw = String(getMeta(db, 'config.jobs.budget') ?? CONFIG_DEFAULTS['jobs.budget']).trim();
  const asked = raw === '' ? NaN : Number(raw);
  const usd = Number.isFinite(asked) && asked >= 0 ? asked : Number(CONFIG_DEFAULTS['jobs.budget']);
  return usd > 0 ? usd : null;
}

/** How long one job may run, in minutes, by the setting: none at 0, the default for anything that is not a whole number. */
export function jobMinutes(db) {
  const raw = String(getMeta(db, 'config.jobs.minutes') ?? CONFIG_DEFAULTS['jobs.minutes']).trim();
  const minutes = /^\d+$/.test(raw) ? Number(raw) : Number(CONFIG_DEFAULTS['jobs.minutes']);
  return minutes > 0 ? minutes : null;
}

/**
 * What code recorded of a job's work, said after its summary so the summary is not the only word on it: the files changed since the
 * job began, in twenty lines at most; the last time the checks ran and what they found; and the notes the job kept. Each part that
 * cannot be read is left out without a word; empty when none can.
 */
function jobWork(db, id, root) {
  const parts = [];
  const record = readState(db, id);
  let changes = null;
  if (record?.snap) {
    try {
      changes = changesSince(root, record.snap);
      // git's stat is its files, a line of "..." past the count, and the totals; the new files fill what is left, the last line saying how many did not fit.
      const stat = diffStat(root, record.snap, CHANGED_LINES - 3).split('\n').filter(Boolean);
      const created = changes.created.map((f) => ` new file: ${f}`);
      const room = CHANGED_LINES - stat.length - 1;
      const listed = stat.length + created.length > CHANGED_LINES ? [...stat, ...created.slice(0, room), ` … and ${created.length - room} more new files`] : [...stat, ...created];
      parts.push(`Changed since the job began:\n${listed.length > 0 ? listed.join('\n') : ' nothing yet'}`);
    } catch {
      changes = null;
    }
  }
  const verdict = record?.verdict;
  if (verdict?.checks) {
    try {
      const moved = changes !== null && verdict.fingerprint !== changes.fingerprint;
      parts.push(`The checks last ran at ${verdict.at} and ${verdict.ok ? 'passed' : 'did not pass'}${moved ? ', on files that have changed since' : ''}:\n${verdictLines(verdict).map((l) => `- ${l}`).join('\n')}`);
    } catch {
      // Left out.
    }
  }
  try {
    const notes = readFileSync(join(paths().jobs, String(id), 'notes.md'), 'utf8').split(/^### /m).filter((n) => n.trim()).map((n) => n.replace(/^[^\n]*\n/, '').trim()).filter(Boolean);
    if (notes.length > 0) parts.push(`Your notes so far:\n${notes.map((n) => `- ${n}`).join('\n')}`);
  } catch {
    // None kept, or none to read.
  }
  return parts.join('\n\n');
}

/** Why the local model finds a job's last calls going round in circles, or null: when it does not, answers outside its shape, or cannot be asked. */
async function circlingWhy(db, calls) {
  // Given up on as the turn gives up on it: a question still open when the cap is reached would hold the process after the job is over.
  const result = await callLocalModel(db, { system: CIRCLES_SYSTEM, prompt: calls.join('\n'), schema: CIRCLES_SCHEMA, kind: 'loop', log: false, timeoutMs: CIRCLES.ms });
  const { stuck, why } = result.ok ? (result.data ?? {}) : {};
  return stuck === true && typeof why === 'string' && why.trim() ? why.replace(/\s+/g, ' ').trim() : null;
}

/** One run per job: two would drive two agents over the same tree. */
const takeRunLock = (id) => takeLock(runLockFile(id), (holder) => `j${id} is already being run (process ${holder}) — wait for it, or stop it there`);

/** Why a conversation ended, when it was neither the model finishing nor the user stopping it nor an error; null otherwise. Said to a chat as to a job. */
export function stopReason(stop) {
  if (stop === 'refusal') return 'stopped: the model declined to continue';
  if (stop === 'max_tokens') return 'stopped: a reply hit the output limit';
  if (stop === 'model_context_window_exceeded') return 'stopped: the conversation no longer fits in the model\'s context';
  if (stop === 'max_turns') return `stopped: ${MAX_TURNS} turns without an end`;
  if (stop === 'loop') return `stopped: the same call, or the same round of calls, was made ${REPEAT_STOP_AT} times in a row`;
  if (stop === 'budget') return 'stopped: the job reached its budget — sumo config jobs.budget sets it, 0 for none';
  if (stop === 'time') return 'stopped: the job reached its time limit — sumo config jobs.minutes sets it, 0 for none';
  if (stop === 'advisor') return `stopped: the advisor was asked ${ADVISOR_STOP_AT} times`;
  if (stop === 'declined') return `stopped: the user declined ${DECLINE_STOP_AT} calls`;
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
