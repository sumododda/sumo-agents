// The editor's guard rails: a file changed under the model is said before its edit, an edit that breaks a file's parse is
// said after it, and what the chat's editor changed in a turn can be put back with /undo.
import assert from 'node:assert/strict';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, symlinkSync, truncateSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { chat, createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { scratchDir } from '../src/projects.mjs';
import { runEditor, undoLast } from '../src/tools.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-10-25T12:00:00.000Z';
const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 }, model: 'claude-opus-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const canned = (responses) => {
  const seen = [];
  const send = async (params) => {
    seen.push(structuredClone(params));
    return responses.shift();
  };
  return { send, seen };
};
const project = () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-editor-safety-')));
  return { root, ctx: { cwd: root, roots: [root] } };
};
/** Whether a command can be started at all: gofmt has no --version, and says so by running. */
const has = (command) => !spawnSync(command, ['--version'], { stdio: 'ignore' }).error;
const STALE = (path) => `${path} changed on disk since you last viewed it; view it again if this edit depends on the rest of it.`;
/** A path inside a pattern, as itself. */
const literal = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

test('an edit to a file that changed on disk since it was viewed is made, and says so first; the editor\'s own changes keep the record', () => {
  const { root, ctx } = project();
  const file = join(root, 'a.txt');
  writeFileSync(file, 'one\ntwo\n');
  assert.equal(runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'one', new_str: 'uno' }, ctx).content, `edited ${file}`, 'never viewed: nothing to compare with');

  runEditor({ command: 'view', path: 'a.txt' }, ctx);
  assert.equal(runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'uno', new_str: 'one' }, ctx).content, `edited ${file}`);
  assert.equal(runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'one', new_str: 'uno' }, ctx).content, `edited ${file}`, 'its own change is not a change on disk');

  writeFileSync(file, 'uno\ntwo\nthree\n');
  const warned = runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'two', new_str: 'dos' }, ctx);
  assert.equal(warned.content, `${STALE(file)}\nedited ${file}`);
  assert.equal(warned.isError, false);
  assert.equal(readFileSync(file, 'utf8'), 'uno\ndos\nthree\n', 'the edit is made all the same');
  assert.equal(runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'dos', new_str: 'two' }, ctx).content, `edited ${file}`, 'said once: the record follows the edit');

  // The same size with a newer time is a change too; an insert is warned as a replace is.
  const later = new Date(Date.now() + 60_000);
  utimesSync(file, later, later);
  assert.equal(runEditor({ command: 'insert', path: 'a.txt', insert_line: 0, insert_text: 'zero\n' }, ctx).content, `${STALE(file)}\ninserted into ${file} after line 0`);

  // A file the editor created is one it knows whole.
  runEditor({ command: 'create', path: 'b.txt', file_text: 'b\n' }, ctx);
  writeFileSync(join(root, 'b.txt'), 'bb\n');
  assert.match(runEditor({ command: 'str_replace', path: 'b.txt', old_str: 'bb', new_str: 'b' }, ctx).content, /changed on disk since you last viewed it/);
  // A directory viewed is no file seen.
  assert.equal(runEditor({ command: 'view', path: '.' }, ctx).isError, false);
});

