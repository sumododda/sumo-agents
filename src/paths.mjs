import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The binary `npm run build:bin` makes runs its code from inside itself (Bun's /$bunfs/), with the files sumo reads
 * (AGENTS.md, guides, prompts…) laid out in the folder beside it: that folder stands for the repo, the binary for the entry.
 */
export const COMPILED = import.meta.url.startsWith('file:///$bunfs/');
export const REPO_ROOT = COMPILED ? dirname(process.execPath) : resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = COMPILED ? process.execPath : join(REPO_ROOT, 'bin', 'sumo.mjs');
/** The words that start this sumo again: the binary alone, or this node on the entry. */
export const SELF = COMPILED ? [ENTRY] : [process.execPath, '--disable-warning=ExperimentalWarning', ENTRY];

/**
 * Everything learned lives here, outside the repo and never in git.
 * SUMO_AGENTS_HOME exists so tests (and a second profile) never touch the real one.
 * Made absolute here: the launcher link and a job's Herdr tab use it from another directory.
 */
export function paths() {
  const home = resolve(process.env.SUMO_AGENTS_HOME || join(homedir(), '.sumo-agents'));
  return {
    home,
    db: join(home, 'memory.db'),
    bin: join(home, 'bin'),
    launcher: join(home, 'bin', 'sumo'),
    logs: join(home, 'logs'),
    backups: join(home, 'backups'),
    jobs: join(home, 'jobs'),
    models: join(home, 'models'),
    scratch: join(home, 'scratch'),
  };
}
