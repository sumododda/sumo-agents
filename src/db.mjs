import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { homeProblem, paths } from './paths.mjs';
import { DatabaseSync } from './sqlite.mjs';

/**
 * One entry per schema version, applied in order and never edited once shipped.
 * Each phase of the plan adds its own tables here rather than the first one
 * guessing at all of them. An entry is SQL, or a function of the database for a
 * step plain SQL cannot make re-runnable (see addColumnsIfMissing).
 */
const MIGRATIONS = [
  `
  CREATE TABLE meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  ) STRICT;

  CREATE TABLE projects (
    slug            TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    path            TEXT NOT NULL UNIQUE,
    remote          TEXT,
    status          TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
    created_at      TEXT NOT NULL,
    last_touched_at TEXT,
    scanned_at      TEXT
  ) STRICT;

  CREATE TABLE project_aliases (
    alias TEXT PRIMARY KEY,
    slug  TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE
  ) STRICT;

  -- AUTOINCREMENT so a purged id is never handed out again: "m12" must not
  -- come to mean a different memory than the one someone remembers.
  CREATE TABLE memories (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    type           TEXT NOT NULL CHECK (type IN ('preference', 'fact', 'decision', 'gotcha', 'procedure')),
    scope          TEXT NOT NULL,
    title          TEXT,
    cue            TEXT,
    body           TEXT NOT NULL,
    topic          TEXT,
    provenance     TEXT NOT NULL CHECK (provenance IN ('stated', 'observed', 'scanned', 'inferred')),
    state          TEXT NOT NULL CHECK (state IN ('active', 'unconfirmed', 'superseded', 'invalid', 'rejected')),
    pinned         INTEGER NOT NULL DEFAULT 0,
    importance     REAL NOT NULL,
    scan_key       TEXT,
    written_by     TEXT NOT NULL,
    source_session TEXT,
    source_turn    INTEGER,
    source_quote   TEXT,
    valid_from     TEXT NOT NULL,
    invalid_at     TEXT,
    superseded_by  INTEGER REFERENCES memories(id) ON DELETE SET NULL,
    created_at     TEXT NOT NULL,
    hits           INTEGER NOT NULL DEFAULT 0,
    last_hit_at    TEXT
  ) STRICT;

  CREATE INDEX memories_scope_state ON memories(scope, state);
  CREATE UNIQUE INDEX memories_active_scan_key ON memories(scope, scan_key)
    WHERE scan_key IS NOT NULL AND state = 'active';

  CREATE VIRTUAL TABLE memories_fts USING fts5(
    title, cue, body, topic,
    content='memories', content_rowid='id', tokenize='porter unicode61'
  );

  CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, title, cue, body, topic)
    VALUES (new.id, new.title, new.cue, new.body, new.topic);
  END;

  CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic)
    VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic);
  END;

  -- Only the indexed columns: a search bumps hits on every row it returns, and
  -- that must not rewrite the index.
  CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, cue, body, topic ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic)
    VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic);
    INSERT INTO memories_fts(rowid, title, cue, body, topic)
    VALUES (new.id, new.title, new.cue, new.body, new.topic);
  END;

  CREATE TABLE search_misses (
    ts    TEXT NOT NULL,
    query TEXT NOT NULL,
    scope TEXT NOT NULL
  ) STRICT;
  `,

  // 2 — sessions: what was said, what was shown, what got done, what the cheap model cost.
  `
  CREATE TABLE sessions (
    id                TEXT PRIMARY KEY,
    harness           TEXT NOT NULL,
    cwd               TEXT,
    transcript_path   TEXT,
    started_at        TEXT NOT NULL,
    last_turn_at      TEXT,
    ended_at          TEXT,
    dream_state       TEXT NOT NULL DEFAULT 'pending' CHECK (dream_state IN ('pending', 'done'))
  ) STRICT;

  CREATE TABLE user_turns (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    ts         TEXT NOT NULL,
    text       TEXT NOT NULL,
    redacted   INTEGER NOT NULL DEFAULT 0,
    scribed    INTEGER NOT NULL DEFAULT 0
  ) STRICT;

  CREATE INDEX user_turns_pending ON user_turns(scribed, session_id);

  CREATE VIRTUAL TABLE user_turns_fts USING fts5(
    text, content='user_turns', content_rowid='id', tokenize='porter unicode61'
  );
  CREATE TRIGGER user_turns_fts_insert AFTER INSERT ON user_turns BEGIN
    INSERT INTO user_turns_fts(rowid, text) VALUES (new.id, new.text);
  END;
  CREATE TRIGGER user_turns_fts_delete AFTER DELETE ON user_turns BEGIN
    INSERT INTO user_turns_fts(user_turns_fts, rowid, text) VALUES ('delete', old.id, old.text);
  END;

  CREATE TABLE session_injections (
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    slug       TEXT NOT NULL,
    ts         TEXT NOT NULL,
    PRIMARY KEY (session_id, slug)
  ) STRICT;

  CREATE TABLE checkpoints (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT,
    project    TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    done       TEXT NOT NULL,
    next_step  TEXT,
    ts         TEXT NOT NULL
  ) STRICT;

  CREATE INDEX checkpoints_project_ts ON checkpoints(project, ts);

  CREATE TABLE model_runs (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    ts            TEXT NOT NULL,
    kind          TEXT NOT NULL,
    model         TEXT NOT NULL,
    input_tokens  INTEGER,
    output_tokens INTEGER,
    cost_usd      REAL,
    ok            INTEGER NOT NULL,
    note          TEXT
  ) STRICT;

  -- Things only the user can settle, surfaced at session start until they stop being true.
  CREATE TABLE notices (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    kind       TEXT NOT NULL,
    memory_a   INTEGER REFERENCES memories(id) ON DELETE CASCADE,
    memory_b   INTEGER REFERENCES memories(id) ON DELETE CASCADE,
    note       TEXT NOT NULL,
    created_at TEXT NOT NULL
  ) STRICT;
  `,

  // 3 — delegated jobs. The files live in ~/.sumo-agents/jobs/<id>/; this is the index.
  `
  CREATE TABLE jobs (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    agent      TEXT NOT NULL CHECK (agent IN ('scout', 'worker')),
    status     TEXT NOT NULL CHECK (status IN ('running', 'needs_input', 'done', 'failed', 'abandoned')),
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  `,

  // 4 — a workflow may name, as a regular expression, the shell commands it must come before.
  `
  ALTER TABLE memories ADD COLUMN gate TEXT;
  `,

  // 5 — a third kind of sub-agent: the reviewer. SQLite cannot alter a CHECK, so the table is rebuilt; ids are kept.
  `
  CREATE TABLE jobs_next (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    project    TEXT NOT NULL REFERENCES projects(slug) ON DELETE CASCADE,
    title      TEXT NOT NULL,
    agent      TEXT NOT NULL CHECK (agent IN ('scout', 'worker', 'reviewer')),
    status     TEXT NOT NULL CHECK (status IN ('running', 'needs_input', 'done', 'failed', 'abandoned')),
    session_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  ) STRICT;
  INSERT INTO jobs_next (id, project, title, agent, status, session_id, created_at, updated_at)
    SELECT id, project, title, agent, status, session_id, created_at, updated_at FROM jobs;
  -- A job's files live in a directory named by its id, so an id must never be handed out twice:
  -- carry the counter over, not just the rows that happen to be left.
  DELETE FROM sqlite_sequence WHERE name = 'jobs_next';
  INSERT INTO sqlite_sequence (name, seq) SELECT 'jobs_next', seq FROM sqlite_sequence WHERE name = 'jobs';
  DROP TABLE jobs;
  ALTER TABLE jobs_next RENAME TO jobs;
  `,

  // 6 — a job's chosen model and effort, why, whether it is a retry, and — once reviewed — how many
  // Important findings it drew. The agent CHECK is unchanged; these are all nullable, so a job
  // created before this migration keeps printing nothing for its route.
  `
  ALTER TABLE jobs ADD COLUMN model TEXT;
  ALTER TABLE jobs ADD COLUMN effort TEXT;
  ALTER TABLE jobs ADD COLUMN route_reason TEXT;
  ALTER TABLE jobs ADD COLUMN important INTEGER;
  ALTER TABLE jobs ADD COLUMN retry_of INTEGER REFERENCES jobs(id) ON DELETE SET NULL;
  `,

  // 7 — the ledger splits cached input from fresh and names the job and session a call belonged to.
  // All nullable: a row from before this migration, or a backend that reports no cache, reads as NULL.
  // job_id has no REFERENCES on purpose: the ledger outlives the jobs it counts.
  (db) => addColumnsIfMissing(db, 'model_runs', [
    'cache_read_tokens INTEGER',
    'cache_creation_tokens INTEGER',
    'job_id INTEGER',
    'session_id TEXT',
  ]),

  // 8 — a memory may carry search terms beside the user's words: what it is about, in words it does not use itself.
  // They are searched, never shown as the user's words. A full-text table takes no new column, so the index is made
  // again with them, and filled from every memory already stored.
  (db) => {
    addColumnsIfMissing(db, 'memories', ['keys TEXT']);
    db.exec(`
      DROP TRIGGER IF EXISTS memories_fts_insert;
      DROP TRIGGER IF EXISTS memories_fts_delete;
      DROP TRIGGER IF EXISTS memories_fts_update;
      DROP TABLE IF EXISTS memories_fts;

      CREATE VIRTUAL TABLE memories_fts USING fts5(
        title, cue, body, topic, keys,
        content='memories', content_rowid='id', tokenize='porter unicode61'
      );
      INSERT INTO memories_fts(memories_fts) VALUES ('rebuild');

      CREATE TRIGGER memories_fts_insert AFTER INSERT ON memories BEGIN
        INSERT INTO memories_fts(rowid, title, cue, body, topic, keys)
        VALUES (new.id, new.title, new.cue, new.body, new.topic, new.keys);
      END;

      CREATE TRIGGER memories_fts_delete AFTER DELETE ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic, keys)
        VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic, old.keys);
      END;

      CREATE TRIGGER memories_fts_update AFTER UPDATE OF title, cue, body, topic, keys ON memories BEGIN
        INSERT INTO memories_fts(memories_fts, rowid, title, cue, body, topic, keys)
        VALUES ('delete', old.id, old.title, old.cue, old.body, old.topic, old.keys);
        INSERT INTO memories_fts(rowid, title, cue, body, topic, keys)
        VALUES (new.id, new.title, new.cue, new.body, new.topic, new.keys);
      END;
    `);
  },
  // 9 — whether the router called a job's work risky (security, credentials, money, migrations, concurrency): 1 or 0, so such
  // work is reviewed once it is done. Nullable: a job routed before this migration was never asked.
  (db) => addColumnsIfMissing(db, 'jobs', ['risky INTEGER']),
  // 10 — why a request wrote its context to the cache again when the cache should have held it: gap, prefix, cleared, model
  // or unknown (cost.mjs). Nullable: a request that found its context, a conversation's first, or a row from before this.
  (db) => addColumnsIfMissing(db, 'model_runs', ['cache_cause TEXT']),
  // 11 — two memories the tidy pass has had judged (dream.mjs): same, replaces, conflict or unrelated, so a pair is put to
  // the model once. Either memory going takes the pair with it.
  `
  CREATE TABLE IF NOT EXISTS memory_pairs (
    a         INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    b         INTEGER NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
    label     TEXT NOT NULL,
    judged_at TEXT NOT NULL,
    PRIMARY KEY (a, b)
  ) STRICT;
  `,
  // 12 — the writer and the tidier are one memory pass with one setting, memory.model. The writer's choice is kept: it is
  // the one that runs after every turn (the user who turned it off still has it off). The tidier's alone is not taken —
  // it would move every turn's filing onto the model chosen for a weekly tidy, a paid one perhaps. The old keys go.
  `
  INSERT OR IGNORE INTO meta (key, value) SELECT 'config.memory.model', value FROM meta WHERE key = 'config.scribe.model';
  DELETE FROM meta WHERE key IN ('config.scribe.model', 'config.dream.model');
  `,
  // 13 — what a conversation read past the machine (a web search or fetch, an MCP server), one tool name a line, each
  // once: what the memory pass files from its replies is held for the user (sessions.mjs, apply.mjs). On the session's
  // own row, not in meta: the pass runs in a process of its own and reads it with the session's turns. Nullable: a
  // conversation that read nothing, or one from before this.
  (db) => addColumnsIfMissing(db, 'sessions', ['outside_read TEXT']),
  // 14 — why a memory is held for the user beyond being a guess: 'outside' when what it says came from a conversation that
  // read the web or an MCP server. Only the user confirms such a one: the model that read the page may not vouch for it.
  (db) => addColumnsIfMissing(db, 'memories', ['held_for TEXT']),
  // 15 — fewer settings. chat.plain and chat.motion are one, chat.screen: plain wins, then a motion turned off is still.
  // model.source, model.repo and model.file are one, model.url, the address they made (the defaults of the time fill in a
  // part not set) — the same file is fetched. prime.budget, scratch.days, jobs.escalate and guides.auto are fixed now.
  `
  INSERT OR IGNORE INTO meta (key, value)
    SELECT 'config.chat.screen', CASE WHEN EXISTS (SELECT 1 FROM meta WHERE key = 'config.chat.plain' AND value = 'on') THEN 'plain' ELSE 'still' END
    WHERE EXISTS (SELECT 1 FROM meta WHERE (key = 'config.chat.plain' AND value = 'on') OR (key = 'config.chat.motion' AND value = 'off'));
  INSERT OR IGNORE INTO meta (key, value)
    SELECT 'config.model.url',
      COALESCE((SELECT value FROM meta WHERE key = 'config.model.source'), 'https://huggingface.co') || '/' ||
      COALESCE((SELECT value FROM meta WHERE key = 'config.model.repo'), 'Qwen/Qwen3-4B-GGUF') || '/resolve/main/' ||
      COALESCE((SELECT value FROM meta WHERE key = 'config.model.file'), 'Qwen3-4B-Q4_K_M.gguf')
    WHERE EXISTS (SELECT 1 FROM meta WHERE key IN ('config.model.source', 'config.model.repo', 'config.model.file'));
  DELETE FROM meta WHERE key IN ('config.chat.plain', 'config.chat.motion', 'config.model.source', 'config.model.repo', 'config.model.file',
    'config.prime.budget', 'config.scratch.days', 'config.jobs.escalate', 'config.guides.auto');
  `,
];

