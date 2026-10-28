// The tidy the consolidation pass does to memory itself: what it is shown, the pairs it has judged, the search terms it
// fills in, and when it is owed. Every model is a stand-in; nothing here is decided by one.
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const DAY = 86_400_000;

/** A memory stored as a row, quicker than through the command: `n` of them in one go, ids in the order given. */
function seed(s, memories) {
  s.sumo(['config']);
  s.sql((db) => {
    const put = db.prepare(`INSERT INTO memories (type, scope, body, topic, keys, provenance, state, importance, written_by, valid_from, created_at)
      VALUES (?, ?, ?, ?, ?, 'stated', 'active', 0.5, 'user', ?, ?)`);
    for (const m of memories) put.run(m.type ?? 'preference', m.scope ?? 'global', m.body, m.topic ?? null, m.keys ?? null, m.at ?? '2026-09-01T00:00:00.000Z', m.at ?? '2026-09-01T00:00:00.000Z');
  });
}

/** A finished conversation whose turns the writer has already filed. */
function finishedSession(s, id, prompts) {
  for (const prompt of prompts) s.hook('prompt', { session_id: id, prompt });
  s.hook('session-end', { session_id: id, reason: 'other' });
  // Marked filed by hand: a memory pass run here would tidy by itself once the third is over.
  s.sql((db) => db.prepare('UPDATE user_turns SET scribed = 1 WHERE session_id = ?').run(id));
}

/** What the local model answers one kind of tidy call; the other calls get the usual answer. */
const willAnswer = (s, kind, output) => writeFileSync(join(s.root, `model-answer.json.${kind}`), JSON.stringify({ is_error: false, structured_output: output, usage: { input_tokens: 900, output_tokens: 40 }, total_cost_usd: 0 }));

/** Every request the stand-in was sent, in order. */
const asked = (s) => {
  const file = join(s.root, 'model-saw.json.all');
  return existsSync(file) ? readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
};

