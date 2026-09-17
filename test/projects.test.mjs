import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { detect } from '../src/projects.mjs';
import { estimateTokens } from '../src/text.mjs';
import { sandbox } from './helpers.mjs';

/** A small but realistic repository for the scanner to read. */
function fixtureRepo(s, name = 'proj-simba') {
  const dir = join(s.root, name);
  mkdirSync(join(dir, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(dir, '.codegraph'));
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name, scripts: { test: 'vitest', lint: 'eslint .', build: 'tsc' }, devDependencies: { typescript: '^5', react: '^19' } }),
  );
  writeFileSync(join(dir, 'pnpm-lock.yaml'), '');
  writeFileSync(join(dir, 'tsconfig.json'), '{}');
  writeFileSync(join(dir, 'CLAUDE.md'), '# rules for this repo\n');
  writeFileSync(join(dir, '.github', 'workflows', 'ci.yml'), 'on: push\n');
  writeFileSync(join(dir, 'README.md'), '# Simba\n\n[![build](https://x/badge.svg)](https://x)\n\nSimba writes a **daily briefing** from your calendar and inbox.\n\n## Install\n');
  return dir;
}

test('adding a project scans it, shows its card, and opens the directory to Claude Code', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);

  const added = s.mem(['project', 'add', dir, '--alias', 'simba']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /^registered proj-simba\n<project proj-simba> .*proj-simba · also called: simba/);
  assert.match(added.out, /\nhas its own instructions — read CLAUDE\.md in the project root before editing\n/);
  assert.match(added.out, /stack: TypeScript, React, pnpm/);
  assert.match(added.out, /commands: test `pnpm test` · lint `pnpm run lint` · build `pnpm run build`/);
  assert.match(added.out, /indexed by CodeGraph/);
  assert.match(added.out, /about: Simba writes a daily briefing from your calendar and inbox\./);
  assert.match(added.out, /\/add-dir /);

  const settings = JSON.parse(readFileSync(s.claudeLocalSettings, 'utf8'));
  assert.equal(settings.permissions.additionalDirectories.length, 1);
  assert.match(settings.permissions.additionalDirectories[0], /proj-simba$/);

  // Scanned facts are ordinary memories: searchable, scoped, marked as scanned.
  assert.match(s.mem(['search', 'package manager stack', '--project', 'simba']).out, /\[fact·proj-simba·scanned\] stack: TypeScript/);
  assert.match(s.mem(['project', 'list']).out, /^proj-simba {2}.*\(also: simba\)/);
});

test('adding the same directory again rescans instead of failing, and keeps existing settings intact', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  writeFileSync(s.claudeLocalSettings, JSON.stringify({ permissions: { allow: ['Bash(ls *)'], additionalDirectories: ['/elsewhere'] } }));
  s.mem(['project', 'add', dir]);

  const again = s.mem(['project', 'add', dir]);
  assert.match(again.out, /^proj-simba was already registered — rescanned \(0 new, 0 changed, 0 gone\)/);

  const settings = JSON.parse(readFileSync(s.claudeLocalSettings, 'utf8'));
  assert.deepEqual(settings.permissions.allow, ['Bash(ls *)']);
  assert.equal(settings.permissions.additionalDirectories.length, 2);
});

test('a rescan replaces exactly the facts that changed and retires the ones that are gone', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.mem(['project', 'add', dir, '--alias', 'simba']);

  renameSync(join(dir, 'pnpm-lock.yaml'), join(dir, 'bun.lock'));
  rmSync(join(dir, 'CLAUDE.md'));

  const rescanned = s.mem(['project', 'rescan', 'simba']);
  assert.match(rescanned.out, /^rescanned: 1 new, 2 changed, 1 gone/);
  assert.match(rescanned.out, /stack: TypeScript, React, bun/);
  assert.match(rescanned.out, /test `bun run test`/);
  assert.doesNotMatch(rescanned.out, /has its own instructions/);
  assert.match(rescanned.out, /^not set up here: AGENTS\.md$/m, 'the instruction file that went away is now named as a gap');

  const stacks = s.sql((db) => db.prepare(`SELECT id, state, superseded_by FROM memories WHERE scan_key = 'stack' ORDER BY id`).all());
  assert.equal(stacks.length, 2);
  assert.equal(stacks[0].state, 'superseded');
  assert.equal(stacks[0].superseded_by, stacks[1].id);
  assert.equal(stacks[1].state, 'active');
});

