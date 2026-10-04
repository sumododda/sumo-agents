import { spawnSync } from 'node:child_process';
import { UsageError } from './memory.mjs';
import { paths } from './paths.mjs';

/**
 * Herdr is where background jobs live: each gets a tab of its own in the
 * chat's workspace — listed under the space on the left, named after the job —
 * and reports itself to Herdr as an agent, so it is under "agents" too with
 * its state. Everything goes through the `herdr` CLI, which answers in JSON.
 * Herdr is required: a missing or stopped Herdr is a reason a job does not
 * start, said back to the model in full.
 */

export const runHerdr = (args) => spawnSync('herdr', args, { encoding: 'utf8', timeout: 10_000 });

/** One word for the shell a pane runs: left as it is when it is plain, single-quoted when it holds a space or anything else the shell would read. */
const shellWord = (text) => (/^[\w/.:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/** The name a job goes by in Herdr's lists: `j33 scout`. */
export const agentLabel = (job) => `j${job.id} ${job.agent}`;

/** A tab for the job in the chat's workspace with the job running in it; the id of its pane comes back. */
export function openJobTab(herdr, { job, project, env = process.env }) {
  const workspace = env.HERDR_WORKSPACE_ID ? ['--workspace', env.HERDR_WORKSPACE_ID] : [];
  const made = herdr(['tab', 'create', ...workspace, '--cwd', project.path, '--label', `${agentLabel(job)} · ${job.title}`, '--no-focus']);
  const tab = parse(made, (result) => result.root_pane?.pane_id);
  if (tab.error) throw new UsageError(`j${job.id} not started — background jobs run in Herdr tabs, and ${tab.error}. Start Herdr, or run it in the chat without &`);
  // Marked as the tab's own run, so the job knows it may close the tab behind itself; a run the user typed into a tab of theirs is not.
  // The tab's shell is Herdr's, not the chat's: the home goes with the command, or a chat on another home would start the job against the default one.
  const run = herdr(['pane', 'run', tab.id, `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${shellWord(paths().home)} ${shellWord(paths().launcher)} job run ${job.id}`]);
  if (run.status !== 0) throw new UsageError(`j${job.id} not started — Herdr opened its tab but would not run the job in it: ${String(run.stderr || run.stdout).trim().slice(0, 200)}`);
  return tab.id;
}

/**
 * What the job's own process tells Herdr about itself, when it runs in a pane: working while it works, blocked
 * when it stopped on a question, idle when it is over. Best effort — a Herdr that will not listen changes nothing.
 */
export function reportAgent(herdr, env, { job, state, message = '' }) {
  if (!env.HERDR_PANE_ID) return;
  herdr(['pane', 'report-agent', env.HERDR_PANE_ID, '--source', 'sumo', '--agent', agentLabel(job), '--state', state, ...(message ? ['--message', message.slice(0, 200)] : [])]);
}

function parse(run, pick) {
  if (run.error) return { error: run.error.code === 'ENOENT' ? '`herdr` is not on PATH' : run.error.message };
  try {
    const answer = JSON.parse(run.stdout);
    if (answer.error) return { error: answer.error.message ?? answer.error.code ?? 'Herdr refused' };
    const id = pick(answer.result ?? {});
    return id ? { id } : { error: 'Herdr answered without a pane id' };
  } catch {
    return { error: `Herdr did not answer in JSON: ${String(run.stderr || run.stdout).trim().slice(0, 200)}` };
  }
}

/**
 * A job done in a tab opened for it closes the tab: there is nothing left to read, and the chat has its outcome
 * from disk. A failed job or one stopped on a question keeps the tab, with what went wrong or what it asked on
 * it; a tab the user opened themselves is theirs. Closing the tab ends this process — it must be the last thing.
 */
export function closeJobTab(herdr, env, job) {
  if (!env.SUMO_JOB_TAB || !env.HERDR_TAB_ID || job.status !== 'done') return;
  herdr(['tab', 'close', env.HERDR_TAB_ID]);
}
