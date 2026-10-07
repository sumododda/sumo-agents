// How `sumo` reads its arguments: a mistake is refused with a plain message, never quietly taken as something else.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { ENTRY } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

test('a flag that needs a value is refused when the next word is another flag, and only real commands run', () => {
  const s = sandbox();
  for (const [args, message] of [
    [['add', 'fact', 'tabs not spaces', '--topic', '--pin'], /--topic needs a value/],
    [['search', 'tabs', '--project', '-n', '3'], /--project needs a value/],
    [['constructor'], /unknown command "constructor"/],
    [['toString', '--help'], /unknown command "toString"/],
  ]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}${run.err}`);
    assert.match(run.err, message);
  }
  assert.match(s.sumo(['search', 'tabs']).out, /nothing in memory/, 'the refused add saved nothing');

  // A value that only looks like a flag, and is not one of this command's, is still a value.
  const gated = s.sumo(['learn', 'commit safely', '--cue', 'commit', '--gate', '--no-verify'], { input: '1. run the hooks\n' });
  assert.equal(gated.code, 0, gated.err);
  assert.match(gated.out, /gates shell commands matching: --no-verify/);
});

test('help names the chat and every job command, and `sumo chat --help` answers instead of refusing', () => {
  const s = sandbox();
  const help = s.sumo(['help']);
  assert.equal(help.code, 0, help.err);
  assert.match(help.out, /sumo chat/);
  for (const sub of ['run', 'watch', 'tell']) assert.match(help.out, new RegExp(`\\b${sub} ID\\b`), `help lists job ${sub}`);
  const chat = s.sumo(['chat', '--help']);
  assert.equal(chat.code, 0, chat.err);
  assert.match(chat.out, /^sumo chat /);
});

test('a mistyped short option, a job command with no id, a bad ops file and a failed pass each say so and exit non-zero', () => {
  const s = sandbox();
  const short = s.sumo(['search', 'foo', '-p', 'bar']);
  assert.equal(short.code, 2);
  assert.match(short.err, /unknown option -p/);
  assert.match(s.sumo(['search', 'a -p flag in the words']).out, /nothing in memory for: a -p flag in the words/, 'inside a quoted query it is just text');

  const noId = s.sumo(['job', 'show']);
  assert.equal(noId.code, 2);
  assert.match(noId.err, /sumo job show needs a job id, like j17/);

  const bad = join(s.root, 'bad.json');
  writeFileSync(bad, 'nope\n');
  const apply = s.sumo(['apply', bad]);
  assert.equal(apply.code, 2);
  assert.match(apply.err, /is not a JSON file of operations/);

  s.hook('prompt', { session_id: 's1', cwd: s.root, prompt: 'always use tabs in this repo' });
  const failed = s.sumo(['scribe', 'run'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: '/nonexistent/stand-in' } });
  assert.equal(failed.code, 1, failed.out);
  assert.match(failed.out, /^failed — /);
});

test('the chat refuses up front what would fail every turn: no credential, a model or an effort that does not exist', () => {
  const s = sandbox();
  for (const [args, extraEnv, message] of [
    [['chat'], {}, /the chat needs an Anthropic credential — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN/],
    [['chat', '--model', 'gpt'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, /no such model "gpt"/],
    [['chat', '--effort', 'ultra'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, /no such effort "ultra"/],
    [['chat', '--resume'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, /no saved session to resume/],
    [['chat', '--resume', 'nope'], { ANTHROPIC_API_KEY: 'sk-ant-test' }, /no saved session starts with "nope"/],
  ]) {
    const run = s.sumo(args, { input: 'hi\n', extraEnv });
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, message);
    assert.equal(run.out, '', 'nothing of the chat was started');
  }
  const byId = s.sumo(['chat', '--model', 'claude-opus-5-5'], { input: '', extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.equal(byId.code, 0, byId.err);
  assert.match(byId.out, /claude-opus-5-5/, 'a full API id is a model too');
});

test('a reader that stops early ends the output quietly: `sumo export | head` is not a crash', async () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'seed']);
  // More than a pipe holds, so the writes are still going when the reader has gone.
  s.sql((db) => {
    const copy = db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at)
      SELECT type, scope, ?, provenance, state, importance, written_by, valid_from, created_at FROM memories WHERE id = 1`);
    for (let i = 0; i < 3000; i++) copy.run(`fact ${i} ${'x'.repeat(100)}`);
  });
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'export'], { env: { ...process.env, SUMO_AGENTS_HOME: s.home }, stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => (err += d));
  child.stdout.once('data', () => child.stdout.destroy());
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.equal(err, '', 'no stack trace');
  assert.equal(code, 0);
});

test('a command that needs a memory id and was given none says so, not that "undefined" is a bad id', () => {
  const s = sandbox();
  for (const command of ['show', 'history', 'confirm', 'reject']) {
    const r = s.sumo([command]);
    assert.equal(r.code, 2);
    assert.match(r.err, /a memory id is needed/);
    assert.doesNotMatch(r.err, /undefined/);
  }
});
