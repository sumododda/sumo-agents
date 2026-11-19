import { CURSOR_MODELS, JOB_MODELS, modelId, usableJobModels, usableModels } from './catalog.mjs';
import { getMeta } from './db.mjs';
import { routeScore, savedScorecard } from './scorecard.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { callLocalModel, costOf } from './model.mjs';
import { UsageError } from './memory.mjs';
import { elapsed } from './text.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
/** A failed job can always be retried; a done one only once review found enough wrong with it — and either retry goes up. */
export const RETRY_IMPORTANT_THRESHOLD = 3;

const KINDS = ['mechanical', 'routine', 'hard', 'novel'];
const SURFACES = ['one spot', 'a few files', 'many interacting parts'];

/**
 * Each router prompt: who is being routed, the kinds to sort the work into, and the rule from kind and surface to a route.
 * With a scorecard saved (src/scorecard.mjs) the same prompt is asked for the sorting alone, and code picks the route
 * (`pickRoute`); with none, the router still chooses by the rule, as it always has. The rule stays in the prompt either way:
 * measured on the router probe (Nov 18 2026), a prompt without it made the local model call a one-function change
 * "many interacting parts" and risky, and the same prompt with it sorted the change as routine, in one spot.
 */
const JOB_KINDS =
  'kind: mechanical (typos, renames, comments, constants, tests for a pure function), routine (an ordinary feature or fix with a clear spec), ' +
  'hard (design, a bug whose cause is unknown, or reviewing risky code), novel (new algorithms, subtle concurrency, deep security review). ' +
  'surface: how much code the job touches. risky: true when it touches security, credentials, money, migrations or concurrency.';
const ROUTER_SYSTEM =
  'You assign a coding job to a model and an effort level. Answer with JSON only. First classify the job, then choose. ' +
  JOB_KINDS +
  ' Model follows kind: haiku for mechanical, sonnet for routine, opus for hard, fable for novel. Effort follows surface: low for one spot, ' +
  'medium for a few files, high for many interacting parts. risky raises the effort one step (low, medium, high, xhigh, max) and makes a ' +
  'routine job hard. History lists only the routes that failed or drew Important review findings on this project: for work like that, go above them.';

/**
 * The same grammar read for a scout, which reads and reports and changes nothing: the kinds above are told in terms of
 * changing code, and read that way an audit is "novel" and a summary of an unfamiliar project is too — the dearest model
 * for work that is reading. Here they are told in terms of what a reading job asks for.
 */
const SCOUT_KINDS =
  'kind: mechanical (one lookup: where one thing is defined, what one setting is), routine (finding, tracing, listing, describing or ' +
  'summarizing code: what a project does, how a feature works, which endpoints exist, which dependencies are behind — however large or ' +
  'unfamiliar the project), hard (it must judge: an audit of security or correctness, a review, a hunt for the cause of a bug), novel ' +
  '(almost never: only reasoning nobody has written down, such as proving a concurrent algorithm correct). surface: how much code must be ' +
  'read. risky: true when what is judged is security, credentials, money, migrations or concurrency.';
const SCOUT = 'The job is done by a scout: it reads code and reports, and changes nothing.';
const SCOUT_ROUTER_SYSTEM =
  `You assign a reading job to a model and an effort level. ${SCOUT} Answer with JSON only. First classify the job, then choose. ` +
  SCOUT_KINDS +
  ' Model follows kind: haiku for mechanical, sonnet for routine, opus for hard, fable for novel. Effort follows surface: low for one spot, ' +
  'medium for a few files or a whole project read for a summary, high when many interacting parts must be judged together. risky raises the ' +
  'effort one step (low, medium, high, xhigh, max). History lists only the routes that failed or drew Important review findings on this ' +
  'project: for work like that, go above them.';

/**
 * The answer shape: the models that are on and the efforts every one of them takes. The classification comes
 * first: a small model that names the route first just repeats a route it was shown, and one that has described
 * the job first chooses from the description.
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
/** The grammar over the models that are on. */
const routerSchema = (usable) => answerShape(usable, EFFORTS);
/** The grammar when the router only sorts: the classification and its reason, no route. */
const CLASSIFY_SCHEMA = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: KINDS },
    surface: { type: 'string', enum: SURFACES },
    risky: { type: 'boolean' },
    reason: { type: 'string', maxLength: 200 },
  },
  required: ['kind', 'surface', 'risky', 'reason'],
  additionalProperties: false,
};

