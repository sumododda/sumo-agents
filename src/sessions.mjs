import { redact } from './redact.mjs';

const TURN_MAX_CHARS = 4000;

/** Hooks can arrive in any order and a session can outlive a restart, so every write starts by making sure the row exists. */
export function ensureSession(db, { id, harness = 'claude', cwd = null, transcriptPath = null, now }) {
  db.prepare(
    `INSERT INTO sessions (id, harness, cwd, transcript_path, started_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cwd = COALESCE(excluded.cwd, cwd),
       transcript_path = COALESCE(excluded.transcript_path, transcript_path),
       ended_at = NULL`,
  ).run(id, harness, cwd, transcriptPath, now);
}

/**
 * Stores what the user typed, word for word — the ground truth every derived
 * memory points back to. Returns the turn id, or null when there was nothing
 * worth keeping (a slash command, a worker's brief, an empty line).
 */
export function recordTurn(db, { sessionId, text, now }) {
  const trimmed = text.trim();
  if (!trimmed || trimmed.startsWith('/') || trimmed.startsWith('JOB:')) return null;

  const cleaned = redact(trimmed);
  const kept = cleaned.text.length > TURN_MAX_CHARS ? `${cleaned.text.slice(0, TURN_MAX_CHARS)} …[cut]` : cleaned.text;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO user_turns (session_id, ts, text, redacted) VALUES (?, ?, ?, ?)')
    .run(sessionId, now, kept, cleaned.count > 0 ? 1 : 0);
  db.prepare('UPDATE sessions SET last_turn_at = ? WHERE id = ?').run(now, sessionId);
  return Number(lastInsertRowid);
}

export function endSession(db, id, now) {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ?').run(now, id);
}

export function pendingTurns(db, limit = 30) {
  return db.prepare('SELECT * FROM user_turns WHERE scribed = 0 ORDER BY id LIMIT ?').all(limit);
}

export function markScribed(db, turnIds) {
  if (turnIds.length === 0) return;
  db.prepare(`UPDATE user_turns SET scribed = 1 WHERE id IN (${turnIds.map(() => '?').join(', ')})`).run(...turnIds);
}

export function injectedSlugs(db, sessionId) {
  // The same table remembers which workflows and memories were shown; those keys ("workflow:m3", "recall:m7") contain a colon, which no project slug can.
  return db.prepare(`SELECT slug FROM session_injections WHERE session_id = ? AND slug NOT LIKE '%:%' ORDER BY ts`).all(sessionId).map((r) => r.slug);
}

export function markInjected(db, sessionId, slug, now) {
  db.prepare('INSERT OR REPLACE INTO session_injections (session_id, slug, ts) VALUES (?, ?, ?)').run(sessionId, slug, now);
}

/** After a compaction the cards are gone from context, so they have to be allowed back in. */
export function clearInjections(db, sessionId) {
  db.prepare('DELETE FROM session_injections WHERE session_id = ?').run(sessionId);
}

/** The project this session is about right now: the one whose card went in most recently. */
export function currentProject(db, sessionId) {
  return db.prepare(`SELECT slug FROM session_injections WHERE session_id = ? AND slug NOT LIKE '%:%' ORDER BY ts DESC LIMIT 1`).get(sessionId)?.slug ?? null;
}

export function addCheckpoint(db, { sessionId = null, project, done, next = null, now }) {
  db.prepare('INSERT INTO checkpoints (session_id, project, done, next_step, ts) VALUES (?, ?, ?, ?, ?)').run(sessionId, project, done, next, now);
  db.prepare('UPDATE projects SET last_touched_at = ? WHERE slug = ?').run(now, project);
}

/**
 * Sessions the consolidation pass has not read yet. A session counts as over
 * when it said so, or when it has been silent for two hours — a closed terminal
 * or a crash never sends the goodbye. `includeOpen` is for a pass the user asked
 * for by hand, which should not wait for anything.
 */
export function sessionsAwaitingDream(db, now, limit = 5, { includeOpen = false } = {}) {
  const cutoff = new Date(Date.parse(now) - 2 * 3_600_000).toISOString();
  return db
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE s.dream_state = 'pending'
         AND (? = 1 OR s.ended_at IS NOT NULL OR COALESCE(s.last_turn_at, s.started_at) < ?)
         AND EXISTS (SELECT 1 FROM user_turns t WHERE t.session_id = s.id)
       ORDER BY s.started_at LIMIT ?`,
    )
    .all(includeOpen ? 1 : 0, cutoff, limit);
}

/** What the user actually typed, searched word for word. */
export function searchTurns(db, match, limit = 8) {
  return db
    .prepare(
      `SELECT t.* FROM user_turns_fts JOIN user_turns t ON t.id = user_turns_fts.rowid
       WHERE user_turns_fts MATCH ? ORDER BY bm25(user_turns_fts), t.id DESC LIMIT ?`,
    )
    .all(match, limit);
}
