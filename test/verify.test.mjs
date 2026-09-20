import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const TASK = `## Goal
Make the thing return 2.
## Check
\`make test\` exits 0.
`;

const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';

/**
 * A committed repository whose one check passes or fails on the content of a
 * file, so a test can break and mend the project the way a worker would.
 */
function gitProject(s, { status = 'ok' } = {}) {
  const dir = join(s.root, 'proj-git');
  mkdirSync(join(dir, 'test'), { recursive: true });
  // .PHONY, or make sees the test/ directory, calls the target up to date and runs nothing.
  writeFileSync(join(dir, 'Makefile'), '.PHONY: test\ntest:\n\t@test "$$(cat status)" = ok\n');
  writeFileSync(join(dir, 'status'), `${status}\n`);
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  writeFileSync(join(dir, 'test', 'thing.test.js'), '// asserts the thing is 1\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.mem(['project', 'add', dir, '--alias', 'gitproj']);
  return { dir, git, write: (file, text) => writeFileSync(join(dir, file), text) };
}

const newWorker = (s, extra = []) => s.mem(['job', 'new', '--project', 'gitproj', '--title', 'return 2', ...extra], { input: TASK });
const finish = (s, id = '1', extra = []) => s.mem(['job', 'finish', id, '--status', 'DONE', ...extra], { input: REPORT });

test("a worker's DONE rests on what the project's checks say, not on what its report says", () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  assert.match(s.mem(['job', 'brief', '1']).out, /Before you edit anything: `mem job baseline 1`/);
  assert.match(s.mem(['job', 'baseline', '1']).out, /^`make test` passes/);

  p.write('src.js', 'export const thing = 2;\n');
  p.write('status', 'broken\n');
  assert.match(s.mem(['job', 'verify', '1']).out, /^j1 would be REFUSED as DONE:\n {2}`make test` FAILED/);

  const refused = finish(s);
  assert.equal(refused.code, 2, 'a report that says "ok" does not make it so');
  assert.match(refused.err, /j1 is not done — the project's checks were run, and:/);
  assert.match(refused.err, /`make test` fails, and it passed when this job began — read .*verify-test\.txt/);
  assert.match(refused.err, /mem job finish 1 --status FAILED, or ask: mem job ask 1/, 'there is always an honest way out');
  assert.match(s.mem(['job', 'list']).out, /j1 \[worker·proj-git·running\]/, 'a refused job is still open');

  p.write('status', 'ok\n');
  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1$/m, 'a plain DONE from a worker now means the checks agreed');
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /## Verified by code — not by the author of this report\n- `make test` passed/);
});

test('what already failed is not blamed on the job — and without a baseline, nothing can hide behind "it was already broken"', () => {
  const s = sandbox();
  gitProject(s, { status: 'broken' });
  newWorker(s);
  assert.match(s.mem(['job', 'baseline', '1']).out, /^`make test` ALREADY FAILS — not yours to fix/);
  assert.match(s.mem(['job', 'brief', '1']).out, /## Already failing before this job began — not yours to fix, and not to be made worse\n- `make test`/);

  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /`make test` was already failing/);

  newWorker(s);
  const blamed = finish(s, '2');
  assert.equal(blamed.code, 2);
  assert.match(blamed.err, /no baseline was taken before the work, so the failure counts as this job's/);
});

test('a baseline taken after the first edit is refused, because it would call the job\'s own breakage "already there"', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('status', 'broken\n');
  assert.match(s.mem(['job', 'baseline', '1']).out, /^no baseline taken: files have already changed since this job began/);
  assert.equal(finish(s).code, 2);
});

test('tests that were already here judge the change and are not part of it; new tests are welcome', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('test/new.test.js', '// asserts the thing is 2\n');
  assert.match(s.mem(['job', 'verify', '1']).out, /^j1 would be accepted as DONE:/, 'adding a test is not touching one');

  p.write('test/thing.test.js', '// asserts nothing\n');
  const refused = finish(s);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /tests that were already here were changed: test\/thing\.test\.js .* If one is genuinely wrong, say why: mem job ask/);

  // The main agent can say up front that this task is allowed to.
  newWorker(s, ['--tests-may-change']);
  assert.match(s.mem(['job', 'brief', '2']).out, /This task may change them — say in the report which, and why\./);
  assert.equal(finish(s, '2').code, 0);
});