/**
 * What each kind asks of a route's score on the scorecard (0–1, a place among Sumo's models): starting values. The effort
 * still follows the surface, as the rule had it, and a larger or risky ask needs at least what the smaller one got (`pickRoute`).
 * On the scorecard of Nov 18 2026 a job gets haiku for mechanical work and sonnet for routine, as the rule had it; hard work,
 * risky work and novel work get opus, which scores above the catalog's Fable 5.1 (for hard work in one spot sonnet at high
 * effort clears the bar too, and costs more than opus at low). The chat, open to xhigh, gets sonnet at xhigh for hard work past
 * one spot: it scores as much as opus at low, for less than opus at medium.
 */
const BARS = { mechanical: 0, routine: 0.3, hard: 0.55, novel: 0.75 };
const SURFACE_EFFORT = { 'one spot': 'low', 'a few files': 'medium', 'many interacting parts': 'high' };

/**
 * A route as the run it is: a model that takes no effort (Composer) runs the same at every one, and one on Cursor that takes
 * an effort is sent its xhigh for max (`cursorModel`, src/cursor.mjs). What the ledger knows of a run, and what this project's
 * record holds against it, is known of each route that is that run.
 */
function runOf(model, effort) {
  const cursor = CURSOR_MODELS[model];
  if (!cursor) return `${model}/${effort}`;
  return cursor.effort ? `${model}/${effort === 'max' ? 'xhigh' : effort}` : `${model}/*`;
}

/**
 * The cheapest of `routes` by one measure: their prices, when every one of them has one — never some priced and some not —
 * and on equal prices, or with none, the lower rung: the model lower on the job ladder, then the lower effort.
 */
function cheapest(routes) {
  const priced = routes.every((r) => r.price);
  return [...routes].sort((a, b) => (priced && a.price.cost !== b.price.cost ? a.price.cost - b.price.cost : 0) || compareRoutes(a, b))[0];
}

/**
 * The route code picks from the router's sorting and the saved scorecard: the cheapest route — priced from the `ledger` where
 * it can (`priceRoutes`), else by the benchmarks — whose score clears the bar for the kind, at the effort the surface asks for
 * or above, one step more when risky, and no higher than `highest`. risky also makes routine work hard where `hardens`. The
 * floors are taken in turn from the lowest, each needing what the pick one floor down scored, so a larger or risky ask never
 * gets a lower-scoring route than a smaller one of the same kind. A retry passes `above`, the score of the attempt retried:
 * the route must score more, and says whether one did (`climbed`). A route in `avoid` (this project's record is against it)
 * is passed over while another is scored. When none clears the bar, the best-scored route. Null when no route of the
 * `usable` models is on the scorecard. Pure.
 */
