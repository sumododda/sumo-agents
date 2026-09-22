import { callLocalModel } from './model.mjs';
import { UsageError } from './memory.mjs';

export const MODELS = ['haiku', 'sonnet', 'opus', 'fable'];
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Total order for the floors below: a model dimension, then an effort dimension within it. */
const MODEL_RANK = ['haiku', 'sonnet', 'opus', 'fable'];
const EFFORT_RANK = ['none', 'low', 'medium', 'high', 'xhigh', 'max'];
/** The ladder `stepUp` climbs: haiku is a step of its own, so it is handled first. */
const MODEL_LADDER = ['sonnet', 'opus', 'fable'];
const EFFORT_LADDER = ['low', 'medium', 'high', 'xhigh', 'max'];

const ROLE_DEFAULT = {
  scout: { model: 'haiku', effort: 'none' },
  worker: { model: 'sonnet', effort: 'medium' },
  reviewer: { model: 'opus', effort: 'high' },
};

/** Security, credentials, money, migrations or concurrency: never trusted to a cheap pass. */
const SECURITY_RE = /credential|password|secret|api[ -]?key|bearer|access token|auth(entication|orization|\b)|payment|billing|migration|concurren|\brace\b/i;

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

/**
 * One rung up the ladder: effort climbs to high before the model does, a model
 * step keeps whatever effort it arrived with, and fable/high is the last rung
 * before the top. Returns null once nothing is left to raise.
 */
export function stepUp({ model, effort }) {
  if (model === 'haiku') return { model: 'sonnet', effort: 'medium' };
  if (model === 'fable') {
    if (effort === 'high') return { model, effort: 'xhigh' };
    return null; // already at xhigh or max — there is nowhere left to go
  }
  if (effort === 'low' || effort === 'medium') {
    return { model, effort: EFFORT_LADDER[EFFORT_LADDER.indexOf(effort) + 1] };
  }
  // effort is high, xhigh or max and the model is not yet fable: the model steps up, effort unchanged.
  return { model: MODEL_LADDER[MODEL_LADDER.indexOf(model) + 1], effort };
}

/**
 * Each axis on its own: the model is raised to the floor's model if it is
 * below it, and the effort to the floor's effort if it is below it. A higher
 * model never excuses a lower effort, and the other way round.
 */
function raiseToFloor(route, floor) {
  const higher = (rank, a, b) => (rank.indexOf(a) < rank.indexOf(b) ? b : a);
  return { model: higher(MODEL_RANK, route.model, floor.model), effort: higher(EFFORT_RANK, route.effort, floor.effort) };
}

/**
 * The floors, applied after every precedence step: scout is pinned to
 * haiku/none outright; a reviewer never judges below opus/high; haiku never
 * carries an effort; and security-shaped work never runs below opus/xhigh for
 * a worker or a reviewer. Each one applied is named in the reason.
 */
function applyFloors({ model, effort, reason }, { agent, title, task }) {
  const applied = [];
  if (agent === 'scout') {
    if (model !== 'haiku' || effort !== 'none') applied.push('scout');
    model = 'haiku';
    effort = 'none';
  } else {
    if (agent === 'reviewer') {
      const raised = raiseToFloor({ model, effort }, { model: 'opus', effort: 'high' });
      if (raised.model !== model || raised.effort !== effort) {
        applied.push('reviewer');
        ({ model, effort } = raised);
      }
    }
    if (SECURITY_RE.test(`${title ?? ''}\n${task ?? ''}`)) {
      const raised = raiseToFloor({ model, effort }, { model: 'opus', effort: 'xhigh' });
      if (raised.model !== model || raised.effort !== effort) {
        applied.push('security');
        ({ model, effort } = raised);
      }
    }
    if (model === 'haiku' && effort !== 'none') {
      applied.push('haiku effort');
      effort = 'none';
    }
  }
  return { model, effort, reason: applied.length > 0 ? `${reason}; floor: ${applied.join(', ')}` : reason };
}

/** A memory of type decision whose text pins a role to a model, and optionally an effort. Latest wins. */
export function projectRule(db, projectSlug, agent) {
  const re = /^(scout|worker|reviewer) model (haiku|sonnet|opus|fable)(?: effort (low|medium|high|xhigh|max))?$/i;
  const rows = db
    .prepare(`SELECT * FROM memories WHERE scope = ? AND type = 'decision' AND state = 'active' ORDER BY id DESC`)
    .all(`project:${projectSlug}`);
  for (const m of rows) {
    const match = re.exec(m.body.trim());
    if (match && match[1].toLowerCase() === agent) {
      return {
        model: match[2].toLowerCase(),
        effort: match[3]?.toLowerCase() ?? ROLE_DEFAULT[agent].effort,
        reason: `project rule m${m.id}: ${m.body}`,
      };
    }
  }
  return null;
}

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

function roleDefault(agent) {
  const d = ROLE_DEFAULT[agent];
  return { model: d.model, effort: d.effort, reason: `default: ${agent} ${d.model}/${d.effort}` };
}

/** The previous job's route, one rung up the ladder — or a refusal when there is nowhere left to go. */
function decideRetry(db, retryOf) {
  const prev = db.prepare('SELECT model, effort FROM jobs WHERE id = ?').get(retryOf);
  if (!prev?.model || !prev?.effort) throw new UsageError(`j${retryOf} has no recorded route to step up from`);
  const next = stepUp({ model: prev.model, effort: prev.effort });
  if (!next) throw new UsageError(`j${retryOf} already ran on ${prev.model}/${prev.effort} — ask the user`);
  return { ...next, reason: `retry: stepped up from j${retryOf} ${prev.model}/${prev.effort}` };
}

/** Precedence b–e: retryOf, then a project rule, then the router, then the role's default. */
async function decide(db, { agent, project, task, title, retryOf }) {
  if (retryOf !== undefined) return decideRetry(db, retryOf);
  const rule = projectRule(db, project.slug, agent);
  if (rule) return rule;
  const routed = await askRouter(db, { agent, project, task, title });
  if (routed.ok) return { model: routed.model, effort: routed.effort, reason: `router: ${routed.reason}` };
  const fallback = roleDefault(agent);
  return { ...fallback, reason: `router failed: ${routed.error}; ${fallback.reason}` };
}

function validateExplicit({ model, effort }) {
  if (model !== undefined && !MODELS.includes(model)) throw new UsageError(`--model is one of: ${MODELS.join(', ')}`);
  if (effort !== undefined && !EFFORTS.includes(effort)) throw new UsageError(`--effort is one of: ${EFFORTS.join(', ')}`);
}

/**
 * Chooses a job's model and effort. First match wins: an explicit flag (each
 * half filled from the steps below when only one is given), a retry's step
 * up, a project rule, the router, then the role's default — and always the
 * floors on top. Async because the router is a real (if local) model call.
 */
export async function chooseRoute(db, { agent, project, task, title, explicit = {}, retryOf } = {}) {
  validateExplicit(explicit);
  let model = explicit.model;
  let effort = explicit.effort;
  let reason;
  if (model === undefined || effort === undefined) {
    const decided = await decide(db, { agent, project, task, title, retryOf });
    model = model ?? decided.model;
    effort = effort ?? decided.effort;
    const named = [explicit.model !== undefined && `model ${explicit.model}`, explicit.effort !== undefined && `effort ${explicit.effort}`].filter(Boolean);
    reason = named.length > 0 ? `explicit ${named.join(', ')}; ${decided.reason}` : decided.reason;
  } else {
    reason = `explicit ${model}/${effort}`;
  }
  return applyFloors({ model, effort, reason }, { agent, title, task });
}
