import { MODELS, usableModels } from './catalog.mjs';
import { getMeta } from './db.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { callLocalModel } from './model.mjs';
import { UsageError } from './memory.mjs';
import { elapsed } from './text.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A failed job can always be retried; a done one only once review found enough wrong with it — and either retry goes up. */
export const RETRY_IMPORTANT_THRESHOLD = 3;

const KINDS = ['mechanical', 'routine', 'hard', 'novel'];
const SURFACES = ['one spot', 'a few files', 'many interacting parts'];

const ROUTER_SYSTEM =
  'You assign a coding job to a model and an effort level. Answer with JSON only. First classify the job, then choose. kind: mechanical (typos, ' +
  'renames, comments, constants, tests for a pure function), routine (an ordinary feature or fix with a clear spec), hard (design, a bug whose ' +
  'cause is unknown, or reviewing risky code), novel (new algorithms, subtle concurrency, deep security review). surface: how much code the job ' +
  'touches. risky: true when it touches security, credentials, money, migrations or concurrency. Model follows kind: haiku for mechanical (it ' +
  'takes no effort setting), sonnet for routine, opus for hard, fable for novel. Effort follows surface: low for one spot, medium for a few ' +
  'files, high for many interacting parts. risky raises the effort one step (low, medium, high, xhigh, max) and makes a routine job hard. ' +
  'History lists only the routes that failed or drew Important review findings on this project: for work like that, go above them.';

/**
 * The same grammar read for a scout, which reads and reports and changes nothing: the kinds above are told in terms of
 * changing code, and read that way an audit is "novel" and a summary of an unfamiliar project is too — the dearest model
 * for work that is reading. Here they are told in terms of what a reading job asks for.
 */
const SCOUT_ROUTER_SYSTEM =
  'You assign a reading job to a model and an effort level. The job is done by a scout: it reads code and reports, and changes nothing. ' +
  'Answer with JSON only. First classify the job, then choose. kind: mechanical (one lookup: where one thing is defined, what one setting ' +
  'is), routine (finding, tracing, listing, describing or summarizing code: what a project does, how a feature works, which endpoints ' +
  'exist, which dependencies are behind — however large or unfamiliar the project), hard (it must judge: an audit of security or ' +
  'correctness, a review, a hunt for the cause of a bug), novel (almost never: only reasoning nobody has written down, such as proving a ' +
  'concurrent algorithm correct). surface: how much code must be read. risky: true when what is judged is security, credentials, money, ' +
  'migrations or concurrency. Model follows kind: haiku for mechanical (it takes no effort setting), sonnet for routine, opus for hard, ' +
  'fable for novel. Effort follows surface: low for one spot, medium for a few files or a whole project read for a summary, high when ' +
  'many interacting parts must be judged together. risky raises the effort one step (low, medium, high, xhigh, max). ' +
  'History lists only the routes that failed or drew Important review findings on this project: for work like that, go above them.';

/**
 * One answer shape per pairing, so the grammar itself cannot give haiku an effort or another model none.
 * The classification comes first: a small model that names the route first just repeats a route it was
 * shown, and one that has described the job first chooses from the description.
 */
const answerShape = (models, efforts) => ({
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    surface: { type: 'string', enum: SURFACES },
    risky: { type: 'boolean' },
    model: { type: 'string', enum: models },
    effort: { type: 'string', enum: efforts },
    reason: { type: 'string', maxLength: 200 },
  },
  required: ['kind', 'surface', 'risky', 'model', 'effort', 'reason'],
  additionalProperties: false,
});
/** The grammar over the models that are on: the haiku branch while haiku is, the effort branch over the others. */
const routerSchema = (usable) => ({
  anyOf: [
    ...(usable.includes('haiku') ? [answerShape(['haiku'], ['none'])] : []),
    ...(usable.some((m) => m !== 'haiku') ? [answerShape(usable.filter((m) => m !== 'haiku'), EFFORTS)] : []),
  ],
});

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

/**
 * Only evidence against a route is shown. A clean record says nothing about what a cheaper route
 * would have done, and the router repeats whatever route it sees praised — so a project that
 * started on the dearest one would never leave it.
 */
function historyText(db, projectSlug) {
  const rows = routeStats(db, { project: projectSlug }).filter((r) => r.failed > 0 || r.avgImportant > 0);
  if (rows.length === 0) return 'no history yet';
  return rows
    .map(
      (r) =>
        `${r.model}/${r.effort}: ${r.jobs} job${r.jobs === 1 ? '' : 's'}, ${r.done} done, ${r.failed} failed, ${r.reviewed} reviewed${
          r.reviewed > 0 ? `, avg ${r.avgImportant.toFixed(1)} Important findings` : ''
        }`,
    )
    .join('\n');
}

