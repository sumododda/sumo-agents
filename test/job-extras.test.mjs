// What a job carries besides its brief: the plan it keeps, a flaky check not blamed on it, a scout's answer reused, the project's dependencies in a worktree.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { note, planOf } from '../src/jobs.mjs';
import { runJob } from '../src/loop.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { bringBack, dropTree, makeTree, treeDiff } from '../src/worktree.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-10-26T12:00:00.000Z';
const TASK = `## Goal
Make the thing return 2.
## Check
\`make test\` exits 0.
`;
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';

/** A project on disk, registered, with one running worker routed to a model — the least a run needs. */
function seed(db) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-extras-'));
  writeFileSync(join(root, 'a.txt'), 'one\n');
  const { project: { slug } } = addProject(db, root, { slug: 'demo', now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, ?, 'worker', 'running', 's1', ?, ?, 'sonnet', 'medium', 'test')`)
    .run(slug, 'demo job', NOW, NOW);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — demo job\n\n## The task\nsay hello\n`);
  return { root, id };
}

const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 } });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

test("a job's plan is the latest checklist among its notes; a note without one leaves it as it was", async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      assert.equal(planOf(id), null, 'no notes, no plan');
      note(db, id, 'looked around; next: write the plan', NOW);
      assert.equal(planOf(id), null, 'a note with no checklist is not a plan');
      note(db, id, 'The plan:\n- [ ] read the parser\n- [ ] fix the off-by-one\n- [ ] add a test', NOW);
      assert.equal(planOf(id), '- [ ] read the parser\n- [ ] fix the off-by-one\n- [ ] add a test');
      note(db, id, 'parser read; next: the fix', NOW);
      assert.equal(planOf(id), '- [ ] read the parser\n- [ ] fix the off-by-one\n- [ ] add a test', 'a progress line does not erase the plan');
      note(db, id, '- [x] read the parser\n* [X] fix the off-by-one\n- [ ] add a test', NOW);
      assert.equal(planOf(id), '- [x] read the parser\n* [X] fix the off-by-one\n- [ ] add a test', 'the list noted again, ticked, is where it stands');
      note(db, id, Array.from({ length: 25 }, (_, i) => `- [ ] step ${i + 1}`).join('\n'), NOW);
      assert.match(planOf(id), /^- \[ \] step 1\n[\s\S]*- \[ \] step 20\n… 5 more steps$/, 'a long plan is cut to a reminder');
    } finally {
      db.close();
    }
  });
});

test('a running job is shown its plan again every ten requests, after the results of that round, as its notes have it then', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      note(db, id, '- [ ] read\n- [ ] fix\n- [ ] test', NOW);
      const seen = [];
      let n = 0;
      // Each command is new, so this is work going on, not a loop.
      const send = async (params) => {
        seen.push(structuredClone(params.messages.at(-1)));
        n++;
        if (n === 12) note(db, id, '- [x] read\n- [x] fix\n- [ ] test', NOW);
        return n <= 21 ? reply('tool_use', [call(`t${n}`, 'bash', { command: `echo ${n}` })]) : reply('end_turn', [{ type: 'text', text: 'stopping' }]);
      };
      await runJob(db, id, { send, now: () => NOW });
      const plans = seen.map((m, i) => [i, m.content.filter((b) => b.type === 'text' && /^Your plan/.test(b.text))]).filter(([, found]) => found.length > 0);
      assert.deepEqual(plans.map(([i]) => i), [10, 20], 'with the 11th and 21st requests: after the 10th and the 20th rounds of results');
      const [, [first]] = plans[0];
      assert.deepEqual(seen[10].content.map((b) => b.type), ['tool_result', 'text'], 'one short block, after the results');
      assert.match(first.text, /\n- \[ \] read\n- \[ \] fix\n- \[ \] test$/);
      assert.match(plans[1][1][0].text, /\n- \[x\] read\n- \[x\] fix\n- \[ \] test$/, 'the plan as it stands then');
    } finally {
      db.close();
    }
  });
});

