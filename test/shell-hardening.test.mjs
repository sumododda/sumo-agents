// The model's shell and editor made harder to misuse and cheaper to read: a placeholder that stands for code, the
// sandbox's network switch and git's hooks and config out of its reach, commands that never wait on a prompt, output
// shown tidied with the whole of it kept, and the question for a run outside the sandbox.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { createChat } from '../src/chat.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { networkOn, sandboxOn } from '../src/loop.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { readOnlyPlaces, sandboxWrap, unsandboxable, writablePlaces } from '../src/sandbox.mjs';
import { childEnv, runBash, runEditor, tidy } from '../src/tools.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';
import { sandbox as throwaway } from './helpers.mjs';

const project = (name = 'sumo-agents-shell-') => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), name)));
  return { root, ctx: { cwd: root, roots: [root] } };
};

/** Git with nothing of the user's: no global or system config, so no signing, no hooks path and no editor of theirs. */
const gitEnv = () => {
  const home = mkdtempSync(join(tmpdir(), 'sumo-agents-git-home-'));
  return childEnv({ PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' });
};
const git = (cwd, env, ...args) => execFileSync('git', args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' });

test('an edit whose new text stands for code instead of holding it is refused, and says to write the code out', () => {
  const { root, ctx } = project();
  const file = join(root, 'a.mjs');
  const original = 'export function a() {\n  return 1;\n}\n';
  writeFileSync(file, original);
  for (const line of [
    '// ... rest of the code unchanged',
    '# ... existing code ...',
    '/* rest of file */',
    '// (unchanged)',
    '<!-- ... -->',
    '...existing code...',
    '  // ... other methods ...',
    '{/* ... */}',
    '// rest of the file stays the same',
    '// ... (rest of the function) ...',
  ]) {
    const out = runEditor({ command: 'str_replace', path: 'a.mjs', old_str: '  return 1;', new_str: `  return 10;\n${line}` }, ctx);
    assert.equal(out.isError, true, line);
    assert.equal(out.content, `not written: new_str has a line that stands for code instead of holding it — ${JSON.stringify(line.trim())} — and the file would hold that line, not the code. Write the code out in full; to leave code as it is, leave it out of the edit.`);
  }
  assert.equal(readFileSync(file, 'utf8'), original, 'nothing was written');

  const created = runEditor({ command: 'create', path: 'b.py', file_text: 'def f():\n    # ... rest of the code ...\n' }, ctx);
  assert.match(created.content, /^not written: file_text has a line that stands for code/);
  assert.equal(existsSync(join(root, 'b.py')), false);
  assert.match(runEditor({ command: 'insert', path: 'a.mjs', insert_line: 1, insert_text: '  // ... existing code ...\n' }, ctx).content, /^not written: insert_text has a line that stands for code/);
  assert.equal(readFileSync(file, 'utf8'), original);
});

test('a plain ... in code or prose is never taken for a placeholder, nor one the file already holds, nor one in a document', () => {
  const { root, ctx } = project();
  const fine = [
    'const all = [...rest, ...others];',
    '  ...existingConfig,',
    'def stub(): ...',
    '...',
    '…',
    '// Wait for it...',
    '// The rest of the code handles the errors.',
    '// Other functions',
    '// existing code paths stay supported',
    '// ...',
    '# ...',
    'print("... rest of the code ...")',
    ' * ... rest of the code',
  ];
  fine.forEach((line, i) => assert.equal(runEditor({ command: 'create', path: `ok${i}.src`, file_text: `${line}\n` }, ctx).isError, false, line));

  // Already in the file, a placeholder is the file's own: carried over by an edit, it is not refused.
  writeFileSync(join(root, 'kept.mjs'), 'const x = 1;\n// ... rest of the code unchanged\n');
  assert.equal(runEditor({ command: 'str_replace', path: 'kept.mjs', old_str: 'const x = 1;\n// ... rest of the code unchanged', new_str: 'const x = 2;\n// ... rest of the code unchanged' }, ctx).isError, false);
  // A document shows code with its gaps, as a reader is meant to see it.
  assert.equal(runEditor({ command: 'create', path: 'README.md', file_text: '```js\napp.use(router);\n// ... rest of your code\n```\n' }, ctx).isError, false);
});

test('create never rewrites a file that is there, whatever its size: it is changed with str_replace', () => {
  const { root, ctx } = project();
  const file = join(root, 'long.txt');
  const text = Array.from({ length: 80 }, (_, i) => `line ${i}`).join('\n');
  writeFileSync(file, text);
  const out = runEditor({ command: 'create', path: 'long.txt', file_text: 'all new\n' }, ctx);
  assert.equal(out.isError, true);
  assert.equal(out.content, `${file} already exists (80 lines): change the lines that change with str_replace or insert — a file is never rewritten whole`);
  assert.equal(readFileSync(file, 'utf8'), text);
});

test('output is tidied before the cap: a progress line as it was left, a run of the same line folded, a very long line cut to its start', () => {
  assert.deepEqual(tidy('Downloading 10%\rDownloading 50%\rDownloading 100%\ndone'), { text: 'Downloading 100%\ndone', cut: 0 });
  assert.deepEqual(tidy('\rfoo\rbar\r\nnext\r\n'), { text: 'bar\r\nnext\r\n', cut: 0 }, 'a line ending \\r\\n keeps its ending');
  assert.deepEqual(tidy('fetching 99%\r            \n'), { text: 'fetching 99%\n', cut: 0 }, 'a state that only blanks the line is not the one kept');
  const warn = 'warning: this call is deprecated';
  assert.deepEqual(tidy(`${warn}\n${warn}\n${warn}\n${warn}\nok\nok\nz`), { text: `${warn}\n[… the same line 3 more times]\nok\nok\nz`, cut: 0 }, 'two of the same are left as they are');
  assert.deepEqual(tidy('\n\n\n\nok'), { text: '\n\n\n\nok', cut: 0 }, 'a run the count would be longer than is left as it is');
  assert.deepEqual(tidy('a'.repeat(2500)), { text: `${'a'.repeat(2000)}[… 500 chars cut]`, cut: 1 });
  assert.deepEqual(tidy('a'.repeat(2000)), { text: 'a'.repeat(2000), cut: 0 });
  // A secret the cut would split is taken out whole first, not left half there where it is no longer recognised.
  const leaky = tidy(`${'x'.repeat(1990)} sk-${'A1b2'.repeat(10)} ${'y'.repeat(100)}`);
  assert.ok(!leaky.text.includes('A1b2'), leaky.text.slice(1980));
});

test('the model is shown the tidied output, with the way to a line cut short; the spill file keeps it as it was printed, and the cap keeps more', async () => {
  const { root, ctx } = project();
  const spill = join(root, 'output');
  const script = join(root, 'print.mjs');
  writeFileSync(script, "process.stdout.write('p 1%\\rp 2%\\rp 3%\\n' + 'the same line\\n'.repeat(5) + 'b'.repeat(2500) + '\\nend\\n');\n");
  const out = await runBash({ command: `${JSON.stringify(process.execPath)} print.mjs` }, { ...ctx, env: childEnv({ PATH: process.env.PATH }), spill, sandbox: false });
  const file = /\[a line cut short is whole in (\S+)\]$/.exec(out.content)?.[1];
  assert.ok(file?.startsWith(`${spill}/`), out.content);
  assert.equal(out.content, `p 3%\nthe same line\n[… the same line 4 more times]\n${'b'.repeat(2000)}[… 500 chars cut]\nend\n[a line cut short is whole in ${file}]`);
  // Every frame — a line of its own there, as every carriage return is once secrets are looked for — every line, and the whole of the long one.
  assert.equal(readFileSync(file, 'utf8'), `p 1%\np 2%\np 3%\n${'the same line\n'.repeat(5)}${'b'.repeat(2500)}\nend`);

  // Four thousand lines of the same — 100 KB, six times the cap — are one line and a count, not the two ends of them.
  const quiet = { ...ctx, env: childEnv({ PATH: process.env.PATH }), sandbox: false };
  assert.equal((await runBash({ command: 'for i in $(seq 4000); do echo "warning: deprecated call"; done' }, quiet)).content, 'warning: deprecated call\n[… the same line 3999 more times]');
  // Of a flood only its two ends are held: each is folded on its own, and the cut between them is said where it was.
  const flood = (await runBash({ command: 'for i in $(seq 20000); do echo "warning: deprecated call"; done' }, quiet)).content;
  assert.match(flood, /^warning: deprecated call\n\[… the same line \d+ more times\]\n[^\n]*\n\[cut \d+ characters from the middle — [^\n]+\]\n[^\n]*\nwarning: deprecated call\n\[… the same line \d+ more times\]$/);
});

test('a viewed file with a line too long to read shows its start and how much was cut', () => {
  const { root, ctx } = project();
  writeFileSync(join(root, 'bundle.min.js'), `// built\n${'f();'.repeat(1500)}\nexport {};\n`);
  const out = runEditor({ command: 'view', path: 'bundle.min.js' }, ctx);
  assert.equal(out.content, `1\t// built\n2\t${'f();'.repeat(500)}[… 4000 chars cut]\n3\texport {};\n4\t`);
});

test('the model\'s shell never waits on a prompt: git opens no editor and no pager and asks for no password, unless the user set one', async () => {
  const { root, ctx } = project();
  const env = gitEnv();
  git(root, env, 'init', '-q');
  writeFileSync(join(root, 'a.txt'), 'a\n');
  git(root, env, 'add', 'a.txt');
  // An editor that waits for somebody, as vi would with nobody at the keyboard.
  const waits = join(root, 'waits.sh');
  writeFileSync(waits, '#!/bin/sh\nsleep 30\n', { mode: 0o755 });
  const began = Date.now();
  const out = await runBash({ command: 'git commit' }, { ...ctx, env: { ...env, EDITOR: waits, VISUAL: waits }, sandbox: false }, { idleMs: 10_000 });
  assert.ok(Date.now() - began < 5_000, `it waited: ${out.content}`);
  assert.match(out.content, /Aborting commit due to empty commit message/);

  const said = await runBash({ command: 'echo "$GIT_TERMINAL_PROMPT|$GIT_EDITOR|$GIT_PAGER|$PAGER|$GIT_SSH_COMMAND"' }, { ...ctx, env: { ...env, PAGER: 'less' }, sandbox: false });
  assert.equal(said.content, '0|true|cat|less|ssh -o BatchMode=yes', 'what the user set is theirs');
  // An ssh command of the user's own, in the environment or in git's config, is not replaced.
  assert.equal((await runBash({ command: 'echo "${GIT_SSH_COMMAND:-none}"' }, { ...ctx, env: { ...env, GIT_SSH: '/usr/bin/ssh' }, sandbox: false })).content, 'none');
  const other = project();
  git(other.root, env, 'init', '-q');
  git(other.root, env, 'config', 'core.sshCommand', 'ssh -i ~/.ssh/work');
  assert.equal((await runBash({ command: 'echo "${GIT_SSH_COMMAND:-none}"' }, { ...other.ctx, env, sandbox: false })).content, 'none');
});

test('the writable places take the per-user cache macOS gives clang and swift, and the package caches that exist', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-caches-'));
  const home = join(root, 'home');
  for (const cache of ['.cargo/git', 'Library/pnpm', '.bun/install/cache', '.gradle/caches', '.m2/repository']) mkdirSync(join(home, cache), { recursive: true });
  const userCache = join(root, 'C');
  mkdirSync(userCache);
  const places = writablePlaces([root], { home, sumo: home, userCache });
  for (const cache of ['.cargo/git', 'Library/pnpm', '.bun/install/cache', '.gradle/caches', '.m2/repository']) assert.ok(places.includes(realpathSync(join(home, cache))), cache);
  assert.ok(places.includes(realpathSync(userCache)));
  assert.ok(!writablePlaces([root], { home, sumo: home, userCache: join(root, 'missing') }).some((p) => p.endsWith('/missing')), 'one that is not there is not named');
  if (process.platform === 'darwin') {
    const real = realpathSync(execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8' }).trim());
    assert.ok(writablePlaces([root], { home, sumo: home }).includes(real), 'by default it is the one getconf names');
  }
});

test('shell.network is on or off, on unless the user turns it off; both switches are read once a process, so a change takes at the next start', () => {
  const s = throwaway();
  assert.match(s.sumo(['config', 'shell.network']).out, /shell\.network = on/);
  assert.match(s.sumo(['config', 'shell.network', 'maybe']).err, /shell\.network is on or off/);
  assert.equal(s.sql((db) => sandboxOn(db)), true);
  assert.equal(s.sql((db) => networkOn(db)), true);
  assert.match(s.sumo(['config', 'shell.network', 'off']).out, /shell\.network = off/);
  // As a model would, writing the database itself: the session it runs in keeps the sandbox it started with.
  s.sql((db) => setMeta(db, 'config.shell.sandbox', 'off'));
  assert.equal(s.sql((db) => sandboxOn(db)), true);
  assert.equal(s.sql((db) => networkOn(db)), true);
  const loop = pathToFileURL(join(REPO_ROOT, 'src', 'loop.mjs')).href;
  const db = pathToFileURL(join(REPO_ROOT, 'src', 'db.mjs')).href;
  const fresh = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', `import { sandboxOn, networkOn } from ${JSON.stringify(loop)}; import { openDb } from ${JSON.stringify(db)}; const db = openDb(); console.log(sandboxOn(db), networkOn(db));`], {
    env: { ...process.env, SUMO_AGENTS_HOME: s.home },
    encoding: 'utf8',
  });
  assert.equal(fresh.stdout.trim(), 'false false', `the next start reads what is stored: ${fresh.stderr}`);
});

test('with the network off the profile denies remote addresses only; without the switch it says nothing of the network', () => {
  assert.ok(!sandboxWrap(['/a'])[2].includes('network'));
  const profile = sandboxWrap(['/a'], { network: false })[2];
  assert.match(profile, /\(deny network-outbound \(remote ip\)\)\n\(allow network-outbound \(remote ip "localhost:\*"\)\)/);
});

test('with the network off a sandboxed command reaches nothing past this machine, and loopback still answers', { skip: unsandboxable() ?? false }, async () => {
  const { root, ctx } = project();
  const server = createServer((socket) => socket.end('hello from here\n'));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const node = JSON.stringify(process.execPath);
    // A literal address, so no name has to resolve: the connection itself is what is refused.
    const remote = `${node} -e "require('net').connect(443, '1.1.1.1').on('connect', () => console.log('connected')).on('error', (e) => console.log(e.code))"`;
    const offline = { ...ctx, env: childEnv({ PATH: process.env.PATH }), sandbox: true, network: false };
    assert.equal((await runBash({ command: remote }, offline)).content, 'EPERM');
    assert.equal((await runBash({ command: 'curl -sS -m 10 https://example.com' }, offline)).isError, true);
    const local = `${node} -e "require('net').connect(${server.address().port}, '127.0.0.1').on('data', (d) => process.stdout.write(d)).on('error', (e) => console.log(e.code))"`;
    assert.equal((await runBash({ command: local }, offline)).content, 'hello from here', 'loopback answers');
    assert.notEqual((await runBash({ command: remote }, { ...offline, network: true })).content, 'EPERM', 'on, the sandbox lets it out');
  } finally {
    server.close();
  }
});

