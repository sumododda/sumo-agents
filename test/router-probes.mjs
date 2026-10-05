#!/usr/bin/env node
// Measures the local router on labelled tasks: how often it routes above or below what a task needs.
// It asks the real router through chooseRoute — same prompt, same schema, same llama-server call —
// in a throwaway home, so the real database and ledger are never written.
// Run after changing the router's prompt, its history or its model:
//   node --disable-warning=ExperimentalWarning test/router-probes.mjs     (about two minutes)
import { existsSync, mkdirSync, mkdtempSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { getMeta, openDb, setMeta } from '../src/db.mjs';
import { stopLocalServer } from '../src/local-server.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { MODELS } from '../src/catalog.mjs';
import { chooseRoute, EFFORTS } from '../src/route.mjs';
import { CONFIG_DEFAULTS } from '../src/setup.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

/** Every route on one scale, cheapest first: haiku/none, sonnet/low … fable/max. */
const rank = (route) => {
  if (route === 'haiku/none') return 0;
  const [model, effort] = route.split('/');
  return 1 + (MODELS.indexOf(model) - 1) * EFFORTS.length + EFFORTS.indexOf(effort);
};

/** [cheapest acceptable route, dearest acceptable route, role, title, task] — the labels are a person's judgment; edit them. */
const PROBES = [
  ['haiku/none', 'sonnet/low', 'worker', 'Fix a typo in the README', '## Goal\nREADME.md line 12 says "recieve"; change it to "receive".\n\n## Check\n`grep -c recieve README.md` prints 0.'],
  ['haiku/none', 'sonnet/low', 'worker', 'Rename a local variable', '## Goal\nIn src/text.mjs rename the local variable `tmp` to `trimmed` inside `clip()`. No behaviour change.\n\n## Check\n`npm test` passes.'],
  ['haiku/none', 'sonnet/low', 'worker', 'Correct a doc comment', '## Goal\nThe comment above `freePort` in src/model.mjs says "UDP"; it should say "TCP".\n\n## Check\nNone needed.'],
  ['haiku/none', 'sonnet/low', 'worker', 'Raise a constant', '## Goal\nRaise `TASK_CUT` in src/route.mjs from 3500 to 4000 and update the one test that asserts it.\n\n## Check\n`npm test` passes.'],
  ['haiku/none', 'sonnet/medium', 'worker', 'Unit tests for clip()', '## Goal\nAdd tests for the pure function `clip(text, n)` in src/text.mjs: an empty string, one shorter than n, one longer than n.\n\n## Must not change\nsrc/text.mjs.\n\n## Check\n`npm test` passes.'],
  ['sonnet/low', 'sonnet/medium', 'worker', 'sumo job list --json', '## Goal\n`sumo job list --json` prints the same rows as an array of objects. One function in src/cli.mjs and one test.\n\n## Non-goals\nNo change to the text output.\n\n## Check\n`npm test` passes with a new test in test/jobs.test.mjs.'],
  ['sonnet/low', 'sonnet/high', 'worker', 'sumo export --since', '## Goal\n`sumo export --since <date>` exports only memories created on or after the date. Touches src/export.mjs and src/cli.mjs.\n\n## Non-goals\nNo change to the JSON shape.\n\n## Check\n`npm test` passes with tests for a valid date, an invalid date and no flag.'],
  [
    'sonnet/medium',
    'opus/medium',
    'worker',
    'Ledger: four new nullable columns',
    '## Goal\nAdd four nullable columns to the `model_runs` table through a new schema version in src/db.mjs, following the ALTER TABLE pattern already there. `logRun` in src/model.mjs takes them as optional fields and writes them; `modelStats` in src/scribe.mjs prints their totals beside the existing numbers. Existing rows stay readable with NULLs.\n\n## Non-goals\nNo new dependency, no change to routing or jobs.\n\n## Must not change\nThe `{ ok, data, usage, error }` envelope every caller gets back. All existing tests.\n\n## Check\n`npm test` passes, with new tests proving a database at the previous schema version migrates and keeps its rows, and that `logRun` writes the four columns.\n\n## Report\nThe schema version you used and the new column list.',
  ],
  ['opus/medium', 'opus/xhigh', 'worker', 'Job runner: the same job sometimes runs twice', '## Goal\nTwo `sumo job run` processes started together sometimes both pick up the same job. Find the race in how the row is claimed and fix it so exactly one wins.\n\n## Must not change\nThe job states and what `sumo job show` prints.\n\n## Check\nA test that starts 20 runners at once and asserts exactly one claim.'],
  ['opus/high', 'fable/high', 'worker', 'Token refresh for API auth', '## Goal\nDesign and build OAuth token refresh, with the credentials kept in the OS keychain. Handle a token that expires mid-request, two refreshes racing each other, and a revoked token.\n\n## Non-goals\nNo new dependency.\n\n## Check\n`npm test` passes with a test for each failure path.'],
  ['haiku/none', 'sonnet/medium', 'reviewer', 'Review: typo fix in the README', '## Goal\nReview the one-line README typo fix.'],
  ['opus/high', 'opus/max', 'reviewer', 'Review: token refresh for API auth', '## Goal\nReview the OAuth token refresh change: keychain storage, a token expiring mid-request, concurrent refreshes, revocation.'],
];

/** What the project's finished jobs look like before the router is asked: [status, model, effort, important]. */
const HISTORIES = {
  'no finished jobs': [],
  'only the dearest route, all clean': [
    ['done', 'opus', 'xhigh', 0],
    ['done', 'opus', 'xhigh', null],
    ['done', 'opus', 'xhigh', null],
    ['done', 'opus', 'xhigh', null],
    ['done', 'opus', 'xhigh', null],
  ],
  'a cheap route that failed and drew findings': [
    ['failed', 'sonnet', 'medium', null],
    ['done', 'sonnet', 'medium', 3],
    ['done', 'sonnet', 'medium', 2],
    ['done', 'opus', 'xhigh', 0],
  ],
};

// The router model and llama-server live in the real home; everything written goes to a throwaway one.
const real = paths();
if (!existsSync(real.db)) throw new Error(`no database at ${real.db} — run: sumo setup`);
const realDb = new DatabaseSync(real.db, { readOnly: true });
const llama = getMeta(realDb, 'llama.path');
const modelFile = getMeta(realDb, 'config.model.file') ?? CONFIG_DEFAULTS['model.file'];
realDb.close();
if (!llama || !existsSync(join(real.models, modelFile))) throw new Error('the router model is not set up — run: sumo setup');

delete process.env.SUMO_AGENTS_MODEL_CMD; // a stand-in would answer instead of the router being measured
console.log(`router: ${modelFile}`);
const now = new Date().toISOString();
// One home per history, so the project keeps the same name and only the history differs between runs.
for (const [name, jobs] of Object.entries(HISTORIES)) {
  await withHome(freshHome(), {}, async () => {
    mkdirSync(paths().models, { recursive: true });
    symlinkSync(join(real.models, modelFile), join(paths().models, modelFile));
    const db = openDb();
    try {
      setMeta(db, 'llama.path', llama);
      setMeta(db, 'config.model.file', modelFile);
      const { project } = addProject(db, mkdtempSync(join(tmpdir(), 'sumo-agents-probe-')), { slug: 'probe' });
      const insert = db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort, important) VALUES (?, 'x', 'worker', ?, ?, ?, ?, ?, ?)`);
      for (const [status, model, effort, important] of jobs) insert.run(project.slug, status, now, now, model, effort, important);
      console.log(`\nhistory: ${name}`);
      const tally = { ok: 0, over: 0, under: 0 };
      for (const [lo, hi, agent, title, task] of PROBES) {
        const { model, effort } = await chooseRoute(db, { agent, project, title, task });
        const route = `${model}/${effort}`;
        const verdict = rank(route) > rank(hi) ? 'over' : rank(route) < rank(lo) ? 'under' : 'ok';
        tally[verdict]++;
        console.log(`  ${verdict.toUpperCase().padEnd(5)} ${route.padEnd(13)} ${title}   (wants ${lo} to ${hi})`);
      }
      console.log(`  ${PROBES.length} probes: ${tally.ok} ok, ${tally.over} routed too high, ${tally.under} routed too low`);
    } finally {
      stopLocalServer(db); // the throwaway home's server would otherwise outlive the probe
      db.close();
    }
  });
}
