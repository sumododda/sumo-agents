import assert from 'node:assert/strict';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { card } from '../src/card.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { addProject, detect, ensureScratch, getProject, keepScratch, listProjects, pruneScratch } from '../src/projects.mjs';
import { estimateTokens } from '../src/text.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
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

test('adding a project scans it and shows its card', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);

  const added = s.sumo(['project', 'add', dir, '--alias', 'simba']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /^registered proj-simba\n<project proj-simba> .*proj-simba · also called: simba/);
  assert.match(added.out, /\nhas its own instructions — read CLAUDE\.md in the project root before editing\n/);
  assert.match(added.out, /stack: TypeScript, React, pnpm/);
  assert.match(added.out, /commands: test `pnpm test` · lint `pnpm run lint` · build `pnpm run build`/);
  // An index the agent is told to prefer costs more than the grep it replaces, so the card never names one.
  assert.doesNotMatch(added.out, /CodeGraph|codegraph/);
  assert.match(added.out, /about: Simba writes a daily briefing from your calendar and inbox\./);

  // Scanned facts are ordinary memories: searchable, scoped, marked as scanned.
  assert.match(s.sumo(['search', 'package manager stack', '--project', 'simba']).out, /\[fact·proj-simba·scanned\] stack: TypeScript/);
  assert.match(s.sumo(['project', 'list']).out, /^proj-simba {2}.*\(also: simba\)/);
});

test('adding the same directory again rescans instead of failing', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir]);

  const again = s.sumo(['project', 'add', dir]);
  assert.match(again.out, /^proj-simba was already registered — rescanned \(0 new, 0 changed, 0 gone\)/);
});

test('a fact stored scrubbed is not mistaken for a changed one: an unchanged README rescans as unchanged', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  writeFileSync(join(dir, 'README.md'), '# Simba\n\nCopy .env.example and set API_KEY=your-own-key before you run the dev server.\n');
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const about = () => s.sql((db) => db.prepare(`SELECT body FROM memories WHERE scan_key = 'about'`).all().map((r) => r.body));
  assert.deepEqual(about(), ['about: Copy .env.example and set APIKEY=[redacted] before you run the dev server.'], 'stored the way every memory is: scrubbed');

  assert.match(s.sumo(['project', 'rescan', 'simba']).out, /^rescanned: 0 new, 0 changed, 0 gone/);
  assert.equal(about().length, 1, 'no copy of the same fact is written on each rescan');
});

test('a rescan replaces exactly the facts that changed and retires the ones that are gone', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);

  renameSync(join(dir, 'pnpm-lock.yaml'), join(dir, 'bun.lock'));
  rmSync(join(dir, 'CLAUDE.md'));

  const rescanned = s.sumo(['project', 'rescan', 'simba']);
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
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  s.sumo(['add', 'fact', 'stack note: we are moving this project off pnpm to bun next sprint', '--project', 'simba']);

  s.sumo(['project', 'rescan', 'simba']);
  const found = s.sumo(['search', 'stack pnpm', '--project', 'simba']).out.trim().split('\n');
  assert.match(found[0], /\[fact·proj-simba·stated\] stack note/);
  assert.match(found[1], /\[fact·proj-simba·scanned\] stack:/);
});

test("a project's own gate is found, and what it never set up is said on the card", () => {
  const s = sandbox();
  const gated = join(s.root, 'gated');
  mkdirSync(gated, { recursive: true });
  writeFileSync(join(gated, 'Makefile'), 'check: test\n\t@true\ntest:\n\t@true\n');
  const added = s.sumo(['project', 'add', gated]);
  assert.match(added.out, /commands: check `make check` · test `make test`/);
  assert.match(added.out, /^not set up here: a CI workflow, AGENTS\.md$/m, 'a check command stands in for test and lint');

  const bare = join(s.root, 'bare');
  mkdirSync(bare, { recursive: true });
  assert.match(s.sumo(['project', 'add', bare]).out, /^not set up here: a test command, a lint command, a CI workflow, AGENTS\.md$/m);

  assert.doesNotMatch(s.sumo(['project', 'add', fixtureRepo(s)]).out, /not set up here/, 'a project with everything says nothing');
});

