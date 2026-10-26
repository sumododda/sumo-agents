// What becomes of a job once it closes, without anybody asking: a first attempt that failed is retried one step up,
// risky work done is reviewed, a retry is told what its review found — and how much of a long report the chat's model reads.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODEL_IDS, MODELS } from '../src/catalog.mjs';
import { createChat } from '../src/chat.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { finish, newJob, runFollowed } from '../src/jobs.mjs';
import { runJob, runLines } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseRoute, routePolicy } from '../src/route.mjs';
import { estimateTokens } from '../src/text.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-10-26T12:00:00.000Z';
const TASK = '## Goal\nMake the thing return 2.\n## Check\n`make test` exits 0.\n';
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';
const FINDINGS = '1. src.js:1 — nothing guards the value — add a guard\n2. src.js:1 — no test pins it — add one\n3. src.js:1 — the key is in the code — read it from the environment';
const REVIEW = `## Summary\nIt returns 2, but cannot be trusted as it stands.\n## Asked vs built\nmatches\n## Findings\n${FINDINGS}\n## Minor\nnone\n`;

const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const route = (r) => `${r.model}/${r.effort}`;
const haiku = { model: 'haiku', effort: 'none', reason: 'a quick look' };

/** What the local router answers from now on: a route, and whether it called the work risky. */
const routerSays = (file, model, effort, risky = false) =>
  writeFileSync(file, JSON.stringify({ is_error: false, result: '', structured_output: { kind: 'routine', surface: 'one spot', risky, model, effort, reason: 'stand-in' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));

/** A committed repository whose one check passes while `status` says ok. */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), '.PHONY: test\ntest:\n\t@test "$$(cat status)" = ok\n');
  writeFileSync(join(dir, 'status'), 'ok\n');
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return dir;
}

/** A fresh home with one git project, `simba`, and the router answering from a file: what a job made and run in-process needs. */
async function inHome(router, fn) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-lifecycle-'));
  const routerFile = join(root, 'router.json');
  routerSays(routerFile, ...router);
  const env = { SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log'), SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerFile };
  return withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const dir = gitRepo(join(root, 'simba'));
      addProject(db, dir, { slug: 'simba', now: NOW });
      return await fn({ db, dir, routerFile });
    } finally {
      db.close();
      await closeMcp();
    }
  });
}

// What a job does with its first request, as its `finish` would from its shell; then it ends its turn.
const fails = ({ db, id }) => finish(db, id, { status: 'FAILED', report: '## Summary\nThe check never passed.\n' }, NOW);
/** A worker that changes the thing and closes DONE: the first DONE is the check against the task, the second is verified. */
const succeeds = ({ db, id, dir }, report = REPORT) => {
  writeFileSync(join(dir, 'src.js'), 'export const thing = 2;\n');
  assert.throws(() => finish(db, id, { status: 'DONE', report }, NOW), /is not closed yet/);
  finish(db, id, { status: 'DONE', report }, NOW);
};
const reviews = ({ db, id }) => finish(db, id, { status: 'DONE', report: REVIEW }, NOW);

/**
 * The chat delegates one worker and ends its turn; each job does what `jobs` says for its id when its first request comes.
 * What comes back: the chat's answer to the delegate call, what the screen was given for it, the model each job ran on,
 * the jobs as stored, and the home's job folder. In the background, the answer is the report the job's event carried.
 */
