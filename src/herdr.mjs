import { spawnSync } from 'node:child_process';
import { paths } from './paths.mjs';

/**
 * Herdr is where a delegated job can be watched. The job itself runs in the chat's process; inside Herdr it also
 * gets a tab of its own, listed on the left and named after it, where `sumo job watch` shows its work as it
 * happens and reports it to Herdr as an agent with its state — so the chat keeps one line per job. Everything
 * goes through the `herdr` CLI, which answers in JSON.
 */

export const runHerdr = (args) => spawnSync('herdr', args, { encoding: 'utf8', timeout: 10_000 });

/** The name a job goes by in Herdr's lists: `j33 scout`. */
export const agentLabel = (job) => `j${job.id} ${job.agent}`;

/**
 * What the job's own process tells Herdr about itself, when it runs in a pane: working while it works, blocked
 * when it stopped on a question, idle when it is over. Best effort — a Herdr that will not listen changes nothing.
 */
export function reportAgent(herdr, env, { job, state, message = '' }) {
  if (!env.HERDR_PANE_ID) return;
  herdr(['pane', 'report-agent', env.HERDR_PANE_ID, '--source', 'sumo', '--agent', agentLabel(job), '--state', state, ...(message ? ['--message', message.slice(0, 200)] : [])]);
}

/** One word for the shell a pane runs: left as it is when it is plain, single-quoted when it holds a space or anything else the shell would read. */
const shellWord = (text) => (/^[\w/.:=@%+-]+$/.test(text) ? text : `'${text.replaceAll("'", `'\\''`)}'`);

/**
 * A tab in the chat's workspace that shows a job's work: `sumo job watch`, not the job — that stays in the chat.
 * Throws with Herdr's reason when the tab cannot be opened; the job runs the same either way.
 */
export function openWatchTab(herdr, { job, project, env = process.env }) {
  const workspace = env.HERDR_WORKSPACE_ID ? ['--workspace', env.HERDR_WORKSPACE_ID] : [];
  const made = herdr(['tab', 'create', ...workspace, '--cwd', project.path, '--label', `${agentLabel(job)} · ${job.title}`, '--no-focus']);
  const tab = parse(made, (result) => result.root_pane?.pane_id);
  if (tab.error) throw new Error(tab.error);
  // Marked as the tab's own, so the watcher may close it behind a job that is done; the home goes with the command,
  // or a chat on another home would be watched from the default one.
  const run = herdr(['pane', 'run', tab.id, `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${shellWord(paths().home)} ${shellWord(paths().launcher)} job watch ${job.id}`]);
  if (run.status !== 0) throw new Error(`Herdr opened the tab but would not run the watcher in it: ${String(run.stderr || run.stdout).trim().slice(0, 200)}`);
  return tab.id;
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

/** A job that is done closes the tab opened to watch it; one that failed or stopped on a question keeps it, and a tab the user opened is theirs. */
export function closeJobTab(herdr, env, job) {
  if (!env.SUMO_JOB_TAB || !env.HERDR_TAB_ID || job.status !== 'done') return;
  herdr(['tab', 'close', env.HERDR_TAB_ID]);
}
