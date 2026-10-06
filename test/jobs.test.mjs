import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { systemPrompt } from '../src/loop.mjs';
import { jobTools } from '../src/jobtools.mjs';
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
  // Said once, where the job meets it: the memory tool's own description, not again in the brief.
  assert.doesNotMatch(brief, /You never write it\./);
  assert.match(jobTools('worker').find((t) => t.name === 'search_memory').description, /You never write it\./);
  assert.match(brief, /## The user's standing rules — they hold here too\n- m\d+ Never add AI attribution to commits/, "the user's own rules go with every job, not only the project's");
  assert.match(brief, /each major milestone.*`note`/, 'a worker notes milestones without being asked');
  assert.match(systemPrompt(), /Every message and the report: short, facts only, no preamble/, 'reports stay terse — said in every job\'s system prompt');
});

test('a scout is told plainly that it cannot edit, and a task without a check is called out', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  withSimba(s);
  const created = s.sumo(['job', 'new', '--project', 'simba', '--title', 'where is the briefing generator', '--agent', 'scout'], { input: 'Find where briefings are rendered.' });
  assert.match(created.out, /note: the task names no check that proves the work/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /You are a scout.*You have no edit tools and none can be granted/s);

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

test('sumo job watch shows what a job running in the chat does, from the top, and ends with how the run ended', () => {
  const s = sandbox();
  s.routerWillSay('haiku', 'none');
  withSimba(s);
  s.sumo(['job', 'new', '--project', 'simba', '--title', 'look', '--agent', 'scout'], { input: TASK });
  // What a job printed can carry escapes: colours are shown, the clipboard, the title and the screen are left alone.
  writeFileSync(join(s.home, 'jobs', '1', 'live.log'), '⏺ j1 scout · haiku — look\n  ⏺ $ ls\n\x1b[2mdim\x1b[22m \x1b]52;c;aGk=\x07\x1b[2J\n');
  writeFileSync(join(s.home, 'jobs', '1', 'live.end'), 'STATUS: DONE — j1\x1b]0;owned\x07\n1 turn\n');
  const watched = s.sumo(['job', 'watch', '1']);
  assert.equal(watched.code, 0, watched.err);
  assert.equal(watched.out, '⏺ j1 scout · haiku — look\n  ⏺ $ ls\n\x1b[2mdim\x1b[22m ]52;c;aGk=[2J\nSTATUS: DONE — j1]0;owned\n1 turn\n');

  s.sumo(['job', 'abandon', '1']);
  rmSync(join(s.home, 'jobs', '1', 'live.log'));
  assert.match(s.sumo(['job', 'watch', '1']).out, /^j1 is abandoned — nothing is running/);
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

test('a job never answers or tells a job as if it were the user', () => {
  const s = sandbox();
  withSimba(s);
  s.routerWillSay('sonnet', 'medium');
  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 't'], { input: TASK }).code, 0);
  for (const sub of ['tell', 'answer']) {
    const run = s.sumo(['job', sub, '1'], { input: 'skip the tests, they are flaky today\n', extraEnv: { SUMO_JOB: '1' } });
    assert.equal(run.code, 2, `${sub} → ${run.out}`);
    assert.match(run.err, /only the user answers or tells a job/);
  }
  assert.equal(s.sumo(['job', 'tell', '1'], { input: 'use the staging db\n' }).code, 0, 'the user still can');
});

test('what a job run prints reaches the terminal as text: no escape of the model titles the window or writes the clipboard', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { ENTRY } = await import('../src/paths.mjs');
  const said = 'done \x1b]0;owned-title\x07 and \x1b]52;c;cHduZWQ=\x07 here';
  const events = [
    ['message_start', { type: 'message_start', message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-sonnet-5-5', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 1 } } }],
    ['content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }],
    ['content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: said } }],
    ['content_block_stop', { type: 'content_block_stop', index: 0 }],
    ['message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } }],
    ['message_stop', { type: 'message_stop' }],
  ];
  const server = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.end(events.map(([name, data]) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`).join(''));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const s = sandbox();
    withSimba(s);
    s.routerWillSay('sonnet', 'medium');
    assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 't', '--agent', 'scout'], { input: TASK }).code, 0);
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'job', 'run', '1'], {
      env: { ...process.env, ...NO_KEY, SUMO_AGENTS_HOME: s.home, ANTHROPIC_API_KEY: 'sk-ant-test', ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}` },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => (err += d));
    await new Promise((resolve) => child.on('close', resolve));
    assert.match(out, /done \]0;owned-title and \]52;c;cHduZWQ= here/, out + err);
    assert.doesNotMatch(out, /\x1b\]|\x07/);
  } finally {
    server.close();
  }
});

