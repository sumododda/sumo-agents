// Memory that is used stays in view, memory that is not steps back without being lost, a search can be held to a time,
// and the slow pass cannot rewrite memory wholesale.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyOps } from '../src/apply.mjs';
import { openDb } from '../src/db.mjs';
import { add, markHits, search } from '../src/memory.mjs';
import { preferences, prime } from '../src/prime.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-10-25T12:00:00.000Z';
const at = (day) => `${day}T09:00:00.000Z`;

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

test('a memory on a project card put in front of the model counts as used; one only sitting in the startup block does not', () => {
  const s = sandbox();
  s.addProject('simba', 'simba');
  s.sumo(['add', 'fact', 'deploys go to the staging cluster first', '--project', 'simba']);
  s.sumo(['add', 'preference', 'keep answers short']);
  const use = (id) => s.sql((db) => ({ ...db.prepare('SELECT hits, last_hit_at FROM memories WHERE id = ?').get(id) }));

  s.hook('session-start', { session_id: 'sess-u', source: 'startup' });
  assert.deepEqual(use(2), { hits: 0, last_hit_at: null }, 'the startup block is shown to every session: that is not a use');

  const shown = s.hook('prompt', { session_id: 'sess-u', prompt: 'ship the simba release' });
  assert.match(shown.out, /fact m1: deploys go to the staging cluster first/);
  assert.equal(use(1).hits, 1);
  assert.ok(Date.parse(use(1).last_hit_at) > 0, 'when it was last used is kept');

  s.hook('prompt', { session_id: 'sess-u', prompt: 'and tag simba too' });
  assert.equal(use(1).hits, 1, 'a card is put in front of a session once, and counted once');
});

/** The ids the preferences section shows when it has room for exactly `n` of them, in the order shown. */
function shownWithRoomFor(db, n) {
  for (let room = 1; room < 5000; room++) {
    const lines = preferences(db, room, NOW).slice(1);
    if (lines.length === n) return lines.map((l) => Number(/^- m(\d+) /.exec(l)[1]));
  }
  throw new Error(`no room shows exactly ${n}`);
}

test('where the startup block is short of room, a preference never used in 60 days leaves first, then the least recently used', async () => {
  await withDb((db) => {
    const pref = (word, created, usedOn) => {
      const { id } = add(db, { type: 'preference', body: `keep the ${word} house style rule`, now: at(created) }).memory;
      if (usedOn) markHits(db, [id], at(usedOn));
      return id;
    };
    const stale = pref('alpha', '2026-05-01');
    const recent = pref('bravo', '2026-05-02', '2026-10-20');
    const longAgo = pref('delta', '2026-05-03', '2026-07-01');
    const fresh = pref('gamma', '2026-10-15');
    const staler = pref('omega', '2026-05-04');
    const lately = pref('sigma', '2026-05-05', '2026-09-01');

    // A new memory nobody has had reason to use yet is as fresh as the day it was said; past 60 days unused, it is the first to go.
    assert.deepEqual(shownWithRoomFor(db, 6), [recent, fresh, lately, longAgo, staler, stale]);
    assert.deepEqual(shownWithRoomFor(db, 3), [recent, fresh, lately]);
    assert.match(preferences(db, 60, NOW)[0], /^Preferences \(\d of 6 shown · more on: .* — sumo search before assuming\):$/);

    // What already decided the order still decides it first: pinned, then the weight of the kind. Use only breaks the ties.
    const pinned = add(db, { type: 'preference', body: 'keep the kappa house style rule', pin: true, now: at('2026-04-01') }).memory.id;
    const decision = add(db, { type: 'decision', body: 'we ship the theta house style', now: at('2026-10-24') }).memory.id;
    markHits(db, [decision], at('2026-10-24'));
    const all = shownWithRoomFor(db, 8);
    assert.equal(all[0], pinned);
    assert.equal(all.at(-1), decision, 'a decision weighs less than a preference, used or not');

    // Left out is not lost: a search finds it, and being found puts it back in view.
    assert.deepEqual(search(db, 'alpha', { now: NOW }).results.map((m) => m.id), [stale]);
    assert.deepEqual(shownWithRoomFor(db, 3), [pinned, stale, recent]);

    // The block itself shows them in that order.
    const block = prime(db, { budget: 2000, now: NOW });
    assert.deepEqual([...block.matchAll(/^- m(\d+) /gm)].map((m) => Number(m[1])), shownWithRoomFor(db, 8));
  });
});

