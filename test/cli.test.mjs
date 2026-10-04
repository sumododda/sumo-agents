// How `sumo` reads its arguments: a mistake is refused with a plain message, never quietly taken as something else.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
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