export function pickRoute({ card, usable, kind, surface, risky = false, hardens = true, highest = null, avoid = [], ledger = null, above = null }) {
  const asked = risky && hardens && kind === 'routine' ? 'hard' : kind;
  const top = highest ? EFFORTS.indexOf(highest) : EFFORTS.length - 1;
  const floor = Math.min(EFFORTS.indexOf(SURFACE_EFFORT[surface] ?? 'low') + (risky ? 1 : 0), top);
  // One route per run (`runOf`): Composer at the floor's effort, and no max on Cursor — either would be the same job said again.
  const efforts = (model, at) => {
    const cursor = CURSOR_MODELS[model];
    if (cursor && !cursor.effort) return [EFFORTS[at]];
    return EFFORTS.slice(at, top + 1).filter((effort) => !cursor || effort !== 'max');
  };
  const avoided = new Set(avoid.map((route) => runOf(...route.split('/'))));
  const poolAt = (at) => {
    const scored = priceRoutes(usable.flatMap((model) => efforts(model, at).map((effort) => ({ model, effort, on: routeScore(card, model, effort, EFFORTS) }))).filter((r) => r.on), ledger, card);
    const open = scored.filter((r) => !avoided.has(runOf(r.model, r.effort)));
    return open.length > 0 ? open : scored;
  };
  let bar = BARS[asked];
  let raisedBy = null;
  let pick = null;
  let clear = [];
  for (let at = 0; at <= floor; at += 1) {
    const pool = poolAt(at);
    if (pool.length === 0) return null;
    if (pick && pick.on.score > bar) [bar, raisedBy] = [pick.on.score, pick];
    clear = pool.filter((r) => r.on.score >= bar && (above === null || r.on.score > above));
    pick = clear.length > 0 ? cheapest(clear) : [...pool].sort((a, b) => b.on.score - a.on.score || compareRoutes(a, b))[0];
  }
  const two = (n) => Number(n.toFixed(2));
  const needs = `${asked}${risky ? ', risky' : ''}, ${surface} needs ${two(bar)}${raisedBy ? `, what ${raisedBy.model}/${raisedBy.effort} scores a step smaller` : ''}${above === null ? '' : ` and more than ${two(above)}, what the attempt retried scores`}`;
  const price = clear.length > 0 && clear.every((r) => r.price) ? `$${pick.price.cost.toFixed(2)} ${pick.price.per}, the cheapest` : 'an unknown cost, the lowest';
  const why = clear.length > 0
    ? `${needs}; ${pick.model}/${pick.effort} scores ${pick.on.score.toFixed(2)} at ${price} of ${clear.length} that do`
    : `${needs}; none does, and ${pick.model}/${pick.effort} scores best at ${pick.on.score.toFixed(2)}`;
  return { model: pick.model, effort: pick.effort, why, ...(above === null ? {} : { climbed: clear.length > 0 }) };
}

/**
 * What Sumo's own jobs of one `agent` have cost, from the ledger, for pricing routes: each run's finished jobs (`runOf`) — how many,
 * and their average — and the typical finished job's tokens, read from the cache and not. Only a job that did billed work
 * counts: one that failed at its first request cost nothing and says nothing of its route. A scout's reading prices a scout's
 * route, never a worker's. Neither API gives a cost back here (Cursor's needs a feature this account lacks), and the ledger
 * prices every request as it comes: it is the one measure of what Sumo's own work costs. Null while it holds no such job.
 */
export function ledgerCost(db, agent) {
  const jobs = db
    .prepare(
      `SELECT j.model AS model, j.effort AS effort, SUM(r.cost_usd) AS cost, SUM(r.input_tokens) AS input, SUM(COALESCE(r.cache_read_tokens, 0)) AS cached,
              SUM(COALESCE(r.cache_creation_tokens, 0)) AS written, SUM(r.output_tokens) AS output
         FROM jobs j JOIN model_runs r ON r.job_id = j.id
        WHERE j.model IS NOT NULL AND j.status IN ('done', 'failed') AND j.agent = ? GROUP BY j.id HAVING SUM(r.cost_usd) > 0`,
    )
    .all(agent);
  if (jobs.length === 0) return null;
  const mean = (k) => jobs.reduce((sum, j) => sum + (j[k] ?? 0), 0) / jobs.length;
  const own = new Map();
  for (const j of jobs) {
    const run = runOf(j.model, j.effort);
    const seen = own.get(run) ?? { sum: 0, n: 0 };
    own.set(run, { sum: seen.sum + j.cost, n: seen.n + 1 });
  }
  return {
    own: new Map([...own].map(([route, { sum, n }]) => [route, { cost: sum / n, jobs: n }])),
    typical: { input: mean('input'), cached: mean('cached'), written: mean('written'), output: mean('output') },
  };
}

/**
 * Prices each route for picking, in one unit. With a `ledger` (`ledgerCost`), what a job costs: a route's own average over its
 * jobs; else the benchmarks' cost of one of their tasks scaled to the size of Sumo's jobs — by how the routes the ledger has
 * priced compare with what the benchmarks say of them — so a dearer effort or model stays dearer; else the typical job's
 * tokens at the model's prices. Without one, what a benchmark task costs, where a source says. A price that is not above
 * zero is none. `routes` are `{ model, effort, on }`; the scale is taken over every route the ledger has priced and the
 * `card` prices too, whether or not this job may use it.
 */
