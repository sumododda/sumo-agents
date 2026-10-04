// How `sumo` reads its arguments: a mistake is refused with a plain message, never quietly taken as something else.
import assert from 'node:assert/strict';
import { test } from 'node:test';
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
