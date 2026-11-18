// `sumo search` as it is typed and read: one list, each line saying what it is, when it was said, and the id that opens it.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const DAY = '2026-11-10';
/** Journal rows written straight in, as the hooks would have: `[who, words, project]`, a minute apart. */
function talk(s, sessionId, lines) {
  s.sumo(['config']); // first touch creates the database
  s.sql((db) => {
    db.prepare(`INSERT OR IGNORE INTO sessions (id, harness, started_at) VALUES (?, 'sumo', ?)`).run(sessionId, `${DAY}T09:00:00.000Z`);
    lines.forEach(([who, text, project = null], i) => {
      const ts = `${DAY}T09:${String(i + 1).padStart(2, '0')}:00.000Z`;
      if (who === 'you') db.prepare('INSERT INTO user_turns (session_id, ts, text, project, full_len) VALUES (?, ?, ?, ?, ?)').run(sessionId, ts, text, project, text.length);
      else db.prepare('INSERT INTO replies (session_id, ts, text, project, full_len) VALUES (?, ?, ?, ?, ?)').run(sessionId, ts, text, project, text.length);
    });
  });
}
const missed = (s) => s.sql((db) => db.prepare('SELECT query FROM search_misses ORDER BY rowid').all().map((r) => r.query));

test('a search answered by a memory prints it with its day, then a few marked lines of the conversations', () => {
  const s = sandbox();
  s.sumo(['add', 'decision', 'the roadmap lives in the wiki']);
  talk(s, 'one', [['you', 'where should the roadmap live, the repo or the wiki?'], ['sumo', 'The wiki: the roadmap changes more often than the code.']]);
  const lines = s.sumo(['search', 'roadmap wiki']).out.trim().split('\n');
  assert.match(lines[0], /^m1 \[dec·global·stated\] the roadmap lives in the wiki · \d{4}-\d{2}-\d{2}$/);
  assert.equal(lines[1], 'also said in the conversations (sumo show <id> opens one whole):');
  assert.deepEqual(lines.slice(2).sort(), [
    `r1 [sumo said] The wiki: the roadmap changes more often than the code. · ${DAY}`,
    `t1 [you said] where should the roadmap live, the repo or the wiki? · ${DAY}`,
  ]);
  assert.deepEqual(missed(s), []);
});

test('a search no memory answers is answered by the conversations, says so, and is not a miss; one that finds nothing anywhere is', () => {
  const s = sandbox();
  talk(s, 'one', [['you', 'should the harness be rewritten in rust?'], ['sumo', 'Not yet: a rust rewrite buys startup time and costs the whole tool loop.']]);
  const lines = s.sumo(['search', 'rust rewrite']).out.trim().split('\n');
  assert.equal(lines[0], 'no memory of this — said in the conversations (sumo show <id> opens one whole):');
  assert.deepEqual(lines.slice(1), [`r1 [sumo said] Not yet: a rust rewrite buys startup time and costs the whole tool loop. · ${DAY}`], 'only the line holding both words');
  assert.deepEqual(missed(s), []);

  assert.equal(s.sumo(['search', 'kubernetes']).out, 'nothing in memory for: kubernetes — nor in the conversations\n');
  assert.deepEqual(missed(s), ['kubernetes']);
});

test('a line that shares one word of several is shown, called loose, and kept as a miss', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'never push to main; always open a pull request']);
  const out = s.sumo(['search', 'how should I be pushing changes']).out;
  assert.match(out, /^m1 \[pref·global·stated\] never push to main/);
  assert.match(out, /^a loose match: no line holds two of these words — not an answer to rely on$/m);
  assert.deepEqual(missed(s), ['how should I be pushing changes']);
});

test('--turns is the conversations alone: both sides, no memory, no header, and its own word for nothing', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the release script signs the build']);
  talk(s, 'one', [['you', 'run the release script'], ['sumo', 'The release script finished: build signed.']]);
  const lines = s.sumo(['search', 'release script', '--turns']).out.trim().split('\n').sort();
  assert.deepEqual(lines, [`r1 [sumo said] The release script finished: build signed. · ${DAY}`, `t1 [you said] run the release script · ${DAY}`]);
  assert.equal(s.sumo(['search', 'kubernetes', '--turns']).out, 'nothing in the conversations for: kubernetes\n');
  assert.deepEqual(missed(s), [], 'nothing was asked of memory');
  const refused = s.sumo(['search', 'release', '--turns', '--type', 'fact']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /--type picks a kind of memory, and --turns leaves memories out/);
});

