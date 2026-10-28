// The model's shell: the OS sandbox around it, the limit on a command gone quiet, and commands left in the background.
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { runJob, sandboxOn } from '../src/loop.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { blockedWrite, guardedPlaces, guardedWhy, sandboxWrap, unsandboxable, writablePlaces } from '../src/sandbox.mjs';
import { askedLimit, backgrounded, childEnv, killGroup, runBash } from '../src/tools.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox as throwaway } from './helpers.mjs';

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settled = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((r) => setTimeout(r, 20));
  return check();
};
const env = childEnv({ PATH: process.env.PATH });

/** A place outside every root and every temporary folder — only the checkout itself is one — gone when the tests are. */
const scratch = mkdtempSync(join(REPO_ROOT, '.sandbox-test-'));
after(() => rmSync(scratch, { recursive: true, force: true }));
const inTmp = [tmpdir(), '/private/tmp'].filter(existsSync).map((t) => realpathSync(t)).some((t) => realpathSync(scratch).startsWith(`${t}/`));
/** Why a test of the sandbox itself cannot run here, or false. */
const noSandbox = unsandboxable() ?? (inTmp ? 'the checkout is in a temporary folder, which the sandbox lets anyone write to' : false);

test('where there is no sandbox, why is said; what it allows is each place once, by its real path; the profile names none of them', () => {
  assert.match(unsandboxable({ platform: 'linux' }), /only on macOS/);
  assert.match(unsandboxable({ platform: 'darwin', exec: join(scratch, 'no-such-sandbox-exec') }), /is missing/);

  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-places-'));
  const home = join(root, 'home');
  mkdirSync(join(home, '.npm'), { recursive: true });
  const places = writablePlaces([root, join(root, '.'), join(root, 'missing')], { home, tmp: tmpdir(), sumo: join(root, 'sumo') });
  assert.equal(places.filter((p) => p === realpathSync(root)).length, 1, 'a root given twice is allowed once');
  assert.ok(places.includes(realpathSync(join(home, '.npm'))), 'a cache that exists is writable');
  assert.ok(!places.some((p) => p.endsWith('/.cache') || p.endsWith('/missing') || p.endsWith('/sumo')), 'one that does not is not named');
  assert.ok(places.includes(realpathSync(tmpdir())));

  // A worktree commits into the main checkout's git directory, outside it.
  const repo = join(root, 'repo');
  mkdirSync(repo);
  const git = (...args) => execFileSync('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args], { cwd: repo, stdio: 'ignore' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  git('worktree', 'add', '-q', join(root, 'tree'));
  assert.ok(writablePlaces([join(root, 'tree')], { home, sumo: home }).includes(realpathSync(join(repo, '.git'))));
  assert.ok(!writablePlaces([repo], { home, sumo: home }).includes(realpathSync(join(repo, '.git'))), 'a git directory inside the root is the root\'s already');

  const wrap = sandboxWrap(['/a/b', '/c']);
  assert.deepEqual([wrap[0], wrap.at(-3), wrap.at(-2), wrap.at(-1)], ['/usr/bin/sandbox-exec', '-DW0=/a/b', '-DW1=/c', '--']);
  assert.match(wrap[2], /\(deny file-write\*\)/);
  assert.ok(!wrap[2].includes('/a/b'), 'paths go in as parameters, never into the profile');
  assert.ok(blockedWrite('rm: x: Operation not permitted') && blockedWrite("EPERM: operation not permitted, unlink 'x'") && blockedWrite('touch: x: Read-only file system'));
  assert.ok(!blockedWrite('No such file or directory'));
});

test('the sandbox is on unless the user turns it off, and shell.sandbox is on or off only', () => {
  const s = throwaway();
  assert.match(s.sumo(['config', 'shell.sandbox']).out, /shell\.sandbox = on/);
  assert.equal(s.sql((db) => sandboxOn(db)), true);
  assert.match(s.sumo(['config', 'shell.sandbox', 'maybe']).err, /shell\.sandbox is on or off/);
  assert.match(s.sumo(['config', 'shell.sandbox', 'off']).out, /shell\.sandbox = off/);
  // Read once a process: the change takes at the next start (test/shell-hardening.test.mjs).
  assert.equal(s.sql((db) => sandboxOn(db)), true);
  assert.match(s.sumo(['config', 'shell.sandbox', 'on'], { extraEnv: { SUMO_TOOL: '1' } }).err, /Refused: the model's shell does not change/, 'not from the model\'s own shell');
});

test('turning the sandbox off says plainly what that means; turning it on says nothing more', () => {
  const s = throwaway();
  const off = s.sumo(['config', 'shell.sandbox', 'off']);
  assert.equal(off.code, 0, off.err);
  assert.deepEqual(off.out.split('\n').slice(0, 2), ['shell.sandbox = off', "warning: the model's shell is no longer held to the project — its commands can write anywhere you can"]);
  assert.match(off.out, /takes effect in chats/);
  assert.doesNotMatch(s.sumo(['config', 'shell.sandbox', 'on']).out, /warning/);
  assert.doesNotMatch(s.sumo(['config', 'shell.network', 'off']).out, /warning/);
});

// The first command of this file: the note is said once a process, so it is the first result that carries it.
test('where there is no sandbox, the first command of a process says it ran without one, and no later one does', { skip: unsandboxable() === null && 'there is a sandbox here' }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-unsandboxed-'));
  const ctx = { cwd: root, roots: [root], env };
  assert.match((await runBash({ command: 'echo one' }, ctx)).content, /^one\n\(the shell is not sandboxed: .+ — a command can write wherever the user can\)$/);
  assert.deepEqual(await runBash({ command: 'echo two' }, ctx), { content: 'two', isError: false });
});