/**
 * `jobs, done, failed, reviewed, avg important` — one line per role and model/effort seen, and, where the ledger holds a
 * job's requests, what a job on that route took on average: requests, time, money. A route's price is what a job on it
 * costs, not what a token on it costs — a cheap model that takes ten times the requests is the dear one.
 */
export function statsLines(db, { project } = {}) {
  const rows = db
    .prepare(
      `SELECT j.agent, j.model, j.effort, COUNT(*) AS jobs, SUM(j.status = 'done') AS done, SUM(j.status = 'failed') AS failed,
              SUM(j.important IS NOT NULL) AS reviewed, AVG(j.important) AS important,
              AVG(r.requests) AS requests, AVG(r.seconds) AS seconds, AVG(r.cost) AS cost
       FROM jobs j
       LEFT JOIN (SELECT job_id, COUNT(*) AS requests, SUM(cost_usd) AS cost, (julianday(MAX(ts)) - julianday(MIN(ts))) * 86400 AS seconds
                  FROM model_runs WHERE job_id IS NOT NULL GROUP BY job_id) r ON r.job_id = j.id
       WHERE j.model IS NOT NULL AND j.status IN ('done', 'failed')${project ? ' AND j.project = ?' : ''}
       GROUP BY j.agent, j.model, j.effort ORDER BY j.agent, j.model, j.effort`,
    )
    .all(...(project ? [project] : []));
  if (rows.length === 0) return ['no finished jobs yet'];
  return rows.map(
    (r) =>
      `${r.agent} · ${r.model}/${r.effort}: ${r.jobs} job${r.jobs === 1 ? '' : 's'}, ${r.done} done, ${r.failed} failed, ${r.reviewed} reviewed, avg ${r.reviewed > 0 ? r.important.toFixed(1) : '-'} important` +
      (r.requests === null ? '' : ` — a job: ${Math.round(r.requests)} request${Math.round(r.requests) === 1 ? '' : 's'}, ${elapsed(Math.round(r.seconds) * 1000)}, $${r.cost.toFixed(2)}`),
  );
}

function stackOf(db, projectSlug) {
  const row = db.prepare(`SELECT body FROM memories WHERE scope = ? AND scan_key = 'stack' AND state = 'active'`).get(`project:${projectSlug}`);
  return row ? row.body.replace(/^stack:\s*/, '') : null;
}

/** What the job being retried ran on and how it ended — without it, a retry is routed exactly like the attempt that failed. */
function retryLine(db, retryOf) {
  const prev = db.prepare('SELECT model, effort, status, important FROM jobs WHERE id = ?').get(retryOf);
  if (!prev) return null;
  const outcome = prev.status === 'failed' ? 'failed' : `was reviewed with ${prev.important ?? 0} Important findings`;
  return `retry of j${retryOf}: it ran on ${prev.model ?? 'no recorded route'}${prev.effort ? `/${prev.effort}` : ''} and ${outcome}`;
}

function routerPrompt(db, { agent, project, task, title, retryOf }) {
  const stack = stackOf(db, project.slug);
  return [
    `role: ${agent}`,
    `project: ${project.slug}${stack ? ` (${stack})` : ''}`,
    `models: ${jobModels(db).join(', ')}`,
    ...(retryOf === undefined ? [] : [retryLine(db, retryOf)].filter(Boolean)),
    'history:',
    historyText(db, project.slug),
    `title: ${title ?? ''}`,
    '',
    String(task ?? '').slice(0, TASK_CUT),
  ].join('\n');
}

/**
 * The same grammar read for a chat turn: the message is the whole job, there is no brief to size it by
 * and no history of turns, so the kinds are told in terms of what a message asks for.
 */
const CHAT_ROUTER_SYSTEM =
  'You assign one chat turn to a model and an effort level. The chat is a coding assistant with a shell and an editor; the turn is what the ' +
  'user just typed. Answer with JSON only. First classify the turn, then choose. kind: mechanical (a one-line question, a lookup, a typo, a ' +
  'rename, running a command and reporting), routine (an ordinary feature or fix with a clear ask, a summary, an explanation), hard (design, ' +
  'a bug whose cause is unknown, a review of risky code, planning across a codebase), novel (new algorithms, subtle concurrency, deep security ' +
  'review). surface: how much code the turn touches. risky: true when it touches security, credentials, money, migrations or concurrency. ' +
  'Model follows kind: haiku for mechanical (it takes no effort setting), sonnet for routine, opus for hard, fable for novel. Effort follows ' +
  'surface: low for one spot, medium for a few files, high for many interacting parts. risky raises the effort one step (low, medium, high, ' +
  'xhigh, max) and makes a routine turn hard.';

