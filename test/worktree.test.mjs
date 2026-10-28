// A worker that would share a working tree is given a git worktree of its own; several attempts are each given one, and one is kept.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { finish, newJob, treeOf } from '../src/jobs.mjs';
import { runJob } from '../src/loop.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const TASK = `## Goal
Make the thing return 2.
## Check
\`make test\` exits 0.
`;
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';
const NOW = '2026-10-25T12:00:00.000Z';

/** Twelve lines, so a change at one end and a change at the other are far enough apart to merge. */
const SRC = Array.from({ length: 12 }, (_, i) => `export const a${i + 1} = ${i + 1};\n`).join('');
const edited = (text, changes) => Object.entries(changes).reduce((t, [n, v]) => t.replace(`a${n} = ${n};`, `a${n} = ${v};`), text);

/** A committed repository whose one check passes while `status` says ok — in whichever tree it is run. */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), '.PHONY: test\ntest:\n\t@test "$$(cat status)" = ok\n');
  writeFileSync(join(dir, 'status'), 'ok\n');
  writeFileSync(join(dir, 'src.js'), SRC);
  writeFileSync(join(dir, '.gitignore'), 'node_modules/\n');
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return { dir, git, read: (file) => readFileSync(join(dir, file), 'utf8'), write: (file, text) => writeFileSync(join(dir, file), text) };
}

function gitProject(s) {
  const p = gitRepo(join(s.root, 'proj-git'));
  s.sumo(['project', 'add', p.dir, '--alias', 'gitproj']);
  return p;
}

const newWorker = (s, extra = []) => s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'return 2', ...extra], { input: TASK });
/** Closes a job from the CLI; a worker's DONE first passes the check against the task, which answers the first one. */
const close = (s, id, status = 'DONE') => {
  if (status === 'DONE' && !existsSync(join(s.home, 'jobs', String(id), 'checked'))) s.sumo(['job', 'finish', String(id), '--status', 'DONE'], { input: REPORT });
  return s.sumo(['job', 'finish', String(id), '--status', status], { input: REPORT });
};
const treeIn = (s, id) => join(s.home, 'jobs', String(id), 'tree');
/** What the cheap model answers the pick with, in the stand-in's envelope; `null` makes the call fail. */
const pickWillSay = (s, pick, reason) =>
  writeFileSync(
    join(s.root, 'model-answer.json'),
    JSON.stringify(pick === null ? { is_error: true, result: 'rate limited', structured_output: null, usage: {}, total_cost_usd: 0 } : { is_error: false, result: '', structured_output: { pick, reason }, usage: { input_tokens: 900, output_tokens: 30 }, total_cost_usd: 0.003 }),
  );