test('an edit that leaves a file unparseable says so with the first lines of the error, and only when it parsed before; the edit stands', () => {
  const { root, ctx } = project();
  const mjs = join(root, 'a.mjs');
  assert.equal(runEditor({ command: 'create', path: 'a.mjs', file_text: 'export const a = 1;\n' }, ctx).content, `created ${mjs}`);
  const broke = runEditor({ command: 'str_replace', path: 'a.mjs', old_str: 'export const a = 1;', new_str: 'export const a = ;' }, ctx);
  assert.equal(broke.isError, false, 'never blocked');
  assert.match(broke.content, new RegExp(`^edited ${literal(mjs)}\\nThe file no longer parses:\\n`));
  assert.match(broke.content, /SyntaxError/);
  assert.ok(broke.content.split('\n').length <= 7, broke.content);
  assert.equal(readFileSync(mjs, 'utf8'), 'export const a = ;\n', 'nor undone');
  assert.equal(runEditor({ command: 'insert', path: 'a.mjs', insert_line: 1, insert_text: 'export const b = 2;\n' }, ctx).content, `inserted into ${mjs} after line 1`, 'already broken: nothing new to say');
  assert.equal(runEditor({ command: 'str_replace', path: 'a.mjs', old_str: 'a = ;', new_str: 'a = 1;' }, ctx).content, `edited ${mjs}`, 'mended');

  // A file that did not exist parsed before, as far as anyone is concerned.
  assert.match(runEditor({ command: 'create', path: 'b.cjs', file_text: 'module.exports = {\n' }, ctx).content, /^created .*b\.cjs\nThe file no longer parses:\n/);
  assert.match(runEditor({ command: 'create', path: 'c.js', file_text: 'const c = (;\n' }, ctx).content, /The file no longer parses:/);

  const json = join(root, 'd.json');
  assert.equal(runEditor({ command: 'create', path: 'd.json', file_text: '{"a": 1}\n' }, ctx).content, `created ${json}`);
  assert.match(runEditor({ command: 'str_replace', path: 'd.json', old_str: '1}', new_str: '1,}' }, ctx).content, new RegExp(`^edited ${literal(json)}\\nThe file no longer parses:\\n.*JSON`));
  assert.equal(runEditor({ command: 'str_replace', path: 'd.json', old_str: '"a"', new_str: '"b"' }, ctx).content, `edited ${json}`);

  // A file of no kind it knows is not checked.
  assert.equal(runEditor({ command: 'create', path: 'e.txt', file_text: '{\n' }, ctx).content, `created ${join(root, 'e.txt')}`);
});

test('a Python file is checked without leaving bytecode behind', { skip: !has('python3') && 'python3 is not on PATH' }, () => {
  const { root, ctx } = project();
  const py = join(root, 'a.py');
  assert.equal(runEditor({ command: 'create', path: 'a.py', file_text: 'def f():\n    return 1\n' }, ctx).content, `created ${py}`);
  const broke = runEditor({ command: 'str_replace', path: 'a.py', old_str: 'def f():', new_str: 'def f(:' }, ctx);
  assert.match(broke.content, new RegExp(`^edited ${literal(py)}\\nThe file no longer parses:\\n`));
  assert.match(broke.content, /SyntaxError/);
  assert.equal(runEditor({ command: 'str_replace', path: 'a.py', old_str: 'return 1', new_str: 'return 2' }, ctx).content, `edited ${py}`);
  assert.deepEqual(readdirSync(root), ['a.py']);
});

test('a Go file is checked with gofmt', { skip: !has('gofmt') && 'gofmt is not on PATH' }, () => {
  const { root, ctx } = project();
  const go = join(root, 'main.go');
  assert.equal(runEditor({ command: 'create', path: 'main.go', file_text: 'package main\n\nfunc main() {\n}\n' }, ctx).content, `created ${go}`);
  assert.match(runEditor({ command: 'str_replace', path: 'main.go', old_str: 'func main() {\n}', new_str: 'func main() {' }, ctx).content, new RegExp(`^edited ${literal(go)}\\nThe file no longer parses:\\n.*main\\.go:`));
});

test('a change that cannot be kept for /undo is still made, and says so rather than failing', () => {
  const { root, ctx } = project();
  writeFileSync(join(root, 'a.txt'), 'one\n');
  // A folder under a file cannot be made.
  const out = runEditor({ command: 'str_replace', path: 'a.txt', old_str: 'one', new_str: 'two' }, { ...ctx, undo: join(root, 'a.txt', 'undo', '1') });
  assert.equal(out.isError, false);
  assert.match(out.content, /^edited .*a\.txt\n\(this change could not be kept for \/undo: ENOTDIR/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'two\n');
});

/** A chat on canned replies, in scratch under a throwaway home, its scribe asked for on paper only. */
async function inChat(responses, fn) {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    const { send, seen } = canned(responses);
    const session = createChat(db, { model: 'opus', effort: 'high', send, now: () => NOW });
    try {
      session.start('startup');
      await fn({ session, seen, db, dir: scratchDir() });
    } finally {
      session.end();
      db.close();
    }
  });
}