/**
 * ALTER TABLE … ADD COLUMN for each definition whose column the table does not have yet, so a
 * migration that only adds columns can be re-run against any shape of the table — a half-applied
 * upgrade, or a database whose user_version was lowered without undoing what came after it.
 * Every ADD COLUMN migration goes through here.
 */
function addColumnsIfMissing(db, table, defs) {
  const have = new Set(db.prepare(`PRAGMA table_info(${table})`).all().map((c) => c.name));
  for (const def of defs) {
    if (!have.has(def.split(/\s+/)[0])) db.exec(`ALTER TABLE ${table} ADD COLUMN ${def}`);
  }
}

export const SCHEMA_VERSION = MIGRATIONS.length;

/** How long one process waits for another to let go of the file before it gives up. */
const BUSY_MS = 3000;

/**
 * Every `sumo` command is a process of its own on this file, and several run at once: the chat, the scribe it
 * wakes, a job in its tab. The wait is set before anything else, so the first statement queues like the rest.
 * secure_delete zeroes what is deleted, so an erased memory does not linger in the file's free space.
 */
export function openDb(file = paths().db) {
  try {
    return opened(file);
  } catch (cause) {
    // A home that is a file, or one sumo may not write, is said as that, with what to do — not as Node's or SQLite's words.
    const said = homeProblem(cause, dirname(file));
    if (said === null) throw cause;
    throw new Error(said, { cause });
  }
}