test('a line that tells a checker to look away is put in front of a person, not silently accepted', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n// eslint-disable-next-line no-undef\nthing2 = 3;\n');
  p.write('extra.py', 'import os  # noqa\n');
  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1\n {2}look at: added lines tell a checker to look away \(skip, ignore, disable\): src\.js:2, extra\.py:1/);
});

test('a key or token in the change blocks DONE; a credential-looking assignment is put in front of a person', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\nconst gh = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";\n');
  const refused = finish(s);
  assert.equal(refused.code, 2, 'a token in the diff is never DONE');
  assert.match(refused.err, /blocking: a key, token or private key was added: src\.js:2 — remove it and read it from the environment/);

  p.write('src.js', 'export const thing = 2;\n');
  p.write('.env', 'API_KEY=whatever\n');
  const envFile = finish(s);
  assert.equal(envFile.code, 2, 'a secret file in the change is never DONE');
  assert.match(envFile.err, /blocking: a secret file was added or changed: \.env/);

  s.mem(['job', 'abandon', '1']);
  p.git('checkout', '--', 'src.js');
  unlinkSync(join(p.dir, '.env'));
  newWorker(s);
  p.write('test/login.test.js', 'const user = { password: "hunter22-not-real" };\n');
  const done = finish(s, '2');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /look at: added lines look like credentials \(password=, token=, or a long random string\): test\/login\.test\.js:1/);
});

test('work can be taken without verification, but never quietly', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('status', 'broken\n');
  assert.equal(finish(s, '1', ['--accept', '']).code, 2, 'a reason is required');
  const taken = finish(s, '1', ['--accept', 'the check needs a database this machine lacks']);
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, /^STATUS: DONE \(UNVERIFIED — taken without running the checks\) — j1/);
  assert.match(s.mem(['job', 'show', '1']).out, /## Accepted without verification\nthe check needs a database this machine lacks/);
});

test("what the user had already changed is not counted as the job's", () => {
  const s = sandbox();
  const p = gitProject(s);
  p.write('src.js', 'export const thing = 1; // the user was here\n');
  p.write('scratch.txt', 'the user left this lying around\n');
  newWorker(s);
  assert.match(s.mem(['job', 'baseline', '1']).out, /passes/, "the user's own edits do not count as the tree having moved");

  p.write('added.js', 'export const other = 2;\n');
  const changed = s.mem(['job', 'changes', '1']);
  assert.match(changed.out, /^1 file changed — .*jobs\/1\/changes\.diff/);
  const diff = readFileSync(join(s.home, 'jobs', '1', 'changes.diff'), 'utf8');
  assert.match(diff, /added\.js/);
  assert.doesNotMatch(diff, /the user was here|scratch\.txt/);
});

