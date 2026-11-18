// Compare the harnesses on one committed fixture and one independent scorer per task.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { resolveAnthropicCredential } from '../src/auth.mjs';
import { modelId, MODELS, setModel } from '../src/catalog.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { EFFORTS } from '../src/route.mjs';
import { runTask, scoreWork, seed } from './coding-eval.mjs';
import { TASKS } from './coding-eval-tasks.mjs';
import { HARD_TASKS } from './coding-eval-hard.mjs';
import { nativeBudgetSend } from './eval-budget.mjs';
import { preflightExternal, runExternal } from './harness-adapters.mjs';

const fixtures = [...TASKS, ...HARD_TASKS];
const harnessNames = ['native', 'claude-code', 'sumo-harness'];

function selection(text, available, label) {
  const names = text.split(',');
  if (new Set(names).size !== names.length || names.some((name) => !available.includes(name))) {
    throw new Error(`invalid ${label} selection ${text}; choose distinct names from ${available.join(', ')}`);
  }
  return names;
}

export function optionsFor(argv) {
  const { values } = parseArgs({ args: argv, options: {
    list: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    harnesses: { type: 'string', default: 'native,claude-code' }, route: { type: 'string' },
    task: { type: 'string', default: TASKS[0].id }, runs: { type: 'string', default: '1' },
    'budget-usd': { type: 'string' }, json: { type: 'string' },
    'sibling-bin': { type: 'string' }, 'claude-bin': { type: 'string' }, 'external-cap': { type: 'boolean' },
  } });
  if (values.list) return { list: true };
  const parts = values.route?.split('/') ?? [];
  if (parts.length !== 2 || !MODELS.includes(parts[0]) || !EFFORTS.includes(parts[1])) throw new Error('supply --route model/effort, for example sonnet/medium');
  const harnesses = selection(values.harnesses, harnessNames, 'harness');
  if (harnesses.length < 2) throw new Error('select at least two harnesses to compare');
  const tasks = selection(values.task, fixtures.map((t) => t.id), 'task').map((id) => fixtures.find((t) => t.id === id));
  const runs = Number(values.runs);
  const budgetUsd = Number(values['budget-usd']);
  if (!Number.isSafeInteger(runs) || runs < 1) throw new Error('--runs must be a positive integer');
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('--budget-usd must be a positive total in USD');
  const perLegUsd = Math.floor(budgetUsd * 1e6 / (harnesses.length * tasks.length * runs)) / 1e6;
  if (!Number.isFinite(perLegUsd) || perLegUsd <= 0) throw new Error('budget too small or too large for the selected runs');
  return { harnesses, tasks, runs, route: { model: parts[0], effort: parts[1] }, budgetUsd, perLegUsd,
    dryRun: values['dry-run'], json: values.json, siblingBin: values['sibling-bin'], claudeBin: values['claude-bin'], externalCap: values['external-cap'] };
}

export function totalsFor(rows) {
  return Array.from(Map.groupBy(rows, (r) => r.harness), ([harness, group]) => {
    const verified = group.filter((r) => r.verified).length;
    const known = group.every((r) => Number.isFinite(r.costUsd));
    const costUsd = known ? group.reduce((sum, r) => sum + r.costUsd, 0) : null;
    return { harness, runs: group.length, verified, falseDone: group.filter((r) => r.falseDone).length,
      seconds: group.reduce((sum, r) => sum + r.seconds, 0), costUsd, usdPerVerified: verified && known ? costUsd / verified : null };
  });
}

async function nativeLeg(db, task, options) {
  const send = nativeBudgetSend({ model: modelId(options.route.model), budgetUsd: options.budgetUsd });
  const row = await runTask(db, task, { dir: options.dir, route: options.route, slug: options.slug, send });
  const usage = send.budget();
  return { status: row.status, passed: row.passed, failed: row.failed, stopped: row.stopped,
    costUsd: usage.unknownCost ? null : usage.spentUsd, requests: usage.requests,
    model: modelId(options.route.model), effort: options.route.effort };
}

