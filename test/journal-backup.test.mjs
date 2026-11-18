// The journal in the copies: a backup and a restore carry the replies, the ledger of passes and each memory's
// history; and a purge reaches the replies a backup holds, as it does the database's own.
import assert from 'node:assert/strict';
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { HAS_PTY, sandbox } from './helpers.mjs';

/** A conversation heard through the hooks: what the user said, and what the assistant answered. */
function conversation(s, id, said, answered) {
  s.hook('prompt', { session_id: id, prompt: said });
  s.hook('stop', { session_id: id, last_assistant_message: answered });
}

const inCopy = (file, fn) => {
  const db = new DatabaseSync(file);
  try {
    return fn(db);
  } finally {
    db.close();
  }
};

test('a backup carries the replies, the passes and each memory\'s history, and a restore brings them back searchable', () => {
  const s = sandbox();
  conversation(s, 'c1', 'the invoice exporter crashes on umlauts in the billing address', 'The exporter assumes latin-1; switching its writer to utf-8 fixes the crash.');
  s.sumo(['add', 'fact', 'the invoice exporter writes utf-8']);
  s.sql((db) => db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('c1', 'abc12345', 'ok', 1, 1, 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString()));
  const counts = (db) => Object.fromEntries(['replies', 'extractions', 'memory_events', 'user_turns'].map((t) => [t, db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n]));
  const before = s.sql(counts);
  assert.deepEqual(before, { replies: 1, extractions: 1, memory_events: 1, user_turns: 1 });

  assert.equal(s.sumo(['backup']).code, 0);
  const [copy] = readdirSync(join(s.home, 'backups'));
  assert.deepEqual(inCopy(join(s.home, 'backups', copy), counts), before, 'the copy holds the new tables whole');

  // Everything after the copy goes; what was in it comes back.
  conversation(s, 'c2', 'said after the backup', 'answered after the backup');
  s.sql((db) => db.exec('DELETE FROM replies; DELETE FROM extractions; DELETE FROM memory_events;'));
  const restored = s.sumo(['backup', 'restore', '--yes']);
  assert.equal(restored.code, 0, restored.err);
  assert.deepEqual(s.sql(counts), before);
  assert.equal(s.sql((db) => db.prepare(`SELECT r.id FROM replies_fts JOIN replies r ON r.id = replies_fts.rowid WHERE replies_fts MATCH '"latin"'`).all().length), 1, 'and the reply is found by its words');
  assert.equal(s.sumo(['memory', 'check']).code, 0, 'every index of the restored database checks out');
});

test('purge reaches the replies in every backup: the answer that said the erased words back is gone from the copies, its index too', () => {
  const s = sandbox();
  const secret = 'zanzibarquux'; // one word: the full-text index keeps it whole
  conversation(s, 'c1', `the door code is ${secret}`, `Noted — the door code is ${secret}, and I will not write it anywhere else.`);
  conversation(s, 'c1', 'and the bins go out on thursday', 'Thursday for the bins, got it.');
  s.sumo(['add', 'fact', `the door code is ${secret}`]);
  s.sql((db) => db.prepare(`UPDATE memories SET source_turn = 1, source_session = 'c1' WHERE id = 1`).run());
  s.sumo(['backup']);

  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.equal(purged.code, 0, purged.err);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, with the sentence it came from and 1 reply of sumo's that said it back, and from 1 backup$/m);
  for (const file of readdirSync(join(s.home, 'backups'))) {
    const path = join(s.home, 'backups', file);
    assert.equal(readFileSync(path).includes(secret), false, `${file} still holds the purged words`);
    assert.deepEqual(inCopy(path, (db) => db.prepare('SELECT text FROM replies').all().map((r) => r.text)), ['Thursday for the bins, got it.'], 'only the reply that said it back went');
  }
});