test('what the user stated is never replaced by what was read off disk, and outranks it', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.mem(['project', 'add', dir, '--alias', 'simba']);
  s.mem(['add', 'fact', 'stack note: we are moving this project off pnpm to bun next sprint', '--project', 'simba']);

  s.mem(['project', 'rescan', 'simba']);
  const found = s.mem(['search', 'stack pnpm', '--project', 'simba']).out.trim().split('\n');
  assert.match(found[0], /\[fact·proj-simba·stated\] stack note/);
  assert.match(found[1], /\[fact·proj-simba·scanned\] stack:/);
});

test("a project's own gate is found, and what it never set up is said on the card", () => {
  const s = sandbox();
  const gated = join(s.root, 'gated');
  mkdirSync(gated, { recursive: true });
  writeFileSync(join(gated, 'Makefile'), 'check: test\n\t@true\ntest:\n\t@true\n');
  const added = s.mem(['project', 'add', gated]);
  assert.match(added.out, /commands: check `make check` · test `make test`/);
  assert.match(added.out, /^not set up here: a CI workflow, AGENTS\.md$/m, 'a check command stands in for test and lint');

  const bare = join(s.root, 'bare');
  mkdirSync(bare, { recursive: true });
  assert.match(s.mem(['project', 'add', bare]).out, /^not set up here: a test command, a lint command, a CI workflow, AGENTS\.md$/m);

  assert.doesNotMatch(s.mem(['project', 'add', fixtureRepo(s)]).out, /not set up here/, 'a project with everything says nothing');
});

test('the card stays under its budget however much the project knows, and says what it left out', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.mem(['project', 'add', dir, '--alias', 'simba']);
  for (let i = 0; i < 40; i++) {
    s.mem(['add', 'preference', `rule number ${i}: always do the thing called item-${i} before merging anything at all`, '--project', 'simba']);
  }

  const card = s.mem(['project', 'show', 'simba']).out.trimEnd();
  assert.ok(estimateTokens(card) <= 200, `card is ${estimateTokens(card)} tokens`);
  assert.match(card, /\(\+\d+ more — mem search "<topic>" --project proj-simba\)\n<\/project>$/);
  assert.match(card, /has its own instructions/, 'the pointer to the repo\'s own rules must survive the squeeze');
  for (const line of card.split('\n')) assert.ok(line.length <= 110 || line.startsWith('<project'), `line too long: ${line}`);
});

test('names cannot collide, and unknown directories are refused', () => {
  const s = sandbox();
  const one = fixtureRepo(s, 'one');
  const two = fixtureRepo(s, 'two');
  s.mem(['project', 'add', one, '--alias', 'shared']);

  assert.match(s.mem(['project', 'add', two, '--slug', 'one']).err, /the name "one" is taken/);
  assert.match(s.mem(['project', 'add', two, '--alias', 'shared']).err, /"shared" already means the project one/);
  assert.equal(s.mem(['project', 'list']).out.trim().split('\n').length, 1, 'a failed add must leave nothing behind');

  const missing = s.mem(['project', 'add', join(s.root, 'nope')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /is not a directory/);
});

test('a project is detected in a sentence by whole words only, never by an ordinary word, never once archived', () => {
  const s = sandbox();
  s.mem(['project', 'add', fixtureRepo(s, 'proj-simba'), '--alias', 'simba']);
  s.mem(['project', 'add', fixtureRepo(s, 'api')]);
  s.mem(['project', 'add', fixtureRepo(s, 'slate')]);

  const db = openDb(join(s.home, 'memory.db'));
  try {
    assert.deepEqual(detect(db, 'fix the briefing bug in Simba please'), ['proj-simba']);
    assert.deepEqual(detect(db, 'continue proj-simba and then slate').sort(), ['proj-simba', 'slate']);
    assert.deepEqual(detect(db, 'the simbas of the world, translated'), [], 'substrings must not match');
    assert.deepEqual(detect(db, 'add an api endpoint'), [], 'a project named like an ordinary word never triggers');
  } finally {
    db.close();
  }

  s.mem(['project', 'archive', 'slate']);
  const after = openDb(join(s.home, 'memory.db'));
  try {
    assert.deepEqual(detect(after, 'continue slate'), []);
  } finally {
    after.close();
  }
  assert.doesNotMatch(s.mem(['project', 'list']).out, /slate/);
  assert.match(s.mem(['project', 'list', '--all']).out, /slate .*\[archived\]/);
});
