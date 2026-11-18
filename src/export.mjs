import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { getMeta, setMeta } from './db.mjs';
import { eraseRow, eraseSaid, UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { DatabaseSync } from './sqlite.mjs';

const KEEP_BACKUPS = 5;
export const SECTIONS = [
  ['preference', 'Preferences'],
  ['decision', 'Decisions'],
  ['fact', 'Facts'],
  ['gotcha', 'Gotchas'],
  ['procedure', 'Workflows'],
];

/**
 * The view for a person: grouped, titled, dated. Never loaded by an agent —
 * agents get the one-line form in render.mjs.
 */
export function exportMarkdown(db, now = new Date().toISOString()) {
  const projects = new Map(db.prepare('SELECT slug, name, path FROM projects').all().map((p) => [`project:${p.slug}`, p]));
  const rows = db.prepare(`SELECT * FROM memories WHERE state IN ('active', 'unconfirmed') ORDER BY id`).all();
  const machine = getMeta(db, 'machine');
  const out = [`# Memory${machine ? ` — ${machine}` : ''} — ${now.slice(0, 10)}`, ''];

  const scopes = ['global', ...[...new Set(rows.map((r) => r.scope))].filter((s) => s !== 'global').sort()];
  for (const scope of scopes) {
    const active = rows.filter((r) => r.scope === scope && r.state === 'active');
    if (active.length === 0) continue;
    const project = projects.get(scope);
    out.push(scope === 'global' ? '## Global' : `## Project: ${project?.name ?? scope} (${project?.path ?? 'path unknown'})`, '');
    for (const [type, heading] of SECTIONS) {
      const group = active.filter((r) => r.type === type);
      if (group.length === 0) continue;
      out.push(`### ${heading}`, '');
      for (const m of group) out.push(...entry(m));
      out.push('');
    }
  }

  const unconfirmed = rows.filter((r) => r.state === 'unconfirmed');
  if (unconfirmed.length > 0) {
    out.push('## Waiting for your yes/no', '');
    for (const m of unconfirmed) out.push(...entry(m));
    out.push('');
  }
  if (rows.length === 0) out.push('Nothing remembered yet.', '');
  return out.join('\n');
}

function entry(m) {
  const meta = `m${m.id} · ${m.provenance} · ${m.valid_from.slice(0, 10)}${m.pinned ? ' · pinned' : ''}`;
  if (m.type !== 'procedure') return [`- ${m.body} _(${meta})_`];
  const body = m.body.split('\n').map((l) => `  ${l}`);
  return [`- **${m.title}**${m.cue ? ` — when: "${m.cue}"` : ''}${m.gate ? ` — gates: \`${m.gate}\`` : ''} _(${meta})_`, ...body];
}

/** Every row of every table the user's knowledge lives in, for moving or inspecting the store. */
export function exportJson(db) {
  const all = (table) => db.prepare(`SELECT * FROM ${table}`).all();
  return {
    exported_at: new Date().toISOString(),
    machine: getMeta(db, 'machine'),
    projects: all('projects'),
    project_aliases: all('project_aliases'),
    memories: all('memories'),
  };
}

/**
 * A consistent snapshot while other sessions keep writing. The data has no git
 * history by design, so this is the only undo there is.
 */
export function backup(db, now = new Date()) {
  const dir = paths().backups;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `memory-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  chmodSync(file, 0o600);
  setMeta(db, 'last_backup', now.toISOString());
  setMeta(db, 'backup.failed', '');

  const old = readdirSync(dir)
    .filter((f) => /^memory-.*\.db$/.test(f))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f), { force: true });
  return { file, pruned: old.length };
}

/**
 * The copies a damaged database can be put back from, newest first: the weekly backups, and the copies made before a
 * migration (`memory.db.pre-v<N>.bak`). An empty one — a copy a process died making — is no copy.
 */
