// The database file: one home, and every `sumo` command a process of its own on it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { openDb, SCHEMA_VERSION, schemaVersion, tx } from '../src/db.mjs';
import { CONFIG_DEFAULTS, modelFileOfUrl } from '../src/setup.mjs';
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

test('a database is copied aside before it is migrated, privately, and only the last three copies are kept', async () => {
  const { mkdtempSync, readdirSync, statSync, utimesSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-migrate-'));
  const file = join(dir, 'memory.db');
  openDb(file).close();
  // Older copies from earlier upgrades, oldest first.
  for (const [i, v] of [1, 2, 3, 4].entries()) {
    writeFileSync(join(dir, `memory.db.pre-v${v}.bak`), 'old copy');
    utimesSync(join(dir, `memory.db.pre-v${v}.bak`), new Date(2026, 0, 1 + i), new Date(2026, 0, 1 + i));
  }
  // One step behind, as a database is after the code has moved on.
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
  raw.close();
  const db = openDb(file);
  assert.equal(schemaVersion(db), SCHEMA_VERSION);
  db.close();

  const copy = join(dir, `memory.db.pre-v${SCHEMA_VERSION - 1}.bak`);
  assert.equal(statSync(copy).mode & 0o777, 0o600);
  const kept = new DatabaseSync(copy);
  assert.equal(kept.prepare('PRAGMA user_version').get().user_version, SCHEMA_VERSION - 1, 'the copy is the database as it was before the step');
  kept.close();
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.bak')).sort(), [`memory.db.pre-v${SCHEMA_VERSION - 1}.bak`, 'memory.db.pre-v3.bak', 'memory.db.pre-v4.bak'].sort());

  // Opening it again with nothing to migrate copies nothing; a new database has nothing to copy.
  openDb(file).close();
  openDb(join(dir, 'new.db')).close();
  assert.equal(readdirSync(dir).filter((n) => n.endsWith('.bak')).length, 3);

  // An empty copy left by a process that died making it is made again; a fresh empty one is another process's at work.
  const half = join(dir, 'half.db');
  openDb(half).close();
  const behind = () => {
    const raw2 = new DatabaseSync(half);
    raw2.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    raw2.close();
  };
  const halfCopy = join(dir, `half.db.pre-v${SCHEMA_VERSION - 1}.bak`);
  behind();
  writeFileSync(halfCopy, '');
  openDb(half).close();
  assert.equal(statSync(halfCopy).size, 0, 'a fresh empty copy is left to the process making it');
  behind();
  utimesSync(halfCopy, new Date(2026, 0, 1), new Date(2026, 0, 1));
  openDb(half).close();
  assert.ok(statSync(halfCopy).size > 0, 'an old empty one is made again');
});

test('a database from a newer sumo is refused, not written over by code that does not know its tables', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-newer-')), 'memory.db');
  openDb(file).close();
  const raw = new DatabaseSync(file);
  raw.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 2}`);
  raw.close();
  assert.throws(() => openDb(file), new RegExp(`the database is from a newer sumo \\(schema ${SCHEMA_VERSION + 2}; this one knows ${SCHEMA_VERSION}\\) — upgrade: npm update -g sumo-agents`));
});

test('the writer and the tidier become one memory pass with one setting: the writer\'s choice is kept, a tidier-only one is not taken', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const upgraded = (settings) => {
    const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-one-pass-')), 'memory.db');
    openDb(file).close();
    const raw = new DatabaseSync(file);
    raw.exec(`PRAGMA user_version = 11; DELETE FROM meta WHERE key LIKE 'config.%model'`);
    for (const [key, value] of Object.entries(settings)) raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`config.${key}`, value);
    raw.close();
    const db = openDb(file);
    try {
      return Object.fromEntries(db.prepare(`SELECT key, value FROM meta WHERE key IN ('config.memory.model', 'config.scribe.model', 'config.dream.model')`).all().map((r) => [r.key, r.value]));
    } finally {
      db.close();
    }
  };
  assert.deepEqual(upgraded({ 'scribe.model': 'off', 'dream.model': 'haiku' }), { 'config.memory.model': 'off' }, 'turned off stays off');
  assert.deepEqual(upgraded({ 'scribe.model': 'haiku', 'dream.model': 'local' }), { 'config.memory.model': 'haiku' });
  assert.deepEqual(upgraded({ 'dream.model': 'haiku' }), {}, 'a tidier on haiku does not put every turn\'s filing there: the default holds');
  assert.deepEqual(upgraded({}), {});
  assert.deepEqual(upgraded({ 'memory.model': 'sonnet', 'scribe.model': 'off' }), { 'config.memory.model': 'sonnet' }, 'a memory.model already set is kept');
});

test('settings made one carry over in every combination: plain wins the screen, then still; the model\'s address is made of its parts; the fixed ones go', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const upgraded = (settings) => {
    const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-fewer-settings-')), 'memory.db');
    openDb(file).close();
    const raw = new DatabaseSync(file);
    raw.exec('PRAGMA user_version = 14');
    for (const [key, value] of Object.entries(settings)) raw.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run(`config.${key}`, value);
    raw.close();
    const db = openDb(file);
    try {
      return Object.fromEntries(db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'config.%'`).all().map((r) => [`${r.key.slice('config.'.length)}`, r.value]));
    } finally {
      db.close();
    }
  };
  const some = (pairs) => Object.fromEntries(pairs.filter(([, value]) => value !== undefined));

  for (const plain of [undefined, 'on', 'off']) {
    for (const motion of [undefined, 'on', 'off']) {
      const screen = plain === 'on' ? 'plain' : motion === 'off' ? 'still' : undefined;
      assert.deepEqual(upgraded(some([['chat.plain', plain], ['chat.motion', motion]])), some([['chat.screen', screen]]), `chat.plain ${plain}, chat.motion ${motion}`);
    }
  }

  const source = 'https://user:token@jfrog.example/artifactory/api/huggingfaceml/hf';
  const repo = 'unsloth/Qwen3-4B-GGUF';
  const file = 'Qwen3-4B-Q8_0.gguf';
  for (const s of [undefined, source]) {
    for (const r of [undefined, repo]) {
      for (const f of [undefined, file]) {
        const old = some([['model.source', s], ['model.repo', r], ['model.file', f]]);
        const url = Object.keys(old).length === 0 ? undefined : `${s ?? 'https://huggingface.co'}/${r ?? 'Qwen/Qwen3-4B-GGUF'}/resolve/main/${f ?? 'Qwen3-4B-Q4_K_M.gguf'}`;
        const after = upgraded(old);
        assert.deepEqual(after, some([['model.url', url]]), JSON.stringify(old));
        assert.equal(modelFileOfUrl(after['model.url']), f ?? modelFileOfUrl(), 'the same file is kept and fetched');
      }
    }
  }
  assert.equal(upgraded({ 'model.source': 'https://huggingface.co' })['model.url'], CONFIG_DEFAULTS['model.url'], 'the old defaults make the new default');

  assert.deepEqual(
    upgraded({ 'prime.budget': '1200', 'scratch.days': '30', 'jobs.escalate': 'off', 'guides.auto': 'off', 'chat.effort': 'high', 'jobs.review': 'all' }),
    { 'chat.effort': 'high', 'jobs.review': 'all' },
    'the settings that are fixed now are gone; the rest are as they were',
  );
});