test('the guarded files — read later by the shell, a tool or an editor — are kept from the sandboxed shell as git\'s hooks are, in the project and the home; a directory the user opened is writable', { skip: noSandbox }, async () => {
  const root = join(scratch, 'guarded-project');
  const opened = join(scratch, 'opened');
  mkdirSync(root);
  mkdirSync(opened);
  writeFileSync(join(root, '.envrc'), 'export A=1\n');
  mkdirSync(join(root, '.vscode'));
  writeFileSync(join(root, '.vscode', 'settings.json'), '{}\n');
  writeFileSync(join(root, 'plain.txt'), 'x\n');
  assert.equal(guardedWhy(join(root, '.vscode', 'settings.json'), { roots: [root] }), 'your editor reads it');
  assert.equal(guardedWhy(join(root, 'packages', 'app', '.vscode', 'settings.json'), { roots: [root] }), null, 'only directly under the project or the home');
  assert.equal(guardedWhy(join(root, 'plain.txt'), { roots: [root] }), null);
  // Credentials other programs trust, in the home; and any repository's git directory, however deep and however spelled.
  const home = join(scratch, 'a-home');
  assert.equal(guardedWhy(join(home, '.ssh', 'authorized_keys'), { roots: [root], home }), 'it holds credentials other programs trust');
  assert.equal(guardedWhy(join(home, '.aws', 'config'), { roots: [root], home }), 'it holds credentials other programs trust');
  assert.equal(guardedWhy(join(home, 'code', 'other', '.git', 'hooks', 'pre-commit'), { roots: [root], home }), 'git runs what is in it, outside the sandbox');
  assert.equal(guardedWhy(join(home, 'code', 'other', '.GIT', 'config'), { roots: [root], home }), 'git runs what is in it, outside the sandbox');
  assert.equal(guardedWhy(join(home, 'code', 'other', 'src', 'git.js'), { roots: [root], home }), null);
  assert.deepEqual(
    guardedPlaces([root], { home: join(scratch, 'nohome'), sumo: join(scratch, 'nosumo'), env: { PATH: '' } }),
    [realpathSync(join(root, '.envrc')), realpathSync(join(root, '.vscode')), ...['memory.db', 'memory.db-wal', 'memory.db-shm', 'mcp.json', 'bin', 'models', 'eval.env'].map((n) => join(scratch, 'nosumo', n))],
    "the guarded files that are there, and sumo's own by name whether or not they are",
  );
  // Programs' own setup in the home, and anything on the PATH; a project's bin folder is the project's.
  for (const [rel, why] of [
    ['.gitconfig', 'git reads it, and runs what it names'],
    ['.config/git/config', 'git reads it, and runs what it names'],
    ['Library/LaunchAgents/evil.plist', 'macOS runs it when you log in'],
    ['.local/bin/git', 'a program there runs as a command'],
    ['.config/nvim/init.lua', 'a program you use reads it when it starts'],
  ]) assert.equal(guardedWhy(join(home, rel), { roots: [root], home, env: { PATH: '' } }), why, rel);
  assert.equal(guardedWhy(join(home, '.config', 'app', 'config.toml'), { roots: [root], home, env: { PATH: '' } }), null, "another program's config is an ordinary file");
  assert.equal(guardedWhy(join(root, 'bin', 'run.mjs'), { roots: [root], home, env: { PATH: '' } }), null, "a project's bin is the project's");
  assert.equal(guardedWhy('/opt/tools/bin/deploy', { roots: [root], home, env: { PATH: '/usr/bin:/opt/tools/bin' } }), 'it is on your PATH: a program there runs as a command');
  const ctx = { cwd: root, roots: [root], env, sandbox: true, opened: new Set([opened]) };
  for (const command of ['echo x >> .envrc', 'echo x > .vscode/settings.json', 'rm -r .vscode']) {
    const out = await runBash({ command }, ctx);
    assert.equal(out.isError, true, command);
    assert.match(out.content, /operation not permitted/i, command);
  }
  assert.equal(readFileSync(join(root, '.envrc'), 'utf8'), 'export A=1\n');
  assert.equal(existsSync(join(root, '.npmrc')), false, 'a guarded name not there yet is still made: only what exists is carved out');
  assert.deepEqual(await runBash({ command: `echo y > plain.txt && echo z > ${opened}/made.txt && echo ok` }, ctx), { content: 'ok', isError: false });
  assert.equal(readFileSync(join(opened, 'made.txt'), 'utf8'), 'z\n');
});

