import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import * as memory from '../src/memory.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseRoute, routeStats, statsLines } from '../src/route.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const STAND_IN = join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs');

/** A registered project a chooseRoute call can point at. */
function makeProject(db, slug = 'demo') {
  const dir = mkdtempSync(join(tmpdir(), `sumo-agents-route-${slug}-`));
  return addProject(db, dir, { slug }).project;
}

function insertJob(db, { project = 'demo', title = 'x', agent = 'worker', status = 'running', model = null, effort = null, important = null, now = new Date().toISOString() } = {}) {
  const { lastInsertRowid } = db
    .prepare(
      `INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort, important)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(project, title, agent, status, now, now, model, effort, important);
  return Number(lastInsertRowid);
}

/** Runs `fn` with the router stand-in answering `answer` (or, with no answer, failing). */
async function withRouter(answer, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-route-'));
  const answerFile = join(dir, 'answer.json');
  if (answer !== undefined) writeAnswer(answerFile, answer);
  return withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: answerFile }, async () => {
    const db = openDb();
    try {
      return await fn(db, makeProject(db, 'routed'));
    } finally {
      db.close();
    }
  });
}

test('the router is asked every time, and its answer is the route', async () => {
  await withRouter({ model: 'opus', effort: 'high', reason: 'novel bug, needs judgment' }, async (db, project) => {
    const route = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    assert.deepEqual(route, { model: 'opus', effort: 'high', reason: 'router: novel bug, needs judgment' });
  });
});

test('a failed router call refuses the route — there is no fallback', async () => {
  await withRouter(undefined, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), (err) => err instanceof memory.UsageError && /^the router failed: /.test(err.message));
  });
});

test('an answer outside the schema is a failure, not a default', async () => {
  await withRouter({ model: 'gpt', effort: 'high', reason: 'x' }, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /the router failed: the router answered outside its schema/);
  });
});

test('nothing raises the router\'s answer: no reviewer floor, no security floor', async () => {
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'small' }, async (db, project) => {
    const reviewer = await chooseRoute(db, { agent: 'reviewer', project, title: 'x', task: 'y' });
    assert.deepEqual(reviewer, { model: 'sonnet', effort: 'low', reason: 'router: small' });
    const security = await chooseRoute(db, { agent: 'worker', project, title: 'rotate the API key', task: 'handles the payment migration' });
    assert.deepEqual(security, { model: 'sonnet', effort: 'low', reason: 'router: small' });
  });
});

test('a project rule no longer decides — the router does', async () => {
  await withRouter({ model: 'sonnet', effort: 'medium', reason: 'routine' }, async (db, project) => {
    memory.add(db, { type: 'decision', project: project.slug, body: 'worker model opus effort xhigh' });
    const route = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    assert.deepEqual(route, { model: 'sonnet', effort: 'medium', reason: 'router: routine' });
  });
});

test('a scout is still asked, then runs on haiku with no effort — the only scout there is', async () => {
  await withRouter({ model: 'opus', effort: 'high', reason: 'deep trace' }, async (db, project) => {
    const route = await chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' });
    assert.deepEqual(route, { model: 'haiku', effort: 'none', reason: 'router: deep trace; scout runs on haiku' });
  });
  await withRouter(undefined, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' }), /the router failed/);
  });
});

test('haiku takes no effort, so an effort the router gives it is dropped', async () => {
  await withRouter({ model: 'haiku', effort: 'low', reason: 'mechanical' }, async (db, project) => {
    const route = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    assert.deepEqual(route, { model: 'haiku', effort: 'none', reason: 'router: mechanical; haiku takes no effort' });
  });
});

test('no effort on a model that takes one is refused: it would silently inherit the session\'s effort', async () => {
  await withRouter({ model: 'sonnet', effort: 'none', reason: 'x' }, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /the router failed: it gave sonnet no effort/);
  });
});

test('routeStats and statsLines group finished jobs by model and effort', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'stats-proj');
      insertJob(db, { project: project.slug, status: 'done', model: 'sonnet', effort: 'medium', important: 2 });
      insertJob(db, { project: project.slug, status: 'done', model: 'sonnet', effort: 'medium', important: null });
      insertJob(db, { project: project.slug, status: 'failed', model: 'sonnet', effort: 'medium', important: null });
      insertJob(db, { project: project.slug, status: 'done', model: 'opus', effort: 'high', important: 1 });
      insertJob(db, { project: project.slug, status: 'running', model: 'opus', effort: 'high' }); // not finished — excluded

      const rows = routeStats(db, { project: project.slug });
      assert.deepEqual(
        rows.map((r) => ({ model: r.model, effort: r.effort, jobs: r.jobs, done: r.done, failed: r.failed, reviewed: r.reviewed })),
        [
          { model: 'opus', effort: 'high', jobs: 1, done: 1, failed: 0, reviewed: 1 },
          { model: 'sonnet', effort: 'medium', jobs: 3, done: 2, failed: 1, reviewed: 1 },
        ],
      );

      const lines = statsLines(db, { project: project.slug });
      assert.deepEqual(lines, [
        'opus/high: 1 jobs, 1 done, 0 failed, 1 reviewed, avg 1.0 important',
        'sonnet/medium: 3 jobs, 2 done, 1 failed, 1 reviewed, avg 2.0 important',
      ]);

      assert.deepEqual(statsLines(db, { project: 'no-such-project' }), ['no finished jobs yet']);
    } finally {
      db.close();
    }
  });
});

function writeAnswer(file, data) {
  writeFileSync(file, JSON.stringify({ is_error: false, result: '', structured_output: data, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }));
}
