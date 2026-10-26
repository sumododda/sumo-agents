import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { bunBuildArgs, resources } from '../scripts/build-bin.mjs';
import { COMPILED, ENTRY, REPO_ROOT, SELF } from '../src/paths.mjs';
import { bunArgs, bunDatabaseSync, DatabaseSync } from '../src/sqlite.mjs';

test('under Node the shim is node:sqlite itself', async () => {
  assert.equal(DatabaseSync, (await import('node:sqlite')).DatabaseSync);
});

test('a bare named value is bound under every prefix, since bun:sqlite matches the spelling', () => {
  assert.deepEqual(bunArgs([{ id: 1, $kept: 2 }], 2), [{ ':id': 1, $id: 1, '@id': 1, $kept: 2 }]);
});

test('positional values the statement has more placeholders for are NULL, as node:sqlite leaves them', () => {
  assert.deepEqual(bunArgs(['a'], 3), ['a', null, null]);
  assert.deepEqual(bunArgs(['a', 'b'], 2), ['a', 'b']);
  assert.deepEqual(bunArgs([], 0), []);
  // Bytes and NULL are values, not a set of names.
  const bytes = new Uint8Array([1, 2]);
  assert.deepEqual(bunArgs([bytes], 1), [bytes]);
  assert.deepEqual(bunArgs([null], 2), [null, null]);
});

/** Stands in for bun:sqlite's Database: what each call was handed, and bun's answers (null for no row). */
function fakeBun() {
  const calls = [];
  class Database {
    constructor(path, options) {
      calls.push(['open', path, options]);
    }
    exec(sql) {
      calls.push(['exec', sql]);
      return { changes: 0, lastInsertRowid: 0 };
    }
    prepare(sql) {
      return {
        paramsCount: (sql.match(/\?/g) ?? []).length,
        get: (...args) => (calls.push(['get', sql, args]), null),
        all: (...args) => (calls.push(['all', sql, args]), []),
        run: (...args) => (calls.push(['run', sql, args]), { changes: 3, lastInsertRowid: 7 }),
        iterate: (...args) => (calls.push(['iterate', sql, args]), [][Symbol.iterator]()),
      };
    }
    query(sql) {
      return { get: () => (calls.push(['query', sql]), { n: 1 }) };
    }
    close() {
      calls.push(['close']);
    }
  }
  return { Database, calls };
}

test('over bun:sqlite the calls sumo makes answer as DatabaseSync does', () => {
  // run() counts the statement's own rows, never the ones its triggers wrote: bun's count is replaced by changes().
  const { Database, calls } = fakeBun();
  const Shim = bunDatabaseSync(Database);
  const db = new Shim('/x/memory.db');
  assert.deepEqual(calls.splice(0), [
    ['open', '/x/memory.db', { readwrite: true, create: true }],
    ['exec', 'PRAGMA foreign_keys = ON'],
  ]);
  assert.equal(db.exec('PRAGMA busy_timeout = 3000'), undefined);
  assert.equal(db.prepare('SELECT * FROM t WHERE a = ? AND b = ?').get(1), undefined);
  assert.deepEqual(db.prepare('INSERT INTO t VALUES (?)').run('v'), { changes: 1, lastInsertRowid: 7 });
  assert.deepEqual(db.prepare('SELECT 1').all(), []);
  assert.deepEqual([...db.prepare('SELECT ?').iterate(2)], []);
  db.close();
  assert.deepEqual(calls, [
    ['exec', 'PRAGMA busy_timeout = 3000'],
    ['get', 'SELECT * FROM t WHERE a = ? AND b = ?', [1, null]],
    ['run', 'INSERT INTO t VALUES (?)', ['v']],
    ['query', 'SELECT changes() AS n'],
    ['all', 'SELECT 1', []],
    ['iterate', 'SELECT ?', [2]],
    ['close'],
  ]);

  new Shim('/x/backup.db', { readOnly: true });
  assert.deepEqual(calls.at(-2), ['open', '/x/backup.db', { readonly: true }]);
});

test('under Node the repo, the entry and the command that starts sumo again are as they were', () => {
  assert.equal(COMPILED, false);
  assert.equal(ENTRY, join(REPO_ROOT, 'bin', 'sumo.mjs'));
  assert.deepEqual(SELF, [process.execPath, '--disable-warning=ExperimentalWarning', ENTRY]);
});

test('the binary is laid out with every file the code reads from the repo', () => {
  const shipped = resources(REPO_ROOT).map((f) => f.replace(/\/$/, ''));
  const read = new Set();
  for (const file of readdirSync(join(REPO_ROOT, 'src')).filter((f) => f.endsWith('.mjs'))) {
    const code = readFileSync(join(REPO_ROOT, 'src', file), 'utf8');
    for (const [, first, rest] of code.matchAll(/join\(REPO_ROOT, '([^']+)'(?:, '([^']+)')?/g)) read.add(rest && first === 'src' ? `${first}/${rest}` : first);
  }
  // The entry is the binary itself; .git is looked for, never read: a checkout says its commit, the binary its package.json.
  read.delete('bin');
  read.delete('.git');
  assert.ok(read.size >= 6, `found ${[...read]}`);
  for (const f of read) assert.ok(shipped.includes(f), `${f} is read at run time but not laid out beside the binary`);
});

