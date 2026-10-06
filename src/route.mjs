import { usableModels } from './catalog.mjs';
import { callLocalModel } from './model.mjs';
import { UsageError } from './memory.mjs';

export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

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
    `models: ${usableModels(db).join(', ')}`,
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

const askRouter = (db, { agent, project, task, title, retryOf }) => askFor(db, ROUTER_SYSTEM, routerPrompt(db, { agent, project, task, title, retryOf }));

async function askFor(db, system, prompt) {
  const usable = usableModels(db);
  if (usable.length === 0) throw new UsageError('no model is on — sumo models enable <name>');
  const result = await callLocalModel(db, { system, prompt, schema: routerSchema(usable) });
  if (!result.ok) return { ok: false, error: result.error };
  const { model, effort, reason } = result.data ?? {};
  // The same pairing the schema enforces, checked again: a backend without grammar support can still answer anything.
  const fits = usable.includes(model) && (model === 'haiku' ? effort === 'none' : EFFORTS.includes(effort));
  if (!fits || typeof reason !== 'string' || !reason.trim()) return { ok: false, error: `the router answered outside its schema: ${JSON.stringify(result.data)}` };
  return { ok: true, model, effort, reason: reason.replace(/\s+/g, ' ').trim() };
}

/**
 * Chooses a job's model and effort by asking the local router — every job, every retry, no exceptions.
 * Its answer is the route; a router that cannot answer refuses the job, with no default to fall back
 * to. A retry tells the router what the previous attempt ran on and how it ended. Its answer is taken as
 * it is, for every role: the models it may pick are the ones that are on (`sumo models`).
 */
export async function chooseRoute(db, { agent, project, task, title, retryOf }) {
  const routed = await askRouter(db, { agent, project, task, title, retryOf });
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error} — no job was created`);
  return { model: routed.model, effort: routed.effort, reason: `router: ${routed.reason}` };
}

/** The chat's route for one turn on auto, by the same router: its answer or a refusal, nothing in between. */
export async function chooseChatRoute(db, { project, text }) {
  const routed = await askFor(db, CHAT_ROUTER_SYSTEM, chatRouterPrompt(db, { project, text }));
  if (!routed.ok) throw new UsageError(`the router failed: ${routed.error}`);
  return { model: routed.model, effort: routed.effort, reason: routed.reason };
}
