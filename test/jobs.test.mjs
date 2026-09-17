import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const TASK = `## Goal
Migrate the project from npm to pnpm.
## Non-goals
Do not upgrade any dependency.
## Must not change
The public CLI.
## Check
\`make test\` exits 0.
## Report
Which lockfile entries changed.
`;

function withSimba(s) {
  const dir = join(s.root, 'proj-simba');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), 'module simba\n');
  // A worker's DONE runs this for real, so it has to be something every machine can pass.
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  s.mem(['project', 'add', dir, '--alias', 'simba']);
  s.mem(['add', 'preference', 'never push to main; always open a PR', '--project', 'simba']);
  s.mem(['add', 'gotcha', 'time-zone tests need SIMBA_TZ exported', '--project', 'simba']);
  return dir;
}

test('a brief carries the task, what memory knows about the project, and how to report — so the worker starts with its context', () => {
  const s = sandbox();
  const dir = withSimba(s);

  const created = s.mem(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm', '--agent', 'worker'], { input: TASK });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /^created j1 \[worker·proj-simba·running\] migrate to pnpm/);
  assert.match(created.out, /JOB: run `mem job brief 1` and follow it exactly\./);
  assert.doesNotMatch(created.out, /names no check/);

  const brief = s.mem(['job', 'brief', '1']).out;
  assert.match(brief, /^# Job j1 — migrate to pnpm/);
  assert.match(brief, /You are a worker/);
  assert.ok(brief.includes(`Work only inside: ${dir}`) || brief.includes('Work only inside: /private' + dir), brief);
  assert.match(brief, /rule m\d+: never push to main; always open a PR/);
  assert.match(brief, /gotcha m\d+: time-zone tests need SIMBA_TZ exported/);
  assert.match(brief, /commands: test `make test`/);
  assert.match(brief, /## Goal\nMigrate the project from npm to pnpm\./);
  assert.match(brief, /mem job finish 1 --status DONE/);
  assert.match(brief, /You never write it\./);
});

test('a scout is told plainly that it cannot edit, and a task without a check is called out', () => {
  const s = sandbox();
  withSimba(s);
  const created = s.mem(['job', 'new', '--project', 'simba', '--title', 'where is the briefing generator', '--agent', 'scout'], { input: 'Find where briefings are rendered.' });
  assert.match(created.out, /note: the task names no check that proves the work/);
  assert.match(s.mem(['job', 'brief', '1']).out, /You are a scout.*You have no edit tools and none can be granted/s);

  assert.equal(s.mem(['job', 'new', '--project', 'simba', '--title', 'x', '--agent', 'architect'], { input: 'y' }).code, 2);
  assert.equal(s.mem(['job', 'new', '--project', 'simba', '--title', 'x'], { input: '' }).code, 2);
  assert.equal(s.mem(['job', 'new', '--project', 'nope', '--title', 'x'], { input: 'y' }).code, 2);
});

test('a blocked worker asks, the answer is recorded, and a fresh worker in another session picks up where the first stopped', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });

  s.mem(['job', 'note', '1'], { input: 'Converted the lockfile. CI config still references npm ci.' });
  const asked = s.mem(['job', 'ask', '1'], { input: 'Should CI pin pnpm 9 or follow latest?' });
  assert.match(asked.out, /^STATUS: NEEDS_INPUT — j1\. Stop now/);

  // A new session is told the job is waiting, without anyone asking.
  const block = s.hook('session-start', { session_id: 'next-day', source: 'startup' }).out;
  assert.match(block, /Job j1 proj-simba "migrate to pnpm" NEEDS_INPUT .* → mem job show 1/);
  assert.match(s.mem(['job', 'show', '1']).out, /waiting on this question:\nShould CI pin pnpm 9 or follow latest\?/);

  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: 'x' }).code, 0, 'a worker may still finish while a question is open');
});