test('/undo puts back what the editor changed in the last turn that changed files, one turn at a time, and says bash is not tracked', async () => {
  const edit = (id, command, path, extra) => call(id, 'str_replace_based_edit_tool', { command, path, ...extra });
  // Each turn ends on a command, so no edit is left unchecked and the turn ends as the model ended it.
  const turn = (calls, n) => [reply('tool_use', [...calls, call(`b${n}`, 'bash', { command: 'test -f old.txt' })]), reply('end_turn', [{ type: 'text', text: 'Done.' }])];
  const responses = [];
  await inChat(responses, async ({ session, seen, dir }) => {
    const old = join(dir, 'old.txt');
    const made = join(dir, 'new.txt');
    writeFileSync(old, 'before\n', { mode: 0o644 });
    assert.equal(session.undo(), 'nothing to undo: the editor has changed no file in this session — changes made through bash are not tracked');

    responses.push(
      ...turn([edit('t1', 'create', made, { file_text: 'fresh\n' }), edit('t2', 'str_replace', old, { old_str: 'before', new_str: 'after' }), edit('t3', 'str_replace', old, { old_str: 'after', new_str: 'after all' })], 1),
      ...turn([call('t4', 'bash', { command: 'echo shell > shell.txt' })], 2),
      ...turn([edit('t5', 'str_replace', made, { old_str: 'fresh', new_str: 'fresher' }), edit('t6', 'str_replace', old, { old_str: 'after all', new_str: 'later' })], 3),
      reply('end_turn', [{ type: 'text', text: 'ok' }]),
    );
    await session.say('make new.txt and change old.txt');
    await session.say('write shell.txt from the shell');
    await session.say('change both again');
    assert.equal(readFileSync(old, 'utf8'), 'later\n');

    // What was kept is the user's alone to read.
    const store = join(paths().logs, 'undo', session.sessionId);
    const turns = readdirSync(store);
    assert.equal(turns.length, 2, 'a turn that changed nothing through the editor keeps nothing');
    for (const t of turns) for (const name of readdirSync(join(store, t))) assert.equal(statSync(join(store, t, name)).mode & 0o777, 0o600, `${t}/${name}`);

    writeFileSync(old, 'an edit made after the turn\n');
    assert.match(session.undo(), /undo stopped.*old\.txt/s);
    assert.equal(readFileSync(made, 'utf8'), 'fresher\n');
    assert.equal(readFileSync(old, 'utf8'), 'an edit made after the turn\n');
    writeFileSync(old, 'later\n');

    assert.equal(session.undo(), 'undid the last turn that changed files: restored new.txt and old.txt — changes made through bash are not tracked, so they stay');
    assert.equal(readFileSync(made, 'utf8'), 'fresh\n');
    assert.equal(readFileSync(old, 'utf8'), 'after all\n');

    assert.equal(session.undo(), 'undid the last turn that changed files: restored old.txt; deleted new.txt, which that turn created — changes made through bash are not tracked, so they stay');
    assert.equal(readFileSync(old, 'utf8'), 'before\n', 'as before the first change of the turn, not the second');
    assert.equal(existsSync(made), false);
    assert.equal(statSync(old).mode & 0o777, 0o644, 'the file keeps its own mode');
    assert.equal(readFileSync(join(dir, 'shell.txt'), 'utf8'), 'shell\n', 'the shell\'s change stays');
    assert.match(session.undo(), /^nothing to undo/);

    // The model is told with its next turn, so it does not edit from what it remembers.
    await session.say('carry on');
    const told = seen.at(-1).messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n');
    assert.match(told, /the user ran \/undo: restored old\.txt; deleted new\.txt, which that turn created\. View a file again before you edit it\./);
  });
});