test('the card stays under its budget however much the project knows, and says what it left out', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  for (let i = 0; i < 40; i++) {
    s.sumo(['add', 'preference', `rule number ${i}: always do the thing called item-${i} before merging anything at all`, '--project', 'simba']);
  }

  const card = s.sumo(['project', 'show', 'simba']).out.trimEnd();
  assert.ok(estimateTokens(card) <= 200, `card is ${estimateTokens(card)} tokens`);
  assert.match(card, /\(\+\d+ more — sumo search "<topic>" --project proj-simba\)\n<\/project>$/);
  assert.match(card, /has its own instructions/, 'the pointer to the repo\'s own rules must survive the squeeze');
  for (const line of card.split('\n')) assert.ok(line.length <= 110 || line.startsWith('<project'), `line too long: ${line}`);
});

test('names cannot collide, and unknown directories are refused', () => {
  const s = sandbox();
  const one = fixtureRepo(s, 'one');
  const two = fixtureRepo(s, 'two');
  s.sumo(['project', 'add', one, '--alias', 'shared']);

  assert.match(s.sumo(['project', 'add', two, '--slug', 'one']).err, /the name "one" is taken/);
  assert.match(s.sumo(['project', 'add', two, '--alias', 'shared']).err, /"shared" already means the project one/);
  assert.equal(s.sumo(['project', 'list']).out.trim().split('\n').length, 1, 'a failed add must leave nothing behind');

  const missing = s.sumo(['project', 'add', join(s.root, 'nope')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /is not a directory/);
});

test('a project is detected in a sentence by whole words only, never by an ordinary word, never once archived', () => {
  const s = sandbox();
  s.sumo(['project', 'add', fixtureRepo(s, 'proj-simba'), '--alias', 'simba']);
  s.sumo(['project', 'add', fixtureRepo(s, 'api')]);
  s.sumo(['project', 'add', fixtureRepo(s, 'slate')]);

  const db = openDb(join(s.home, 'memory.db'));
  try {
    assert.deepEqual(detect(db, 'fix the briefing bug in Simba please'), ['proj-simba']);
    assert.deepEqual(detect(db, 'continue proj-simba and then slate').sort(), ['proj-simba', 'slate']);
    assert.deepEqual(detect(db, 'the simbas of the world, translated'), [], 'substrings must not match');
    assert.deepEqual(detect(db, 'add an api endpoint'), [], 'a project named like an ordinary word never triggers');
  } finally {
    db.close();
  }

  s.sumo(['project', 'archive', 'slate']);
  const after = openDb(join(s.home, 'memory.db'));
  try {
    assert.deepEqual(detect(after, 'continue slate'), []);
  } finally {
    after.close();
  }
  assert.doesNotMatch(s.sumo(['project', 'list']).out, /slate/);
  assert.match(s.sumo(['project', 'list', '--all']).out, /slate .*\[archived\]/);
});

test('a scanned fact the user forgot or replaced stays let go on a rescan; one that left the disk and came back returns', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const idOf = (key) => s.sql((db) => db.prepare(`SELECT id FROM memories WHERE scan_key = ? AND state = 'active'`).get(key)?.id);

  s.sumo(['forget', String(idOf('stack'))]);
  assert.match(s.sumo(['project', 'rescan', 'simba']).out, /^rescanned: 0 new, 0 changed, 0 gone/);
  assert.equal(idOf('stack'), undefined, 'the forgotten stack is not read back in');

  const instructions = idOf('instructions');
  assert.ok(instructions);
  const saved = s.sumo(['add', 'fact', 'the rules for this repo live in docs/RULES.md', '--project', 'simba']);
  const replacement = /saved m(\d+)/.exec(saved.out)[1];
  assert.equal(s.sumo(['supersede', String(instructions), replacement]).code, 0);
  s.sumo(['project', 'rescan', 'simba']);
  assert.equal(idOf('instructions'), undefined, 'the replaced fact does not come back beside its replacement');

  // The disk itself changing is news: the scanner says it.
  renameSync(join(dir, 'pnpm-lock.yaml'), join(dir, 'bun.lock'));
  assert.match(s.sumo(['project', 'rescan', 'simba']).out, /stack: TypeScript, React, bun/);

  // A fact the scanner retired because its file went away comes back with the file.
  const ci = idOf('ci');
  assert.ok(ci, 'the fixture has a CI fact');
  renameSync(join(dir, '.github'), join(dir, '.github-away'));
  s.sumo(['project', 'rescan', 'simba']);
  assert.equal(idOf('ci'), undefined);
  renameSync(join(dir, '.github-away'), join(dir, '.github'));
  s.sumo(['project', 'rescan', 'simba']);
  assert.ok(idOf('ci'), 'back with its file');
});

