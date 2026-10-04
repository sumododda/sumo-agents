import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENTRY } from '../src/paths.mjs';
import { verifyCommands } from '../src/scan.mjs';
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
function gitProject(s, { status = 'ok', recipe = '@test "$$(cat status)" = ok' } = {}) {
  const dir = join(s.root, 'proj-git');
  mkdirSync(join(dir, 'test'), { recursive: true });
  // .PHONY, or make sees the test/ directory, calls the target up to date and runs nothing.
  writeFileSync(join(dir, 'Makefile'), `.PHONY: test\ntest:\n\t${recipe}\n`);
  writeFileSync(join(dir, 'status'), `${status}\n`);
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  writeFileSync(join(dir, 'test', 'thing.test.js'), '// asserts the thing is 1\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.sumo(['project', 'add', dir, '--alias', 'gitproj']);
  return { dir, git, write: (file, text) => writeFileSync(join(dir, file), text) };
}

const newWorker = (s, extra = []) => s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'return 2', ...extra], { input: TASK });
const finish = (s, id = '1', extra = []) => s.sumo(['job', 'finish', id, '--status', 'DONE', ...extra], { input: REPORT });

test('a passing check that changes the tree cannot certify the changed files', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s, { recipe: '@test "$$(cat status)" = ok && echo broken > status' });
  newWorker(s);
  const verdict = s.sumo(['job', 'verify', '1']);
  assert.equal(readFileSync(join(p.dir, 'status'), 'utf8'), 'broken\n');
  assert.match(verdict.out, /^j1 would be REFUSED as DONE:/, verdict.out);
  assert.match(verdict.out, /files changed while the checks ran/);
  const done = finish(s);
  assert.equal(done.code, 2, 'the cached verdict must not accept an untested tree');
  assert.match(s.sumo(['job', 'list']).out, /running/);
});

test("a worker's DONE rests on what the project's checks say, not on what its report says", () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  assert.match(s.sumo(['job', 'brief', '1']).out, /Before you edit anything: `sumo job baseline 1`/);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes/);

  p.write('src.js', 'export const thing = 2;\n');
  p.write('status', 'broken\n');
  assert.match(s.sumo(['job', 'verify', '1']).out, /^j1 would be REFUSED as DONE:\n {2}`make test` FAILED/);

  const refused = finish(s);
  assert.equal(refused.code, 2, 'a report that says "ok" does not make it so');
  assert.match(refused.err, /j1 is not done — the project's checks were run, and:/);
  assert.match(refused.err, /`make test` fails, and it passed when this job began — read .*verify-test\.txt/);
  assert.match(refused.err, /sumo job finish 1 --status FAILED, or ask: sumo job ask 1/, 'there is always an honest way out');
  assert.match(s.sumo(['job', 'list']).out, /j1 \[worker·proj-git·running\]/, 'a refused job is still open');

  p.write('status', 'ok\n');
  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1$/m, 'a plain DONE from a worker now means the checks agreed');
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /## Verified by code — not by the author of this report\n- `make test` passed/);
});

