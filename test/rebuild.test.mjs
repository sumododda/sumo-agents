// Derived memory is disposable: `sumo memory rebuild` reads the journal again with the extractor as it is now, shows
// the difference from what was derived before, and — unless asked only to show it — files what is missing and lets go
// what is no longer found. What the user said to remember, confirmed or pinned is never part of it.
import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { extractorVersion, filingState } from '../src/ledger.mjs';
import { dryExtract } from '../src/rebuild.mjs';
import { withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const rows = (s, sql) => s.sql((db) => db.prepare(sql).all().map((r) => ({ ...r })));
const add = (turn, body, quote) => ({ op: 'add', type: 'preference', scope: 'global', topic: 'x', body, turn, quote, keys: [] });
const SQUASH = add(1, 'Always squash merge on github', 'always squash merge on github');
const MAIN = add(2, 'Deploy from the main branch', 'we deploy from the main branch');
const SHORT = add(3, 'I prefer short answers', 'I prefer short answers');

/** One finished conversation of three statements, of which an earlier extractor filed the first two. */
function filedBefore(s) {
  for (const prompt of ['from now on always squash merge on github', 'we deploy from the main branch', 'I prefer short answers, everywhere']) s.hook('prompt', { session_id: 'a', prompt });
  s.hook('session-end', { session_id: 'a', reason: 'other' });
  s.modelWillSay([SQUASH, MAIN]);
  assert.match(s.sumo(['memory', 'run', '--auto']).out, /saved m1 [\s\S]*saved m2 /);
  // As if derived by an extractor that has since changed.
  s.sql((db) => db.prepare(`UPDATE memories SET derived_by = 'old00000'`).run());
  // What the extractor as it is now finds there: the second still, the third as well, and no longer the first.
  s.modelWillSay([MAIN, SHORT]);
}
const counts = (s) => s.sql((db) => ({
  memories: db.prepare('SELECT COUNT(*) AS n FROM memories').get().n,
  active: db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'active'`).get().n,
  extractions: db.prepare('SELECT COUNT(*) AS n FROM extractions').get().n,
  events: db.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n,
  runs: db.prepare('SELECT COUNT(*) AS n FROM model_runs').get().n,
}));

test('rebuild --dry-run reads the journal again and shows what it would add and which derived memories it would no longer file, changing nothing', () => {
  const s = sandbox();
  filedBefore(s);
  const before = counts(s);
  const run = s.sumo(['memory', 'rebuild', '--dry-run']);
  assert.equal(run.code, 0, run.err);
  const version = s.sql((db) => extractorVersion(db));
  assert.match(run.out, new RegExp(`^read 1 conversation, 3 turns, with extractor ${version} `));
  assert.match(run.out, /^would add: 1\n {2}\+ \[preference·global\] I prefer short answers, everywhere — t3 "I prefer short answers"$/m);
  assert.match(run.out, /^derived, no longer supported: 1\n {2}- m1 \[pref·global·stated\] from now on always squash merge on github — derived by old00000 from t1$/m);
  assert.doesNotMatch(run.out, /m2 /, 'what it still finds is neither');
  assert.match(run.out, /^nothing was changed \(--dry-run\)$/m);
  assert.deepEqual(counts(s), before, 'not a memory, not a ledger row, not a line of history, not a model run');
  // The model was shown the conversation and no memory: what it files is the conversation's alone.
  assert.doesNotMatch(s.modelWasShown().prompt, /Existing|m1 \[pref/);
});

test('rebuild applies the difference: what is missing is filed as derived by this extractor, what is no longer found is let go with its history kept, and each change is in the memory\'s history as rebuilt', () => {
  const s = sandbox();
  filedBefore(s);
  const run = s.sumo(['memory', 'rebuild']);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /saved m3 \[pref·global·stated\] I prefer short answers, everywhere$/m);
  assert.match(run.out, /let go m1 \(sumo history 1 still shows it\)/);
  assert.match(run.out, /^rebuilt: 1 statement filed, 1 memory let go$/m);

  const version = s.sql((db) => extractorVersion(db));
  assert.deepEqual(rows(s, 'SELECT id, state, derived_by FROM memories ORDER BY id'), [
    { id: 1, state: 'invalid', derived_by: 'old00000' },
    { id: 2, state: 'active', derived_by: 'old00000' },
    { id: 3, state: 'active', derived_by: version },
  ]);
  const run2 = rows(s, `SELECT id FROM extractions WHERE status = 'ok' ORDER BY id DESC LIMIT 1`)[0].id;
  assert.deepEqual(rows(s, `SELECT memory_id, op, actor, run_id FROM memory_events WHERE reason = 'rebuilt' ORDER BY memory_id`), [
    { memory_id: 1, op: 'forgotten', actor: 'sumo', run_id: run2 },
    { memory_id: 3, op: 'rebuilt', actor: 'sumo', run_id: run2 },
  ]);
  assert.match(s.sumo(['history', 'm1']).out, /from now on always squash merge on github/, 'let go, not erased');
  // A memory a rebuild let go is not the user throwing it out.
  assert.equal(s.sql((db) => filingState(db).junkRate), null);
  // Rebuilt, memory matches the extractor: again changes nothing, and the pass has nothing left to read.
  assert.match(s.sumo(['memory', 'rebuild']).out, /^would add: 0\nderived, no longer supported: 0$/m);
  assert.match(s.sumo(['memory', 'run', '--auto']).out, /^nothing to do/);
});

test('rebuild never touches a primary memory, one the user pinned or one they confirmed — only what an extractor derived', () => {
  const s = sandbox();
  filedBefore(s);
  s.sql((db) => {
    // Said to be remembered from the same turn (the chat model saving on the spot): primary, though it cites the turn.
    db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, source_turn, valid_from, created_at)
      VALUES ('preference', 'global', 'squash merges only', 'stated', 'active', 0.5, 'chat-model', 1, ?, ?)`).run(new Date().toISOString(), new Date().toISOString());
    db.prepare('UPDATE memories SET pinned = 1 WHERE id = 1').run();
  });
  s.modelWillSay([SHORT]);
  const dry = s.sumo(['memory', 'rebuild', '--dry-run']).out;
  assert.match(dry, /^derived, no longer supported: 1\n {2}- m2 /m, 'the unpinned derived one only');
  assert.doesNotMatch(dry, /- m1 |- m3 /);

  // Once confirmed by the user a derived memory is theirs.
  s.sql((db) => db.prepare(`INSERT INTO memory_events (ts, memory_id, op, actor) VALUES (?, 2, 'confirmed', 'user')`).run(new Date().toISOString()));
  const run = s.sumo(['memory', 'rebuild']);
  assert.match(run.out, /^derived, no longer supported: 0$/m);
  assert.deepEqual(rows(s, `SELECT id FROM memories WHERE state = 'active' ORDER BY id`).map((r) => r.id), [1, 2, 3, 4]);
});

