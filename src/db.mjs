import { chmodSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { paths } from './paths.mjs';

/**
 * One entry per schema version, applied in order and never edited once shipped.
 * Each phase of the plan adds its own tables here rather than the first one
 * guessing at all of them.
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
];

export const SCHEMA_VERSION = MIGRATIONS.length;

export function openDb(file = paths().db) {
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  const fresh = !existsSync(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000; PRAGMA foreign_keys = ON;');
  migrate(db);
  if (fresh) chmodSync(file, 0o600);
  return db;
}

export function schemaVersion(db) {
  return db.prepare('PRAGMA user_version').get().user_version;
}

function migrate(db) {
  for (let v = schemaVersion(db); v < MIGRATIONS.length; v++) {
    tx(db, () => {
      db.exec(MIGRATIONS[v]);
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
    db.exec('ROLLBACK');
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