/** Marks memory tidied at `at`, so a pass owes none. */
const tidiedAt = (s, at) => s.sql((db) => db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('dream.last_tidy', ?)`).run(at));

test('past sixty memories a pass still reads the oldest: a slice of them that moves on each pass, beside the newest', () => {
  const s = sandbox();
  seed(s, [
    { body: 'deploys run from the mac mini in the office' },
    { body: 'deploys run from the linux box in the rack' },
    ...Array.from({ length: 68 }, (_, i) => ({ body: `rule number ${i + 3} about subject ${i + 3}` })),
  ]);
  tidiedAt(s, new Date().toISOString());
  finishedSession(s, 'one', ['thanks, that is all']);
  finishedSession(s, 'two', ['nothing else today']);

  s.modelWillSay([]);
  assert.equal(s.sumo(['memory', 'run', '--tidy']).code, 0);
  const first = s.modelWasShown().prompt;
  assert.match(first, /^m1 \[.*mac mini/m, 'the oldest clash is read');
  assert.match(first, /^m2 \[.*linux box/m);
  assert.match(first, /^m70 \[/m, 'and the newest');
  const shown = (prompt) => [...prompt.matchAll(/^m(\d+) \[/gm)].map((m) => Number(m[1]));
  assert.ok(shown(first).length <= 60, `${shown(first).length} memories shown`);
  assert.equal(shown(first).includes(25), false, 'past the slice and before the newest: not this time');

  finishedSession(s, 'three', ['see you tomorrow']);
  s.modelWillSay([]);
  assert.equal(s.sumo(['memory', 'run', '--tidy']).code, 0);
  const second = shown(s.modelWasShown().prompt);
  assert.ok(second.includes(25), 'the slice moved on');
  assert.equal(second.includes(1), false, 'and the start waits for its turn again');
});

test('code picks the pairs, the local model judges them, and the user settles them: nothing is superseded or forgotten by the pass', () => {
  const s = sandbox();
  seed(s, [
    { body: 'deploys run nightly from the mac mini in the office', at: '2026-09-21T00:00:00.000Z' },
    { body: 'deploys run nightly from the linux box in the office', at: '2026-10-04T00:00:00.000Z' },
    { body: 'always squash merge pull requests on github', topic: 'git' },
    { body: 'squash merge every pull request on github', topic: 'git' },
    { body: 'use pnpm to install packages in slate', scope: 'global', keys: 'package manager' },
    // Two words in common and a search term make a pair; one word and a search term would not.
    { body: 'run the slate installs with vitest', keys: 'package manager' },
    { body: 'the coffee machine is on the second floor' },
  ]);
  willAnswer(s, 'dream-keys', { memories: [] });
  willAnswer(s, 'dream-pairs', { pairs: [{ pair: 1, label: 'same' }, { pair: 2, label: 'conflict' }, { pair: 3, label: 'unrelated' }, { pair: 9, label: 'same' }, { pair: 2, label: 'maybe' }] });

  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^tidy: read 0 sessions/, 'a tidy with no conversation waiting');
  const pairsCall = asked(s).find((r) => r.kind === 'dream-pairs');
  assert.match(pairsCall.prompt, /^Pairs to judge — /);
  assert.match(pairsCall.system, /"Pairs to judge": for each \[pN\]/, 'the pass\'s own instructions');
  assert.deepEqual(pairsCall.schema.properties.pairs.items.properties.label.enum, ['same', 'replaces', 'conflict', 'unrelated']);
  assert.doesNotMatch(pairsCall.prompt, /coffee machine/, 'a memory like no other is never put to the model');
  // The likeliest first: the squash rule shares the most words and a topic; then the deploy clash; then a search term.
  assert.match(pairsCall.prompt, /\[p1\]\n {2}A: m3 \(preference, global, 2026-09-01\): always squash merge pull requests on github\n {2}B: m4 /);
  assert.match(pairsCall.prompt, /\[p2\]\n {2}A: m1 \(preference, global, 2026-09-21\): deploys run nightly from the mac mini in the office\n {2}B: m2 /);
  assert.match(pairsCall.prompt, /\[p3\]\n {2}A: m5 [^\n]*\n {2}B: m6 /);

  assert.match(run.out, /raised for the user: m1 and m2 cannot both be true/);
  assert.match(run.out, /raised for the user: m3 and m4 say the same thing/);
  assert.match(run.out, /dropped — pair 9: not one of the pairs asked/);
  const block = s.sumo(['prime']).out;
  assert.match(block, /m1 and m2 disagree — they cannot both be true/);
  assert.match(block, /m3 and m4 look alike — they say the same thing/);
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'active'`).get().n), 7, 'every memory still stands');

  // Asked once: the pairs answered — raised or unrelated — are never put to the model again.
  const judged = s.sql((db) => db.prepare('SELECT a, b, label FROM memory_pairs ORDER BY a, b').all().map((r) => `${r.a}:${r.b}:${r.label}`));
  assert.deepEqual(judged, ['1:2:conflict', '3:4:same', '5:6:unrelated']);
  const before = asked(s).filter((r) => r.kind === 'dream-pairs').length;
  tidiedAt(s, new Date(Date.now() - 8 * DAY).toISOString());
  willAnswer(s, 'dream-pairs', { pairs: [] });
  s.sumo(['memory', 'run', '--tidy']);
  assert.equal(asked(s).filter((r) => r.kind === 'dream-pairs').length, before, 'every likely pair is judged: no call is made');
});

test('a newer memory that may replace an older one is said with which is newer', () => {
  const s = sandbox();
  seed(s, [
    { body: 'the slate project uses pnpm for every install', at: '2026-09-01T00:00:00.000Z' },
    { body: 'the slate project uses bun for every install', at: '2026-10-10T00:00:00.000Z' },
  ]);
  willAnswer(s, 'dream-keys', { memories: [] });
  willAnswer(s, 'dream-pairs', { pairs: [{ pair: 1, label: 'replaces' }] });
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /raised for the user: m1 and m2 may be replaced by m2/);
  assert.match(s.sumo(['prime']).out, /m1 and m2 look alike — m2 is newer and may replace m1 — if it does, supersede m1 with it/);
});