test('a database made by 0.4.0, with real rows in it, upgrades whole: every row is there after, the schema is current, the old settings carried over, and a copy of it as it was is kept', async () => {
  const { copyFileSync, existsSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  // Made by the 0.4.0 code through its own API (schema 9): a project with an alias, a session with turns, a job, ledger
  // rows, memories in every state, and the two settings the memory pass took over.
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-v040-'));
  const file = join(dir, 'memory.db');
  copyFileSync(fileURLToPath(new URL('./fixtures/db-0.4.0.sqlite', import.meta.url)), file);
  const db = openDb(file);
  try {
    assert.equal(schemaVersion(db), SCHEMA_VERSION);
    const count = (table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
    assert.deepEqual(
      { memories: count('memories'), turns: count('user_turns'), sessions: count('sessions'), projects: count('projects'), aliases: count('project_aliases'), jobs: count('jobs'), runs: count('model_runs') },
      { memories: 8, turns: 2, sessions: 1, projects: 1, aliases: 1, jobs: 1, runs: 3 },
    );
    const states = Object.fromEntries(db.prepare('SELECT body, state FROM memories').all().map((r) => [r.body, r.state]));
    assert.equal(states['Use bun in shop'], 'active');
    assert.equal(states['Use pnpm in shop, never npm'], 'superseded');
    assert.equal(states['The shop tests need TZ=UTC'], 'invalid');
    assert.equal(states['Prefer short answers'], 'unconfirmed');
    // Still found by what it says: the search index came through the upgrade.
    assert.deepEqual(db.prepare(`SELECT m.body FROM memories_fts f JOIN memories m ON m.id = f.rowid WHERE memories_fts MATCH 'bun'`).all().map((r) => r.body), ['Use bun in shop']);
    assert.equal(db.prepare(`SELECT title FROM jobs`).get().title, 'Fix the cart total');
    assert.equal(db.prepare(`SELECT alias FROM project_aliases`).get().alias, 'webshop');
    // The writer's setting is the memory pass's now; the tidier's alone was not taken; others are as they were.
    const meta = Object.fromEntries(db.prepare(`SELECT key, value FROM meta WHERE key LIKE 'config.%'`).all().map((r) => [r.key, r.value]));
    assert.deepEqual(meta, { 'config.memory.model': 'off', 'config.chat.effort': 'high' });
    // What later versions added is there, empty for old rows.
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM memories WHERE held_for IS NOT NULL').get().n, 0);
    assert.equal(count('memory_pairs'), 0);
  } finally {
    db.close();
  }
  const copy = join(dir, 'memory.db.pre-v9.bak');
  assert.equal(existsSync(copy), true, 'the database as it was, kept before the upgrade');
  const kept = new DatabaseSync(copy, { readOnly: true });
  try {
    assert.equal(kept.prepare('PRAGMA user_version').get().user_version, 9);
    assert.equal(kept.prepare('SELECT COUNT(*) AS n FROM memories').get().n, 8);
  } finally {
    kept.close();
  }
});
