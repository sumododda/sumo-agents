// The block every session starts with has a ceiling, whatever it is handed.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openDb, setMeta } from '../src/db.mjs';
import { add } from '../src/memory.mjs';
import { prime } from '../src/prime.mjs';
import { estimateTokens } from '../src/text.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-10-04T12:00:00.000Z';

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

test('a budget that is not a number holds the block to the default, not to nothing', async () => {
  await withDb((db) => {
    for (let i = 0; i < 120; i++) add(db, { type: 'preference', body: `preference number ${i} about one specific style choice ${i * 7}`, now: NOW });
    setMeta(db, 'config.prime.budget', '2k');
    assert.ok(estimateTokens(prime(db, { now: NOW })) <= 800);
    assert.ok(estimateTokens(prime(db, { budget: Number('lots'), now: NOW })) <= 800);
  });
});

test('a workflow with a long title or cue is named in a line, not in full', async () => {
  await withDb((db) => {
    for (let i = 0; i < 10; i++) {
      add(db, { type: 'procedure', title: `release flow ${i} ${'with many careful steps '.repeat(20)}`, cue: 'when shipping '.repeat(40), body: '1. test\n2. tag', now: NOW });
    }
    const block = prime(db, { now: NOW });
    assert.ok(estimateTokens(block) <= 800, `${estimateTokens(block)} tokens`);
    assert.match(block, /m1 "release flow 0 with many careful steps .*…" — when: when shipping .*…/);
  });
});

test('projects and workflows share the startup budget, leaving a pointer when a section does not fit', async () => {
  await withDb((db) => {
    for (let i = 0; i < 12; i++) {
      db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)')
        .run(`p${i}`, `p${i}`, `/work/${'long-directory/'.repeat(15)}project-${i}`, NOW);
    }
    for (let i = 0; i < 10; i++) {
      add(db, { type: 'procedure', title: `workflow ${i} ${'x'.repeat(60)}`, cue: 'when shipping '.repeat(10), body: '1. test\n2. ship', now: NOW });
    }
    const block = prime(db, { now: NOW });
    assert.ok(estimateTokens(block) <= 800, `${estimateTokens(block)} tokens`);
    assert.match(block, /sumo project list/);
    assert.match(block, /sumo search/);
    assert.match(block, /^<sumo-memory[\s\S]*<\/sumo-memory>$/);
  });
});

test('a path is shortened with ~ only when it is inside the home directory, not when it merely starts with its name', async () => {
  await withHome(freshHome(), { HOME: '/Users/sumo' }, async () => {
    const db = openDb();
    try {
      const insert = db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)');
      insert.run('mine', 'mine', '/Users/sumo/code/mine', NOW);
      insert.run('theirs', 'theirs', '/Users/sumo2/code/theirs', NOW);
      const block = prime(db, { now: NOW });
      assert.match(block, /mine \(~\/code\/mine\)/);
      assert.match(block, /theirs \(\/Users\/sumo2\/code\/theirs\)/);
    } finally {
      db.close();
    }
  });
});

test('with the memory writer off, the block tells the model to save what lasts itself', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      assert.doesNotMatch(prime(db), /memory writer is off/);
      setMeta(db, 'config.scribe.model', 'off');
      assert.match(prime(db), /The memory writer is off \(scribe\.model\): save what the user states that should last, as it is said, with sumo add\./);
    } finally {
      db.close();
    }
  });
});