test('a second worker works in a worktree made from the project as it stands; done, its change is brought back and the tree removed', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  // What the user had going: an edit not committed, a file never added, and something git ignores.
  p.write('src.js', edited(SRC, { 1: 100 }));
  p.write('notes.txt', 'mine\n');
  mkdirSync(join(p.dir, 'node_modules'));
  p.write('node_modules/dep.js', 'installed\n');
  const before = p.git('status', '--porcelain').stdout;

  assert.doesNotMatch(newWorker(s).out, /worktree/);
  assert.equal(existsSync(treeIn(s, 1)), false, 'a worker alone works in the project itself');
  assert.match(s.sumo(['job', 'brief', '1']).out, /Work only inside: \S*proj-git /);

  const second = newWorker(s);
  assert.equal(second.code, 0, second.err);
  const tree = treeIn(s, 2);
  assert.match(second.out, /note: j1 "return 2" is already a worker in proj-git — this one works in a worktree of its own/);
  assert.equal(p.git('status', '--porcelain').stdout, before, "the user's files are as they were");
  assert.equal(p.git('diff', '--cached').stdout, '', "and so is the user's index");
  assert.equal(readFileSync(join(tree, 'src.js'), 'utf8'), edited(SRC, { 1: 100 }), 'the tree starts from the edit not committed');
  assert.equal(readFileSync(join(tree, 'notes.txt'), 'utf8'), 'mine\n', 'and from the file never added');
  // What git ignores is not copied; installed dependencies are linked to the project's own.
  assert.equal(lstatSync(join(tree, 'node_modules')).isSymbolicLink(), true);
  assert.equal(realpathSync(join(tree, 'node_modules')), realpathSync(join(p.dir, 'node_modules')));
  const brief = s.sumo(['job', 'brief', '2']).out;
  assert.ok(brief.includes(`Work only inside: ${tree}   `), brief);
  assert.match(brief, /## Where you work\nj1 "return 2" is another worker open in \S*proj-git, so this job has a git worktree of its own/);
  assert.match(brief, /Files git ignores — build output and the like — were not copied into it\. The project's installed dependencies — node_modules — are its own, linked in/);

  // Its checks are run in its tree, not in the project.
  writeFileSync(join(tree, 'status'), 'broken\n');
  assert.match(s.sumo(['job', 'verify', '2']).out, /^j2 would be REFUSED as DONE:/);
  writeFileSync(join(tree, 'status'), 'ok\n');
  // The work: a line changed, a file added.
  writeFileSync(join(tree, 'src.js'), edited(SRC, { 1: 100, 12: 2 }));
  writeFileSync(join(tree, 'added.js'), 'export const added = true;\n');
  const done = close(s, 2);
  assert.equal(done.code, 0, done.err);
  assert.match(done.out, /^STATUS: DONE — j2\nThe change was applied to \S*proj-git; its worktree is removed\./m);

  assert.equal(p.read('src.js'), edited(SRC, { 1: 100, 12: 2 }), "the work lands on top of the user's own edit");
  assert.equal(p.read('added.js'), 'export const added = true;\n');
  assert.equal(p.read('notes.txt'), 'mine\n');
  assert.equal(p.git('diff', '--cached').stdout, '', 'applied straight onto the files: nothing is staged');
  assert.equal(existsSync(tree), false);
  assert.doesNotMatch(p.git('worktree', 'list').stdout, /jobs\/2\/tree/, "git's record of the tree goes with it");
  assert.match(s.sumo(['job', 'show', '2']).out, /## Worktree\nThe change was applied to/, 'what became of it is in the report');
  assert.match(readFileSync(join(s.home, 'jobs', '2', 'changes.diff'), 'utf8'), /added\.js/, 'and what it changed is kept beside the job');
  assert.match(s.sumo(['job', 'changes', '2']).out, /^2 files changed — /, 'read back from what was kept, not from a project that has moved on');
});

test('a change the project has moved past is not forced in: the tree is kept and said; one that merges is merged', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  newWorker(s);
  newWorker(s);
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 3), 'src.js'), edited(SRC, { 8: 2 }));

  // The same line, changed in the project meanwhile.
  p.write('src.js', edited(SRC, { 12: 3 }));
  const refused = close(s, 2);
  assert.equal(refused.code, 0, refused.err);
  assert.match(refused.out, /The change was NOT applied: it does not apply to \S*proj-git as that stands now\. It is kept in \S+jobs\/2\/tree — bring it over by hand/);
  assert.equal(p.read('src.js'), edited(SRC, { 12: 3 }), 'the project is left exactly as it was, with no conflict markers');
  assert.equal(p.git('diff', '--cached').stdout, '');
  assert.equal(existsSync(treeIn(s, 2)), true);

  // A change two lines off, committed: the patch's context no longer matches, but a three-way merge is clean.
  p.git('checkout', '--', 'src.js');
  p.write('src.js', edited(SRC, { 6: 3 }));
  p.git('commit', '-qam', 'the user moved on');
  const merged = close(s, 3);
  assert.match(merged.out, /The change was applied to \S*proj-git by a three-way merge, and staged; its worktree is removed\./);
  assert.equal(p.read('src.js'), edited(SRC, { 6: 3, 8: 2 }));
  assert.equal(existsSync(treeIn(s, 3)), false);
});

test('a failed or abandoned worker in a worktree leaves its change as changes.diff, and nothing in the project', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  newWorker(s);
  newWorker(s);
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  const failed = close(s, 2, 'FAILED');
  assert.match(failed.out, /^STATUS: FAILED — j2\nIts worktree is removed; what it changed is kept in \S+jobs\/2\/changes\.diff\./m);
  assert.match(readFileSync(join(s.home, 'jobs', '2', 'changes.diff'), 'utf8'), /-export const a12 = 12;\n\+export const a12 = 2;/);
  assert.equal(p.read('src.js'), SRC);
  assert.equal(existsSync(treeIn(s, 2)), false);

  assert.match(s.sumo(['job', 'abandon', '3']).out, /^abandoned j3\nIts worktree is removed/);
  assert.equal(existsSync(treeIn(s, 3)), false);
  assert.equal(p.git('worktree', 'list').stdout.trim().split('\n').length, 1, 'only the project itself is left');
});

