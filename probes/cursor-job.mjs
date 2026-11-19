#!/usr/bin/env node
// A live job on a Cursor model, start to finish, run with `sumo job run` as a person runs one — what it does is shown as it
// happens. It works in a throwaway home and a throwaway project, so the real database and ledger are never written, and
// leaves nothing behind. It needs CURSOR_API_KEY, and spends a few cents of the key's Cursor usage.
//   node probes/cursor-job.mjs            → on composer
//   node probes/cursor-job.mjs grok       → on grok, at medium effort
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { leaveNothing } from './throwaway.mjs';

const model = process.argv[2] ?? 'composer';
if (!['composer', 'grok'].includes(model)) throw new Error(`a Cursor model: composer or grok, not ${model}`);
if (!process.env.CURSOR_API_KEY?.trim()) throw new Error('export CURSOR_API_KEY first: the job runs on Cursor');

const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-job-'));
const home = join(root, 'home');
const project = join(root, 'greet');
mkdirSync(project);
writeFileSync(join(project, 'package.json'), `${JSON.stringify({ name: 'greet', type: 'module', scripts: { test: 'node --test' } }, null, 2)}\n`);
// The probe's own shell, without a stand-in: the run is the real one.
const env = { ...process.env, SUMO_AGENTS_HOME: home };
delete env.SUMO_AGENTS_MODEL_CMD;
const sumo = (args, stdio = 'pipe') => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', join(import.meta.dirname, '..', 'bin', 'sumo.mjs'), ...args], { env, encoding: 'utf8', stdio });

try {
  const added = sumo(['project', 'add', project, '--slug', 'greet']);
  if (added.status !== 0) throw new Error(`could not add the project: ${added.stderr}`);
  // `sumo job new` asks the local router, which a throwaway home has not got: the job is made the same way, with the route
  // given — its brief, its rules and its recorded start as any job's — on the model asked for, switched on as Discover would.
  process.env.SUMO_AGENTS_HOME = home;
  const { openDb } = await import('../src/db.mjs');
  const { setModel } = await import('../src/catalog.mjs');
  const { newJob } = await import('../src/jobs.mjs');
  const db = openDb();
  let id;
  try {
    setModel(db, model, true);
    const task = '## Goal\nCreate greet.mjs exporting greet(name), which returns `hello, <name>`, and greet.test.mjs testing it with node:test.\n\n## Check\n`npm test` passes.';
    const made = await newJob(db, { project: 'greet', title: 'greet(name)', task, route: { model, effort: 'medium', reason: 'probes/cursor-job.mjs', risky: false } });
    id = made.id ?? made.job?.id;
    if (!Number.isInteger(id)) throw new Error(`no job id in ${JSON.stringify(made).slice(0, 200)}`);
  } finally {
    db.close();
  }

  console.log(`j${id} on ${model}, in ${project}\n`);
  const started = Date.now();
  sumo(['job', 'run', String(id)], 'inherit');
  console.log(`\n— ${((Date.now() - started) / 1000).toFixed(0)} s —`);
  console.log(sumo(['job', 'show', String(id)]).stdout.split('\n').slice(0, 12).join('\n'));
  console.log(`the project now holds: ${readdirSync(project).filter((f) => !f.startsWith('.')).join(', ')}`);
  for (const file of ['greet.mjs', 'greet.test.mjs']) {
    try {
      console.log(`\n${file}:\n${readFileSync(join(project, file), 'utf8')}`);
    } catch {
      console.log(`\n${file}: not written`);
    }
  }
  console.log(sumo(['cost']).stdout);
} finally {
  leaveNothing(root);
}
