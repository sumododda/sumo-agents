// The route policy: what code does to the router's answer before it is a job's route — a first attempt starts lower,
// a retry goes up, a reviewer is never weaker than the work it judges.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODELS, setModel } from '../src/catalog.mjs';
import { openDb } from '../src/db.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseRoute, routePolicy } from '../src/route.mjs';
import { CONFIG_DEFAULTS } from '../src/setup.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const ALL = MODELS;
const route = (r) => `${r.model}/${r.effort}`;
const routed = (model, effort, reason = 'stand-in') => ({ model, effort, reason });
const job = (id, model, effort, status = 'failed', important = null) => ({ id, model, effort, status, important });

test('a worker\'s first attempt starts on opus, not fable, keeping its effort — unless opus is off', () => {
  const capped = routePolicy({ agent: 'worker', routed: routed('fable', 'high'), usable: ALL });
  assert.equal(route(capped), 'opus/high');
  assert.equal(capped.policy, 'a first attempt starts on opus, not fable (the router said fable/high)');

  // With opus off, fable is the only model above sonnet: it stays.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('fable', 'medium'), usable: ['haiku', 'sonnet', 'fable'] })), 'fable/medium');
  // A scout or a reviewer is not a worker: its first attempt may be on fable.
  assert.equal(route(routePolicy({ agent: 'scout', routed: routed('fable', 'high'), usable: ALL })), 'fable/high');
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('fable', 'low'), usable: ALL })), 'fable/low');
});

test('no first attempt runs above high effort; a retry may', () => {
  for (const agent of ['worker', 'scout', 'reviewer']) {
    for (const effort of ['xhigh', 'max']) {
      const r = routePolicy({ agent, routed: routed('opus', effort), usable: ALL });
      assert.equal(route(r), 'opus/high', `${agent} ${effort}`);
      assert.equal(r.policy, `a first attempt runs at high effort at most (the router said opus/${effort})`);
    }
  }
  const both = routePolicy({ agent: 'worker', routed: routed('fable', 'max'), usable: ALL });
  assert.equal(route(both), 'opus/high');
  assert.equal(both.policy, 'a first attempt starts on opus, not fable; a first attempt runs at high effort at most (the router said fable/max)');

  const retried = routePolicy({ agent: 'worker', routed: routed('opus', 'xhigh'), retryOf: job(4, 'sonnet', 'high'), usable: ALL });
  assert.equal(route(retried), 'opus/xhigh');
  assert.equal(retried.policy, null, 'the router already went above the attempt that failed');
});

test('what the policy leaves alone it says nothing about', () => {
  for (const [model, effort] of [['haiku', 'none'], ['sonnet', 'low'], ['opus', 'high']]) {
    const r = routePolicy({ agent: 'worker', routed: routed(model, effort), usable: ALL });
    assert.deepEqual(r, { model, effort, policy: null });
  }
});

test('a retry of a job that failed runs at least one step above it: the next model up that is on, keeping the effort', () => {
  const up = routePolicy({ agent: 'worker', routed: routed('sonnet', 'low'), retryOf: job(3, 'sonnet', 'low'), usable: ALL });
  assert.equal(route(up), 'opus/low');
  assert.equal(up.policy, "a retry goes above j3's sonnet/low, which failed (the router said sonnet/low)");

  // Off haiku there is an effort to pick: medium.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('haiku', 'none'), retryOf: job(3, 'haiku', 'none'), usable: ALL })), 'sonnet/medium');
  // A model that is off is stepped over.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('sonnet', 'medium'), retryOf: job(3, 'sonnet', 'medium'), usable: ['haiku', 'sonnet', 'fable'] })), 'fable/medium');
  // A retry is where fable is for: the first-attempt cap does not apply.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('opus', 'high'), retryOf: job(3, 'opus', 'high'), usable: ALL })), 'fable/high');
});

test('on the top model that is on, a retry goes one effort up, max at most', () => {
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('opus', 'medium'), retryOf: job(3, 'fable', 'high'), usable: ALL })), 'fable/xhigh');
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('fable', 'low'), retryOf: job(3, 'fable', 'max'), usable: ALL })), 'fable/max');
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('sonnet', 'low'), retryOf: job(3, 'opus', 'high'), usable: ['haiku', 'sonnet', 'opus'] })), 'opus/xhigh');
  // Only haiku on: there is nowhere to go.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('haiku', 'none'), retryOf: job(3, 'haiku', 'none'), usable: ['haiku'] })), 'haiku/none');
});