test('a backup from before replies were kept is still cleaned by a purge, not reported as one that could not be', () => {
  const s = sandbox();
  const secret = 'quokkavelvet';
  s.sumo(['add', 'preference', `Always use ${secret} for deploys`]);
  s.sumo(['backup']);
  const [copy] = readdirSync(join(s.home, 'backups'));
  inCopy(join(s.home, 'backups', copy), (db) => db.exec('DROP TABLE replies_fts; DROP TABLE replies; VACUUM;'));

  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, and from 1 backup;/m);
  assert.doesNotMatch(purged.out, /could not be cleaned/);
  assert.equal(readFileSync(join(s.home, 'backups', copy)).includes(secret), false);
});

/** Every file under a folder that holds a word, by its path from there. */
function holding(dir, word, under = '') {
  return readdirSync(join(dir, under)).flatMap((name) => {
    const path = join(under, name);
    return statSync(join(dir, path)).isDirectory() ? holding(dir, word, path) : readFileSync(join(dir, path)).includes(word) ? [path] : [];
  });
}
const DOOR = 'the garage door code is zebra-4417-quokka';
const FILED = { op: 'add', type: 'fact', scope: 'global', topic: 'home', body: 'The garage door code is zebra-4417-quokka', turn: 1, quote: DOOR, keys: [] };

test('a purge erases every turn and reply that says the memory, in any conversation — from the database, each backup with what its passes proposed, and the spool', () => {
  const s = sandbox();
  conversation(s, 'a', `remember ${DOOR}`, `Noted — ${DOOR}.`);
  conversation(s, 'a', 'and the bins go out on thursday', 'Thursday for the bins, got it.');
  s.hook('session-end', { session_id: 'a' });
  conversation(s, 'b', `as I said yesterday, ${DOOR.toUpperCase()}`, `Yes: ${DOOR}, and it stays out of every file.`);
  conversation(s, 'b', 'what day do the bins go out', 'Thursday.');
  s.modelWillSay([FILED]);
  assert.match(s.sumo(['memory', 'run', '--auto']).out, /saved m1 /);
  s.sumo(['backup']);
  // A turn that could not be written, still waiting, and one set aside as unreadable: both say it.
  mkdirSync(join(s.home, 'spool'), { recursive: true });
  const waiting = (text) => JSON.stringify({ v: 1, at: new Date().toISOString(), event: 'prompt', harness: 'claude', session_id: 'c', text });
  writeFileSync(join(s.home, 'spool', 'events.jsonl'), `${waiting(`once more: ${DOOR}`)}\n${waiting('something else entirely')}\n`);
  writeFileSync(join(s.home, 'spool', 'events.bad.jsonl'), `${JSON.stringify({ at: new Date().toISOString(), why: 'no time it happened', line: JSON.stringify({ v: 1, event: 'prompt', session_id: 'd', text: `again, ${DOOR}` }) })}\n`);

  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.equal(purged.code, 0, purged.err);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, with the sentence it came from and 1 more turn that says it and 2 replies of sumo's that said it back, and from 1 backup, and 2 lines of the spool$/m);
  assert.equal(purged.out.split('\n').filter((l) => /^ {2}[tr]\d+ · /.test(l)).length, 4, 'each row that went is listed');
  assert.match(purged.out, /\nother mentions may remain — find them: sumo search "<words>" --turns, erase one: sumo forget --purge t12\n$/);
  assert.deepEqual(holding(s.home, 'quokka'), [], 'no file under the home holds the words');
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns ORDER BY id').all().map((r) => r.text)), ['and the bins go out on thursday', 'what day do the bins go out']);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM replies ORDER BY id').all().map((r) => r.text)), ['Thursday for the bins, got it.', 'Thursday.']);
  assert.match(s.sumo(['search', 'garage door code']).out, /^nothing in memory for: garage door code — nor in the conversations/);
  assert.doesNotMatch(s.sumo(['search', 'garage door code']).out, /quokka/);
  for (const file of readdirSync(join(s.home, 'backups'))) {
    const copy = inCopy(join(s.home, 'backups', file), (db) => ({ turns: db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n, replies: db.prepare('SELECT COUNT(*) AS n FROM replies').get().n, ops: db.prepare('SELECT ops_json FROM extractions').all().map((r) => r.ops_json) }));
    assert.deepEqual(copy, { turns: 2, replies: 2, ops: [null] }, 'the copy lost the same rows, and what the pass proposed');
  }
  assert.equal(readFileSync(join(s.home, 'spool', 'events.jsonl'), 'utf8').trim().split('\n').length, 1, 'the other event still waits');
});

