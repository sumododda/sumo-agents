import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ago } from './card.mjs';
import { heldBy } from './lock.mjs';
import { UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { redact } from './redact.mjs';
import { clip, head } from './text.mjs';
import { readBackwards } from './transcript.mjs';

const TURN_MAX_CHARS = 4000;

/**
 * Where a session starts costing quality. The numbers are absolute tokens, not
 * a share of the window: what degrades an answer is how much context is in
 * play, and a million-token window degrades at the same sizes a small one does.
 */
const BANDS = [
  { band: 'act', from: 150_000 },
  { band: 'watch', from: 80_000 },
];

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
  // A command's name may carry a dash or a plugin prefix (`/code-review`, `/codex:rescue`); a path (`/usr/bin`) still has a slash after its first word.
  if (!trimmed || /^\/[\w:-]+(\s|$)/.test(trimmed) || trimmed.startsWith('JOB:')) return null;

  const cleaned = redact(trimmed);
  const kept = cleaned.text.length > TURN_MAX_CHARS ? `${head(cleaned.text, TURN_MAX_CHARS)} …[cut]` : cleaned.text;
  const { lastInsertRowid } = db
    .prepare('INSERT INTO user_turns (session_id, ts, text, redacted) VALUES (?, ?, ?, ?)')
    .run(sessionId, now, kept, cleaned.count > 0 ? 1 : 0);
  db.prepare("UPDATE sessions SET last_turn_at = ?, dream_state = 'pending' WHERE id = ?").run(now, sessionId);
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

/**
 * How much context this session is carrying, from the last assistant turn the
 * transcript recorded — everything the model was billed for reading, cache
 * included. A transcript can be several megabytes, so a line is string-matched
 * before it is parsed. Anything unreadable is null: a nudge that cannot be
 * computed is simply not given, never an error in the middle of a turn.
 */
export function contextUse(transcriptPath) {
  if (!transcriptPath) return null;
  // Read from the end, on every prompt: the size is in the last reply, and the file can be hundreds of megabytes.
  return readBackwards(transcriptPath, (lines) => {
    for (let i = lines.length - 1; i >= 0; i--) {
      if (!lines[i].includes('"type":"assistant"')) continue;
      let entry;
      try {
        entry = JSON.parse(lines[i]);
      } catch {
        return null; // A transcript that cannot be parsed answers nothing at all.
      }
      // An error Claude Code writes in the reply's place (a rate limit, a failed sign-in) bills nothing; the size is in the reply before it.
      if (entry.isApiErrorMessage || entry.message?.model === '<synthetic>') continue;
      const { message } = entry;
      if (!message?.usage) return null;
      const { input_tokens: input = 0, cache_read_input_tokens: read = 0, cache_creation_input_tokens: written = 0 } = message.usage;
      return { tokens: input + read + written, model: message.model ?? null };
    }
    return undefined;
  });
}

/** 'watch', 'act', or null while the session is still small. */
export function contextBand(tokens) {
  return BANDS.find((b) => tokens >= b.from)?.band ?? null;
}

const inK = (tokens) => `${Math.round(tokens / 1000)}k`;

/**
 * What the session is told when it crosses a band. One line, ending with the
 * hint, so a `/compact` can be pasted exactly as it stands.
 */
export function contextNudge(band, tokens, focus) {
  const hint = `hint: focus on ${focus}; keep decisions and open job ids in a note; drop tool output and file contents.`;
  if (band === 'act') return `context: ${inK(tokens)} tokens — start fresh now: note where you are (sumo job note; the end of the turn records "Left off"), then tell the user to type /new. ${hint}`;
  return `context: ${inK(tokens)} tokens — quality drops from here. Finish the piece in hand, then tell the user to type /new: the memory block brings the thread back. ${hint}`;
}

/**
 * A task just ended: the cheapest moment there is to start a fresh session, if
 * this one has grown enough to be worth it. Null when the newest session stored
 * no transcript path — how big it is cannot be known, and nothing is guessed.
 */
export function taskEndedNudge(db) {
  const path = db.prepare(`SELECT transcript_path FROM sessions WHERE id NOT LIKE 'job:%' ORDER BY COALESCE(last_turn_at, started_at) DESC LIMIT 1`).get()?.transcript_path ?? null;
  const use = contextUse(path);
  if (!use || !contextBand(use.tokens)) return null;
  return `this session is at ${inK(use.tokens)} tokens and the task just ended — a good moment for /new; the memory block brings the thread back.`;
}

/**
 * A chat session saved to be picked up again: the whole conversation as the model was sent it, written after every
 * turn beside the session's log, so a closed terminal or a crash loses one turn at most. The API is stateless, so
 * resuming is sending the same messages again; what it costs is one cold cache write.
 */

const sessionsDir = () => join(paths().logs, 'sessions');
export const stateFile = (id) => join(sessionsDir(), `${id}.state.json`);
export const lockFile = (id) => join(sessionsDir(), `${id}.lock`);
/** A session id as it is shown and typed: the first eight characters, which no two sessions share in practice. */
export const shortId = (id) => id.slice(0, 8);
/** How long a saved session is kept to be resumed. */
const STATE_KEEP_MS = 30 * 24 * 3_600_000;
/** How much of a state file holds its summary: what comes before the messages. */
const SUMMARY_BYTES = 4096;
const NO_PICTURE = '[a picture was here; pictures are not kept when a session is saved]';
const TITLE_MAX = 60;

const redactValues = (value) => {
  if (typeof value === 'string') return redact(value).text;
  if (Array.isArray(value)) return value.map(redactValues);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, redactValues(v)]));
  return value;
};

