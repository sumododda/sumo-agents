import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import * as memory from '../src/memory.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { MODELS, setModel } from '../src/catalog.mjs';
import { chooseChatRoute, chooseRoute, routeStats, statsLines } from '../src/route.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const STAND_IN = join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs');
const NOW = '2026-10-05T12:00:00.000Z';

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

test('a scout is routed like every job: what the router says is what it runs on', async () => {
  await withRouter({ model: 'opus', effort: 'high', reason: 'deep trace' }, async (db, project) => {
    assert.deepEqual(await chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' }), { model: 'opus', effort: 'high', reason: 'router: deep trace' });
  });
  await withRouter({ model: 'haiku', effort: 'none', reason: 'a quick look' }, async (db, project) => {
    assert.deepEqual(await chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' }), { model: 'haiku', effort: 'none', reason: 'router: a quick look' });
  });
  await withRouter(undefined, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' }), /the router failed/);
  });
});

test('an effort that does not fit the model is outside the schema: haiku takes none, the others need one', async () => {
  await withRouter({ model: 'haiku', effort: 'low', reason: 'x' }, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /the router failed: the router answered outside its schema/);
  });
  // No effort would silently run the plain role sub-agent on whatever effort the session has.
  await withRouter({ model: 'sonnet', effort: 'none', reason: 'x' }, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /the router failed: the router answered outside its schema/);
  });
  await withRouter({ model: 'haiku', effort: 'none', reason: 'mechanical' }, async (db, project) => {
    assert.deepEqual(await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), { model: 'haiku', effort: 'none', reason: 'router: mechanical' });
  });
});

test('the schema the router answers under pairs haiku with no effort, and every other model with a real one', async () => {
  const capture = join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-capture-')), 'saw.json');
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'x' }, async (db, project) => {
    process.env.STUB_CAPTURE = capture;
    try {
      await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    } finally {
      delete process.env.STUB_CAPTURE;
    }
  });
  const { schema } = JSON.parse(readFileSync(capture, 'utf8'));
  const pairs = schema.anyOf.map((branch) => [branch.properties.model.enum, branch.properties.effort.enum]);
  assert.deepEqual(pairs, [
    [['haiku'], ['none']],
    [['sonnet', 'opus', 'fable'], ['low', 'medium', 'high', 'xhigh', 'max']],
  ]);
});

test('the router describes the job before it picks: kind, surface and risky come ahead of the model in every answer', async () => {
  const capture = join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-capture-')), 'saw.json');
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'x' }, async (db, project) => {
    process.env.STUB_CAPTURE = capture;
    try {
      await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    } finally {
      delete process.env.STUB_CAPTURE;
    }
  });
  const { schema } = JSON.parse(readFileSync(capture, 'utf8'));
  for (const branch of schema.anyOf) {
    assert.deepEqual(Object.keys(branch.properties), ['kind', 'surface', 'risky', 'model', 'effort', 'reason']);
    assert.deepEqual(branch.required, Object.keys(branch.properties));
  }
});

test('a reason is one line of text: missing is outside the schema, a newline is folded', async () => {
  await withRouter({ model: 'sonnet', effort: 'low' }, async (db, project) => {
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /outside its schema/);
  });
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'small\n  and precise' }, async (db, project) => {
    assert.equal((await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' })).reason, 'router: small and precise');
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
        'opus/high: 1 job, 1 done, 0 failed, 1 reviewed, avg 1.0 important',
        'sonnet/medium: 3 jobs, 2 done, 1 failed, 1 reviewed, avg 2.0 important',
      ]);

      assert.deepEqual(statsLines(db, { project: 'no-such-project' }), ['no finished jobs yet']);
    } finally {
      db.close();
    }
  });
});

test('the router is shown only evidence against a route: a clean record never, a failure or Important findings always', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-route-'));
  const answerFile = join(dir, 'answer.json');
  const capture = join(dir, 'shown.json');
  writeAnswer(answerFile, { model: 'sonnet', effort: 'medium', reason: 'routine' });
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: answerFile, STUB_CAPTURE: capture }, async () => {
    const db = openDb();
    try {
      const project = makeProject(db, 'evidence');
      const shown = async () => {
        await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
        return JSON.parse(readFileSync(capture, 'utf8')).prompt;
      };

      // Five clean jobs on the dearest route say nothing about what a cheaper one would have done.
      for (let i = 0; i < 5; i++) insertJob(db, { project: project.slug, status: 'done', model: 'opus', effort: 'xhigh', important: i === 0 ? 0 : null });
      insertJob(db, { project: project.slug, status: 'done', model: 'haiku', effort: 'none', important: null });
      const clean = await shown();
      assert.doesNotMatch(clean, /opus\/xhigh|haiku\/none/);
      assert.match(clean, /^history:\nno history yet$/m);

      insertJob(db, { project: project.slug, status: 'failed', model: 'sonnet', effort: 'medium' });
      insertJob(db, { project: project.slug, status: 'done', model: 'sonnet', effort: 'medium', important: 2 });
      const against = await shown();
      assert.match(against, /^history:\nsonnet\/medium: 2 jobs, 1 done, 1 failed, 1 reviewed, avg 2\.0 Important findings$/m);
      assert.doesNotMatch(against, /opus\/xhigh|haiku\/none/);
    } finally {
      db.close();
    }
  });
});

function writeAnswer(file, data) {
  writeFileSync(file, JSON.stringify({ is_error: false, result: '', structured_output: data, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 }));
}

test('a model that is off is outside the router\'s grammar and prompt; an answer naming it is refused; with none on there is nothing to ask', async () => {
  const capture = join(mkdtempSync(join(tmpdir(), 'sumo-agents-route-capture-')), 'saw.json');
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'x' }, async (db, project) => {
    setModel(db, 'fable', false, NOW);
    setModel(db, 'haiku', false, NOW);
    process.env.STUB_CAPTURE = capture;
    try {
      await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' });
    } finally {
      delete process.env.STUB_CAPTURE;
    }
    const { schema, prompt } = JSON.parse(readFileSync(capture, 'utf8'));
    assert.deepEqual(schema.anyOf.map((branch) => branch.properties.model.enum), [['sonnet', 'opus']], 'no haiku branch, no fable');
    assert.match(prompt, /^models: sonnet, opus$/m, 'the router is told which models are on');
  });
  await withRouter({ model: 'fable', effort: 'high', reason: 'x' }, async (db, project) => {
    setModel(db, 'fable', false, NOW);
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), /the router failed: the router answered outside its schema/);
  });
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'x' }, async (db, project) => {
    for (const model of MODELS) setModel(db, model, false, NOW);
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), (err) => err instanceof memory.UsageError && /^no model is on — sumo models enable <name>/.test(err.message));
    await assert.rejects(chooseChatRoute(db, { project, text: 'hi' }), (err) => err instanceof memory.UsageError && /^no model is on/.test(err.message));
  });
});

test('a model that is off is never a job\'s route: the router is not offered it, and an answer naming it is refused', async () => {
  await withRouter({ model: 'haiku', effort: 'none', reason: 'a quick look' }, async (db, project) => {
    setModel(db, 'haiku', false, NOW);
    await assert.rejects(chooseRoute(db, { agent: 'scout', project, title: 'x', task: 'y' }), /the router failed: the router answered outside its schema/);
  });
});
