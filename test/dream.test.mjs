import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

/** A finished conversation whose turns the writer has already filed. */
function finishedSession(s, id, prompts) {
  for (const prompt of prompts) s.hook('prompt', { session_id: id, prompt });
  s.hook('session-end', { session_id: id, reason: 'other' });
  s.modelWillSay([]);
  s.mem(['scribe', 'run']);
}

test('consolidation starts by itself once three finished sessions are waiting — not before', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  s.hook('session-start', { session_id: 'three', source: 'startup' });
  assert.equal(s.spawned().includes('dream run'), false);
  assert.match(s.mem(['dream', 'status']).out, /finished sessions waiting: 2 \(runs by itself at 3\)/);

  finishedSession(s, 'three', ['again: shorter PR description']);
  s.hook('session-start', { session_id: 'four', source: 'startup' });
  assert.equal(s.spawned().includes('dream run'), true);
});

test('reading sessions side by side: a pattern becomes a question, a clash is raised, a routine is proposed — nothing is decided for the user', () => {
  const s = sandbox();
  s.mem(['add', 'preference', 'use tabs for indentation']);
  s.mem(['add', 'preference', 'use two spaces for indentation']);
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  finishedSession(s, 'three', ['again: shorter PR description', 'to release: run the tests, bump the version, tag it, push the tag']);

  s.modelWillSay([
    { op: 'add', type: 'preference', scope: 'global', topic: 'writing', body: 'The user wants pull request descriptions kept short' },
    { op: 'contradiction', ids: [1, 2], note: 'tabs and two spaces cannot both be the indentation rule' },
    { op: 'procedure', scope: 'global', title: 'release', cue: 'release it', body: '1. run the tests\n2. bump the version\n3. tag it\n4. push the tag' },
    { op: 'supersede', old: 1, body: 'use four spaces for indentation', turn: 1, quote: 'a sentence nobody said' },
  ]);
  const run = s.mem(['dream', 'run']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^read 3 sessions/);
  assert.match(run.out, /held for confirmation m3 \[pref·global·inferred·unconfirmed\]/);
  assert.match(run.out, /raised for the user: m1 vs m2 — tabs and two spaces/);
  assert.match(run.out, /held for confirmation m4 \[proc·global·inferred·unconfirmed\] "release"/);
  assert.match(run.out, /held for confirmation m5 /, 'an unproven replacement is only a guess');

  // The model saw the conversations and what is already remembered.
  const shown = s.modelWasShown();
  assert.match(shown.system, /^You label text\. You are shown several finished conversations/);
  assert.match(shown.prompt, /What is already remembered:\n[\s\S]*use tabs for indentation/);
  assert.match(shown.prompt, /\[t\d+\] user: again: shorter PR description/);
  assert.deepEqual(shown.schema.properties.ops.items.properties.op.enum, ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'procedure']);

  // Everything waits for the user; the two real memories are untouched.
  const block = s.mem(['prime']).out;
  assert.match(block, /Ask the user \(then mem confirm\|reject m3\): is this right\? "The user wants pull request descriptions kept short"/);
  assert.match(block, /Ask the user \(then mem confirm\|reject m4\): is this right\? "workflow "release""/);
  assert.match(block, /Ask the user: m1 and m2 disagree — tabs and two spaces cannot both be the indentation rule/);
  assert.match(s.mem(['search', 'indentation']).out, /m1 .*tabs[\s\S]*m2 .*two spaces|m2 .*two spaces[\s\S]*m1 .*tabs/);

  // Settling the clash makes the notice go away on its own.
  s.mem(['forget', 'm1']);
  assert.doesNotMatch(s.mem(['prime']).out, /disagree/);

  // A confirmed workflow becomes a real one.
  s.mem(['confirm', 'm4']);
  assert.match(s.mem(['prime']).out, /Workflows — before doing what one covers, run mem show <id> and follow it: m4 "release" — when: release it/);

  assert.match(s.mem(['dream', 'run']).out, /nothing to do — no finished sessions are waiting/);
});

test('a bad answer changes nothing and the sessions are read again next time', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['hello']);
  writeFileSync(join(s.root, 'model-answer.json'), JSON.stringify({ is_error: false, structured_output: { ops: 'not a list' }, usage: {}, total_cost_usd: 0 }));

  assert.match(s.mem(['dream', 'run']).out, /^failed — the answer had no list of operations/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), 0);
  assert.match(s.mem(['dream', 'status']).out, /finished sessions waiting: 1/);
  assert.match(s.mem(['scribe', 'stats']).out, /dream: 1 runs \(0 ok\)/);
});

test('asked for by hand, consolidation does not wait for the conversation to end', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'still-open', prompt: 'always squash merge' });
  s.modelWillSay([]);
  s.mem(['scribe', 'run']);
  assert.match(s.mem(['dream', 'status']).out, /finished sessions waiting: 0/);
  assert.match(s.mem(['dream', 'run']).out, /^read 1 sessions/);
});
