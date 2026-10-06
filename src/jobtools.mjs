import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ENTRY, paths } from './paths.mjs';
import { capRedacted, runCommand } from './tools.mjs';

/**
 * What a sub-agent notes, asks, reads memory and closes its job with: tools of
 * its own, not `sumo job` commands it has to remember to type. Each runs the
 * same `sumo` command a person would, in a process of its own — a worker's
 * checks take minutes, and in this process they would stall every other job
 * and the chat beside them.
 */

const text = (description) => ({ type: 'string', description });
const tool = (name, description, properties = {}, required = Object.keys(properties)) => ({ name, description, input_schema: { type: 'object', properties, required } });

const NOTE = tool('note', 'Keep one line of progress — what now works; next: the step — so a resumed run starts from it.', { text: text('the note') });
const ASK = tool('ask', 'Blocked on something only the user can decide: one question, then stop. You are resumed with the answer.', { question: text('the question') });
const SEARCH = tool('search_memory', "Search the user's memory: their rules, and this project's facts and traps. You never write it.", { query: text('a few words') });
const BASELINE = tool('baseline', "Before your first edit: run the project's checks and record what already fails, so none of it is blamed on you. Takes minutes.");
const VERIFY = tool('verify', "Run the project's checks now and see the verdict DONE will be given. Takes minutes.");
const FINISH = tool(
  'finish',
  "Close the job — the last thing you do, or nobody knows it ended. A worker's DONE runs the project's checks first and is refused while something new fails.",
  // No way to take the work unverified: that is for the user or the main agent to grant, never the author.
  { status: { type: 'string', enum: ['DONE', 'FAILED'] }, report: text('the report, in the shape the brief gives') },
);

/** A role's job tools, in a fixed order so its cached prefix never moves. */
export const jobTools = (agent) => [...(agent === 'worker' ? [BASELINE, VERIFY] : []), NOTE, ASK, SEARCH, FINISH];
const NAMES = new Set([BASELINE, VERIFY, NOTE, ASK, SEARCH, FINISH].map((t) => t.name));
export const isJobTool = (call) => NAMES.has(call.name);

/** One word for the shell: left as it is when plain, single-quoted otherwise. */
const word = (w) => (/^[\w/.:=@%+-]+$/.test(w) ? w : `'${String(w).replaceAll("'", `'\\''`)}'`);
const sumo = (args) => [process.execPath, '--disable-warning=ExperimentalWarning', ENTRY, ...args].map(word).join(' ');

/** The command a call stands for, and what it reads on stdin. Null for a call missing what it needs. */
function commandFor(call, job) {
  const input = call.input ?? {};
  const id = String(job.id);
  const given = (v) => typeof v === 'string' && v.trim() !== '';
  switch (call.name) {
    case 'note':
      return given(input.text) ? { args: ['job', 'note', id], stdin: input.text } : null;
    case 'ask':
      return given(input.question) ? { args: ['job', 'ask', id], stdin: input.question } : null;
    case 'search_memory':
      return given(input.query) ? { args: ['search', input.query, '--project', job.project] } : null;
    case 'baseline':
      return { args: ['job', 'baseline', id], checks: true };
    case 'verify':
      return { args: ['job', 'verify', id], checks: true };
    case 'finish':
      if (!['DONE', 'FAILED'].includes(input.status) || !given(input.report)) return null;
      return { args: ['job', 'finish', id, '--status', input.status], stdin: input.report, checks: true };
    default:
      return null;
  }
}

/** Runs one job tool call; what the command printed is the answer, and a refusal is an error the model can read. */
export async function runJobTool(call, { job, ctx, signal = null }) {
  const command = commandFor(call, job);
  if (!command) return { content: `${call.name} is missing what it needs: ${JSON.stringify(jobTools(job.agent).find((t) => t.name === call.name)?.input_schema.required ?? [])}`, isError: true };
  // Text goes in by file: the command's stdin is closed, and nothing the model wrote is ever read by a shell.
  const file = command.stdin === undefined ? null : join(paths().jobs, String(job.id), `.${call.id}.txt`);
  if (file) writeFileSync(file, command.stdin, { mode: 0o600 });
  try {
    const args = file ? [...command.args, '--from-file', file] : command.args;
    // The checks give each command its own limit; anything else is quick.
    const run = await runCommand(sumo(args), { cwd: ctx.cwd, env: ctx.env, signal, timeoutMs: command.checks ? null : 60_000 });
    if (run.error) return { content: run.error, isError: true };
    const output = capRedacted(run.output.trim(), undefined, run.omitted);
    return { content: output || '(done)', isError: run.stopped !== null || run.status !== 0 };
  } finally {
    if (file) rmSync(file, { force: true });
  }
}
