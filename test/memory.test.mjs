import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { score } from '../src/memory.mjs';
import { redact } from '../src/redact.mjs';
import { overlap } from '../src/text.mjs';
import { sandbox } from './helpers.mjs';

test('a memory is found by a differently-worded question', () => {
  const s = sandbox();
  assert.match(s.sumo(['add', 'preference', 'never push to main; always open a pull request']).out, /^saved m1 \[pref·global·stated\]/);

  const found = s.sumo(['search', 'how should I be pushing changes']);
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /m1 \[pref·global·stated\] never push to main/);
});

test('asking about something never said gets an explicit "nothing", and the miss is recorded', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'be concise']);

  const miss = s.sumo(['search', 'kubernetes deployment strategy']);
  assert.equal(miss.code, 0);
  assert.match(miss.out, /^nothing in memory for: kubernetes deployment strategy/);
  assert.deepEqual(
    s.sql((db) => db.prepare('SELECT query, scope FROM search_misses').all()).map((r) => ({ ...r })),
    [{ query: 'kubernetes deployment strategy', scope: 'global' }],
  );
});

test('a search that finds nothing is recorded without the secret in it, and a pasted page is not kept whole', () => {
  const s = sandbox();
  s.sumo(['search', 'the token is ghp_a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8']);
  s.sumo(['search', `stack ${'frame '.repeat(5000)}`]);
  const kept = s.sql((db) => db.prepare('SELECT query FROM search_misses ORDER BY rowid').all()).map((r) => r.query);
  assert.equal(kept[0], 'the token is [redacted]');
  assert.ok(kept[1].length <= 200, `kept ${kept[1].length} characters`);
});

test('superseding keeps the history and hides the old memory by default', () => {
  const s = sandbox();
  s.addProject('simba');
  s.sumo(['add', 'fact', 'simba uses bun as its package manager', '--project', 'simba']);
  const replaced = s.sumo(['add', 'fact', 'simba uses pnpm as its package manager', '--project', 'simba', '--supersedes', 'm1']);
  assert.equal(replaced.code, 0, replaced.err);

  const now = s.sumo(['search', 'package manager', '--project', 'simba']).out;
  assert.match(now, /pnpm/);
  assert.doesNotMatch(now, /bun/);

  assert.match(s.sumo(['search', 'package manager', '--project', 'simba', '--all']).out, /m1 \[fact·simba·stated·superseded\]/);

  const history = s.sumo(['history', 'm2']).out.trim().split('\n');
  assert.equal(history.length, 2);
  assert.match(history[0], /^m1 .*superseded .*bun/);
  assert.match(history[1], /^m2 .*active .*pnpm/);
  assert.match(s.sumo(['show', 'm1']).out, /superseded by: m2/);
});

test('adding something close to an existing memory shows it, and the two can be linked afterwards', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'use npm for installing packages']);
  const second = s.sumo(['add', 'preference', 'use pnpm for installing packages, never npm']);
  assert.match(second.out, /similar — if m2 replaces one: sumo supersede <old-id> m2/);
  assert.match(second.out, /\n {2}m1 \[pref·global·stated\] use npm/);

  assert.match(s.sumo(['supersede', 'm1', 'm2']).out, /^superseded m1/);
  assert.doesNotMatch(s.sumo(['search', 'installing packages']).out, /m1 /);

  const unrelated = s.sumo(['add', 'preference', 'write commit messages in the imperative mood']);
  assert.doesNotMatch(unrelated.out, /similar/);
});

test('two sentences about the same thing are recognised despite different word forms', () => {
  assert.equal(overlap('uses pnpm for installing packages', 'use pnpm to install a package'), 1);
  assert.equal(overlap('pushed the fixes', 'pushing a fix'), 1);
  assert.equal(overlap('never push to main', 'write tests first'), 0);
  assert.equal(overlap('the class compiles', 'classes compile'), 1);
});

