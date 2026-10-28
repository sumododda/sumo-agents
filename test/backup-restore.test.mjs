// A way back from a damaged database: the error names the newest backup and the command, doctor says the same, and
// `sumo backup restore` puts a copy back — checked first, the damaged one kept aside — for the user only.
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { HAS_PTY, sandbox } from './helpers.mjs';

const damage = (s) => {
  for (const side of ['-wal', '-shm']) rmSync(join(s.home, `memory.db${side}`), { force: true });
  writeFileSync(join(s.home, 'memory.db'), 'this is not a database, it was overwritten');
};

test('a damaged database names the newest backup and the command that puts it back; the restore keeps the damaged one aside and brings the rows back', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the staging database is wiped every night']);
  const backedUp = s.sumo(['backup']);
  assert.equal(backedUp.code, 0, backedUp.err);
  s.sumo(['add', 'fact', 'added after the backup, so the restore goes without it']);
  damage(s);

  const broken = s.sumo(['search', 'staging']);
  assert.equal(broken.code, 1);
  assert.match(broken.err, /file is not a database — the newest backup is .*memory-.*\.db \(\d{4}-\d{2}-\d{2} \d{2}:\d{2}\): sumo backup restore puts it back, keeping this one aside/);
  assert.match(s.sumo(['doctor']).out, /FAIL {2}database opens — file is not a database — the newest backup is .*: sumo backup restore/);

  // The model's shell may not do it: putting a database back is the user's.
  const byModel = s.sumo(['backup', 'restore'], { extraEnv: { SUMO_TOOL: '1' } });
  assert.equal(byModel.code, 1);
  assert.match(byModel.err, /Refused: the model's shell does not change what the user controls/);

  const restored = s.sumo(['backup', 'restore']);
  assert.equal(restored.code, 0, restored.err);
  assert.match(restored.out, /^restored .*memory-.*\.db \(backed up \d{4}-\d{2}-\d{2} \d{2}:\d{2}\) — 1 memory; the damaged database is kept as .*memory\.db\.damaged-.*$/m);
  assert.equal(statSync(join(s.home, 'memory.db')).mode & 0o777, 0o600);
  assert.ok(readdirSync(s.home).some((f) => f.startsWith('memory.db.damaged-')), 'the damaged one is kept, not deleted');
  const found = s.sumo(['search', 'staging']);
  assert.equal(found.code, 0, found.err);
  assert.match(found.out, /the staging database is wiped every night/);
  assert.doesNotMatch(s.sumo(['search', 'after']).out, /added after the backup/);
});

test('the newest copy wins, a copy made before a migration among them; a file named is taken as named; a copy that is not a database changes nothing', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the first fact']);
  const weekly = s.sumo(['backup']).out.match(/backed up to (\S+)/)[1];
  // Made later, as an upgrade makes one: the newest of the two.
  s.sumo(['add', 'fact', 'the second fact']);
  const premigration = join(s.home, 'memory.db.pre-v13.bak');
  s.sumo(['backup']);
  const second = readdirSync(join(s.home, 'backups')).sort().at(-1);
  copyFileSync(join(s.home, 'backups', second), premigration);
  rmSync(join(s.home, 'backups', second));
  const later = new Date(Date.now() + 60_000);
  utimesSync(premigration, later, later);

  // The database in place is fine, so putting a copy over it is said up front with --yes.
  const restored = s.sumo(['backup', 'restore', '--yes']);
  assert.match(restored.out, /^restored .*memory\.db\.pre-v13\.bak .* — 2 memories; the database it replaced \(2 memories\) is kept as .*memory\.db\.replaced-/m, 'the newest: the copy made before the migration');

  const named = s.sumo(['backup', 'restore', weekly, '--yes']);
  assert.equal(named.code, 0, named.err);
  assert.match(named.out, /— 1 memory/);

  const junk = join(s.root, 'junk.db');
  writeFileSync(junk, 'not sqlite');
  const before = statSync(join(s.home, 'memory.db')).mtimeMs;
  const refused = s.sumo(['backup', 'restore', junk, '--yes']);
  assert.equal(refused.code, 2);
  assert.match(refused.err, /junk\.db is not a usable database .* — nothing was changed/);
  assert.equal(statSync(join(s.home, 'memory.db')).mtimeMs, before, 'the database in place is untouched');
  assert.equal(existsSync(join(s.root, 'missing.db')), false);
  assert.match(s.sumo(['backup', 'restore', join(s.root, 'missing.db')]).err, /missing\.db does not exist/);
});

test('a database that is fine is not replaced unasked: with no terminal it takes --yes, and nothing moves without it', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the first fact']);
  s.sumo(['backup']);
  s.sumo(['add', 'fact', 'added after the backup']);
  const refused = s.sumo(['backup', 'restore']);
  assert.equal(refused.code, 2);
  assert.equal(refused.err, 'sumo: the database in place opens and holds 2 memories, and putting a backup over it drops what came after, so it asks first — run it in a terminal, or add --yes\n');
  assert.match(s.sumo(['search', 'after']).out, /added after the backup/);
  assert.deepEqual(readdirSync(s.home).filter((f) => f.startsWith('memory.db.')), [], 'nothing set aside');
});

test('at a terminal, restoring over a working database says what is lost and goes ahead only on a yes', { skip: !HAS_PTY && 'no python3 pty here' }, () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the first fact']);
  s.sumo(['backup']);
  s.sumo(['add', 'fact', 'added after the backup']);
  const declined = s.typed(['backup', 'restore'], 'n', ']');
  assert.match(declined.out, /memory\.db is fine, with 2 memories\. The copy is .*memory-.*\.db, backed up \d{4}-\d{2}-\d{2} \d{2}:\d{2}, with 1 memory\.\nPut the copy in its place, keeping the one there now aside\? \[y\/N\]/);
  assert.match(declined.out, /sumo: nothing was restored/);
  assert.equal(declined.code, 1);
  const done = s.typed(['backup', 'restore'], 'y', ']');
  assert.equal(done.code, 0, done.out);
  assert.match(done.out, /restored .* — 1 memory; the database it replaced \(2 memories\) is kept as .*memory\.db\.replaced-/);
  assert.doesNotMatch(s.sumo(['search', 'after']).out, /added after the backup/);
});
