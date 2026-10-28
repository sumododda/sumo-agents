import { readFileSync, statSync } from 'node:fs';
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
/** This sumo's version, from its package.json; empty where there is none to read. Read here, with nothing else loaded, so a crash while loading still says it. */
export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();

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

/**
 * Why the home cannot be used, said for a person with what to do next — or null when a failure is about something
 * else: a file where its folder should be (the home itself, or a folder above it), or a place sumo may not write.
 * Without a cause only the first is looked for: doctor asks that before anything reads from the home.
 */
export function homeProblem(cause = null, home = paths().home) {
  let at = home;
  for (;;) {
    let found = null;
    try {
      found = statSync(at);
    } catch {
      // Not there yet, or under a file: the folder above says which.
    }
    if (found && !found.isDirectory()) {
      return `${at} is a file, not a folder — ${process.env.SUMO_AGENTS_HOME ? 'SUMO_AGENTS_HOME must name a folder' : 'sumo keeps its home there: move the file aside'}`;
    }
    if (found || dirname(at) === at) break;
    at = dirname(at);
  }
  if (!['EACCES', 'EROFS'].includes(cause?.code) && !/readonly database/.test(cause?.message ?? '')) return null;
  // In the model's shell the words stay SQLite's and Node's: the sandbox reads them to tell a write it blocked, and asks the user.
  if (process.env.SUMO_TOOL || process.env.SUMO_JOB) return null;
  return at === home
    ? `the home ${home} is not writable — check its owner and mode, or sumo doctor --fix`
    : `the home ${home} cannot be made: ${at} is not writable — check its owner and mode`;
}