test('a retry is never below what the router answered, and goes up only after something went wrong', () => {
  // The router went higher than one step: its answer stands.
  assert.deepEqual(routePolicy({ agent: 'worker', routed: routed('fable', 'medium'), retryOf: job(3, 'sonnet', 'high'), usable: ALL }), { model: 'fable', effort: 'medium', policy: null });
  assert.deepEqual(routePolicy({ agent: 'worker', routed: routed('opus', 'medium'), retryOf: job(3, 'sonnet', 'low'), usable: ALL }), { model: 'opus', effort: 'medium', policy: null });

  // Done, but a review found enough wrong with it: up.
  const reviewed = routePolicy({ agent: 'worker', routed: routed('sonnet', 'medium'), retryOf: job(5, 'sonnet', 'medium', 'done', 3), usable: ALL });
  assert.equal(route(reviewed), 'opus/medium');
  assert.equal(reviewed.policy, "a retry goes above j5's sonnet/medium, which drew 3 Important findings (the router said sonnet/medium)");
  // Done with fewer findings than a retry needs: no floor.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('sonnet', 'medium'), retryOf: job(5, 'sonnet', 'medium', 'done', 2), usable: ALL })), 'sonnet/medium');
  // An attempt with no recorded route has nothing to go above.
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('sonnet', 'low'), retryOf: job(5, null, null), usable: ALL })), 'sonnet/low');
  assert.equal(route(routePolicy({ agent: 'worker', routed: routed('sonnet', 'low'), retryOf: job(5, 'claude-opus-4', 'high'), usable: ALL })), 'sonnet/low');
});

test('a reviewer of a job runs on at least that job\'s model, at medium effort or more', () => {
  const raised = routePolicy({ agent: 'reviewer', routed: routed('sonnet', 'low'), reviews: job(1, 'opus', 'high', 'done'), usable: ALL });
  assert.equal(route(raised), 'opus/medium');
  assert.equal(raised.policy, "a reviewer is at least as strong as j1's opus; a reviewer runs at medium effort at least (the router said sonnet/low)");

  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('haiku', 'none'), reviews: job(1, 'sonnet', 'low', 'done'), usable: ALL })), 'sonnet/medium');
  assert.deepEqual(routePolicy({ agent: 'reviewer', routed: routed('opus', 'high'), reviews: job(1, 'sonnet', 'low', 'done'), usable: ALL }), { model: 'opus', effort: 'high', policy: null });
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('fable', 'low'), reviews: job(1, 'opus', 'high', 'done'), usable: ALL })), 'fable/medium');
  // The work ran on fable: so does its review, first attempt or not.
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('opus', 'high'), reviews: job(1, 'fable', 'high', 'done'), usable: ALL })), 'fable/high');
  // A model that is off now: the nearest one that is on, above it if there is one, else the top one.
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('sonnet', 'medium'), reviews: job(1, 'opus', 'high', 'done'), usable: ['haiku', 'sonnet', 'fable'] })), 'fable/medium');
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('sonnet', 'medium'), reviews: job(1, 'fable', 'high', 'done'), usable: ['haiku', 'sonnet', 'opus'] })), 'opus/medium');
  // Haiku judging haiku: there is no effort to raise.
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('haiku', 'none'), reviews: job(1, 'haiku', 'none', 'done'), usable: ALL })), 'haiku/none');
  // A reviewer pointed at no job (the uncommitted change) is the router's answer.
  assert.equal(route(routePolicy({ agent: 'reviewer', routed: routed('sonnet', 'low'), usable: ALL })), 'sonnet/low');
});

/** A registered project and the router stand-in answering `answer`, for chooseRoute in-process. */
async function withRouter(answer, fn) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-route-policy-'));
  const answerFile = join(dir, 'answer.json');
  writeFileSync(answerFile, JSON.stringify({ is_error: false, result: '', structured_output: answer, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  return withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ANSWER: answerFile }, async () => {
    const db = openDb();
    try {
      return await fn(db, addProject(db, dir, { slug: 'policy' }).project);
    } finally {
      db.close();
    }
  });
}