test('what already failed is not blamed on the job — and without a baseline, nothing can hide behind "it was already broken"', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  gitProject(s, { status: 'broken' });
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` ALREADY FAILS — not yours to fix/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /## Already failing before this job began — not yours to fix, and not to be made worse\n- `make test`/);

  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /`make test` was already failing/);
  // A check that already failed cannot tell a new failure from the old one, so a person is pointed at it.
  assert.match(done.out, /^ {2}look at: `make test` was already failing when this job began; compare /m);

  newWorker(s);
  const blamed = finish(s, '2');
  assert.equal(blamed.code, 2);
  assert.match(blamed.err, /no baseline was taken before the work, so the failure counts as this job's/);
});

test('a baseline taken after the first edit is refused, because it would call the job\'s own breakage "already there"', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('status', 'broken\n');
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^no baseline taken: files have already changed since this job began/);
  assert.equal(finish(s).code, 2);
});

test('tests that were already here judge the change and are not part of it; new tests are welcome', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('test/new.test.js', '// asserts the thing is 2\n');
  assert.match(s.sumo(['job', 'verify', '1']).out, /^j1 would be accepted as DONE:/, 'adding a test is not touching one');

  p.write('test/thing.test.js', '// asserts nothing\n');
  const refused = finish(s);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /tests that were already here were changed: test\/thing\.test\.js .* If one is genuinely wrong, say why: sumo job ask/);

  // The main agent can say up front that this task is allowed to.
  newWorker(s, ['--tests-may-change']);
  assert.match(s.sumo(['job', 'brief', '2']).out, /This task may change them — say in the report which, and why\./);
  assert.equal(finish(s, '2').code, 0);
});

test('a line that tells a checker to look away is put in front of a person, not silently accepted', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
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
  s.routerWillSay('sonnet', 'medium');
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

  s.sumo(['job', 'abandon', '1']);
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
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('status', 'broken\n');
  assert.equal(finish(s, '1', ['--accept', '']).code, 2, 'a reason is required');
  const taken = finish(s, '1', ['--accept', 'the check needs a database this machine lacks']);
  assert.equal(taken.code, 0, taken.err);
  assert.match(taken.out, /^STATUS: DONE \(UNVERIFIED — taken without running the checks\) — j1/);
  assert.match(s.sumo(['job', 'show', '1']).out, /## Accepted without verification\nthe check needs a database this machine lacks/);
});

test("what the user had already changed is not counted as the job's", () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  p.write('src.js', 'export const thing = 1; // the user was here\n');
  p.write('scratch.txt', 'the user left this lying around\n');
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /passes/, "the user's own edits do not count as the tree having moved");

  p.write('added.js', 'export const other = 2;\n');
  const changed = s.sumo(['job', 'changes', '1']);
  assert.match(changed.out, /^1 file changed — .*jobs\/1\/changes\.diff/);
  const diff = readFileSync(join(s.home, 'jobs', '1', 'changes.diff'), 'utf8');
  assert.match(diff, /added\.js/);
  assert.doesNotMatch(diff, /the user was here|scratch\.txt/);
});

test('--guide carries the written way of doing that work into the brief', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  gitProject(s);
  newWorker(s, ['--guide', 'fix']);
  const brief = s.sumo(['job', 'brief', '1']).out;
  assert.match(brief, /## How this kind of work is done here\n1\. What changed recently\?/);
  assert.doesNotMatch(brief, /^# Fix$/m, 'the guide comes without its own title');
  assert.match(brief, /You do not start other jobs\./);
  assert.match(brief, /## Concerns[\s\S]*## Decisions/);

  const bad = newWorker(s, ['--guide', 'vibes']);
  assert.equal(bad.code, 2);
  assert.match(bad.err, /--guide is one of: fix, feature, review/);
  assert.match(s.sumo(['job', 'list']).out, /^j1 .*\n?$/, 'a refused job is never created');
});

test('a reviewer is handed the change as one file, what was asked, and the author\'s report as claims', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  assert.equal(s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--title', 'review'], { input: 'x' }).code, 2, 'nothing changed, nothing to review');

  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  finish(s);

  const created = s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--reviews', 'j1', '--title', 'review j1'], { input: 'The thing must return 2.' });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /run it: sumo job run \d+/);
  assert.doesNotMatch(created.out, /names no check/);

  const brief = s.sumo(['job', 'brief', '2']).out;
  assert.match(brief, /You are a reviewer: you judge a change somebody else made.*You did not write it and you owe it nothing/s);
  assert.match(brief, /What was asked: .*jobs\/1\/brief\.md/);
  assert.match(brief, /What its author says they did: .*jobs\/1\/report\.md {3}— claims, not facts/);
  assert.match(brief, /The whole change, 1 file: .*jobs\/2\/changes\.diff/);
  assert.match(brief, /## How this kind of work is done here\n1\. Judge the change, not its author's account of it/);
  assert.match(brief, /## Asked vs built[\s\S]*## Findings[\s\S]*## Could not verify/);
  assert.match(readFileSync(join(s.home, 'jobs', '2', 'changes.diff'), 'utf8'), /-export const thing = 1;\n\+export const thing = 2;/);

  assert.equal(s.sumo(['job', 'finish', '2', '--status', 'DONE'], { input: '## Summary\nMatches.\n' }).code, 0, 'a review is not itself run through the checks');

  // With no job named, it judges whatever is uncommitted.
  p.write('loose.js', 'export const loose = true;\n');
  s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--title', 'review the tree'], { input: 'x' });
  assert.match(readFileSync(join(s.home, 'jobs', '3', 'changes.diff'), 'utf8'), /loose\.js/);
  assert.equal(s.sumo(['job', 'new', '--project', 'gitproj', '--reviews', '1', '--title', 'x'], { input: 'x' }).code, 2, '--reviews is a reviewer flag');
});

test('a second worker in the same working tree is called out when it is created', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  gitProject(s);
  assert.doesNotMatch(newWorker(s).out, /already a running worker/);
  assert.match(newWorker(s).out, /note: j1 "return 2" is already a running worker in proj-git — two workers in one working tree overwrite each other/);
  s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'scout', '--title', 'look'], { input: TASK });
  assert.doesNotMatch(s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'scout', '--title', 'look again'], { input: TASK }).out, /already a running worker/, 'scouts only read');
});

test('jobs from before reviewers existed survive the upgrade, and no job id is ever handed out twice', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
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
      INSERT INTO jobs_old SELECT id, project, title, agent, status, session_id, created_at, updated_at FROM jobs WHERE id = 1;
      DROP TABLE jobs;
      ALTER TABLE jobs_old RENAME TO jobs;
      UPDATE sqlite_sequence SET seq = 2 WHERE name = 'jobs';
      PRAGMA user_version = 4;
    `);
  });

  assert.match(s.sumo(['job', 'list']).out, /^j1 \[worker·proj-git·running\] return 2\n?$/, 'opening it migrates it; the job is still there');
  assert.match(newWorker(s).out, /^created j3 /, "j2's directory still exists on disk, so its id must not come back");
  assert.equal(s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'architect', '--title', 'x'], { input: 'y' }).code, 2);
});

