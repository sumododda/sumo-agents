// The editor's guard rails: a file changed under the model is said before its edit, an edit that breaks a file's parse is
// said after it, and what the chat's editor changed in a turn can be put back with /undo.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, realpathSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { chat, createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { paths } from '../src/paths.mjs';
import { scratchDir } from '../src/projects.mjs';
import { runEditor } from '../src/tools.mjs';
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
  const turn = (calls, n) => [reply('tool_use', [...calls, call(`b${n}`, 'bash', { command: 'true' })]), reply('end_turn', [{ type: 'text', text: 'Done.' }])];
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

test('/undo walks back twenty turns at most: older ones are let go as new ones are kept', async () => {
  const responses = [];
  await inChat(responses, async ({ session, dir }) => {
    const file = join(dir, 'count.txt');
    writeFileSync(file, '0\n');
    for (let n = 1; n <= 21; n++) {
      responses.push(
        reply('tool_use', [call(`e${n}`, 'str_replace_based_edit_tool', { command: 'str_replace', path: file, old_str: `${n - 1}\n`, new_str: `${n}\n` }), call(`b${n}`, 'bash', { command: 'true' })]),
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
    assert.match(printed.join(''), / {4}nothing to undo: the editor has changed no file in this session/);
  });
});
