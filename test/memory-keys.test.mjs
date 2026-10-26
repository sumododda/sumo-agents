// A memory is found by what it is about, not only by its words: the writer may add search terms beside the user's
// sentence. They are searched, and never shown as the user's words.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { storedKeys } from '../src/memory.mjs';
import { opsSchema } from '../src/scribe.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-k', cwd: '/work/home' };
const SAID = 'always run eslint --fix before you commit';
const BODY = 'Always run eslint --fix before you commit';
const say = (s, prompt) => s.hook('prompt', { ...SESSION, prompt });
const stop = (s, reply) => s.hook('stop', { ...SESSION, last_assistant_message: reply, stop_hook_active: false });

/** The writer files the user's rule, with whatever search terms the model gave it. */
function filed(s, keys) {
  say(s, SAID);
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', topic: 'tooling', body: BODY, turn: 1, quote: SAID, keys }]);
  const run = s.sumo(['scribe', 'run']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /saved m\d+ /);
}

test('search terms are checked before they are stored: text, trimmed, lowercase, short, few, new to the body, no secrets', () => {
  assert.equal(
    storedKeys(['lint', ' Lint ', 'ESLint', 'commit', 'pre-commit', 'x'.repeat(33), 42, null, '--', 'sk-a1b2c3d4e5f6g7h8i9j0k1', 'code   style'], BODY),
    'lint, pre-commit, code style',
    'a repeat, a word the body has, one too long, not text, no word at all, a secret: each dropped, the rest kept',
  );
  assert.equal(storedKeys(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'], 'x'), 'a, b, c, d, e, f', 'six at most');
  assert.equal(storedKeys('lint, linter', BODY), 'lint, linter', 'one string of several is read as several');
  for (const none of [undefined, null, [], {}, 7, ['eslint', 'before']]) assert.equal(storedKeys(none, BODY), null, String(none));
});

test('a memory whose words never say "lint" is found by a search for it through its search terms — one without them is not', () => {
  const keyed = sandbox();
  filed(keyed, ['lint', 'pre-commit']);
  assert.equal(keyed.sql((db) => db.prepare('SELECT keys FROM memories WHERE id = 1').get().keys), 'lint, pre-commit');
  const found = keyed.sumo(['search', 'lint']);
  assert.equal(found.code, 0, found.err);
  assert.equal(found.out.trim(), `m1 [pref·global·stated] ${BODY}`, 'found, and shown by its body alone');

  const plain = sandbox();
  plain.sumo(['add', 'preference', BODY]);
  assert.equal(plain.sql((db) => db.prepare('SELECT keys FROM memories WHERE id = 1').get().keys), null, 'sumo add stores none');
  assert.match(plain.sumo(['search', 'lint']).out, /^nothing in memory for: lint/);
});

test('a question about linting is held back by the memory it is about, through its search terms', () => {
  const asked = 'Should I lint before pushing?';

  const keyed = sandbox();
  filed(keyed, ['lint', 'pre-commit']);
  const held = JSON.parse(stop(keyed, asked).out);
  assert.match(held.context, /memory already holds\nm1 \[pref·global·stated\] Always run eslint --fix before you commit\n/);

  // The same rule without them shares one word with the question, which is an accident, not an answer.
  const plain = sandbox();
  say(plain, SAID);
  plain.sumo(['add', 'preference', BODY]);
  assert.equal(stop(plain, asked).out, '');
});

test('search terms are never shown as the user\'s words: not in the startup block, nor in the body of sumo show', () => {
  const s = sandbox();
  filed(s, ['lint', 'pre-commit']);

  const block = s.sumo(['prime']).out;
  assert.match(block, /- m1 Always run eslint --fix before you commit/);
  assert.doesNotMatch(block, /\blint\b|pre-commit/);

  const shown = s.sumo(['show', 'm1']).out.trim().split('\n');
  assert.equal(shown.at(-1), BODY, 'the body is the user\'s sentence, as it was filed');
  assert.ok(shown.some((l) => /^keys: lint, pre-commit {3}\(/.test(l)), shown.join('\n'));
});

test('search terms a model gets wrong are dropped and the memory is kept', () => {
  for (const keys of ['eslint', 7, { lint: true }, [['lint']]]) {
    const s = sandbox();
    filed(s, keys);
    assert.equal(s.sql((db) => db.prepare('SELECT keys FROM memories WHERE id = 1').get().keys), null, JSON.stringify(keys));
  }
});

test('the writer and the slow pass are asked for search terms with every memory they file, and may give none', () => {
  const s = sandbox();
  s.sumo(['config']); // first touch creates the database
  const schema = s.sql((db) => opsSchema(db, ['add', 'supersede', 'gotcha', 'procedure']));
  const byOp = Object.fromEntries(schema.properties.ops.items.anyOf.map((branch) => [branch.properties.op.enum[0], branch]));
  for (const op of ['add', 'supersede', 'gotcha']) {
    assert.deepEqual({ ...byOp[op].properties.keys, description: undefined }, { type: 'array', items: { type: 'string' }, description: undefined }, op);
    assert.ok(byOp[op].required.includes('keys'), `${op}: an empty list is how none is given — no optional field for the grammar`);
  }
  assert.equal(byOp.procedure.properties.keys, undefined, 'a workflow is found by its title and cue');
});

test('a gotcha from the writer is found by its search terms too', () => {
  const s = sandbox();
  say(s, 'ok thanks');
  s.modelWillSay([{ op: 'gotcha', scope: 'global', body: 'The test runner hangs when a port is still bound', keys: ['flaky', 'timeout'] }]);
  assert.match(s.sumo(['scribe', 'run']).out, /saved m1 \[gotcha/);
  assert.match(s.sumo(['search', 'flaky']).out, /^m1 \[gotcha·global·observed\] The test runner hangs/);
});

test('a memory from before search terms upgrades in place: the index is made again with every memory already stored', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'keep commit subjects under fifty characters']);
  // Put the database back to the shape it had in the previous release.
  s.sql((db) => db.exec(`
    DROP TRIGGER memories_fts_insert; DROP TRIGGER memories_fts_delete; DROP TRIGGER memories_fts_update;
    DROP TABLE memories_fts;
    CREATE VIRTUAL TABLE memories_fts USING fts5(title, cue, body, topic, content='memories', content_rowid='id', tokenize='porter unicode61');
    INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');
    CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
      INSERT INTO memories_fts(rowid, title, cue, body, topic) VALUES (new.id, new.title, new.cue, new.body, new.topic);
    END;
    CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic) VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic);
    END;
    CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, cue, body, topic ON memories BEGIN
      INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic) VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic);
      INSERT INTO memories_fts(rowid, title, cue, body, topic) VALUES (new.id, new.title, new.cue, new.body, new.topic);
    END;
    ALTER TABLE memories DROP COLUMN keys;
    PRAGMA user_version = 7; -- the version before search terms
  `));

  assert.match(s.sumo(['search', 'commit subjects']).out, /^m1 .*keep commit subjects/, 'opening it migrates it; nothing is lost from the index');
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  filed(s, ['lint']);
  assert.match(s.sumo(['search', 'lint']).out, /^m2 .*eslint --fix/);
  s.sumo(['forget', 'm2', '--purge']);
  assert.match(s.sumo(['search', 'lint']).out, /^nothing in memory for: lint/, 'and a purge takes its search terms out of the index with it');
});
