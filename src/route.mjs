import { callLocalModel } from './model.mjs';
import { UsageError } from './memory.mjs';

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

const ROUTER_SYSTEM =
  'You assign a coding job to a model and an effort level. Answer with JSON only. Models, cheapest first: haiku (fast, mechanical work; no ' +
  'effort setting), sonnet (routine coding), opus (design, hard bugs, review), fable (only when opus would plausibly fail: novel algorithms, ' +
  'subtle concurrency, deep security review). Effort, cheapest first: low (short scoped edits), medium (routine implementation), high (judgment ' +
  'needed), xhigh (many interacting parts), max (rare; only for the hardest reasoning). Rules: pick the cheapest model that would finish in one ' +
  'pass with no Important review findings, then the lowest effort that fits. Raise effort before raising the model. Security, credentials, ' +
  'money, migrations or concurrency raise both. A precise check and a small surface lower both. Use the project\'s history.';

const ROUTER_SCHEMA = {
  type: 'object',
  properties: {
    model: { type: 'string', enum: MODELS },
    effort: { type: 'string', enum: ['none', ...EFFORTS] },
    reason: { type: 'string', maxLength: 200 },
  },
  required: ['model', 'effort', 'reason'],
  additionalProperties: false,
};

const TASK_CUT = 3500;

/** Per model/effort, over this project's finished jobs: how many, how many reviewed, and how they scored. */
export function routeStats(db, { project } = {}) {
  const where = [`model IS NOT NULL`, `status IN ('done', 'failed')`];
  const params = [];
  if (project) {
    where.push('project = ?');
    params.push(project);
  }
  return db
    .prepare(
      `SELECT model, effort,
              COUNT(*) AS jobs,
              SUM(status = 'done') AS done,
              SUM(status = 'failed') AS failed,
              SUM(important IS NOT NULL) AS reviewed,
              AVG(important) AS avg_important
       FROM jobs WHERE ${where.join(' AND ')} GROUP BY model, effort ORDER BY model, effort`,
    )
    .all(...params)
    .map((r) => ({ model: r.model, effort: r.effort, jobs: r.jobs, done: r.done, failed: r.failed, reviewed: r.reviewed, avgImportant: r.avg_important }));
}

function historyText(db, projectSlug) {
  const rows = routeStats(db, { project: projectSlug });
  if (rows.length === 0) return 'no history yet';
  return rows
    .map(
      (r) =>
        `${r.model}/${r.effort}: ${r.jobs} job${r.jobs === 1 ? '' : 's'}, ${r.reviewed} reviewed${
          r.reviewed > 0 ? `, avg ${r.avgImportant.toFixed(1)} Important findings` : ''
        }`,
    )
    .join('\n');
}

/** `jobs, done, failed, reviewed, avg important` — one line per model/effort seen. */
export function statsLines(db, { project } = {}) {
  const rows = routeStats(db, { project });
  if (rows.length === 0) return ['no finished jobs yet'];
  return rows.map(
    (r) => `${r.model}/${r.effort}: ${r.jobs} jobs, ${r.done} done, ${r.failed} failed, ${r.reviewed} reviewed, avg ${r.reviewed > 0 ? r.avgImportant.toFixed(1) : '-'} important`,
  );
}

function stackOf(db, projectSlug) {
  const row = db.prepare(`SELECT body FROM memories WHERE scope = ? AND scan_key = 'stack' AND state = 'active'`).get(`project:${projectSlug}`);
  return row ? row.body.replace(/^stack:\s*/, '') : null;
}

function routerPrompt(db, { agent, project, task, title }) {
  const stack = stackOf(db, project.slug);
  return [
    `role: ${agent}`,
    `project: ${project.slug}${stack ? ` (${stack})` : ''}`,
    'history:',
    historyText(db, project.slug),
    `title: ${title ?? ''}`,
    '',
    String(task ?? '').slice(0, TASK_CUT),
  ].join('\n');
}

async function askRouter(db, { agent, project, task, title }) {
  const result = await callLocalModel(db, { system: ROUTER_SYSTEM, prompt: routerPrompt(db, { agent, project, task, title }), schema: ROUTER_SCHEMA });
  if (!result.ok) return { ok: false, error: result.error };
  const { model, effort } = result.data ?? {};
  if (!MODELS.includes(model) || !['none', ...EFFORTS].includes(effort)) return { ok: false, error: `the router answered outside its schema: ${JSON.stringify(result.data)}` };
  return { ok: true, model, effort, reason: result.data.reason };
}

/**
 * Chooses a job's model and effort by asking the local router — every job, every retry, no exceptions.
 * Its answer is the route. A router that cannot answer, or answers something no sub-agent can run,
 * refuses the job: there is no default to fall back to. The only change made to an answer is
 * mechanical: a scout exists only on haiku, and haiku takes no effort.
 */
export async function chooseRoute(db, { agent, project, task, title }) {
  const routed = await askRouter(db, { agent, project, task, title });
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error} — no job was created`);
  let { model, effort } = routed;
  let reason = `router: ${routed.reason}`;
  if (agent === 'scout') {
    if (model !== 'haiku' || effort !== 'none') reason += '; scout runs on haiku';
    return { model: 'haiku', effort: 'none', reason };
  }
  if (model === 'haiku') {
    if (effort !== 'none') reason += '; haiku takes no effort';
    return { model, effort: 'none', reason };
  }
  // With no effort, the plain role sub-agent would run on whatever effort the session happens to have.
  if (effort === 'none') throw new UsageError(`the router failed: it gave ${model} no effort — no job was created`);
  return { model, effort, reason };
}