function backupsOnHand() {
  const { backups, db } = paths();
  const found = [];
  const listed = (dir, keep) => {
    try {
      for (const name of readdirSync(dir)) if (keep(name)) found.push(join(dir, name));
    } catch {
      // Not there yet: nothing kept there.
    }
  };
  listed(backups, (name) => /^memory-.*\.db$/.test(name));
  listed(dirname(db), (name) => name.startsWith(`${basename(db)}.pre-v`) && name.endsWith('.bak'));
  return found
    .map((file) => ({ file, stat: statSync(file) }))
    .filter(({ stat }) => stat.size > 0)
    .map(({ file, stat }) => ({ file, at: stat.mtime }))
    .sort((a, b) => b.at - a.at);
}

const minute = (date) => date.toISOString().slice(0, 16).replace('T', ' ');

/** What to say when the database cannot be opened: the newest copy, and the command that puts it back. */
export function restoreHint() {
  const [newest] = backupsOnHand();
  return newest ? `the newest backup is ${newest.file} (${minute(newest.at)}): sumo backup restore puts it back, keeping this one aside` : `no backup was found to put back (${paths().backups} is empty)`;
}

/** Whether an error is SQLite saying the file is not a database it can read. */
export const damaged = (cause) => /file is not a database|database disk image is malformed|SQLITE_(?:CORRUPT|NOTADB)/i.test(String(cause?.message ?? cause));

const memoriesIn = (n) => `${n} memor${n === 1 ? 'y' : 'ies'}`;

/**
 * The copy a restore would put back — `file`, or the newest on hand — checked before anything moves: a copy SQLite cannot
 * read changes nothing. `{ from, at, memories }`.
 */
export function restoreCandidate(file = null) {
  const chosen = file ? resolve(file) : backupsOnHand()[0]?.file;
  if (!chosen) throw new UsageError(`no backup to put back: none in ${paths().backups}, and no copy made before a migration`);
  if (!existsSync(chosen)) throw new UsageError(`${chosen} does not exist`);
  try {
    const copy = new DatabaseSync(chosen, { readOnly: true });
    try {
      const checked = Object.values(copy.prepare('PRAGMA quick_check').get())[0];
      if (checked !== 'ok') throw new Error(checked);
      return { from: chosen, at: statSync(chosen).mtime, memories: copy.prepare('SELECT COUNT(*) AS n FROM memories').get().n };
    } finally {
      copy.close();
    }
  } catch (cause) {
    throw new UsageError(`${chosen} is not a usable database (${cause.message}) — nothing was changed`);
  }
}

/** The database in place, when it opens and checks out: `{ memories }`. Null when it is missing or damaged — nothing to lose by replacing it. */
export function liveDatabase() {
  const { db } = paths();
  if (!existsSync(db)) return null;
  try {
    const live = new DatabaseSync(db, { readOnly: true });
    try {
      if (Object.values(live.prepare('PRAGMA quick_check').get())[0] !== 'ok') return null;
      return { memories: live.prepare('SELECT COUNT(*) AS n FROM memories').get().n };
    } finally {
      live.close();
    }
  } catch {
    return null;
  }
}

/** What is asked before a copy goes over a database that is fine: both sides, counted, then a short question. */
export const restoreQuestion = (copy, live) =>
  `memory.db is fine, with ${memoriesIn(live.memories)}. The copy is ${copy.from}, backed up ${minute(copy.at)}, with ${memoriesIn(copy.memories)}.\nPut the copy in its place, keeping the one there now aside? [y/N] `;

/**
 * Puts a checked copy back. The database it replaces is kept aside with its -wal and -shm — as `memory.db.damaged-<time>`,
 * or `memory.db.replaced-<time>` when it was fine (`live`): a restore never deletes. The copy is the user's only, at 0600.
 * Returns the lines the user reads.
 */
export function restoreLines(copy, live, now = new Date()) {
  const { db } = paths();
  const aside = `${db}.${live ? 'replaced' : 'damaged'}-${now.toISOString().replace(/[:.]/g, '-')}`;
  for (const side of ['', '-wal', '-shm']) if (existsSync(`${db}${side}`)) renameSync(`${db}${side}`, `${aside}${side}`);
  copyFileSync(copy.from, db);
  chmodSync(db, 0o600);
  const kept = !existsSync(aside) ? '' : live ? `; the database it replaced (${memoriesIn(live.memories)}) is kept as ${aside}` : `; the damaged database is kept as ${aside}`;
  return [`restored ${copy.from} (backed up ${minute(copy.at)}) — ${memoriesIn(copy.memories)}${kept}`];
}