/**
 * One block as it is kept: a picture becomes a line saying there was one; the words — the user's, the model's, a
 * tool's input and what it printed — are redacted, since the user's were sent raw and no secret lands in a file. Ids,
 * types, names and a thinking block's signature are left exactly as they are: the API matches on them.
 */
function keepBlock(block) {
  if (block.type === 'image') return { type: 'text', text: NO_PICTURE };
  const { cache_control: _dropped, ...kept } = block;
  if (typeof kept.text === 'string') kept.text = redact(kept.text).text;
  if (kept.type === 'tool_result') kept.content = typeof kept.content === 'string' ? redact(kept.content).text : Array.isArray(kept.content) ? kept.content.map(keepBlock) : kept.content;
  if (kept.type === 'tool_use') kept.input = redactValues(kept.input);
  return kept;
}

/** The conversation as it is kept on disk: no pictures, no secrets, no cache markers (they are placed again when it is sent). */
export function keepable(messages) {
  return messages.map((m) => ({ role: m.role, content: typeof m.content === 'string' ? redact(m.content).text : m.content.map(keepBlock) }));
}

/**
 * The conversation without the model's thinking blocks: what a resumed session sends first. A block's signature is bound
 * to the exact history it was made in — the system prompt, the tools, every message before it — and a saved session has
 * had its secrets redacted and its pictures taken out, while AGENTS.md and the MCP servers may have changed since; on the
 * current models such a block is refused, not ignored. The text and the calls stay; a reply that was only thinking goes.
 */
export function withoutThinking(messages) {
  return messages
    .map((m) => (m.role === 'assistant' && Array.isArray(m.content) ? { ...m, content: m.content.filter((b) => b.type !== 'thinking' && b.type !== 'redacted_thinking') } : m))
    .filter((m) => !(Array.isArray(m.content) && m.content.length === 0));
}

/** Writes the session's state whole, then moves it into place: a crash while writing leaves the last good one. */
export function saveState({ id, messages, model, effort, routed, cwd, contextTokens, now }) {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const file = stateFile(id);
  // The summary first, so a listing can read it without the messages behind it; the route's reason last, since it is prose of any length.
  const state = { version: 1, id, savedAt: now, contextTokens, model, effort, cwd, messages: keepable(messages), routed };
  writeFileSync(`${file}.tmp`, JSON.stringify(state), { mode: 0o600 });
  renameSync(`${file}.tmp`, file);
  return file;
}

/** A saved session, whole; null when there is none by this id. One that cannot be read or is of another shape is said. */
export function loadState(id) {
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile(id), 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return null;
    throw new UsageError(`the saved session ${shortId(id)} cannot be read: ${cause.message}`);
  }
  if (state?.version !== 1 || !Array.isArray(state.messages)) throw new UsageError(`the saved session ${shortId(id)} is not one this version can resume`);
  return state;
}