test('search can be held to what was said or changed since a day, or before one', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the deploy script lives in ops/deploy.sh']);
  s.sumo(['add', 'fact', 'the deploy target is the staging cluster']);
  s.sumo(['add', 'fact', 'the deploy needs the VPN up']);
  const daysAgo = (n) => new Date(Date.now() - n * 86_400_000).toISOString();
  const dayOf = (n) => daysAgo(n).slice(0, 10);
  s.sql((db) => {
    const set = db.prepare('UPDATE memories SET created_at = ?, valid_from = ? WHERE id = ?');
    set.run(daysAgo(200), daysAgo(200), 1);
    set.run(daysAgo(20), daysAgo(20), 2);
    set.run(daysAgo(2), daysAgo(2), 3);
  });
  const ids = (run) => {
    assert.equal(run.code, 0, run.err);
    return [...run.out.matchAll(/^m(\d+) /gm)].map((m) => Number(m[1])).sort((a, b) => a - b);
  };

  assert.deepEqual(ids(s.sumo(['search', 'deploy'])), [1, 2, 3]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', '7d'])), [3]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', '30d'])), [2, 3]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', dayOf(20)])), [2, 3]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--before', dayOf(100)])), [1]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', dayOf(200), '--before', dayOf(199)])), [1], 'the day named by --since is in, the day named by --before is not');
  assert.match(s.sumo(['search', 'deploy', '--since', dayOf(199), '--before', dayOf(198)]).out, /^nothing in memory for: deploy/);

  // Replacing a memory changes it: retired today, it was last changed today, whenever it was first said.
  s.sumo(['add', 'fact', 'the deploy script lives in ops/release.sh', '--supersedes', 'm1']);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', '7d'])), [3, 4]);
  assert.deepEqual(ids(s.sumo(['search', 'deploy', '--since', '7d', '--all'])), [1, 3, 4]);

  for (const [flag, value, why] of [
    ['--since', 'yesterday', /--since takes a day \(YYYY-MM-DD\) or a number of days back \(7d\)/],
    ['--since', '2026-02-30', /--since takes a day/],
    ['--since', '0d', /--since takes a day/],
    ['--before', '7d', /--before takes a day \(YYYY-MM-DD\)/],
    ['--before', '10/01/2026', /--before takes a day/],
  ]) {
    const run = s.sumo(['search', 'deploy', flag, value]);
    assert.equal(run.code, 2, `${flag} ${value}`);
    assert.match(run.err, why);
  }
  const turns = s.sumo(['search', 'deploy', '--turns', '--since', '7d']);
  assert.equal(turns.code, 2);
  assert.match(turns.err, /--since and --before hold memories to a time, not what the user typed/);
  assert.match(s.sumo(['search', '--help']).out, /\[--since <YYYY-MM-DD\|Nd>\] \[--before <YYYY-MM-DD>\]/);
  assert.match(s.sumo(['help']).out, /sumo search <query> .*\[--since <YYYY-MM-DD\|Nd>\] \[--before <YYYY-MM-DD>\]/);
});

const TOOLS = ['eslint', 'prettier', 'vitest', 'webpack', 'rollup', 'docker', 'podman', 'terraform', 'pulumi', 'bazel', 'gradle', 'maven'];

/**
 * A global memory with `filler` unrelated memories beside it and one per tool, and, for each tool, the user's turn that
 * replaces its memory and the slow pass's op that says so.
 */
function rewriteOf(db, { filler, tools }) {
  for (let i = 0; i < filler; i++) add(db, { type: 'fact', body: `unrelated fact number ${i} about item${i}`, now: at('2026-09-01') });
  const turns = new Map();
  const ops = tools.map((tool, i) => {
    const old = add(db, { type: 'preference', body: `pin ${tool} at major version one`, now: at('2026-09-01') }).memory.id;
    const turn = { id: 1000 + i, session_id: 'side-by-side', text: `from now on pin ${tool} at major version two` };
    turns.set(turn.id, turn);
    return { op: 'supersede', old, type: 'preference', scope: 'global', topic: 'tooling', body: `pin ${tool} at major version two`, turn: turn.id, quote: `pin ${tool} at major version two` };
  });
  return { ops, turns };
}

const active = (db) => db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'active'`).get().n;

test('the slow pass retires a few memories at a time, never more than ten in one pass: past that its replacements are refused and its additions kept', async () => {
  await withDb((db) => {
    // Eleven of 51: under a quarter, but more than ten at once.
    const { ops, turns } = rewriteOf(db, { filler: 40, tools: TOOLS.slice(0, 11) });
    const gotcha = { op: 'gotcha', scope: 'global', body: 'the staging database is wiped every night at two' };
    const before = active(db);

    const { applied, dropped } = applyOps(db, [...ops, gotcha], { source: 'dream', turns, now: NOW });
    assert.deepEqual(applied.map((l) => l.replace(/ m\d+ /, ' m? ')), ['saved m? [gotcha·global·observed] the staging database is wiped every night at two']);
    assert.equal(dropped.length, 11);
    assert.match(dropped[0], /^supersede: m\d+ is left as it is — this pass would retire 11 memories at once, more than 10: a rewrite that wide is not taken from a model$/);
    assert.equal(active(db), before + 1, 'nothing was retired and no replacement was kept');
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'superseded'`).get().n, 0);
  });
});

