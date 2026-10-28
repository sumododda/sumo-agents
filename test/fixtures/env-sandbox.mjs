// A throwaway env for tests that call src functions in-process instead of spawning `sumo` —
// paths.mjs and friends read straight from process.env, so there is nowhere else to put this.
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The test runner sets FORCE_COLOR=1 for each file when it reports to a terminal, for its own diffs. sumo honours a
// FORCE_COLOR as the user's, so every line a test reads would be coloured at a terminal and plain in CI: it is taken
// away here, before any test runs. A test about colour sets it itself.
delete process.env.FORCE_COLOR;

/** A fresh SUMO_AGENTS_HOME nothing else has touched. */
export function freshHome() {
  return join(mkdtempSync(join(tmpdir(), 'sumo-agents-env-sandbox-')), 'home');
}

/**
 * Runs `fn` with SUMO_AGENTS_HOME (and any other env vars in `extra`) pointed at a throwaway
 * value, restoring whatever was there before — even if `fn` throws.
 */
export async function withHome(home, extra, fn) {
  const keys = { SUMO_AGENTS_HOME: home, ...extra };
  const previous = Object.fromEntries(Object.keys(keys).map((k) => [k, process.env[k]]));
  Object.assign(process.env, keys);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(previous)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}