test('a recorded start that git has since collected is said out loud, never read as "nothing changed"', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('test/thing.test.js', '// asserts nothing\n');
  const stateFile = join(s.home, 'jobs', '1', 'verify.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, snap: { ...state.snap, base: '0123456789abcdef0123456789abcdef01234567' } }));

  assert.match(s.sumo(['job', 'verify', '1']).out, /note: the recorded start of this job is no longer in the repository — what changed, and whether existing tests were touched, could not be checked/);
  const changes = s.sumo(['job', 'changes', '1']);
  assert.equal(changes.code, 2);
  assert.match(changes.err, /is no longer in the repository/);
});

test('a retried worker keeps the original\'s permission to change tests that were already here', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s, ['--tests-may-change']);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'FAILED'], { input: '## Summary\nRan out of road.\n' }).code, 0);

  const retried = s.sumo(['job', 'retry', '1']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(s.sumo(['job', 'brief', '2']).out, /This task may change them — say in the report which, and why\./);

  p.write('src.js', 'export const thing = 2;\n');
  p.write('test/thing.test.js', '// asserts the thing is 2\n');
  const done = finish(s, '2');
  assert.equal(done.code, 0, done.err);
});

test('git is read the same whatever the user has configured: a test with an accent in its name still judges, and a key is still seen through a diff tool or forced colour', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  p.write('test/café.test.js', '// asserts the thing is 1\n');
  p.git('add', '-A');
  p.git('commit', '-q', '-m', 'a test with an accent');
  p.git('config', 'color.ui', 'always');
  p.git('config', 'diff.external', 'false');
  newWorker(s);

  p.write('test/café.test.js', '// asserts nothing any more\n');
  const tampered = finish(s);
  assert.equal(tampered.code, 2, tampered.out);
  assert.match(tampered.err, /tests that were already here were changed: test\/café\.test\.js/);

  p.git('checkout', '--', '.');
  p.write('src.js', 'export const thing = 2;\nconst gh = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";\n');
  const leaked = finish(s);
  assert.equal(leaked.code, 2, leaked.out);
  assert.match(leaked.err, /blocking: a key, token or private key was added: src\.js:2/);
});

test('a private key pasted into the change blocks DONE, though it is spread over many lines', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\nconst pem = `-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----`;\n');
  const refused = finish(s);
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.err, /blocking: a key, token or private key was added: src\.js:2/);
});

test('a DONE that cannot be checked is refused, not waved through: no record of where the job began, or no project left to run the checks in', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('src.js', 'export const thing = 2;\n');
  p.write('status', 'broken\n');
  assert.equal(finish(s).code, 2, 'the checks fail');

  // The record of where the job began is gone or cut short: a full disk, or the worker's own editor, which may write there.
  writeFileSync(join(s.home, 'jobs', '1', 'verify.json'), '');
  const unreadable = finish(s);
  assert.equal(unreadable.code, 2, unreadable.out);
  assert.match(unreadable.err, /j1 cannot be verified — .*verify\.json.*--accept/s);
  assert.match(s.sumo(['job', 'list']).out, /j1 \[worker·proj-git·running\]/);

  // Taking it anyway stays possible, and is still said out loud.
  const taken = finish(s, '1', ['--accept', 'checked by hand']);
  assert.equal(taken.code, 0, taken.err);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /## Accepted without verification\nchecked by hand/);
});