test("one project's memory never appears in another project's search — only a count does", () => {
  const s = sandbox();
  s.addProject('simba');
  s.addProject('slate');
  s.sumo(['add', 'gotcha', 'integration tests need REDIS_URL set', '--project', 'simba']);

  for (const args of [['search', 'integration tests redis'], ['search', 'integration tests redis', '--project', 'slate']]) {
    const out = s.sumo(args).out;
    assert.match(out, /^nothing in memory for/);
    assert.doesNotMatch(out, /REDIS_URL/);
    assert.match(out, /matches in other projects, not shown: simba \(1\)/);
  }

  assert.match(s.sumo(['search', 'integration tests redis', '--project', 'simba']).out, /REDIS_URL/);
  assert.match(s.sumo(['search', 'integration tests redis', '--everywhere']).out, /REDIS_URL/);
});

test('a project can be named by its alias, and an unknown project is refused', () => {
  const s = sandbox();
  s.addProject('proj-simba', 'simba');
  assert.match(s.sumo(['add', 'decision', 'ship behind a feature flag', '--project', 'simba']).out, /\[dec·proj-simba·stated\]/);

  const unknown = s.sumo(['add', 'fact', 'anything', '--project', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown project "nope"/);
});

test('ranking: the project being worked on beats global, and what was stated beats what was scanned', () => {
  const now = '2026-09-17T00:00:00.000Z';
  const base = { rank: -1, scope: 'global', provenance: 'stated', type: 'preference', importance: 0.8, valid_from: now };
  const ctx = { projectScope: 'project:simba', now, bestRank: -1 };

  assert.ok(score({ ...base, scope: 'project:simba' }, ctx) > score(base, ctx));
  assert.ok(score(base, ctx) > score({ ...base, scope: 'project:slate' }, ctx));
  assert.ok(score(base, ctx) > score({ ...base, provenance: 'scanned' }, ctx));

  // A two-year-old fact ranks below a fresh one; a two-year-old preference does not age at all.
  const old = '2024-09-17T00:00:00.000Z';
  assert.ok(score({ ...base, type: 'fact' }, ctx) > score({ ...base, type: 'fact', valid_from: old }, ctx));
  assert.equal(score(base, ctx), score({ ...base, valid_from: old }, ctx));

  // Trust outweighs a moderately better text match, but not a far better one.
  const scanned = { ...base, type: 'fact', provenance: 'scanned' };
  const stated = { ...base, type: 'fact' };
  assert.ok(score({ ...stated, rank: -0.7 }, ctx) > score({ ...scanned, rank: -1 }, ctx));
  assert.ok(score({ ...stated, rank: -0.2 }, ctx) < score({ ...scanned, rank: -1 }, ctx));
});

test('a guess stays out of search until the user says yes, and is gone for good on no', () => {
  const s = sandbox();
  s.sumo(['config']);
  s.sql((db) => {
    const insert = db.prepare(
      `INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at)
       VALUES ('preference', 'global', ?, 'inferred', 'unconfirmed', 0.8, 'dream', ?, ?)`,
    );
    const at = new Date().toISOString();
    insert.run('prefers short pull request descriptions', at, at);
    insert.run('prefers tabs over spaces', at, at);
  });

  assert.match(s.sumo(['search', 'pull request descriptions']).out, /^nothing in memory/);

  assert.match(s.sumo(['confirm', 'm1']).out, /^confirmed m1 \[pref·global·stated\]/);
  assert.match(s.sumo(['search', 'pull request descriptions']).out, /m1 /);

  assert.match(s.sumo(['reject', 'm2']).out, /^rejected m2/);
  assert.match(s.sumo(['search', 'tabs spaces']).out, /^nothing in memory/);
  assert.equal(s.sumo(['confirm', 'm2']).code, 2);
});

test('forget hides a memory but keeps the record; purge erases it, and its id is never reused', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the staging database lives on host alpha']);
  s.sumo(['add', 'fact', 'the office wifi password hint is the cat']);

  assert.match(s.sumo(['forget', 'm1']).out, /^forgot m1 .*invalid/);
  assert.match(s.sumo(['search', 'staging database']).out, /^nothing in memory/);
  assert.match(s.sumo(['show', 'm1']).out, /host alpha/);

  assert.match(s.sumo(['forget', 'm2', '--purge']).out, /^purged m2/);
  assert.equal(s.sumo(['show', 'm2']).code, 2);
  assert.match(s.sumo(['search', 'wifi password', '--all']).out, /^nothing in memory/);

  assert.match(s.sumo(['add', 'fact', 'something new']).out, /^saved m3 /);
});