test('a rebuild that would let go more than a pass may retire is refused whole, unless --yes', () => {
  const s = sandbox();
  const said = ['always squash merge on github', 'we deploy from the main branch', 'I prefer short answers', 'never force-push on the slate repository'];
  for (const prompt of said) s.hook('prompt', { session_id: 'a', prompt });
  s.hook('session-end', { session_id: 'a', reason: 'other' });
  s.modelWillSay(said.map((text, i) => add(i + 1, text, text)));
  s.sumo(['memory', 'run', '--auto']);
  assert.equal(rows(s, `SELECT id FROM memories WHERE state = 'active'`).length, 4);

  // The extractor now finds nothing in that conversation: four of four would go.
  s.modelWillSay([]);
  const refused = s.sumo(['memory', 'rebuild']);
  assert.equal(refused.code, 1);
  assert.match(refused.out, /^refused — this rebuild would retire 4 of the 4 memories in global, more than a quarter: a rewrite that wide is not taken from a model\nnothing was changed: sumo memory rebuild --yes makes the change anyway$/m);
  assert.equal(rows(s, `SELECT id FROM memories WHERE state = 'active'`).length, 4);
  assert.equal(rows(s, `SELECT id FROM memory_events WHERE reason = 'rebuilt'`).length, 0);
  assert.equal(rows(s, 'SELECT id FROM extractions').length, 1, 'not even the ledger');

  const forced = s.sumo(['memory', 'rebuild', '--yes']);
  assert.equal(forced.code, 0, forced.out + forced.err);
  assert.match(forced.out, /^rebuilt: 0 statements filed, 4 memories let go$/m);
  assert.equal(rows(s, `SELECT id FROM memories WHERE state = 'invalid'`).length, 4);
});