test('search terms and a topic are filled in for memories that have none, each checked; a bad one is dropped, never stored', () => {
  const s = sandbox();
  seed(s, [
    { body: 'always run eslint --fix before you commit' },
    { body: 'deploy the docs site from the main branch', topic: 'deploy' },
    { body: 'review every pull request before merging', keys: 'code review' },
  ]);
  willAnswer(s, 'dream-pairs', { pairs: [] });
  willAnswer(s, 'dream-keys', {
    memories: [
      { id: 1, topic: 'tooling', keys: ['lint', 'linter', 'eslint', 'sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'] },
      { id: 2, topic: 'Not A Word!', keys: ['documentation', 'publish'] },
      { id: 3, topic: 'git', keys: ['ignored, it has keys'] },
      { id: 42, topic: 'git', keys: ['nothing asked this'] },
    ],
  });

  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  const keysCall = asked(s).find((r) => r.kind === 'dream-keys');
  assert.match(keysCall.prompt, /^Search terms — a topic and keys for each memory:\n\[m1\] always run eslint --fix before you commit\n\[m2\] deploy the docs site/);
  assert.match(run.out, /search terms for 3 memories: m1, m2, m3/);
  assert.match(run.out, /dropped — search terms for m42: not one of the memories asked/);

  const rows = s.sql((db) => db.prepare('SELECT id, topic, keys FROM memories ORDER BY id').all().map((r) => ({ ...r })));
  assert.deepEqual(rows[0], { id: 1, topic: 'tooling', keys: 'lint, linter' }, 'a word the memory already has, and a secret, are dropped');
  assert.deepEqual(rows[1], { id: 2, topic: 'deploy', keys: 'documentation, publish' }, 'a topic it had is kept; a bad one is never stored');
  assert.deepEqual(rows[2], { id: 3, topic: 'git', keys: 'code review' }, 'keys it had are never replaced');
  // What they are for: a search in other words finds the memory.
  assert.match(s.sumo(['search', 'linter']).out, /m1 .*eslint/);
});

test('the tidy is owed weekly, or when three conversations wait; with nothing owed a pass has nothing to do', async () => {
  const s = sandbox();
  const { tidyDue } = await import('../src/dream.mjs');
  const { openDb } = await import('../src/db.mjs');
  const due = (now = new Date().toISOString()) => {
    process.env.SUMO_AGENTS_HOME = s.home;
    const db = openDb(join(s.home, 'memory.db'));
    try {
      return tidyDue(db, now);
    } finally {
      db.close();
    }
  };
  const home = process.env.SUMO_AGENTS_HOME;
  try {
    s.sumo(['config']);
    assert.equal(due(), false, 'no memory, no conversation: nothing to tidy');
    seed(s, [{ body: 'keep pull request descriptions short' }]);
    assert.equal(due(), true, 'never tidied');
    assert.match(s.sumo(['memory', 'status']).out, /^last tidy {2}never · weekly sweep: never — owed: the next pass sweeps$/m);

    willAnswer(s, 'dream-keys', { memories: [] });
    willAnswer(s, 'dream-pairs', { pairs: [] });
    s.sumo(['memory', 'run', '--tidy']);
    assert.equal(due(), false, 'just tidied');
    assert.match(s.sumo(['memory', 'status']).out, /^last tidy {2}\d{4}-\d{2}-\d{2} · weekly sweep: \d{4}-\d{2}-\d{2}$/m);
    assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^tidy: nothing to do — no finished sessions are waiting/);
    assert.equal(due(new Date(Date.now() + 8 * DAY).toISOString()), true, 'a week on');

    for (const id of ['one', 'two', 'three']) finishedSession(s, id, [`a message in ${id}`]);
    assert.equal(due(), true, 'three conversations waiting');
  } finally {
    if (home === undefined) delete process.env.SUMO_AGENTS_HOME;
    else process.env.SUMO_AGENTS_HOME = home;
  }
});

