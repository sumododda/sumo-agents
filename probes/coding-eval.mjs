#!/usr/bin/env node
// A live measurement, not a test: it runs real jobs on the real models, so it needs a credential and costs money
// (the eight tasks are small: a few dollars at most, on the routes the router picks).
// It answers the question nothing else here does — does a change to the loop, the prompts, the tools or the router
// make jobs come out right more often, or cheaper? Run it before such a change and after it, and compare.
//   node --disable-warning=ExperimentalWarning probes/coding-eval.mjs                     every task, routed by the router
//   node … probes/coding-eval.mjs --route sonnet/medium       the same model for every task: the harness is what varies
//   node … probes/coding-eval.mjs --task cart-quantity,who-calls --runs 3 --json out.json
//   node … probes/coding-eval.mjs --list
// Each task is a small project written out fresh, handed to a job as a brief, and scored by what the job never saw:
// hidden tests against the tree it left, the files it was told not to touch, and — for a scout — what its report says.
// A job that says DONE and is wrong is counted apart from one that is wrong and says so.
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { resolveAnthropicCredential } from '../src/auth.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { getJob, newJob, reportOf } from '../src/jobs.mjs';
import { stopLocalServer } from '../src/local-server.mjs';
import { runJob } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { EFFORTS } from '../src/route.mjs';
import { MODELS } from '../src/catalog.mjs';
import { CONFIG_DEFAULTS } from '../src/setup.mjs';
import { elapsed } from '../src/text.mjs';
import { TASKS } from './coding-eval-tasks.mjs';

const HIDDEN = 'eval-hidden';
const git = (dir, ...args) => spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', ...args], { cwd: dir, encoding: 'utf8' });

/** A task's project, written out fresh and committed: the tree a job starts from. */
export function seed(task, dir) {
  for (const [path, content] of Object.entries(task.files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), content);
  }
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'seed');
  return dir;
}

/**
 * The environment without the mark Node's test runner leaves on what it runs: a `node --test` started under that mark
 * takes itself for a test file, runs nothing and exits 0 — and a check that ran nothing would pass everything.
 */
const outsideATest = () => {
  const { NODE_TEST_CONTEXT: _mark, ...env } = process.env;
  return env;
};

/** Every file of the project as it stands, by its path from the project's top; git's own files and the eval's are not the project's. */
function filesOf(dir, under = dir) {
  return readdirSync(under, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === HIDDEN) return [];
    const at = join(under, entry.name);
    return entry.isDirectory() ? filesOf(dir, at) : [relative(dir, at)];
  });
}

/**
 * What the job left, judged by what it never saw. One entry per thing checked: `{ name, ok, detail }`.
 * The hidden tests are put beside the project only for as long as they run.
 */