test('/undo checks the entire turn before restoring or deleting files, and keeps a conflicted turn for retry', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const edit = { ...ctx, undo: join(session, '1') };
  const original = join(root, 'old.txt');
  const created = join(root, 'new.txt');
  writeFileSync(original, 'first');
  runEditor({ command: 'str_replace', path: original, old_str: 'first', new_str: 'second' }, edit);
  runEditor({ command: 'create', path: created, file_text: 'made' }, edit);
  writeFileSync(created, 'mine');
  assert.match(undoLast(session).blocked, /new\.txt/);
  assert.equal(readFileSync(original, 'utf8'), 'second');
  assert.equal(readFileSync(created, 'utf8'), 'mine');
  writeFileSync(created, 'made');
  assert.deepEqual(undoLast(session), { restored: [original], deleted: [created] });
  assert.equal(readFileSync(original, 'utf8'), 'first');
  assert.equal(existsSync(created), false);
});

test('/undo preserves an intervening write even when the editor edited the file again in the same turn', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const path = join(root, 'text.txt');
  const edit = { ...ctx, undo: join(session, '1') };
  runEditor({ command: 'create', path, file_text: 'initial' }, edit);
  writeFileSync(path, 'mine and initial');
  runEditor({ command: 'str_replace', path, old_str: 'initial', new_str: 'edited' }, edit);
  assert.match(undoLast(session).blocked, /outside the editor during this turn/);
  assert.equal(readFileSync(path, 'utf8'), 'mine and edited');
});

test('/undo resumes after an interruption following a restore, without touching paths already completed', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const dir = join(session, '1');
  const edit = { ...ctx, undo: dir };
  const [first, second, last] = ['one', 'two', 'three'].map((name) => join(root, name));
  for (const path of [first, second, last]) {
    writeFileSync(path, 'old');
    runEditor({ command: 'str_replace', path, old_str: 'old', new_str: 'new' }, edit);
  }
  // The first two writes completed, then the process exited before it could advance past the second.
  writeFileSync(join(dir, 'restoring'), '1');
  writeFileSync(first, 'mine after undo');
  writeFileSync(second, 'old');
  assert.deepEqual(undoLast(session), { restored: [first, second, last], deleted: [] });
  assert.equal(readFileSync(first, 'utf8'), 'mine after undo');
  assert.equal(readFileSync(last, 'utf8'), 'old');
});

test('/undo keeps old or unreadable records and the current files', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const dir = join(session, '1');
  const path = join(root, 'new.txt');
  runEditor({ command: 'create', path, file_text: 'mine' }, { ...ctx, undo: dir });
  const manifest = join(dir, 'manifest.json');
  for (const record of ['{', JSON.stringify([{ path, kept: null, mode: null }])]) {
    writeFileSync(manifest, record);
    assert.match(undoLast(session).blocked, /undo stopped/i);
    assert.equal(readFileSync(path, 'utf8'), 'mine');
    assert.equal(readFileSync(manifest, 'utf8'), record);
  }
});

test('/undo judges a file by what it holds, not by its inode: one a tool wrote back through a rename, as `sed -i` does, is still put back', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const path = join(root, 'a.txt');
  writeFileSync(path, 'before');
  runEditor({ command: 'str_replace', path, old_str: 'before', new_str: 'after' }, { ...ctx, undo: join(session, '1') });
  // The same bytes written to a new file and moved over the old one: a new inode, and nothing changed.
  writeFileSync(join(root, 'a.tmp'), 'after');
  execFileSync('mv', [join(root, 'a.tmp'), path]);
  assert.deepEqual(undoLast(session), { restored: [path], deleted: [] });
  assert.equal(readFileSync(path, 'utf8'), 'before');
});

