import { createHash } from 'node:crypto';
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ago } from './card.mjs';
import { heldBy } from './lock.mjs';
import { Refusal, UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { redact } from './redact.mjs';
import { cjkTerms, clip, containing, ftsAllQuery, ftsQuery, head, stem, termsHeld, words } from './text.mjs';
import { readBackwards } from './transcript.mjs';

/**
 * How much of one turn or reply the journal keeps: whole, in practice. The journal is what memory is rebuilt from and
 * what search falls back on, and at 4,000 characters the pasted error or the long explanation a later question was
 * about had been cut away. Past this it is a pasted file, and its head is kept.
 */
const JOURNAL_MAX_CHARS = 64_000;
const CUT = ' …[cut]';
/** A conversation nobody has spoken in for this long is over, as far as reading it for memory goes. */
export const FINISHED_AFTER_MS = 30 * 60_000;

/**
 * Where a session starts costing quality. The numbers are absolute tokens, not
 * a share of the window: what degrades an answer is how much context is in
 * play, and a million-token window degrades at the same sizes a small one does.
 * It is said early because every request pays for all of it again: a chat averages
 * some 65k tokens a request, and it is most of what is spent.
 */
const BANDS = [
  { band: 'act', from: 150_000 },
  { band: 'watch', from: 60_000 },
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

/** A slash command, a worker's brief and an empty line are not something the user said. A command's name may carry a dash or a plugin prefix (`/code-review`, `/codex:rescue`); a path (`/usr/bin`) still has a slash after its first word. */
const notSaid = (trimmed) => !trimmed || /^\/[\w:-]+(\s|$)/.test(trimmed) || trimmed.startsWith('JOB:');

/**
 * Words as the journal keeps them: secrets out first, then the cut — half a token left at the edge of a cut would
 * still be a leak. `fullLen` is how long they were, secrets out, before any cut. Null for nothing at all.
 */
function journalText(raw) {
  const trimmed = String(raw ?? '').trim();
  if (!trimmed) return null;
  const cleaned = redact(trimmed);
  const cut = cleaned.text.length > JOURNAL_MAX_CHARS;
  return { text: cut ? `${head(cleaned.text, JOURNAL_MAX_CHARS)}${CUT}` : cleaned.text, fullLen: cleaned.text.length, redacted: cleaned.count > 0 };
}

/**
 * What the user typed, as the journal would keep it — `{ text, fullLen, redacted }` — or null when it is nothing
 * the journal records (a slash command, a `JOB:` brief, an empty line). For whoever must keep a turn somewhere
 * else first (the spool): the words leave here already redacted and cut.
 */
export const turnText = (raw) => (notSaid(String(raw ?? '').trim()) ? null : journalText(raw));
/** The same for the assistant's reply; null only when it said nothing. */
export const replyText = (raw) => journalText(raw);

/**
 * Words kept somewhere else first, on their way into the journal. They were redacted and cut when they were kept;
 * they are redacted again here, since a file is not the hand that wrote it, and never cut a second time — a cut of a
 * cut would be other words, and another digest.
 */
function fromKept(kept) {
  if (typeof kept?.text !== 'string' || !kept.text.trim()) return null;
  const cleaned = redact(kept.text.trim());
  const text = cleaned.text.length > JOURNAL_MAX_CHARS + CUT.length ? `${head(cleaned.text, JOURNAL_MAX_CHARS)}${CUT}` : cleaned.text;
  return { text, fullLen: Number.isInteger(kept.fullLen) && kept.fullLen >= 0 ? kept.fullLen : text.length, redacted: kept.redacted === true || cleaned.count > 0 };
}

/** One journal row's digest: its session, its time and its words as kept. The same event written twice is the same row. */
const shaOf = (sessionId, ts, text) => createHash('sha256').update(`${sessionId}\n${ts}\n${text}`).digest('hex');

/** The project a session was about at a moment: the one whose card had gone in most recently by then. */
function projectAsOf(db, sessionId, at) {
  return db.prepare(`SELECT slug FROM session_injections WHERE session_id = ? AND slug NOT LIKE '%:%' AND ts <= ? ORDER BY ts DESC LIMIT 1`).get(sessionId, at)?.slug ?? null;
}

/**
 * Stores what the user typed, word for word and whole (the first 64,000 characters of a longer paste, the cut
 * marked, `full_len` saying how long it was) — the ground truth every derived memory points back to. It is stamped
 * with the project the session was about, and with a digest of its session, time and words: the same turn written
 * again — an event replayed from the spool — inserts nothing and returns the row already there. Returns the turn id,
 * or null when there was nothing worth keeping (a slash command, a worker's brief, an empty line).
 *
 * `kept` is for a replay: `{ text, fullLen, redacted }` as `turnText` made them when the event was set aside.
 */
export function recordTurn(db, { sessionId, text, now, kept = null }) {
  const said = kept ? fromKept(kept) : turnText(text);
  if (!said || notSaid(said.text)) return null;
  const sha = shaOf(sessionId, now, said.text);
  const { changes, lastInsertRowid } = db
    .prepare('INSERT OR IGNORE INTO user_turns (session_id, ts, text, redacted, project, full_len, sha) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(sessionId, now, said.text, said.redacted ? 1 : 0, projectAsOf(db, sessionId, now), said.fullLen, sha);
  if (Number(changes) === 0) return db.prepare('SELECT id FROM user_turns WHERE sha = ?').get(sha).id;
  // A turn replayed late is older than what the session has heard since: the newest time stays.
  db.prepare("UPDATE sessions SET last_turn_at = MAX(COALESCE(last_turn_at, ''), ?), dream_state = 'pending' WHERE id = ?").run(now, sessionId);
  return Number(lastInsertRowid);
}

/**
 * Stores the assistant's final reply of a turn in the journal, beside the user's turns: redacted like a turn, whole
 * up to 64,000 characters, stamped with the session's project, and with the same kind of digest, so a replay inserts
 * nothing twice. It is what search falls back on and what the memory pass reads for context — never itself a memory:
 * only the user's words are. The session's row must exist (`ensureSession`). Returns the reply id, or null when
 * nothing was said.
 */
export function recordReply(db, { sessionId, text, now, kept = null }) {
  const said = kept ? fromKept(kept) : replyText(text);
  if (!said) return null;
  const sha = shaOf(sessionId, now, said.text);
  const { changes, lastInsertRowid } = db
    .prepare('INSERT OR IGNORE INTO replies (session_id, ts, text, project, full_len, sha) VALUES (?, ?, ?, ?, ?, ?)')
    .run(sessionId, now, said.text, projectAsOf(db, sessionId, now), said.fullLen, sha);
  return Number(changes) === 0 ? db.prepare('SELECT id FROM replies WHERE sha = ?').get(sha).id : Number(lastInsertRowid);
}

/**
 * A session heard of late: an event that could not be written when it happened, replayed with the time it happened.
 * Unlike `ensureSession` it never reopens a session that has ended since — the event is from before that — and an
 * older start replaces a newer one.
 */
export function heardSession(db, { id, harness = 'claude', cwd = null, transcriptPath = null, now }) {
  db.prepare(
    `INSERT INTO sessions (id, harness, cwd, transcript_path, started_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       cwd = COALESCE(cwd, excluded.cwd),
       transcript_path = COALESCE(transcript_path, excluded.transcript_path),
       started_at = MIN(started_at, excluded.started_at)`,
  ).run(id, harness, cwd, transcriptPath, now);
}

/** A goodbye replayed late: the session ended then, unless it has been heard from since or has ended already. */
export function endedThen(db, id, at) {
  db.prepare('UPDATE sessions SET ended_at = ? WHERE id = ? AND ended_at IS NULL AND COALESCE(last_turn_at, started_at) <= ?').run(at, id, at);
}

/**
 * One conversation as the journal holds it, in the order it was said: the user's turns and the assistant's final
 * replies of a session, each `{ kind: 'turn' | 'reply', id, session_id, ts, text, project, full_len }`. `id` is the
 * row's own in `user_turns` or `replies` (the two count separately). Ordered by time, not by id: a turn replayed
 * from the spool has a late id and its own time; at the same instant the turn comes before the reply.
 */
export function sessionJournal(db, sessionId) {
  return db
    .prepare(
      `SELECT 'turn' AS kind, id, session_id, ts, text, project, full_len FROM user_turns WHERE session_id = ?1
       UNION ALL
       SELECT 'reply' AS kind, id, session_id, ts, text, project, full_len FROM replies WHERE session_id = ?1
       ORDER BY ts, kind DESC, id`,
    )
    .all(sessionId);
}

const COVERED = (versions) => `EXISTS (SELECT 1 FROM extractions x WHERE x.session_id = t.session_id AND x.status IN ('ok', 'quarantined')
  ${versions.length > 0 ? `AND x.extractor_version IN (${versions.map(() => '?').join(', ')}) ` : ''}AND t.id BETWEEN x.first_turn AND x.last_turn)`;
/** No version named is every version: a turn any extractor read counts as read. */
const listOf = (version) => (version === undefined || version === null ? [] : Array.isArray(version) ? version : [version]);

/**
 * The finished conversations the memory pass has yet to read: sessions rows, oldest first, that are over — ended, or
 * nobody has spoken or been answered in them for 30 minutes (a closed terminal never says goodbye) — and hold a turn
 * no `ok` or `quarantined` extraction covers (its id within the row's `first_turn`…`last_turn`). A `failed` or
 * `running` row covers nothing: the turn is still owed.
 *
 * With no `version` an extraction under any extractor covers, which is what the pass asks: a changed prompt, model
 * or rule must not make every conversation owed again and have them all read anew by themselves — reading again under
 * the current extractor is `sumo memory rebuild`, which shows its difference first. `version`, one or several,
 * counts only those extractors' rows. `includeOpen` is for a pass the user asked for by hand, which waits for nothing.
 */
export function sessionsAwaitingExtraction(db, { version, now, limit = 5, includeOpen = false }) {
  const versions = listOf(version);
  const cutoff = new Date(Date.parse(now) - FINISHED_AFTER_MS).toISOString();
  return db
    .prepare(
      `SELECT s.* FROM sessions s
       WHERE (? = 1 OR s.ended_at IS NOT NULL
              OR MAX(COALESCE(s.last_turn_at, s.started_at), COALESCE((SELECT MAX(r.ts) FROM replies r WHERE r.session_id = s.id), '')) < ?)
         AND EXISTS (SELECT 1 FROM user_turns t WHERE t.session_id = s.id AND NOT ${COVERED(versions)})
       ORDER BY s.started_at, s.id LIMIT ?`,
    )
    .all(includeOpen ? 1 : 0, cutoff, ...versions, limit);
}

/** The turns of one session that no `ok` or `quarantined` extraction covers — of any extractor, or of `version` (one, or several) when given — oldest first: what a pass still owes it. */
export function turnsAwaitingExtraction(db, sessionId, version) {
  const versions = listOf(version);
  return db.prepare(`SELECT t.* FROM user_turns t WHERE t.session_id = ? AND NOT ${COVERED(versions)} ORDER BY t.ts, t.id`).all(sessionId, ...versions);
}

/**
 * When the user was last heard: the time of the newest turn in the journal — or of a later prompt that left no turn
 * (`noteHeard`) — or null when there is none. With a
 * `harness` — 'claude' for what came in through `sumo hook`, 'sumo' for sumo's own chat — only that one's sessions:
 * a harness whose hook lines are gone goes quiet while the other keeps talking.
 */
export function lastHeard(db, harness = null) {
  const said = db.prepare('SELECT MAX(t.ts) AS at FROM user_turns t JOIN sessions s ON s.id = t.session_id WHERE (? IS NULL OR s.harness = ?)').get(harness, harness).at ?? null;
  const stamped = db.prepare(`SELECT MAX(value) AS at FROM meta WHERE key LIKE ? ESCAPE '\\'`).get(`${HEARD_AT}${harness ?? '%'}`).at ?? null;
  return said !== null && stamped !== null ? (said > stamped ? said : stamped) : (said ?? stamped);
}

/** Where the time of a harness's last prompt that left no turn is kept: `heard_at.claude`, `heard_at.sumo`. */
const HEARD_AT = 'heard\\_at.';

/**
 * A prompt that is nothing the journal keeps — a slash command, a brief — is still the harness being heard: its time
 * is kept, so days of `/compact` and `/clear` are not read as hook lines gone missing.
 */
export function noteHeard(db, harness, now) {
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = MAX(value, excluded.value)').run(`heard_at.${harness}`, now);
}

/**
 * A call that reached past the machine — a web search or fetch, an MCP server — written on its session, each tool once:
 * what the conversation says after it may be what a page told it, so the memory pass holds what it would file from the
 * conversation's replies for the user (arXiv 2503.03704: memory written from injected content is read later as trusted).
 * A session not recorded yet gets nothing: a call comes after the turn that recorded it.
 */
export function noteSessionOutside(db, sessionId, tool) {
  if (!sessionId) return;
  const name = String(tool).replace(/\s+/g, ' ');
  const row = db.prepare('SELECT outside_read FROM sessions WHERE id = ?').get(sessionId);
  if (!row || (row.outside_read ?? '').split('\n').includes(name)) return;
  db.prepare('UPDATE sessions SET outside_read = ? WHERE id = ?').run(row.outside_read ? `${row.outside_read}\n${name}` : name, sessionId);
}

/** The tools any of these sessions read past the machine with, each once, in the order first seen. */
export function outsideReadsOf(db, sessionIds) {
  const ids = [...new Set(sessionIds)].filter(Boolean);
  if (ids.length === 0) return [];
  const rows = db.prepare(`SELECT outside_read FROM sessions WHERE id IN (${ids.map(() => '?').join(', ')}) AND outside_read IS NOT NULL`).all(...ids);
  return [...new Set(rows.flatMap((r) => r.outside_read.split('\n')))];
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

/** The two halves of the journal, and the letter each one's ids are typed with: `t481` is a turn, `r3` a reply. */
const JOURNAL = { turn: { table: 'user_turns', fts: 'user_turns_fts', mark: 't' }, reply: { table: 'replies', fts: 'replies_fts', mark: 'r' } };
/** How much of a turn or a reply one line of a search shows: the part around the words asked for. */
const EXCERPT_CHARS = 200;
const EXCERPT_LEAD = 40;

/**
 * The stretch of a text that holds the most of the words searched for, on one line: a reply can be pages long, and
 * its first words are seldom where the answer is. A word is looked for by its stem, so "deploys" shows for "deploy".
 */
function excerpt(text, query) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  const lower = flat.toLowerCase();
  const at = [...new Set(words(query))].map((w) => lower.indexOf(lower.includes(w) ? w : stem(w))).filter((i) => i >= 0);
  const within = (from) => at.filter((i) => i >= from && i < from + EXCERPT_CHARS - EXCERPT_LEAD).length;
  const first = at.reduce((best, i) => (best === null || within(i) > within(best) || (within(i) === within(best) && i < best) ? i : best), null) ?? 0;
  const from = Math.max(0, Math.min(first - EXCERPT_LEAD, flat.length - EXCERPT_CHARS));
  return `${from > 0 ? '…' : ''}${head(flat.slice(from), EXCERPT_CHARS).trim()}${from + EXCERPT_CHARS < flat.length ? '…' : ''}`;
}

/**
 * One half of the journal searched: the rows in scope that hold every word (`every`) or any of them, best first, and
 * how many rows matched per project. The index answers for the words it keeps apart; a Chinese, Japanese or Korean
 * word sits inside a run the index keeps as one word, so it is looked for in the text itself — a row found only that
 * way ranks by the share of those words it holds, the best the index found counting as all of them.
 */
function saidIn(db, kind, query, every, { project, everywhere, since, before, limit }) {
  const { table, fts, mark } = JOURNAL[kind];
  const cjk = cjkTerms(query);
  const match = every ? ftsAllQuery(query) : ftsQuery(query);
  const likes = cjk.map(() => `t.text LIKE ? ESCAPE '\\'`);
  const patterns = cjk.map(containing);
  const dated = `${since ? ' AND t.ts >= ?' : ''}${before ? ' AND t.ts < ?' : ''}`;
  const dates = [since, before].filter(Boolean);
  // What was said about no project is everyone's, as a global memory is; another project's is counted, never shown.
  const mine = everywhere ? '' : project ? ' AND (t.project IS NULL OR t.project = ?)' : ' AND t.project IS NULL';
  const mineParams = everywhere || !project ? [] : [project];

  const inIndex = match ? `t.id IN (SELECT rowid FROM ${fts} WHERE ${fts} MATCH ?)` : null;
  const holds = [inIndex, ...likes].filter(Boolean).join(every ? ' AND ' : ' OR ');
  const counted = db.prepare(`SELECT t.project AS project, COUNT(*) AS n FROM ${table} t WHERE (${holds})${dated} GROUP BY t.project`).all(...(match ? [match] : []), ...patterns, ...dates);

  const cols = 't.id, t.session_id, t.ts, t.text, t.project, t.full_len';
  const indexed = match
    ? db
        .prepare(
          `SELECT ${cols}, bm25(${fts}) AS rank FROM ${fts} JOIN ${table} t ON t.id = ${fts}.rowid
           WHERE ${fts} MATCH ?${every ? likes.map((l) => ` AND ${l}`).join('') : ''}${dated}${mine} ORDER BY rank, t.ts DESC, t.id DESC LIMIT ?`,
        )
        .all(match, ...(every ? patterns : []), ...dates, ...mineParams, limit)
    : [];
  const byId = new Map(indexed.map((row) => [row.id, row]));
  if (cjk.length > 0 && (!every || !match)) {
    const best = indexed.reduce((min, row) => Math.min(min, row.rank), 0) || -1;
    const inText = db
      .prepare(`SELECT ${cols} FROM ${table} t WHERE (${likes.join(every ? ' AND ' : ' OR ')})${dated}${mine} ORDER BY ${likes.map((l) => `(${l})`).join(' + ')} DESC, t.ts DESC, t.id DESC LIMIT ?`)
      .all(...patterns, ...dates, ...mineParams, ...patterns, limit);
    for (const row of inText) {
      const lower = row.text.toLowerCase();
      const rank = (best * cjk.filter((t) => lower.includes(t)).length) / cjk.length;
      const known = byId.get(row.id);
      if (!known || rank < known.rank) byId.set(row.id, { ...row, rank });
    }
  }
  const rows = [...byId.values()].map(({ text, ...row }) => ({ kind, ref: `${mark}${row.id}`, ...row, excerpt: excerpt(text, query), held: termsHeld(query, text) }));
  return { rows, counted };
}

/**
 * The conversations themselves, searched: what the user typed and what sumo answered, where the answer to "what did
 * we say about …" lives when nobody made a memory of it. All the words first; only when no row in scope holds every
 * one is it tried with any of them (`fellBack`); `terms: 'all' | 'any'` asks for one of the two alone.
 *
 * Scope is as memory has it: a row said about no project, and the rows of `project` (a slug); another project's rows
 * are counted in `elsewhere` (`project:<slug>` → how many), never shown, unless `everywhere`. `since` and `before`
 * (ISO times) hold it to when it was said. Each hit is `{ kind: 'turn' | 'reply', ref, id, session_id, ts, project,
 * full_len, excerpt, held, rank }` — `ref` is the id as it is typed (`t481`, `r3`), `excerpt` the part around the
 * words, `held` how many of the search's words the whole text holds. `more` counts what matched in scope past `limit`;
 * `best` is the most `held` among the hits.
 */
export function searchJournal(db, query, { terms, project = null, everywhere = false, since, before, limit = 8 } = {}) {
  if (!ftsQuery(query)) throw new UsageError('nothing to search for');
  const several = new Set(words(query)).size > 1;
  let hits = [];
  let counted = [];
  let fellBack = false;
  for (const every of terms === 'any' ? [false] : terms === 'all' || !several ? [true] : [true, false]) {
    const halves = Object.keys(JOURNAL).map((kind) => saidIn(db, kind, query, every, { project, everywhere, since, before, limit }));
    hits = halves.flatMap((h) => h.rows).sort((a, b) => a.rank - b.rank || (a.ts < b.ts ? 1 : a.ts > b.ts ? -1 : 0) || b.id - a.id);
    counted = halves.flatMap((h) => h.counted);
    fellBack = !every && terms !== 'any';
    if (hits.length > 0) break;
  }
  const elsewhere = {};
  let inScope = 0;
  for (const { project: said, n } of counted) {
    if (everywhere || said === null || said === project) inScope += n;
    else elsewhere[`project:${said}`] = (elsewhere[`project:${said}`] ?? 0) + n;
  }
  const shown = hits.slice(0, limit);
  return { hits: shown, elsewhere, more: inScope - shown.length, fellBack, best: shown.reduce((most, h) => Math.max(most, h.held), 0) };
}

/** How many turns and replies either side of one are shown with it. */
const AROUND = 2;

/**
 * One turn or reply by the id a search printed (`t481`, `r3`), whole, with what was said around it in its
 * conversation: `{ entry, around }`, both as `sessionJournal` gives rows, `around` in the order it was said and
 * holding the entry itself. Null when `ref` is not such an id; a refusal when it names nothing.
 */
export function journalEntry(db, ref) {
  const typed = /^([tr])(\d+)$/.exec(String(ref ?? '').trim().toLowerCase());
  if (!typed) return null;
  const kind = typed[1] === 't' ? 'turn' : 'reply';
  const id = Number(typed[2]);
  const row = db.prepare(`SELECT session_id FROM ${JOURNAL[kind].table} WHERE id = ?`).get(id);
  if (!row) throw new Refusal(`no ${kind} ${typed[0]} in the conversations — sumo search "<words>" prints the ids it finds`);
  const said = sessionJournal(db, row.session_id).map((e) => ({ ...e, ref: `${JOURNAL[e.kind].mark}${e.id}` }));
  const at = said.findIndex((e) => e.kind === kind && e.id === id);
  return { entry: said[at], around: said.slice(Math.max(0, at - AROUND), at + AROUND + 1) };
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
 * hint, so a `/compact` can be pasted exactly as it stands. No figure: a count
 * of its own tokens is what makes a model cut its work short; the screen shows it.
 */
export function contextNudge(band, focus) {
  const hint = `hint: focus on ${focus}; keep decisions and open job ids in a note; drop tool output and file contents.`;
  if (band === 'act') return `context: very large — start fresh now: note where you are (sumo job note; the end of the turn records "Left off"), then tell the user to type /handoff, which carries your hand-off into a fresh session, or /new. ${hint}`;
  return `context: large — quality drops from here. Finish the piece in hand, then tell the user to type /handoff: a fresh session starts from your hand-off, and the memory block brings the thread back. ${hint}`;
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
  return 'this session has grown large and the task just ended — a good moment for /new; the memory block brings the thread back.';
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

// Identifiers pair tool calls and results. The API needs encrypted web results and citation indices byte-for-byte.
const PROTOCOL_FIELDS = new Set(['type', 'name', 'id', 'tool_use_id', 'encrypted_content', 'encrypted_index', 'encrypted_stdout']);

/** Keep the API block structure for resume while scrubbing its human-readable contents, including nested web results. */
function keepBlock(value) {
  if (typeof value === 'string') return redact(value).text;
  if (Array.isArray(value)) return value.map(keepBlock);
  if (!value || typeof value !== 'object') return value;
  if (value.type === 'image') return { type: 'text', text: NO_PICTURE };
  if (value.type === 'base64') return { type: 'text', media_type: 'text/plain', data: '[binary attachment omitted]' };
  const kept = {};
  for (const [key, child] of Object.entries(value)) {
    if (key === 'cache_control') continue;
    // Tool inputs contain arbitrary user data, even under keys that look like protocol fields.
    if (key === 'input') kept[key] = redactValues(child);
    else kept[key] = PROTOCOL_FIELDS.has(key) ? child : keepBlock(child);
  }
  return kept;
}

/** What the session can replay after resuming. Thinking signatures cannot survive redaction or a changed prefix. */
function keepable(messages) {
  return withoutThinking(messages).map((m) => ({ role: m.role, content: keepBlock(m.content) }));
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
export function saveState({ id, messages, model, effort, routed, cwd, contextTokens, now, pending = [] }) {
  mkdirSync(sessionsDir(), { recursive: true, mode: 0o700 });
  const file = stateFile(id);
  // The summary first, so a listing can read it without the messages behind it; the route's reason last, since it is prose of any length.
  // `pending` is what jobs reported that the model has not read yet: it goes with the session, to be read when it is picked up again.
  const state = { version: 1, id, savedAt: now, contextTokens, model, effort, cwd, messages: keepable(messages), routed: redactValues(routed), pending: redactValues(pending) };
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
    throw new Refusal(`the saved session ${shortId(id)} cannot be read: ${cause.message}`);
  }
  if (state?.version !== 1 || !Array.isArray(state.messages)) throw new Refusal(`the saved session ${shortId(id)} is not one this version can resume`);
  return state;
}

/** What a state file says about itself, read from its head: everything before the messages. Null when it cannot be read. */
function summaryOf(file) {
  try {
    const fd = openSync(file, 'r');
    try {
      const buffer = Buffer.alloc(SUMMARY_BYTES);
      const text = buffer.toString('utf8', 0, readSync(fd, buffer, 0, SUMMARY_BYTES, 0));
      const cut = text.indexOf(',"messages":');
      // The read above was at a position, so the descriptor is still at the start: a head with no cut is read whole from it.
      return JSON.parse(cut === -1 ? readFileSync(fd, 'utf8') : `${text.slice(0, cut)}}`);
    } finally {
      closeSync(fd);
    }
  } catch {
    return null;
  }
}

/**
 * The sessions that can be picked up, newest first — every one still on disk that a conversation in the journal stands
 * behind, the heavy ones marked. Newest is by the journal's own time, the last thing said in it, never by what a file
 * says of itself: a file is not the hand that wrote it. `except` is the session asking, which cannot resume itself.
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
  const row = db.prepare('SELECT COALESCE(last_turn_at, started_at) AS at FROM sessions WHERE id = ?');
  return names
    .filter((name) => name.endsWith('.state.json'))
    .map((name) => name.slice(0, -'.state.json'.length))
    .filter((id) => id !== except)
    .map((id) => {
      const heard = row.get(id)?.at;
      const summary = heard ? summaryOf(stateFile(id)) : null;
      if (!summary?.savedAt) return null;
      const tokens = summary.contextTokens ?? 0;
      return {
        id,
        savedAt: summary.savedAt,
        lastTurnAt: heard,
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
    .sort((a, b) => (a.lastTurnAt < b.lastTurnAt ? 1 : a.lastTurnAt > b.lastTurnAt ? -1 : 0));
}

/** The saved session `ref` names: `last` for the newest, otherwise the one id that starts with it. Anything else is said. */
export function findSaved(db, ref, options) {
  const all = savedSessions(db, options);
  if (ref === 'last') {
    if (all.length === 0) throw new Refusal('no saved session to resume');
    return all[0];
  }
  const hits = all.filter((s) => s.id.startsWith(ref));
  if (hits.length === 1) return hits[0];
  if (hits.length === 0) throw new Refusal(`no saved session starts with "${ref}"${all.length > 0 ? ` — one of: ${all.map((s) => shortId(s.id)).join(', ')}` : ''}`);
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
