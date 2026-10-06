import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

const TASK = '## Goal\nMake the thing return 2.\n## Check\n`make test` exits 0.\n';
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';

/** A committed repository whose one check always passes, so a worker can finish DONE without fuss. */
function gitProject(s) {
  const dir = join(s.root, 'proj-route');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.sumo(['project', 'add', dir, '--alias', 'routeproj']);
  return { dir, write: (file, text) => writeFileSync(join(dir, file), text) };
}

const newWorker = (s, extra = [], route = ['sonnet', 'low']) => {
  s.routerWillSay(...route);
  return s.sumo(['job', 'new', '--project', 'routeproj', '--title', 'return 2', ...extra], { input: TASK });
};

test('a review\'s numbered Findings become the reviewed job\'s "important", visible on show', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);

  s.routerWillSay('opus', 'high');
  s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'The thing must return 2.' });
  // A numbered decoy outside "## Findings" (here, and in "## Minor" below) must not be counted — only what is under the heading itself.
  const reviewReport = `## Summary
1. Mostly right, three things wrong.
## Asked vs built
Matches.
## Findings
1. src.js:1 — the export is not memoized
2. src.js:1 — no test asserts the new value
3. src.js:1 — the old value 1 is not documented anywhere
## Minor
1. src.js:1 — could use a shorter name
## Could not verify
Nothing.
`;
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: reviewReport }).code, 0);

  assert.match(s.sumo(['job', 'show', '1']).out, /^important: 3$/m);
  assert.match(s.sumo(['job', 'show', '1']).out, /^route: sonnet\/low — router: stand-in route$/m);
});

test('a review that finds nothing under "## Findings" stores important: 0', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  s.routerWillSay('opus', 'high');
  s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  const clean = '## Summary\nMatches.\n## Asked vs built\nMatches.\n## Findings\nNone.\n## Minor\nNone.\n## Could not verify\nNothing.\n';
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: clean }).code, 0);
  assert.match(s.sumo(['job', 'show', '1']).out, /^important: 0$/m);
});

test('retry refuses a job that is still running, and one that is done without enough Important findings', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s);
  const runningRetry = s.sumo(['job', 'retry', '1']);
  assert.equal(runningRetry.code, 2);
  assert.match(runningRetry.err, /j1 is running — only a failed job, or a done one reviewed with important >= 3, can be retried/);

  const p = gitProject(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  const notEnough = s.sumo(['job', 'retry', '1']);
  assert.equal(notEnough.code, 2);
  assert.match(notEnough.err, /j1 is done \(important: 0\) — only a failed job/);
});

test('retry asks the router again — no ladder — and carries the old attempt forward', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s);
  s.sumo(['job', 'note', '1'], { input: 'Tried returning 2 directly; the linter complained about an unused import.' });
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'FAILED'], { input: '## Summary\nThe check never passed.\n' }).code, 0);

  s.routerWillSay('opus', 'medium', 'the first attempt failed on lint');
  const retried = s.sumo(['job', 'retry', '1']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(retried.out, /^created j2 \[worker·proj-route·running\] return 2 \(retry of j1\)/);
  assert.match(retried.out, /^route: opus\/medium — router: the first attempt failed on lint$/m);
  assert.match(retried.out, /run it: sumo job run \d+/);
  assert.match(retried.out, /run it: sumo job run 2/);
  assert.equal(s.sql((db) => db.prepare('SELECT retry_of FROM jobs WHERE id = 2').get().retry_of), 1);
  // The router is told what it is retrying, or it would hand back the route that just failed.
  const shown = s.modelWasShown().prompt;
  assert.match(shown, /^retry of j1: it ran on sonnet\/low and failed$/m);
  assert.match(shown, /^sonnet\/low: 1 job, 0 done, 1 failed, 0 reviewed$/m);

  const brief = s.sumo(['job', 'brief', '2']).out;
  assert.match(brief, /^## Goal\nMake the thing return 2\./m);
  assert.match(brief, /## What the previous attempt found\n### Notes\n[\s\S]*Tried returning 2 directly/);
  assert.match(brief, /### Report\n## Summary\nThe check never passed\./);
});

test('a router that fails stops job new and retry cold: exit non-zero, no job created', () => {
  const s = sandbox();
  gitProject(s);
  const refused = s.sumo(['job', 'new', '--project', 'routeproj', '--title', 'return 2'], { input: TASK });
  assert.notEqual(refused.code, 0);
  assert.match(refused.err, /the router failed: /);
  assert.equal(refused.out, '');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n), 0);

  newWorker(s);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'FAILED'], { input: '## Summary\nno.\n' }).code, 0);
  s.routerWillSay(null);
  const noRetry = s.sumo(['job', 'retry', '1']);
  assert.notEqual(noRetry.code, 0);
  assert.match(noRetry.err, /the router failed: /);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n), 1);
});