test('a file that was there before the job but never added to git is watched too: what the job does to it counts', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  p.write('helper.js', 'export const help = 1;\n');
  p.write('test/new.test.js', '// asserts help is 1\n');
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes/);
  assert.match(s.sumo(['job', 'verify', '1']).out, /^j1 would be accepted as DONE/, 'untouched, they are not part of the change');

  p.write('test/new.test.js', '// asserts nothing\n');
  const tampered = finish(s);
  assert.equal(tampered.code, 2, tampered.out);
  assert.match(tampered.err, /tests that were already here were changed: test\/new\.test\.js/);

  p.write('test/new.test.js', '// asserts help is 1\n');
  p.write('helper.js', 'export const help = 1;\nconst gh = "ghp_0123456789abcdefghijklmnopqrstuvwxyzAB";\n');
  const leaked = finish(s);
  assert.equal(leaked.code, 2, leaked.out);
  assert.match(leaked.err, /blocking: a key, token or private key was added: helper\.js:2/);
  s.sumo(['job', 'changes', '1']);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'changes.diff'), 'utf8'), /changed \(it was never in git\): helper\.js/);
});

test('a baseline is refused when there is no telling what has changed: the start of the job is gone from the repository', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  p.write('status', 'broken\n');
  const stateFile = join(s.home, 'jobs', '1', 'verify.json');
  const state = JSON.parse(readFileSync(stateFile, 'utf8'));
  writeFileSync(stateFile, JSON.stringify({ ...state, snap: { ...state.snap, base: '0123456789abcdef0123456789abcdef01234567' } }));

  assert.match(s.sumo(['job', 'baseline', '1']).out, /^no baseline taken: the recorded start of this job is no longer in the repository/);
  assert.equal(JSON.parse(readFileSync(stateFile, 'utf8')).baseline, null, 'the job\'s own breakage is not written down as "already failing"');
});

/** Waits for something another process does; false if it never happens. */
async function until(done, ms = 5000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) if (done()) return true;
  return done();
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
/** `sumo` in a process of its own, for what has to happen while it runs. */
const sumoAside = (s, args, options = {}) => spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], { env: { ...process.env, SUMO_AGENTS_HOME: s.home }, ...options });

test('the checks that judge a change are not part of it: one rewritten or no longer run since the job began is refused', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes/);

  p.write('status', 'broken\n');
  p.write('Makefile', '.PHONY: test\ntest:\n\t@true\n');
  const rewritten = finish(s);
  assert.equal(rewritten.code, 2, rewritten.out);
  assert.match(rewritten.err, /blocking: checks that were already here were changed: `make test` — they judge this change and are not part of it\. If one is genuinely wrong, say why: sumo job ask/);

  p.write('Makefile', 'all:\n\t@true\n');
  const dropped = finish(s);
  assert.equal(dropped.code, 2, dropped.out);
  assert.match(dropped.err, /blocking: checks that were run when this job began are no longer run: `make test` — they judge this change and are not part of it/);

  // A task that may change tests may change how they run — but not stop them running.
  s.sumo(['job', 'abandon', '1']);
  p.write('status', 'ok\n');
  p.write('Makefile', '.PHONY: test\ntest:\n\t@test "$$(cat status)" = ok\n');
  newWorker(s, ['--tests-may-change']);
  p.write('Makefile', '.PHONY: test\ntest:\n\t@true\n');
  assert.equal(finish(s, '2').code, 0);

  // What `npm test` runs is the script's body, so that is what is compared.
  const npm = join(s.root, 'proj-npm');
  mkdirSync(npm);
  writeFileSync(join(npm, 'package.json'), JSON.stringify({ scripts: { test: 'node --test', lint: 'eslint .' } }));
  assert.deepEqual(verifyCommands(npm), [
    { name: 'test', command: 'npm test', definition: 'node --test' },
    { name: 'lint', command: 'npm run lint', definition: 'eslint .' },
  ]);
});