test('a worker is told to keep a plan of several steps as a checklist note, and tick it as it goes', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = join(s.root, 'proj');
  mkdirSync(dir);
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  s.sumo(['project', 'add', dir, '--alias', 'proj']);
  s.sumo(['job', 'new', '--project', 'proj', '--title', 'return 2'], { input: TASK });
  assert.match(s.sumo(['job', 'brief', '1']).out, /- A task of several steps: `note` the plan first, as a checklist — one `- \[ \] <step>` a line — and .* ticked `- \[x\]`/);
});

/**
 * A committed project whose one check passes or fails on each run as the next word of a list kept outside it — so running
 * it changes nothing in the tree. `pass`; `fail`, the same failure every time but for how long it took; `other`, another one.
 */
function flakyProject(s, outcomes) {
  const queue = join(s.root, 'outcomes');
  const script = join(s.root, 'check.sh');
  writeFileSync(queue, `${outcomes.join('\n')}\n`);
  writeFileSync(
    script,
    `o=$(head -n 1 "${queue}"); tail -n +2 "${queue}" > "${queue}.next"; mv "${queue}.next" "${queue}"
case "$o" in
  pass) echo "ok 1 - the thing is 2"; exit 0 ;;
  fail) echo "not ok 1 - the thing is 2 ($$ms)"; exit 1 ;;
  *) echo "not ok 2 - the other thing"; exit 1 ;;
esac
`,
  );
  const dir = join(s.root, 'proj-git');
  mkdirSync(dir);
  writeFileSync(join(dir, 'Makefile'), `.PHONY: test\ntest:\n\t@sh ${script}\n`);
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  s.sumo(['project', 'add', dir, '--alias', 'gitproj']);
  return { dir, left: () => readFileSync(queue, 'utf8').split('\n').filter(Boolean), runs: (more) => writeFileSync(queue, `${more.join('\n')}\n`) };
}

const newWorker = (s, title = 'return 2') => s.sumo(['job', 'new', '--project', 'gitproj', '--title', title], { input: TASK });
/** A worker's DONE takes two: the first is answered with the check against the task, and nothing is run. */
const done = (s, id) => {
  assert.match(s.sumo(['job', 'finish', String(id), '--status', 'DONE'], { input: REPORT }).err, /is not closed yet/);
  return s.sumo(['job', 'finish', String(id), '--status', 'DONE'], { input: REPORT });
};

test('a check that fails at the baseline is run once more: two runs that disagree make it flaky, and a failure of it then is not blamed on the worker', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = flakyProject(s, ['fail', 'pass', 'fail']);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` is FLAKY — /);
  assert.deepEqual(p.left(), ['fail'], 'run twice at the baseline, not more');
  assert.match(s.sumo(['job', 'brief', '1']).out, /## Already failing before this job began[^\n]*\n- `make test` — flaky: /);
  const closed = done(s, 1);
  assert.equal(closed.code, 0, closed.err);
  assert.deepEqual(p.left(), [], 'a check recorded flaky is not run again at the end: its failure is not held against the job anyway');
  assert.match(closed.out, /^ {2}look at: `make test` failed, and it was flaky when this job began — DONE is not refused on it/m, 'and the verdict names it');
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'report.md'), 'utf8'), /- `make test` was flaky/);
});

test('two failing runs at the baseline that fail the same way — for all their timings — are already failing; two that fail differently are flaky', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = flakyProject(s, ['fail', 'fail']);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` ALREADY FAILS — not yours to fix/);
  assert.deepEqual(p.left(), []);
  s.sumo(['job', 'abandon', '1']);

  p.runs(['fail', 'other']);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '2']).out, /^`make test` is FLAKY — /);
  const state = JSON.parse(readFileSync(join(s.home, 'jobs', '2', 'verify.json'), 'utf8'));
  assert.equal(state.baseline[0].flaky, true, 'recorded in the baseline');
  assert.equal(state.baseline[0].ok, false);
  assert.match(readFileSync(state.baseline[0].again, 'utf8'), /not ok 2 - the other thing/, 'the second run keeps a log of its own');
});

