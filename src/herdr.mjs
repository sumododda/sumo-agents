import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { paths, SELF } from './paths.mjs';

/**
 * Herdr is where a delegated job can be watched. The job itself runs in the chat's process; inside Herdr it also
 * gets a tab of its own, listed on the left and named after it, where `sumo job watch` shows its work as it
 * happens and reports it to Herdr as an agent with its state — so the chat keeps one line per job. The chat opened
 * the tab, so the chat closes it once the job's run is over, however it ended. Everything goes through the `herdr`
 * CLI, which answers in JSON — an error on stderr.
 */

export const runHerdr = (args) => spawnSync('herdr', args, { encoding: 'utf8', timeout: 10_000 });

/** The name a job goes by in Herdr's lists: `j33 scout`. */
const agentLabel = (job) => `j${job.id} ${job.agent}`;

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
 * Its pane and its tab, which the chat closes once the run is over. Throws with Herdr's reason when the tab cannot be
 * opened; the job runs the same either way. The watcher is typed into the tab's shell after this returns, once the
 * shell is ready for it, and `signal` calls that off when the run ends first; `onFail` hears why it never started.
 */
export function openWatchTab(herdr, { job, project, env = process.env, onFail = () => {}, sleep, signal = null }) {
  const workspace = env.HERDR_WORKSPACE_ID ? ['--workspace', env.HERDR_WORKSPACE_ID] : [];
  const made = herdr(['tab', 'create', ...workspace, '--cwd', project.path, '--label', `${agentLabel(job)} · ${job.title}`, '--no-focus']);
  const tab = parse(made);
  if (tab.error) throw new Error(tab.error);
  // Marked as the tab's own, so the watcher may close it behind the run; the home goes with the command,
  // or a chat on another home would be watched from the default one.
  // The launcher setup made, where there is one; else this very sumo, node and entry by their full paths — a clone not set up yet still has a watcher.
  const sumo = existsSync(paths().launcher) ? shellWord(paths().launcher) : SELF.map(shellWord).join(' ');
  const command = `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${shellWord(paths().home)} ${sumo} job watch ${job.id}`;
  startWatcher(herdr, { pane: tab.pane, job, command, sleep, signal })
    .then((started) => started === false && onFail('its Herdr tab never started the watcher'))
    .catch((cause) => onFail(cause.message));
  return tab;
}

/** Closes a tab sumo opened; one already gone is no matter. */
export const closeTab = (herdr, tab) => herdr(['tab', 'close', tab]);

const POLL_MS = 250;
/**
 * How long a new shell is given to reach its prompt; how long a typed watcher is given to start before a shell back
 * at its prompt has it typed again; and how long anything else may hold the tab's foreground before it is given up.
 */
const READY_MS = 15_000;
const STARTED_MS = 3_000;
const GIVE_UP_MS = 30_000;
const TRIES = 3;
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms).unref());

/** Herdr's answer: `{ result }`, `{ gone: true }` for a pane that is closed, or null when Herdr cannot say — an older Herdr, or one not answering. */
function ask(herdr, args) {
  const run = herdr(args);
  if (run.error) return null;
  try {
    const answer = JSON.parse(run.status === 0 ? run.stdout : run.stderr);
    if (answer.error) return answer.error.code === 'pane_not_found' ? { gone: true } : null;
    return { result: answer.result ?? {} };
  } catch {
    return null;
  }
}

/** What the pane runs in the foreground; `{ gone: true }` or null as `ask` says. */
function foreground(herdr, pane) {
  const answer = ask(herdr, ['pane', 'process-info', '--pane', pane]);
  return answer?.gone ? answer : (answer?.result.process_info ?? null);
}

const screen = (herdr, pane) => {
  const run = herdr(['pane', 'read', pane, '--source', 'visible']);
  return run.error || run.status !== 0 ? null : String(run.stdout);
};

/**
 * Types the watcher into a new tab's shell and makes sure it runs. The watcher is typed only once the shell stands
 * alone in the foreground with its screen settled — what Herdr itself asks of a shell before it starts an agent there.
 * It has started once Herdr shows its report on the pane (`reportAgent`), or once it runs in the foreground. It is
 * typed again, a few times at most, only when the shell stands alone at its prompt again — the line was lost, or the
 * watcher quit — never while anything runs there: a line typed into a watcher reaches the job as a message.
 * True once it runs; false when it never did; null when it no longer matters — the run is over (`signal`), the pane
 * is gone, or Herdr cannot say (one too old to ask).
 */
export async function startWatcher(herdr, { pane, job, command, sleep = pause, tries = TRIES, signal = null }) {
  const watching = new RegExp(`job watch ${job.id}(?!\\d)`);
  const reported = () => ask(herdr, ['pane', 'get', pane])?.result?.pane?.agent === agentLabel(job);
  const started = (info) => info.foreground_processes?.some((p) => watching.test(String(p.cmdline))) || reported();
  const alone = (info) => info.foreground_processes?.every((p) => p.pid === info.shell_pid);
  for (let attempt = 0; attempt < tries; attempt++) {
    let last = null;
    for (let waited = 0; waited < READY_MS; waited += POLL_MS) {
      if (signal?.aborted) return null;
      const info = foreground(herdr, pane);
      if (info?.gone) return null;
      if (info === null) break;
      const now = screen(herdr, pane);
      if (alone(info) && now?.trim() && now === last) break;
      last = now;
      await sleep(POLL_MS);
    }
    if (signal?.aborted) return null;
    const run = herdr(['pane', 'run', pane, command]);
    if (run.error || run.status !== 0) {
      if (foreground(herdr, pane)?.gone) return null;
      throw new Error(`Herdr opened the tab but would not run the watcher in it: ${String(run.stderr || run.stdout || run.error?.message).trim().slice(0, 200)}`);
    }
    for (let waited = POLL_MS; ; waited += POLL_MS) {
      await sleep(POLL_MS);
      if (signal?.aborted) return null;
      const info = foreground(herdr, pane);
      if (info === null || info.gone) return null;
      if (started(info)) return true;
      if (waited >= STARTED_MS && alone(info)) break;
      if (waited >= GIVE_UP_MS) return false;
    }
  }
  return false;
}

/** The tab `tab create` made: its root pane, and the tab to close once the run is over. */
function parse(run) {
  if (run.error) return { error: run.error.code === 'ENOENT' ? '`herdr` is not on PATH' : run.error.message };
  try {
    const answer = JSON.parse(run.status === 0 ? run.stdout : run.stderr || run.stdout);
    if (answer.error) return { error: answer.error.message ?? answer.error.code ?? 'Herdr refused' };
    const pane = answer.result?.root_pane?.pane_id;
    const tab = answer.result?.tab?.tab_id ?? answer.result?.root_pane?.tab_id;
    return pane && tab ? { pane, tab } : { error: 'Herdr answered without a pane and tab id' };
  } catch {
    return { error: `Herdr did not answer in JSON: ${String(run.stderr || run.stdout).trim().slice(0, 200)}` };
  }
}

/**
 * The watcher's side: the tab opened to watch a job closes once the run is over, however it ended. The chat closes
 * it too; this is for a chat that could not. Only a tab sumo opened is closed — a tab the user opened is theirs.
 */
export function closeJobTab(herdr, env) {
  if (env.SUMO_JOB_TAB && env.HERDR_TAB_ID) closeTab(herdr, env.HERDR_TAB_ID);
}
