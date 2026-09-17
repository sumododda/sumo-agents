import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { sandbox } from './helpers.mjs';

const mode = (file) => statSync(file).mode & 0o777;

test('setup creates a private home, a private database and a launcher that runs', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);

  const run = s.mem(['setup', '--bin-dir', binDir]);
  assert.equal(run.code, 0, run.err);

  assert.equal(mode(s.home), 0o700);
  assert.equal(mode(join(s.home, 'memory.db')), 0o600);
  assert.equal(readlinkSync(join(binDir, 'mem')), join(s.home, 'bin', 'mem'));

  // The launcher must work with nothing helpful on PATH — that is how a hook calls it.
  const viaLauncher = spawnSync(join(binDir, 'mem'), ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(viaLauncher.status, 0, viaLauncher.stderr);
  assert.match(viaLauncher.stdout, /^mem — /);
  assert.equal(viaLauncher.stderr, '', 'the experimental-SQLite warning must not leak into hook output');
});

test('setup can be run again without changing anything', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.mem(['setup', '--bin-dir', binDir]);
  s.mem(['add', 'preference', 'be concise']);

  const again = s.mem(['setup', '--bin-dir', binDir]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already linked/);
  assert.match(s.mem(['search', 'concise']).out, /be concise/);
});

test('setup never overwrites a different command called mem', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'mem'), '#!/bin/sh\necho someone else\n', { mode: 0o755 });

  const run = s.mem(['setup', '--bin-dir', binDir]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /skipped/);
  assert.equal(lstatSync(join(binDir, 'mem')).isSymbolicLink(), false);
});

test('doctor passes after setup and fails once the launcher is broken', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.mem(['setup', '--bin-dir', binDir]);
  const path = { PATH: `${binDir}:${process.env.PATH}` };

  const healthy = s.mem(['doctor'], { extraEnv: path });
  assert.equal(healthy.code, 0, healthy.out);
  assert.doesNotMatch(healthy.out, /FAIL/);
  assert.match(healthy.out, /^ok {4}code [0-9a-f]{7,} · \d{4}-\d{2}-\d{2} · /, 'the first line says which commit is running, so an update can be checked at a glance');

  writeFileSync(join(s.home, 'bin', 'mem'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const broken = s.mem(['doctor'], { extraEnv: path });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /FAIL {2}launcher/);
});

test('the schema is migrated once and recorded', () => {
  const s = sandbox();
  s.mem(['config']);
  s.mem(['config']);
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
});

test('config reads defaults, stores changes and rejects names it does not know', () => {
  const s = sandbox();
  assert.match(s.mem(['config', 'scribe.model']).out, /scribe\.model = haiku/);
  assert.match(s.mem(['config', 'scribe.model', 'sonnet']).out, /scribe\.model = sonnet/);
  assert.match(s.mem(['config']).out, /scribe\.model = sonnet/);

  const typo = s.mem(['config', 'scribe.modle', 'sonnet']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /unknown setting/);
});