test('/undo asked again of a turn whose file changed since lets that turn go, keeping the file as it is, so the turns before it can still be undone', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const [first, second] = ['first.txt', 'second.txt'].map((name) => join(root, name));
  writeFileSync(first, 'one');
  writeFileSync(second, 'two');
  runEditor({ command: 'str_replace', path: first, old_str: 'one', new_str: 'uno' }, { ...ctx, undo: join(session, '1') });
  runEditor({ command: 'str_replace', path: second, old_str: 'two', new_str: 'dos' }, { ...ctx, undo: join(session, '2') });
  writeFileSync(second, 'dos, formatted');
  assert.match(undoLast(session).blocked, /^undo stopped before changing any files: .*second\.txt changed after the editor wrote it\. Put it back as the editor left it and \/undo again — or \/undo again to let that turn go/);
  assert.match(undoLast(session).blocked, /^undo let go of the last turn .*second\.txt changed after the editor wrote it.*\/undo again reaches the turn before/);
  assert.equal(readFileSync(second, 'utf8'), 'dos, formatted');
  assert.deepEqual(undoLast(session), { restored: [first], deleted: [] });
  assert.equal(readFileSync(first, 'utf8'), 'one');
});

test('/undo of a file the editor made that has since been deleted finds it already gone, and puts the rest back', () => {
  const { root, ctx } = project();
  const session = join(root, 'session');
  const edit = { ...ctx, undo: join(session, '1') };
  const [kept, made] = ['kept.txt', 'made.txt'].map((name) => join(root, name));
  writeFileSync(kept, 'old');
  runEditor({ command: 'str_replace', path: kept, old_str: 'old', new_str: 'new' }, edit);
  runEditor({ command: 'create', path: made, file_text: 'made' }, edit);
  execFileSync('rm', [made]);
  assert.deepEqual(undoLast(session), { restored: [kept], deleted: [made] });
  assert.equal(readFileSync(kept, 'utf8'), 'old');
});

test('/undo walks back twenty turns at most: older ones are let go as new ones are kept', async () => {
  const responses = [];
  await inChat(responses, async ({ session, dir }) => {
    const file = join(dir, 'count.txt');
    writeFileSync(file, '0\n');
    for (let n = 1; n <= 21; n++) {
      responses.push(
        reply('tool_use', [call(`e${n}`, 'str_replace_based_edit_tool', { command: 'str_replace', path: file, old_str: `${n - 1}\n`, new_str: `${n}\n` }), call(`b${n}`, 'bash', { command: 'test -s count.txt' })]),
        reply('end_turn', [{ type: 'text', text: 'Done.' }]),
      );
      await session.say(`count to ${n}`);
    }
    assert.equal(readFileSync(file, 'utf8'), '21\n');
    assert.equal(readdirSync(join(paths().logs, 'undo', session.sessionId)).length, 20);
    for (let n = 0; n < 20; n++) assert.match(session.undo(), /^undid the last turn that changed files: restored count\.txt/);
    assert.equal(readFileSync(file, 'utf8'), '1\n', 'the first turn\'s change was let go');
    assert.match(session.undo(), /^nothing to undo/);
  });
});

test('/undo is a command of the menu and of help, and runs in the piped chat', async () => {
  await inChat([], async ({ session, db }) => {
    assert.ok(session.commands.some((c) => c.name === 'undo'));
    assert.deepEqual(session.expand('/undo'), { control: 'undo' });
    const printed = [];
    const output = new Writable({
      write(chunk, _encoding, done) {
        printed.push(String(chunk));
        done();
      },
    });
    assert.equal(await chat(db, { model: 'opus', effort: 'high', send: canned([]).send, input: Readable.from(['/undo\n']), output }), 0);
    assert.match(printed.join(''), /⎿ {2}nothing to undo: the editor has changed no file in this session/);
  });
});

