import { spawnSync } from 'node:child_process';

/**
 * A job run by hand with `sumo job run` in a Herdr pane reports itself to Herdr as an agent, so it is under
 * "agents" with its state. Everything goes through the `herdr` CLI. The chat never needs Herdr: it runs the
 * jobs it delegates in its own process.
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