test('the tidy calls the local model only, and one that could not answer leaves it owed', () => {
  const s = sandbox();
  seed(s, [
    { body: 'deploys run from the mac mini in the office' },
    { body: 'deploys run from the linux box in the office' },
  ]);
  // On a paid model the tidy is not run at all.
  s.sql((db) => db.prepare(`INSERT INTO meta (key, value) VALUES ('config.memory.model', 'haiku')`).run());
  assert.match(s.sumo(['memory', 'run', '--tidy']).out, /^tidy: nothing to do — no finished sessions are waiting, and memory has nothing to tidy/);
  assert.deepEqual(asked(s).filter((r) => String(r.kind).startsWith('dream-')), []);

  s.sql((db) => db.prepare(`DELETE FROM meta WHERE key IN ('config.memory.model', 'dream.last_tidy')`).run());
  const failing = s.sumo(['memory', 'run', '--tidy'], { extraEnv: { STUB_LOCAL_FAILS: '1' } });
  assert.match(failing.out, /^tidy: failed — /);
  assert.equal(s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'dream.last_tidy'`).get()), undefined, 'still owed');
  assert.match(s.sumo(['memory', 'status']).out, /owed/);
});

test('pairs are picked from a bounded index, never every pair: two thousand memories in a moment, and a shared topic alone makes no pair', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { openDb } = await import('../src/db.mjs');
  const { candidatePairs } = await import('../src/dream.mjs');
  const fill = (db, rows) => {
    const put = db.prepare(`INSERT INTO memories (type, scope, body, topic, keys, provenance, state, importance, written_by, valid_from, created_at)
      VALUES ('preference', ?, ?, ?, NULL, 'stated', 'active', 0.5, 'user', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')`);
    for (const r of rows) put.run(r.scope ?? 'global', r.body, r.topic ?? null);
  };
  const vocabulary = Array.from({ length: 400 }, (_, i) => `word${i.toString(36)}x`);
  const big = openDb(join(mkdtempSync(join(tmpdir(), 'sumo-agents-pairs-')), 'memory.db'));
  try {
    // Two thousand memories of six words each from a vocabulary of four hundred, across five scopes: plenty of overlap.
    fill(big, Array.from({ length: 2000 }, (_, i) => ({
      scope: i % 5 === 0 ? 'global' : `project:p${i % 5}`,
      body: Array.from({ length: 6 }, (_, k) => vocabulary[(i * 7 + k * 13 + (i % 11) * k) % vocabulary.length]).join(' '),
      topic: ['git', 'testing', 'style'][i % 3],
    })));
    // The best of three: what the code costs, not what a machine busy with the rest of the suite costs. Every-pair work
    // would take seconds, far past the budget, whatever the load.
    let took = Infinity;
    let pairs = [];
    for (let run = 0; run < 3; run++) {
      const began = performance.now();
      pairs = candidatePairs(big, 10);
      took = Math.min(took, performance.now() - began);
    }
    assert.ok(took < 300, `picking pairs among 2,000 took ${Math.round(took)} ms`);
    assert.ok(pairs.length > 0 && pairs.length <= 10);
    for (const { a, b } of pairs) assert.ok(a.scope === b.scope || a.scope === 'global' || b.scope === 'global', 'never across two projects');
  } finally {
    big.close();
  }

  const topical = openDb(join(mkdtempSync(join(tmpdir(), 'sumo-agents-pairs-')), 'memory.db'));
  try {
    // Thirty memories about git that share no words: the topic alone is no reason to ask the model about any of them.
    fill(topical, Array.from({ length: 30 }, (_, i) => ({ body: `${vocabulary[i * 3]} ${vocabulary[i * 3 + 1]} ${vocabulary[i * 3 + 2]}`, topic: 'git' })));
    assert.deepEqual(candidatePairs(topical, 10), []);
    // Two shared words beside the topic make one.
    fill(topical, [{ body: 'rebase feature branches before merging', topic: 'git' }, { body: 'rebase feature branches nightly', topic: 'git' }]);
    assert.deepEqual(candidatePairs(topical, 10).map(({ a, b }) => [a.id, b.id]), [[31, 32]]);
  } finally {
    topical.close();
  }
});

test('the tidy does not file again what the writer already filed from the same sentence', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'one', prompt: 'I prefer short answers, everywhere' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', topic: 'style', body: 'I prefer short answers', turn: 1, quote: 'I prefer short answers' }]);
  assert.match(s.sumo(['memory', 'run']).out, /saved m\d+ \[pref·global·stated\] I prefer short answers/);
  const filed = s.sql((db) => db.prepare(`SELECT id FROM memories WHERE body = 'I prefer short answers'`).get().id);
  s.hook('session-end', { session_id: 'one', reason: 'other' });

  willAnswer(s, 'dream-keys', { memories: [] });
  willAnswer(s, 'dream-pairs', { pairs: [] });
  s.modelWillSay([
    { op: 'add', type: 'preference', scope: 'global', topic: 'style', body: 'I prefer short answers, everywhere', turn: 1, quote: 'I prefer short answers, everywhere' },
    // Another rule from the same sentence is a rule of its own.
    { op: 'add', type: 'preference', scope: 'global', topic: 'style', body: 'Answers should avoid emojis', turn: 1, quote: null },
  ]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, new RegExp(`dropped — add: already filed from that sentence: m${filed}`));
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT body FROM memories WHERE body LIKE '%short answers%'`).all().map((r) => r.body)), ['I prefer short answers']);
});

test('two memories that say one thing in other words are raised by the pass that reads them once the pair, judged alone, says so: a pair named by a wrong number is not put to the user, and nothing is retired', () => {
  const s = sandbox();
  seed(s, [
    { body: 'I prefer short answers' },
    { body: 'keep your replies brief' },
    { body: 'the coffee machine is on the second floor', state: 'active' },
    { body: 'never force-push on slate' },
    { type: 'decision', body: 'slate uses bun, not pnpm' },
  ]);
  s.sql((db) => db.prepare(`UPDATE memories SET state = 'superseded' WHERE id = 3`).run());
  finishedSession(s, 'one', ["don't ever force-push on slate"]);
  willAnswer(s, 'dream-keys', { memories: [] });
  // Asked about each pair alone, the model holds the first and calls the second unrelated.
  willAnswer(s, 'dream-pairs', { pairs: [{ pair: 1, label: 'same' }, { pair: 2, label: 'unrelated' }] });
  willAnswer(s, 'dream-repeats', { repeats: [] });
  s.modelWillSay([
    { op: 'same', ids: [1, 2], note: 'both ask for brevity' },
    // The number of the turn the rule was said in, read as a memory's: what a small model reading a list does.
    { op: 'same', ids: [4, 5], note: 't5 repeats the rule against force-push on slate' },
    { op: 'same', ids: [1, 99], note: 'not a memory' },
    { op: 'same', ids: [2, 3], note: 'one of them is gone' },
  ]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /to be judged on their own: m1 and m2 say the same thing — both ask for brevity/);
  assert.match(run.out, /raised for the user: m1 and m2 say the same thing — both ask for brevity/);
  assert.match(run.out, /dropped — m4 and m5, named as saying the same thing: judged on their own, they are unrelated/);
  assert.match(run.out, /dropped — same: m99 is not one of the memories this pass was shown/);
  assert.match(run.out, /dropped — same: m3 is not one of the memories this pass was shown/);
  const judge = asked(s).filter((r) => r.kind === 'dream-pairs').at(-1);
  assert.match(judge.prompt, /\[p1\]\n {2}A: m1 [^\n]*short answers\n {2}B: m2 [^\n]*brief\n\[p2\]\n {2}A: m4 [^\n]*force-push[^\n]*\n {2}B: m5 [^\n]*bun[^\n]*$/, 'each pair named is put to the model alone');
  assert.match(s.sumo(['prime']).out, /m1 and m2 look alike — both ask for brevity/);
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT memory_a, memory_b FROM notices`).all().map((n) => [n.memory_a, n.memory_b])), [[1, 2]], 'only the pair that held');
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT id FROM memories WHERE state = 'active' ORDER BY id`).all().map((r) => r.id)), [1, 2, 4, 5]);

  // Asked once: the pair judged unrelated is not named again, nor put to the model.
  finishedSession(s, 'two', ['thanks again']);
  s.modelWillSay([{ op: 'same', ids: [4, 5], note: 'the same rule' }]);
  const again = s.sumo(['memory', 'run', '--tidy']);
  assert.match(again.out, /dropped — same: m4 and m5 were judged on their own already: unrelated/);
  assert.equal(asked(s).filter((r) => r.kind === 'dream-pairs').length, 1, 'no second call');
});

test('a pair named while the local model cannot judge it waits, and the next tidy judges it first', () => {
  const s = sandbox();
  seed(s, [{ body: 'I prefer short answers' }, { body: 'keep your replies brief' }]);
  finishedSession(s, 'one', ['thanks, that is all']);
  willAnswer(s, 'dream-repeats', { repeats: [] });
  writeFileSync(join(s.root, 'model-answer.json.dream-pairs'), JSON.stringify({ is_error: true, result: 'server busy', usage: {}, total_cost_usd: 0 }));
  s.modelWillSay([{ op: 'same', ids: [1, 2], note: 'both ask for brevity' }]);
  const first = s.sumo(['memory', 'run', '--tidy']);
  assert.match(first.out, /dropped — the pairs named wait to be judged: model call failed: server busy/);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM notices').get().n), 0, 'nothing raised unjudged');

  finishedSession(s, 'two', ['see you tomorrow']);
  willAnswer(s, 'dream-pairs', { pairs: [{ pair: 1, label: 'same' }] });
  s.modelWillSay([]);
  const next = s.sumo(['memory', 'run', '--tidy']);
  assert.match(next.out, /raised for the user: m1 and m2 say the same thing — both ask for brevity/);
  assert.match(asked(s).filter((r) => r.kind === 'dream-pairs').at(-1).prompt, /\[p1\]\n {2}A: m1 [^\n]*\n {2}B: m2 [^\n]*$/);
});

test('read by a paid model, the conversations\' pairs are raised as named: the pair judge is the local model\'s alone, and no local call is made', () => {
  const s = sandbox();
  seed(s, [{ body: 'I prefer short answers' }, { body: 'keep your replies brief' }]);
  s.sql((db) => db.prepare(`INSERT INTO meta (key, value) VALUES ('config.memory.model', 'haiku')`).run());
  finishedSession(s, 'one', ['thanks, that is all']);
  s.modelWillSay([{ op: 'same', ids: [1, 2], note: 'both ask for brevity' }]);
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /to be judged on their own: m1 and m2 say the same thing — both ask for brevity\n[\s\S]*raised for the user: m1 and m2 say the same thing — both ask for brevity/);
  assert.deepEqual(asked(s).filter((r) => r.model === 'local').map((r) => r.kind), []);
  assert.equal(s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'dream.named_pairs'`).get().value), '[]', 'nothing left waiting');
});