function priceRoutes(routes, ledger, card) {
  const priced = (cost, per) => (cost > 0 ? { cost, per } : null);
  if (!ledger) return routes.map((r) => ({ ...r, price: priced(r.on.cost, 'a task on the benchmarks') }));
  const ratios = [...ledger.own]
    .map(([route, mine]) => [mine, routeScore(card, ...route.split('/'), EFFORTS)?.cost])
    .filter(([, cost]) => cost > 0)
    .map(([mine, cost]) => mine.cost / cost)
    .filter((ratio) => ratio > 0)
    .sort((a, b) => a - b);
  const scale = ratios.length > 0 ? ratios[Math.floor(ratios.length / 2)] : null;
  const typical = (model) => {
    const t = ledger.typical;
    return costOf(modelId(model), { input_tokens: Math.max(0, t.input - t.cached - t.written), cache_read_input_tokens: t.cached, cache_creation_input_tokens: t.written, output_tokens: t.output });
  };
  return routes.map((r) => {
    const mine = ledger.own.get(runOf(r.model, r.effort));
    if (mine) return { ...r, price: priced(mine.cost, `a job, by its ${mine.jobs} in the ledger`) };
    if (r.on.cost > 0 && scale !== null) return { ...r, price: priced(r.on.cost * scale, `a job, from the benchmarks scaled to the ledger's (×${scale.toPrecision(2)})`) };
    return { ...r, price: priced(typical(r.model), "a job, the ledger's typical one at its prices") };
  });
}

/**
 * The saved scorecard, when it lists any of `usable` and scores no other version of one of them: what decides whether the router
 * sorts or chooses. One fetched before the catalog moved a model on is set aside until Discover fetches it again — read, it would
 * leave that model out of routing for want of a score.
 */
function scorecardFor(db, usable) {
  const card = savedScorecard(db);
  const stale = Object.values(card?.sources ?? {}).some((s) => s.entries.some((e) => usable.includes(e.model) && e.id !== modelId(e.model)));
  return card && !stale && usable.some((m) => EFFORTS.some((e) => routeScore(card, m, e, EFFORTS))) ? card : null;
}

/** The routes this project's record is against: half or more of their jobs failed, or their reviews averaged enough Important findings. */
const troubled = (db, projectSlug) =>
  routeStats(db, { project: projectSlug })
    .filter((r) => (r.failed > 0 && r.failed >= r.done) || (r.avgImportant ?? 0) >= RETRY_IMPORTANT_THRESHOLD)
    .map((r) => `${r.model}/${r.effort}`);

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

/** What the router reads of a job. Only sorting it (`classify`), it is not shown the models or their history: code weighs those. */
function routerPrompt(db, { agent, project, task, title, retryOf }, { classify = false } = {}) {
  const stack = stackOf(db, project.slug);
  return [
    `role: ${agent}`,
    `project: ${project.slug}${stack ? ` (${stack})` : ''}`,
    ...(classify
      ? []
      : [`models: ${jobModels(db, { claude: true }).join(', ')}`, ...(retryOf === undefined ? [] : [retryLine(db, retryOf)].filter(Boolean)), 'history:', historyText(db, project.slug)]),
    `title: ${title ?? ''}`,
    '',
    String(task ?? '').slice(0, TASK_CUT),
  ].join('\n');
}

/**
 * The same grammar read for a chat turn: the message is the whole job, there is no brief to size it by
 * and no history of turns, so the kinds are told in terms of what a message asks for.
 */
const CHAT_KINDS =
  'kind: mechanical (a one-line question, a lookup, a typo, a rename, running a command and reporting), routine (an ordinary feature or fix ' +
  'with a clear ask, a summary, an explanation), hard (design, a bug whose cause is unknown, a review of risky code, planning across a ' +
  'codebase), novel (new algorithms, subtle concurrency, deep security review). surface: how much code the turn touches. risky: true when ' +
  'it touches security, credentials, money, migrations or concurrency.';
const CHAT = 'The chat is a coding assistant with a shell and an editor; the turn is what the user just typed.';
const CHAT_ROUTER_SYSTEM =
  `You assign one chat turn to a model and an effort level. ${CHAT} Answer with JSON only. First classify the turn, then choose. ` +
  CHAT_KINDS +
  ' Model follows kind: haiku for mechanical, sonnet for routine, opus for hard, fable for novel. Effort follows surface: low for one spot, ' +
  'medium for a few files, high for many interacting parts. risky raises the effort one step (low, medium, high, xhigh, max) and makes a ' +
  'routine turn hard.';

