import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { getJob, newJob } from '../src/jobs.mjs';
import { runJob } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { estimateTokens } from '../src/text.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const TASK = '## Goal\nMake the thing return 2.\n## Check\n`make test` exits 0.\n';
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';
const CHECKLIST = [
  '- Every requirement in the task is met.',
  '- Debug output and scratch files are removed.',
  '- Tests were changed only if the task allows it.',
  '- Every claim in the report is backed by a tool result from this run.',
];

/** A committed repository whose one check passes while the file `status` says ok, so a test can break and mend it. */
function gitRepo(dir, files) {
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries({ Makefile: 'test:\n\t@test "$$(cat status)" = ok\n', status: 'ok\n', 'src.js': 'export const thing = 1;\n', ...files })) {
    mkdirSync(join(dir, file, '..'), { recursive: true });
    writeFileSync(join(dir, file), text);
  }
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return { dir, write: (file, text) => writeFileSync(join(dir, file), text) };
}

function gitProject(s, files = {}) {
  const p = gitRepo(join(s.root, 'proj-check'), files);
  s.sumo(['project', 'add', p.dir, '--alias', 'checkproj']);
  return p;
}

const newJobOf = (s, agent = 'worker', extra = []) => s.sumo(['job', 'new', '--project', 'checkproj', '--title', 'return 2', '--agent', agent, ...extra], { input: TASK });
const finish = (s, id, status = 'DONE', extra = []) => s.sumo(['job', 'finish', id, '--status', status, ...extra], { input: REPORT });
const jobFiles = (s, id) => readdirSync(join(s.home, 'jobs', id));

test("a worker's first DONE is answered with the task, what changed and what to check — not taken; the next goes on to verification", () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newJobOf(s);
  p.write('src.js', 'export const thing = 2;\n');
  p.write('debug.log', 'thing is 2?\n');

  const first = finish(s, '1');
  assert.equal(first.code, 2, 'the job is not closed, so the command did not do what it was asked');
  assert.match(first.err, /j1 is not closed yet/);
  assert.match(first.err, /## The task\n## Goal\nMake the thing return 2\.\n## Check\n`make test` exits 0\./, 'the task as it was given');
  assert.match(first.err, /^ src\.js \| 2 \+-$/m, "git's own summary of the change since the job began");
  assert.match(first.err, /^ new file: debug\.log$/m, 'and what it added that git does not track');
  for (const line of CHECKLIST) assert.ok(first.err.includes(line), line);
  assert.match(first.err, /call `finish` again with the same report, or a corrected one, to go on to verification/);
  assert.match(s.sumo(['job', 'list']).out, /j1 \[worker·proj-check·running\]/, 'the job is still open');
  assert.deepEqual(jobFiles(s, '1').filter((f) => f.startsWith('verify-')), [], 'nothing was run yet');
  assert.equal(existsSync(join(s.home, 'jobs', '1', 'report.md')), false);

  const done = finish(s, '1');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1$/m);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /## Verified by code — not by the author of this report\n- `make test` passed/);
});

test('the check is asked once per job, and remembered in its folder: a DONE the checks refuse, once mended, goes straight to verification', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newJobOf(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes/);
  p.write('status', 'broken\n');

  assert.match(finish(s, '1').err, /j1 is not closed yet/);
  assert.ok(jobFiles(s, '1').includes('checked'), 'kept on disk, so a run started again does not ask again');
  const refused = finish(s, '1');
  assert.equal(refused.code, 2);
  assert.match(refused.err, /j1 is not done — the project's checks were run, and:/, 'the second DONE is verified as it always was');

  p.write('status', 'ok\n');
  const done = finish(s, '1');
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j1$/m, 'not asked a second time');
});

test('FAILED, a scout, a reviewer and a DONE taken with --accept close at once, as they always did', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);

  newJobOf(s);
  assert.match(finish(s, '1', 'FAILED').out, /^STATUS: FAILED — j1$/m);
  newJobOf(s, 'scout');
  assert.match(finish(s, '2').out, /^STATUS: DONE — j2$/m);

  newJobOf(s);
  p.write('src.js', 'export const thing = 2;\n');
  const accepted = finish(s, '3', 'DONE', ['--accept', 'the user read the diff']);
  assert.equal(accepted.code, 0, accepted.err);
  assert.match(accepted.out, /^STATUS: DONE \(UNVERIFIED — taken without running the checks\) — j3$/m);

  newJobOf(s, 'reviewer', ['--reviews', 'j3']);
  assert.match(finish(s, '4').out, /^STATUS: DONE — j4$/m);
  for (const id of ['1', '2', '3', '4']) assert.equal(jobFiles(s, id).includes('checked'), false, `j${id} was never asked`);
});

test('outside git, the check still gives the task and the list, and says what it cannot show', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = join(s.root, 'proj-check');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  s.sumo(['project', 'add', dir, '--alias', 'checkproj']);
  newJobOf(s);

  const first = finish(s, '1');
  assert.equal(first.code, 2);
  assert.match(first.err, /## The task\n## Goal\nMake the thing return 2\./);
  assert.match(first.err, /not a git repository — what changed cannot be shown/);
  for (const line of CHECKLIST) assert.ok(first.err.includes(line), line);
  assert.equal(finish(s, '1').code, 0);
});

const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

