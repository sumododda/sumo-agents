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
  s.mem(['project', 'add', dir, '--alias', 'routeproj']);
  return { dir, write: (file, text) => writeFileSync(join(dir, file), text) };
}

const newWorker = (s, extra = []) => s.mem(['job', 'new', '--project', 'routeproj', '--title', 'return 2', '--model', 'sonnet', '--effort', 'low', ...extra], { input: TASK });

test('a review\'s numbered Findings become the reviewed job\'s "important", visible on show', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);

  s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'The thing must return 2.' });
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
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'DONE'], { input: reviewReport }).code, 0);

  assert.match(s.mem(['job', 'show', '1']).out, /^important: 3$/m);
  assert.match(s.mem(['job', 'show', '1']).out, /^route: sonnet\/low — explicit sonnet\/low$/m);
});

test('a review that finds nothing under "## Findings" stores important: 0', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  const clean = '## Summary\nMatches.\n## Asked vs built\nMatches.\n## Findings\nNone.\n## Minor\nNone.\n## Could not verify\nNothing.\n';
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'DONE'], { input: clean }).code, 0);
  assert.match(s.mem(['job', 'show', '1']).out, /^important: 0$/m);
});

test('retry refuses a job that is still running, and one that is done without enough Important findings', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s);
  const runningRetry = s.mem(['job', 'retry', '1']);
  assert.equal(runningRetry.code, 2);
  assert.match(runningRetry.err, /j1 is running — only a failed job, or a done one reviewed with important >= 3, can be retried/);

  const p = gitProject(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  const notEnough = s.mem(['job', 'retry', '1']);
  assert.equal(notEnough.code, 2);
  assert.match(notEnough.err, /j1 is done \(important: 0\) — only a failed job/);
});

test('retry steps a failed job\'s route up the ladder, carries the old attempt forward, and refuses once there is nowhere left to go', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s);
  s.mem(['job', 'note', '1'], { input: 'Tried returning 2 directly; the linter complained about an unused import.' });
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'FAILED'], { input: '## Summary\nThe check never passed.\n' }).code, 0);

  const retried = s.mem(['job', 'retry', '1']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(retried.out, /^created j2 \[worker·proj-route·running\] return 2 \(retry of j1\)/);
  assert.match(retried.out, /^route: sonnet\/medium — retry: stepped up from j1 sonnet\/low$/m);
  assert.match(retried.out, /start it with the worker-medium sub-agent and exactly this prompt:/);
  assert.match(retried.out, /JOB: run `mem job brief 2` and follow it exactly\./);

  const brief = s.mem(['job', 'brief', '2']).out;
  assert.match(brief, /^## Goal\nMake the thing return 2\./m);
  assert.match(brief, /## What the previous attempt found\n### Notes\n[\s\S]*Tried returning 2 directly/);
  assert.match(brief, /### Report\n## Summary\nThe check never passed\./);

  // Fail it again from the top of the ladder — nowhere left to step up to.
  s.sql((db) => db.prepare("UPDATE jobs SET model = 'fable', effort = 'xhigh' WHERE id = 2").run());
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nStill fails.\n' }).code, 0);
  const stuck = s.mem(['job', 'retry', '2']);
  assert.equal(stuck.code, 2, stuck.err);
  assert.match(stuck.err, /j2 already ran on fable\/xhigh — ask the user/);
});

test('mem job stats groups finished jobs by model and effort', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s, ['--title', 'a']);
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  newWorker(s, ['--title', 'b', '--model', 'opus', '--effort', 'high']);
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nno.\n' }).code, 0);

  const lines = s.mem(['job', 'stats', '--project', 'routeproj']).out.trim().split('\n');
  assert.deepEqual(lines, ['opus/high: 1 jobs, 0 done, 1 failed, 0 reviewed, avg - important', 'sonnet/low: 1 jobs, 1 done, 0 failed, 0 reviewed, avg - important']);

  assert.match(s.mem(['job', 'stats', '--project', 'nope']).err, /unknown project/);
  // No --project: the same two lines, since this sandbox has only the one project.
  assert.deepEqual(s.mem(['job', 'stats']).out.trim().split('\n'), lines);
});

/** A review this project really received, kept as a fixture so the count is judged on the house format. */
const realReview = (name) => readFileSync(join(REPO_ROOT, 'test', 'fixtures', name), 'utf8');

test("reviews written in this project's own format are counted: j23 scores 3 and j26 scores 4", () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);

  // j23's findings are unnumbered paragraphs that open with <file:line>; j26's are a numbered list.
  s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'DONE'], { input: realReview('review-j23.md') }).code, 0);
  assert.match(s.mem(['job', 'show', '1']).out, /^important: 3$/m);

  s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1 again'], { input: 'x' });
  assert.equal(s.mem(['job', 'finish', '3', '--status', 'DONE'], { input: realReview('review-j26.md') }).code, 0);
  assert.match(s.mem(['job', 'show', '1']).out, /^important: 4$/m);
});

test('the reviewer brief asks for findings as a numbered list', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' });
  assert.match(s.mem(['job', 'brief', '2']).out, /## Findings\s+numbered, worst first: `1\. <file:line> —/);
});

test('a retried reviewer still reviews the job the original was pointed at', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT }).code, 0);
  assert.equal(s.mem(['job', 'new', '--project', 'routeproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'x' }).code, 0);
  assert.equal(s.mem(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nRan out of context.\n' }).code, 0);

  const retried = s.mem(['job', 'retry', '2']);
  assert.equal(retried.code, 0, retried.err);
  assert.deepEqual(JSON.parse(readFileSync(join(s.home, 'jobs', '3', 'reviews.json'), 'utf8')), { reviews: 1 });
  assert.match(s.mem(['job', 'brief', '3']).out, /What was asked: .*jobs\/1\/brief\.md/);
});

test('an effort of none names the plain role sub-agent, never worker-none', () => {
  const s = sandbox();
  gitProject(s);
  const created = s.mem(['job', 'new', '--project', 'routeproj', '--title', 'return 2', '--model', 'haiku'], { input: TASK });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /^route: haiku\/none/m);
  assert.match(created.out, /start it with the worker sub-agent/);
});
