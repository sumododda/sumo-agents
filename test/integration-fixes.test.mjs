// What a review of the worktree change found where its parts meet: a tree's change kept out of a project another worker is
// at work in, a reviewer shown the tree's own change, sumo's own warnings never bought off with a dearer retry, a job's
// background stopped before its tree is settled, only a worker at work counted, the checks in the sandbox, a hooks
// directory git's config names kept read-only, git's reason said, a settle that threw tried again, no review outside git.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODEL_IDS } from '../src/catalog.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { attemptsSettled, finish, newJob, readState, runFollowed, settle, treeOf } from '../src/jobs.mjs';
import { runJobTool } from '../src/jobtools.mjs';
import { contextFor, runJob, runLines } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { costOf } from '../src/model.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject, getProject } from '../src/projects.mjs';
import { readOnlyPlaces, unsandboxable } from '../src/sandbox.mjs';
import { childEnv, runBash, runEditor } from '../src/tools.mjs';
import { bringBack, makeTree } from '../src/worktree.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const TASK = '## Goal\nMake the thing return 2.\n## Check\n`make test` exits 0.\n';
const REPORT = '## Summary\nThe thing returns 2.\n## Files changed\nsrc.js — returns 2\n## Check\n`make test` → ok\n';
const NOW = '2026-10-26T12:00:00.000Z';
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
  return { ...p, path: s.sql((db) => db.prepare('SELECT path FROM projects').get().path) };
}
const newWorker = (s) => s.sumo(['job', 'new', '--project', 'gitproj', '--title', 'return 2'], { input: TASK });
/** Closes a job from the CLI; a worker's DONE first passes the check against the task, which answers the first one. */
const close = (s, id, status = 'DONE') => {
  if (status === 'DONE' && !existsSync(join(s.home, 'jobs', String(id), 'checked'))) s.sumo(['job', 'finish', String(id), '--status', 'DONE'], { input: REPORT });
  return s.sumo(['job', 'finish', String(id), '--status', status], { input: REPORT });
};
const treeIn = (s, id) => join(s.home, 'jobs', String(id), 'tree');

/** A fresh home with one git project, `proj`, and the router answering sonnet/medium: what a job made and run in-process needs. */
async function inProcess(fn) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-fixes-'));
  const routerAnswer = join(root, 'router.json');
  writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model: 'sonnet', effort: 'medium', reason: 'small' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  const env = { SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log'), SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer, STUB_ANSWER: join(root, 'pick.json') };
  return withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const p = gitRepo(join(root, 'proj'));
      addProject(db, p.dir, { slug: 'proj', now: NOW });
      return await fn({ db, p, root, path: getProject(db, 'proj').path });
    } finally {
      db.close();
      await closeMcp();
    }
  });
}
const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage, model: MODEL_IDS.sonnet });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const runLock = (id) => join(paths().jobs, String(id), 'run.lock');
/** Closes a worker in-process the way its `finish` would: the first DONE is the check against the task, the second is verified. */
const done = (db, id) => {
  assert.throws(() => finish(db, id, { status: 'DONE', report: REPORT }, NOW), /is not closed yet/);
  return finish(db, id, { status: 'DONE', report: REPORT }, NOW);
};

test('a worktree job done while another worker is at work in the project is not brought into it: kept as a patch, with the command that applies it once that one is done', () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  newWorker(s);
  // j1 is being run: its run lock names a live process.
  writeFileSync(join(s.home, 'jobs', '1', 'run.lock'), String(process.pid));
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 2), 'added.js'), 'export const added = true;\n');
  const closed = close(s, 2);
  assert.equal(closed.code, 0, closed.err);
  const dir = join(s.home, 'jobs', '2');
  const said = `The change was NOT applied: j1 "return 2" is still working in ${p.path}, and the change would land under it — its start, its checks and its review would count it as its own. Its worktree is removed; what it changed is kept in ${dir}/changes.diff, and whole as a patch: once j1 is done, git -C ${p.path} apply ${dir}/change.patch`;
  assert.ok(closed.out.includes(`STATUS: DONE — j2\n${said}\n`), closed.out);
  assert.equal(p.read('src.js'), SRC, "j1's files are as it left them");
  assert.equal(existsSync(join(p.dir, 'added.js')), false);
  assert.equal(existsSync(treeIn(s, 2)), false, 'the tree is removed');
  assert.ok(s.sumo(['job', 'show', '2']).out.includes(`## Worktree\n${said}`), 'and the report says so');
  const kept = readFileSync(join(dir, 'changes.diff'), 'utf8');
  assert.ok(kept.includes('+export const a12 = 2;') && kept.includes('+++ b/added.js'), 'a reviewer reads the change as ever');

  // Once j1 is done, the command said brings the change over whole.
  rmSync(join(s.home, 'jobs', '1', 'run.lock'));
  execFileSync('git', ['-C', p.path, 'apply', join(dir, 'change.patch')]);
  assert.equal(p.read('src.js'), edited(SRC, { 12: 2 }));
  assert.equal(p.read('added.js'), 'export const added = true;\n');
});