function opened(file) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  // SQLite gives the -wal and -shm files the database's own mode: the file is made private before SQLite first opens
  // it, or they are born readable by everyone (umask 022) and keep the latest writes there.
  if (!existsSync(file)) closeSync(openSync(file, 'a', 0o600));
  for (const side of [file, `${file}-wal`, `${file}-shm`]) {
    try {
      if (statSync(side).mode & 0o077) chmodSync(side, 0o600);
    } catch {
      // Not there yet: made with the database's mode when it is.
    }
  }
  const db = new DatabaseSync(file);
  db.exec(`PRAGMA busy_timeout = ${BUSY_MS}; PRAGMA foreign_keys = ON; PRAGMA secure_delete = ON;`);
  useWal(db);
  const found = schemaVersion(db);
  // A newer sumo's tables are not this one's to write: its migrations would be taken for undone, or its rows misread.
  if (found > MIGRATIONS.length) {
    db.close();
    throw new Error(`the database is from a newer sumo (schema ${found}; this one knows ${MIGRATIONS.length}) — upgrade: npm update -g sumo-agents`);
  }
  if (found > 0 && found < MIGRATIONS.length) copyAside(db, file, found);
  migrate(db);
  return db;
}

/** How many copies made before a migration are kept: the newest. */
const PRE_MIGRATION_KEPT = 3;
/** How long an empty copy may be another process's copy still being made, before it is taken for one that died half-way. */
const HALF_MADE_MS = 60_000;