test('outside git a second worker still shares the tree, and is told so', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const dir = join(s.root, 'plain');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
  s.sumo(['project', 'add', dir, '--alias', 'plain']);
  s.sumo(['job', 'new', '--project', 'plain', '--title', 'one'], { input: TASK });
  assert.match(s.sumo(['job', 'new', '--project', 'plain', '--title', 'two'], { input: TASK }).out, /two workers in one working tree overwrite each other/);
  assert.equal(existsSync(treeIn(s, 2)), false);
  assert.match(s.sumo(['job', 'new', '--project', 'plain', '--title', 'x', '--attempts', '2'], { input: TASK }).err, /not a git repository with a commit — each attempt needs a worktree of its own/);
});

test('a project in a subdirectory of its repository works in the same subdirectory of the worktree, and its change lands there', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const repo = gitRepo(join(s.root, 'mono'));
  mkdirSync(join(repo.dir, 'pkg'));
  repo.write('pkg/Makefile', '.PHONY: test\ntest:\n\t@test "$$(cat status)" = ok\n');
  repo.write('pkg/status', 'ok\n');
  repo.write('pkg/src.js', SRC);
  repo.git('add', '-A');
  repo.git('commit', '-qm', 'a package');
  repo.write('pkg/loose.txt', 'not added\n');
  s.sumo(['project', 'add', join(repo.dir, 'pkg'), '--alias', 'pkg']);
  s.sumo(['job', 'new', '--project', 'pkg', '--title', 'one'], { input: TASK });
  s.sumo(['job', 'new', '--project', 'pkg', '--title', 'two'], { input: TASK });
  const inside = join(treeIn(s, 2), 'pkg');
  const brief = s.sumo(['job', 'brief', '2']).out;
  assert.ok(brief.includes(`Work only inside: ${inside}   `), brief);
  assert.equal(readFileSync(join(inside, 'loose.txt'), 'utf8'), 'not added\n');
  writeFileSync(join(inside, 'src.js'), edited(SRC, { 12: 2 }));
  assert.match(close(s, 2).out, /The change was applied to \S*mono\/pkg; its worktree is removed\./);
  assert.equal(repo.read('pkg/src.js'), edited(SRC, { 12: 2 }));
  assert.equal(repo.read('src.js'), SRC, 'the rest of the repository is untouched');
});

/** A git project registered in-process, with the router's answer recorded — what a job made and run here needs. */
function inProcess() {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-tree-'));
  const routerAnswer = join(root, 'router.json');
  const pickAnswer = join(root, 'pick.json');
  writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model: 'sonnet', effort: 'medium', reason: 'small' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  const env = { SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log'), SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer, STUB_ANSWER: pickAnswer };
  return { root, env, pickAnswer };
}
const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

test('a run in a worktree: its shell starts there, the project itself cannot be edited, and the run settles the tree once the job closes itself', async () => {
  const { root, env } = inProcess();
  await withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const p = gitRepo(join(root, 'proj'));
      addProject(db, p.dir, { slug: 'proj', now: NOW });
      await newJob(db, { project: 'proj', title: 'first', task: TASK, now: NOW });
      const { job } = await newJob(db, { project: 'proj', title: 'second', task: TASK, now: NOW });
      const tree = treeOf(db, job.id);
      assert.equal(tree.path, join(paths().jobs, String(job.id), 'tree'));
      const real = realpathSync(tree.path);
      const responses = [
        reply('tool_use', [call('t1', 'bash', { command: 'pwd -P' }), call('t2', 'str_replace_based_edit_tool', { command: 'create', path: join(p.dir, 'stray.js'), file_text: 'x\n' })]),
        reply('tool_use', [call('t3', 'str_replace_based_edit_tool', { command: 'create', path: 'added.js', file_text: 'export const added = true;\n' })]),
        reply('tool_use', [call('t4', 'finish', { status: 'DONE', report: REPORT })]),
        reply('tool_use', [call('t5', 'finish', { status: 'DONE', report: REPORT })]),
        reply('end_turn', [{ type: 'text', text: 'closed' }]),
      ];
      const seen = [];
      const outcome = await runJob(db, job.id, { send: async (params) => (seen.push(structuredClone(params)), responses.shift()), now: () => NOW });

      const [pwd, stray] = seen[1].messages.at(-1).content;
      // The first line: off macOS, the first result in a process also says the shell is not sandboxed.
      assert.equal(pwd.content.trim().split('\n')[0], real, 'bash starts in the worktree');
      assert.equal(stray.is_error, true, 'the project belongs to the other worker');
      assert.equal(existsSync(join(p.dir, 'stray.js')), false);
      assert.match(seen[3].messages.at(-1).content[0].content, /is not closed yet — before DONE counts/, 'the first DONE is the check against the task');
      assert.match(seen[4].messages.at(-1).content[0].content, /^STATUS: DONE/, 'its own finish does not settle the tree: the run does, once it ends');
      assert.equal(outcome.job.status, 'done');
      assert.deepEqual(outcome.settled, [`The change was applied to ${db.prepare('SELECT path FROM projects').get().path}; its worktree is removed.`]);
      assert.equal(p.read('added.js'), 'export const added = true;\n');
      assert.equal(existsSync(tree.top), false);
    } finally {
      db.close();
    }
  });
});

