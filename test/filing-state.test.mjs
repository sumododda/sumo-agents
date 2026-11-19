// How filing stands, read from the ledger without a model: the junk rate of what an extractor derived, what pauses
// filing, and that a changed extractor starts with a clean record.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, setMeta } from '../src/db.mjs';
import { extractorVersion, filingState } from '../src/ledger.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const DAY = 86_400_000;
const T0 = Date.parse('2026-10-01T00:00:00.000Z');
const at = (days) => new Date(T0 + days * DAY).toISOString();

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

/** `n` memories derived by one run of an extractor, as the ledger and the history hold them; returns their ids. */
function derive(db, version, n, from = 1) {
  db.prepare(`INSERT OR IGNORE INTO sessions (id, harness, started_at) VALUES ('s', 'claude', ?)`).run(at(0));
  const run = Number(db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('s', ?, 'ok', 1, 1, 1, ?, ?)`).run(version, at(0), at(0)).lastInsertRowid);
  const ids = Array.from({ length: n }, (_, i) => from + i);
  for (const id of ids) db.prepare(`INSERT INTO memory_events (ts, memory_id, op, actor, run_id) VALUES (?, ?, 'added', 'scribe', ?)`).run(at(0), id, run);
  return ids;
}
const event = (db, id, op, { actor = 'user', days = 1, reason = null } = {}) =>
  db.prepare('INSERT INTO memory_events (ts, memory_id, op, actor, reason) VALUES (?, ?, ?, ?, ?)').run(at(days), id, op, actor, reason);

test('the junk rate is the share of what this extractor derived that the user threw out within thirty days; under ten derived it says nothing', async () => {
  await withDb((db) => {
    const version = extractorVersion(db);
    const few = derive(db, version, 9);
    for (const id of few) event(db, id, 'forgotten');
    assert.equal(filingState(db).junkRate, null, 'nine derived, all forgotten: too few to call a rate');

    derive(db, version, 11, 10);
    assert.equal(filingState(db).junkRate, 9 / 20);
    assert.equal(filingState(db).paused, false, 'under half');
  });

  await withDb((db) => {
    const ids = derive(db, extractorVersion(db), 20);
    event(db, ids[0], 'forgotten');
    event(db, ids[1], 'rejected');
    event(db, ids[2], 'purged');
    event(db, ids[3], 'superseded', { actor: 'user' });
    event(db, ids[4], 'superseded', { actor: 'model-shell' });
    // None of these is the user throwing out what was filed:
    event(db, ids[5], 'superseded', { actor: 'scribe' }); // the pass filed a newer statement over it
    event(db, ids[6], 'forgotten', { actor: 'sumo', reason: 'rebuilt' }); // a rebuild let it go
    event(db, ids[7], 'forgotten', { days: 31 }); // wanted for a month: stale, not junk
    event(db, ids[8], 'confirmed');
    event(db, ids[9], 'expired', { actor: 'sumo', days: 45 });
    assert.equal(filingState(db).junkRate, 5 / 20);
  });
});

test('more than half of what an extractor filed thrown out pauses its filing, and says why', async () => {
  await withDb((db) => {
    const ids = derive(db, extractorVersion(db), 12);
    for (const id of ids.slice(0, 7)) event(db, id, 'forgotten');
    const state = filingState(db);
    assert.equal(state.paused, true);
    assert.equal(state.failures, 0);
    assert.equal(state.reason, '58% of what this extractor filed was forgotten or rejected within 30 days — sumo memory run reads again by hand, and a changed prompt or model starts afresh');
  });
});

test('a changed extractor starts with a clean record: the failures, the junk and the quarantine of the one before are not its own', async () => {
  await withDb((db) => {
    const version = extractorVersion(db);
    const ids = derive(db, version, 12);
    for (const id of ids) event(db, id, 'forgotten');
    db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('s', ?, 'quarantined', 3, 2, 2, ?, ?)`).run(version, at(1), at(1));
    setMeta(db, 'scribe.failures', 4);
    setMeta(db, 'scribe.failures_version', version);
    setMeta(db, 'scribe.last_error', 'model file not found');
    const before = filingState(db);
    assert.deepEqual({ paused: before.paused, failures: before.failures, quarantined: before.quarantined, junkRate: before.junkRate }, { paused: true, failures: 4, quarantined: 1, junkRate: 1 });
    assert.match(before.reason, /^the last 4 passes failed \(model file not found\)/, 'the failures are said first: nothing is being filed at all');

    // memory.model is part of the version: set to another, this is another extractor.
    setMeta(db, 'config.memory.model', 'haiku');
    assert.notEqual(extractorVersion(db), version);
    assert.deepEqual(filingState(db), { paused: false, reason: null, failures: 0, quarantined: 0, junkRate: null, fallbackUsed: false, lastOkAt: at(0) });
  });
});

test('a filing that paused itself is said in the block every session starts with, and why: nothing new is filed until the user acts', async () => {
  const { prime } = await import('../src/prime.mjs');
  await withDb((db) => {
    const ids = derive(db, extractorVersion(db), 10);
    for (const id of ids.slice(0, 6)) event(db, id, 'forgotten');
    assert.match(prime(db, { now: at(2) }), /^Warning: the memory pass has stopped filing by itself — 60% of what this extractor filed was forgotten or rejected within 30 days — sumo memory run reads again by hand, and a changed prompt or model starts afresh\. Tell the user\.$/m);
  });
});