test('a sandboxed command writes in the project and the temporary folders and nowhere else — what the guard lets through too — and says where it may write', { skip: noSandbox }, async () => {
  const root = join(scratch, 'project');
  const outside = join(scratch, 'outside');
  mkdirSync(root);
  mkdirSync(outside);
  writeFileSync(join(outside, 'keep.txt'), 'kept');
  const ctx = { cwd: root, roots: [root], env, sandbox: true };

  assert.deepEqual(await runBash({ command: 'echo made > made.txt && mktemp > /dev/null && echo ok' }, ctx), { content: 'ok', isError: false });
  assert.equal(readFileSync(join(root, 'made.txt'), 'utf8'), 'made\n');

  // BSD find says so and exits 0 all the same: nothing is gone, and a command that succeeded is not said to be blocked.
  const found = await runBash({ command: `find ${outside} -mindepth 1 -delete` }, ctx);
  assert.match(found.content, /Operation not permitted$/);
  assert.equal(existsSync(join(outside, 'keep.txt')), true);
  for (const command of [
    `echo x > ${outside}/new.txt`,
    `mv ${outside}/keep.txt ${root}/`,
    `${JSON.stringify(process.execPath)} -e "require('fs').rmSync(${JSON.stringify(outside).replaceAll('"', "'")}, { recursive: true })"`,
  ]) {
    const out = await runBash({ command }, ctx);
    assert.equal(out.isError, true, command);
    assert.match(out.content, /operation not permitted/i, command);
    assert.match(out.content, /\(the sandbox blocked a write outside the project — only these can be written: /, command);
    assert.ok(out.content.includes(realpathSync(root)), 'the writable places are named');
    assert.match(out.content, /\(nobody is here to allow it outside the sandbox: report it, with the command, so the user can run it themselves\)$/);
  }
  assert.equal(readFileSync(join(outside, 'keep.txt'), 'utf8'), 'kept', 'nothing outside was touched');
  assert.equal(existsSync(join(outside, 'new.txt')), false);

  // With somebody there, it is put to them: the exact command, once; a no keeps it blocked, a yes runs it again outside.
  const asked = [];
  const answering = (answer) => async (ask) => {
    asked.push(ask);
    return answer;
  };
  const write = `echo x > ${outside}/allowed.txt && echo wrote`;
  const declined = await runBash({ command: write }, { ...ctx, approve: answering('no') });
  assert.match(declined.content, /\(the user declined running it outside the sandbox: do not run it again; carry on another way, or ask the user\)$/);
  assert.equal(existsSync(join(outside, 'allowed.txt')), false);
  // The screen is told in a line, not shown the paths and the instructions the model is given.
  assert.match(declined.shown, /\ndeclined: the sandbox kept it from writing outside the project, and it was not run outside it$/);
  assert.doesNotMatch(declined.shown, /only these can be written|do not run it again/);
  assert.deepEqual(asked.map((a) => a.input), [{ command: write }]);
  assert.match(asked[0].blocked, /Operation not permitted|Read-only file system/, 'the question carries what the sandbox refused');
  const allowed = await runBash({ command: write }, { ...ctx, approve: answering('once') });
  assert.deepEqual(allowed, { content: '(the sandbox blocked a write outside the project; the user let it run again outside the sandbox)\nwrote', isError: false });
  assert.equal(readFileSync(join(outside, 'allowed.txt'), 'utf8'), 'x\n');

  // Turned off, it writes wherever the user can.
  assert.deepEqual(await runBash({ command: `echo x > ${outside}/new.txt && echo wrote` }, { ...ctx, sandbox: false }), { content: 'wrote', isError: false });
  assert.equal(existsSync(join(outside, 'new.txt')), true);
});

test('a stop still reaches everything a sandboxed command started, and so does its time limit', { skip: noSandbox }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-sandbox-kill-'));
  const ctx = { cwd: root, roots: [root], env, sandbox: true };
  const stop = new AbortController();
  const began = Date.now();
  const waiting = runBash({ command: 'sleep 30 & echo $! > child.pid; wait' }, ctx, { signal: stop.signal });
  assert.equal(await settled(() => existsSync(join(root, 'child.pid')) && readFileSync(join(root, 'child.pid'), 'utf8').trim() !== ''), true);
  const child = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
  stop.abort();
  assert.match((await waiting).content, /interrupted by the user/);
  assert.ok(Date.now() - began < 5000, 'the sleep was killed, not waited for');
  assert.equal(await settled(() => !alive(child)), true, 'the sleep the shell started is gone too');

  const late = await runBash({ command: 'sleep 30 & echo $! > late.pid; wait' }, ctx, { timeoutMs: 400 });
  assert.match(late.content, /\(stopped: it ran past 0\.4 seconds\)$/);
  assert.equal(await settled(() => !alive(Number(readFileSync(join(root, 'late.pid'), 'utf8')))), true);
});