test('attempts: sibling workers on one brief, each in a worktree; once all have closed, the pick is brought back and the rest removed', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  const made = s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'return 2', '--attempts', '2'], { input: TASK });
  assert.equal(made.code, 0, made.err);
  assert.match(made.out, /^created j1 \[worker·proj-git·not started\] return 2 \(attempt 1 of 2\)\ncreated j2 \[worker·proj-git·not started\] return 2 \(attempt 2 of 2\)\n/);
  assert.match(made.out, /run each: sumo job run 1 · sumo job run 2 — once all have closed, the best verified one is brought back/);
  assert.match(s.sumo(['job', 'brief', '1']).out, /## Where you work\nSeveral attempts are made at this task, each in a git worktree of its own/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(DISTINCT route_reason) AS n FROM jobs').get().n), 1, 'routed once, for all of them');

  writeFileSync(join(treeIn(s, 1), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 2), 'thing.test.js'), '// the thing returns 2\n');
  pickWillSay(s, 2, 'it also adds a test for the thing');

  const first = close(s, 1);
  assert.equal(first.code, 0, first.err);
  assert.doesNotMatch(first.out, /Picked|applied/, 'the other attempt is still at work');
  assert.equal(existsSync(treeIn(s, 1)), true, 'a verified attempt waits for the others with its tree');
  assert.equal(p.read('src.js'), SRC);

  const last = close(s, 2);
  assert.match(last.out, /j1 done, j2 done; verified done: j1, j2\.\nPicked j2: it also adds a test for the thing\nThe change was applied to \S*proj-git; its worktree is removed\./);
  assert.equal(p.read('src.js'), edited(SRC, { 12: 2 }));
  assert.equal(p.read('thing.test.js'), '// the thing returns 2\n');
  assert.equal(existsSync(treeIn(s, 1)), false, 'the attempt not picked is removed');
  assert.equal(existsSync(treeIn(s, 2)), false);
  assert.match(readFileSync(join(s.home, 'jobs', '1', 'changes.diff'), 'utf8'), /a12 = 2/, 'and what it did is kept');
  assert.match(s.sumo(['job', 'show', '1']).out, /## Attempts\nj1 done, j2 done; verified done: j1, j2\.\nPicked j2: it also adds a test/, "the pick is recorded in the first attempt's report");

  const asked = s.modelWasShown();
  assert.equal(asked.model, 'sonnet');
  assert.deepEqual(asked.schema.required, ['pick', 'reason']);
  assert.match(asked.prompt, /^## The task\n## Goal\nMake the thing return 2\.[\s\S]*## Attempt 1\ndiff --git a\/src\.js[\s\S]*## Attempt 2\n[\s\S]*thing\.test\.js/);
  assert.deepEqual(s.sql((db) => ({ ...db.prepare(`SELECT kind, model, ok, job_id, note FROM model_runs WHERE kind = 'pick'`).get() })), { kind: 'pick', model: 'sonnet', ok: 1, job_id: 1, note: 'picked attempt 2' });
});

