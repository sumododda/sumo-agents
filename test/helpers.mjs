import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY, REPO_ROOT } from '../src/paths.mjs';

/** A throwaway home, so no test ever touches the real ~/.sumo-agents. */
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-test-'));
  const home = join(root, 'home');
  const spawnLog = join(root, 'spawned.log');
  const modelAnswer = join(root, 'model-answer.json');
  const modelSaw = join(root, 'model-saw.json');
  const routerAnswer = join(root, 'router-answer.json');
  const env = {
    ...process.env,
    SUMO_AGENTS_HOME: home,
    SUMO_AGENTS_SPAWN_LOG: spawnLog,
    SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'),
    STUB_ANSWER: modelAnswer,
    STUB_CAPTURE: modelSaw,
    STUB_ROUTER_ANSWER: routerAnswer,
  };

  /** Runs `sumo` exactly as a user would. Never throws: exit code and streams come back for asserting on. */
  const sumo = (args, { input, extraEnv } = {}) => {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], {
      env: { ...env, ...extraEnv },
      input,
      encoding: 'utf8',
    });
    return { code: run.status, out: run.stdout, err: run.stderr };
  };

  /** Direct access, for arranging state no command can create yet and for checking what was really stored. */
  const sql = (fn) => {
    const db = new DatabaseSync(join(home, 'memory.db'));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const addProject = (slug, alias) => {
    sumo(['config']); // first touch creates the database
    sql((db) => {
      db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        slug,
        slug,
        `/tmp/projects/${slug}`,
        new Date().toISOString(),
      );
      if (alias) db.prepare('INSERT INTO project_aliases (alias, slug) VALUES (?, ?)').run(alias, slug);
    });
  };

  /** Raises one session event from outside the process: JSON on stdin. */
  const hook = (event, payload, extraEnv) => sumo(['hook', event], { input: JSON.stringify(payload), extraEnv });

  /** What the cheap model will answer next, in Claude Code's own envelope. */
  const modelWillSay = (ops, { isError = false } = {}) =>
    writeFileSync(
      modelAnswer,
      JSON.stringify({ is_error: isError, result: isError ? 'rate limited' : '', structured_output: isError ? null : { ops }, usage: { input_tokens: 3400, output_tokens: 120 }, total_cost_usd: 0.004 }),
    );

  /** What the local router will answer for every `sumo job new` and `sumo job retry` from here on; null makes it fail. */
  const routerWillSay = (model, effort, reason = 'stand-in route') =>
    model === null ? rmSync(routerAnswer, { force: true }) : writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model, effort, reason }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));

  const modelWasShown = () => JSON.parse(readFileSync(modelSaw, 'utf8'));
  const spawned = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  return { root, home, sumo, sql, addProject, hook, modelWillSay, routerWillSay, modelWasShown, spawned };
}