test('a check that passed at the baseline and fails at the end is run once more: passing then, it is flaky and DONE goes through, said in one line; failing again, DONE is refused', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = flakyProject(s, ['pass']);
  newWorker(s);
  assert.match(s.sumo(['job', 'baseline', '1']).out, /^`make test` passes$/m);
  assert.deepEqual(p.left(), [], 'a passing check is not run again');

  p.runs(['fail', 'pass']);
  const verdict = s.sumo(['job', 'verify', '1']);
  assert.match(verdict.out, /^j1 would be accepted as DONE:/, verdict.out);
  const said = verdict.out.split('\n').filter((l) => /flaky/.test(l));
  assert.deepEqual(said, ['  `make test` was flaky', '  look at: `make test` failed, then passed when run again — flaky, so DONE is not refused on it; read ' + join(s.home, 'jobs', '1', 'verify-test.txt')]);
  assert.deepEqual(p.left(), []);

  p.runs(['fail', 'fail', 'pass']);
  writeFileSync(join(p.dir, 'src.js'), 'export const thing = 2;\n');
  const refused = done(s, 1);
  assert.equal(refused.code, 1, refused.out);
  assert.match(refused.err, /blocking: `make test` fails, and it passed when this job began/);
  assert.deepEqual(p.left(), ['pass'], 'run once more, never twice');
});

test('a scout asking much what an earlier one answered in the last two weeks is pointed at that report — the two closest, done scouts on this project only', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = join(s.root, 'proj');
  const elsewhere = join(s.root, 'other');
  mkdirSync(dir);
  mkdirSync(elsewhere);
  s.sumo(['project', 'add', dir, '--alias', 'proj']);
  s.sumo(['project', 'add', elsewhere, '--alias', 'other']);
  const scout = (title, project = 'proj') => s.sumo(['job', 'new', '--project', project, '--title', title, '--agent', 'scout'], { input: 'Find out.' });
  const closed = (id, status, daysAgo) => {
    s.sumo(['job', 'finish', String(id), '--status', status], { input: '## Summary\nfound it\n' });
    s.sql((db) => db.prepare('UPDATE jobs SET updated_at = ? WHERE id = ?').run(new Date(Date.now() - daysAgo * 86_400_000).toISOString(), id));
  };
  scout('how does the auth token refresh work'); // j1: auth token refresh work — 3 of 4 shared
  closed(1, 'DONE', 5);
  scout('auth token refresh'); // j2: all 3 shared
  closed(2, 'DONE', 3);
  scout('refresh the auth token cache'); // j3: 3 of 4 shared, and newer than j1
  closed(3, 'DONE', 1);
  scout('auth token refresh flow'); // j4: failed
  closed(4, 'FAILED', 1);
  scout('auth token refresh client'); // j5: too long ago
  closed(5, 'DONE', 20);
  scout('auth token refresh client', 'other'); // j6: another project
  closed(6, 'DONE', 1);
  scout('auth middleware order'); // j7: 1 of 3 shared
  closed(7, 'DONE', 1);

  const asked = scout('explain how the auth token refresh works in the client');
  assert.equal(asked.code, 0, asked.err);
  const brief = s.sumo(['job', 'brief', '8']).out;
  const day = (daysAgo) => new Date(Date.now() - daysAgo * 86_400_000).toISOString().slice(0, 10);
  const section = /## Asked before\n([\s\S]*?)(?:\n\n|\n?$)/.exec(brief)?.[1];
  assert.deepEqual(section?.split('\n'), [
    `A scout answered a similar question on ${day(3)} — j2 "auth token refresh": read it with \`sumo job show 2\` and reuse what still holds.`,
    `A scout answered a similar question on ${day(1)} — j3 "refresh the auth token cache": read it with \`sumo job show 3\` and reuse what still holds.`,
  ]);

  assert.doesNotMatch(s.sumo(['job', 'brief', String(Number(/created j(\d+)/.exec(scout('where are the database migrations kept').out)[1]))]).out, /Asked before/, 'nothing alike, nothing said');
});

/** A committed repository that ignores its installed dependencies, with some installed. */
function withDependencies(dir) {
  mkdirSync(join(dir, 'node_modules', 'dep'), { recursive: true });
  mkdirSync(join(dir, '.venv', 'bin'), { recursive: true });
  // One ignored as a folder only, as most projects write it — a link of that name does not match it — and one by name.
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n.venv\n');
  writeFileSync(join(dir, 'Makefile'), '.PHONY: test\ntest:\n\t@test -f node_modules/dep/index.js\n');
  writeFileSync(join(dir, 'src.js'), 'export const thing = 1;\n');
  writeFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'installed\n');
  writeFileSync(join(dir, '.venv', 'bin', 'python'), 'installed\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return git;
}

