import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

/** A finished conversation whose turns the writer has already filed. */
function finishedSession(s, id, prompts) {
  for (const prompt of prompts) s.hook('prompt', { session_id: id, prompt });
  s.hook('session-end', { session_id: id, reason: 'other' });
  s.modelWillSay([]);
  s.sumo(['scribe', 'run']);
}

test('consolidation starts by itself once three finished sessions are waiting — not before', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  s.hook('session-start', { session_id: 'three', source: 'startup' });
  assert.equal(s.spawned().includes('dream run'), false);
  assert.match(s.sumo(['dream', 'status']).out, /finished sessions waiting: 2 \(runs by itself at 3\)/);

  finishedSession(s, 'three', ['again: shorter PR description']);
  s.hook('session-start', { session_id: 'four', source: 'startup' });
  assert.equal(s.spawned().includes('dream run'), true);
});

test('reading sessions side by side: a pattern becomes a question, a clash is raised, a routine is proposed — nothing is decided for the user', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'use tabs for indentation']);
  s.sumo(['add', 'preference', 'use two spaces for indentation']);
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  finishedSession(s, 'three', ['again: shorter PR description', 'to release: run the tests, bump the version, tag it, push the tag']);

  s.modelWillSay([
    { op: 'add', type: 'preference', scope: 'global', topic: 'writing', body: 'The user wants pull request descriptions kept short' },
    { op: 'contradiction', ids: [1, 2], note: 'tabs and two spaces cannot both be the indentation rule' },
    { op: 'procedure', scope: 'global', title: 'release', cue: 'release it', body: '1. run the tests\n2. bump the version\n3. tag it\n4. push the tag' },
    { op: 'supersede', old: 1, body: 'use four spaces for indentation', turn: 1, quote: 'a sentence nobody said' },
  ]);
  const run = s.sumo(['dream', 'run']);
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
  assert.deepEqual(shown.schema.properties.ops.items.anyOf.map((branch) => branch.properties.op.enum[0]), ['add', 'supersede', 'gotcha', 'contradiction', 'procedure'], 'a checkpoint is omitted when there is no known project it could name');

  // Everything waits for the user; the two real memories are untouched.
  const block = s.sumo(['prime']).out;
  assert.match(block, /Ask the user \(then sumo confirm\|reject m3\): is this right\? "The user wants pull request descriptions kept short"/);
  assert.match(block, /Ask the user \(then sumo confirm\|reject m4\): is this right\? "workflow "release""/);
  assert.match(block, /Ask the user: m1 and m2 disagree — tabs and two spaces cannot both be the indentation rule/);
  assert.match(s.sumo(['search', 'indentation']).out, /m1 .*tabs[\s\S]*m2 .*two spaces|m2 .*two spaces[\s\S]*m1 .*tabs/);

  // Settling the clash makes the notice go away on its own.
  s.sumo(['forget', 'm1']);
  assert.doesNotMatch(s.sumo(['prime']).out, /disagree/);

  // A confirmed workflow becomes a real one.
  s.sumo(['confirm', 'm4']);
  assert.match(s.sumo(['prime']).out, /Workflows — before doing what one covers, run sumo show <id> and follow it: m4 "release" — when: release it/);

  assert.match(s.sumo(['dream', 'run']).out, /nothing to do — no finished sessions are waiting/);
});

test('a bad answer changes nothing and the sessions are read again next time', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['hello']);
  writeFileSync(join(s.root, 'model-answer.json'), JSON.stringify({ is_error: false, structured_output: { ops: 'not a list' }, usage: {}, total_cost_usd: 0 }));

  assert.match(s.sumo(['dream', 'run']).out, /^failed — the answer had no list of operations/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), 0);
  assert.match(s.sumo(['dream', 'status']).out, /finished sessions waiting: 1/);
  assert.match(s.sumo(['scribe', 'stats']).out, /dream: 1 runs \(0 ok\)/);
});