test("a reviewer of a worktree job is handed that job's own change as it was kept, not the project measured against the tree's start", () => {
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  // What the user had that git does not hold: installed dependencies, and a file never added.
  mkdirSync(join(p.dir, 'node_modules'));
  p.write('node_modules/dep.js', 'installed\n');
  p.write('notes.txt', 'mine\n');
  newWorker(s);
  newWorker(s);
  // The brief says what the linked dependencies cannot show: a workspace package through them is the project's.
  assert.match(s.sumo(['job', 'brief', '2']).out, /linked in: the checks run with them, and they are read-only here; if one must be added or changed, say so in the report\. A workspace package or an editable install reached through them is the project's copy, not this tree's: a check that loads one tests the project's code, not your change to it\./);
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  writeFileSync(join(treeIn(s, 2), 'added.js'), 'export const added = true;\n');
  assert.match(close(s, 2).out, /The change was applied to \S+; its worktree is removed\./);

  const made = s.sumo(['job', 'new', '--project', 'gitproj', '--agent', 'reviewer', '--reviews', '2', '--title', 'judge'], { input: 'Judge it.' });
  assert.equal(made.code, 0, made.err);
  const diff = readFileSync(join(s.home, 'jobs', '3', 'changes.diff'), 'utf8');
  assert.match(diff, /-export const a12 = 12;\n\+export const a12 = 2;/);
  assert.match(diff, /added\.js/);
  assert.doesNotMatch(diff, /node_modules|notes\.txt/, 'nothing the job did not do');
  assert.match(s.sumo(['job', 'brief', '3']).out, /The whole change, 2 files: \S+\/jobs\/3\/changes\.diff/);
});

test("a first attempt sumo told to close — near its budget or its time — and closed FAILED is not retried on a dearer route with all of it fresh; the report says why", async () => {
  await inProcess(async ({ db }) => {
    const usage = { input_tokens: 100, output_tokens: 10 };
    setMeta(db, 'config.jobs.budget', String(1.1 * costOf(MODEL_IDS.sonnet, usage)));
    const tries = async (now, onFirst) => {
      const { job } = await newJob(db, { project: 'proj', title: 'return 2', task: TASK, now: NOW });
      let n = 0;
      const send = async (params) => {
        if (++n === 1) {
          onFirst?.();
          return reply('tool_use', [call('t1', 'bash', { command: 'echo working' })], usage);
        }
        const told = params.messages.at(-1).content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
        assert.match(told, /Close it with `finish` now/, 'the run was told to close');
        finish(db, job.id, { status: 'FAILED', report: '## Summary\nStopped where it stands.\n' }, NOW);
        return reply('end_turn', [{ type: 'text', text: 'closed' }], usage);
      };
      const ran = await runFollowed(db, job.id, async (id) => runLines(await runJob(db, id, { send, now })), { now });
      return { id: job.id, ran };
    };

    const broke = await tries(() => NOW);
    assert.deepEqual(broke.ran.map((step) => step.id), [broke.id, null]);
    const line = `j${broke.id} failed on sonnet/medium after it was told to close near its budget: it is not retried one step up, which would start again on a dearer route with a fresh budget. To retry it anyway: sumo job retry ${broke.id}`;
    assert.equal(broke.ran[1].line, line);
    assert.ok(readFileSync(join(paths().jobs, String(broke.id), 'report.md'), 'utf8').includes(`## Not retried\n${line}\n`));

    // The same near its time: the first request takes nine of its ten minutes.
    setMeta(db, 'config.jobs.budget', '0');
    setMeta(db, 'config.jobs.minutes', '10');
    let clock = Date.parse(NOW);
    const late = await tries(() => new Date(clock).toISOString(), () => (clock += 9 * 60_000));
    assert.deepEqual(late.ran.map((step) => step.id), [late.id, null]);
    assert.match(late.ran[1].line, new RegExp(`^j${late.id} failed on sonnet/medium after it was told to close near its time limit: it is not retried one step up, which would start again on a dearer route with a fresh time limit\\.`));
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE retry_of IS NOT NULL`).get().n, 0, 'no retry was made');
  });
});

test('what a job left running in the background is stopped before its worktree is settled: nothing of it is there when the change lands', async () => {
  await inProcess(async ({ db, p, root }) => {
    await newJob(db, { project: 'proj', title: 'first', task: TASK, now: NOW });
    const { job } = await newJob(db, { project: 'proj', title: 'second', task: TASK, now: NOW });
    assert.ok(treeOf(db, job.id));
    const seen = join(root, 'seen');
    // A watcher left running, as a dev server would be: it notes it if it is still there when the change reaches the project.
    const watcher = `while :; do [ -e ${p.dir}/added.js ] && echo seen > ${seen}; sleep 0.005; done &`;
    const responses = [
      reply('tool_use', [call('t1', 'bash', { command: watcher }), call('t2', 'str_replace_based_edit_tool', { command: 'create', path: 'added.js', file_text: 'export const added = true;\n' })]),
      reply('tool_use', [call('t3', 'finish', { status: 'DONE', report: REPORT })]),
      reply('tool_use', [call('t4', 'finish', { status: 'DONE', report: REPORT })]),
      reply('end_turn', [{ type: 'text', text: 'closed' }]),
    ];
    const outcome = await runJob(db, job.id, { send: async () => responses.shift(), now: () => NOW });
    assert.match(outcome.settled[0], /^The change was applied to /);
    assert.equal(p.read('added.js'), 'export const added = true;\n');
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(existsSync(seen), false, 'the watcher was gone before the change was brought back');
  });
});

test('only a worker at work sends the next one into a worktree: one a stop left open does not, nor one whose lock is a dead process\'s; one made minutes ago still does', async () => {
  await inProcess(async ({ db }) => {
    const make = (title, minutes) => newJob(db, { project: 'proj', title, task: TASK, now: new Date(Date.parse(NOW) + minutes * 60_000).toISOString() });
    const crowded = (made) => made.warnings.filter((w) => /already a/.test(w));
    await make('stopped', 0);
    // An hour on, j1 is still open — its run was stopped at its budget — but nobody works it.
    const alone = await make('alone', 60);
    assert.equal(treeOf(db, alone.job.id), null, 'it works in the project itself');
    assert.deepEqual(crowded(alone), []);
    // A lock left by a process that died is nobody at work.
    writeFileSync(runLock(1), String(2 ** 22));
    const after = await make('after a crash', 120);
    assert.equal(treeOf(db, after.job.id), null);
    assert.deepEqual(crowded(after), []);
    // Run again, its lock held by a live process, j1 is at work.
    writeFileSync(runLock(1), String(process.pid));
    const beside = await make('beside', 180);
    assert.ok(treeOf(db, beside.job.id), 'given a worktree of its own');
    assert.match(crowded(beside)[0] ?? '', /^note: j1 "stopped" is already a worker in proj — this one works in a worktree of its own/);
    // One made a minute ago, not yet run, still counts: two made at once never share the project.
    const next = await make('next', 181);
    assert.ok(treeOf(db, next.job.id));
    assert.match(crowded(next)[0] ?? '', new RegExp(`^note: j${beside.job.id} "beside" is already a worker in proj`));
  });
});

test("a job's checks run in the sandbox its shell is in: a test cannot write git's hooks, and what the checks found is still recorded", { skip: unsandboxable() ?? false }, async () => {
  await inProcess(async ({ db, p }) => {
    // A check that writes a hook, as a test the model wrote could; it passes either way.
    p.write('Makefile', '.PHONY: test\ntest:\n\t@echo "touch owned" > .git/hooks/pre-commit; test "$$(cat status)" = ok\n');
    p.git('commit', '-qam', 'a check that writes a hook');
    const { job } = await newJob(db, { project: 'proj', title: 'return 2', task: TASK, now: NOW });
    const ctx = contextFor(getProject(db, 'proj'), { jobId: job.id, sandbox: true });
    const out = await runJobTool({ id: 'c1', name: 'baseline', input: {} }, { job, ctx });
    assert.equal(existsSync(join(p.dir, '.git', 'hooks', 'pre-commit')), false, 'the hook was not written');
    assert.equal(out.content, '`make test` passes', out.content);
    assert.equal(readState(db, job.id).baseline.length, 1, 'the baseline is written in the sumo home');
  });
});

test("a hooks directory git's config names — husky's .husky/_ — is kept from the shell and the editor as .git/hooks is", { skip: unsandboxable() ?? false }, async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-hooks-path-')));
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['config', 'core.hooksPath', '.husky/_'], { cwd: root });
  const hooks = join(root, '.husky', '_');
  mkdirSync(hooks, { recursive: true });
  assert.deepEqual(readOnlyPlaces([root]), [join(root, '.git', 'hooks'), join(root, '.git', 'config'), hooks]);
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }), sandbox: true };
  for (const command of ['echo "curl example.com" > .husky/_/pre-commit', 'mv .husky/_ .husky/aside']) {
    const out = await runBash({ command }, ctx);
    assert.equal(out.isError, true, command);
    assert.match(out.content, /operation not permitted/i, command);
  }
  assert.equal(existsSync(join(hooks, 'pre-commit')), false);
  assert.match(runEditor({ command: 'create', path: join(hooks, 'pre-commit'), file_text: '#!/bin/sh\n' }, ctx).content, /git's own hooks or configuration/);
  assert.deepEqual(await runBash({ command: 'echo x > .husky/notes.txt && echo wrote' }, ctx), { content: 'wrote', isError: false }, 'the rest of the project is written as ever');

  // One that is not there yet is kept all the same, by the path git would run it from.
  const other = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-hooks-path-')));
  execFileSync('git', ['init', '-q'], { cwd: other });
  execFileSync('git', ['config', 'core.hooksPath', 'tools/hooks'], { cwd: other });
  assert.ok(readOnlyPlaces([other]).includes(join(other, 'tools', 'hooks')));
});

test("a change that cannot be brought back says git's own reason, and no three-way merge is tried over edits not staged", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-bring-back-')));
  const proj = join(root, 'proj');
  mkdirSync(proj);
  const g = (...args) => execFileSync('git', ['-C', proj, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...args], { encoding: 'utf8' });
  const lines = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`);
  const text = (changes) => `${lines.map((l, i) => changes[i + 1] ?? l).join('\n')}\n`;
  writeFileSync(join(proj, 'f.txt'), text({}));
  g('init', '-q');
  g('add', '-A');
  g('commit', '-qm', 'start');
  // The user's edit, which the tree starts from; then the job changes line 20 while a worker in the project changes line 18.
  writeFileSync(join(proj, 'f.txt'), text({ 1: 'line 1 (user)' }));
  mkdirSync(join(root, 'job'));
  const tree = makeTree(proj, join(root, 'job', 'tree'));
  writeFileSync(join(tree.path, 'f.txt'), text({ 1: 'line 1 (user)', 20: 'line 20 (job)' }));
  writeFileSync(join(proj, 'f.txt'), text({ 1: 'line 1 (user)', 18: 'line 18 (worker)' }));
  const back = bringBack(proj, tree, join(root, 'job'));
  assert.deepEqual(back, { applied: false, why: `error: patch failed: f.txt:17; error: f.txt: patch does not apply — and f.txt has edits in ${proj} not staged, so a three-way merge could not be tried` });
  assert.equal(readFileSync(join(proj, 'f.txt'), 'utf8'), text({ 1: 'line 1 (user)', 18: 'line 18 (worker)' }), 'the project is left as it was');

  // Said where the change is kept.
  const s = sandbox();
  s.routerWillSay('sonnet', 'medium');
  const p = gitProject(s);
  newWorker(s);
  newWorker(s);
  writeFileSync(join(treeIn(s, 2), 'src.js'), edited(SRC, { 12: 2 }));
  p.write('src.js', edited(SRC, { 12: 3 }));
  const refused = close(s, 2).out;
  assert.ok(refused.includes(`It is kept in ${treeIn(s, 2)} — bring it over by hand, then: git -C ${p.path} worktree remove --force ${treeIn(s, 2)}   (git said: error: patch failed: src.js:`), refused);
  assert.match(refused, /error: src\.js: patch does not apply — and src\.js has edits in \S+ not staged, so a three-way merge could not be tried\)\n/);
});

test('a settle that throws says where the tree is and that its change was not brought back, and can be tried again', async () => {
  await inProcess(async ({ db, p, path }) => {
    await newJob(db, { project: 'proj', title: 'first', task: TASK, now: NOW });
    const { job } = await newJob(db, { project: 'proj', title: 'second', task: TASK, now: NOW });
    const tree = treeOf(db, job.id);
    writeFileSync(join(tree.path, 'src.js'), edited(SRC, { 12: 2 }));
    done(db, job.id);
    // A git that died in the tree left its lock behind: `git add -A` there fails.
    const lock = execFileSync('git', ['-C', tree.path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], { encoding: 'utf8' }).trim();
    writeFileSync(lock, '');
    const failed = await settle(db, job.id, NOW);
    assert.equal(failed.length, 1);
    assert.match(failed[0], /^Its worktree could not be settled: [\s\S]*index\.lock[\s\S]*\. Its change was NOT brought back; the tree is still at (\S+) — bring it over by hand, then: git -C \S+ worktree remove --force \1$/);
    assert.ok(failed[0].endsWith(`the tree is still at ${tree.top} — bring it over by hand, then: git -C ${path} worktree remove --force ${tree.top}`));
    assert.equal(p.read('src.js'), SRC);
    assert.equal(existsSync(tree.top), true);
    rmSync(lock);
    assert.deepEqual(await settle(db, job.id, NOW), [`The change was applied to ${path}; its worktree is removed.`], 'tried again, it settles');
    assert.equal(p.read('src.js'), edited(SRC, { 12: 2 }));
    assert.equal(await settle(db, job.id, NOW).then((l) => l.length), 0, 'and once settled, never again');

    // Attempts: the pick that threw is not taken for picked, and is picked once the trouble is gone.
    const { jobs: [one, two] } = await newJob(db, { project: 'proj', title: 'again', task: TASK, attempts: 2, now: NOW });
    finish(db, two.id, { status: 'FAILED', report: '## Summary\nno.\n' }, NOW);
    await settle(db, two.id, NOW);
    writeFileSync(join(treeOf(db, one.id).path, 'added.js'), 'x\n');
    done(db, one.id);
    const pickLock = execFileSync('git', ['-C', treeOf(db, one.id).path, 'rev-parse', '--path-format=absolute', '--git-path', 'index.lock'], { encoding: 'utf8' }).trim();
    writeFileSync(pickLock, '');
    assert.match((await settle(db, one.id, NOW))[0], /^Its worktree could not be settled: /);
    assert.equal(attemptsSettled(db, one.id), null, 'nothing was picked');
    rmSync(pickLock);
    assert.match((await settle(db, one.id, NOW)).join('\n'), new RegExp(`Picked j${one.id}: the only one verified done\\nThe change was applied to `));
    assert.match(attemptsSettled(db, one.id).join('\n'), /Picked/);
    assert.equal(p.read('added.js'), 'x\n');
  });
});

test('a verified worker in a project outside git is not put to a reviewer: there is no change to hand over, and nothing is said', async () => {
  await inProcess(async ({ db, root }) => {
    const dir = join(root, 'plain');
    mkdirSync(dir);
    writeFileSync(join(dir, 'Makefile'), 'test:\n\t@true\n');
    addProject(db, dir, { slug: 'plain', now: NOW });
    setMeta(db, 'config.jobs.review', 'all');
    const { job } = await newJob(db, { project: 'plain', title: 'return 2', task: TASK, now: NOW });
    const ran = await runFollowed(db, job.id, async (id) => (done(db, id), 'closed'), { now: () => NOW });
    assert.deepEqual(ran.map(({ id, line }) => ({ id, line })), [{ id: job.id, line: null }]);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM jobs WHERE agent = 'reviewer'`).get().n, 0);
  });
});