test('purge leaves nothing of what it erased in the database files: not the memory, not the sentence, not their index entries', () => {
  const s = sandbox();
  const secret = 'zq7hunter2vault'; // a shape the scrubber does not know, which is when purge is needed
  s.hook('prompt', { session_id: 'sess-p', prompt: `the staging login is admin / ${secret}, remember that` });
  s.modelWillSay([{ op: 'add', type: 'fact', scope: 'global', topic: 'deploy', body: `the staging login is admin / ${secret}`, turn: 1, quote: `the staging login is admin / ${secret}` }]);
  assert.match(s.sumo(['scribe', 'run']).out, /saved m1 /);
  assert.equal(s.sql((db) => db.prepare('SELECT source_turn FROM memories WHERE id = 1').get().source_turn), 1);

  assert.match(s.sumo(['forget', 'm1', '--purge']).out, /^purged m1/);
  for (const file of ['memory.db', 'memory.db-wal']) {
    const path = join(s.home, file);
    if (existsSync(path)) assert.equal(readFileSync(path).includes(secret), false, `${file} still holds the purged words`);
  }
});

test('secrets are scrubbed before storage, while paths and commit hashes survive', () => {
  const s = sandbox();
  const added = s.sumo(['add', 'fact', 'the deploy key is sk-abcdefghijklmnopqrstuvwxyz123456 and api_key=hunter2hunter2']);
  assert.match(added.out, /redacted 2 secret-looking values/);
  const stored = s.sql((db) => db.prepare('SELECT body FROM memories WHERE id = 1').get().body);
  assert.doesNotMatch(stored, /sk-abc|hunter2/);
  assert.match(stored, /\[redacted\]/);

  const harmless =
    'see /Users/sumo/projects/some-very-long-directory-name/src/components/BriefingGenerator.tsx at 4f2a9c1e8b7d6f5a4c3b2a1908f7e6d5c4b3a291';
  assert.deepEqual(redact(harmless), { text: harmless, count: 0 });
});