test('rebuild reads only the conversations asked for: the newest N, or those since a day', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'old', prompt: 'always squash merge on github' });
  s.hook('session-end', { session_id: 'old' });
  s.hook('prompt', { session_id: 'new', prompt: 'we deploy from the main branch' });
  s.hook('session-end', { session_id: 'new' });
  s.sql((db) => {
    db.prepare(`UPDATE sessions SET started_at = '2026-09-01T00:00:00.000Z', last_turn_at = '2026-09-01T00:00:00.000Z' WHERE id = 'old'`).run();
    db.prepare(`UPDATE user_turns SET ts = '2026-09-01T00:00:00.000Z' WHERE session_id = 'old'`).run();
  });
  s.modelWillSay([]);
  assert.match(s.sumo(['memory', 'rebuild', '--dry-run']).out, /^read 2 conversations, 2 turns/);
  assert.match(s.sumo(['memory', 'rebuild', '--dry-run', '--limit', '1']).out, /^read 1 conversation, 1 turn,/);
  assert.match(s.modelWasShown().prompt, /we deploy from the main branch/, 'the newest');
  assert.match(s.sumo(['memory', 'rebuild', '--dry-run', '--since', '7d']).out, /^read 1 conversation, 1 turn,/);
  const typo = s.sumo(['memory', 'rebuild', '--since', 'yesterday']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /--since takes a day/);
});

