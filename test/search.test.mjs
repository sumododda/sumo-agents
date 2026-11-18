// One search: memories first, then the conversations themselves — every word first, then any word.
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { add, search } from '../src/memory.mjs';
import { addProject } from '../src/projects.mjs';
import { searchAll } from '../src/search.mjs';
import { ensureSession, journalEntry, markInjected, recordReply, recordTurn, searchJournal } from '../src/sessions.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-11-18T12:00:00.000Z';
const at = (minutes) => new Date(Date.parse('2026-11-10T09:00:00.000Z') + minutes * 60_000).toISOString();

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

/** A conversation in the journal: `[who, words]` pairs a minute apart, about `project` when one is named. Returns the ids as typed. */
function talk(db, sessionId, lines, { project = null, from = 0 } = {}) {
  ensureSession(db, { id: sessionId, harness: 'sumo', now: at(from) });
  if (project) markInjected(db, sessionId, project, at(from));
  return lines.map(([who, text], i) => {
    const said = { sessionId, text, now: at(from + i + 1) };
    return who === 'you' ? `t${recordTurn(db, said)}` : `r${recordReply(db, said)}`;
  });
}
const misses = (db) => db.prepare('SELECT query, scope FROM search_misses ORDER BY rowid').all().map((r) => ({ ...r }));
const hitsOf = (db, id) => db.prepare('SELECT hits FROM memories WHERE id = ?').get(id).hits;
const refs = (found) => found.conversations.map((h) => h.ref);

test('a topic talked through and never made a memory of is found in the conversations — the user\'s side and sumo\'s — and is not a miss', async () => {
  await withDb((db) => {
    const [turn, reply] = talk(db, 's1', [
      ['you', 'what would a rewrite of the harness in rust buy us?'],
      ['sumo', 'A rust harness would start faster, but the ledger screen and the tool loop would have to be written again.'],
    ]);
    const asked = searchAll(db, 'rust harness', { now: NOW });
    assert.deepEqual(asked.memories, []);
    assert.deepEqual(new Set(refs(asked)), new Set([turn, reply]));
    assert.deepEqual(asked.conversations.map((h) => h.kind).sort(), ['reply', 'turn']);
    assert.equal(asked.loose, false);

    // Only sumo said "ledger": before replies were kept this was a recorded miss.
    const ledger = searchAll(db, 'ledger', { now: NOW });
    assert.deepEqual(refs(ledger), [reply]);
    assert.match(ledger.conversations[0].excerpt, /ledger screen/);
    assert.deepEqual(misses(db), [], 'the conversations answered: nothing is kept as a miss');
  });
});

test('when a memory answers, a few lines of the conversations follow it, and only the memory shown counts as used', async () => {
  await withDb((db) => {
    const { memory } = add(db, { type: 'decision', body: 'the roadmap is kept in the wiki, never in the repo', now: NOW });
    talk(db, 's1', [1, 2, 3, 4, 5].map((n) => ['you', `roadmap idea ${n}: put the wiki page in order`]));
    const found = searchAll(db, 'roadmap wiki', { now: NOW });
    assert.deepEqual(found.memories.map((m) => m.id), [memory.id]);
    assert.equal(found.conversations.length, 3, 'fewer than a search of the conversations alone would show');
    assert.equal(found.moreSaid, 2, 'and the rest is counted');
    assert.equal(hitsOf(db, memory.id), 1);
    assert.equal(searchAll(db, 'roadmap wiki', { now: NOW, turns: true }).conversations.length, 5, '--turns is the conversations alone, all of them');
    assert.equal(hitsOf(db, memory.id), 1, 'a search of the conversations alone uses no memory');
    assert.deepEqual(misses(db), []);
  });
});

test('every word is looked for first: what holds them all is the answer, and what holds only one of them is left out', async () => {
  await withDb((db) => {
    const both = add(db, { type: 'preference', body: 'deploy simba on weekdays only', now: NOW }).memory;
    const one = add(db, { type: 'fact', body: 'the deploy script lives in scripts/', now: NOW }).memory;
    assert.deepEqual(search(db, 'deploy weekdays', { now: NOW }).results.map((m) => m.id), [both.id]);
    assert.equal(hitsOf(db, one.id), 0, 'a candidate that was not shown was not used');
    assert.equal(search(db, 'deploy weekdays', { now: NOW }).fellBack, false);
  });
});

