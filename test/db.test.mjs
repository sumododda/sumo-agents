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
    // A guess still waiting: guesses are no longer kept (schema 16), so it is rejected — the row stays.
    assert.equal(states['Prefer short answers'], 'rejected');
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

test('a database at schema 15, with rows in every state, becomes the layered memory: turns gain their journal columns, replies and the ledgers are there, what a model filed is marked derived, history starts from what the rows say, the old writer\'s guesses still waiting are rejected once while what the model\'s shell saved is held for the user, and the turns already read are not owed again', async () => {
  const { copyFileSync, existsSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  // An empty database made by the code as it stood at schema 15 (0.6.1), filled here with a row in every state.
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-v15-'));
  const file = join(dir, 'memory.db');
  copyFileSync(fileURLToPath(new URL('./fixtures/db-schema-15.sqlite', import.meta.url)), file);
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 15);
  const memory = raw.prepare(
    `INSERT INTO memories (id, type, scope, body, provenance, state, importance, written_by, source_turn, source_quote, valid_from, invalid_at, superseded_by, held_for, created_at)
     VALUES (?, ?, 'global', ?, ?, ?, 0.5, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const day = (n) => `2026-10-${String(n).padStart(2, '0')}T09:00:00.000Z`;
  raw.exec(`
    INSERT INTO sessions (id, harness, started_at, last_turn_at) VALUES ('read', 'claude', '${day(1)}', '${day(1)}'), ('half', 'claude', '${day(2)}', '${day(2)}'), ('unread', 'claude', '${day(3)}', '${day(3)}'), ('silent', 'claude', '${day(4)}', NULL);
    INSERT INTO user_turns (id, session_id, ts, text, scribed) VALUES
      (1, 'read', '${day(1)}', 'always squash-merge', 1), (2, 'read', '${day(1)}', 'and use pnpm', 1),
      (3, 'half', '${day(2)}', 'the tests need TZ=UTC', 1), (4, 'half', '${day(2)}', 'short answers please', 0),
      (5, 'unread', '${day(3)}', 'never push to main', 0), (6, 'half', '${day(2)}', 'and tabs, not spaces', 1);
  `);
  //      id  type          body                      provenance  state          writer        turn  quote                  from     invalid  by    held        created
  memory.run(1, 'preference', 'Use pnpm',               'stated',   'active',      'user',       null, null,                  day(1),  null,    null, null,       day(1));
  memory.run(2, 'preference', 'Always squash-merge',    'stated',   'active',      'scribe',     1,    'always squash-merge', day(1),  null,    null, null,       day(1));
  memory.run(3, 'preference', 'Short answers',          'stated',   'active',      'scribe',     null, null,                  day(5),  null,    null, null,       day(2));
  memory.run(4, 'preference', 'Likes tabs',             'inferred', 'unconfirmed', 'scribe',     null, null,                  day(2),  null,    null, null,       day(2));
  memory.run(5, 'gotcha',     'The API is rate limited','inferred', 'unconfirmed', 'scribe',     null, null,                  day(2),  null,    null, 'outside',  day(2));
  memory.run(6, 'preference', 'Use npm',                'stated',   'superseded',  'user',       null, null,                  day(1),  day(3),  1,    null,       day(1));
  memory.run(7, 'fact',       'Tests need TZ=UTC',      'stated',   'invalid',     'dream',      3,    'the tests need TZ=UTC', day(2), day(4), null, null,       day(2));
  memory.run(8, 'preference', 'Likes spaces',           'inferred', 'rejected',    'scribe',     null, null,                  day(2),  day(3),  null, null,       day(2));
  memory.run(9, 'gotcha',     'The build needs Node 22', 'observed', 'active',     'worker',     null, null,                  day(3),  null,    null, null,       day(3));
  memory.run(10, 'fact',      'Uses vitest',            'scanned',  'active',      'scanner',    null, null,                  day(3),  null,    null, null,       day(3));
  memory.run(11, 'preference', 'Prefers dark mode',     'inferred', 'unconfirmed', 'chat-model', null, null,                  day(3),  null,    null, null,       day(3));
  raw.exec(`INSERT INTO notices (kind, memory_a, note, created_at) VALUES ('conflict', 4, 'a notice about a guess', '${day(2)}')`);
  raw.close();

  const before = Date.now();
  const db = openDb(file);
  try {
    assert.equal(schemaVersion(db), 17);
    const columns = (table) => db.prepare(`PRAGMA table_info(${table})`).all().map((c) => `${c.name} ${c.type}`);
    assert.deepEqual(columns('user_turns').slice(-3), ['project TEXT', 'full_len INTEGER', 'sha TEXT']);
    assert.equal(columns('memories').at(-1), 'derived_by TEXT');
    assert.deepEqual(columns('replies'), ['id INTEGER', 'session_id TEXT', 'ts TEXT', 'text TEXT', 'project TEXT', 'full_len INTEGER', 'sha TEXT']);
    assert.deepEqual(columns('extractions'), ['id INTEGER', 'session_id TEXT', 'extractor_version TEXT', 'status TEXT', 'attempts INTEGER', 'first_turn INTEGER', 'last_turn INTEGER', 'ops_json TEXT', 'error TEXT', 'started_at TEXT', 'ended_at TEXT']);
    assert.deepEqual(columns('memory_events'), ['id INTEGER', 'ts TEXT', 'memory_id INTEGER', 'op TEXT', 'actor TEXT', 'run_id INTEGER', 'reason TEXT']);

    // The turns are as they were, the scribed mark kept; nothing is guessed for the new columns.
    assert.deepEqual(db.prepare('SELECT id, text, scribed, project, full_len, sha FROM user_turns ORDER BY id').all().map((t) => ({ ...t })), [
      { id: 1, text: 'always squash-merge', scribed: 1, project: null, full_len: null, sha: null },
      { id: 2, text: 'and use pnpm', scribed: 1, project: null, full_len: null, sha: null },
      { id: 3, text: 'the tests need TZ=UTC', scribed: 1, project: null, full_len: null, sha: null },
      { id: 4, text: 'short answers please', scribed: 0, project: null, full_len: null, sha: null },
      { id: 5, text: 'never push to main', scribed: 0, project: null, full_len: null, sha: null },
      { id: 6, text: 'and tabs, not spaces', scribed: 1, project: null, full_len: null, sha: null },
    ]);
    // A digest names one row: the same one twice is refused, on turns as on replies.
    db.prepare(`UPDATE user_turns SET sha = 'abc' WHERE id = 1`).run();
    assert.throws(() => db.prepare(`UPDATE user_turns SET sha = 'abc' WHERE id = 2`).run(), /UNIQUE constraint failed/);
    db.prepare(`UPDATE user_turns SET sha = NULL WHERE id = 1`).run();
    db.prepare(`INSERT INTO replies (session_id, ts, text, sha) VALUES ('read', '${day(1)}', 'Squash-merging from now on.', 'r1')`).run();
    assert.throws(() => db.prepare(`INSERT INTO replies (session_id, ts, text, sha) VALUES ('read', '${day(1)}', 'again', 'r1')`).run(), /UNIQUE constraint failed/);
    assert.throws(() => db.prepare(`INSERT INTO replies (session_id, ts, text) VALUES ('nobody', '${day(1)}', 'no such session')`).run(), /FOREIGN KEY constraint failed/);
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM replies_fts WHERE replies_fts MATCH 'squash'`).get().n, 1);
    assert.throws(() => db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, started_at) VALUES ('read', 'e1', 'done', '${day(1)}')`).run(), /CHECK constraint failed/);

    // Derived: what a model filed and the user never made their own. One they confirmed, or said themselves, is primary.
    const memories = Object.fromEntries(db.prepare('SELECT id, state, derived_by, invalid_at, held_for FROM memories').all().map((m) => [m.id, m]));
    assert.deepEqual(Object.fromEntries(Object.entries(memories).map(([id, m]) => [id, m.derived_by])), { 1: null, 2: 'v0', 3: null, 4: 'v0', 5: 'v0', 6: null, 7: 'v0', 8: 'v0', 9: 'v0', 10: null, 11: null });
    // The old writer's guess still waiting is rejected, its row kept; one held for an outside read waits for the user, and so
    // does what the model's shell saved and the user had not answered — held as the shell's from now on; the rest are as they were.
    assert.deepEqual(Object.fromEntries(Object.entries(memories).map(([id, m]) => [id, m.state])), { 1: 'active', 2: 'active', 3: 'active', 4: 'rejected', 5: 'unconfirmed', 6: 'superseded', 7: 'invalid', 8: 'rejected', 9: 'active', 10: 'active', 11: 'unconfirmed' });
    assert.deepEqual([memories[5].held_for, memories[11].held_for, memories[4].held_for], ['outside', 'shell', null]);
    assert.equal(memories[11].invalid_at, null);
    for (const id of [4]) assert.ok(Date.parse(memories[id].invalid_at) >= before - 1000 && /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(memories[id].invalid_at), `m${id} says when, as every other time is written`);
    assert.equal(memories[8].invalid_at, day(3), 'one rejected before keeps its own time');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM notices').get().n, 1, 'notices are left alone');

    // History starts from what the rows say.
    const events = db.prepare('SELECT ts, memory_id, op, actor, run_id, reason FROM memory_events ORDER BY id').all();
    const told = (id) => events.filter((e) => e.memory_id === id).map((e) => `${e.op} by ${e.actor} at ${e.ts.slice(0, 10)}: ${e.reason}`);
    assert.equal(events.filter((e) => e.op === 'added' && e.reason === 'backfilled').length, 11, 'every memory came once');
    assert.deepEqual(told(1), ['added by user at 2026-10-01: backfilled']);
    assert.deepEqual(told(3), ['added by scribe at 2026-10-02: backfilled', 'confirmed by user at 2026-10-05: backfilled']);
    assert.deepEqual(told(6), ['added by user at 2026-10-01: backfilled', 'superseded by unknown at 2026-10-03: backfilled']);
    assert.deepEqual(told(7), ['added by dream at 2026-10-02: backfilled', 'forgotten by unknown at 2026-10-04: backfilled']);
    assert.deepEqual(told(8), ['added by scribe at 2026-10-02: backfilled', 'rejected by unknown at 2026-10-03: backfilled']);
    assert.deepEqual(told(5), ['added by scribe at 2026-10-02: backfilled']);
    // Migration 16 rejected it with the guesses; 17 gave it back to the user to answer, and the history says both.
    assert.deepEqual(told(11).map((l) => l.replace(/ at \d{4}-\d\d-\d\d/, '')), ['added by chat-model: backfilled', 'rejected by migration: a guess still waiting when guesses stopped being kept', "held by migration: saved by the model's shell and never answered: it waits for the user again"]);
    for (const id of [4]) {
      const [, rejected] = events.filter((e) => e.memory_id === id);
      assert.deepEqual({ op: rejected.op, actor: rejected.actor, reason: rejected.reason, ts: rejected.ts }, { op: 'rejected', actor: 'migration', reason: 'a guess still waiting when guesses stopped being kept', ts: memories[id].invalid_at });
    }
    assert.equal(events.length, 11 + 1 + 3 + 2 + 1);
    assert.ok(events.every((e) => e.run_id === null));

    // A conversation the old writer read to its end is not owed again; of one half read, the turns it had read are not, and the rest are; one never read is.
    assert.deepEqual(db.prepare('SELECT session_id, extractor_version, status, attempts, first_turn, last_turn, ops_json, error, started_at, ended_at FROM extractions ORDER BY first_turn').all().map((x) => ({ ...x })), [
      { session_id: 'read', extractor_version: 'v0', status: 'ok', attempts: 1, first_turn: 1, last_turn: 2, ops_json: null, error: null, started_at: day(1), ended_at: day(1) },
      { session_id: 'half', extractor_version: 'v0', status: 'ok', attempts: 1, first_turn: 3, last_turn: 3, ops_json: null, error: null, started_at: day(2), ended_at: day(2) },
      { session_id: 'half', extractor_version: 'v0', status: 'ok', attempts: 1, first_turn: 6, last_turn: 6, ops_json: null, error: null, started_at: day(2), ended_at: day(2) },
    ]);
    const { turnsAwaitingExtraction } = await import('../src/sessions.mjs');
    assert.deepEqual(['read', 'half', 'unread'].map((id) => turnsAwaitingExtraction(db, id).map((t) => t.id)), [[], [4], [5]]);
  } finally {
    db.close();
  }
  assert.equal(existsSync(join(dir, 'memory.db.pre-v15.bak')), true, 'the database as it was, kept before the upgrade');

  // Opened again, nothing is done twice — nor when the step is run again over a database that has had it.
  openDb(file).close();
  const lowered = new DatabaseSync(file);
  lowered.exec('PRAGMA user_version = 15');
  lowered.close();
  const again = openDb(file);
  try {
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM memory_events').get().n, 18);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM extractions').get().n, 3);
    assert.deepEqual({ ...again.prepare('SELECT state, held_for FROM memories WHERE id = 11').get() }, { state: 'unconfirmed', held_for: 'shell' });
  } finally {
    again.close();
  }
});

test('a database that ran migration 16 as it first shipped is mended by 17: what the model\'s shell saved and 16 rejected waits for the user again, a pass\'s guess stays rejected, and the turns the old writer had read in a half-read conversation are not owed again', async () => {
  const { copyFileSync, mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { DatabaseSync } = await import('node:sqlite');
  const { turnsAwaitingExtraction } = await import('../src/sessions.mjs');
  // The schema-15 fixture with rows in it, opened once by the code as it stood when the owner's database was migrated
  // (the first migration 16): memories 2, 3, 5, 6 were waiting with no hold named, and all four were rejected.
  const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-v16-')), 'memory.db');
  copyFileSync(fileURLToPath(new URL('./fixtures/db-schema-16.sqlite', import.meta.url)), file);
  const raw = new DatabaseSync(file);
  assert.equal(raw.prepare('PRAGMA user_version').get().user_version, 16);
  assert.deepEqual(raw.prepare('SELECT id, state, held_for FROM memories ORDER BY id').all().map((m) => `m${m.id} ${m.state} ${m.held_for}`), ['m1 active null', 'm2 rejected null', 'm3 rejected null', 'm4 unconfirmed outside', 'm5 rejected null', 'm6 rejected null', 'm7 rejected null']);
  assert.deepEqual(raw.prepare('SELECT session_id, first_turn, last_turn FROM extractions').all().map((x) => ({ ...x })), [{ session_id: 'read', first_turn: 1, last_turn: 2 }]);
  // Since then: a pass of the new writer read the conversation 'reread' whole, and the user forgot nothing.
  raw.exec(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('reread', 'abc12345', 'ok', 1, 7, 8, '2026-11-17T09:00:00.000Z', '2026-11-17T09:00:00.000Z')`);
  raw.close();

  const db = openDb(file);
  try {
    assert.equal(schemaVersion(db), 17);
    const memories = db.prepare('SELECT id, type, state, held_for, invalid_at FROM memories ORDER BY id').all();
    assert.deepEqual(memories.map((m) => `m${m.id} ${m.state} ${m.held_for}`), [
      'm1 active null',
      'm2 rejected null', // the scribe's guess
      'm3 rejected null', // the tidy's
      'm4 unconfirmed outside',
      'm5 unconfirmed shell', // a memory the chat model saved from its shell
      'm6 unconfirmed shell', // a workflow it taught
      'm7 rejected null', // rejected before the migration, by the user: theirs to have refused
    ]);
    assert.deepEqual(memories.filter((m) => m.held_for === 'shell').map((m) => m.invalid_at), [null, null]);
    const told = (id) => db.prepare('SELECT op, actor, reason FROM memory_events WHERE memory_id = ? ORDER BY id').all(id).map((e) => `${e.op} by ${e.actor}`);
    assert.deepEqual(told(5), ['added by chat-model', 'rejected by migration', 'held by migration']);
    assert.deepEqual(told(2), ['added by scribe', 'rejected by migration']);
    assert.deepEqual(told(7), ['added by chat-model', 'rejected by unknown']);

    assert.deepEqual(db.prepare(`SELECT session_id, extractor_version, first_turn, last_turn FROM extractions ORDER BY first_turn`).all().map((x) => `${x.session_id} ${x.extractor_version} ${x.first_turn}-${x.last_turn}`), ['read v0 1-2', 'half v0 3-3', 'half v0 6-6', 'reread abc12345 7-8']);
    assert.deepEqual(['read', 'half', 'unread', 'reread'].map((id) => turnsAwaitingExtraction(db, id).map((t) => t.id)), [[], [4], [5], []]);
  } finally {
    db.close();
  }
  // Opened again, and with the step run again, nothing is done twice.
  const lowered = new DatabaseSync(file);
  lowered.exec('PRAGMA user_version = 16');
  lowered.close();
  const again = openDb(file);
  try {
    assert.equal(again.prepare(`SELECT COUNT(*) AS n FROM memory_events WHERE op = 'held'`).get().n, 2);
    assert.equal(again.prepare('SELECT COUNT(*) AS n FROM extractions').get().n, 4);
  } finally {
    again.close();
  }
});

test('a new database is made at the current schema, with nothing for migration 17 to mend', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      assert.equal(schemaVersion(db), 17);
      assert.deepEqual(['memories', 'memory_events', 'extractions'].map((table) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n), [0, 0, 0]);
    } finally {
      db.close();
    }
  });
});