test('two checks of one name are told apart: each is judged against its own baseline and has a log of its own', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  // A Rust crate with Python tests: `cargo test` and `pytest`, both called "test".
  const dir = join(s.root, 'proj-mixed');
  const bin = join(s.root, 'bin');
  mkdirSync(dir);
  mkdirSync(bin);
  writeFileSync(join(bin, 'cargo'), '#!/bin/sh\necho cargo ran\ntest "$(cat rust-status)" = ok\n', { mode: 0o755 });
  writeFileSync(join(bin, 'pytest'), '#!/bin/sh\necho pytest ran\ntest "$(cat py-status)" = ok\n', { mode: 0o755 });
  writeFileSync(join(dir, 'Cargo.toml'), '[package]\nname = "mixed"\n');
  writeFileSync(join(dir, 'pyproject.toml'), '[tool.pytest.ini_options]\n');
  writeFileSync(join(dir, 'rust-status'), 'ok\n');
  writeFileSync(join(dir, 'py-status'), 'broken\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.sumo(['project', 'add', dir, '--alias', 'mixed']);
  const withBin = { extraEnv: { PATH: `${bin}:${process.env.PATH}` } };

  s.sumo(['job', 'new', '--project', 'mixed', '--title', 'x'], { input: TASK });
  assert.match(s.sumo(['job', 'baseline', '1'], withBin).out, /^`cargo test` passes\n`pytest` ALREADY FAILS/);
  writeFileSync(join(dir, 'rust-status'), 'broken\n');
  const refused = s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: REPORT, ...withBin });
  assert.equal(refused.code, 2, refused.out);
  assert.match(refused.err, /blocking: `cargo test` fails, and it passed when this job began/);
  const logs = readdirSync(join(s.home, 'jobs', '1')).filter((f) => f.endsWith('.txt')).sort();
  assert.deepEqual(logs, ['baseline-test-2.txt', 'baseline-test.txt', 'verify-test-2.txt', 'verify-test.txt']);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'verify-test.txt'), 'utf8'), /^\$ cargo test\ncargo ran/);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'verify-test-2.txt'), 'utf8'), /^\$ pytest\npytest ran/);
});

test('a retried worker is judged from where the first attempt began: what that attempt left in the tree is still its to answer for', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes/);
  p.write('test/thing.test.js', '// asserts nothing\n');
  assert.match(finish(s).err, /tests that were already here were changed: test\/thing\.test\.js/);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'FAILED'], { input: REPORT }).code, 0);

  const retried = s.sumo(['job', 'retry', '1']);
  assert.equal(retried.code, 0, retried.err);
  assert.match(s.sumo(['job', 'baseline', '2']).out, /^`make test` passes$/m, 'the first attempt\'s baseline comes with it — not taken again over that attempt\'s edits, nor refused');
  const done = finish(s, '2');
  assert.equal(done.code, 2, done.out);
  assert.match(done.err, /tests that were already here were changed: test\/thing\.test\.js/);
});

test('a check past its time limit is stopped with everything it started — and a stopped `sumo job verify` stops its checks too', async () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s, { recipe: '@echo $$$$ > check.pid; sleep 20' });
  const pidFile = join(p.dir, 'check.pid');
  newWorker(s);

  const timed = s.sumo(['job', 'verify', '1'], { extraEnv: { SUMO_AGENTS_CHECK_TIMEOUT_MS: '1000' } });
  assert.match(timed.out, /blocking: `make test` ran past the time limit/);
  const left = Number(readFileSync(pidFile, 'utf8'));
  const stopped = await until(() => !alive(left), 2000);
  if (!stopped) process.kill(left, 'SIGKILL');
  assert.ok(stopped, 'nothing the check started outlives its time limit');

  // A stop kills the group `sumo job verify` runs in (src/tools.mjs); a check in a group of its own must go with it.
  unlinkSync(pidFile);
  const run = sumoAside(s, ['job', 'verify', '1'], { stdio: 'ignore', detached: true });
  assert.ok(await until(() => existsSync(pidFile) && readFileSync(pidFile, 'utf8').trim()), 'the check started');
  process.kill(-run.pid, 'SIGKILL');
  const check = Number(readFileSync(pidFile, 'utf8'));
  const gone = await until(() => !alive(check), 3000);
  if (!gone) process.kill(check, 'SIGKILL');
  assert.ok(gone, 'a check does not outlive the command that ran it');
});