function delegated({ jobs, router = ['sonnet', 'medium', false], config = {}, background = false }) {
  return inHome(router, async ({ db, dir, routerFile }) => {
    for (const [key, value] of Object.entries(config)) setMeta(db, `config.${key}`, value);
    const chat = [reply('tool_use', [call('t1', 'delegate', { agent: 'worker', project: 'simba', title: 'return 2', task: TASK })]), reply('end_turn', [{ type: 'text', text: 'said' }]), reply('end_turn', [{ type: 'text', text: 'read' }])];
    const asked = [];
    const ranOn = {};
    const send = async (params) => {
      const id = Number(/^# Job j(\d+)/.exec(params.messages[0]?.content?.[0]?.text ?? '')?.[1]);
      if (!id) {
        asked.push(structuredClone(params));
        return chat.shift();
      }
      ranOn[id] = params.model;
      await jobs[id]({ db, id, dir, routerFile });
      return reply('end_turn', [{ type: 'text', text: `j${id} closed` }]);
    };
    const watched = [];
    const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, background, watch: (e) => watched.push(e), now: () => NOW });
    session.start('startup');
    await session.say('make the thing return 2');
    let result = watched.find((e) => e.type === 'result' && e.call.name === 'delegate')?.result;
    let event = null;
    if (background) {
      for (let i = 0; i < 500 && !watched.some((e) => e.type === 'job-report'); i++) await new Promise((r) => setTimeout(r, 10));
      ({ result } = watched.find((e) => e.type === 'job-report'));
      assert.deepEqual(session.running(), [], 'every job of the chain has let go of its stop');
      await session.wake();
      event = asked.at(-1).messages.at(-1).content[0].text;
    }
    const rows = db.prepare('SELECT id, agent, status, model, effort, retry_of, risky, important, route_reason FROM jobs ORDER BY id').all().map((r) => ({ ...r }));
    return { answer: result.content, screen: result.job, event, ranOn, rows, jobsDir: paths().jobs };
  });
}

test("a scout's first attempt runs on sonnet at low effort, not haiku, while sonnet is on — and says so", () => {
  assert.deepEqual(routePolicy({ agent: 'scout', routed: haiku, usable: MODELS }), {
    model: 'sonnet',
    effort: 'low',
    policy: "a scout's first attempt starts on sonnet at low effort, not haiku (the router said haiku/none)",
  });
  assert.equal(route(routePolicy({ agent: 'scout', routed: haiku, usable: ['haiku', 'opus'] })), 'haiku/none', 'with sonnet off, haiku stays');
  assert.equal(route(routePolicy({ agent: 'scout', routed: { model: 'opus', effort: 'medium' }, usable: MODELS })), 'opus/medium', 'a scout above haiku is left alone');
  assert.equal(route(routePolicy({ agent: 'worker', routed: haiku, usable: MODELS })), 'haiku/none', 'a worker on haiku is not a scout');
  // A retry goes one step above the attempt that failed, by the retry rule.
  assert.equal(route(routePolicy({ agent: 'scout', routed: haiku, retryOf: { id: 3, model: 'haiku', effort: 'none', status: 'failed', important: null }, usable: MODELS })), 'sonnet/medium');
});

test("the router's word on risky work comes back with the route and is kept with the job", async () => {
  await inHome(['sonnet', 'medium', true], async ({ db, routerFile }) => {
    const project = db.prepare(`SELECT * FROM projects WHERE slug = 'simba'`).get();
    assert.equal((await chooseRoute(db, { agent: 'worker', project, title: 'rotate the key', task: TASK })).risky, true);
    const { job } = await newJob(db, { project: 'simba', title: 'rotate the key', task: TASK, now: NOW });
    assert.equal(job.risky, 1);
    routerSays(routerFile, 'sonnet', 'medium', false);
    assert.equal((await newJob(db, { project: 'simba', title: 'look', agent: 'scout', task: TASK, now: NOW })).job.risky, 0);
    // An answer that says nothing of it is not a yes.
    writeFileSync(routerFile, JSON.stringify({ is_error: false, result: '', structured_output: { model: 'sonnet', effort: 'low', reason: 'small' }, usage: {}, total_cost_usd: 0 }));
    assert.equal((await chooseRoute(db, { agent: 'worker', project, title: 'x', task: TASK })).risky, false);
  });
});