test('cold restart: the brief replays the answers and the progress notes', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });
  s.mem(['job', 'note', '1'], { input: 'Converted the lockfile. CI config still references npm ci.' });
  s.mem(['job', 'ask', '1'], { input: 'Should CI pin pnpm 9 or follow latest?' });

  assert.equal(s.mem(['job', 'answer', '1'], { input: '' }).code, 2);
  const answered = s.mem(['job', 'answer', '1'], { input: 'Pin pnpm 9.' });
  assert.match(answered.out, /Resume the same sub-agent \(SendMessage\)/);
  assert.match(answered.out, /If that sub-agent is gone, start a new one with: JOB: run `mem job brief 1`/);
  assert.match(s.mem(['job', 'list']).out, /^j1 \[worker·proj-simba·running\]/);

  const brief = s.mem(['job', 'brief', '1']).out;
  assert.match(brief, /## Questions and answers so far\n### Question — .*\nShould CI pin pnpm 9 or follow latest\?\n\n### Answer — .*\nPin pnpm 9\./);
  assert.match(brief, /## Progress so far \(from an earlier run of this job — continue from here, do not start over\)\n### note — .*\nConverted the lockfile\./);
  assert.equal(s.mem(['job', 'answer', '1'], { input: 'again' }).code, 2, 'nothing is waiting for an answer any more');
});

test('finishing files the traps the worker hit — as observed gotchas in that project only — and leaves a checkpoint', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });

  const report = `## Summary
Replaced npm with pnpm; lockfile regenerated.
## Files changed
pnpm-lock.yaml — new
package-lock.json — removed
## Check
\`make test\` → ok
## Learned
- pnpm needs \`shamefully-hoist=true\` in .npmrc or the electron build cannot find its native modules
- time-zone tests need SIMBA_TZ exported
- none
`;
  const done = s.mem(['job', 'finish', '1', '--status', 'done'], { input: report });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1\n {2}saved m\d+ \[gotcha·proj-simba·observed\] pnpm needs `shamefully-hoist=true`/);
  assert.equal(done.out.trim().split('\n').length, 2, 'the trap memory already knew is not filed twice, and "none" is not a trap');

  const written = s.sql((db) => db.prepare(`SELECT written_by, scope, provenance FROM memories WHERE body LIKE 'pnpm needs%'`).get());
  assert.deepEqual({ ...written }, { written_by: 'worker', scope: 'project:proj-simba', provenance: 'observed' });

  assert.match(s.mem(['prime']).out, /Left off: proj-simba — finished job j1 "migrate to pnpm": Replaced npm with pnpm; lockfile regenerated\./);
  assert.match(s.mem(['job', 'show', '1']).out, /## Files changed\npnpm-lock\.yaml — new/);
  assert.match(s.mem(['job', 'list']).out, /^no open jobs/);
  assert.match(s.mem(['job', 'brief', '1']).out, /This job is already done\. Do nothing\./);
  assert.equal(s.mem(['job', 'finish', '1', '--status', 'DONE'], { input: 'again' }).code, 2);
  assert.equal(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8').startsWith('## Summary'), true);
});

test('a rule stated a minute ago is filed before the brief is built, so the worker gets it', () => {
  const s = sandbox();
  withSimba(s);
  s.hook('prompt', { session_id: 'now', prompt: 'in simba, never touch the vendored ios directory' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'project:proj-simba', body: 'Never touch the vendored ios directory', turn: 1, quote: 'never touch the vendored ios directory' }]);

  s.mem(['job', 'new', '--project', 'simba', '--title', 'tidy imports'], { input: TASK });
  assert.match(s.mem(['job', 'brief', '1']).out, /rule m\d+: Never touch the vendored ios directory/);
});

test('an abandoned or failed job stops being announced', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'one'], { input: TASK });
  s.mem(['job', 'new', '--project', 'simba', '--title', 'two'], { input: TASK });
  s.mem(['job', 'abandon', 'j1']);
  s.mem(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nThe check never passed.\n' });

  const block = s.mem(['prime']).out;
  assert.doesNotMatch(block, /Job j/);
  assert.match(block, /Left off: proj-simba — FAILED job j2 "two": The check never passed\. → next: read the report: mem job show 2/);
  assert.match(s.mem(['job', 'list', '--all']).out, /j2 \[worker·proj-simba·failed\] two\nj1 \[worker·proj-simba·abandoned\] one/);
});