test('only when nothing holds every word is any word tried; a result sharing two of several words answers, one sharing a single word is shown and still kept as a miss', async () => {
  await withDb((db) => {
    add(db, { type: 'preference', body: 'never push to main; always open a pull request', now: NOW });
    const two = search(db, 'pull request template wording', { now: NOW });
    assert.deepEqual([two.results.length, two.fellBack, two.best, two.loose], [1, true, 2, false]);
    assert.deepEqual(misses(db), []);

    const loose = search(db, 'how should I be pushing changes', { now: NOW });
    assert.deepEqual([loose.results.length, loose.fellBack, loose.best, loose.loose], [1, true, 1, true]);
    assert.deepEqual(misses(db), [{ query: 'how should I be pushing changes', scope: 'global' }]);

    const all = searchAll(db, 'pushing kubernetes helm', { now: NOW });
    assert.deepEqual([all.memories.length, all.loose], [1, true]);
    assert.equal(misses(db).length, 2, 'the one search keeps the same record');

    // One word asked for is all the words: finding it is an answer.
    assert.equal(search(db, 'push', { now: NOW }).loose, false);
    assert.equal(misses(db).length, 2);
  });
});

test('a loose memory beside a conversation that holds the words is not a miss: the conversation answered', async () => {
  await withDb((db) => {
    add(db, { type: 'fact', body: 'the screen is redrawn by ink', now: NOW });
    const [, reply] = talk(db, 's1', [['you', 'what next?'], ['sumo', 'Roadmap ideas, todo next: the ledger look, then session resume.']]);
    const found = searchAll(db, 'roadmap ideas todo next', { now: NOW });
    assert.deepEqual(found.memories, [], 'every word was found, so nothing holding one word is shown');
    assert.deepEqual(refs(found), [reply]);
    assert.deepEqual(misses(db), []);
  });
});

test('a word in a memory\'s title or search terms outweighs the same word somewhere in a body', async () => {
  await withDb((db) => {
    const inBody = add(db, { type: 'fact', body: 'the release notes mention the linter once', now: NOW }).memory;
    const inKeys = add(db, { type: 'fact', body: 'always run eslint --fix before committing code', keys: ['linter'], now: NOW }).memory;
    const inTitle = add(db, { type: 'procedure', title: 'linter setup', body: '1. install\n2. configure\n3. wire it into the editor and the hook that runs before a commit', now: NOW }).memory;
    const ranked = search(db, 'linter', { now: NOW, record: false }).results.sort((a, b) => a.rank - b.rank).map((m) => m.id);
    assert.equal(ranked.at(-1), inBody.id, `the body-only match ranks last: ${ranked}`);
    assert.deepEqual(new Set(ranked.slice(0, 2)), new Set([inKeys.id, inTitle.id]));
  });
});

test('what was said about another project is counted, not shown — unless the project is named, or everywhere is asked for', async () => {
  await withDb((db) => {
    for (const slug of ['simba', 'nala']) addProject(db, mkdtempSync(join(tmpdir(), `sumo-agents-${slug}-`)), { slug, now: NOW });
    const [open] = talk(db, 's0', [['you', 'the staging certificate renews itself']]);
    const [simba] = talk(db, 's1', [['you', 'simba staging certificate expires in march']], { project: 'simba' });
    const [nala] = talk(db, 's2', [['you', 'nala staging certificate is a wildcard'], ['sumo', 'Noted: the staging certificate for nala is a wildcard.']], { project: 'nala' });

    const plain = searchAll(db, 'staging certificate', { now: NOW });
    assert.deepEqual(refs(plain), [open], 'no project named: only what was said about none');
    assert.deepEqual(plain.elsewhere, { 'project:simba': 1, 'project:nala': 2 });

    const inSimba = searchAll(db, 'staging certificate', { now: NOW, project: 'simba' });
    assert.deepEqual(new Set(refs(inSimba)), new Set([open, simba]));
    assert.deepEqual(inSimba.elsewhere, { 'project:nala': 2 });
    assert.equal(inSimba.conversations.find((h) => h.ref === simba).project, 'simba');

    const all = searchAll(db, 'staging certificate', { now: NOW, everywhere: true });
    assert.ok(refs(all).includes(nala));
    assert.deepEqual(all.elsewhere, {});

    // What only another project holds is not shown, and the search is a miss in this scope.
    assert.deepEqual(refs(searchAll(db, 'wildcard', { now: NOW })), []);
    assert.deepEqual(misses(db), [{ query: 'wildcard', scope: 'global' }]);
  });
});

