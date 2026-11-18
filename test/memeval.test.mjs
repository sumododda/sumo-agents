// Memory measured on the owner's own history: the searches that once found nothing run again through today's
// search, and the extractor replayed on the turns behind what the user threw out and what they stated.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { getMeta, openDb, setMeta } from '../src/db.mjs';
import { extractorVersion } from '../src/ledger.mjs';
import { add, forget } from '../src/memory.mjs';
import { evalLines, memoryEval } from '../src/memeval.mjs';
import { ensureSession, recordReply, recordTurn } from '../src/sessions.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-11-17T12:00:00.000Z';
const ago = (days) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();

async function withDb(fn) {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      await fn(db);
    } finally {
      db.close();
    }
  });
}

const said = (db, text, days = 5) => {
  ensureSession(db, { id: 's1', harness: 'sumo', now: ago(days) });
  return recordTurn(db, { sessionId: 's1', text, now: ago(days) });
};
/** A memory drawn from a turn, as the pass files it. */
const derived = (db, body, turn, days = 5) => add(db, { type: 'preference', body, provenance: 'stated', writtenBy: 'scribe', sourceSession: 's1', sourceTurn: turn, sourceQuote: body, derivedBy: 'v0', now: ago(days) }).memory.id;
/** An extractor that files, from each turn, what `filing` says for it — and counts how often it was asked. */
const extractor = (filing) => {
  const asked = [];
  const extract = async (_db, { turnIds }) => {
    asked.push(...turnIds);
    return { ok: true, error: null, wouldFile: turnIds.flatMap((turnId) => (filing[turnId] ?? []).map((body) => ({ turnId, type: 'preference', scope: 'global', body, quote: body, existing: null }))), dropped: [] };
  };
  return Object.assign(extract, { asked });
};
const never = async () => assert.fail('the extractor was not to be asked');