test('dryExtract says what the extractor would file from the turns asked about — also what memory holds already, and what the user let go — and writes nothing', async () => {
  const s = sandbox();
  filedBefore(s);
  s.sumo(['forget', 'm1']);
  s.modelWillSay([SQUASH, MAIN, SHORT, add(3, 'The user owns a boat', 'a boat nobody mentioned')]);
  const before = counts(s);
  const env = { SUMO_AGENTS_MODEL_CMD: new URL('./fixtures/model-stub.mjs', import.meta.url).pathname, STUB_ANSWER: `${s.root}/model-answer.json` };
  const out = await withHome(s.home, env, async () => {
    const db = openDb();
    try {
      return await dryExtract(db, { turnIds: [1, 2, 3], now: new Date().toISOString() });
    } finally {
      db.close();
    }
  });
  assert.equal(out.ok, true, out.error);
  assert.deepEqual(out.wouldFile.map((f) => ({ turnId: f.turnId, type: f.type, scope: f.scope, body: f.body, quote: f.quote, existing: f.existing })), [
    { turnId: 1, type: 'preference', scope: 'global', body: 'from now on always squash merge on github', quote: SQUASH.quote, existing: 1 },
    { turnId: 2, type: 'preference', scope: 'global', body: 'we deploy from the main branch', quote: MAIN.quote, existing: 2 },
    { turnId: 3, type: 'preference', scope: 'global', body: 'I prefer short answers, everywhere', quote: SHORT.quote, existing: null },
  ]);
  assert.equal(out.dropped.filter((reason) => /not the user's words/.test(reason)).length, 1);
  assert.deepEqual(counts(s), before);
});

test('rebuild never lets go a derived memory that replaced another: it carries a change the user stated, and the one it replaced would not come back', () => {
  const s = sandbox();
  assert.match(s.sumo(['add', 'preference', 'slate uses pnpm for installs']).out, /m1 /);
  // Filed by an earlier pass, and the pair judge calls the new statement its replacement: a pass replaces only such a memory.
  s.sql((db) => db.prepare(`UPDATE memories SET derived_by = 'old00000'`).run());
  writeFileSync(join(s.root, 'model-answer.json.dream-pairs'), JSON.stringify({ is_error: false, structured_output: { pairs: [{ pair: 1, label: 'replaces' }] }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  s.hook('prompt', { session_id: 'a', prompt: 'slate uses bun for installs now, we moved off pnpm' });
  s.hook('session-end', { session_id: 'a', reason: 'other' });
  s.modelWillSay([{ op: 'supersede', old: 1, type: 'preference', scope: 'global', topic: 'tooling', body: 'slate uses bun for installs', turn: 1, quote: 'slate uses bun for installs now', keys: [] }]);
  assert.match(s.sumo(['memory', 'run', '--auto']).out, /saved m2 /);
  assert.deepEqual(rows(s, 'SELECT id, state, superseded_by FROM memories ORDER BY id'), [{ id: 1, state: 'superseded', superseded_by: 2 }, { id: 2, state: 'active', superseded_by: null }]);

  // Today the extractor finds nothing in that turn.
  s.modelWillSay([]);
  const dry = s.sumo(['memory', 'rebuild', '--dry-run']).out;
  assert.match(dry, /^derived, no longer supported: 0$/m);
  assert.match(dry, /^ {2}kept: replaces m1 — m2 \[pref·global·stated\] slate uses bun for installs now, we moved off pnpm$/m);
  const run = s.sumo(['memory', 'rebuild']);
  assert.equal(run.code, 0, run.out + run.err);
  assert.match(run.out, /^ {2}kept: replaces m1 — m2 /m);
  assert.match(run.out, /^rebuilt: 0 statements filed, 0 memories let go$/m);
  assert.deepEqual(rows(s, 'SELECT id, state FROM memories ORDER BY id'), [{ id: 1, state: 'superseded' }, { id: 2, state: 'active' }], 'the user is left with what they last said');
  assert.match(s.sumo(['search', 'slate installs']).out, /m2 .*slate uses bun for installs now/);
});

test("from the model's shell a rebuild only shows its difference: letting memories go, --yes or not, is the user's to run — and so are check --fix and the eval", () => {
  const s = sandbox();
  const said = ['always squash merge on github', 'we deploy from the main branch', 'I prefer short answers', 'never force-push on the slate repository'];
  for (const prompt of said) s.hook('prompt', { session_id: 'a', prompt });
  s.hook('session-end', { session_id: 'a', reason: 'other' });
  s.modelWillSay(said.map((text, i) => add(i + 1, text, text)));
  s.sumo(['memory', 'run', '--auto']);
  s.modelWillSay([]);
  const before = counts(s);

  for (const env of [{ SUMO_TOOL: '1' }, { SUMO_TOOL: '1', SUMO_JOB: '3' }]) {
    for (const args of [['memory', 'rebuild'], ['memory', 'rebuild', '--yes'], ['memory', 'rebuild', '--yes', '--limit', '1']]) {
      const run = s.sumo(args, { extraEnv: env });
      assert.equal(run.code, 1, args.join(' '));
      assert.match(run.err, /^sumo: rebuilding memory is the user's to do: they run sumo memory rebuild themselves\. sumo memory rebuild --dry-run shows what it would change/);
      assert.equal(run.out, '');
    }
    for (const [args, said] of [[['memory', 'check', '--fix'], /^sumo: mending memory is the user's to do: they run sumo memory check --fix themselves\. sumo memory check says what is wrong/], [['memory', 'eval'], /^sumo: measuring the extractor asks the model about every case, and is the user's to do: they run sumo memory eval themselves/]]) {
      const run = s.sumo(args, { extraEnv: env });
      assert.equal(run.code, 1, args.join(' '));
      assert.match(run.err, said);
    }
  }
  assert.deepEqual(counts(s), before, 'nothing was read, filed or let go');
  assert.equal(rows(s, `SELECT id FROM memories WHERE state = 'active'`).length, 4);

  // What only shows is theirs to run.
  const dry = s.sumo(['memory', 'rebuild', '--dry-run'], { extraEnv: { SUMO_TOOL: '1' } });
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /^derived, no longer supported: 4$/m);
  assert.equal(s.sumo(['memory', 'check'], { extraEnv: { SUMO_TOOL: '1' } }).err, '');
  assert.match(s.sumo(['help', 'hooks'], { extraEnv: { SUMO_TOOL: '1' } }).out, /hook session-start/);
  assert.equal(rows(s, `SELECT id FROM memories WHERE state = 'active'`).length, 4);
});