test('attempts: no pick from the model takes the smallest change; one verified is simply kept; none verified brings nothing back', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'return 2', '--attempts', '3'], { input: TASK });
  writeFileSync(join(treeIn(s, 1), 'src.js'), edited(SRC, { 12: 2, 11: 2 }));
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 3), 'status'), 'broken\n');
  pickWillSay(s, null);
  close(s, 1);
  assert.match(close(s, 3).err, /j3 is not done — the project's checks were run/, 'a DONE that fails its checks is refused');
  assert.match(close(s, 3, 'FAILED').out, /Not verified done, so not a candidate: its worktree is removed/);
  const last = close(s, 2);
  assert.match(last.out, /j1 done, j2 done, j3 failed; verified done: j1, j2\.\nPicked j2: the smallest change — no pick came back \(model call failed: rate limited\)/);
  assert.equal(p.read('src.js'), edited(SRC, { 12: 2 }));

  // One verified and one failed: the one is kept without asking anybody.
  s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'again', '--attempts', '2'], { input: TASK });
  writeFileSync(join(treeIn(s, 4), 'added.js'), 'x\n');
  close(s, 5, 'FAILED');
  assert.match(close(s, 4).out, /Picked j4: the only one verified done\nThe change was applied/);
  assert.equal(p.read('added.js'), 'x\n');

  s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'once more', '--attempts', '2'], { input: TASK });
  close(s, 6, 'FAILED');
  assert.match(s.sumo(['job', 'abandon', '7']).out, /j6 failed, j7 abandoned; verified done: none\.\nNone was verified done, so nothing was brought back\./);
  assert.equal(p.git('worktree', 'list').stdout.trim().split('\n').length, 1);

  assert.match(s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'x', '--attempts', '4'], { input: TASK }).err, /--attempts is 2 or 3/);
  assert.match(s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'x', '--agent', 'scout', '--attempts', '2'], { input: TASK }).err, /--attempts goes with a worker/);
});

test('attempts delegated in the chat run side by side and come back as one answer, the pick first', async () => {
  const { root, env, pickAnswer } = inProcess();
  writeFileSync(pickAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { pick: 1, reason: 'the smaller of two equal fixes' }, usage: {}, total_cost_usd: 0 }));
  await withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const p = gitRepo(join(root, 'simba'));
      addProject(db, p.dir, { slug: 'simba', now: NOW });
      const chatReplies = [reply('tool_use', [call('t1', 'delegate', { agent: 'worker', project: 'simba', title: 'return 2', task: TASK, attempts: 2 })]), reply('end_turn', [{ type: 'text', text: 'one kept' }])];
      const seen = [];
      // Each attempt does its work in its own tree and closes itself, as its `finish` would from its shell.
      const send = async (params) => {
        seen.push(structuredClone(params));
        const id = Number(/^# Job j(\d+)/.exec(params.messages[0]?.content?.[0]?.text ?? '')?.[1]);
        if (!id) return chatReplies.shift();
        writeFileSync(join(treeOf(db, id).path, 'src.js'), edited(SRC, id === 1 ? { 12: 2 } : { 12: 2, 11: 2 }));
        assert.throws(() => finish(db, id, { status: 'DONE', report: REPORT }, NOW), /is not closed yet/, 'the first DONE is the check against the task');
        finish(db, id, { status: 'DONE', report: REPORT }, NOW);
        return reply('end_turn', [{ type: 'text', text: `j${id} closed` }]);
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      assert.equal((await session.say('make the thing return 2, two ways')).text, 'one kept');

      const results = seen.at(-1).messages.at(-1).content;
      assert.equal(results.length, 1, 'one answer for both attempts');
      assert.match(results[0].content, /^Attempts j1, j2:\nj1 done, j2 done; verified done: j1, j2\.\nPicked j1: the smaller of two equal fixes\nThe change was applied to /);
      assert.match(results[0].content, /STATUS: DONE — j1[\s\S]*STATUS: DONE — j2/, 'and then how each went');
      assert.equal(p.read('src.js'), edited(SRC, { 12: 2 }));
      assert.equal(existsSync(join(paths().jobs, '2', 'tree')), false);
    } finally {
      db.close();
    }
  });
});
