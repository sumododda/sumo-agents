// The block every session starts with has a ceiling, whatever it is handed.
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, setMeta } from '../src/db.mjs';
import { add } from '../src/memory.mjs';
import { prime } from '../src/prime.mjs';
import { ensureScratch } from '../src/projects.mjs';
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
      setMeta(db, 'config.memory.model', 'off');
      assert.match(prime(db), /The memory pass is off \(memory\.model\): save what the user states that should last, as it is said, with sumo add\./);
    } finally {
      db.close();
    }
  });
});

test('the block says where work that belongs to no project goes; scratch is not listed among the projects, and alone it is not a memory', async () => {
  await withDb((db) => {
    ensureScratch(db, NOW);
    const empty = prime(db, { now: NOW });
    assert.match(empty, /Nothing remembered yet/);
    const line = empty.split('\n').find((l) => l.startsWith('Scratch: '));
    assert.ok(line.startsWith(`Scratch: ${join(process.env.SUMO_AGENTS_HOME, 'scratch')} — `), line);
    assert.match(line, /a folder per chore.*14 days/);

    db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)').run('mine', 'mine', '/work/mine', NOW);
    const block = prime(db, { now: NOW });
    assert.match(block, /^Projects: mine \(\/work\/mine\)$/m);
    assert.match(block, /^Scratch: .* 14 days/m);
    assert.doesNotMatch(block, /Nothing remembered yet/);
  });
});

test('the questions put to the user are about memories held for them — an outside read, or a save from the model\'s shell they never typed — everything or this session\'s project, two weeks old at most; nothing else waits as a guess', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { addProject } = await import('../src/projects.mjs');
  await withDb(async (db) => {
    for (const slug of ['alpha', 'beta']) addProject(db, mkdtempSync(join(tmpdir(), `sumo-agents-${slug}-`)), { slug, now: NOW });
    const days = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
    const held = (body, project, age, heldFor = 'outside') => add(db, { type: 'preference', body, project, heldFor, writtenBy: 'scribe', now: days(age) }).memory.id;
    // A guess of the old kind — unconfirmed, held for nothing — is something only an old database holds: nothing writes one now.
    const unconfirmed = (body, project, age) => {
      const id = held(body, project, age);
      db.prepare('UPDATE memories SET held_for = NULL WHERE id = ?').run(id);
      return id;
    };
    const everywhere = held('the vendor api allows ten requests a minute', undefined, 2);
    const alpha = held('alpha deploys only from the release branch', 'alpha', 3);
    const beta = held('beta keeps its fixtures in testdata', 'beta', 3);
    const stale = held('the vendor sandbox resets nightly', undefined, 20);
    const guess = unconfirmed('the user prefers tabs over spaces', undefined, 1);
    const shell = held('the user wants every branch rebased before review', 'beta', 1, 'shell');
    const asked = (block) => [...block.matchAll(/sumo confirm\|reject m(\d+)/g)].map((m) => Number(m[1]));

    assert.deepEqual(asked(prime(db, { now: NOW })), [everywhere], 'no project: only what is about everything');
    assert.deepEqual(asked(prime(db, { now: NOW, project: 'alpha' })), [everywhere, alpha], 'in alpha: alpha\'s too, never beta\'s');
    assert.ok(!asked(prime(db, { now: NOW, project: 'beta' })).includes(stale), 'one twenty days old is not asked in every session');
    assert.ok(asked(prime(db, { now: NOW, project: 'beta' })).includes(beta));
    const inBeta = prime(db, { now: NOW, project: 'beta' });
    assert.match(inBeta, new RegExp(`^Ask the user \\(then sumo confirm\\|reject m${beta}\\): is this right\\? "beta keeps its fixtures in testdata"$`, 'm'));
    assert.match(inBeta, new RegExp(`^Ask the user \\(then sumo confirm\\|reject m${shell}\\): they never typed this — keep it\\? "the user wants every branch rebased before review"$`, 'm'), 'what the model\'s shell saved unsaid is asked too, in words that say why');
    assert.equal(db.prepare('SELECT state FROM memories WHERE id = ?').get(stale).state, 'unconfirmed', 'it is still there, waiting');
    assert.ok(!asked(prime(db, { now: NOW })).includes(guess), 'a guess is not a queue any more: one left unconfirmed with no outside read behind it is never asked');
  });
});

test('where a project was left is said for two weeks, then no longer', async () => {
  const { addCheckpoint } = await import('../src/sessions.mjs');
  await withDb((db) => {
    const insert = db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)');
    for (const slug of ['fresh', 'edge', 'stale']) insert.run(slug, slug, `/work/${slug}`, NOW);
    const days = (n) => new Date(Date.parse(NOW) - n * 86_400_000).toISOString();
    addCheckpoint(db, { project: 'fresh', done: 'wired the journal', next: 'the search', now: days(2) });
    addCheckpoint(db, { project: 'edge', done: 'cut the release', now: days(13) });
    addCheckpoint(db, { project: 'stale', done: 'tried the rust rewrite', now: days(15) });
    const block = prime(db, { now: NOW });
    assert.match(block, /^Left off: fresh — wired the journal → next: the search \(2d ago\)$/m);
    assert.match(block, /^Left off: edge — cut the release \(13d ago\)$/m);
    assert.doesNotMatch(block, /Left off: stale/, 'fifteen days on it is history, a search away');
  });
});

test('a block squeezed to fit counts the lines it left out, in the line that says more is behind search', async () => {
  await withDb((db) => {
    for (let i = 0; i < 12; i++) {
      db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)').run(`p${i}`, `p${i}`, `/work/${'long-directory/'.repeat(15)}project-${i}`, NOW);
    }
    for (let i = 0; i < 10; i++) add(db, { type: 'procedure', title: `workflow ${i} ${'x'.repeat(60)}`, cue: 'when shipping '.repeat(10), body: '1. test\n2. ship', now: NOW });
    for (let i = 0; i < 5; i++) add(db, { type: 'preference', body: `preference number ${i} about one specific style choice`, now: NOW });
    const block = prime(db, { now: NOW });
    assert.ok(estimateTokens(block) <= 800, `${estimateTokens(block)} tokens`);
    const said = /^More memory \((\d+) lines? left out for room\): sumo search · sumo project list · sumo job list$/m.exec(block);
    assert.ok(said, block);
    assert.ok(Number(said[1]) >= 1);

    // A small block leaves nothing out and has nothing to count.
    assert.doesNotMatch(prime(db, { now: NOW, budget: 4000 }), /left out for room/);
  });
});

test('a session started inside a project is told it works there; one started elsewhere is told no project', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { addProject } = await import('../src/projects.mjs');
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      for (const slug of ['fruit', 'veg']) addProject(db, mkdtempSync(join(tmpdir(), `sumo-agents-${slug}-`)), { slug, now: NOW });
      assert.match(prime(db, { project: 'fruit', now: NOW }), /^Working in: fruit \(.+\) — this session started there; the work is there unless the user names another$/m);
      assert.doesNotMatch(prime(db, { now: NOW }), /Working in:/);
    } finally {
      db.close();
    }
  });
});