test('what another project said is counted with its memories, and shown when the project is named', () => {
  const s = sandbox();
  s.addProject('simba');
  s.sumo(['add', 'fact', 'simba staging certificate is a wildcard', '--project', 'simba']);
  talk(s, 'one', [['you', 'the staging certificate for simba expires in march', 'simba']]);
  const plain = s.sumo(['search', 'staging certificate']).out;
  assert.equal(plain, 'nothing in memory for: staging certificate — nor in the conversations\nmatches in other projects, not shown: simba (2) — add --project <name> or --everywhere\n');
  const named = s.sumo(['search', 'staging certificate', '--project', 'simba']).out;
  assert.match(named, /^m1 \[fact·simba·stated\]/);
  assert.match(named, /^t1 \[you said·simba\] the staging certificate for simba expires in march/m);
});

test('--json is one object with its lists named: memories and conversations, each row with the id that opens it', () => {
  const s = sandbox();
  s.sumo(['add', 'decision', 'the roadmap lives in the wiki']);
  talk(s, 'one', [['you', 'put the roadmap in the wiki']]);
  const found = JSON.parse(s.sumo(['search', 'roadmap wiki', '--json']).out);
  assert.deepEqual(Object.keys(found), ['memories', 'conversations', 'more', 'moreConversations', 'elsewhere', 'loose']);
  assert.equal(found.memories[0].id, 1);
  assert.deepEqual(found.conversations, [{ kind: 'turn', ref: 't1', id: 1, session_id: 'one', ts: `${DAY}T09:01:00.000Z`, project: null, full_len: 27, excerpt: 'put the roadmap in the wiki', held: 2 }]);
  assert.deepEqual(Object.keys(JSON.parse(s.sumo(['search', 'roadmap wiki', '--turns', '--json']).out)), ['conversations', 'moreConversations', 'elsewhere']);
});

test('sumo show opens a turn or a reply whole, by the id a search printed, with what was said around it', () => {
  const s = sandbox();
  const long = `Here is the plan. ${'One more step follows. '.repeat(30)}Done.`;
  talk(s, 'abcdef0123456789', [['you', 'what is the plan?'], ['sumo', long], ['you', 'go ahead'], ['sumo', 'Started.']]);
  const shown = s.sumo(['show', 'r1']).out;
  assert.match(shown, new RegExp(`^r1 \\[sumo said\\] ${DAY} 09:02 · conversation abcdef01\\n\\nHere is the plan\\.`));
  assert.ok(shown.includes(long), 'whole, not the line a search clips it to');
  assert.match(shown, /around it \(sumo show <id> opens one whole\):\n {2}t1 \[you said\] .* what is the plan\?\n> r1 \[sumo said\] .*…\n {2}t2 \[you said\] .* go ahead\n {2}r2 \[sumo said\] .* Started\.\n$/);

  assert.match(s.sumo(['show', 't2']).out, /^t2 \[you said\] .*\n\ngo ahead\n/);
  assert.deepEqual(JSON.parse(s.sumo(['show', 't2', '--json']).out).turn.text, 'go ahead');
  const none = s.sumo(['show', 't99']);
  assert.equal(none.code, 1);
  assert.match(none.err, /no turn t99 in the conversations/);
});

test('a purge erases sumo\'s replies that said the purged words back — in its conversation and in any other — from the database files and the reply index too, and leaves the other replies', () => {
  const s = sandbox();
  const secret = 'zq7hunter2vault'; // a shape the scrubber does not know, which is when purge is needed
  const quote = `the staging login is admin / ${secret}`;
  talk(s, 'sess-p', [
    ['you', `${quote}, remember that`],
    ['sumo', `Noted, xylophonequark — I will remember that The Staging   login\nis admin / ${secret}.`],
    ['sumo', 'Anything else before I deploy?'],
  ]);
  talk(s, 'other', [['sumo', `In another conversation: ${quote}.`]]);
  s.sql((db) => {
    db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, source_session, source_turn, source_quote, valid_from, created_at)
      VALUES ('fact', 'global', 'staging login: admin', 'stated', 'active', 0.5, 'scribe', 'sess-p', 1, ?, ?, ?)`).run(quote, `${DAY}T10:00:00.000Z`, `${DAY}T10:00:00.000Z`);
  });
  assert.match(s.sumo(['search', secret, '--turns']).out, /^r\d /m, 'before: the reply is found by the secret');

  const purged = s.sumo(['forget', 'm1', '--purge', '--yes']);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, with the sentence it came from and 2 replies of sumo's that said it back/);
  const left = s.sql((db) => db.prepare('SELECT session_id, text FROM replies ORDER BY id').all().map((r) => ({ ...r })));
  assert.deepEqual(left.map((r) => r.session_id), ['sess-p'], 'the reply that did not say it stays; the one that said it in another conversation went too');
  assert.equal(left[0].text, 'Anything else before I deploy?');
  assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM replies_fts WHERE replies_fts MATCH 'xylophonequark'`).get().n), 0, 'gone from the reply index');

  for (const file of ['memory.db', 'memory.db-wal']) {
    const path = join(s.home, file);
    if (existsSync(path)) for (const word of ['xylophonequark', secret]) assert.equal(readFileSync(path).includes(word), false, `${file} still holds a word of an erased reply`);
  }
});