function chatRouterPrompt(db, { project, text }) {
  const stack = project ? stackOf(db, project.slug) : null;
  return [`project: ${project ? `${project.slug}${stack ? ` (${stack})` : ''}` : 'none'}`, `models: ${usableModels(db).join(', ')}`, 'turn:', String(text ?? '').slice(0, TASK_CUT)].join('\n');
}

/** The smallest model a job may run on (`jobs.floor`); haiku, the cheapest, holds nothing back. */
export const jobFloor = (db) => getMeta(db, 'config.jobs.floor') ?? CONFIG_DEFAULTS['jobs.floor'];

/** The models a job may be routed to: the ones that are on, from the floor up — or all of them, when none at or above it is on. */
export function jobModels(db) {
  const usable = usableModels(db);
  const above = usable.filter((m) => MODELS.indexOf(m) >= MODELS.indexOf(jobFloor(db)));
  return above.length > 0 ? above : usable;
}

const askRouter = (db, { agent, project, task, title, retryOf }) => askFor(db, agent === 'scout' ? SCOUT_ROUTER_SYSTEM : ROUTER_SYSTEM, routerPrompt(db, { agent, project, task, title, retryOf }), jobModels(db));

async function askFor(db, system, prompt, models = usableModels(db)) {
  const usable = models;
  if (usable.length === 0) throw new UsageError('no model is on — sumo models enable <name>');
  const result = await callLocalModel(db, { system, prompt, schema: routerSchema(usable) });
  if (!result.ok) return { ok: false, error: result.error };
  const { model, effort, reason, risky } = result.data ?? {};
  // The same pairing the schema enforces, checked again: a backend without grammar support can still answer anything.
  const fits = usable.includes(model) && (model === 'haiku' ? effort === 'none' : EFFORTS.includes(effort));
  if (!fits || typeof reason !== 'string' || !reason.trim()) return { ok: false, error: `the router answered outside its schema: ${JSON.stringify(result.data)}` };
  // Whether the work touches security, credentials, money, migrations or concurrency: kept, so such work is reviewed. Only a plain yes is one.
  return { ok: true, model, effort, reason: reason.replace(/\s+/g, ' ').trim(), risky: risky === true };
}

// Routes compared on one scale: by model first, cheapest to dearest as the catalog lists them, then by effort.
// Haiku's 'none' sits below every effort.
const modelRank = (model) => MODELS.indexOf(model);
const effortRank = (effort) => EFFORTS.indexOf(effort);
const compareRoutes = (a, b) => modelRank(a.model) - modelRank(b.model) || effortRank(a.effort) - effortRank(b.effort);

/** One step above a route: the next model up that is on, keeping the effort (medium, off haiku); on the top one, one effort up, max at most. */
function stepAbove({ model, effort }, usable) {
  const next = usable.find((m) => modelRank(m) > modelRank(model));
  if (next) return { model: next, effort: EFFORTS.includes(effort) ? effort : 'medium' };
  const top = usable.at(-1);
  if (top === 'haiku') return { model: top, effort: 'none' };
  return { model: top, effort: EFFORTS[Math.min(effortRank(effort) + 1, EFFORTS.length - 1)] };
}

/**
 * What code does to the router's answer before it is a job's route. The router reads only the task's words, the weakest
 * thing to route by, and is merely asked to go above what failed; on the ledger, workers that started on fable finished
 * 2 of 5 at more than twice the price of opus, which finished 5 of 6. So these hold whatever it answers:
 * - A first attempt starts lower: a worker's never runs on fable while opus is on, and no first attempt runs above high effort.
 * - A scout's first attempt does not run on haiku while sonnet is on: on the ledger, haiku scouts left 3 of 11 unfinished,
 *   sonnet and opus ones none of 9 — and haiku caches nothing below 4,096 tokens. It runs on sonnet at low effort instead.
 * - A retry of a job that failed, or that drew RETRY_IMPORTANT_THRESHOLD Important findings, runs at least one step above it.
 * - A reviewer pointed at a job runs on at least that job's model, at medium effort or more.
 * Pure: `retryOf` and `reviews` are the rows (id, model, effort, status, important) of the job retried and the job judged,
 * or nothing; `usable` is the models that are on, cheapest first. An attempt with no route Sumo knows has nothing to go
 * above. `policy` says what changed and why, or is null.
 */
