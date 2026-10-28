import assert from 'node:assert/strict';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { tidyDue } from '../src/dream.mjs';
import { sandbox } from './helpers.mjs';

/** What the local model answers when a pair is put to it alone: `[{ pair, label }]`, by the pair's number in the call. */
const judgeWillSay = (s, pairs) =>
  writeFileSync(join(s.root, 'model-answer.json.dream-pairs'), JSON.stringify({ is_error: false, structured_output: { pairs }, usage: { input_tokens: 400, output_tokens: 20 }, total_cost_usd: 0 }));

/**
 * A finished conversation whose turns are already filed, with nothing in them worth keeping. Marked filed by hand: a
 * memory pass run here would tidy by itself once the third is over, before the test asks it to.
 */
function finishedSession(s, id, prompts) {
  for (const prompt of prompts) s.hook('prompt', { session_id: id, prompt });
  s.hook('session-end', { session_id: id, reason: 'other' });
  s.sql((db) => db.prepare('UPDATE user_turns SET scribed = 1 WHERE session_id = ?').run(id));
}

test('consolidation starts by itself once three finished sessions are waiting — not before', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  s.hook('session-start', { session_id: 'three', source: 'startup' });
  assert.equal(s.sql((db) => tidyDue(db)), false, 'two conversations are not enough to tidy');
  assert.match(s.sumo(['memory', 'status']).out, /^waiting {4}0 turns to file · 2 finished conversations to read \(tidied by itself at 3, and weekly\)$/m);

  finishedSession(s, 'three', ['again: shorter PR description']);
  s.hook('session-start', { session_id: 'four', source: 'startup' });
  assert.equal(s.sql((db) => tidyDue(db)), true, 'three are');
  assert.equal(s.spawned().includes('memory run'), true, 'and the one memory pass is started, which tidies');
});

test('a tidy names the memories it means: a clash between two that share no word with each other or its note is dropped, and a one-off ask is not a routine', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'keep your replies brief']);
  s.sumo(['add', 'preference', 'slate uses pnpm, never npm']);
  s.sumo(['add', 'preference', 'slate moved from pnpm to bun']);
  finishedSession(s, 'one', ['make the button blue']);
  finishedSession(s, 'two', ['deploy it: build, upload, smoke test']);
  finishedSession(s, 'three', ['deploy it again: build, upload, smoke test']);
  s.modelWillSay([
    { op: 'contradiction', ids: [1, 3], note: 'slate uses pnpm vs moved to bun' },
    { op: 'contradiction', ids: [2, 3], note: 'pnpm or bun' },
    { op: 'procedure', scope: 'global', title: 'change button color', cue: 'make the button blue', body: '1. open the theme\n2. set the colour' },
    { op: 'procedure', scope: 'global', title: 'deploy', cue: 'deploy it', body: '1. build\n2. upload\n3. smoke test' },
  ]);
  judgeWillSay(s, [{ pair: 1, label: 'conflict' }]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /dropped — contradiction: m1 shares no word with m3 or the note — not the memory meant/);
  assert.match(run.out, /to be judged on their own: m2 and m3 cannot both be true — pnpm or bun[\s\S]*raised for the user: m2 and m3 cannot both be true — pnpm or bun/);
  assert.match(run.out, /dropped — procedure: a routine is something done more than once, and "make the button blue" was said once/);
  assert.match(run.out, /held for confirmation m\d+ \[proc·global·inferred·unconfirmed\] "deploy"/);
});