test('the build compiles for this machine, with system CAs, and takes no .env or bunfig from where it runs', () => {
  const args = bunBuildArgs('/out/sumo', { platform: 'darwin', arch: 'arm64' });
  assert.deepEqual(args.slice(0, 6), ['build', 'bin/sumo.mjs', '--compile', '--target=bun-darwin-arm64', '--outfile', '/out/sumo']);
  for (const flag of ['--compile-exec-argv=--use-system-ca', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig']) assert.ok(args.includes(flag), flag);
  assert.ok(!JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).dependencies.bun, 'bun builds; it is no dependency');
});

const bun = spawnSync('bun', ['--version'], { encoding: 'utf8' });
const noBun = bun.error || bun.status !== 0 ? 'bun is not installed' : false;

test('on Bun the shim gives what node:sqlite gives for the same statements', { skip: noBun }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-bun-'));
  try {
    const probe = join(dir, 'probe.mjs');
    writeFileSync(probe, `
      import { DatabaseSync } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src', 'sqlite.mjs')).href)};
      const file = process.argv[2];
      const out = {};
      const tryIt = (name, f) => { try { const v = f(); out[name] = v === undefined ? 'undefined' : v; } catch (e) { out[name] = 'threw: ' + e.message; } };
      const db = new DatabaseSync(file);
      tryIt('exec', () => db.exec(\`
        CREATE TABLE p (id INTEGER PRIMARY KEY, name TEXT NOT NULL) STRICT;
        CREATE TABLE c (id INTEGER PRIMARY KEY, p INTEGER REFERENCES p(id), body TEXT) STRICT;
        CREATE VIRTUAL TABLE c_fts USING fts5(body, content='c', content_rowid='id', tokenize='porter unicode61');
        CREATE TRIGGER c_ai AFTER INSERT ON c BEGIN INSERT INTO c_fts(rowid, body) VALUES (new.id, new.body); END;
      \`));
      tryIt('run', () => db.prepare('INSERT INTO p (name) VALUES (?)').run('one'));
      tryIt('fk', () => db.prepare('INSERT INTO c (p, body) VALUES (?, ?)').run(99, 'orphan'));
      tryIt('child', () => db.prepare('INSERT INTO c (p, body) VALUES (?, ?)').run(1, 'running dogs bark'));
      tryIt('missing', () => db.prepare('SELECT * FROM p WHERE id = ?').get(42));
      tryIt('fewer', () => ({ ...db.prepare('SELECT ? AS a, ? AS b').get(1) }));
      tryIt('named', () => ({ ...db.prepare('SELECT :a AS a, $b AS b, @c AS c').get({ a: 1, b: 2, c: 3 }) }));
      tryIt('all', () => db.prepare('SELECT id, name FROM p').all().map((r) => ({ ...r })));
      tryIt('iterate', () => [...db.prepare('SELECT id FROM c').iterate()].map((r) => r.id));
      tryIt('match', () => db.prepare('SELECT c.body, bm25(c_fts) < 0 AS ranked FROM c_fts JOIN c ON c.id = c_fts.rowid WHERE c_fts MATCH ?').all('run').map((r) => ({ ...r })));
      tryIt('tx', () => { db.exec('BEGIN IMMEDIATE'); db.prepare('INSERT INTO p (name) VALUES (?)').run('two'); db.exec('ROLLBACK'); return db.prepare('SELECT COUNT(*) AS n FROM p').get().n; });
      tryIt('unique', () => db.prepare('INSERT INTO p (id, name) VALUES (?, ?)').run(1, 'again'));
      db.close();
      const ro = new DatabaseSync(file, { readOnly: true });
      tryIt('readOnly', () => ro.prepare('INSERT INTO p (name) VALUES (?)').run('three'));
      ro.close();
      console.log(JSON.stringify(out));
    `);
    const run = (cmd, args, name) => {
      const r = spawnSync(cmd, [...args, probe, join(dir, `${name}.db`)], { encoding: 'utf8', cwd: dir });
      assert.equal(r.status, 0, r.stderr);
      return JSON.parse(r.stdout);
    };
    const onNode = run(process.execPath, ['--disable-warning=ExperimentalWarning'], 'node');
    const onBun = run('bun', [], 'bun');
    assert.deepEqual(onBun, onNode);
    assert.equal(onNode.fk, 'threw: FOREIGN KEY constraint failed');
    assert.deepEqual(onNode.fewer, { a: 1, b: null });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
