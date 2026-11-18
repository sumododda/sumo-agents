// Every change of a memory's state leaves one line of history, and what the user made theirs is never an extractor's.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { add, confirm, expireUnusedGotchas, forget, get, reject, supersede } from '../src/memory.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-11-18T12:00:00.000Z';
const LATER = '2026-11-19T12:00:00.000Z';

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

const events = (db, id) => db.prepare('SELECT ts, op, actor, run_id, reason FROM memory_events WHERE memory_id = ? ORDER BY id').all(id).map((e) => ({ ...e }));
/** A pass's row, as the extractor writes one before it files anything. */
function run(db) {
  db.prepare(`INSERT INTO sessions (id, harness, started_at) VALUES ('s1', 'sumo', ?)`).run(NOW);
  return Number(db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, started_at) VALUES ('s1', 'x1', 'running', 1, ?)`).run(NOW).lastInsertRowid);
}

test('a memory the user said to remember is primary, and its history starts with who wrote it', async () => {
  await withDb((db) => {
    const { memory } = add(db, { type: 'preference', body: 'never push to main', now: NOW });
    assert.equal(memory.derived_by, null);
    assert.deepEqual(events(db, memory.id), [{ ts: NOW, op: 'added', actor: 'chat-model', run_id: null, reason: null }]);
  });
});

test('a memory an extractor drew from the journal carries its version and the pass that filed it', async () => {
  await withDb((db) => {
    const runId = run(db);
    const { memory } = add(db, { type: 'fact', body: 'simba deploys from the release branch', writtenBy: 'scribe', derivedBy: 'x1', runId, now: NOW });
    assert.equal(memory.derived_by, 'x1');
    assert.deepEqual(events(db, memory.id), [{ ts: NOW, op: 'added', actor: 'scribe', run_id: runId, reason: null }]);
  });
});

test('replacing a memory is one line in the old one\'s history, naming what replaced it — whether it is added in its place or linked after', async () => {
  await withDb((db) => {
    const runId = run(db);
    const old = add(db, { type: 'fact', body: 'simba uses bun', now: NOW }).memory;
    const next = add(db, { type: 'fact', body: 'simba uses pnpm', writtenBy: 'scribe', derivedBy: 'x1', runId, supersedes: old.id, now: LATER }).memory;
    assert.deepEqual(events(db, old.id).at(-1), { ts: LATER, op: 'superseded', actor: 'scribe', run_id: runId, reason: `by m${next.id}` });

    const a = add(db, { type: 'preference', body: 'tabs in go files', now: NOW }).memory;
    const b = add(db, { type: 'preference', body: 'gofmt decides the indentation', now: NOW }).memory;
    supersede(db, a.id, b.id, LATER, { actor: 'user' });
    assert.deepEqual(events(db, a.id).map((e) => [e.op, e.actor, e.reason]), [['added', 'chat-model', null], ['superseded', 'user', `by m${b.id}`]]);
    supersede(db, b.id, next.id, LATER);
    assert.equal(events(db, b.id).at(-1).actor, 'sumo', 'nobody named: sumo did it');
  });
});

test('forgetting is one line, by whoever the caller says; forgetting it twice adds none', async () => {
  await withDb((db) => {
    const { memory } = add(db, { type: 'fact', body: 'the staging box is the mac mini', now: NOW });
    forget(db, memory.id, { now: LATER, actor: 'user' });
    forget(db, memory.id, { now: LATER, actor: 'user' });
    assert.deepEqual(events(db, memory.id).slice(1), [{ ts: LATER, op: 'forgotten', actor: 'user', run_id: null, reason: null }]);
  });
});

test('a purge leaves a line that it happened and none of the words', async () => {
  await withDb((db) => {
    const { memory } = add(db, { type: 'fact', body: 'the door code is zq7hunter2vault', now: NOW });
    forget(db, memory.id, { purge: true, now: LATER, actor: 'user' });
    const kept = events(db, memory.id);
    assert.deepEqual(kept.map((e) => e.op), ['added', 'purged']);
    assert.doesNotMatch(JSON.stringify(kept), /zq7hunter2vault|door/);
  });
});

test('a memory the user confirms becomes theirs: active, stated, primary — and a rejected one says who rejected it', async () => {
  await withDb((db) => {
    const held = add(db, { type: 'gotcha', body: 'the vendor api allows ten requests a minute', heldFor: 'outside', writtenBy: 'scribe', derivedBy: 'x1', now: NOW }).memory;
    assert.equal(held.state, 'unconfirmed');
    const yes = confirm(db, held.id, { now: LATER });
    assert.deepEqual([yes.state, yes.provenance, yes.derived_by], ['active', 'stated', null]);
    assert.deepEqual(events(db, held.id).at(-1), { ts: LATER, op: 'confirmed', actor: 'user', run_id: null, reason: null });

    const other = add(db, { type: 'gotcha', body: 'the vendor sandbox resets nightly', heldFor: 'outside', writtenBy: 'scribe', derivedBy: 'x1', now: NOW }).memory;
    reject(db, other.id, LATER, { actor: 'user' });
    assert.equal(get(db, other.id).derived_by, 'x1', 'a rejected one stays what it was');
    assert.deepEqual(events(db, other.id).at(-1), { ts: LATER, op: 'rejected', actor: 'user', run_id: null, reason: null });
  });
});

test('a gotcha let go for never being shown says so in its history, as sumo\'s doing and not the user\'s', async () => {
  await withDb((db) => {
    const old = add(db, { type: 'gotcha', body: 'the linter chokes on generated files', provenance: 'observed', writtenBy: 'worker', now: '2026-09-01T00:00:00.000Z' }).memory;
    assert.equal(expireUnusedGotchas(db, NOW), 1);
    assert.equal(get(db, old.id).state, 'invalid');
    assert.deepEqual(events(db, old.id).at(-1), { ts: NOW, op: 'expired', actor: 'sumo', run_id: null, reason: 'never shown in 45 days' });
  });
});
