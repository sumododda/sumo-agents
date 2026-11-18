// The one memory pass: it files, then tidies when the week is up, and says what each half did; a tidy that fails rests
// before it is tried again by itself; the page is the user's, never the model's shell's.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

/** A memory from before the week began: with it, and no tidy yet, the weekly tidy is due. */
const oldMemory = (s) => {
  s.sumo(['add', 'preference', 'keep pull request descriptions short']);
  s.sql((db) => db.prepare('UPDATE memories SET created_at = ?, valid_from = ?').run('2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z'));
};

/** What the tidy's calls to the local model answer: each kind its own, failing or with nothing to change. */
const tidyWill = (s, { fails }) => {
  const answers = { 'dream-keys': { memories: [] }, 'dream-repeats': { repeats: [] }, 'dream-pairs': { pairs: [] } };
  for (const [kind, output] of Object.entries(answers)) {
    writeFileSync(
      join(s.root, `model-answer.json.${kind}`),
      JSON.stringify(fails ? { is_error: true, result: 'local model unavailable', structured_output: null, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 } : { is_error: false, result: '', structured_output: output, usage: { input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0 }),
    );
  }
};

test('a pass that also tidies says what it filed and what the tidy did, each under its own name', () => {
  const s = sandbox();
  oldMemory(s);
  s.hook('prompt', { session_id: 'four', prompt: 'always use bun in every project' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', body: 'Use bun in every project', turn: 1, quote: 'always use bun in every project' }]);
  tidyWill(s, { fails: false });
  const run = s.sumo(['memory', 'run']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^read 1 turns[\s\S]*saved m\d+ \[pref·global·stated\] always use bun in every project[\s\S]*^tidy: went over memory/m);
});

test('a tidy that fails rests for six hours: the passes after it file and do not tidy, until asked to', () => {
  const s = sandbox();
  oldMemory(s);
  s.modelWillSay([]);
  tidyWill(s, { fails: true });
  const first = s.sumo(['memory', 'run']);
  assert.match(first.out, /tidy: failed — /, first.out);
  assert.equal(first.code, 0, 'a tidy nobody asked for failing is said, not an exit code');
  assert.match(s.sumo(['memory', 'status']).out, /the last tidy, at .*; tried again by itself six hours on, or now: sumo memory run --tidy$/m);

  s.hook('prompt', { session_id: 'four', prompt: 'thanks' });
  const next = s.sumo(['memory', 'run']);
  assert.match(next.out, /^read 1 turns/);
  assert.doesNotMatch(next.out, /tidy:/, 'resting: the next pass only files');

  const asked = s.sumo(['memory', 'run', '--tidy']);
  assert.match(asked.out, /failed — /);
  assert.equal(asked.code, 1, 'a tidy asked for that fails is a failure');

  tidyWill(s, { fails: false });
  const mended = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(mended.code, 0, mended.err);
  assert.doesNotMatch(s.sumo(['memory', 'status']).out, /the last tidy, at/, 'a tidy that went through clears it');
});

test('the memory page is the user\'s: from the model\'s shell it is refused, not served until a Ctrl-C that never comes', () => {
  const s = sandbox();
  const piped = s.sumo(['memory']);
  assert.equal(piped.code, 2, 'with no terminal the page would wait on nobody');
  assert.match(piped.err, /^sumo: the memory page runs until Ctrl-C, so it needs a terminal — run sumo memory in one/);
  assert.equal(s.spawned().some((line) => /\bopen\b|xdg-open/.test(line)), false, 'and no browser is opened');
  const tool = s.sumo(['memory'], { extraEnv: { SUMO_TOOL: '1' } });
  assert.equal(tool.code, 1);
  assert.match(tool.err, /the memory page is the user's: they open it with \/memory in the chat, or sumo memory/);
});