test('a command that prints nothing for too long is stopped, with the way to wait longer; one that keeps talking is not, nor are the checks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-quiet-'));
  const ctx = { cwd: root, roots: [root], env };
  const quiet = await runBash({ command: 'echo begun; sleep 5' }, ctx, { idleMs: 300 });
  assert.equal(quiet.isError, true);
  assert.equal(quiet.content, 'begun\n(stopped: it printed nothing for 0.3 seconds — to wait longer, run it again as `timeout 600 echo begun; sleep 5`, or in the background with a trailing `&` and read its log)');
  assert.deepEqual(await runBash({ command: 'for i in 1 2 3 4 5 6; do echo $i; sleep 0.15; done' }, ctx, { idleMs: 500 }), { content: '1\n2\n3\n4\n5\n6', isError: false }, 'each line starts the wait again');

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sumo'), '#!/bin/sh\nsleep 1\necho "j1 would be accepted as DONE"\n', { mode: 0o755 });
  const checks = { ...ctx, env: childEnv({ PATH: `${bin}:${process.env.PATH}` }) };
  assert.deepEqual(await runBash({ command: 'sumo job verify 1' }, checks, { idleMs: 300 }), { content: 'j1 would be accepted as DONE', isError: false }, 'a check is silent while it works');
});

test('`timeout N` sets both limits, at most half an hour; without a timeout on the PATH the prefix is taken off and the limit kept here', async () => {
  assert.deepEqual(askedLimit('timeout 90 npm test', ''), { ms: 90_000, command: 'npm test' });
  assert.deepEqual(askedLimit('timeout 2m make', ''), { ms: 120_000, command: 'make' });
  assert.deepEqual(askedLimit('timeout 99999 make', ''), { ms: 1_800_000, command: 'make' });
  assert.equal(askedLimit('make', ''), null);
  assert.equal(askedLimit('timeout -k 5 60 make', ''), null, 'flags are left to the binary, if there is one');

  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-timeout-'));
  const none = join(root, 'none');
  mkdirSync(none);
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: `${none}:/usr/bin:/bin` }) };
  if (!existsSync('/usr/bin/timeout') && !existsSync('/bin/timeout')) {
    assert.deepEqual(await runBash({ command: 'timeout 5 echo hi' }, ctx), { content: 'hi', isError: false });
    const began = Date.now();
    const late = await runBash({ command: 'timeout 1 sleep 5' }, ctx, { idleMs: 300 });
    assert.equal(late.content, '\n(stopped: it ran past 1 second)', 'the asked limit, not the shorter silence');
    assert.ok(Date.now() - began < 3000);
  }
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'timeout'), '#!/bin/sh\necho "timeout was given: $*"\n', { mode: 0o755 });
  assert.deepEqual(await runBash({ command: 'timeout 5 echo hi' }, { ...ctx, env: childEnv({ PATH: `${bin}:/usr/bin:/bin` }) }), { content: 'timeout was given: 5 echo hi', isError: false }, 'one on the PATH is used');
});

