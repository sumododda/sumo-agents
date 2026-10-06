// The database file: one home, and every `sumo` command a process of its own on it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, tx } from '../src/db.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const DB = fileURLToPath(new URL('../src/db.mjs', import.meta.url));

/** What every command does — open, write, leave — as a process of its own. Resolves to null, or to why it failed. */
function opens(home) {
  const script = `const { openDb, setMeta } = await import(${JSON.stringify(DB)}); const db = openDb(); setMeta(db, 'pid' + process.pid, 'x'); db.close();`;
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, SUMO_AGENTS_HOME: home }, stdio: ['ignore', 'ignore', 'pipe'] });
    let err = '';
    child.stderr.on('data', (chunk) => (err += chunk));
    child.on('close', (code) => resolve(code === 0 ? null : (/^\w*Error.*$/m.exec(err)?.[0] ?? `exit ${code}`)));
  });
}

const together = async (home, n = 6) => (await Promise.all(Array.from({ length: n }, () => opens(home)))).filter(Boolean);

test('processes that open the database at the same moment all get in: on a file nobody has opened before, and on one already there', async () => {
  for (let round = 0; round < 4; round++) {
    const home = freshHome();
    assert.deepEqual(await together(home), [], 'a new database: one of them creates it, the others wait');
    assert.deepEqual(await together(home), [], 'a database already there');
  }
});

test('a transaction SQLite rolled back by itself fails with the reason it failed, not with the rollback that found nothing to undo', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      db.exec(`CREATE TABLE once (k TEXT PRIMARY KEY); INSERT INTO once VALUES ('a');`);
      // OR ROLLBACK stands in for what a full disk or an I/O error does: the transaction is gone before the error is thrown.
      assert.throws(() => tx(db, () => db.prepare(`INSERT OR ROLLBACK INTO once VALUES ('a')`).run()), /UNIQUE constraint failed/);
      assert.equal(tx(db, () => db.prepare('SELECT count(*) AS n FROM once').get().n), 1, 'and the next transaction starts clean');
    } finally {
      db.close();
    }
  });
});

test('the database and the files beside it are private from the first open, whatever the umask', async () => {
  const { mkdtempSync, statSync, existsSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-mode-'));
  const file = join(dir, 'memory.db');
  const was = process.umask(0o022);
  try {
    const db = openDb(file);
    db.exec(`CREATE TABLE IF NOT EXISTS t (x); INSERT INTO t VALUES (1);`);
    for (const side of [file, `${file}-wal`, `${file}-shm`]) {
      if (existsSync(side)) assert.equal(statSync(side).mode & 0o777, 0o600, side);
    }
    db.close();
  } finally {
    process.umask(was);
  }
});