async function externalLeg(harness, task, options) {
  const { report, ...result } = await runExternal(harness, { ...options, task });
  const checks = scoreWork(task, options.dir, report ?? '');
  return { ...result, passed: checks.length > 0 && checks.every((c) => c.ok),
    failed: checks.filter((c) => !c.ok).map((c) => [c.name, c.detail].filter(Boolean).join(' — ')) };
}

/** Every leg gets a separate writable copy of exactly the same Git commit. Scoring happens after the harness exits. */
export async function compare(options, { db, root, runNative = nativeLeg, runOther = externalLeg, onRow = () => {} }) {
  const rows = [];
  for (const task of options.tasks) {
    const template = join(root, `seed-${task.id}`);
    mkdirSync(template);
    seed(task, template);
    const commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: template, encoding: 'utf8' }).trim();
    for (let run = 1; run <= options.runs; run++) {
      // Rotate the first harness across repetitions to distribute order effects.
      const offset = (run - 1) % options.harnesses.length;
      const order = [...options.harnesses.slice(offset), ...options.harnesses.slice(0, offset)];
      for (const harness of order) {
        const slug = `${task.id}-${run}-${harness}`;
        const dir = join(root, slug);
        cpSync(template, dir, { recursive: true });
        const args = { ...options, budgetUsd: options.perLegUsd, dir, slug };
        const began = performance.now();
        let result;
        try {
          result = harness === 'native' ? await runNative(db, task, args) : await runOther(harness, task, args);
        } catch (error) {
          result = { status: 'failed', passed: false, failed: [], stopped: error.message, costUsd: null, requests: null, model: null, effort: null };
        }
        const row = { task: task.id, run, commit, harness, ...result, seconds: (performance.now() - began) / 1000,
          verified: result.status === 'done' && result.passed && !result.stopped, falseDone: result.status === 'done' && !result.passed };
        rows.push(row);
        onRow(row, rows);
      }
    }
  }
  return rows;
}

async function main() {
  const options = optionsFor(process.argv.slice(2));
  if (options.list) {
    console.log(harnessNames.join(', '));
    for (const task of fixtures) console.log(`${task.id}  ${task.title}`);
    return;
  }
  const plan = { harnesses: options.harnesses, tasks: options.tasks.map((t) => t.id), runs: options.runs,
    model: modelId(options.route.model), effort: options.route.effort, totalBudgetUsd: options.budgetUsd, perLegBudgetUsd: options.perLegUsd };
  console.log(JSON.stringify(plan));
  if (options.dryRun) return;
  for (const harness of options.harnesses) {
    if (harness === 'native') {
      if (!resolveAnthropicCredential()) throw new Error('native requires an Anthropic credential');
    } else {
      preflightExternal(harness, { ...options, budgetUsd: options.perLegUsd });
    }
  }
  const root = mkdtempSync(join(tmpdir(), 'sumo-paired-eval-'));
  let db;
  try {
    if (options.harnesses.includes('native')) {
      process.env.SUMO_AGENTS_HOME = join(root, 'home');
      db = openDb();
      setModel(db, options.route.model, true);
      setMeta(db, 'config.jobs.advisor', 'off');
    }
    const onRow = (row, rows) => {
      console.log(JSON.stringify(row));
      if (options.json) {
        const temp = options.json + '.' + process.pid + '.tmp';
        writeFileSync(temp, JSON.stringify({ plan, rows, totals: totalsFor(rows) }, null, 2) + '\n', { mode: 0o600 });
        renameSync(temp, options.json);
      }
    };
    const rows = await compare(options, { db, root, onRow });
    console.table(totalsFor(rows));
    if (rows.some((r) => !r.verified)) process.exitCode = 1;
  } finally {
    try { await closeMcp(); } finally { db?.close(); rmSync(root, { recursive: true, force: true }); }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main().catch((error) => {
  console.error(error.message);
  process.exitCode = 2;
});