function chatRouterPrompt(db, { project, text }, { classify = false } = {}) {
  const stack = project ? stackOf(db, project.slug) : null;
  const models = classify ? [] : [`models: ${usableModels(db).join(', ')}`];
  return [`project: ${project ? `${project.slug}${stack ? ` (${stack})` : ''}` : 'none'}`, ...models, 'turn:', String(text ?? '').slice(0, TASK_CUT)].join('\n');
}

/** The smallest model a job may run on (`jobs.floor`); haiku, the cheapest, holds nothing back. */
const jobFloor = (db) => getMeta(db, 'config.jobs.floor') ?? CONFIG_DEFAULTS['jobs.floor'];

/**
 * The models a job may be routed to: the ones that are on, from the floor up — or all of them, when none at or above it is on.
 * Cursor's are among them where the scorecard weighs them; the rule names Claude's alone, so where the router chooses by it
 * (`claude`) only Claude's are.
 */
export function jobModels(db, { claude = false } = {}) {
  const usable = claude ? usableModels(db) : usableJobModels(db);
  const above = usable.filter((m) => JOB_MODELS.indexOf(m) >= JOB_MODELS.indexOf(jobFloor(db)));
  return above.length > 0 ? above : usable;
}

const askRouter = (db, { agent, project, task, title, retryOf }, { classify = false } = {}) =>
  askFor(db, agent === 'scout' ? SCOUT_ROUTER_SYSTEM : ROUTER_SYSTEM, routerPrompt(db, { agent, project, task, title, retryOf }, { classify }), jobModels(db, { claude: !classify }), { classify });

async function askFor(db, system, prompt, models = usableModels(db), { classify = false } = {}) {
  const usable = models;
  if (usable.length === 0) throw new UsageError('no model is on — turn one on under API models, on the settings page (sumo config)');
  const result = await callLocalModel(db, { system, prompt, schema: classify ? CLASSIFY_SCHEMA : routerSchema(usable) });
  if (!result.ok) return { ok: false, error: result.error };
  const { kind, surface, model, effort, reason, risky } = result.data ?? {};
  // The same pairing the schema enforces, checked again: a backend without grammar support can still answer anything.
  const fits = classify ? KINDS.includes(kind) && SURFACES.includes(surface) : usable.includes(model) && EFFORTS.includes(effort);
  if (!fits || typeof reason !== 'string' || !reason.trim()) return { ok: false, error: `the router answered outside its schema: ${JSON.stringify(result.data)}` };
  // Whether the work touches security, credentials, money, migrations or concurrency: kept, so such work is reviewed. Only a plain yes is one.
  return { ok: true, kind, surface, model, effort, reason: reason.replace(/\s+/g, ' ').trim(), risky: risky === true };
}

// Routes compared on one scale: by model first, weakest to strongest as the job ladder lists them (JOB_MODELS), then by effort.
// The 'none' an old job ran at, from when haiku took no effort, sits below every effort.
const modelRank = (model) => JOB_MODELS.indexOf(model);
const effortRank = (effort) => EFFORTS.indexOf(effort);
const compareRoutes = (a, b) => modelRank(a.model) - modelRank(b.model) || effortRank(a.effort) - effortRank(b.effort);

/** Whether a retry of `prev` must go above it: the job failed, or drew RETRY_IMPORTANT_THRESHOLD Important findings, on a route Sumo knows. */
const goesAbove = (prev) => Boolean(prev) && modelRank(prev.model) >= 0 && (prev.status === 'failed' || (prev.important ?? 0) >= RETRY_IMPORTANT_THRESHOLD);

/** One step above a route: the next model up that is on, keeping the effort (medium, off an old 'none'); on the top one, one effort up, max at most. */
function stepAbove({ model, effort }, usable) {
  const next = usable.find((m) => modelRank(m) > modelRank(model));
  if (next) return { model: next, effort: EFFORTS.includes(effort) ? effort : 'medium' };
  const top = usable.at(-1);
  return { model: top, effort: EFFORTS[Math.min(effortRank(effort) + 1, EFFORTS.length - 1)] };
}