test('a purge of a memory with no turn behind it — saved by sumo add — still erases the turn and the reply that say it whole, and lists them', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'a', prompt: `remember ${DOOR}` });
  assert.match(s.sumo(['add', 'fact', DOOR]).out, /^saved m1 /);
  s.hook('stop', { session_id: 'a', last_assistant_message: `Saved: ${DOOR}.` });

  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, with 1 turn and 1 reply that say it\n {2}t1 · \d{4}-\d\d-\d\d · remember the garage door code is zebra-4417-quokka\n {2}r1 · \d{4}-\d\d-\d\d · Saved: the garage door code is zebra-4417-quokka\.\nother mentions may remain — find them: sumo search "<words>" --turns, erase one: sumo forget --purge t12\n$/);
  assert.deepEqual(holding(s.home, 'quokka'), []);
});

test('a purge takes no conversation that merely holds a short memory\'s few words: under five words and twenty-five characters, only the memory and the turn it cites go', () => {
  const s = sandbox();
  const talk = (id, said, answered) => conversation(s, id, said, answered);
  talk('a', 'we use bun', 'Understood.');
  talk('b', 'here is the whole migration plan I spent an hour writing: step one move the tables, step two backfill, step three cut over. By the way we use bun for the scripts', 'A solid plan: move, backfill, cut over. And yes, we use bun.');
  talk('c', 'unrelated question about tides', 'Understood.');
  s.sumo(['add', 'fact', 'we use bun']);
  const counts = () => s.sql((db) => [db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n, db.prepare('SELECT COUNT(*) AS n FROM replies').get().n]);
  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.equal(purged.out, 'purged m1 — erased, not recoverable; no sentence of the user\'s was tied to it — sumo search --turns finds one if it is there\nother mentions may remain — find them: sumo search "<words>" --turns, erase one: sumo forget --purge t12\n');
  assert.deepEqual(counts(), [3, 3], 'every conversation is as it was');
  assert.match(s.sumo(['search', 'migration plan backfill']).out, /t2 \[you said\]/);
});