test('a rule said again in other words, sharing no word, is checked against the rules where it applies and raised for the user once the pair, judged alone, holds it: once, never retired, and a wrong answer is dropped', () => {
  const s = sandbox();
  seed(s, [
    { body: 'I prefer short answers' },
    { body: 'never force-push on slate', scope: 'project:slate' },
    { body: 'keep your replies brief, always' },
    { type: 'fact', body: 'the laptop is a mac' },
  ]);
  willAnswer(s, 'dream-keys', { memories: [] });
  willAnswer(s, 'dream-pairs', { pairs: [{ pair: 1, label: 'same' }, { pair: 2, label: 'unrelated' }] });
  willAnswer(s, 'dream-repeats', { repeats: [{ rule: 3, same_as: 1 }, { rule: 3, same_as: 4 }, { rule: 9, same_as: 1 }, { rule: 2, same_as: 1 }] });
  const run = s.sumo(['memory', 'run', '--tidy']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /raised for the user: m1 and m3 say the same thing$/m);
  assert.match(run.out, /dropped — m1 and m2, named as saying the same thing: judged on their own, they are unrelated/, 'the force-push rule only shares the list with short answers');
  const judged = asked(s).find((r) => r.kind === 'dream-pairs');
  assert.match(judged.prompt, /\[p1\]\n {2}A: m1 [^\n]*short answers\n {2}B: m3 [^\n]*brief[^\n]*\n\[p2\]\n {2}A: m1 [^\n]*\n {2}B: m2 [^\n]*force-push/, 'what the check named is judged first, each pair alone');
  assert.match(run.out, /dropped — repeat m3 of m4: not a rule checked and another rule shown/, 'a fact is not among the rules shown');
  assert.match(run.out, /dropped — repeat m9 of m1/);
  const sent = asked(s).find((r) => r.kind === 'dream-repeats');
  assert.ok(sent, 'one call asks');
  assert.match(sent.prompt, /Rules checked:[\s\S]*\[m1\] I prefer short answers[\s\S]*\[m3\] keep your replies brief/);
  assert.doesNotMatch(sent.prompt, /the laptop is a mac/, 'only rules are shown');
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT kind, memory_a, memory_b FROM notices`).all().map((n) => ({ ...n }))), [{ kind: 'lookalike', memory_a: 1, memory_b: 3 }]);
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT id FROM memories WHERE state = 'active' ORDER BY id`).all().map((r) => r.id)), [1, 2, 3, 4], 'nothing retired');
  // Checked once: the next tidy does not ask about the same rules again.
  const before = asked(s).filter((r) => r.kind === 'dream-repeats').length;
  s.sumo(['memory', 'run', '--tidy']);
  assert.equal(asked(s).filter((r) => r.kind === 'dream-repeats').length, before, 'no rule left to check: no call');
});