test('adding an archived project again brings it back', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  s.sumo(['project', 'archive', 'simba']);
  assert.doesNotMatch(s.sumo(['project', 'list']).out, /proj-simba/);
  const again = s.sumo(['project', 'add', dir]);
  assert.match(again.out, /^proj-simba is back from the archive — rescanned/);
  assert.match(s.sumo(['project', 'list']).out, /proj-simba/);
  assert.doesNotMatch(s.sumo(['project', 'show', 'simba']).out, /archived/);
});

test('a project is found by the name it was registered from as well as its slug, and an unknown one lists the known', () => {
  const s = sandbox();
  const dir = fixtureRepo(s, 'My Proj');
  assert.match(s.sumo(['project', 'add', dir]).out, /^registered my-proj/);
  const added = s.sumo(['add', 'fact', 'deploys go through the staging branch', '--project', 'My Proj']);
  assert.equal(added.code, 0, added.err);
  assert.match(added.out, /proj:my-proj|my-proj/);
  const unknown = s.sumo(['search', 'deploys', '--project', 'nope']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /unknown project "nope" \(known: my-proj\)/);
});

test('purging a forgotten scanned fact leaves no copy of its words, and the fact stays let go', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const about = () => s.sql((db) => db.prepare(`SELECT id, body FROM memories WHERE scan_key = 'about' AND state = 'active'`).get());
  const { id, body } = about();
  s.sumo(['forget', String(id)]);
  s.sumo(['forget', String(id), '--purge']);
  const kept = s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key LIKE 'scan.retired.%'`).all()).map((r) => r.value);
  assert.ok(kept.every((v) => !v.includes(body) && !body.includes(v)), 'only a digest is kept');
  s.sumo(['project', 'rescan', 'simba']);
  assert.equal(about(), undefined, 'a purge does not bring the fact back');
});

test('a scan reads only the repository\'s own plain files: a link out of it, a FIFO or a device is passed over', async () => {
  const { symlinkSync } = await import('node:fs');
  const { execFileSync } = await import('node:child_process');
  const s = sandbox();
  const dir = join(s.root, 'linked');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(s.root, 'netrc'), 'machine api.internal.example.com login deploybot password Tr0ub4dor-and-3-horses\n');
  symlinkSync(join(s.root, 'netrc'), join(dir, 'README.md'));
  symlinkSync('/dev/zero', join(dir, 'Makefile'));
  execFileSync('mkfifo', [join(dir, 'pyproject.toml')]);
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'linked', scripts: { test: 'vitest' } }));
  const added = s.sumo(['project', 'add', dir]);
  assert.equal(added.code, 0, added.err);
  assert.doesNotMatch(added.out, /Tr0ub4dor|deploybot/);
  assert.match(added.out, /test `npm (run )?test`/);
});

test('purging an active scanned fact keeps it let go on the next rescan', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const about = () => s.sql((db) => db.prepare(`SELECT id FROM memories WHERE scan_key = 'about' AND state = 'active'`).get());
  s.sumo(['forget', String(about().id), '--purge']);
  assert.match(s.sumo(['project', 'rescan', 'simba']).out, /^rescanned: 0 new/);
  assert.equal(about(), undefined);
});

/** Runs `fn` with a database in a home of its own, for what reads the home straight from the environment. */
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

/** Makes `path` look last written `days` ago. A link is aged itself, not what it points at. */
function age(path, days, { link = false } = {}) {
  const then = new Date(Date.now() - days * 86_400_000);
  (link ? lutimesSync : utimesSync)(path, then, then);
}

test('scratch is a project in the home, registered once: its card is how it is used, and the word in a sentence never means it', async () => {
  await withDb((db) => {
    const now = new Date().toISOString();
    const path = ensureScratch(db, now);
    assert.equal(path, realpathSync(join(process.env.SUMO_AGENTS_HOME, 'scratch')));
    assert.equal(ensureScratch(db, now), path, 'asked again, nothing changes');
    assert.deepEqual(listProjects(db).map((p) => [p.slug, p.path]), [['scratch', path]]);

    assert.deepEqual(detect(db, 'rebuild the parser from scratch'), [], 'a turn of phrase must not move the work');

    setMeta(db, 'config.scratch.days', '9');
    const shown = card(db, 'scratch');
    assert.match(shown, new RegExp(`^<project scratch> ${path}\\n`));
    assert.match(shown, /one folder per chore/);
    assert.match(shown, /9 days/);
    assert.match(shown, /sumo project add/);
  });
});

test('a chore nothing was written in for the set days is let go; one written in deep down stays; a link goes without what it points at', async () => {
  await withDb((db) => {
    const now = new Date().toISOString();
    const scratch = ensureScratch(db, now);
    const outside = mkdtempSync(join(tmpdir(), 'sumo-agents-outside-'));
    writeFileSync(join(outside, 'kept.txt'), 'not scratch');

    mkdirSync(join(scratch, 'idle', 'sub'), { recursive: true });
    writeFileSync(join(scratch, 'idle', 'sub', 'a.txt'), 'a');
    mkdirSync(join(scratch, 'worked', 'sub'), { recursive: true });
    writeFileSync(join(scratch, 'worked', 'sub', 'fresh.txt'), 'b');
    writeFileSync(join(scratch, 'loose.txt'), 'c');
    symlinkSync(outside, join(scratch, 'link'));

    for (const old of ['idle/sub/a.txt', 'idle/sub', 'idle', 'worked/sub', 'worked', 'loose.txt']) age(join(scratch, old), 30);
    age(join(outside, 'kept.txt'), 30);
    age(outside, 30);
    age(join(scratch, 'link'), 30, { link: true });

    assert.equal(pruneScratch(now, 14), 3);
    assert.equal(existsSync(join(scratch, 'idle')), false);
    assert.equal(existsSync(join(scratch, 'loose.txt')), false);
    assert.equal(existsSync(join(scratch, 'worked', 'sub', 'fresh.txt')), true, 'a file written in yesterday keeps its whole chore');
    assert.equal(existsSync(join(outside, 'kept.txt')), true, 'what a link points at is not scratch');
    assert.equal(pruneScratch(now, 60), 0, 'inside the days, nothing goes');
  });
});

test("a project of the user's already called scratch keeps the name, and is never pruned as scratch", async () => {
  await withDb((db) => {
    const now = new Date().toISOString();
    const mine = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-mine-')));
    mkdirSync(join(mine, 'old'));
    age(join(mine, 'old'), 30);
    addProject(db, mine, { slug: 'scratch', now });

    ensureScratch(db, now);
    assert.equal(getProject(db, 'scratch').path, mine);
    assert.doesNotMatch(card(db, 'scratch'), /one folder per chore/, 'their project has its own card');
    pruneScratch(now, 14);
    assert.equal(existsSync(join(mine, 'old')), true);
  });
});

test('scratch is tidied at a session start once a day: not again within the day, and again after it', async () => {
  await withDb((db) => {
    const at = (hours) => new Date(Date.now() + hours * 3_600_000).toISOString();
    const idle = (name) => {
      const dir = join(ensureScratch(db), name);
      mkdirSync(dir);
      age(dir, 30);
      return dir;
    };
    const first = idle('one');
    keepScratch(db, at(0));
    assert.equal(existsSync(first), false);

    const second = idle('two');
    keepScratch(db, at(1));
    assert.equal(existsSync(second), true, 'every folder was walked an hour ago');
    keepScratch(db, at(25));
    assert.equal(existsSync(second), false);
  });
});
