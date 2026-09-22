import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const ENTRY = join(REPO_ROOT, 'bin', 'mem.mjs');

/**
 * Everything learned lives here, outside the repo and never in git.
 * SUMO_AGENTS_HOME exists so tests (and a second profile) never touch the real one.
 */
export function paths() {
  const home = process.env.SUMO_AGENTS_HOME || join(homedir(), '.sumo-agents');
  return {
    home,
    db: join(home, 'memory.db'),
    bin: join(home, 'bin'),
    launcher: join(home, 'bin', 'mem'),
    logs: join(home, 'logs'),
    backups: join(home, 'backups'),
    jobs: join(home, 'jobs'),
    models: join(home, 'models'),
  };
}