export function routePolicy({ agent, routed, retryOf: prev, reviews: target, usable, floor = null }) {
  let route = { model: routed.model, effort: routed.effort };
  const why = [];
  // The user's floor before anything else: a job never starts on a model below it while one at or above it is on.
  if (floor && modelRank(route.model) < modelRank(floor)) {
    const up = usable.find((m) => modelRank(m) >= modelRank(floor));
    if (up) {
      route = { model: up, effort: up === 'haiku' ? 'none' : EFFORTS.includes(route.effort) ? route.effort : 'medium' };
      why.push(`jobs.floor is ${floor}`);
    }
  }
  if (!prev) {
    if (agent === 'worker' && route.model === 'fable' && usable.includes('opus')) {
      route.model = 'opus';
      why.push('a first attempt starts on opus, not fable');
    }
    if (agent === 'scout' && route.model === 'haiku' && usable.includes('sonnet')) {
      route = { model: 'sonnet', effort: 'low' };
      why.push("a scout's first attempt starts on sonnet at low effort, not haiku");
    }
    if (effortRank(route.effort) > effortRank('high')) {
      route.effort = 'high';
      why.push('a first attempt runs at high effort at most');
    }
  } else if (modelRank(prev.model) >= 0 && (prev.status === 'failed' || (prev.important ?? 0) >= RETRY_IMPORTANT_THRESHOLD)) {
    const floor = stepAbove(prev, usable);
    if (compareRoutes(floor, route) > 0) {
      route = floor;
      const outcome = prev.status === 'failed' ? 'failed' : `drew ${prev.important} Important findings`;
      why.push(`a retry goes above j${prev.id}'s ${prev.model}/${prev.effort}, which ${outcome}`);
    }
  }
  if (agent === 'reviewer' && target?.model) {
    if (modelRank(route.model) < modelRank(target.model)) {
      // The judged job's model, or the nearest one that is on: above it if there is one, else the top one.
      route.model = usable.find((m) => modelRank(m) >= modelRank(target.model)) ?? usable.at(-1);
      why.push(`a reviewer is at least as strong as j${target.id}'s ${target.model}`);
    }
    if (route.model !== 'haiku' && effortRank(route.effort) < effortRank('medium')) {
      route.effort = 'medium';
      why.push('a reviewer runs at medium effort at least');
    }
  }
  return { ...route, policy: why.length === 0 ? null : `${why.join('; ')} (the router said ${routed.model}/${routed.effort})` };
}

const jobRoute = (db, id) => (id === undefined || id === null ? null : (db.prepare('SELECT id, model, effort, status, important FROM jobs WHERE id = ?').get(id) ?? null));

/**
 * Chooses a job's model and effort: the local router is asked — every job, every retry, no exceptions — and
 * `routePolicy` holds its answer to a few rules. A router that cannot answer refuses the job, with no default
 * to fall back to. A retry tells the router what the previous attempt ran on and how it ended; the models it
 * may pick are the ones that are on (`sumo models`). Then the policy: a worker's first attempt starts on
 * opus, not fable, and no first attempt runs above high effort; a retry of a job that failed or drew enough
 * Important findings runs at least one step above it — the next model up, or on the top one a higher effort —
 * and never below what the router answered; a reviewer created with `--reviews` runs on at least the judged
 * job's model, at medium effort or more; a scout's first attempt runs on sonnet at low effort, not haiku, while sonnet is
 * on. What the policy changed follows the router's reason. `risky` is the router's word on whether the work touches
 * security, credentials, money, migrations or concurrency — kept with the job, so such work is reviewed once it is done.
 */
export async function chooseRoute(db, { agent, project, task, title, retryOf, reviews }) {
  const routed = await askRouter(db, { agent, project, task, title, retryOf });
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error} — no job was created`);
  const { model, effort, policy } = routePolicy({ agent, routed, retryOf: jobRoute(db, retryOf), reviews: jobRoute(db, reviews), usable: usableModels(db), floor: jobFloor(db) });
  return { model, effort, reason: `router: ${routed.reason}${policy ? `; policy: ${policy}` : ''}`, risky: routed.risky };
}

/** The chat's route for one turn on auto, by the same router: its answer or a refusal, nothing in between. */
export async function chooseChatRoute(db, { project, text }) {
  const routed = await askFor(db, CHAT_ROUTER_SYSTEM, chatRouterPrompt(db, { project, text }));
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error}`);
  return { model: routed.model, effort: routed.effort, reason: routed.reason };
}