test('a clash is raised only between memories the pass was shown: one it never saw is a wrong number, though the note names its words', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'slate moved from pnpm to bun']);
  // Read from a repository, so never shown to the pass — as the stack a project scan files is not.
  s.sql((db) => db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, scan_key, written_by, valid_from, created_at)
    VALUES ('fact', 'global', 'stack: JavaScript, npm', 'scanned', 'active', 0.5, 'stack', 'scanner', ?, ?)`).run(new Date().toISOString(), new Date().toISOString()));
  finishedSession(s, 'one', ['thanks, that is all']);
  s.modelWillSay([{ op: 'contradiction', ids: [1, 2], note: 'the stack says npm, but slate moved to bun' }]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.doesNotMatch(s.modelWasShown().prompt, /stack: JavaScript/, 'it was never shown');
  assert.match(run.out, /dropped — contradiction: m2 is not one of the memories this pass was shown/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM notices').get().n), 0, 'nothing put to the user');
});

test('reading sessions side by side: a pattern becomes a question, a clash is raised, a routine is proposed — nothing is decided for the user', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'use tabs for indentation']);
  s.sumo(['add', 'preference', 'use two spaces for indentation']);
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it', 'release it the usual way: run the tests, bump the version, tag it, push the tag']);
  finishedSession(s, 'three', ['again: shorter PR description', 'to release: run the tests, bump the version, tag it, push the tag']);

  s.modelWillSay([
    { op: 'add', type: 'preference', scope: 'global', topic: 'writing', body: 'The user wants pull request descriptions kept short' },
    { op: 'contradiction', ids: [1, 2], note: 'tabs and two spaces cannot both be the indentation rule' },
    { op: 'procedure', scope: 'global', title: 'release', cue: 'release it', body: '1. run the tests\n2. bump the version\n3. tag it\n4. push the tag' },
    { op: 'supersede', old: 1, body: 'use four spaces for indentation', turn: 1, quote: 'a sentence nobody said' },
  ]);
  judgeWillSay(s, [{ pair: 1, label: 'conflict' }]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^tidy: read 3 sessions/);
  assert.match(run.out, /held for confirmation m3 \[pref·global·inferred·unconfirmed\]/);
  assert.match(run.out, /raised for the user: m1 and m2 cannot both be true — tabs and two spaces/);
  assert.match(run.out, /held for confirmation m4 \[proc·global·inferred·unconfirmed\] "release"/);
  assert.match(run.out, /held for confirmation m5 /, 'an unproven replacement is only a guess');

  // The model saw the conversations and what is already remembered; the clash it named was then put to it alone.
  const sent = readFileSync(join(s.root, 'model-saw.json.all'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const shown = sent.find((r) => r.kind === 'dream');
  assert.match(sent.at(-1).prompt, /^Pairs to judge — [^\n]*\n\[p1\]\n {2}A: m1 [^\n]*use tabs for indentation\n {2}B: m2 [^\n]*use two spaces for indentation$/);
  assert.match(shown.system, /^You label text\. You are shown several finished conversations/);
  assert.match(shown.prompt, /What is already remembered:\n[\s\S]*use tabs for indentation/);
  assert.match(shown.prompt, /\[t\d+\] user: again: shorter PR description/);
  assert.deepEqual(shown.schema.properties.ops.items.anyOf.map((branch) => branch.properties.op.enum[0]), ['add', 'supersede', 'gotcha', 'contradiction', 'same', 'procedure'], 'a checkpoint is omitted when there is no known project it could name');

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

  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /nothing to do — no finished sessions are waiting/);
});

test('a bad answer changes nothing and the sessions are read again next time', () => {
  const s = sandbox();
  finishedSession(s, 'one', ['hello']);
  writeFileSync(join(s.root, 'model-answer.json'), JSON.stringify({ is_error: false, structured_output: { ops: 'not a list' }, usage: {}, total_cost_usd: 0 }));

  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^tidy: failed — the answer had no list of operations/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), 0);
  assert.match(s.sumo(['memory', 'status']).out, /1 finished conversation to read/);
  assert.match(s.sumo(['memory', 'status']).out, /tidying: 1 run \(0 ok\)/);
});

test('a pass that reads a conversation still going on does not close it: what is said in the rest of it is read later', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'open', prompt: 'first thing in a long session' });
  finishedSession(s, 'one', ['keep the PR description short please']);
  finishedSession(s, 'two', ['that PR description is too long, cut it']);
  finishedSession(s, 'three', ['again: shorter PR description']);
  s.hook('session-start', { session_id: 'four', source: 'startup' });
  assert.equal(s.sql((db) => tidyDue(db)), true, 'three are');
  assert.equal(s.spawned().includes('memory run'), true, 'and the one memory pass is started, which tidies');

  s.modelWillSay([]);
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^(?:tidy: )?read 4 sessions/m);
  const states = s.sql((db) => Object.fromEntries(db.prepare('SELECT id, dream_state FROM sessions').all().map((r) => [r.id, r.dream_state])));
  assert.deepEqual(states, { open: 'pending', one: 'done', two: 'done', three: 'done', four: 'pending' });

  s.hook('prompt', { session_id: 'open', prompt: 'second thing: always use pnpm' });
  finishedSession(s, 'open', []);
  assert.match(s.sumo(['memory', 'status']).out, /1 finished conversation to read/);
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
  const run = s.sumo(['memory', 'run', '--tidy'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: stub } });
  assert.equal(run.code, 0, run.err);
  assert.equal(s.sql((db) => db.prepare('SELECT dream_state FROM sessions WHERE id = ?').get('one').dream_state), 'pending');
  s.hook('session-end', { session_id: 'one' });
  s.modelWillSay([]);
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^(?:tidy: )?read 1 sessions/m);
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
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^tidy: nothing to do — no finished sessions are waiting/);
  assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM sessions WHERE dream_state = 'done'`).get().n), 0);

  rmSync(join(s.home, 'scribe.lock'));
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^read \d+ turns[\s\S]*^tidy: read 3 sessions/m, 'the pass files them first, then they are read');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns WHERE scribed = 0').get().n), 0);
});

test('with the writer turned off there is nothing to wait for', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.hook('session-end', { session_id: 'one', reason: 'other' });
  s.sql((db) => db.prepare(`INSERT INTO meta (key, value) VALUES ('config.memory.model', 'off')`).run());
  s.modelWillSay([]);
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^(?:tidy: )?read 1 sessions/m);
});

test('asked for by hand, consolidation does not wait for the conversation to end', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'still-open', prompt: 'always squash merge' });
  s.modelWillSay([]);
  s.sumo(['memory', 'run']);
  assert.match(s.sumo(['memory', 'status']).out, /0 finished conversations to read/);
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^(?:tidy: )?read 1 sessions/m);
});

test('a long conversation is read by its latest turns, as many as fit, so consolidation never asks for more than the model holds', () => {
  const s = sandbox();
  const prompts = Array.from({ length: 20 }, (_, i) => `message ${i}: ${'please keep the release notes short and plain '.repeat(20)}`);
  finishedSession(s, 'long', prompts);
  s.modelWillSay([]);
  assert.equal(s.sumo(['memory', 'run', '--tidy']).code, 0);
  const prompt = s.modelWasShown().prompt;
  assert.match(prompt, /\[\d+ earlier turns not shown\]/);
  assert.match(prompt, /message 19:/, 'the latest turn is read');
  assert.doesNotMatch(prompt, /message 0:/);
  const shown = prompt.split('\n').filter((l) => /^\[t\d+\] user:/.test(l)).join('\n');
  assert.ok(shown.length <= 8_000, `${shown.length} characters of turns`);
});