test('a workflow is taught once, found by its cue, and shown in full', () => {
  const s = sandbox();
  const steps = '1. run the tests\n2. bump the version\n3. open a PR with the changelog\n';
  const learned = s.sumo(['learn', 'ship it', '--cue', 'ship it'], { input: steps });
  assert.equal(learned.code, 0, learned.err);
  assert.match(learned.out, /^saved m1 \[proc·global·stated\] "ship it" — when: ship it/);

  assert.match(s.sumo(['search', 'ship it']).out, /m1 \[proc/);
  assert.match(s.sumo(['show', 'm1']).out, /2\. bump the version/);

  assert.equal(s.sumo(['learn', 'empty one'], { input: '' }).code, 2);
  assert.equal(s.sumo(['add', 'procedure', 'x']).code, 2);
});

test('export renders a readable view grouped by project and kind, and a complete JSON dump', () => {
  const s = sandbox();
  s.addProject('simba');
  s.sumo(['add', 'preference', 'be concise']);
  s.sumo(['add', 'gotcha', 'tests need REDIS_URL', '--project', 'simba']);
  s.sumo(['add', 'fact', 'old fact']);
  s.sumo(['forget', 'm3']);

  const md = s.sumo(['export']).out;
  assert.match(md, /^# Memory/);
  assert.match(md, /## Global\n\n### Preferences\n\n- be concise _\(m1 · stated · \d{4}-\d{2}-\d{2}\)_/);
  assert.match(md, /## Project: simba \(\/tmp\/projects\/simba\)\n\n### Gotchas\n\n- tests need REDIS_URL/);
  assert.doesNotMatch(md, /old fact/);

  const dump = JSON.parse(s.sumo(['export', '--json']).out);
  assert.equal(dump.memories.length, 3);
  assert.equal(dump.projects[0].slug, 'simba');
});

test('backup writes a private snapshot and keeps only the newest five', () => {
  const s = sandbox();
  s.sumo(['add', 'preference', 'be concise']);
  for (let i = 0; i < 7; i++) assert.equal(s.sumo(['backup']).code, 0);

  const dir = join(s.home, 'backups');
  const files = readdirSync(dir);
  assert.equal(files.length, 5);
  assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
});

test('a wrong first guess gets an answer complete enough to make the second one right', () => {
  const s = sandbox();

  // The docs say "workflow", the store says "procedure": either word, tried with add, gets the whole recipe at once.
  for (const word of ['workflow', 'procedure']) {
    const run = s.sumo(['add', word, 'PR creation: run CI, then open the PR']);
    assert.equal(run.code, 2);
    assert.match(run.err, /saved with sumo learn, not sumo add/);
    assert.match(run.err, /sumo learn "<short title>" --cue ".*" \[--gate '<regex>'\] \[--project S\] <<'EOF'\n1\. first step/);
  }

  // An unknown type is shown only what add really accepts — never a type add would then refuse.
  const unknown = s.sumo(['add', 'opinion', 'x']);
  assert.match(unknown.err, /one of: preference, fact, decision, gotcha \(for a workflow: sumo learn\)/);
  assert.doesNotMatch(unknown.err, /procedure/);

  // Asking any command for help is never an error.
  for (const args of [['learn', '--help'], ['learn', 'some title', '--help'], ['job', '-h'], ['search', '--help'], ['add', '--help']]) {
    const run = s.sumo(args);
    assert.deepEqual([run.code, run.err], [0, ''], args.join(' '));
    assert.match(run.out, /^sumo /);
  }
  assert.match(s.sumo(['learn', '--help']).out, /steps come on stdin/);

  s.sumo(['learn', 'ship it', '--cue', 'ship it'], { input: '1. run the tests\n2. tag it\n' });
  assert.match(s.sumo(['search', 'ship', '--type', 'workflow']).out, /m1 \[proc/);
});

test('mistakes in how sumo is called exit 2 with a plain message', () => {
  const s = sandbox();
  for (const [args, message] of [
    [['frobnicate'], /unknown command/],
    [['add', 'opinion', 'x'], /unknown type "opinion"/],
    [['search', 'x', '--projct', 'y'], /unknown option --projct/],
    [['search', 'x', '--project'], /--project needs a value/],
    [['show', 'twelve'], /not a memory id/],
    [['add', 'fact', '   '], /nothing to remember/],
  ]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.err}`);
    assert.match(run.err, message);
  }
});

test('purge reaches every backup: none of them holds the erased words afterwards, not even in its search index', () => {
  const s = sandbox();
  const secret = 'zanzibarquux'; // one word: the full-text index keeps it whole
  assert.match(s.sumo(['add', 'preference', `Always use ${secret} for deploys`]).out, /saved m1 /);
  s.sumo(['backup']);
  const purged = s.sumo(['forget', 'm1', '--purge']);
  assert.match(purged.out, /^purged m1 — erased, not recoverable, and from 1 backup;/m);
  for (const file of readdirSync(join(s.home, 'backups'))) {
    assert.equal(readFileSync(join(s.home, 'backups', file)).includes(secret), false, `${file} still holds the purged words`);
  }
});

test('a backup that cannot be cleaned whole is left as it was and named, never half-purged', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const s = sandbox();
  s.hook('prompt', { session_id: 'sess-o', prompt: 'the old vault word is quokkaglimmer, remember that' });
  s.modelWillSay([{ op: 'add', type: 'fact', scope: 'global', body: 'the old vault word is quokkaglimmer', turn: 1, quote: 'the old vault word is quokkaglimmer' }]);
  assert.match(s.sumo(['scribe', 'run']).out, /saved m1 /);
  s.sumo(['backup']);
  const [file] = readdirSync(join(s.home, 'backups'));
  const old = new DatabaseSync(join(s.home, 'backups', file));
  old.exec('DROP TABLE user_turns_fts');
  old.close();
  const purged = s.sumo(['forget', 'm1', '--purge']);
  assert.match(purged.out, /still in 1 backup that could not be cleaned — delete it by hand/);
  const after = new DatabaseSync(join(s.home, 'backups', file));
  assert.equal(after.prepare('SELECT COUNT(*) AS n FROM memories WHERE id = 1').get().n, 1, 'the memory is still there, not half-removed');
  after.close();
});
