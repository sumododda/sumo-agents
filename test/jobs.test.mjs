import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { NO_KEY, sandbox } from './helpers.mjs';

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
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  s.sumo(['add', 'preference', 'never push to main; always open a PR', '--project', 'simba']);
  s.sumo(['add', 'gotcha', 'time-zone tests need SIMBA_TZ exported', '--project', 'simba']);
  return dir;
}

test('a brief carries the task, what memory knows about the project, and how to report — so the worker starts with its context', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = withSimba(s);
  s.sumo(['add', 'preference', 'Never add AI attribution to commits']);

  const created = s.sumo(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm', '--agent', 'worker'], { input: TASK });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /^created j1 \[worker·proj-simba·running\] migrate to pnpm/);
  assert.match(created.out, /run it: sumo job run 1/);
  assert.doesNotMatch(created.out, /names no check/);

  const brief = s.sumo(['job', 'brief', '1']).out;
  assert.match(brief, /^# Job j1 — migrate to pnpm/);
  assert.match(brief, /You are a worker/);
  assert.ok(brief.includes(`Work only inside: ${dir}`) || brief.includes('Work only inside: /private' + dir), brief);
  assert.match(brief, /rule m\d+: never push to main; always open a PR/);
  assert.match(brief, /gotcha m\d+: time-zone tests need SIMBA_TZ exported/);
  assert.match(brief, /commands: test `make test`/);
  assert.match(brief, /## Goal\nMigrate the project from npm to pnpm\./);
  assert.match(brief, /close the job, or nobody knows it ended: `finish` with DONE/);
  assert.doesNotMatch(brief, /sumo job/, 'the job is worked with its own tools, not commands it must remember to type');
  assert.match(brief, /You never write it\./);
  assert.match(brief, /## The user's standing rules — they hold here too\n- m\d+ Never add AI attribution to commits/, "the user's own rules go with every job, not only the project's");
  assert.match(brief, /each major milestone.*`note`/, 'a worker notes milestones without being asked');
  assert.match(brief, /Every message and report: short lines, facts only\. No prose/, 'reports stay terse');
});

test('a scout is told plainly that it cannot edit, and a task without a check is called out', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  const created = s.sumo(['job', 'new', '--project', 'simba', '--title', 'where is the briefing generator', '--agent', 'scout'], { input: 'Find where briefings are rendered.' });
  assert.match(created.out, /note: the task names no check that proves the work/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /You are a scout.*You have no edit tools and none can be granted/s);
  assert.match(s.sumo(['job', 'brief', '1']).out, /Every message and report: short lines, facts only\. No prose/, 'a scout reports tersely too');

  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 'x', '--agent', 'architect'], { input: 'y' }).code, 2);
  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 'x'], { input: '' }).code, 2);
  assert.equal(s.sumo(['job', 'new', '--project', 'nope', '--title', 'x'], { input: 'y' }).code, 2);
});

test('a blocked worker asks, the answer is recorded, and a fresh worker in another session picks up where the first stopped', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });

  s.sumo(['job', 'note', '1'], { input: 'Converted the lockfile. CI config still references npm ci.' });
  const asked = s.sumo(['job', 'ask', '1'], { input: 'Should CI pin pnpm 9 or follow latest?' });
  assert.match(asked.out, /^STATUS: NEEDS_INPUT — j1\. Stop now/);

  // A new session is told the job is waiting, without anyone asking.
  const block = s.hook('session-start', { session_id: 'next-day', source: 'startup' }).out;
  assert.match(block, /Job j1 proj-simba "migrate to pnpm" NEEDS_INPUT .* → sumo job show 1/);
  assert.match(s.sumo(['job', 'show', '1']).out, /waiting on this question:\nShould CI pin pnpm 9 or follow latest\?/);

  // Told from any shell: waits on disk for the job's next request; nothing to say is refused.
  assert.match(s.sumo(['job', 'tell', '1'], { input: 'pin pnpm 9' }).out, /^told j1 — it reads it with its next request/);
  assert.match(s.sumo(['job', 'tell', '1'], { input: '  ' }).err, /the message is empty/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /## The task/, 'the brief itself does not carry the inbox');

  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: 'x' }).code, 0, 'a worker may still finish while a question is open');
  assert.match(s.sumo(['job', 'tell', '1'], { input: 'late' }).err, /j1 is done — it cannot be told anything/);
});

test('cold restart: the brief replays the answers and the progress notes', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });
  s.sumo(['job', 'note', '1'], { input: 'Converted the lockfile. CI config still references npm ci.' });
  s.sumo(['job', 'ask', '1'], { input: 'Should CI pin pnpm 9 or follow latest?' });

  assert.equal(s.sumo(['job', 'answer', '1'], { input: '' }).code, 2);
  const answered = s.sumo(['job', 'answer', '1'], { input: 'Pin pnpm 9.' });
  assert.match(answered.out, /Continue it: delegate with job 1, or sumo job run 1 in a terminal/);
  assert.match(s.sumo(['job', 'list']).out, /^j1 \[worker·proj-simba·running\]/);

  const brief = s.sumo(['job', 'brief', '1']).out;
  assert.match(brief, /## Questions and answers so far\n### Question — .*\nShould CI pin pnpm 9 or follow latest\?\n\n### Answer — .*\nPin pnpm 9\./);
  assert.match(brief, /## Progress so far \(from an earlier run of this job — continue from here, do not start over\)\n### note — .*\nConverted the lockfile\./);
  assert.equal(s.sumo(['job', 'answer', '1'], { input: 'again' }).code, 2, 'nothing is waiting for an answer any more');
});