test('the conversations can be held to when it was said, and a type asks for memories alone', async () => {
  await withDb((db) => {
    const [early] = talk(db, 's1', [['you', 'the deploy window is friday']], { from: 0 });
    const [late] = talk(db, 's2', [['you', 'the deploy window moved to monday']], { from: 3 * 24 * 60 });
    const cut = at(24 * 60);
    assert.deepEqual(refs(searchAll(db, 'deploy window', { now: NOW, before: cut })), [early]);
    assert.deepEqual(refs(searchAll(db, 'deploy window', { now: NOW, since: cut })), [late]);
    assert.deepEqual(refs(searchAll(db, 'deploy window', { now: NOW, type: 'fact' })), [], 'a type is a kind of memory');
  });
});

test('a Japanese word is found inside the run it was written in, in a reply as in a turn; every word still comes before any word', async () => {
  await withDb((db) => {
    const [tokyo, osaka, reply] = talk(db, 's1', [
      ['you', '東京のサーバーを再起動して'],
      ['you', '大阪のサーバーは速い'],
      ['sumo', '東京のサーバーを再起動しました。'],
    ]);
    assert.deepEqual(new Set(searchJournal(db, '東京 サーバー').hits.map((h) => h.ref)), new Set([tokyo, reply]), 'both words: the row holding only one is left out');
    assert.deepEqual(searchJournal(db, 'サーバー').hits.map((h) => h.ref), [reply, osaka, tokyo], 'newest first when all hold it');
    const any = searchJournal(db, '大阪 名古屋');
    assert.deepEqual([any.hits.map((h) => h.ref), any.fellBack, any.best], [[osaka], true, 1]);
    assert.deepEqual(searchJournal(db, 'テ_ト').hits, [], 'what is typed is matched as typed, never as a pattern');
  });
});

test('a line of a long reply shows the part around the words asked for, not its first words', async () => {
  await withDb((db) => {
    const [, reply] = talk(db, 's1', [['you', 'explain the release'], ['sumo', `${'Some preamble about nothing in particular. '.repeat(40)}The publish step needs the reviewer's approval in the release environment. ${'And a long tail. '.repeat(40)}`]]);
    const [hit] = searchJournal(db, 'reviewer approval').hits;
    assert.equal(hit.ref, reply);
    assert.match(hit.excerpt, /^….*reviewer's approval.*…$/);
    assert.ok(hit.excerpt.length <= 202, `${hit.excerpt.length} characters`);
  });
});

test('a turn or a reply is opened whole by the id a search printed, with what was said around it', async () => {
  await withDb((db) => {
    const ids = talk(db, 's1', [
      ['you', 'first question'],
      ['sumo', 'first answer'],
      ['you', 'the one in the middle'],
      ['sumo', 'its answer'],
      ['you', 'a later question'],
      ['sumo', 'a later answer'],
    ]);
    const { entry, around } = journalEntry(db, ids[2]);
    assert.deepEqual([entry.kind, entry.ref, entry.text], ['turn', ids[2], 'the one in the middle']);
    assert.deepEqual(around.map((e) => e.ref), ids.slice(0, 5), 'two either side, in the order it was said');

    assert.equal(journalEntry(db, ids[5]).entry.text, 'a later answer');
    assert.equal(journalEntry(db, 'm12'), null, 'a memory id is not one of these');
    assert.throws(() => journalEntry(db, 't999'), /no turn t999 in the conversations/);
    assert.throws(() => journalEntry(db, 'r999'), /no reply r999/);
  });
});