test("a worktree links the project's installed dependencies instead of going without them; the change brought back never holds the links, and removing the tree never follows them", () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-deps-'));
  const project = join(root, 'proj');
  mkdirSync(project);
  const git = withDependencies(project);
  const exclude = readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8');
  const tree = makeTree(project, join(root, 'tree'));
  assert.deepEqual(tree.linked, ['node_modules', '.venv']);
  for (const name of ['node_modules', '.venv']) {
    assert.ok(lstatSync(join(tree.path, name)).isSymbolicLink(), name);
    assert.equal(realpathSync(join(tree.path, name)), realpathSync(join(project, name)), `${name} is the project's own`);
  }
  assert.equal(existsSync(join(tree.path, 'venv')), false, 'only the ones the project has');
  const inTree = (...args) => spawnSync('git', ['-C', tree.path, ...args], { encoding: 'utf8' }).stdout;
  assert.equal(inTree('status', '--porcelain'), '', 'the links are nothing git sees as new or changed');
  assert.equal(inTree('ls-files', '--others', '--exclude-standard'), '');
  assert.equal(readFileSync(join(project, '.git', 'info', 'exclude'), 'utf8'), exclude, "the user's own exclude file is left alone");

  // The work, and a link replaced the way an install would replace it: neither link is part of the change.
  writeFileSync(join(tree.path, 'src.js'), 'export const thing = 2;\n');
  rmSync(join(tree.path, 'node_modules'));
  mkdirSync(join(tree.path, 'node_modules'));
  writeFileSync(join(tree.path, 'node_modules', 'other.js'), 'x\n');
  rmSync(join(tree.path, '.venv'));
  const diff = treeDiff(tree);
  assert.match(diff, /^diff --git a\/src\.js b\/src\.js$/m);
  assert.doesNotMatch(diff, /node_modules|\.venv/);

  assert.deepEqual(bringBack(project, tree, root), { applied: true, merged: false });
  assert.equal(readFileSync(join(project, 'src.js'), 'utf8'), 'export const thing = 2;\n');
  assert.equal(git('status', '--porcelain').stdout, ' M src.js\n');
  dropTree(project, tree.top);
  assert.equal(existsSync(tree.top), false);
  assert.equal(readFileSync(join(project, 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n', 'removing the tree did not follow the link');

  // A tree git will not let go of is deleted by hand: that does not follow a link either.
  const again = makeTree(project, join(root, 'again'));
  dropTree(join(root, 'not-a-repository'), again.top);
  assert.equal(existsSync(again.top), false);
  assert.equal(readFileSync(join(project, 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n');
  assert.equal(readFileSync(join(project, '.venv', 'bin', 'python'), 'utf8'), 'installed\n');
});

test("a second worker's checks run in its worktree with the project's dependencies, and its brief says they are the project's own and read-only", () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = join(s.root, 'proj-git');
  mkdirSync(dir);
  withDependencies(dir);
  s.sumo(['project', 'add', dir, '--alias', 'gitproj']);
  newWorker(s, 'one');
  newWorker(s, 'two');
  const brief = s.sumo(['job', 'brief', '2']).out;
  assert.match(brief, /## Where you work\n.*Files git ignores — build output and the like — were not copied into it\. The project's installed dependencies — node_modules, \.venv — are its own, linked in: the checks run with them, and they are read-only here; if one must be added or changed, say so in the report\./);
  assert.match(s.sumo(['job', 'baseline', '2']).out, /^`make test` passes$/m, 'the checks find the dependencies in the tree');
  writeFileSync(join(s.home, 'jobs', '2', 'tree', 'src.js'), 'export const thing = 2;\n');
  const closed = done(s, 2);
  assert.equal(closed.code, 0, closed.err);
  assert.match(closed.out, /The change was applied to \S*proj-git; its worktree is removed\./);
  assert.equal(readFileSync(join(dir, 'src.js'), 'utf8'), 'export const thing = 2;\n');
  assert.equal(readFileSync(join(dir, 'node_modules', 'dep', 'index.js'), 'utf8'), 'installed\n');
  assert.equal(lstatSync(join(dir, 'node_modules')).isSymbolicLink(), false, "the project's own folder is still a folder");
});
