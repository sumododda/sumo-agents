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
 * Throws with Herdr's reason when the tab cannot be opened; the job runs the same either way. The watcher is typed
 * into the tab's shell after this returns, once the shell is ready for it; `onFail` hears why when it never started.
 */
export function openWatchTab(herdr, { job, project, env = process.env, onFail = () => {}, sleep }) {
  const workspace = env.HERDR_WORKSPACE_ID ? ['--workspace', env.HERDR_WORKSPACE_ID] : [];
  const made = herdr(['tab', 'create', ...workspace, '--cwd', project.path, '--label', `${agentLabel(job)} · ${job.title}`, '--no-focus']);
  const tab = parse(made, (result) => result.root_pane?.pane_id);
  if (tab.error) throw new Error(tab.error);
  // Marked as the tab's own, so the watcher may close it behind a job that is done; the home goes with the command,
  // or a chat on another home would be watched from the default one.
  const command = `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${shellWord(paths().home)} ${shellWord(paths().launcher)} job watch ${job.id}`;
  startWatcher(herdr, { pane: tab.id, job: job.id, command, sleep })
    .then((started) => started || onFail('its Herdr tab never started the watcher'))
    .catch((cause) => onFail(cause.message));
  return tab.id;
}

const POLL_MS = 250;
/** How long a new shell is given to reach its prompt, and a typed watcher to start, before it is typed again. */
const READY_MS = 15_000;
const STARTED_MS = 3_000;
const TRIES = 3;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** What the pane runs in the foreground, from Herdr; null when Herdr cannot say — an older Herdr, or a pane that is gone. */
function foreground(herdr, pane) {
  const run = herdr(['pane', 'process-info', '--pane', pane]);
  if (run.error || run.status !== 0) return null;
  try {
    return JSON.parse(run.stdout).result?.process_info ?? null;
  } catch {
    return null;
  }
}

const screen = (herdr, pane) => {
  const run = herdr(['pane', 'read', pane, '--source', 'visible']);
  return run.error || run.status !== 0 ? null : String(run.stdout);
};

/**
 * Types the watcher into a new tab's shell and makes sure it runs. A shell still starting up can throw away what is
 * typed before its prompt — the command shows, then nothing — so the watcher is typed only once the shell stands
 * alone in the foreground with its screen settled, and typed again, a few times at most, when it did not start.
 * True once it runs, or once Herdr can no longer say (the pane closed behind a job that ended, or a Herdr too old to ask).
 */
export async function startWatcher(herdr, { pane, job, command, sleep = pause, tries = TRIES }) {
  const watching = new RegExp(`job watch ${job}(?!\\d)`);
  const started = (info) => info.foreground_processes?.some((p) => watching.test(String(p.cmdline))) || screen(herdr, pane)?.includes(`⏺ j${job} `);
  for (let attempt = 0; attempt < tries; attempt++) {
    let last = null;
    for (let waited = 0; waited < READY_MS; waited += POLL_MS) {
      const info = foreground(herdr, pane);
      if (info === null) break;
      const now = screen(herdr, pane);
      const alone = info.foreground_processes?.every((p) => p.pid === info.shell_pid);
      if (alone && now?.trim() && now === last) break;
      last = now;
      await sleep(POLL_MS);
    }
    const run = herdr(['pane', 'run', pane, command]);
    if (run.error || run.status !== 0) throw new Error(`Herdr opened the tab but would not run the watcher in it: ${String(run.stderr || run.stdout || run.error?.message).trim().slice(0, 200)}`);
    for (let waited = 0; waited < STARTED_MS; waited += POLL_MS) {
      await sleep(POLL_MS);
      const info = foreground(herdr, pane);
      if (info === null || started(info)) return true;
    }
  }
  return false;
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