test('every recorded miss is run again through today\'s search: what now finds something is counted, the rest named — and the eval keeps no miss and counts no use of its own', async () => {
  await withDb(async (db) => {
    const miss = (query, scope = 'global', times = 1) => {
      for (let n = 0; n < times; n++) db.prepare('INSERT INTO search_misses (ts, query, scope) VALUES (?, ?, ?)').run(ago(10 - n), query, scope);
    };
    // Talked through at length, never made a memory of: the conversations answer it now.
    said(db, 'the terraform state for staging lives in the shared bucket, locked through dynamodb');
    recordReply(db, { sessionId: 's1', text: 'Staging state is remote: an s3 backend with a dynamodb lock table.', now: ago(5) });
    miss('terraform state staging', 'global', 2);
    // A memory made since.
    const kept = add(db, { type: 'preference', body: 'uses pnpm for every javascript project', now: ago(2) }).memory.id;
    miss('pnpm javascript');
    // Still nothing; and a project that is gone.
    miss('kubernetes ingress annotations', 'everywhere');
    miss('pnpm javascript', 'project:removed');

    const before = db.prepare('SELECT COUNT(*) AS n FROM search_misses').get().n;
    const result = await memoryEval(db, { now: NOW, extract: never });
    assert.deepEqual({ total: result.misses.total, found: result.misses.found }, { total: 5, found: 3 });
    assert.deepEqual(result.misses.still.map((m) => `${m.query} (${m.scope})`).sort(), ['kubernetes ingress annotations (everywhere)', 'pnpm javascript (project:removed)']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM search_misses').get().n, before, 'an eval that grew the list it measures would measure itself');
    assert.equal(db.prepare('SELECT hits FROM memories WHERE id = ?').get(kept).hits, 0, 'nobody was shown anything');

    const lines = evalLines(result);
    assert.equal(lines[0], 'search: 3 of 5 recorded misses now find something');
    assert.ok(lines.includes('  still nothing: "kubernetes ingress annotations" (everywhere)'));
    assert.equal(lines.exitCode, undefined);
  });
});

test('the extractor is replayed on your own history: what you rejected or forgot must stay out, what you stated must be kept — filed-again junk and what it missed are named, and the score remembered', async () => {
  await withDb(async (db) => {
    const turns = {
      yaml: said(db, 'convert this file to yaml for me', 9),
      night: said(db, 'i am up late tonight, lets finish the migration', 8),
      pnpm: said(db, 'we use pnpm here, never npm', 7),
      fridays: said(db, 'never deploy on fridays', 6),
      old: said(db, 'the office wifi password is on the whiteboard', 90),
    };
    // Rejected back when a guess waited for a yes or no: the row says so.
    db.prepare(`UPDATE memories SET state = 'rejected', invalid_at = ? WHERE id = ?`).run(ago(8), derived(db, 'prefers yaml for config files', turns.yaml, 9));
    forget(db, derived(db, 'works mostly at night', turns.night, 8), { now: ago(7) });
    const pnpm = derived(db, 'uses pnpm, never npm', turns.pnpm, 7);
    const fridays = derived(db, 'never deploys on fridays', turns.fridays, 6);
    // Forgotten two months after it was filed: it went stale, it was never junk — not a case.
    forget(db, derived(db, 'the office wifi password is on the whiteboard', turns.old, 90), { now: ago(20) });
    // Nor is what a migration rejected: nobody judged it.
    const waiting = derived(db, 'likes long variable names', turns.yaml, 9);
    db.prepare(`UPDATE memories SET state = 'rejected', invalid_at = ? WHERE id = ?`).run(ago(1), waiting);
    db.prepare(`INSERT INTO memory_events (ts, memory_id, op, actor, reason) VALUES (?, ?, 'rejected', 'migration', 'a guess still waiting when guesses stopped being kept')`).run(ago(1), waiting);

    // Today's extractor: files the yaml junk again in other words, keeps the night junk out, keeps pnpm, and finds nothing in the fridays turn.
    const extract = extractor({ [turns.yaml]: ['the user prefers yaml for their config files'], [turns.pnpm]: ['uses pnpm, never npm'], [turns.fridays]: [] });
    const result = await memoryEval(db, { now: NOW, extract });
    assert.equal(result.replay.ran, true);
    assert.deepEqual(result.replay.negatives, { cases: 2, kept: 1, refiled: [{ id: 1, body: 'prefers yaml for config files' }] });
    assert.deepEqual(result.replay.positives, { cases: 2, kept: 1, missed: [{ id: fridays, body: 'never deploys on fridays' }] }, 'nothing filed from its turn is the memory missed');
    assert.equal(result.score, 0.5);
    assert.deepEqual([...extract.asked].sort(), [turns.yaml, turns.night, turns.pnpm, turns.fridays].sort(), 'one call a turn, and none for what is not a case');
    assert.deepEqual(JSON.parse(getMeta(db, 'memory.eval')).last, { version: extractorVersion(db), score: 0.5, cases: 4, at: NOW });

    const lines = evalLines(result);
    assert.deepEqual(lines.slice(1), [
      `extractor ${extractorVersion(db)}: 50% of 4 cases`,
      '  thrown out by you: 1 of 2 stay out, 1 would be filed again',
      '    filed again: m1 prefers yaml for config files',
      '  stated by you: 1 of 2 would be kept, 1 missed',
      `    missed: m${fridays} never deploys on fridays`,
    ]);

    // A memory it would file again as the very row it was — the extractor says which — is the same memory, whatever its words.
    const same = async (_db, { turnIds }) => ({ ok: true, error: null, wouldFile: turnIds[0] === turns.pnpm ? [{ turnId: turns.pnpm, type: 'preference', scope: 'global', body: 'pnpm', quote: 'pnpm', existing: pnpm }] : [], dropped: [] });
    assert.equal((await memoryEval(db, { now: NOW, extract: same })).replay.positives.kept, 1);

    // --limit bounds the calls: the newest of each kind.
    const one = extractor({});
    const bounded = await memoryEval(db, { now: NOW, limit: 1, extract: one });
    assert.deepEqual([bounded.replay.negatives.cases, bounded.replay.positives.cases, one.asked.length], [1, 1, 2]);
  });
});

test('a model that is off or down is said and the eval exits 1 — it could not run, which is not a pass; nothing is scored, and the searches are still measured', async () => {
  await withDb(async (db) => {
    const turn = said(db, 'we use pnpm here, never npm');
    derived(db, 'uses pnpm, never npm', turn);
    db.prepare('INSERT INTO search_misses (ts, query, scope) VALUES (?, ?, ?)').run(ago(3), 'pnpm', 'global');

    const down = await memoryEval(db, { now: NOW, extract: async () => ({ ok: false, error: 'llama-server did not become healthy', wouldFile: [], dropped: [] }) });
    assert.deepEqual({ ran: down.replay.ran, score: down.score, worse: down.worse }, { ran: false, score: null, worse: false });
    assert.deepEqual([...evalLines(down)], ['search: 1 of 1 recorded misses now find something', `extractor ${extractorVersion(db)}: not replayed — the model could not be asked — llama-server did not become healthy`]);
    assert.equal(evalLines(down).exitCode, 1, 'a script must be able to tell "not measured" from "measured, and fine"');
    assert.equal(getMeta(db, 'memory.eval'), null, 'a run that did not go through is not a score');

    setMeta(db, 'config.memory.model', 'off');
    const off = await memoryEval(db, { now: NOW, extract: never });
    assert.match(evalLines(off)[1], /not replayed — the memory pass is off \(memory\.model\)/);
    assert.equal(evalLines(off).exitCode, 1);
  });
  await withDb(async (db) => {
    const empty = await memoryEval(db, { now: NOW, extract: never });
    assert.deepEqual(evalLines(empty), ['search: no search has been recorded as finding nothing', `extractor ${extractorVersion(db)}: not replayed — no memory with the turn it came from to replay yet`]);
  });
});

test('an extractor that scores below the last other version exits 1 and names both scores; the same version run again compares with that other one still', async () => {
  await withDb(async (db) => {
    const turns = { pnpm: said(db, 'we use pnpm here, never npm', 7), fridays: said(db, 'never deploy on fridays', 6) };
    derived(db, 'uses pnpm, never npm', turns.pnpm, 7);
    derived(db, 'never deploys on fridays', turns.fridays, 6);
    const good = extractor({ [turns.pnpm]: ['uses pnpm, never npm'], [turns.fridays]: ['never deploys on fridays'] });
    const poor = extractor({ [turns.pnpm]: ['uses pnpm, never npm'] });

    const first = await memoryEval(db, { now: ago(1), extract: good });
    const was = extractorVersion(db);
    assert.deepEqual({ score: first.score, previous: first.previous, worse: first.worse }, { score: 1, previous: null, worse: false });

    // The model named by memory.model is part of what the extractor is: another model, another version.
    setMeta(db, 'config.memory.model', 'haiku');
    const is = extractorVersion(db);
    assert.notEqual(is, was);
    const second = await memoryEval(db, { now: NOW, extract: poor });
    assert.equal(second.worse, true);
    const lines = evalLines(second);
    assert.equal(lines.exitCode, 1);
    assert.equal(lines.at(-1), `worse: extractor ${was} scored 100% of 2 cases on ${ago(1).slice(0, 10)} — ${is} scores 50%`);

    const again = await memoryEval(db, { now: NOW, extract: good });
    assert.deepEqual({ worse: again.worse, previous: again.previous.version }, { worse: false, previous: was });
    assert.equal(evalLines(again).at(-1), `before: extractor ${was} scored 100% of 2 cases on ${ago(1).slice(0, 10)}`);
    assert.equal(evalLines(again).exitCode, undefined);
  });
});

test('sumo memory eval prints the numbers, and --json gives them as one object', () => {
  const s = sandbox();
  s.sumo(['search', 'kubernetes ingress annotations']);
  const run = s.sumo(['memory', 'eval']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^search: 0 of 1 recorded misses now find something\n {2}still nothing: "kubernetes ingress annotations" \(global\)\nextractor [0-9a-f]{8}: not replayed — no memory with the turn it came from to replay yet\n$/);
  const json = JSON.parse(s.sumo(['memory', 'eval', '--json', '--limit', '3']).out);
  assert.deepEqual({ misses: json.misses, score: json.score, worse: json.worse }, { misses: { total: 1, found: 0, still: [{ query: 'kubernetes ingress annotations', scope: 'global' }], stillMore: 0 }, score: null, worse: false });
  assert.equal(s.sumo(['memory', 'eval', '--limit', 'many']).code, 2);
});

test('sumo memory eval that could not ask the model exits 1, as text and as --json; with nothing to replay yet it has nothing to fail', () => {
  const s = sandbox();
  assert.equal(s.sumo(['memory', 'eval']).code, 0, 'no memory with its turn yet: nothing to measure');
  s.hook('prompt', { session_id: 'a', prompt: 'from now on always squash merge on github' });
  s.hook('session-end', { session_id: 'a' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', topic: 'git', body: 'Always squash merge on github', turn: 1, quote: 'always squash merge on github', keys: [] }]);
  s.sumo(['memory', 'run', '--auto']);

  s.modelWillSay([], { isError: true });
  const down = s.sumo(['memory', 'eval']);
  assert.match(down.out, /^extractor [0-9a-f]{8}: not replayed — the model could not be asked — /m);
  assert.equal(down.code, 1);
  assert.equal(s.sumo(['memory', 'eval', '--json']).code, 1);

  s.sumo(['config', 'memory.model', 'off']);
  const off = s.sumo(['memory', 'eval']);
  assert.match(off.out, /not replayed — the memory pass is off/);
  assert.equal(off.code, 1);
});

test('a memory from before memories were the user\'s own sentences is the one filed again when the same words of the same turn are quoted — however differently the two are worded', async () => {
  await withDb(async (db) => {
    const turn = said(db, 'again a wall of text. three lines max.', 6);
    const other = said(db, 'we ship on fridays', 6);
    const old = add(db, { type: 'preference', body: 'PR descriptions stay under three lines', provenance: 'stated', writtenBy: 'scribe', sourceSession: 's1', sourceTurn: turn, sourceQuote: 'three lines max', derivedBy: 'v0', now: ago(6) }).memory.id;
    const verbatim = (turnId, body, quote) => ({ turnId, type: 'preference', scope: 'global', body, quote, existing: null });
    // What the extractor files today: the sentence as typed.
    const kept = await memoryEval(db, { now: NOW, extract: async (_db, { turnIds }) => ({ ok: true, error: null, dropped: [], wouldFile: turnIds.includes(turn) ? [verbatim(turn, 'three lines max.', 'three lines max')] : [] }) });
    assert.deepEqual(kept.replay.positives, { cases: 1, kept: 1, missed: [] });
    // The same words quoted from another turn are not this memory.
    const elsewhere = await memoryEval(db, { now: NOW, extract: async () => ({ ok: true, error: null, dropped: [], wouldFile: [verbatim(other, 'three lines max.', 'three lines max')] }) });
    assert.deepEqual(elsewhere.replay.positives, { cases: 1, kept: 0, missed: [{ id: old, body: 'PR descriptions stay under three lines' }] });
  });
});
