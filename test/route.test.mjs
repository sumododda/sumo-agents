import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import * as memory from '../src/memory.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseRoute, projectRule, routeStats, statsLines, stepUp } from '../src/route.mjs';
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

test('stepUp climbs effort to high, then the model, then to xhigh, then refuses', () => {
  assert.deepEqual(stepUp({ model: 'haiku', effort: 'none' }), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(stepUp({ model: 'sonnet', effort: 'low' }), { model: 'sonnet', effort: 'medium' });
  assert.deepEqual(stepUp({ model: 'sonnet', effort: 'medium' }), { model: 'sonnet', effort: 'high' });
  assert.deepEqual(stepUp({ model: 'sonnet', effort: 'high' }), { model: 'opus', effort: 'high' });
  assert.deepEqual(stepUp({ model: 'opus', effort: 'high' }), { model: 'fable', effort: 'high' });
  assert.deepEqual(stepUp({ model: 'fable', effort: 'high' }), { model: 'fable', effort: 'xhigh' });
  assert.equal(stepUp({ model: 'fable', effort: 'xhigh' }), null);
  assert.equal(stepUp({ model: 'fable', effort: 'max' }), null);
  // A floor can land a route above the ladder's normal high-water mark (opus/xhigh); the model still climbs.
  assert.deepEqual(stepUp({ model: 'opus', effort: 'xhigh' }), { model: 'fable', effort: 'xhigh' });
});

test('explicit model and effort win outright, with no project or router involved', async () => {
  const route = await chooseRoute(null, { agent: 'worker', title: 'x', task: 'y', explicit: { model: 'opus', effort: 'high' } });
  assert.deepEqual(route, { model: 'opus', effort: 'high', reason: 'explicit opus/high' });
});

test('a partial explicit value fills the other half from the router, and is named in the reason', async () => {
  const answerFile = join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-partial-')), 'answer.json');
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: answerFile }, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'partial');
      writeAnswer(answerFile, { model: 'sonnet', effort: 'low', reason: 'small, precise change' });
      const route = await chooseRoute(db, { agent: 'worker', project, title: 'tidy', task: 'tidy imports', explicit: { effort: 'high' } });
      assert.equal(route.model, 'sonnet', 'the missing half came from the router');
      assert.equal(route.effort, 'high', 'the explicit half was kept, not the router\'s');
      assert.match(route.reason, /^explicit effort high; router: small, precise change$/);
    } finally {
      db.close();
    }
  });
});

test('retryOf steps the previous job\'s route up the ladder and says so', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'retry-proj');
      const prevId = insertJob(db, { project: project.slug, model: 'sonnet', effort: 'medium', status: 'failed' });
      const route = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y', retryOf: prevId });
      assert.deepEqual(route, { model: 'sonnet', effort: 'high', reason: `retry: stepped up from j${prevId} sonnet/medium` });
    } finally {
      db.close();
    }
  });
});

test('retryOf beyond the top of the ladder refuses, naming the job', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'top');
      const prevId = insertJob(db, { project: project.slug, model: 'fable', effort: 'xhigh', status: 'failed' });
      await assert.rejects(
        chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y', retryOf: prevId }),
        (err) => /already ran on fable\/xhigh — ask the user/.test(err.message),
      );
    } finally {
      db.close();
    }
  });
});

test('a project rule pins a role to a model, with the latest active one winning', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'ruled');
      memory.add(db, { type: 'decision', project: 'ruled', body: 'worker model sonnet' });
      const first = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
      assert.equal(first.model, 'sonnet');
      assert.match(first.reason, /^project rule m\d+: worker model sonnet$/);

      memory.add(db, { type: 'decision', project: 'ruled', body: 'worker model opus effort xhigh' });
      const latest = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
      assert.deepEqual({ model: latest.model, effort: latest.effort }, { model: 'opus', effort: 'xhigh' });

      // A rule for a different role does not answer for this one.
      assert.equal(projectRule(db, 'ruled', 'scout'), null);
    } finally {
      db.close();
    }
  });
});

test('the router decides when nothing else does, and a failed call falls back to the role default with the error kept', async () => {
  const answerFile = join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-routed-')), 'answer.json');
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: answerFile }, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'routed');
      writeAnswer(answerFile, { model: 'opus', effort: 'high', reason: 'novel bug, needs judgment' });
      const ok = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
      assert.deepEqual(ok, { model: 'opus', effort: 'high', reason: 'router: novel bug, needs judgment' });
    } finally {
      db.close();
    }
  });

  // No STUB_ANSWER file at all: the stand-in itself throws, so the call fails and e answers instead.
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-noanswer-')), 'missing.json') }, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'unrouted');
      const route = await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
      assert.equal(route.model, 'sonnet');
      assert.equal(route.effort, 'medium');
      assert.match(route.reason, /^router failed: [\s\S]*; default: worker sonnet\/medium$/);
    } finally {
      db.close();
    }
  });
});