test('the slow pass may not retire more than a quarter of the memories in a scope; what retires nothing does not count', async () => {
  await withDb((db) => {
    // Four of 12 in global: a third.
    const { ops, turns } = rewriteOf(db, { filler: 8, tools: TOOLS.slice(0, 4) });
    const { applied, dropped } = applyOps(db, ops, { source: 'dream', turns, now: NOW });
    assert.deepEqual(applied, []);
    assert.equal(dropped.length, 4);
    assert.match(dropped[0], /— this pass would retire 4 of the 12 memories in global, more than a quarter: a rewrite that wide is not taken from a model$/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'superseded'`).get().n, 0);
  });

  await withDb((db) => {
    // Ten of 50 retire, under both bounds; an eleventh replacement is a guess, which retires nothing and is not counted.
    const { ops, turns } = rewriteOf(db, { filler: 39, tools: TOOLS.slice(0, 11) });
    ops[10].quote = 'words the user never typed';
    const { applied, dropped } = applyOps(db, ops, { source: 'dream', turns, now: NOW });
    assert.deepEqual(dropped, []);
    assert.equal(applied.filter((l) => l.startsWith('saved ')).length, 10);
    assert.equal(applied.filter((l) => l.startsWith('held for confirmation ')).length, 1);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'superseded'`).get().n, 10);
  });

  await withDb((db) => {
    // One of three is a third, but one replacement is never a rewrite: a small scope can still have a memory replaced.
    const { ops, turns } = rewriteOf(db, { filler: 2, tools: TOOLS.slice(0, 1) });
    assert.deepEqual(applyOps(db, ops, { source: 'dream', turns, now: NOW }).dropped, []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'superseded'`).get().n, 1);
  });

  await withDb((db) => {
    // The writer files each conversation as it happens; the bound is the slow pass's, which reads many side by side.
    const { ops, turns } = rewriteOf(db, { filler: 0, tools: TOOLS.slice(0, 2) });
    assert.deepEqual(applyOps(db, ops, { source: 'scribe', turns, now: NOW }).dropped, []);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'superseded'`).get().n, 2);
  });
});

test('a refused rewrite is said where the pass says what it did, and written to its log', () => {
  const s = sandbox();
  for (const rule of ['use tabs for indentation', 'write commit messages in the present tense', 'keep pull request descriptions short', 'run the linter before every commit']) s.sumo(['add', 'preference', rule]);
  for (const [id, prompt] of [['one', 'from now on use two spaces for indentation'], ['two', 'commit messages go in the past tense from now on'], ['three', 'thanks, that is all for today']]) {
    s.hook('prompt', { session_id: id, prompt });
    s.hook('session-end', { session_id: id, reason: 'other' });
    s.modelWillSay([]);
    s.sumo(['scribe', 'run']);
  }
  s.modelWillSay([
    { op: 'supersede', old: 1, type: 'preference', scope: 'global', topic: 'style', body: 'use two spaces for indentation', turn: 1, quote: 'use two spaces for indentation' },
    { op: 'supersede', old: 2, type: 'preference', scope: 'global', topic: 'git', body: 'write commit messages in the past tense', turn: 2, quote: 'in the past tense from now on' },
    { op: 'gotcha', scope: 'global', body: 'the staging database is wiped every night at two' },
  ]);

  const run = s.sumo(['dream', 'run']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^ {2}saved m5 \[gotcha·global·observed\]/m);
  assert.match(run.out, /^ {2}dropped — supersede: m1 is left as it is — this pass would retire 2 of the 4 memories in global, more than a quarter/m);
  assert.match(run.out, /^ {2}dropped — supersede: m2 is left as it is/m);
  assert.deepEqual(s.sql((db) => db.prepare(`SELECT id FROM memories WHERE state = 'active' ORDER BY id`).all().map((r) => r.id)), [1, 2, 3, 4, 5]);
  assert.match(readFileSync(join(s.home, 'logs', 'scribe.log'), 'utf8'), /dropped — supersede: m1 is left as it is — this pass would retire 2 of the 4 memories in global/);
  assert.match(s.sql((db) => db.prepare(`SELECT note FROM model_runs WHERE kind = 'dream'`).get().note), /^applied=1 dropped=2$/);
});
