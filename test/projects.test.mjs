import assert from 'node:assert/strict';
import { existsSync, lutimesSync, mkdirSync, mkdtempSync, realpathSync, renameSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { card } from '../src/card.mjs';
import { openDb } from '../src/db.mjs';
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

test('a card is built from a fresh scan: rescanned when a file the scan reads changed, or the scan is a week old — and a fact about a file that went away goes with it', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const scannedAt = () => s.sql((db) => db.prepare(`SELECT scanned_at FROM projects WHERE slug = 'proj-simba'`).get().scanned_at);
  const back = (days) => new Date(Date.now() - days * 24 * 3_600_000);
  const setScanned = (days) => s.sql((db) => db.prepare(`UPDATE projects SET scanned_at = ? WHERE slug = 'proj-simba'`).run(back(days).toISOString()));
  // Every file and folder the scan reads, set to before the scan, so only what a step changes is newer.
  const age = (days) => {
    for (const name of ['.', '.github/workflows', 'package.json', 'pnpm-lock.yaml', 'tsconfig.json', 'CLAUDE.md', 'README.md']) {
      if (existsSync(join(dir, name))) utimesSync(join(dir, name), back(days), back(days));
    }
  };
  const cardFor = (session) => s.hook('prompt', { session_id: session, prompt: 'work on simba' }).out;

  // Nothing changed, scanned a day ago: the card is the stored one, and the scan stays as it was.
  age(3);
  setScanned(1);
  const before = scannedAt();
  assert.match(cardFor('fresh-1'), /stack: TypeScript, React, pnpm/);
  assert.equal(scannedAt(), before, 'no rescan when nothing it reads changed');

  // package.json changed after the scan: the card shows what it says now.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'proj-simba', scripts: { test: 'vitest' }, devDependencies: { typescript: '^5', vue: '^3' } }));
  assert.match(cardFor('fresh-2'), /stack: TypeScript, Vue, pnpm/);
  assert.notEqual(scannedAt(), before);

  // A change the stat cannot see — the file kept its old time — is still picked up once the scan is a week old.
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name: 'proj-simba', scripts: { test: 'vitest' }, devDependencies: { typescript: '^5', svelte: '^5' } }));
  age(20);
  setScanned(6);
  assert.match(cardFor('fresh-3'), /stack: TypeScript, Vue, pnpm/, 'six days old, nothing newer on disk: not rescanned');
  setScanned(8);
  assert.match(cardFor('fresh-4'), /stack: TypeScript, Svelte, pnpm/);

  // What an editor or the system leaves in the folder — a swap file, .DS_Store, a file saved by rename — is not a file
  // the scan reads: the folder's own time moves, and nothing is rescanned for it.
  age(20);
  setScanned(1);
  const quiet = scannedAt();
  writeFileSync(join(dir, '.notes.md.swp'), 'x');
  writeFileSync(join(dir, '.DS_Store'), 'x');
  writeFileSync(join(dir, 'notes.md.tmp'), 'draft');
  renameSync(join(dir, 'notes.md.tmp'), join(dir, 'notes.md'));
  cardFor('fresh-quiet');
  assert.equal(scannedAt(), quiet, 'no rescan for files the scan does not read');

  // The instructions file the card points at is deleted: the pointer goes, and the gap is named.
  age(20);
  setScanned(1);
  rmSync(join(dir, 'CLAUDE.md'));
  const after = cardFor('fresh-5');
  assert.doesNotMatch(after, /read CLAUDE\.md/);
  assert.match(after, /not set up here: .*AGENTS\.md/);
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
  assert.equal(missing.code, 1);
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
  assert.equal(unknown.code, 1);
  assert.match(unknown.err, /unknown project "nope" \(known: my-proj\)/);
});

test('purging a forgotten scanned fact leaves no copy of its words, and the fact stays let go', () => {
  const s = sandbox();
  const dir = fixtureRepo(s);
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  const about = () => s.sql((db) => db.prepare(`SELECT id, body FROM memories WHERE scan_key = 'about' AND state = 'active'`).get());
  const { id, body } = about();
  s.sumo(['forget', String(id)]);
  s.sumo(['forget', String(id), '--purge', '--yes']);
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
  s.sumo(['forget', String(about().id), '--purge', '--yes']);
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

    const shown = card(db, 'scratch');
    assert.match(shown, new RegExp(`^<project scratch> ${path}\\n`));
    assert.match(shown, /one folder per chore/);
    assert.match(shown, /14 days/);
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

test('a folder too wide to work in is never a project — the top of the disk, the home or above it, sumo\'s own home — and a name too common to mean one project is refused', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { homedir } = await import('node:os');
      const { dirname } = await import('node:path');
      const { addAlias } = await import('../src/projects.mjs');
      for (const wide of ['/', homedir(), dirname(homedir()), process.env.SUMO_AGENTS_HOME]) {
        assert.throws(() => addProject(db, wide, { slug: 'wide' }), /cannot be a project: it holds (the whole disk|your home|sumo's own home)|is not a directory/, wide);
      }
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM projects').get().n, 0);
      assert.throws(() => addProject(db, '/', { slug: 'disk' }), /cannot be a project: it holds the whole disk/);
      // A system folder that holds one on the PATH: the shell would write where programs run from.
      const system = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-system-')));
      mkdirSync(join(system, 'bin'));
      const path = process.env.PATH;
      process.env.PATH = `${join(system, 'bin')}:${path}`;
      try {
        assert.throws(() => addProject(db, system, { slug: 'system' }), /it holds .*\/bin, a folder on your PATH/);
      } finally {
        process.env.PATH = path;
      }
      const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-named-')));
      assert.throws(() => addProject(db, dir, { slug: 'the' }), /too short or too common a word to name a project/);
      const { project } = addProject(db, dir, { slug: 'fine-name' });
      for (const alias of ['the', 'it', 'please'.slice(0, 2)]) assert.throws(() => addAlias(db, project.slug, alias), /too short or too common/, alias);
      assert.equal(addAlias(db, project.slug, 'webapp'), 'webapp');
    } finally {
      db.close();
    }
  });
});

test('with every project archived, the list says how many and how to see them, not that there are none', () => {
  const s = sandbox();
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-archived-'));
  s.sumo(['project', 'add', dir, '--slug', 'demo-app']);
  s.sumo(['project', 'archive', 'demo-app']);
  assert.equal(s.sumo(['project', 'list']).out, 'no active projects — 1 archived: sumo project list --all\n');
  assert.match(s.sumo(['project', 'list', '--all']).out, /demo-app/);
});

test('adding a registered project again with another --slug says the name is kept, and how to add one', () => {
  const s = sandbox();
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-slug-'));
  s.sumo(['project', 'add', dir, '--slug', 'demo-app']);
  const again = s.sumo(['project', 'add', dir, '--slug', 'other-name']);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /^--slug is for a new project: this one keeps the name demo-app \(an alias adds a name: --alias other-name\)$/m);
});