const insertJob = (db, { agent = 'worker', status, model, effort, important = null }) =>
  Number(
    db
      .prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort, important) VALUES ('policy', 'x', ?, ?, ?, ?, ?, ?, ?)`)
      .run(agent, status, '2026-10-05T12:00:00.000Z', '2026-10-05T12:00:00.000Z', model, effort, important).lastInsertRowid,
  );

test('chooseRoute applies the policy to the router\'s answer and says why after the router\'s reason', async () => {
  await withRouter({ model: 'fable', effort: 'xhigh', reason: 'novel algorithm' }, async (db, project) => {
    assert.deepEqual(await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), {
      model: 'opus',
      effort: 'high',
      reason: 'router: novel algorithm; policy: a first attempt starts on opus, not fable; a first attempt runs at high effort at most (the router said fable/xhigh)',
      risky: false,
    });
    setModel(db, 'opus', false, '2026-10-05T12:00:00.000Z');
    assert.equal(route(await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' })), 'fable/high');
  });
  await withRouter({ model: 'sonnet', effort: 'low', reason: 'small' }, async (db, project) => {
    const failed = insertJob(db, { status: 'failed', model: 'sonnet', effort: 'low' });
    assert.deepEqual(await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y', retryOf: failed }), {
      model: 'opus',
      effort: 'low',
      reason: `router: small; policy: a retry goes above j${failed}'s sonnet/low, which failed (the router said sonnet/low)`,
      risky: false,
    });
    const work = insertJob(db, { status: 'done', model: 'opus', effort: 'high' });
    assert.equal(route(await chooseRoute(db, { agent: 'reviewer', project, title: 'x', task: 'y', reviews: work })), 'opus/medium');
    assert.deepEqual(await chooseRoute(db, { agent: 'worker', project, title: 'x', task: 'y' }), { model: 'sonnet', effort: 'low', reason: 'router: small', risky: false });
  });
});

const TASK = '## Goal\nMake the thing return 2.\n## Check\n`make test` exits 0.\n';
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';

/** A committed repository whose one check always passes, so a worker can finish DONE without fuss. */
function gitProject(s) {
  const dir = join(s.root, 'proj-policy');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.sumo(['project', 'add', dir, '--alias', 'policyproj']);
  return { write: (file, text) => writeFileSync(join(dir, file), text) };
}

test('sumo job retry goes above the attempt that failed, and a reviewer with --reviews is raised to the work it judges', () => {
  const s = sandbox();
  const p = gitProject(s);
  s.routerWillSay('sonnet', 'low');
  assert.equal(s.sumo(['job', 'new', '--project', 'policyproj', '--title', 'return 2'], { input: TASK }).code, 0);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'FAILED'], { input: '## Summary\nThe check never passed.\n' }).code, 0);

  // The router hands back the very route that just failed.
  const retried = s.sumo(['job', 'retry', '1']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(retried.out, /^route: opus\/low — router: stand-in route; policy: a retry goes above j1's sonnet\/low, which failed \(the router said sonnet\/low\)$/m);

  p.write('src.js', 'export const thing = 2;\n');
  assert.match(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: REPORT }).err, /j2 is not closed yet/, 'the first DONE is the check against the task');
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: REPORT }).code, 0);
  const review = s.sumo(['job', 'new', '--project', 'policyproj', '--agent', 'reviewer', '--reviews', 'j2', '--title', 'review j2'], { input: 'The thing must return 2.' });
  assert.equal(review.code, 0, review.err);
  assert.match(review.out, /^route: opus\/medium — router: stand-in route; policy: a reviewer is at least as strong as j2's opus; a reviewer runs at medium effort at least \(the router said sonnet\/low\)$/m);
});

test('the chat\'s default effort is medium', () => {
  assert.equal(CONFIG_DEFAULTS['chat.effort'], 'medium');
  assert.match(sandbox().sumo(['config', 'chat.effort']).out, /^chat\.effort = medium$/m);
});