/**
 * The database as it is, copied beside it before it is migrated — `<db>.pre-v<N>.bak`, N the version it was at — so an
 * upgrade that goes wrong can be undone by hand. VACUUM INTO writes a consistent copy while others read; it writes into
 * a file made empty and private first, so the copy is never readable by others for a moment. A copy already there was
 * made by a process that got here first. One that cannot be made is let go: the migrations only add.
 */
function copyAside(db, file, version) {
  const copy = `${file}.pre-v${version}.bak`;
  // An empty copy left a while ago is one a process died making: it is made again. A fresh empty one is another
  // process's at work.
  try {
    const left = statSync(copy);
    if (left.size === 0 && Date.now() - left.mtimeMs > HALF_MADE_MS) rmSync(copy, { force: true });
  } catch {
    // Not there: the usual case.
  }
  try {
    closeSync(openSync(copy, 'wx', 0o600));
  } catch {
    return;
  }
  try {
    db.exec(`VACUUM INTO '${copy.replaceAll("'", "''")}'`);
  } catch {
    rmSync(copy, { force: true });
    return;
  }
  const mine = `${basename(file)}.pre-v`;
  const copies = readdirSync(dirname(file))
    .filter((name) => name.startsWith(mine) && name.endsWith('.bak'))
    .map((name) => join(dirname(file), name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const old of copies.slice(PRE_MIGRATION_KEPT)) rmSync(old, { force: true });
}

/**
 * The switch to WAL needs the file to itself, and SQLite does not wait for that the way it waits for a lock:
 * of two processes opening a new database at the same moment, one is told "locked" at once. It asks again.
 */
function useWal(db) {
  const giveUp = Date.now() + BUSY_MS;
  for (;;) {
    try {
      return db.exec('PRAGMA journal_mode = WAL');
    } catch (cause) {
      if (!/database is locked/.test(cause.message) || Date.now() > giveUp) throw cause;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
    }
  }
}

export function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

/** The version is read again inside each step: a process that waited for another to migrate finds the step already taken. */
function migrate(db) {
  while (schemaVersion(db) < MIGRATIONS.length) {
    tx(db, () => {
      const v = schemaVersion(db);
      if (v >= MIGRATIONS.length) return;
      if (typeof MIGRATIONS[v] === 'function') MIGRATIONS[v](db);
      else db.exec(MIGRATIONS[v]);
      db.exec(`PRAGMA user_version = ${v + 1}`);
    });
  }
}

const inTransaction = new WeakSet();

/**
 * IMMEDIATE so two sessions writing at once queue on busy_timeout instead of
 * failing mid-way. Re-entrant: a call made inside a transaction joins it, and
 * the outermost call alone commits or rolls back.
 */
export function tx(db, fn) {
  if (inTransaction.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTransaction.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (cause) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // SQLite had already rolled back by itself (a full disk, an I/O error): the reason worth reporting is the first one.
    }
    throw cause;
  } finally {
    inTransaction.delete(db);
  }
}

export function getMeta(db, key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

export function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value',
  ).run(key, String(value));
}