/** What a state file says about itself, read from its head: everything before the messages. Null when it cannot be read. */
function summaryOf(file) {
  try {
    const fd = openSync(file, 'r');
    let text;
    try {
      const buffer = Buffer.alloc(SUMMARY_BYTES);
      text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, SUMMARY_BYTES, 0));
    } finally {
      closeSync(fd);
    }
    const cut = text.indexOf(',"messages":');
    return JSON.parse(cut === -1 ? readFileSync(file, 'utf8') : `${text.slice(0, cut)}}`);
  } catch {
    return null;
  }
}

/**
 * The sessions that can be picked up, newest first — every one still on disk, the heavy ones marked. `except` is the
 * session asking, which cannot resume itself.
 */
export function savedSessions(db, { now, except = null } = {}) {
  let names;
  try {
    names = readdirSync(sessionsDir());
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
  const firstTurn = db.prepare('SELECT text FROM user_turns WHERE session_id = ? ORDER BY id LIMIT 1');
  const turns = db.prepare('SELECT COUNT(*) AS n FROM user_turns WHERE session_id = ?');
  const row = db.prepare('SELECT last_turn_at FROM sessions WHERE id = ?');
  return names
    .filter((name) => name.endsWith('.state.json'))
    .map((name) => name.slice(0, -'.state.json'.length))
    .filter((id) => id !== except)
    .map((id) => {
      const summary = summaryOf(stateFile(id));
      if (!summary?.savedAt) return null;
      const tokens = summary.contextTokens ?? 0;
      return {
        id,
        savedAt: summary.savedAt,
        lastTurnAt: row.get(id)?.last_turn_at ?? summary.savedAt,
        cwd: summary.cwd ?? null,
        project: currentProject(db, id),
        title: firstTurn.get(id)?.text ?? '',
        turns: turns.get(id).n,
        tokens,
        heavy: contextBand(tokens) === 'act',
        openElsewhere: heldBy(lockFile(id)),
      };
    })
    .filter(Boolean)
    .sort((a, b) => (a.savedAt < b.savedAt ? 1 : a.savedAt > b.savedAt ? -1 : 0));
}

/** The saved session `ref` names: `last` for the newest, otherwise the one id that starts with it. Anything else is said. */
export function findSaved(db, ref, options) {
  const all = savedSessions(db, options);
  if (ref === 'last') {
    if (all.length === 0) throw new UsageError('no saved session to resume');
    return all[0];
  }
  const hits = all.filter((s) => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new UsageError(`no saved session starts with "${ref}"${all.length > 0 ? ` — one of: ${all.map((s) => shortId(s.id)).join(', ')}` : ''}`);
  throw new UsageError(`"${ref}" could be ${hits.map((s) => shortId(s.id)).join(' or ')} — give more of the id`);
}

/** How a saved session is described, without its id: when, what about, how big, and what stands in the way of picking it up. */
export function describeSaved(s, now) {
  const title = clip(s.title, TITLE_MAX);
  const parts = [ago(s.lastTurnAt, now), s.project ?? 'no project', title ? `“${title}”` : '(nothing said)', `${s.turns} turn${s.turns === 1 ? '' : 's'}`, `${inK(s.tokens)} tokens`];
  if (s.heavy) parts.push('heavy: the gauge said to start fresh');
  if (s.openElsewhere) parts.push(`open in another terminal (process ${s.openElsewhere})`);
  return parts.join(' · ');
}

export const sessionLine = (s, now) => `${shortId(s.id)} · ${describeSaved(s, now)}`;

/**
 * Saved sessions older than the keep are let go — a save a crash cut short with them — and so is a lock a session
 * died holding; the logs beside them stay, the dream pass reads those. Returns how many went.
 */
export function pruneStates(now, keepMs = STATE_KEEP_MS) {
  let names;
  try {
    names = readdirSync(sessionsDir());
  } catch (cause) {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  }
  let gone = 0;
  for (const name of names) {
    const file = join(sessionsDir(), name);
    try {
      if (name.endsWith('.lock')) {
        if (heldBy(file)) continue;
      } else if (!/\.state\.json(?:\.tmp)?$/.test(name) || Date.parse(now) - statSync(file).mtimeMs <= keepMs) {
        continue;
      }
      unlinkSync(file);
      gone++;
    } catch (cause) {
      if (cause.code !== 'ENOENT') throw cause;
    }
  }
  return gone;
}