test('jobs.escalate is on or off, on by default; jobs.review is risky, all or off, risky by default', () => {
  const s = sandbox();
  const listed = s.sumo(['config']).out;
  assert.match(listed, /^jobs\.escalate = on$/m);
  assert.match(listed, /^jobs\.review = risky$/m);
  const escalate = s.sumo(['config', 'jobs.escalate', 'maybe']);
  assert.notEqual(escalate.code, 0);
  assert.match(escalate.err, /jobs\.escalate is on or off/);
  const review = s.sumo(['config', 'jobs.review', 'some']);
  assert.notEqual(review.code, 0);
  assert.match(review.err, /jobs\.review is risky, all or off/);
  assert.match(s.sumo(['config', 'jobs.review']).out, /^jobs\.review = risky$/m, 'a refused value is not stored');
  assert.match(s.sumo(['config', 'jobs.escalate', 'off']).out, /^jobs\.escalate = off$/m);
  assert.match(s.sumo(['config', 'jobs.review', 'all']).out, /^jobs\.review = all$/m);
  assert.match(s.sumo(['config', 'jobs.review', 'off']).out, /^jobs\.review = off$/m);
});

test('a first attempt that fails is retried once, one step up, without being asked; the chat is told so, then how the retry went', async () => {
  const r = await delegated({ jobs: { 1: fails, 2: succeeds } });
  assert.match(r.answer, /^j1 failed on sonnet\/medium and was retried on opus\/medium, as j2 — j1's own report: sumo job show 1\nSTATUS: DONE — j2\n/);
  assert.match(r.answer, /## Summary\nThe thing returns 2\./, "the retry's report");
  assert.doesNotMatch(r.answer, /STATUS: FAILED — j1|The check never passed/, 'the attempt that failed is one line; its report is a command away');
  assert.deepEqual(r.ranOn, { 1: MODEL_IDS.sonnet, 2: MODEL_IDS.opus });
  assert.deepEqual(r.rows.map(({ id, status, retry_of, model, effort }) => ({ id, status, retry_of, model, effort })), [
    { id: 1, status: 'failed', retry_of: null, model: 'sonnet', effort: 'medium' },
    { id: 2, status: 'done', retry_of: 1, model: 'opus', effort: 'medium' },
  ]);
  assert.match(r.rows[1].route_reason, /policy: a retry goes above j1's sonnet\/medium, which failed/);
  assert.match(readFileSync(join(r.jobsDir, '2', 'brief.md'), 'utf8'), /## What the previous attempt found\n### Report\n## Summary\nThe check never passed\./);
  assert.equal(r.screen.id, 2, 'the screen shows how the retry went');
  assert.match(r.screen.report, /^j1 failed on sonnet\/medium and was retried on opus\/medium/);
});

test('a retry that fails is not retried again, and with jobs.escalate off a failed attempt is simply reported', async () => {
  const twice = await delegated({ jobs: { 1: fails, 2: fails } });
  assert.match(twice.answer, /^j1 failed on sonnet\/medium and was retried on opus\/medium, as j2 — [^\n]*\nSTATUS: FAILED — j2\n/);
  assert.deepEqual(twice.rows.map((j) => j.id), [1, 2], 'no third attempt');

  const off = await delegated({ jobs: { 1: fails }, config: { 'jobs.escalate': 'off' } });
  assert.match(off.answer, /^STATUS: FAILED — j1\n/);
  assert.doesNotMatch(off.answer, /retried/);
  assert.deepEqual(off.rows.map((j) => j.id), [1]);
});

test('in the background the retry runs under the same call and is stopped with it; its report is one event for both', async () => {
  const r = await delegated({ jobs: { 1: fails, 2: succeeds }, background: true });
  assert.match(r.answer, /^j1 failed on sonnet\/medium and was retried on opus\/medium, as j2 — [^\n]*\nSTATUS: DONE — j2\n/);
  assert.match(r.event, /^<event>\nAn automated event, not a message from the user: j1, j2 have reported\.\nj1 failed on sonnet\/medium and was retried/);
});

test('risky work done and verified is reviewed without being asked, by a reviewer at least as strong, after the worker\'s report', async () => {
  // The router calls the work risky; asked again for the review, it would put it on haiku.
  const work = (ctx) => {
    routerSays(ctx.routerFile, 'haiku', 'none');
    succeeds(ctx);
  };
  const r = await delegated({ router: ['sonnet', 'medium', true], jobs: { 1: work, 2: reviews } });
  assert.match(r.answer, /^STATUS: DONE — j1\n[\s\S]*## Summary\nThe thing returns 2\.[\s\S]*## Verified by code[\s\S]*\n\nThe router called j1's work risky, so j2 reviewed j1 on sonnet\/medium:\nSTATUS: DONE — j2\n/);
  assert.ok(r.answer.includes(`## Findings\n${FINDINGS}`), "the review's own words follow");
  const [worker, reviewer] = r.rows;
  assert.deepEqual([worker.risky, worker.important], [1, 3], 'the review graded the work');
  assert.deepEqual([reviewer.agent, reviewer.status, route(reviewer)], ['reviewer', 'done', 'sonnet/medium']);
  assert.match(reviewer.route_reason, /policy: a reviewer is at least as strong as j1's sonnet; a reviewer runs at medium effort at least \(the router said haiku\/none\)/);
  assert.deepEqual(JSON.parse(readFileSync(join(r.jobsDir, '2', 'reviews.json'), 'utf8')), { reviews: 1 });
  const brief = readFileSync(join(r.jobsDir, '2', 'brief.md'), 'utf8');
  assert.match(brief, /^# Job j2 — return 2 \(review of j1\)/);
  assert.match(brief, /The router called this work risky — it touches security, credentials, money, migrations or concurrency\./);
  assert.match(brief, /## The change to judge\nWhat was asked: .*jobs\/1\/brief\.md/);
  assert.equal(r.screen.id, 1, 'the screen shows the work, with the review under it');
  assert.match(r.screen.report, /The router called j1's work risky, so j2 reviewed j1 on sonnet\/medium:\n## Summary\nIt returns 2, but cannot/);
});

test('work that is not risky is reviewed only with jobs.review all; jobs.review off, or work taken without verification, is not', async () => {
  const plain = await delegated({ jobs: { 1: succeeds } });
  assert.match(plain.answer, /^STATUS: DONE — j1\n/);
  assert.doesNotMatch(plain.answer, /review/);
  assert.deepEqual(plain.rows.map((j) => j.agent), ['worker']);

  const all = await delegated({ jobs: { 1: succeeds, 2: reviews }, config: { 'jobs.review': 'all' } });
  assert.match(all.answer, /\n\njobs\.review is all, so j2 reviewed j1 on sonnet\/medium:\nSTATUS: DONE — j2\n/);
  assert.match(readFileSync(join(all.jobsDir, '2', 'brief.md'), 'utf8'), /Every worker that finishes is reviewed here \(jobs\.review is all\)\./);

  const off = await delegated({ router: ['sonnet', 'medium', true], jobs: { 1: succeeds }, config: { 'jobs.review': 'off' } });
  assert.deepEqual(off.rows.map((j) => j.agent), ['worker']);

  const accepted = ({ db, id }) => finish(db, id, { status: 'DONE', report: REPORT, accept: 'checked by hand' }, NOW);
  const taken = await delegated({ router: ['sonnet', 'medium', true], jobs: { 1: accepted } });
  assert.match(taken.answer, /## Accepted without verification\nchecked by hand/);
  assert.deepEqual(taken.rows.map((j) => j.agent), ['worker'], 'a review is added to the checks; it does not stand in for them');
});

test('a retry of reviewed work is told what the review found, in its words, the head of it when it is long', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = gitRepo(join(s.root, 'proj'));
  s.sumo(['project', 'add', dir, '--alias', 'proj']);
  const close = (id, report, status = 'DONE') => s.sumo(['job', 'finish', String(id), '--status', status], { input: report });
  const review = (findings) => {
    const made = s.sumo(['job', 'new', '--project', 'proj', '--agent', 'reviewer', '--reviews', '1', '--title', 'judge'], { input: 'Judge it.' });
    assert.equal(made.code, 0, made.err);
    const id = /^created j(\d+)/m.exec(made.out)[1];
    assert.equal(close(id, REVIEW.replace(FINDINGS, findings)).code, 0);
  };

  s.sumo(['job', 'new', '--project', 'proj', '--title', 'return 2'], { input: TASK });
  writeFileSync(join(dir, 'src.js'), 'export const thing = 2;\n');
  close(1, REPORT);
  assert.equal(close(1, REPORT).code, 0);
  review(FINDINGS);
  assert.match(s.sumo(['job', 'show', '1']).out, /^important: 3$/m);
  assert.equal(s.sumo(['job', 'retry', '1']).code, 0);
  const brief = s.sumo(['job', 'brief', '3']).out;
  assert.ok(brief.includes(`### What its review, j2, found\n${FINDINGS}\n`), brief);
  assert.match(brief, /### Report\n## Summary\nThe thing returns 2\.[\s\S]*### What its review/, "after the work's own report");

  // The newest review is the one told; a long one is cut, with the way to the rest.
  s.sumo(['job', 'abandon', '3']);
  const long = Array.from({ length: 40 }, (_, i) => `${i + 1}. src.js:1 — finding number ${i + 1}, said at some length — the smallest fix`).join('\n');
  review(long);
  assert.equal(s.sumo(['job', 'retry', '1']).code, 0);
  const cut = s.sumo(['job', 'brief', '5']).out;
  const told = /### What its review, j4, found\n([\s\S]*?)\n\[… the rest of the review: sumo job show 4\]/.exec(cut);
  assert.ok(told, cut);
  assert.ok(told[1].length <= 1500 && long.startsWith(told[1]), 'verbatim, from the top');
  assert.doesNotMatch(cut, /What its review, j2, found/);

  // A failed job nobody reviewed is retried with no such section.
  s.sumo(['job', 'abandon', '5']);
  s.sumo(['job', 'new', '--project', 'proj', '--title', 'other'], { input: TASK });
  close(6, '## Summary\nno.\n', 'FAILED');
  assert.equal(s.sumo(['job', 'retry', '6']).code, 0);
  assert.doesNotMatch(s.sumo(['job', 'brief', '7']).out, /What its review/);
});

test("a long report is cut to about 1,500 tokens for the chat's model, keeping what code added and saying where the rest is; the screen has it whole", async () => {
  const long = `## Summary\nThe thing returns 2.\n## Files changed\n${Array.from({ length: 400 }, (_, i) => `src/part${i}.js — one more line of what changed, at length`).join('\n')}\n## Check\nthe last words of the author\n`;
  const r = await delegated({ jobs: { 1: (ctx) => succeeds(ctx, long) } });
  assert.match(r.answer, /^STATUS: DONE — j1\n[\s\S]*## Summary\nThe thing returns 2\.\n## Files changed\nsrc\/part0\.js/);
  assert.match(r.answer, /\n\[… cut\]\n## Verified by code — not by the author of this report\n[\s\S]*\nThe report is cut to fit; the whole of it: sumo job show 1$/);
  assert.doesNotMatch(r.answer, /the last words of the author/);
  assert.ok(estimateTokens(r.answer) <= 1600, `${estimateTokens(r.answer)} tokens`);
  assert.match(r.screen.report, /the last words of the author/, 'the screen is given the whole report');
});

test('`sumo job run` goes through the same steps: the job, then its retry, each run in turn', async () => {
  await inHome(['sonnet', 'medium', false], async ({ db, dir, routerFile }) => {
    const { job } = await newJob(db, { project: 'simba', title: 'return 2', task: TASK, now: NOW });
    const send = async (params) => {
      const id = Number(/^# Job j(\d+)/.exec(params.messages[0].content[0].text)[1]);
      (id === job.id ? fails : succeeds)({ db, id, dir, routerFile });
      return reply('end_turn', [{ type: 'text', text: `j${id} closed` }]);
    };
    const ran = await runFollowed(db, job.id, async (each) => runLines(await runJob(db, each, { send, now: () => NOW })), { now: () => NOW });
    assert.deepEqual(ran.map((step) => [step.id, step.kind, step.result?.[0]]), [
      [1, null, 'STATUS: FAILED — j1'],
      [2, 'retry', 'STATUS: DONE — j2'],
    ]);
    assert.equal(ran[1].line, "j1 failed on sonnet/medium and was retried on opus/medium, as j2 — j1's own report: sumo job show 1");
  });
});