test('--model and --effort are gone: the router is the only one who picks', () => {
  const s = sandbox();
  gitProject(s);
  s.routerWillSay('sonnet', 'low');
  for (const flag of [['--model', 'opus'], ['--effort', 'high']]) {
    const run = s.sumo(['job', 'new', '--project', 'routeproj', '--title', 'return 2', ...flag], { input: TASK });
    assert.equal(run.code, 2);
    assert.match(run.err, new RegExp(`unknown option ${flag[0]}`));
  }
});

test('sumo job stats groups finished jobs by model and effort', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s, ['--title', 'a']);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  newWorker(s, ['--title', 'b'], ['opus', 'high']);
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nno.\n' }).code, 0);

  const lines = s.sumo(['job', 'stats', '--project', 'routeproj']).out.trim().split('\n');
  assert.deepEqual(lines, ['opus/high: 1 job, 0 done, 1 failed, 0 reviewed, avg - important', 'sonnet/low: 1 job, 1 done, 0 failed, 0 reviewed, avg - important']);

  assert.match(s.sumo(['job', 'stats', '--project', 'nope']).err, /unknown project/);
  // No --project: the same two lines, since this sandbox has only the one project.
  assert.deepEqual(s.sumo(['job', 'stats']).out.trim().split('\n'), lines);
});

/** A review this project really received, kept as a fixture so the count is judged on the house format. */
const realReview = (name) => readFileSync(join(REPO_ROOT, 'test', 'fixtures', name), 'utf8');

test("reviews written in this project's own format are counted: j23 scores 3 and j26 scores 4", () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);

  // j23's findings are unnumbered paragraphs that open with <file:line>; j26's are a numbered list.
  s.routerWillSay('opus', 'high');
  s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: realReview('review-j23.md') }).code, 0);
  assert.match(s.sumo(['job', 'show', '1']).out, /^important: 3$/m);

  s.routerWillSay('opus', 'high');
  s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1 again'], { input: 'x' });
  assert.equal(s.sumo(['job', 'finish', '3', '--status', 'DONE'], { input: realReview('review-j26.md') }).code, 0);
  assert.match(s.sumo(['job', 'show', '1']).out, /^important: 4$/m);
});

test('the reviewer brief asks for findings as a numbered list', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  s.routerWillSay('opus', 'high');
  s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  assert.match(s.sumo(['job', 'brief', '2']).out, /## Findings\s+numbered, worst first: `1\. <file:line> —/);
});

test('a retried reviewer still reviews the job the original was pointed at', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  s.routerWillSay('opus', 'high');
  assert.equal(s.sumo(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' }).code, 0);
  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nRan out of context.\n' }).code, 0);

  const retried = s.sumo(['job', 'retry', '2']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(s.modelWasShown().prompt, /^retry of j2: it ran on opus\/high and failed$/m);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'jobs', '3', 'reviews.json'), 'utf8')), { reviews: 1 });
  assert.match(s.sumo(['job', 'brief', '3']).out, /What was asked: .*jobs\/1\/brief\.md/);
});

test('an effort of none names the plain role sub-agent, never worker-none', () => {
  const s = sandbox();
  gitProject(s);
  s.routerWillSay('haiku', 'none');
  const created = s.sumo(['job', 'new', '--project', 'routeproj', '--title', 'return 2'], { input: TASK });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /^route: haiku\/none/m);
  assert.match(created.out, /run it: sumo job run \d+/);
});
