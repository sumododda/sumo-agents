/**
 * The advisor, as the API's own tool: a stronger model the one doing a job may ask from inside a request. It reads the
 * whole conversation and answers the model, not the screen — the call and the advice are blocks of the reply and go back
 * with the conversation exactly as they came: the advice is encrypted, and the API reads it from there on the next turn.
 *
 * For jobs only. A job keeps one model to its end; the tool cannot leave a conversation that has advice in it, nor be
 * given a limit of none, so a chat that changes models could be left with an advisor weaker than the model asking.
 */
import { MODEL_IDS, modelId, MODELS } from './catalog.mjs';

const ADVISOR_TYPE = 'advisor_20260301';
const ADVISOR_NAME = 'advisor';
export const ADVISOR_BETA = 'advisor-tool-2026-03-01';

/** Each asking has the advisor read the whole conversation at its own price: the job is told at the first of these, and the run stopped at the second. */
export const ADVISOR_SPENT_AT = 3;
export const ADVISOR_STOP_AT = 6;
/** Said once, with the answers of the turn that asked that many times: the tool itself cannot be taken away. */
export const ADVISOR_SPENT = `[sumo: the advisor has been asked ${ADVISOR_SPENT_AT} times in this job, and each asking has it read the whole conversation again. Do not ask it again: carry on with what you have. Asked ${ADVISOR_STOP_AT} times, the run is stopped.]`;

/** Whom a job's model may ask: the next model up that is on. None when nothing on is above it — a model asking itself pays twice for one opinion. */
export function advisorOf(model, usable) {
  const at = MODELS.indexOf(model);
  return at === -1 ? null : (MODELS.slice(at + 1).find((name) => usable.includes(name)) ?? null);
}

/** The tool, for a request. Its limit counts within one request and cannot be none: once a request, and the job's own limit is the loop's to keep. */
export const advisorTool = (advisor) => ({ type: ADVISOR_TYPE, name: ADVISOR_NAME, model: modelId(advisor), max_uses: 1 });

/** Said in the system prompt of a job that has one: the model cannot be made to ask, so it is told when asking is worth its price. */
export const advisorLine = (advisor) =>
  `You have an advisor: the \`${ADVISOR_NAME}\` tool asks ${advisor}, a stronger model, which reads this whole conversation and answers with advice. ` +
  'Each asking costs a full read of the conversation, so ask early and where it changes the outcome: before settling a plan that touches several files or that you are unsure of, ' +
  `and when two attempts at the same thing have failed. Not for routine steps, and not more than ${ADVISOR_SPENT_AT} times in a job. ` +
  'Weigh the advice against what you have seen yourself: the work, and what you report, stay yours.';

/** Who the advisor among a request's tools is, by the name the screen uses; null when there is none. */
export function advisorIn(tools) {
  const id = tools?.find((tool) => tool.type === ADVISOR_TYPE)?.model;
  return id === undefined ? null : (MODELS.find((name) => MODEL_IDS[name] === id) ?? id);
}

export const isAdvisorCall = (block) => block.type === 'server_tool_use' && block.name === ADVISOR_NAME;
export const isAdvisorResult = (block) => block.type === 'advisor_tool_result';
/** A call by its name alone, for the screen. */
export const isAdvisorTool = (call) => call.name === ADVISOR_NAME;

/** What asking came to, said as any tool's result is: that advice was given — it is the model's alone to read — or the failure by its code. */
export function advisorResult(block) {
  const got = block.content;
  if (got?.type !== 'advisor_redacted_result' && got?.type !== 'advisor_result') return { content: `advisor failed: ${got?.error_code ?? 'no reason given'}`, isError: true };
  return { content: 'advice given', isError: false };
}

/**
 * What the advisor itself read and wrote in one reply, each asking with the model that answered it. The top of a reply's
 * usage counts the job's own model only; the advisor is among the iterations, and nowhere else.
 */
export const advisorRuns = (usage) => (usage?.iterations ?? []).filter((entry) => entry.type === 'advisor_message');