/**
 * Every copy this machine keeps of the database — the weekly backups, and what was set aside beside it before a
 * migration or by a restore — put through `erase(db, has)`, which says how much it took out: a copy it changed is
 * rewritten whole, indexes and pages, so nothing of what went is left in it. All of it or none: a copy that cannot be
 * cleaned whole is left as it was, and named. `{ cleaned, failed }`.
 */
function cleanBackups(erase) {
  const { backups, db: live } = paths();
  const within = (dir, keep) => (existsSync(dir) ? readdirSync(dir).filter(keep).map((f) => join(dir, f)) : []);
  const aside = (f) => f.startsWith(`${basename(live)}.`) && (/\.pre-v\d+\.bak$/.test(f) || /\.(?:damaged|replaced)-[^/]*$/.test(f)) && !/-(?:wal|shm)$/.test(f);
  const files = [...within(backups, (f) => /^memory-.*\.db$/.test(f)), ...within(dirname(live), aside)];
  const failed = [];
  let cleaned = 0;
  for (const file of files) {
    let db = null;
    try {
      db = new DatabaseSync(file);
      db.exec('PRAGMA secure_delete = ON;');
      const has = (name) => db.prepare('SELECT 1 FROM sqlite_master WHERE name = ?').get(name) !== undefined;
      let changed = 0;
      db.exec('BEGIN');
      try {
        changed = erase(db, has);
        if (changed > 0) {
          // A deleted row's words stay in the full-text index's pages until it is rebuilt; VACUUM keeps those pages.
          db.exec(`INSERT INTO memories_fts(memories_fts) VALUES ('rebuild'); INSERT INTO user_turns_fts(user_turns_fts) VALUES ('rebuild');`);
          // A copy from before replies were kept has none to clean.
          if (has('replies_fts')) db.exec(`INSERT INTO replies_fts(replies_fts) VALUES ('rebuild');`);
        }
        db.exec('COMMIT');
      } catch (cause) {
        db.exec('ROLLBACK');
        throw cause;
      }
      if (changed > 0) {
        db.exec('VACUUM');
        cleaned++;
      }
    } catch {
      failed.push(file);
    } finally {
      db?.close();
    }
  }
  return { cleaned, failed };
}

/**
 * A purge reaches the backups too: "erased, not recoverable" must hold for every copy this machine keeps. Each backup
 * loses the memory, every turn and reply that says it whole and what its passes proposed — by the one rule the
 * database itself is held to (`eraseSaid` in memory.mjs). A copy from before the memory was filed may hold the
 * sentence without the memory: it is cleaned all the same. Returns how many were cleaned, and the ones that could
 * not be — said, never hidden.
 */
export function purgeFromBackups({ id, body, created_at: createdAt, source_turn: sourceTurn, source_session: sourceSession = null, source_quote: sourceQuote = null }) {
  return cleanBackups((db, has) => {
    // The same memory, not just the same number: a backup from after a restore may hold another one under this id.
    const row = db.prepare('SELECT source_turn FROM memories WHERE id = ? AND body = ? AND created_at = ?').get(id, body, createdAt);
    // The passes that filed it, while its history still names them; a copy from before histories were kept has none.
    const runs = row && has('memory_events') ? db.prepare('SELECT run_id FROM memory_events WHERE memory_id = ? AND run_id IS NOT NULL').all(id).map((e) => e.run_id) : [];
    if (row) db.prepare('DELETE FROM memories WHERE id = ?').run(id);
    // The turn it cites goes by its number only where the memory is this one: in another copy that number may be another turn.
    const erased = eraseSaid(db, { body, source_quote: sourceQuote, source_turn: row ? sourceTurn : null, source_session: sourceSession }, { runs });
    return (row ? 1 : 0) + erased.turns.length + erased.replies.length + erased.ops;
  });
}

/** One turn or reply purged (`sumo forget --purge t12`) goes from every copy that holds it, the same way. */
export const purgeRowFromBackups = (entry) => cleanBackups((db) => (eraseRow(db, entry) ? 1 : 0));