test('a file swapped for a link while the editor works on it is not written through the link: the change goes to the file that was checked, or nowhere', () => {
  const { root } = project();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-editor-swap-out-')));
  writeFileSync(join(outside, 'target'), 'outside\n');
  writeFileSync(join(root, 'x.py'), 'A = 1\n');
  // The parse the editor runs before it writes is the window. This python3 stands in for a background command of the
  // model's, which its sandbox lets make links in the project: it puts a link out where the file was.
  const bin = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-editor-swap-bin-')));
  writeFileSync(join(bin, 'python3'), `#!/bin/sh\nrm -f '${join(root, 'x.py')}' && ln -s '${join(outside, 'target')}' '${join(root, 'x.py')}'\n`, { mode: 0o755 });
  const out = runEditor({ command: 'str_replace', path: 'x.py', old_str: 'A = 1', new_str: 'A = 2' }, { cwd: root, roots: [root], env: { PATH: `${bin}:/usr/bin:/bin` } });
  assert.equal(readFileSync(join(outside, 'target'), 'utf8'), 'outside\n', 'nothing reached the file the link points at');
  assert.equal(out.isError, true);
  assert.match(out.content, /x\.py was replaced while it was being changed; nothing was written — view it again/);
});

test('a guarded file is not made through a link in the project to the project: `sub/.npmrc` with `sub -> .` is the project\'s `.npmrc`, asked about by where it lands', () => {
  const { root, ctx } = project();
  execFileSync('git', ['init', '-q', root]);
  execFileSync('git', ['-C', root, 'config', 'core.hooksPath', '.husky/_']);
  mkdirSync(join(root, '.husky'));
  // Links the model's shell may make: they are in the project.
  symlinkSync('.', join(root, 'sub'));
  symlinkSync('.husky', join(root, 'h'));
  for (const name of ['.npmrc', '.envrc', '.yarnrc.yml', 'bunfig.toml', '.mcp.json', '.pre-commit-config.yaml', 'lefthook.yml']) {
    const input = { command: 'create', path: `sub/${name}`, file_text: 'x = 1\n' };
    const out = runEditor(input, ctx);
    assert.equal(out.isError, true, name);
    assert.equal(out.ask?.path, join(root, name), `${name}: the question names where it lands`);
    assert.match(out.content, new RegExp(`sub/${literal(name)} \\(a link to ${literal(join(root, name))}\\) is changed only when the user says so`));
    assert.equal(existsSync(join(root, name)), false, `${name}: nothing made before the user says so`);
    assert.match(runEditor(input, { ...ctx, granted: out.ask.path }).content, /^created /, `${name}: once they do, it is made`);
  }
  // The hooks folder git's config names, reached through a link to the folder above it: git's own, never changed here.
  const hook = runEditor({ command: 'create', path: 'h/_/pre-commit', file_text: '#!/bin/sh\n' }, ctx);
  assert.equal(hook.isError, true);
  assert.match(hook.content, /git's own hooks or configuration/);
  assert.equal(existsSync(join(root, '.husky', '_', 'pre-commit')), false);
});

test('/undo writes back only to the file the editor wrote: a link swapped in at its name the moment after the write is not taken for it, so /undo never writes through the link', async () => {
  const { root } = project();
  const guarded = join(root, '.envrc');
  const planted = 'export PATH=/tmp/evil:$PATH\n';
  // The other sessions kept beside this one, a month of them, each looked at when a turn's first change is kept.
  const sessions = join(root, 'undo');
  for (let i = 0; i < 400; i++) mkdirSync(join(sessions, `other-${i}`), { recursive: true });
  let swaps = 0;
  for (let attempt = 0; attempt < 8; attempt++) {
    // A file the shell cannot write, and a project file the model filled so the editor leaves it byte for byte the same.
    const kept = `# attempt ${attempt}\n`;
    writeFileSync(guarded, kept);
    const file = join(root, `a${attempt}.txt`);
    writeFileSync(file, `${planted}${kept}`);
    // A background command of the model's: once the file holds what the editor will write, a link to the guarded file at its name.
    const racer = spawn(process.execPath, ['-e', `
      const fs = require('fs');
      try { fs.rmSync(${JSON.stringify(`${file}.lnk`)}); } catch {}
      fs.symlinkSync(${JSON.stringify(guarded)}, ${JSON.stringify(`${file}.lnk`)});
      process.stdout.write('ready\\n');
      const until = Date.now() + 5000;
      while (Date.now() < until) {
        const s = fs.statSync(${JSON.stringify(file)}, { throwIfNoEntry: false });
        if (s && s.size === ${Buffer.byteLength(kept)}) { fs.renameSync(${JSON.stringify(`${file}.lnk`)}, ${JSON.stringify(file)}); process.stdout.write('swapped\\n'); break; }
      }`], { stdio: ['ignore', 'pipe', 'inherit'] });
    let said = '';
    await new Promise((resolve) => racer.stdout.on('data', (d) => (said += d) && said.includes('ready') && resolve()));
    const session = join(sessions, `session-${attempt}`);
    const out = runEditor({ command: 'str_replace', path: file, old_str: planted, new_str: '' }, { cwd: root, roots: [root], undo: join(session, '1') });
    await new Promise((resolve) => racer.on('exit', resolve));
    if (!said.includes('swapped') || out.isError) continue;
    swaps++;
    undoLast(session);
    assert.equal(readFileSync(guarded, 'utf8'), kept, `attempt ${attempt}: /undo wrote nothing through the link`);
  }
  assert.ok(swaps > 0, 'the link was swapped in after the write at least once: the test reached the window it is about');
});

test('a hard link reached through a link of its own is asked about as the hard link itself is', () => {
  const { root, ctx } = project();
  const outside = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-editor-hardlink-out-')));
  writeFileSync(join(outside, '.zshrc'), '# shell\n');
  linkSync(join(outside, '.zshrc'), join(root, 'notes.txt'));
  symlinkSync(join(root, 'notes.txt'), join(root, 'alias.txt'));
  const input = { command: 'str_replace', path: 'alias.txt', old_str: '# shell', new_str: '# shell, edited' };
  const out = runEditor(input, ctx);
  assert.equal(out.ask?.guarded, 'it has another name elsewhere (a hard link), and a change here changes that file too');
  assert.equal(readFileSync(join(outside, '.zshrc'), 'utf8'), '# shell\n', 'nothing written before the user says so');
  assert.match(runEditor(input, { ...ctx, granted: out.ask.path }).content, /^edited /, 'once they do, it is changed');
  assert.equal(readFileSync(join(outside, '.zshrc'), 'utf8'), '# shell, edited\n');
});

test('the editor reads only plain files: a FIFO is refused at once, never waited on, and a file too big to view whole is said to be', () => {
  const { root, ctx } = project();
  execFileSync('mkfifo', [join(root, 'pipe.txt')]);
  // In a process of its own: waiting on a writer would block this one for good.
  const script = `import { runEditor } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'tools.mjs')).href)};
const ctx = ${JSON.stringify(ctx)};
for (const input of [{ command: 'view' }, { command: 'str_replace', old_str: 'a', new_str: 'b' }, { command: 'insert', insert_line: 0, insert_text: 'x\\n' }]) console.log(JSON.stringify(runEditor({ ...input, path: 'pipe.txt' }, ctx)));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(run.signal, null, 'it answered rather than waiting on a writer');
  const answers = run.stdout.trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(answers.length, 3, run.stderr);
  for (const out of answers) {
    assert.equal(out.isError, true);
    assert.match(out.content, /pipe\.txt is not a plain file/);
  }
  const big = join(root, 'big.log');
  writeFileSync(big, '');
  truncateSync(big, 65 * 1024 * 1024);
  const huge = runEditor({ command: 'view', path: 'big.log' }, ctx);
  assert.equal(huge.isError, true);
  assert.match(huge.content, /big\.log is 68157440 bytes, too big to view whole/);
});