export function scoreWork(task, dir, report = '') {
  const checks = [];
  // A scout's answer is the line the brief asked the report to end on: a set, so its order and its dress do not matter.
  const plain = (item) => item.replace(/[`*]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
  for (const [key, wanted] of Object.entries(task.answers ?? {})) {
    const said = [...report.matchAll(new RegExp(`^[\\s>*\`-]*${key}:[*\`]*\\s*(.*)$`, 'gim'))].at(-1)?.[1];
    const items = said === undefined ? null : [...new Set(said.split(',').map(plain).filter((item) => item && item !== 'none'))].sort();
    checks.push({ name: `the report ends on the right ${key} line`, ok: items !== null && JSON.stringify(items) === JSON.stringify(wanted.map(plain).sort()), detail: items === null ? 'no such line' : `said: ${items.join(', ') || 'none'}` });
  }
  for (const path of task.unchanged ?? []) {
    const now = existsSync(join(dir, path)) ? readFileSync(join(dir, path), 'utf8') : null;
    checks.push({ name: `${path} is as it was`, ok: now === task.files[path], detail: now === null ? 'deleted' : 'edited' });
  }
  if (task.added) {
    const fresh = filesOf(dir).filter((path) => !(path in task.files) && task.added.test(path));
    checks.push({ name: 'what the brief asked to be added is there', ok: fresh.length > 0, detail: `nothing new matches ${task.added}` });
  }
  if (task.hidden) {
    const at = join(dir, HIDDEN);
    try {
      mkdirSync(at, { recursive: true });
      for (const [name, content] of Object.entries(task.hidden)) writeFileSync(join(at, name), content);
      const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', ...Object.keys(task.hidden).map((name) => join(HIDDEN, name))], { cwd: dir, encoding: 'utf8', timeout: 120_000, env: outsideATest() });
      const out = `${run.stdout}\n${run.stderr}`;
      const failed = [...out.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map((m) => m[1]).filter((name) => !name.endsWith('.mjs'));
      // A run in which no test ran proves nothing: it is a failure of the eval, and is scored as one.
      const ran = Number(/^# pass (\d+)$/m.exec(out)?.[1] ?? 0) + Number(/^# fail (\d+)$/m.exec(out)?.[1] ?? 0);
      checks.push({ name: 'the hidden tests pass', ok: run.status === 0 && ran > 0, detail: ran === 0 ? 'no hidden test ran' : [...new Set(failed)].join('; ') || `exit ${run.status ?? run.signal}` });
    } finally {
      rmSync(at, { recursive: true, force: true });
    }
  }
  return checks;
}

/**
 * One task, start to finish, in the home the environment names: its project seeded and registered, a job made for its
 * brief — routed by the router, or pinned to `route` so that only the harness varies — run in this process, and scored.
 * `send` is the transport, for a stand-in model; without it the job talks to the API.
 */
export async function runTask(db, task, { send = undefined, route = null, slug = task.id, now = () => new Date().toISOString() } = {}) {
  const dir = seed(task, mkdtempSync(join(tmpdir(), `sumo-eval-${task.id}-`)));
  addProject(db, dir, { slug, now: now() });
  const { job: made } = await newJob(db, { project: slug, title: task.title, agent: task.agent, task: task.brief, testsMayChange: Boolean(task.testsMayChange), now: now() });
  if (route) db.prepare(`UPDATE jobs SET model = ?, effort = ?, route_reason = 'eval: pinned' WHERE id = ?`).run(route.model, route.effort, made.id);
  const began = Date.now();
  let stopped = null;
  try {
    const outcome = await runJob(db, made.id, { ...(send ? { send } : {}), now });
    if (outcome.stop === 'error') stopped = outcome.error;
  } catch (cause) {
    stopped = cause.message;
  }
  const job = getJob(db, made.id);
  const checks = scoreWork(task, dir, reportOf(made.id) ?? '');
  const passed = checks.every((c) => c.ok);
  const spent = db.prepare('SELECT COUNT(*) AS requests, COALESCE(SUM(cost_usd), 0) AS cost FROM model_runs WHERE job_id = ?').get(made.id);
  return {
    id: task.id,
    agent: task.agent,
    job: made.id,
    route: `${job.model}/${job.effort}`,
    status: job.status,
    passed,
    // Said DONE, and it is not: the failure that costs most, because nobody looks again.
    falseDone: job.status === 'done' && !passed,
    failed: checks.filter((c) => !c.ok).map((c) => `${c.name}${c.detail ? ` — ${c.detail}` : ''}`),
    requests: spent.requests,
    costUsd: spent.cost,
    seconds: Math.round((Date.now() - began) / 1000),
    stopped,
    dir,
  };
}

/** One result as a line, and all of them as the line that sums them up. */
export const resultLine = (r) =>
  `${r.passed ? 'PASS' : r.falseDone ? 'FALSE DONE' : 'FAIL'.padEnd(4)} ${r.id.padEnd(20)} ${r.agent.padEnd(6)} ${r.route.padEnd(13)} ${r.status.padEnd(7)} ${String(r.requests).padStart(3)} requests  ${elapsed(r.seconds * 1000).padStart(7)}  $${r.costUsd.toFixed(2)}${r.passed ? '' : `\n     ${[...r.failed, ...(r.stopped ? [`stopped: ${r.stopped}`] : [])].join('\n     ')}`}`;
export function summary(results) {
  const sum = (key) => results.reduce((a, r) => a + r[key], 0);
  return `${results.length} run${results.length === 1 ? '' : 's'}: ${results.filter((r) => r.passed).length} passed · ${results.filter((r) => r.falseDone).length} said DONE and were not · ${sum('requests')} requests · ${elapsed(sum('seconds') * 1000)} · $${sum('costUsd').toFixed(2)}`;
}

function parseArgs(argv) {
  const value = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const route = value('route');
  const [model, effort] = route ? route.split('/') : [];
  if (route && (!MODELS.includes(model) || (model === 'haiku' ? effort !== 'none' : !EFFORTS.includes(effort)))) throw new Error(`--route is a model and an effort, like sonnet/medium or haiku/none — not "${route}"`);
  const wanted = value('task')?.split(',');
  const unknown = (wanted ?? []).filter((id) => !TASKS.some((t) => t.id === id));
  if (unknown.length > 0) throw new Error(`no such task: ${unknown.join(', ')} — see --list`);
  return { list: argv.includes('--list'), route: route ? { model, effort } : null, runs: Number(value('runs') ?? 1), json: value('json'), tasks: wanted ? TASKS.filter((t) => wanted.includes(t.id)) : TASKS };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.list) return console.log(TASKS.map((t) => `${t.id.padEnd(20)} ${t.agent.padEnd(6)} ${t.title}`).join('\n'));
  if (!resolveAnthropicCredential()) throw new Error('the eval runs real jobs: export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in this shell first');
  // The real home is only read: which router model it has, and where llama-server is. Every job runs in a home made for this run.
  const real = paths();
  const realDb = new DatabaseSync(real.db, { readOnly: true });
  const meta = (key) => realDb.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value;
  const modelFile = meta('config.model.file') ?? CONFIG_DEFAULTS['model.file'];
  const llama = meta('llama.path');
  const switches = meta('models.state');
  realDb.close();
  if (!existsSync(join(real.models, modelFile))) throw new Error(`the router model is not here (${join(real.models, modelFile)}) — sumo setup`);

  process.env.SUMO_AGENTS_HOME = join(mkdtempSync(join(tmpdir(), 'sumo-eval-home-')), 'home');
  delete process.env.SUMO_AGENTS_MODEL_CMD;
  mkdirSync(paths().models, { recursive: true });
  symlinkSync(join(real.models, modelFile), join(paths().models, modelFile));
  const db = openDb();
  const results = [];
  try {
    setMeta(db, 'llama.path', llama);
    setMeta(db, 'config.model.file', modelFile);
    // The models that are off on this machine are off here too: the router must not pick one the credential does not have.
    if (switches) setMeta(db, 'models.state', switches);
    console.log(`coding eval — ${args.tasks.length} task${args.tasks.length === 1 ? '' : 's'} × ${args.runs}, ${args.route ? `pinned to ${args.route.model}/${args.route.effort}` : 'routed by the router'}\n`);
    for (let run = 1; run <= args.runs; run++) {
      for (const task of args.tasks) {
        const result = await runTask(db, task, { route: args.route, slug: args.runs === 1 ? task.id : `${task.id}-${run}` });
        results.push({ ...result, run });
        console.log(resultLine(result));
      }
    }
    console.log(`\n${summary(results)}`);
    if (args.json) writeFileSync(args.json, `${JSON.stringify({ at: new Date().toISOString(), route: args.route, results }, null, 2)}\n`);
  } finally {
    stopLocalServer(db);
    db.close();
    await closeMcp();
  }
  return results.every((r) => r.passed) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code ?? 0),
    (cause) => {
      console.error(`coding eval: ${cause.message}`);
      process.exit(2);
    },
  );
}