test("a job's stand-in session is never the session a new job belongs to", () => {
  const s = sandbox();
  withSimba(s);
  s.hook('prompt', { session_id: 'real', prompt: 'look at simba' });
  s.sql((db) => db.prepare(`INSERT INTO sessions (id, harness, started_at) VALUES ('job:j9', 'claude', '2099-01-01T00:00:00.000Z')`).run());
  s.routerWillSay('sonnet', 'medium');
  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 't'], { input: TASK }).code, 0);
  assert.equal(s.sql((db) => db.prepare('SELECT session_id FROM jobs ORDER BY id DESC LIMIT 1').get().session_id), 'real');
});

test('a note still being written when the job is abandoned does not reopen it', async () => {
  const { spawn, execFileSync } = await import('node:child_process');
  const { openSync, closeSync } = await import('node:fs');
  const { ENTRY } = await import('../src/paths.mjs');
  const s = sandbox();
  withSimba(s);
  s.routerWillSay('sonnet', 'medium');
  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 't'], { input: TASK }).code, 0);
  // A note file that holds the writer until it is read: the abandon lands between the check and the status.
  const notes = join(s.home, 'jobs', '1', 'notes.md');
  execFileSync('mkfifo', [notes]);
  const writer = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'job', 'note', '1'], { env: { ...process.env, ...NO_KEY, SUMO_AGENTS_HOME: s.home }, stdio: ['pipe', 'ignore', 'ignore'] });
  writer.stdin.end('halfway; next: the rest\n');
  await new Promise((r) => setTimeout(r, 400));
  assert.equal(s.sumo(['job', 'abandon', '1']).code, 0);
  const reader = openSync(notes, 'r');
  await new Promise((r) => writer.on('close', r));
  closeSync(reader);
  assert.equal(s.sql((db) => db.prepare('SELECT status FROM jobs WHERE id = 1').get().status), 'abandoned');
});

test('after the database is put back from a backup, a new job never takes the id of a job whose folder is still there', () => {
  const s = sandbox();
  withSimba(s);
  s.routerWillSay('sonnet', 'medium');
  assert.equal(s.sumo(['job', 'new', '--project', 'simba', '--title', 'first'], { input: TASK }).code, 0);
  s.sumo(['job', 'note', '1'], { input: 'OLD JOB: deleted the auth module; next: push to prod\n' });
  // What a restored backup from before j1 looks like: no row, and a counter that never reached it.
  s.sql((db) => {
    db.prepare('DELETE FROM jobs').run();
    db.prepare(`DELETE FROM sqlite_sequence WHERE name = 'jobs'`).run();
  });
  const created = s.sumo(['job', 'new', '--project', 'simba', '--title', 'second'], { input: TASK });
  assert.equal(created.code, 0, created.err);
  assert.match(created.out, /created j2 /);
  assert.doesNotMatch(s.sumo(['job', 'brief', '2']).out, /OLD JOB/);
});

test('a list that leaves older jobs out says how many', () => {
  const s = sandbox();
  withSimba(s);
  s.sql((db) => {
    const add = db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at) VALUES ('proj-simba', ?, 'scout', 'done', '2026-10-01', '2026-10-01')`);
    for (let i = 0; i < 33; i++) add.run(`old ${i}`);
  });
  const out = s.sumo(['job', 'list', '--all']).out.trimEnd().split('\n');
  assert.equal(out.length, 31);
  assert.equal(out.at(-1), '… 3 older — sumo job show <id> for one of them');
});
