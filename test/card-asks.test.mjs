// A project's own questions — guesses to confirm, notices to settle — reach the user wherever the chat was started:
// with the project's card, the first time the project comes up in a session, once.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const ASK_GUESS = /Ask the user \(then sumo confirm\|reject m\d+\): is this right\? "simba deploys only on weekdays"/;
const ASK_NOTICE = /Ask the user: m\d+ and m\d+ disagree — two hosts for staging \(sumo show both; settle with sumo supersede or sumo forget\)/;

/** A project with a guess waiting and a notice raised about two of its memories. */
function simbaWithQuestions(s) {
  s.addProject('simba');
  const now = new Date().toISOString();
  s.sql((db) => {
    const put = db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at)
      VALUES (?, 'project:simba', ?, ?, ?, 0.5, 'scribe', ?, ?)`);
    put.run('preference', 'simba deploys only on weekdays', 'inferred', 'unconfirmed', now, now);
    const a = Number(put.run('fact', 'simba staging runs on the mac mini', 'stated', 'active', now, now).lastInsertRowid);
    const b = Number(put.run('fact', 'simba staging runs on the hetzner box', 'stated', 'active', now, now).lastInsertRowid);
    db.prepare(`INSERT INTO notices (kind, memory_a, memory_b, note, created_at) VALUES ('contradiction', ?, ?, 'two hosts for staging', ?)`).run(a, b, now);
  });
}

test('a session started outside a project is asked that project\'s guesses and notices with its card, once', () => {
  const s = sandbox();
  simbaWithQuestions(s);
  const started = s.hook('session-start', { session_id: 'away', source: 'startup', cwd: s.root }).out;
  assert.doesNotMatch(started, ASK_GUESS, 'the block at the start does not know the session is about simba');

  const first = s.hook('prompt', { session_id: 'away', prompt: 'lets work on simba today', cwd: s.root }).out;
  assert.match(first, /<project simba>/);
  assert.match(first, ASK_GUESS, 'the guess comes with the card');
  assert.match(first, ASK_NOTICE, 'and the notice');

  const again = s.hook('prompt', { session_id: 'away', prompt: 'and in simba, check the build', cwd: s.root }).out;
  assert.doesNotMatch(again, /Ask the user/, 'asked once a session');
});

test('a session started inside the project is asked at the start, and its card does not ask again', () => {
  const s = sandbox();
  simbaWithQuestions(s);
  const started = s.hook('session-start', { session_id: 'inside', source: 'startup', cwd: '/tmp/projects/simba' }).out;
  assert.match(started, ASK_GUESS);
  const first = s.hook('prompt', { session_id: 'inside', prompt: 'fix the flaky test', cwd: '/tmp/projects/simba' }).out;
  assert.match(first, /<project simba>/);
  assert.doesNotMatch(first, /Ask the user/, 'already asked in the block');
});

test('a job\'s brief and sumo project show carry the card without questions: only the user answers them', () => {
  const s = sandbox();
  simbaWithQuestions(s);
  assert.doesNotMatch(s.sumo(['project', 'show', 'simba']).out, /Ask the user/);
});
