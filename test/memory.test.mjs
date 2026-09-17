import assert from 'node:assert/strict';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { score } from '../src/memory.mjs';
import { redact } from '../src/redact.mjs';
import { overlap } from '../src/text.mjs';
import { sandbox } from './helpers.mjs';

test('a memory is found by a differently-worded question', () => {
  const s = sandbox();
  assert.match(s.mem(['add', 'preference', 'never push to main; always open a pull request']).out, /^saved m1 \[pref·global·stated\]/);

  const found = s.mem(['search', 'how should I be pushing changes']);
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /m1 \[pref·global·stated\] never push to main/);
});

test('asking about something never said gets an explicit "nothing", and the miss is recorded', () => {
  const s = sandbox();
  s.mem(['add', 'preference', 'be concise']);

  const miss = s.mem(['search', 'kubernetes deployment strategy']);
  assert.equal(miss.code, 0);
  assert.match(miss.out, /^nothing in memory for: kubernetes deployment strategy/);
  assert.deepEqual(
    s.sql((db) => db.prepare('SELECT query, scope FROM search_misses').all()).map((r) => ({ ...r })),
    [{ query: 'kubernetes deployment strategy', scope: 'global' }],
  );
});

test('superseding keeps the history and hides the old memory by default', () => {
  const s = sandbox();
  s.addProject('simba');
  s.mem(['add', 'fact', 'simba uses bun as its package manager', '--project', 'simba']);
  const replaced = s.mem(['add', 'fact', 'simba uses pnpm as its package manager', '--project', 'simba', '--supersedes', 'm1']);
  assert.equal(replaced.code, 0, replaced.err);

  const now = s.mem(['search', 'package manager', '--project', 'simba']).out;
  assert.match(now, /pnpm/);
  assert.doesNotMatch(now, /bun/);

  assert.match(s.mem(['search', 'package manager', '--project', 'simba', '--all']).out, /m1 \[fact·simba·stated·superseded\]/);

  const history = s.mem(['history', 'm2']).out.trim().split('\n');
  assert.equal(history.length, 2);
  assert.match(history[0], /^m1 .*superseded .*bun/);
  assert.match(history[1], /^m2 .*active .*pnpm/);
  assert.match(s.mem(['show', 'm1']).out, /superseded by: m2/);
});

test('adding something close to an existing memory shows it, and the two can be linked afterwards', () => {
  const s = sandbox();
  s.mem(['add', 'preference', 'use npm for installing packages']);
  const second = s.mem(['add', 'preference', 'use pnpm for installing packages, never npm']);
  assert.match(second.out, /similar — if m2 replaces one: mem supersede <old-id> m2/);
  assert.match(second.out, /\n {2}m1 \[pref·global·stated\] use npm/);

  assert.match(s.mem(['supersede', 'm1', 'm2']).out, /^superseded m1/);
  assert.doesNotMatch(s.mem(['search', 'installing packages']).out, /m1 /);

  const unrelated = s.mem(['add', 'preference', 'write commit messages in the imperative mood']);
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
  s.mem(['add', 'gotcha', 'integration tests need REDIS_URL set', '--project', 'simba']);

  for (const args of [['search', 'integration tests redis'], ['search', 'integration tests redis', '--project', 'slate']]) {
    const out = s.mem(args).out;
    assert.match(out, /^nothing in memory for/);
    assert.doesNotMatch(out, /REDIS_URL/);
    assert.match(out, /matches in other projects, not shown: simba \(1\)/);
  }

  assert.match(s.mem(['search', 'integration tests redis', '--project', 'simba']).out, /REDIS_URL/);
  assert.match(s.mem(['search', 'integration tests redis', '--everywhere']).out, /REDIS_URL/);
});

test('a project can be named by its alias, and an unknown project is refused', () => {
  const s = sandbox();
  s.addProject('proj-simba', 'simba');
  assert.match(s.mem(['add', 'decision', 'ship behind a feature flag', '--project', 'simba']).out, /\[dec·proj-simba·stated\]/);

  const unknown = s.mem(['add', 'fact', 'anything', '--project', 'nope']);
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
  s.mem(['config']);
  s.sql((db) => {
    const insert = db.prepare(
      `INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at)
       VALUES ('preference', 'global', ?, 'inferred', 'unconfirmed', 0.8, 'dream', ?, ?)`,
    );
    const at = new Date().toISOString();
    insert.run('prefers short pull request descriptions', at, at);
    insert.run('prefers tabs over spaces', at, at);
  });

  assert.match(s.mem(['search', 'pull request descriptions']).out, /^nothing in memory/);

  assert.match(s.mem(['confirm', 'm1']).out, /^confirmed m1 \[pref·global·stated\]/);
  assert.match(s.mem(['search', 'pull request descriptions']).out, /m1 /);

  assert.match(s.mem(['reject', 'm2']).out, /^rejected m2/);
  assert.match(s.mem(['search', 'tabs spaces']).out, /^nothing in memory/);
  assert.equal(s.mem(['confirm', 'm2']).code, 2);
});