test('only a lone & at the very end, outside quotes and comments, puts a command in the background', () => {
  assert.equal(backgrounded('npm run dev &'), 'npm run dev');
  assert.equal(backgrounded('npm run dev > dev.log 2>&1 &  '), 'npm run dev > dev.log 2>&1');
  assert.equal(backgrounded("echo 'it is ready' &"), "echo 'it is ready'");
  for (const no of ['make && make test', 'make &&', 'echo "a &"', "echo 'b &'", 'echo hi # later &', 'cmd |&', 'cmd 2>&', 'echo \\&', 'a &\nb &', 'cat <<EOF &\nx\nEOF', '&', 'echo "unclosed &']) {
    assert.equal(backgrounded(no), null, no);
  }
});

test('a command in the background answers at once with its pid and its log, runs in its own group, and goes when the process does', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-background-'));
  const spill = join(root, 'output');
  const ctx = { cwd: root, roots: [root], env, spill, background: new Set() };
  const began = Date.now();
  const out = await runBash({ command: 'echo serving; sleep 30 &' }, ctx);
  assert.ok(Date.now() - began < 2000, 'it did not wait');
  assert.equal(out.isError, false);
  const pid = Number(/^started in the background \(pid (\d+)\)/.exec(out.content)?.[1]);
  const log = /its output goes to (\S+) — read it with `tail -n 50 \1`\. It is stopped when the job or the chat that started it ends\.$/.exec(out.content)?.[1];
  assert.ok(pid > 0 && log?.startsWith(`${spill}/`), out.content);
  assert.equal(await settled(() => readFileSync(log, 'utf8') === 'serving\n'), true, 'what it prints goes to the log');
  assert.ok(alive(pid) && ctx.background.has(pid));
  killGroup(pid);
  assert.equal(await settled(() => !alive(pid) && !ctx.background.has(pid)), true, 'its group is its own, and one that ended is let go');

  // This process ending, however it ends, takes it along.
  const host = `
    const { runBash } = await import(${JSON.stringify(new URL('../src/tools.mjs', import.meta.url).href)});
    const out = await runBash({ command: 'sleep 30 &' }, { cwd: ${JSON.stringify(root)}, roots: [${JSON.stringify(root)}], env: process.env, spill: ${JSON.stringify(spill)} });
    console.log(/pid (\\d+)/.exec(out.content)[1]);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', host], { stdio: ['ignore', 'pipe', 'inherit'] });
  let said = '';
  child.stdout.on('data', (chunk) => (said += chunk));
  await new Promise((r) => child.on('close', r));
  const left = Number(said.trim());
  assert.ok(left > 0, said);
  assert.equal(await settled(() => !alive(left)), true, 'the background command went with the process that started it');
});

test('a command in the background is sandboxed too', { skip: noSandbox }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-background-sandbox-'));
  const outside = mkdtempSync(join(scratch, 'outside-'));
  const out = await runBash({ command: `echo x > ${outside}/bg.txt &` }, { cwd: root, roots: [root], env, spill: join(root, 'output'), sandbox: true });
  const log = /its output goes to (\S+) —/.exec(out.content)[1];
  assert.equal(await settled(() => /Operation not permitted/.test(readFileSync(log, 'utf8'))), true);
  assert.equal(existsSync(join(outside, 'bg.txt')), false);
});

test('a job\'s commands left in the background end with the job, and its blocked writes are put to the user with the job named', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-sandbox-job-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo' }));
      const now = '2026-10-25T12:00:00.000Z';
      const { project: { slug } } = addProject(db, root, { slug: 'demo', now });
      const id = Number(db.prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, 'demo', 'scout', 'running', 's1', ?, ?, 'sonnet', 'low', 'test')`).run(slug, now, now).lastInsertRowid);
      mkdirSync(join(paths().jobs, String(id)), { recursive: true });
      writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id}\n\nlook\n`);
      const outside = mkdtempSync(join(scratch, 'job-'));
      const replies = [
        { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'sleep 30 &' } }, { type: 'tool_use', id: 't2', name: 'bash', input: { command: `echo x > ${outside}/j.txt` } }], usage: { input_tokens: 1, output_tokens: 1 } },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'still done' }], usage: { input_tokens: 1, output_tokens: 1 } },
      ];
      const seen = [];
      const asked = [];
      await runJob(db, id, {
        send: async (params) => {
          seen.push(structuredClone(params));
          return replies.shift();
        },
        approve: async (ask) => {
          asked.push(ask);
          return 'no';
        },
      });
      const results = seen[1].messages.at(-1).content;
      const pid = Number(/pid (\d+)/.exec(results[0].content)?.[1]);
      assert.ok(pid > 0, results[0].content);
      assert.ok(results[0].content.includes(join(paths().jobs, String(id), 'output')), 'its log is in the job\'s own folder');
      assert.equal(await settled(() => !alive(pid)), true, 'the job ended, and so did what it left running');
      if (!noSandbox) {
        assert.deepEqual(asked.map((a) => [a.job, a.input.command]), [[id, `echo x > ${outside}/j.txt`]]);
        assert.match(results[1].content, /the user declined running it outside the sandbox/);
      }
    } finally {
      db.close();
    }
  });
});

test("sumo's own memory, settings and MCP servers are read-only to the sandboxed shell; a plain sumo command runs as sumo itself, where the model's limits hold", { skip: noSandbox }, async () => {
  await withHome(freshHome(), {}, async () => {
    const home = process.env.SUMO_AGENTS_HOME;
    openDb().close();
    const root = join(scratch, 'sumo-own');
    mkdirSync(root);
    const ctx = { cwd: root, roots: [root], env: { ...env, SUMO_AGENTS_HOME: home, SUMO_TOOL: '1' }, sandbox: true };
    // Written past the CLI — straight into the database, or a server list made where there was none — the sandbox refuses it.
    for (const command of [
      `echo x >> ${home}/memory.db`,
      `echo '{"mcpServers":{"x":{"command":"/bin/sh","allow":"all"}}}' > ${home}/mcp.json`,
      `${JSON.stringify(process.execPath)} -e "require('fs').writeFileSync(process.env.SUMO_AGENTS_HOME + '/memory.db-wal', 'x')"`,
      `mkdir -p ${home}/bin && echo x > ${home}/bin/sumo`,
    ]) {
      const out = await runBash({ command }, ctx);
      assert.equal(out.isError, true, command);
      assert.match(out.content, /operation not permitted/i, command);
    }
    assert.equal(existsSync(join(home, 'mcp.json')), false, 'no server list was made');
    // Through the CLI it works, as sumo, outside the sandbox — and what only the user may change is still refused.
    const searched = await runBash({ command: 'sumo search "nothing here"' }, ctx);
    assert.equal(searched.isError, false, searched.content);
    const off = await runBash({ command: 'sumo config shell.sandbox off' }, ctx);
    assert.equal(off.isError, true);
    assert.match(off.content, /Refused: the model's shell does not change what the user controls/);
    // A sumo command the shell would expand or pipe is not taken for one: it stays in the sandbox, which cannot open the database.
    assert.equal((await runBash({ command: 'sumo search "nothing here" && echo searched' }, ctx)).isError, true);
  });
});

test('a workflow taught with a quoted here-document is filed through sumo itself; one whose steps would end it early and run more stays in the sandbox', { skip: noSandbox }, async () => {
  await withHome(freshHome(), {}, async () => {
    const home = process.env.SUMO_AGENTS_HOME;
    openDb().close();
    const root = join(scratch, 'heredoc');
    mkdirSync(root);
    const ctx = { cwd: root, roots: [root], env: { ...env, SUMO_AGENTS_HOME: home, SUMO_TOOL: '1' }, sandbox: true };
    const taught = await runBash({ command: "sumo learn 'release' --cue 'release it' <<'EOF_STEPS'\n1. run the tests\n2. tag it\nEOF_STEPS" }, ctx);
    assert.equal(taught.isError, false, taught.content);
    const marker = join(scratch, 'heredoc-ran.txt');
    const sneaky = await runBash({ command: `sumo learn 'x' --cue 'y' <<'EOF'\n1. a\nEOF\ntouch ${marker}\nEOF` }, ctx);
    assert.equal(sneaky.isError, true, 'run in the sandbox, where the database cannot be opened');
    assert.match(sneaky.content, /the sandbox blocked a write/, 'and said as a blocked write, so the user can be asked');
    assert.equal(existsSync(marker), false, 'what came after the early end never ran outside the sandbox');
    const db = openDb();
    try {
      assert.deepEqual(db.prepare(`SELECT title FROM memories WHERE type = 'procedure'`).all().map((r) => r.title), ['release'], 'only the honest one was filed');
    } finally {
      db.close();
    }
  });
});