test("the finish tool answers the same way: a worker's first DONE comes back with the check, the second closes the job", async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-finish-check-'));
  const routerAnswer = join(root, 'router-answer.json');
  writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model: 'sonnet', effort: 'low', reason: 'a stand-in' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  const env = { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer, SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log') };
  await withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const p = gitRepo(join(root, 'proj'), {});
      addProject(db, p.dir, { slug: 'proj', now: new Date().toISOString() });
      const { job } = await newJob(db, { project: 'proj', title: 'return 2', agent: 'worker', task: TASK });
      p.write('src.js', 'export const thing = 2;\n');
      const seen = [];
      const replies = [
        reply('tool_use', [call('f1', 'finish', { status: 'DONE', report: REPORT })]),
        reply('tool_use', [call('f2', 'finish', { status: 'DONE', report: REPORT })]),
        reply('end_turn', [{ type: 'text', text: 'closed' }]),
      ];
      const send = async (params) => {
        seen.push(structuredClone(params));
        return replies.shift();
      };
      const outcome = await runJob(db, job.id, { send });

      const checked = seen[1].messages.at(-1).content[0];
      assert.equal(checked.is_error, true, 'the job is still open: the call did not close it');
      assert.match(checked.content, new RegExp(`j${job.id} is not closed yet`));
      assert.match(checked.content, /## The task\n## Goal\nMake the thing return 2\./);
      assert.match(checked.content, /src\.js \| 2 \+-/);
      for (const line of CHECKLIST) assert.ok(checked.content.includes(line), line);
      const closed = seen[2].messages.at(-1).content[0];
      assert.equal(closed.is_error, false, closed.content);
      assert.match(closed.content, new RegExp(`^STATUS: DONE — j${job.id}$`, 'm'));
      assert.equal(outcome.job.status, 'done');
      assert.equal(getJob(db, job.id).status, 'done');
    } finally {
      db.close();
      await closeMcp();
    }
  });
});

/** The section of a brief that says where things stood when it was written. */
const situationOf = (brief) => /\n(## Where things stand as this job begins[^\n]*\n[\s\S]*?)\n\n## The task\n/.exec(brief)?.[1] ?? null;

test('a brief says where things stand — branch, what is uncommitted, the top level, the toolchain its files call for — and stays within its budget', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const files = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`src/f${String(i + 1).padStart(2, '0')}.js`, 'one\n']));
  const p = gitProject(s, { ...files, 'package.json': '{"name":"check"}\n' });
  for (const file of Object.keys(files)) p.write(file, 'two\n');
  p.write('notes.txt', 'mine\n');
  newJobOf(s, 'scout');

  const brief = readFileSync(join(s.home, 'jobs', '1', 'brief.md'), 'utf8');
  const section = situationOf(brief);
  assert.ok(section, brief);
  assert.ok(brief.indexOf(section) < brief.indexOf('## The task'), 'before the task, beside what is already known');
  assert.match(section, /^Branch: trunk$/m);
  assert.match(section, /^Toolchain: node \d+\.\d+\.\d+$/m, 'package.json is there, so node is said; nothing else is');
  assert.match(section, /^Top level: Makefile notes\.txt package\.json src\/ src\.js status$/m, 'directories are marked');
  assert.doesNotMatch(section, /\.git\b/, 'what is hidden stays out');
  const status = section.split('git status --short:\n')[1].split('\n');
  assert.equal(status.filter((l) => /^ M src\/f\d\d\.js$|^\?\? notes\.txt$/.test(l)).length, 15, 'at most fifteen lines');
  assert.equal(status.at(-1), '… 6 more');
  assert.ok(estimateTokens(section) <= 150, `${estimateTokens(section)} tokens:\n${section}`);
});

test('long paths are cut to the budget and counted; a clean tree says so; outside git there are no git lines', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const files = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`src/a-rather-long-module-name-that-goes-on-${String(i + 1).padStart(2, '0')}.js`, 'one\n']));
  const p = gitProject(s, files);
  for (const file of Object.keys(files)) p.write(file, 'two\n');
  newJobOf(s, 'scout');
  const long = situationOf(readFileSync(join(s.home, 'jobs', '1', 'brief.md'), 'utf8'));
  assert.ok(estimateTokens(long) <= 150, `${estimateTokens(long)} tokens:\n${long}`);
  const shown = long.split('\n').filter((l) => l.startsWith(' M src/')).length;
  assert.ok(shown > 0 && shown < 12, long);
  assert.match(long, new RegExp(`^… ${12 - shown} more$`, 'm'));

  const clean = sandbox();
  clean.routerWillSay('sonnet', 'medium');
  gitProject(clean);
  newJobOf(clean, 'scout');
  assert.match(situationOf(readFileSync(join(clean.home, 'jobs', '1', 'brief.md'), 'utf8')), /^git status --short: clean$/m);

  const plain = sandbox();
  plain.routerWillSay('sonnet', 'medium');
  const dir = join(plain.root, 'proj-plain');
  mkdirSync(join(dir, 'docs'), { recursive: true });
  writeFileSync(join(dir, 'README.md'), 'hello\n');
  plain.sumo(['project', 'add', dir, '--alias', 'checkproj']);
  newJobOf(plain, 'scout');
  const outside = situationOf(readFileSync(join(plain.home, 'jobs', '1', 'brief.md'), 'utf8'));
  assert.match(outside, /^Top level: docs\/ README\.md$/m);
  assert.doesNotMatch(outside, /Branch|git status|Toolchain/);
});