test('floors: scout is always haiku/none, however it was chosen', async () => {
  const route = await chooseRoute(null, { agent: 'scout', title: 'x', task: 'y', explicit: { model: 'opus', effort: 'high' } });
  assert.deepEqual(route, { model: 'haiku', effort: 'none', reason: 'explicit opus/high; floor: scout' });
});

test('floors: a reviewer never judges below opus/high', async () => {
  const route = await chooseRoute(null, { agent: 'reviewer', title: 'x', task: 'y', explicit: { model: 'sonnet', effort: 'medium' } });
  assert.deepEqual(route, { model: 'opus', effort: 'high', reason: 'explicit sonnet/medium; floor: reviewer' });

  // Already above the floor: left alone.
  const above = await chooseRoute(null, { agent: 'reviewer', title: 'x', task: 'y', explicit: { model: 'fable', effort: 'high' } });
  assert.deepEqual(above, { model: 'fable', effort: 'high', reason: 'explicit fable/high' });
});

test('floors: haiku never carries an effort', async () => {
  const route = await chooseRoute(null, { agent: 'worker', title: 'x', task: 'y', explicit: { model: 'haiku', effort: 'low' } });
  assert.deepEqual(route, { model: 'haiku', effort: 'none', reason: 'explicit haiku/low; floor: haiku effort' });
});

test('floors: security-shaped work never runs below opus/xhigh, for a worker or a reviewer', async () => {
  const worker = await chooseRoute(null, { agent: 'worker', title: 'rotate the API key', task: 'y', explicit: { model: 'sonnet', effort: 'low' } });
  assert.deepEqual(worker, { model: 'opus', effort: 'xhigh', reason: 'explicit sonnet/low; floor: security' });

  const reviewer = await chooseRoute(null, { agent: 'reviewer', title: 'x', task: 'handles the payment webhook', explicit: { model: 'sonnet', effort: 'medium' } });
  assert.match(reviewer.reason, /floor: reviewer, security/);
  assert.deepEqual({ model: reviewer.model, effort: reviewer.effort }, { model: 'opus', effort: 'xhigh' });

  // A scout stays haiku/none even for security work — that floor is scout-only.
  const scout = await chooseRoute(null, { agent: 'scout', title: 'x', task: 'find where the password is checked', explicit: { model: 'sonnet', effort: 'medium' } });
  assert.deepEqual(scout, { model: 'haiku', effort: 'none', reason: 'explicit sonnet/medium; floor: scout' });
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

test('floors raise each axis on its own: a high model never excuses a low effort', async () => {
  const lowEffort = await chooseRoute(null, { agent: 'reviewer', title: 'x', task: 'y', explicit: { model: 'fable', effort: 'low' } });
  assert.deepEqual(lowEffort, { model: 'fable', effort: 'high', reason: 'explicit fable/low; floor: reviewer' });

  // The other way round: the model is raised to the floor and the higher effort is kept.
  const lowModel = await chooseRoute(null, { agent: 'reviewer', title: 'x', task: 'y', explicit: { model: 'sonnet', effort: 'max' } });
  assert.deepEqual(lowModel, { model: 'opus', effort: 'max', reason: 'explicit sonnet/max; floor: reviewer' });

  const secLowEffort = await chooseRoute(null, { agent: 'worker', title: 'rotate the access token', task: 'y', explicit: { model: 'fable', effort: 'low' } });
  assert.deepEqual(secLowEffort, { model: 'fable', effort: 'xhigh', reason: 'explicit fable/low; floor: security' });

  const secLowModel = await chooseRoute(null, { agent: 'worker', title: 'rotate the access token', task: 'y', explicit: { model: 'haiku', effort: 'max' } });
  assert.deepEqual(secLowModel, { model: 'opus', effort: 'max', reason: 'explicit haiku/max; floor: security' });

  // The scout ceiling pins both axes, whichever one is above it.
  const scoutEffort = await chooseRoute(null, { agent: 'scout', title: 'x', task: 'y', explicit: { model: 'haiku', effort: 'max' } });
  assert.deepEqual(scoutEffort, { model: 'haiku', effort: 'none', reason: 'explicit haiku/max; floor: scout' });
  const scoutModel = await chooseRoute(null, { agent: 'scout', title: 'x', task: 'y', explicit: { model: 'fable', effort: 'low' } });
  assert.deepEqual(scoutModel, { model: 'haiku', effort: 'none', reason: 'explicit fable/low; floor: scout' });
});

test('the security floor reads security words, not the ordinary word "tokens"', async () => {
  const counting = await chooseRoute(null, { agent: 'worker', title: 'trim the project card', task: 'keep it under 400 absolute tokens, whatever the window', explicit: { model: 'sonnet', effort: 'low' } });
  assert.deepEqual(counting, { model: 'sonnet', effort: 'low', reason: 'explicit sonnet/low' });

  const credential = await chooseRoute(null, { agent: 'worker', title: 'rotate the access token', task: 'y', explicit: { model: 'sonnet', effort: 'low' } });
  assert.deepEqual(credential, { model: 'opus', effort: 'xhigh', reason: 'explicit sonnet/low; floor: security' });
});