test('the sandboxed shell cannot write git\'s hooks or its config, nor move the git directory aside, while add, commit, checkout and worktree still work', { skip: unsandboxable() ?? false }, async () => {
  const { root, ctx } = project('sumo-agents-git-guard-');
  const env = gitEnv();
  git(root, env, 'init', '-q');
  git(root, env, 'commit', '-q', '--allow-empty', '-m', 'first');
  writeFileSync(join(root, '.git', 'hooks', 'post-merge'), '#!/bin/sh\n', { mode: 0o644 });
  const sandboxed = { ...ctx, env, sandbox: true };
  assert.deepEqual(readOnlyPlaces([root]), [join(root, '.git', 'hooks'), join(root, '.git', 'config')]);
  for (const command of ['echo "touch /tmp/owned" > .git/hooks/pre-commit', 'echo "touch /tmp/owned" >> .git/hooks/post-merge', 'chmod +x .git/hooks/post-merge', 'echo "[core] hooksPath = /tmp" >> .git/config', 'git config core.hooksPath /tmp', 'mv .git .git-aside', 'mv .git/hooks .git/old-hooks', `mv ${root} ${root}-aside`]) {
    const out = await runBash({ command }, sandboxed);
    assert.equal(out.isError, true, command);
    assert.match(out.content, /operation not permitted/i, command);
  }
  assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
  assert.doesNotMatch(readFileSync(join(root, '.git', 'config'), 'utf8'), /hooksPath/);
  const blocked = await runBash({ command: 'echo x > .git/hooks/post-commit' }, sandboxed);
  assert.match(blocked.content, new RegExp(`except git's hooks and config: ${join(root, '.git', 'hooks')}, ${join(root, '.git', 'config')}\\)`));

  const tree = join(realpathSync(tmpdir()), `sumo-agents-git-tree-${process.pid}`);
  const work = await runBash({ command: `echo a > a.txt && git add a.txt && git commit -qm second && git checkout -qb side && git checkout -q - && git worktree add -q ${tree} && git log --oneline | wc -l | tr -d ' '` }, sandboxed);
  assert.deepEqual(work, { content: '2', isError: false });

  // From the worktree, the git directory it commits into is outside it, and writable: its hooks and config still are not.
  const common = join(root, '.git');
  assert.deepEqual(readOnlyPlaces([tree]), [join(tree, '.git'), join(common, 'hooks'), join(common, 'config')]);
  const inTree = { cwd: tree, roots: [tree], env, sandbox: true };
  for (const command of [`echo x > ${common}/hooks/pre-commit`, `echo x >> ${common}/config`, 'echo "gitdir: /tmp/elsewhere" > .git', `mv ${common} ${common}-aside`]) {
    assert.equal((await runBash({ command }, inTree)).isError, true, command);
  }
  assert.deepEqual(await runBash({ command: 'echo b > b.txt && git add b.txt && git commit -qm third && echo committed' }, inTree), { content: 'committed', isError: false });
});