test('--guide carries the written way of doing that work into the brief', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s, ['--guide', 'fix']);
  const brief = s.mem(['job', 'brief', '1']).out;
  assert.match(brief, /## How this kind of work is done here\n1\. What changed recently\?/);
  assert.doesNotMatch(brief, /^# Fix$/m, 'the guide comes without its own title');
  assert.match(brief, /You do not start sub-agents\./);
  assert.match(brief, /## Concerns[\s\S]*## Decisions/);

  const bad = newWorker(s, ['--guide', 'vibes']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--guide is one of: fix, feature, review/);
  assert.match(s.mem(['job', 'list']).out, /^j1 .*\n?$/, 'a refused job is never created');
});

test('a reviewer is handed the change as one file, what was asked, and the author\'s report as claims', () => {
  const s = sandbox();
  const p = gitProject(s);
  assert.equal(s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--title', 'review'], { input: 'x' }).code, 2, 'nothing changed, nothing to review');

  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  finish(s);

  const created = s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'The thing must return 2.' });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /start it with the reviewer sub-agent/);
  assert.doesNotMatch(created.out, /names no check/);

  const brief = s.mem(['job', 'brief', '2']).out;
  assert.match(brief, /You are a reviewer: you judge a change somebody else made.*You did not write it and you owe it nothing/s);
  assert.match(brief, /What was asked: .*jobs\/1\/brief\.md/);
  assert.match(brief, /What its author says they did: .*jobs\/1\/report\.md {3}— claims, not facts/);
  assert.match(brief, /The whole change, 1 file: .*jobs\/2\/changes\.diff/);
  assert.match(brief, /## How this kind of work is done here\n1\. Judge the change, not its author's account of it/);
  assert.match(brief, /## Asked vs built[\s\S]*## Findings[\s\S]*## Could not verify/);
  assert.match(readFileSync(join(s.home, 'jobs', '2', 'changes.diff'), 'utf8'), /-export const thing = 1;\n\+export const thing = 2;/);

  assert.equal(s.mem(['job', 'finish', '2', '--status', 'DONE'], { input: '## Summary\nMatches.\n' }).code, 0, 'a review is not itself run through the checks');

  // With no job named, it judges whatever is uncommitted.
  p.write('loose.js', 'export const loose = true;\n');
  s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--title', 'review the tree'], { input: 'x' });
  assert.match(readFileSync(join(s.home, 'jobs', '3', 'changes.diff'), 'utf8'), /loose\.js/);
  assert.equal(s.mem(['job', 'new', '--project', 'gitproj', '--reviews', '1', '--title', 'x'], { input: 'x' }).code, 2, '--reviews is a reviewer flag');
});

test('a second worker in the same working tree is called out when it is created', () => {
  const s = sandbox();
  gitProject(s);
  assert.doesNotMatch(newWorker(s).out, /already a running worker/);
  assert.match(newWorker(s).out, /note: j1 "return 2" is already a running worker in proj-git — two workers in one working tree overwrite each other/);
  s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'scout', '--title', 'look'], { input: TASK });
  assert.doesNotMatch(s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'scout', '--title', 'look again'], { input: TASK }).out, /already a running worker/, 'scouts only read');
});

test('jobs from before reviewers existed survive the upgrade, and no job id is ever handed out twice', () => {
  const s = sandbox();
  gitProject(s);
  newWorker(s);
  newWorker(s);
  // Put the table back to the shape it had in the previous release, with the counter ahead of the rows.
  s.sql((db) => {
    db.exec(`
      CREATE TABLE jobs_old (
        id INTEGER PRIMARY KEY AUTOINCREMENT, project TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE, title TEXT NOT NULL,
        agent TEXT NOT NULL CHECK (agent IN ('scout', 'worker')),
        status TEXT NOT NULL CHECK (status IN ('running', 'needs_input', 'done', 'failed', 'abandoned')),
        session_id TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      ) STRICT;
      INSERT INTO jobs_old SELECT * FROM jobs WHERE id = 1;
      DROP TABLE jobs;
      ALTER TABLE jobs_old RENAME TO jobs;
      UPDATE sqlite_sequence SET seq = 2 WHERE name = 'jobs';
      PRAGMA user_version = 4;
    `);
  });

  assert.match(s.mem(['job', 'list']).out, /^j1 \[worker·proj-git·running\] return 2\n?$/, 'opening it migrates it; the job is still there');
  assert.match(newWorker(s).out, /^created j3 /, "j2's directory still exists on disk, so its id must not come back");
  assert.equal(s.mem(['job', 'new', '--project', 'gitproj', '--agent', 'architect', '--title', 'x'], { input: 'y' }).code, 2);
});

test('a recorded start that git has since collected is said out loud, never read as "nothing changed"', () => {
  const s = sandbox();
  const p = gitProject(s);
  newWorker(s);
  p.write('test/thing.test.js', '// asserts nothing\n');
  const stateFile = join(s.home, 'jobs', '1', 'verify.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, snap: { ...state.snap, base: '0123456789abcdef0123456789abcdef01234567' } }));

  assert.match(s.mem(['job', 'verify', '1']).out, /note: the recorded start of this job is no longer in the repository — what changed, and whether existing tests were touched, could not be checked/);
  const changes = s.mem(['job', 'changes', '1']);
  assert.equal(changes.code, 2);
  assert.match(changes.err, /is no longer in the repository/);
});