/**
 * What code does to the router's answer before it is a job's route. The router reads only the task's words, the weakest
 * thing to route by, and is merely asked to go above what failed; on the ledger, workers that started on fable finished
 * 2 of 5 at more than twice the price of opus, which finished 5 of 6. So these hold whatever it answers:
 * - A first attempt starts lower: a worker's never runs on fable while opus is on, and no first attempt runs above high effort.
 * - A scout's first attempt does not run on haiku while sonnet is on: on the ledger, haiku scouts left 3 of 11 unfinished,
 *   sonnet and opus ones none of 9 (measured on Haiku 4.5; not yet on 5.5). It runs on sonnet at low effort instead.
 * - A retry of a job that failed, or that drew RETRY_IMPORTANT_THRESHOLD Important findings, runs at least one step above it —
 *   unless the scorecard already put it on a route that scores above it (`climbed`): the ladder's next model up may score less.
 * - A reviewer pointed at a job runs on at least that job's model, at medium effort or more.
 * Pure: `retryOf` and `reviews` are the rows (id, model, effort, status, important) of the job retried and the job judged,
 * or nothing; `usable` is the models that are on, cheapest first. An attempt with no route Sumo knows has nothing to go
 * above. `policy` says what changed and why, or is null.
 */
export function routePolicy({ agent, routed, retryOf: prev, reviews: target, usable, floor = null, climbed = false }) {
  let route = { model: routed.model, effort: routed.effort };
  const why = [];
  // The user's floor before anything else: a job never starts on a model below it while one at or above it is on.
  if (floor && modelRank(route.model) < modelRank(floor)) {
    const up = usable.find((m) => modelRank(m) >= modelRank(floor));
    if (up) {
      route = { model: up, effort: EFFORTS.includes(route.effort) ? route.effort : 'medium' };
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
  } else if (goesAbove(prev) && !climbed) {
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
    if (effortRank(route.effort) < effortRank('medium')) {
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
  // With a scorecard the router only sorts the job and code picks the route from it; with none, the router chooses by its rule,
  // among Claude's models, as it always has.
  const card = scorecardFor(db, jobModels(db));
  const routed = await askRouter(db, { agent, project, task, title, retryOf }, { classify: card !== null });
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error} — no job was created`);
  const first = retryOf === undefined || retryOf === null;
  const prev = jobRoute(db, retryOf);
  // A retry on the scorecard goes to a route that scores more than the attempt retried, never back to that one.
  const above = card && goesAbove(prev) ? (routeScore(card, prev.model, prev.effort, EFFORTS)?.score ?? null) : null;
  const avoid = [...troubled(db, project.slug), ...(above === null ? [] : [`${prev.model}/${prev.effort}`])];
  const scored = card && pickRoute({ card, usable: jobModels(db), kind: routed.kind, surface: routed.surface, risky: routed.risky, hardens: agent !== 'scout', highest: first ? 'high' : null, avoid, ledger: ledgerCost(db, agent), above });
  const chosen = scored ? { ...routed, model: scored.model, effort: scored.effort } : routed;
  const { model, effort, policy } = routePolicy({ agent, routed: chosen, retryOf: prev, reviews: jobRoute(db, reviews), usable: card ? usableJobModels(db) : usableModels(db), floor: jobFloor(db), climbed: scored?.climbed === true });
  return { model, effort, reason: `router: ${routed.reason}${scored ? `; scorecard: ${scored.why}` : ''}${policy ? `; policy: ${policy}` : ''}`, risky: routed.risky };
}

/** The chat's route for one turn on auto, by the same router — sorting the turn when a scorecard is saved, choosing when none is: its answer or a refusal, nothing in between. */
export async function chooseChatRoute(db, { project, text }) {
  // The chat runs on Cursor's models too: with a scorecard they are weighed with Claude's; with none, the rule names Claude's alone.
  const card = scorecardFor(db, usableJobModels(db));
  const classify = card !== null;
  const routed = await askFor(db, CHAT_ROUTER_SYSTEM, chatRouterPrompt(db, { project, text }, { classify }), usableModels(db), { classify });
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error}`);
  // A turn edits and runs commands as a worker does: its routes are priced by workers' jobs.
  const scored = card && pickRoute({ card, usable: usableJobModels(db), kind: routed.kind, surface: routed.surface, risky: routed.risky, ledger: ledgerCost(db, 'worker') });
  return scored ? { model: scored.model, effort: scored.effort, reason: `${routed.reason}; scorecard: ${scored.why}` } : { model: routed.model, effort: routed.effort, reason: routed.reason };
}