test('a pass that reads a conversation still going on does not close it: what is said in the rest of it is read later', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'open', prompt: 'first thing in a long session' });
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  finishedSession(s, 'three', ['again: shorter PR description']);
  s.hook('session-start', { session_id: 'four', source: 'startup' });
  assert.equal(s.spawned().includes('dream run'), true);

  s.modelWillSay([]);
  assert.match(s.sumo(['dream', 'run']).out, /^read 4 sessions/);
  const states = s.sql((db) => Object.fromEntries(db.prepare('SELECT id, dream_state FROM sessions').all().map((r) => [r.id, r.dream_state])));
  assert.deepEqual(states, { open: 'pending', one: 'done', two: 'done', three: 'done', four: 'pending' });

  s.hook('prompt', { session_id: 'open', prompt: 'second thing: always use pnpm' });
  finishedSession(s, 'open', []);
  assert.match(s.sumo(['dream', 'status']).out, /finished sessions waiting: 1/);
});

test('a new turn during consolidation remains pending for a later pass', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['always review before shipping']);
  const stub = join(s.root, 'resume-during-model.mjs');
  writeFileSync(stub, `#!/usr/bin/env node
    import { readFileSync } from 'node:fs';
    import { openDb } from ${JSON.stringify(new URL('../src/db.mjs', import.meta.url).href)};
    import { ensureSession, recordTurn } from ${JSON.stringify(new URL('../src/sessions.mjs', import.meta.url).href)};
    readFileSync(0, 'utf8');
    const db = openDb(), now = new Date().toISOString();
    ensureSession(db, { id: 'one', now });
    recordTurn(db, { sessionId: 'one', text: 'always keep rollback instructions', now });
    db.close();
    console.log(JSON.stringify({ structured_output: { ops: [] }, usage: {}, total_cost_usd: 0 }));
  `, { mode: 0o755 });
  const run = s.sumo(['dream', 'run'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: stub } });
  assert.equal(run.code, 0, run.err);
  assert.equal(s.sql((db) => db.prepare('SELECT dream_state FROM sessions WHERE id = ?').get('one').dream_state), 'pending');
  s.hook('session-end', { session_id: 'one' });
  s.modelWillSay([]);
  assert.match(s.sumo(['dream', 'run']).out, /^read 1 sessions/);
});

test('consolidation reads what the writer filed: a conversation it has not finished filing waits for it', () => {
  const s = sandbox();
  for (const id of ['one', 'two', 'three']) {
    s.hook('prompt', { session_id: id, prompt: `from now on always squash merge, said in ${id}` });
    s.hook('session-end', { session_id: id, reason: 'other' });
  }
  // The writer started by the same session start is still busy with these turns.
  writeFileSync(join(s.home, 'scribe.lock'), String(process.pid));
  s.modelWillSay([]);
  assert.match(s.sumo(['dream', 'run']).out, /^nothing to do — no finished sessions are waiting/);
  assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE dream_state = 'done'`).get().n), 0);

  rmSync(join(s.home, 'scribe.lock'));
  assert.match(s.sumo(['dream', 'run']).out, /^read 3 sessions/, 'the writer files them first, then they are read');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns WHERE scribed = 0').get().n), 0);
});

test('with the writer turned off there is nothing to wait for', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.hook('session-end', { session_id: 'one', reason: 'other' });
  s.sql((db) => db.prepare(`INSERT INTO meta (key, value) VALUES ('config.scribe.model', 'off')`).run());
  s.modelWillSay([]);
  assert.match(s.sumo(['dream', 'run']).out, /^read 1 sessions/);
});

test('asked for by hand, consolidation does not wait for the conversation to end', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'still-open', prompt: 'always squash merge' });
  s.modelWillSay([]);
  s.sumo(['scribe', 'run']);
  assert.match(s.sumo(['dream', 'status']).out, /finished sessions waiting: 0/);
  assert.match(s.sumo(['dream', 'run']).out, /^read 1 sessions/);
});

test('a long conversation is read by its latest turns, as many as fit, so consolidation never asks for more than the model holds', () => {
  const s = sandbox();
  const prompts = Array.from({ length: 20 }, (_, i) => `message ${i}: ${'please keep the release notes short and plain '.repeat(20)}`);
  finishedSession(s, 'long', prompts);
  s.modelWillSay([]);
  assert.equal(s.sumo(['dream', 'run']).code, 0);
  const prompt = s.modelWasShown().prompt;
  assert.match(prompt, /\[\d+ earlier turns not shown\]/);
  assert.match(prompt, /message 19:/, 'the latest turn is read');
  assert.doesNotMatch(prompt, /message 0:/);
  const shown = prompt.split('\n').filter((l) => /^\[t\d+\] user:/.test(l)).join('\n');
  assert.ok(shown.length <= 8_000, `${shown.length} characters of turns`);
});