test('finishing files the traps the worker hit — as observed gotchas in that project only — and leaves a checkpoint', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'migrate to pnpm'], { input: TASK });

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
  const done = s.sumo(['job', 'finish', '1', '--status', 'done'], { input: report });
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1\n {2}saved m\d+ \[gotcha·proj-simba·observed\] pnpm needs `shamefully-hoist=true`/);
  assert.equal(done.out.trim().split('\n').length, 2, 'the trap memory already knew is not filed twice, and "none" is not a trap');

  const written = s.sql((db) => db.prepare(`SELECT written_by, scope, provenance FROM memories WHERE body LIKE 'pnpm needs%'`).get());
  assert.deepEqual({ ...written }, { written_by: 'worker', scope: 'project:proj-simba', provenance: 'observed' });

  assert.match(s.sumo(['prime']).out, /Left off: proj-simba — finished job j1 "migrate to pnpm": Replaced npm with pnpm; lockfile regenerated\./);
  assert.match(s.sumo(['job', 'show', '1']).out, /## Files changed\npnpm-lock\.yaml — new/);
  assert.match(s.sumo(['job', 'list']).out, /^no open jobs/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /This job is already done\. Do nothing\./);
  assert.equal(s.sumo(['job', 'finish', '1', '--status', 'DONE'], { input: 'again' }).code, 2);
  assert.equal(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8').startsWith('## Summary'), true);
});

test('a rule stated a minute ago is filed before the brief is built, so the worker gets it', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  s.hook('prompt', { session_id: 'now', prompt: 'in simba, never touch the vendored ios directory' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'project:proj-simba', body: 'Never touch the vendored ios directory', turn: 1, quote: 'never touch the vendored ios directory' }]);

  s.sumo(['job', 'new', '--project', 'simba', '--title', 'tidy imports'], { input: TASK });
  assert.match(s.sumo(['job', 'brief', '1']).out, /rule m\d+: Never touch the vendored ios directory/);
});

test('an abandoned or failed job stops being announced', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'one'], { input: TASK });
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'two'], { input: TASK });
  s.sumo(['job', 'abandon', 'j1']);
  s.sumo(['job', 'finish', '2', '--status', 'FAILED'], { input: '## Summary\nThe check never passed.\n' });

  const block = s.sumo(['prime']).out;
  assert.doesNotMatch(block, /Job j/);
  assert.match(block, /Left off: proj-simba — FAILED job j2 "two": The check never passed\. → next: read the report: sumo job show 2/);
  assert.match(s.sumo(['job', 'list', '--all']).out, /j2 \[worker·proj-simba·failed\] two\nj1 \[worker·proj-simba·abandoned\] one/);
});

test('a job run in a shell with no Anthropic credential is refused in one line, before anything is sent', () => {
  const s = sandbox();
  s.routerWillSay('haiku', 'none');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'look', '--agent', 'scout'], { input: TASK });
  const run = s.sumo(['job', 'run', '1'], { extraEnv: NO_KEY });
  assert.notEqual(run.code, 0);
  assert.match(run.err, /j1 not started — this shell has no Anthropic credential\. Inside the chat, the delegate tool runs it/);
  assert.match(s.sumo(['job', 'show', '1']).out, /running/, 'the job is left as it was');
});

test('a job that is over, or not there, is refused by name before anything runs', () => {
  const s = sandbox();
  s.routerWillSay('haiku', 'none');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'look', '--agent', 'scout'], { input: TASK });
  s.sumo(['job', 'abandon', '1']);
  const closed = s.sumo(['job', 'run', '1'], { extraEnv: { ...NO_KEY, ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.notEqual(closed.code, 0);
  assert.match(closed.err, /j1 is abandoned — only a running job can be run/);
  assert.match(s.sumo(['job', 'run', '99'], { extraEnv: { ...NO_KEY, ANTHROPIC_API_KEY: 'sk-ant-test' } }).err, /^sumo: no job j99\n$/);
});

test('a job that cannot be set up is not left behind as an open job with no brief', () => {
  const s = sandbox();
  s.routerWillSay('haiku', 'none');
  withSimba(s);
  // Something else sits where job directories go.
  writeFileSync(join(s.home, 'jobs'), 'not a directory');
  const failed = s.sumo(['job', 'new', '--project', 'simba', '--title', 'look', '--agent', 'scout'], { input: TASK });
  assert.notEqual(failed.code, 0);
  assert.equal(s.sumo(['job', 'list', '--all']).out, 'no open jobs\n');
  assert.equal(s.sql((db) => db.prepare('SELECT count(*) AS n FROM jobs').get().n), 0);
});