test('forget hides a memory but keeps the record; purge erases it, and its id is never reused', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'the staging database lives on host alpha']);
  s.mem(['add', 'fact', 'the office wifi password hint is the cat']);

  assert.match(s.mem(['forget', 'm1']).out, /^forgot m1 .*invalid/);
  assert.match(s.mem(['search', 'staging database']).out, /^nothing in memory/);
  assert.match(s.mem(['show', 'm1']).out, /host alpha/);

  assert.match(s.mem(['forget', 'm2', '--purge']).out, /^purged m2/);
  assert.equal(s.mem(['show', 'm2']).code, 2);
  assert.match(s.mem(['search', 'wifi password', '--all']).out, /^nothing in memory/);

  assert.match(s.mem(['add', 'fact', 'something new']).out, /^saved m3 /);
});

test('secrets are scrubbed before storage, while paths and commit hashes survive', () => {
  const s = sandbox();
  const added = s.mem(['add', 'fact', 'the deploy key is sk-abcdefghijklmnopqrstuvwxyz123456 and api_key=hunter2hunter2']);
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
  const learned = s.mem(['learn', 'ship it', '--cue', 'ship it'], { input: steps });
  assert.equal(learned.code, 0, learned.err);
  assert.match(learned.out, /^saved m1 \[proc·global·stated\] "ship it" — when: ship it/);

  assert.match(s.mem(['search', 'ship it']).out, /m1 \[proc/);
  assert.match(s.mem(['show', 'm1']).out, /2\. bump the version/);

  assert.equal(s.mem(['learn', 'empty one'], { input: '' }).code, 2);
  assert.equal(s.mem(['add', 'procedure', 'x']).code, 2);
});

test('export renders a readable view grouped by project and kind, and a complete JSON dump', () => {
  const s = sandbox();
  s.addProject('simba');
  s.mem(['add', 'preference', 'be concise']);
  s.mem(['add', 'gotcha', 'tests need REDIS_URL', '--project', 'simba']);
  s.mem(['add', 'fact', 'old fact']);
  s.mem(['forget', 'm3']);

  const md = s.mem(['export']).out;
  assert.match(md, /^# Memory/);
  assert.match(md, /## Global\n\n### Preferences\n\n- be concise _\(m1 · stated · \d{4}-\d{2}-\d{2}\)_/);
  assert.match(md, /## Project: simba \(\/tmp\/projects\/simba\)\n\n### Gotchas\n\n- tests need REDIS_URL/);
  assert.doesNotMatch(md, /old fact/);

  const dump = JSON.parse(s.mem(['export', '--json']).out);
  assert.equal(dump.memories.length, 3);
  assert.equal(dump.projects[0].slug, 'simba');
});

test('backup writes a private snapshot and keeps only the newest five', () => {
  const s = sandbox();
  s.mem(['add', 'preference', 'be concise']);
  for (let i = 0; i < 7; i++) assert.equal(s.mem(['backup']).code, 0);

  const dir = join(s.home, 'backups');
  const files = readdirSync(dir);
  assert.equal(files.length, 5);
  assert.equal(statSync(join(dir, files[0])).mode & 0o777, 0o600);
});

test('a wrong first guess gets an answer complete enough to make the second one right', () => {
  const s = sandbox();

  // The docs say "workflow", the store says "procedure": either word, tried with add, gets the whole recipe at once.
  for (const word of ['workflow', 'procedure']) {
    const run = s.mem(['add', word, 'PR creation: run CI, then open the PR']);
    assert.equal(run.code, 2);
    assert.match(run.err, /saved with mem learn, not mem add/);
    assert.match(run.err, /mem learn "<short title>" --cue ".*" \[--gate '<regex>'\] \[--project S\] <<'EOF'\n1\. first step/);
  }

  // An unknown type is shown only what add really accepts — never a type add would then refuse.
  const unknown = s.mem(['add', 'opinion', 'x']);
  assert.match(unknown.err, /one of: preference, fact, decision, gotcha \(for a workflow: mem learn\)/);
  assert.doesNotMatch(unknown.err, /procedure/);

  // Asking any command for help is never an error.
  for (const args of [['learn', '--help'], ['learn', 'some title', '--help'], ['job', '-h'], ['search', '--help'], ['add', '--help']]) {
    const run = s.mem(args);
    assert.deepEqual([run.code, run.err], [0, ''], args.join(' '));
    assert.match(run.out, /^mem /);
  }
  assert.match(s.mem(['learn', '--help']).out, /steps come on stdin/);

  s.mem(['learn', 'ship it', '--cue', 'ship it'], { input: '1. run the tests\n2. tag it\n' });
  assert.match(s.mem(['search', 'ship', '--type', 'workflow']).out, /m1 \[proc/);
});

test('mistakes in how mem is called exit 2 with a plain message', () => {
  const s = sandbox();
  for (const [args, message] of [
    [['frobnicate'], /unknown command/],
    [['add', 'opinion', 'x'], /unknown type "opinion"/],
    [['search', 'x', '--projct', 'y'], /unknown option --projct/],
    [['search', 'x', '--project'], /--project needs a value/],
    [['show', 'twelve'], /not a memory id/],
    [['add', 'fact', '   '], /nothing to remember/],
  ]) {
    const run = s.mem(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.err}`);
    assert.match(run.err, message);
  }
});