test('a job abandoned while its checks run stays abandoned: finishing it afterwards is refused', async () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s, { recipe: '@touch started; while [ ! -f go ]; do sleep 0.1; done; test "$$(cat status)" = ok' });
  newWorker(s);
  const run = sumoAside(s, ['job', 'finish', '1', '--status', 'DONE']);
  let err = '';
  run.stderr.on('data', (d) => (err += d));
  run.stdin.end(REPORT);
  assert.ok(await until(() => existsSync(join(p.dir, 'started'))), 'the checks started');

  assert.equal(s.sumo(['job', 'abandon', '1']).code, 0);
  p.write('go', '');
  const code = await new Promise((r) => run.on('close', r));
  assert.equal(code, 2, err);
  assert.match(err, /j1 is abandoned — it cannot be finished/);
  assert.match(s.sumo(['job', 'list', '--all']).out, /^j1 \[worker·proj-git·abandoned\]/m);
});

test('an untracked repository inside the project does not make git hash every untracked file one at a time', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  p.write('notes.txt', 'mine\n');
  p.write('data.csv', '1,2\n');
  mkdirSync(join(p.dir, 'vendored'));
  spawnSync('git', ['-C', join(p.dir, 'vendored'), 'init', '-q']);
  p.write('vendored/x', 'y\n');
  // git, with every call written down.
  const bin = join(s.root, 'bin');
  const log = join(s.root, 'git.log');
  mkdirSync(bin);
  const realGit = spawnSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).stdout.trim();
  writeFileSync(join(bin, 'git'), `#!/bin/sh\necho "$*" >> '${log}'\nexec '${realGit}' "$@"\n`, { mode: 0o755 });

  const created = s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'x'], { input: TASK, extraEnv: { PATH: `${bin}:${process.env.PATH}` } });
  assert.equal(created.code, 0, created.err);
  const hashing = readFileSync(log, 'utf8').split('\n').filter((l) => l.includes('hash-object'));
  assert.ok(hashing.length > 0);
  assert.deepEqual(hashing.filter((l) => !l.includes('--stdin-paths')), [], 'all of them in one call');
  assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(s.home, 'jobs', '1', 'verify.json'), 'utf8')).snap.hashes).sort(), ['data.csv', 'notes.txt']);
});

test('a check that is over is not waited on for what it left running: the time limit is for checks, not for their leftovers', async () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s, { recipe: '@(sleep 30; echo late) & echo $$! > leftover.pid; echo checked' });
  newWorker(s);
  const started = Date.now();
  const run = s.sumo(['job', 'verify', '1'], { extraEnv: { SUMO_AGENTS_CHECK_TIMEOUT_MS: '6000' } });
  const took = Date.now() - started;
  const left = Number(readFileSync(join(p.dir, 'leftover.pid'), 'utf8'));
  const gone = await until(() => !alive(left), 3000);
  if (!gone) process.kill(left, 'SIGKILL');
  assert.ok(took < 5000, `verify took ${took} ms`);
  assert.match(run.out, /`make test` passed/, run.out);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'verify-test.txt'), 'utf8'), /^\$ make test\nchecked\n$/);
  assert.ok(gone, 'what the check left running does not outlive it');
});

test('a baseline taken after an early verdict is what DONE is judged against: the verdict from before it is not reused', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  gitProject(s, { status: 'broken' });
  newWorker(s);
  // Looked before the baseline: with nothing to compare against, the failure counts as the job's.
  assert.match(s.sumo(['job', 'verify', '1']).out, /no baseline was taken before the work/);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` ALREADY FAILS/);

  const done = finish(s);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /look at: `make test` was already failing when this job began/);
});

test('a make recipe goes on past a blank or comment line inside it, so a change to its later lines is a change to the check', () => {
  const s = sandbox();
  const dir = join(s.root, 'proj-make');
  mkdirSync(dir);
  writeFileSync(join(dir, 'Makefile'), '.PHONY: test\ntest:\n\t@echo one\n\n# then the real run\n\t@node --test\n\nlint:\n\t@eslint .\n');
  const test = verifyCommands(dir).find((c) => c.command === 'make test');
  assert.equal(test.definition, 'test:\n\t@echo one\n\n# then the real run\n\t@node --test');
});

test('a check that prints more than is kept is read from its end: the log holds its last lines, whole', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  // About 3 MB of numbered lines, so the end is read from well inside the file.
  gitProject(s, { recipe: '@seq 1 400000 | sed "s/^/line /"' });
  newWorker(s);
  s.sumo(['job', 'verify', '1']);
  const lines = readFileSync(join(s.home, 'jobs', '1', 'verify-test.txt'), 'utf8').trimEnd().split('\n');
  assert.equal(lines[0], '$ make test');
  assert.equal(lines.length, 201);
  assert.equal(lines[1], 'line 399801');
  assert.equal(lines.at(-1), 'line 400000');
});