test('one turn or reply is erased for good by its id — sumo forget --purge t2 — shown first, from the backups and the spool too: how a mention the memory\'s purge left is taken out', () => {
  const s = sandbox();
  conversation(s, 'a', `remember ${DOOR}`, 'Noted.');
  conversation(s, 'a', 'zebra-4417-quokka also opens the side gate', 'Good to know: zebra-4417-quokka, side gate too.');
  conversation(s, 'a', 'and the bins go out on thursday', 'Thursday for the bins, got it.');
  s.hook('session-end', { session_id: 'a' });
  s.modelWillSay([FILED]);
  assert.match(s.sumo(['memory', 'run', '--auto']).out, /saved m1 /);
  s.sumo(['backup']);
  mkdirSync(join(s.home, 'spool'), { recursive: true });
  writeFileSync(join(s.home, 'spool', 'events.jsonl'), `${JSON.stringify({ v: 1, at: new Date().toISOString(), event: 'prompt', harness: 'claude', session_id: 'a', text: 'zebra-4417-quokka also opens the side gate' })}\n`);

  const first = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.match(first.out, /^purged m1 — erased, not recoverable, with the sentence it came from, and from 1 backup\n {2}t1 · /);
  assert.match(first.out, /^other mentions may remain — find them: sumo search "<words>" --turns, erase one: sumo forget --purge t12$/m);
  const found = s.sumo(['search', 'quokka', '--turns']).out;
  assert.match(found, /^t2 \[you said\] zebra-4417-quokka also opens the side gate/m, 'the turn that says the code alone is still there, and found as the purge said');

  // The model's shell may not; the user, without a terminal, says --yes.
  assert.match(s.sumo(['forget', '--purge', 't2', '--yes'], { extraEnv: { SUMO_TOOL: '1' } }).err, /erasing a turn or a reply for good is the user's to do/);
  assert.equal(s.sumo(['forget', '--purge', 't2']).code, 2, 'asks first');
  assert.equal(s.sumo(['forget', 't2']).code, 2, 'a turn is never merely forgotten');
  const turn = s.sumo(['forget', '--purge', 't2', '--yes']);
  assert.equal(turn.code, 0, turn.err);
  assert.match(turn.out, /^purged t2 — erased, not recoverable, and from 1 backup, and 1 line of the spool\n$/);
  const reply = s.sumo(['forget', '--purge', 'r2', '--yes']);
  assert.match(reply.out, /^purged r2 — erased, not recoverable, and from 1 backup\n$/);
  assert.deepEqual(holding(s.home, 'quokka'), []);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns').all().map((r) => r.text)), ['and the bins go out on thursday']);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM replies ORDER BY id').all().map((r) => r.text)), ['Noted.', 'Thursday for the bins, got it.']);
  assert.match(s.sumo(['forget', '--purge', 't99', '--yes']).err, /no turn t99 in the conversations/);
  assert.equal(s.sumo(['memory', 'check']).code, 0, 'the indexes still hold what is left');
});

test('a turn that a memory still cites is erased when asked, and the memory that holds its words is named', () => {
  const s = sandbox();
  conversation(s, 'a', `remember ${DOOR}`, 'Noted.');
  s.hook('session-end', { session_id: 'a' });
  s.modelWillSay([FILED]);
  s.sumo(['memory', 'run', '--auto']);
  const out = s.sumo(['forget', '--purge', 't1', '--yes']).out;
  assert.match(out, /^purged t1 — erased, not recoverable\nm1 was drawn from it and still holds its words: sumo forget m1 --purge erases it too\n$/);
});

test('at a terminal, a purge lists each turn and reply that will go with the memory before its id is typed back', { skip: !HAS_PTY && 'no python3 pty here' }, () => {
  const s = sandbox();
  conversation(s, 'a', `remember ${DOOR}`, `Noted — ${DOOR}.`);
  conversation(s, 'b', `again: ${DOOR}`, 'Yes.');
  s.sumo(['add', 'fact', DOOR]);
  const asked = s.typed(['forget', 'm1', '--purge'], 'no', ':');
  assert.match(asked.out, /m1 \[fact·global·stated\] the garage door code is zebra-4417-quokka\nwith it go 2 turns and 1 reply that say it:\n {2}t1 · \d{4}-\d\d-\d\d · remember the garage door code is zebra-4417-quokka\n {2}t2 · \d{4}-\d\d-\d\d · again: the garage door code is zebra-4417-quokka\n {2}r1 · \d{4}-\d\d-\d\d · Noted — the garage door code is zebra-4417-quokka\.\nErase m1 for good, from every backup too\? Type m1 to confirm:/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n), 2, 'declined: nothing went');

  const row = s.typed(['forget', '--purge', 't2'], 't2', ':');
  assert.match(row.out, /t2 · \d{4}-\d\d-\d\d · again: the garage door code is zebra-4417-quokka\nErase t2 for good, from every backup too\? Type t2 to confirm:/);
  assert.match(row.out, /purged t2 — erased, not recoverable/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n), 1);
});