test('a write the sandbox blocked is put to the user as a run outside the sandbox, once: yes or no, no always', { skip: unsandboxable() ?? false }, async () => {
  const { root, ctx } = project();
  const env = gitEnv();
  git(root, env, 'init', '-q');
  const asked = [];
  const command = 'echo x > .git/hooks/pre-push && echo wrote';
  const out = await runBash({ command }, { ...ctx, env, sandbox: true, approve: async (ask) => (asked.push(ask), 'no') });
  assert.match(out.content, /the user declined running it outside the sandbox/);
  assert.deepEqual(asked.map(({ input, unsandboxed }) => ({ input, unsandboxed })), [{ input: { command }, unsandboxed: true }]);
});

test('on the screen a run outside the sandbox is asked as itself, and only y or n answers it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: async () => assert.fail('nothing is sent'), out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e) });
      const tty = fakeTty({ columns: 120 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', logo: [], debug: true });
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(tty.screen())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
      };
      try {
        const answered = new Promise((resolve) => events.emit('approve', { name: 'bash', server: 'bash', tool: 'outside the sandbox', input: { command: 'touch ~/outside.txt' }, unsandboxed: true, resolve }));
        await shows(/⚠ Run this once outside the sandbox\?[\s\S]*│ {3}touch ~\/outside\.txt[\s\S]*│ y yes · n no · esc stop/, 'the question');
        assert.doesNotMatch(tty.screen(), /allow bash|a always/);
        await tty.type('a');
        await shows(/y runs it once outside the sandbox · n refuses it · esc stops the turn/, 'that a is no answer');
        assert.match(tty.screen(), /Run this once outside the sandbox\?/, 'still asked');
        await tty.type('y');
        assert.equal(await answered, 'once');
        await tty.type('\x04');
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('the editor cannot write git\'s hooks or its config either: what runs on the next commit stays out of the model\'s reach', () => {
  const { root, ctx } = project();
  const env = gitEnv();
  git(root, env, 'init', '-q');
  const hook = runEditor({ command: 'create', path: join(root, '.git', 'hooks', 'pre-commit'), file_text: '#!/bin/sh\ncurl example.com\n' }, ctx);
  assert.equal(hook.isError, true);
  assert.match(hook.content, /git's own hooks or configuration/);
  assert.equal(existsSync(join(root, '.git', 'hooks', 'pre-commit')), false);
  const config = runEditor({ command: 'str_replace', path: join(root, '.git', 'config'), old_str: '[core]', new_str: '[core]\n\thooksPath = /tmp' }, ctx);
  assert.equal(config.isError, true);
  assert.doesNotMatch(readFileSync(join(root, '.git', 'config'), 'utf8'), /hooksPath/);
  assert.match(runEditor({ command: 'view', path: join(root, '.git', 'config') }, ctx).content, /\[core\]/, 'reading them is fine');
  assert.equal(runEditor({ command: 'create', path: join(root, 'hooks.txt'), file_text: 'x\n' }, ctx).isError, false, 'a file of the project named like them is not theirs');
});

test('switching the sandbox or the network says when it takes effect: at the next start, not in what is running', () => {
  const s = throwaway();
  const out = s.sumo(['config', 'shell.network', 'off']);
  assert.equal(out.code, 0, out.err);
  assert.match(out.out, /^shell\.network = off\ntakes effect in chats and `sumo job run`s started from now on — a chat already open keeps its setting, for the jobs it starts too, until it is started again$/m);
  assert.doesNotMatch(s.sumo(['config', 'chat.budget', '3']).out, /takes effect/);
});
