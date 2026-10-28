import { createHash } from 'node:crypto';
import { getMeta, setMeta, tx } from './db.mjs';
import { redact } from './redact.mjs';
import { cjkTerms, clip, containing, ftsQuery, overlap, sharedStems, stem, words } from './text.mjs';
import { matchWithin } from './workflows.mjs';

/** How much of a search that found nothing is kept as the record of it. */
const MISS_KEPT = 200;

const TYPES = ['preference', 'fact', 'decision', 'gotcha', 'procedure'];

const IMPORTANCE = { preference: 0.8, procedure: 0.8, decision: 0.7, gotcha: 0.6, fact: 0.5 };
const PROVENANCE_WEIGHT = { stated: 1, observed: 0.9, scanned: 0.7, inferred: 0.5 };
/** Days for a memory's rank to fall to 1/e. Absent means it does not age: a preference stays true until superseded. */
const DECAY_DAYS = { fact: 365, gotcha: 365 };
const PROJECT_MATCH_BOOST = 1.5;
const OTHER_PROJECT_PENALTY = 0.5;
const SIMILAR_OVERLAP = 0.5;
/** How many search terms a memory carries beside its words, and how long one may be. */
const KEYS_KEPT = 6;
const KEY_CHARS = 32;

/** Commands no gate may ever catch: a pattern that matches these would hold back everything. */
const NEVER_GATED = ['', 'ls', 'cd src', 'git status', 'cat README.md'];
/** Text of the kind that sets a backtracking pattern off: long runs of one character, of words, of spaces, each with a miss at the end. */
const RUNAWAY = ['a'.repeat(40), 'word '.repeat(30), ' '.repeat(60), '1'.repeat(40), 'gh pr create '.repeat(8)].map((text) => `${text}!`);

/** A mistake in how `sumo` was called (exit 2), as opposed to something going wrong (exit 1). */
export class UsageError extends Error {
  exit = 2;
}
/** Understood, and not done: what it names is not there, not in a state for it, or not the asker's to do (exit 1). */
export class Refusal extends UsageError {
  exit = 1;
}
/** Not done for want of an Anthropic credential in this shell (exit 4, as other tools say "log in first"). */
export class NeedsCredential extends UsageError {
  exit = 4;
}

/**
 * A gate is a regular expression over a shell command: the commands a workflow has to come before.
 * It is written once, by whoever teaches the workflow, and shown to the user — stated, not guessed.
 */
function checkGate(raw) {
  const pattern = String(raw ?? '').trim();
  const example = 'a gate is a regular expression over the shell command, e.g. gh(-axi)? pr create';
  if (!pattern) throw new UsageError(example);
  let regex;
  try {
    regex = new RegExp(pattern, 'i');
  } catch (cause) {
    throw new UsageError(`that gate is not a valid regular expression: ${cause.message}`);
  }
  const caught = NEVER_GATED.find((command) => regex.test(command));
  if (caught !== undefined) throw new UsageError(`that gate is too broad — it would hold back "${caught || 'every command'}"`);
  if (pattern.length < 4) throw new UsageError(`that gate is too short to mean one command — ${example}`);
  if (RUNAWAY.some((text) => matchWithin(regex, text) === null)) {
    throw new UsageError(`that gate takes too long to match — a repeat inside a repeat, such as (a+)+ or (\\w+\\s*)+, makes it run for minutes on some commands. ${example}`);
  }
  return pattern;
}

export function setGate(db, id, raw) {
  const row = get(db, id);
  if (row.type !== 'procedure') throw new Refusal(`m${id} is not a workflow — only a workflow can gate a command`);
  const gate = raw === null ? null : checkGate(raw);
  db.prepare('UPDATE memories SET gate = ? WHERE id = ?').run(gate, id);
  return get(db, id);
}

export function parseId(raw) {
  if (raw === undefined) throw new UsageError('a memory id is needed — ids look like m12');
  const match = /^m?(\d+)$/.exec(String(raw ?? '').trim());
  if (!match) throw new UsageError(`"${raw}" is not a memory id — ids look like m12`);
  return Number(match[1]);
}

export function resolveProject(db, nameOrAlias) {
  const find = (key) => db.prepare('SELECT slug FROM projects WHERE slug = ?').get(key) ?? db.prepare('SELECT slug FROM project_aliases WHERE alias = ?').get(key);
  // A project is also known by the name it was registered from, as typed: "My Proj" is my-proj (the slug projects.mjs makes).
  const row = find(nameOrAlias.toLowerCase()) ?? find(nameOrAlias.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, ''));
  if (!row) {
    const known = db.prepare(`SELECT slug FROM projects WHERE status = 'active' ORDER BY slug LIMIT 9`).all().map((r) => r.slug);
    const listed = known.length === 0 ? '' : ` (known: ${known.slice(0, 8).join(', ')}${known.length > 8 ? ', …' : ''})`;
    throw new Refusal(`unknown project "${nameOrAlias}"${listed} — register it first: sumo project add <path>`);
  }
  return row.slug;
}

function scopeFor(db, project) {
  return project ? `project:${resolveProject(db, project)}` : 'global';
}

export function get(db, id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) throw new Refusal(`no memory m${id}`);
  return row;
}

function requireActive(db, id, verb) {
  const row = get(db, id);
  if (row.state !== 'active') throw new Refusal(`m${id} is ${row.state} — only an active memory can be ${verb}`);
  return row;
}

/** A memory's text as it is stored: secrets scrubbed, and — since a memory is one statement — on one line, unless it is a procedure, which may be a document. */
export function storedBody(type, text) {
  const cleaned = redact(text ?? '');
  return { text: type === 'procedure' ? cleaned.text.trim() : cleaned.text.replace(/\s+/g, ' ').trim(), redacted: cleaned.count };
}

/**
 * A memory's search terms as they are stored, or null: what it is about, in words its body does not use — "lint" for
 * "always run eslint --fix before you commit". A model writes them, so each is checked here and a bad one is dropped,
 * never the memory: not text, longer than a term, secret-looking, a repeat, or only words the body has already.
 */
export function storedKeys(raw, body) {
  const given = (Array.isArray(raw) ? raw : [raw]).filter((k) => typeof k === 'string').flatMap((k) => k.split(','));
  const known = new Set(words(body).map(stem));
  const kept = [];
  for (const term of given) {
    const key = term.replace(/\s+/g, ' ').trim();
    // Before it is lowercased: a token's mixed case is part of what gives it away.
    if (!key || key.length > KEY_CHARS || redact(key).count > 0 || kept.includes(key.toLowerCase())) continue;
    if (words(key).every((w) => known.has(stem(w)))) continue;
    kept.push(key.toLowerCase());
    if (kept.length === KEYS_KEPT) break;
  }
  return kept.length > 0 ? kept.join(', ') : null;
}

/**
 * Stores one memory. Returns it with any active memories that look like the
 * same statement, so the caller can supersede instead of piling up duplicates.
 */
export function add(db, input) {
  if (!TYPES.includes(input.type)) {
    throw new UsageError(`unknown type "${input.type}" — one of: ${TYPES.join(', ')}`);
  }
  const provenance = input.provenance ?? 'stated';
  if (!(provenance in PROVENANCE_WEIGHT)) throw new UsageError(`unknown provenance "${provenance}"`);

  const { text: body, redacted } = storedBody(input.type, input.body);
  if (!body) throw new UsageError('nothing to remember — the text is empty');
  if (input.type === 'procedure' && !input.title?.trim()) throw new UsageError('a procedure needs a title');
  const gate = input.gate === undefined ? null : checkGate(input.gate);
  if (gate !== null && input.type !== 'procedure') throw new UsageError('only a workflow can gate a command');

  const scope = scopeFor(db, input.project);
  const now = input.now ?? new Date().toISOString();

  return tx(db, () => {
    const replaced = input.supersedes === undefined ? null : requireActive(db, input.supersedes, 'superseded');
    const similar = replaced ? [] : findSimilar(db, { type: input.type, title: input.title, body, scope });

    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO memories (type, scope, title, cue, gate, body, topic, keys, provenance, state, pinned, importance,
                               scan_key, written_by, source_session, source_turn, source_quote, valid_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        scope,
        input.title?.trim() || null,
        input.cue?.trim() || null,
        gate,
        body,
        input.topic?.trim().toLowerCase() || null,
        storedKeys(input.keys, body),
        provenance,
        provenance === 'inferred' ? 'unconfirmed' : 'active',
        input.pin ? 1 : 0,
        IMPORTANCE[input.type],
        input.scanKey ?? null,
        input.writtenBy ?? 'chat-model',
        input.sourceSession ?? null,
        input.sourceTurn ?? null,
        input.sourceQuote ?? null,
        now,
        now,
      );
    const id = Number(lastInsertRowid);
    if (replaced) markSuperseded(db, replaced.id, id, now);

    return { memory: get(db, id), similar, redacted };
  });
}

/**
 * A fact read off disk that was retired by anything but the scanner — forgotten, or replaced — stays retired: the next
 * rescan reads the same text off disk, and must not bring back what was let go. A different text is news, and comes in.
 */
const retiredKey = (scope, scanKey) => `scan.retired.${scope}.${scanKey}`;
// Kept as a digest, never the text: a purge erases the words, and the fact still stays let go.
const digestOf = (body) => createHash('sha256').update(body).digest('hex');
function noteRetired(db, id) {
  const row = db.prepare('SELECT scope, scan_key, body FROM memories WHERE id = ?').get(id);
  if (row?.scan_key) setMeta(db, retiredKey(row.scope, row.scan_key), digestOf(row.body));
}
/** Whether a scanned fact with this text was let go by someone other than the scanner. */
export const scanRetired = (db, scope, scanKey, body) => getMeta(db, retiredKey(scope, scanKey)) === digestOf(body);

function markSuperseded(db, oldId, newId, now) {
  noteRetired(db, oldId);
  db.prepare(`UPDATE memories SET state = 'superseded', superseded_by = ?, invalid_at = ? WHERE id = ?`).run(
    newId,
    now,
    oldId,
  );
}

/** Links two memories that already exist: `oldId` stops being true because of `newId`. */
export function supersede(db, oldId, newId, now = new Date().toISOString()) {
  if (oldId === newId) throw new UsageError('a memory cannot supersede itself');
  return tx(db, () => {
    requireActive(db, oldId, 'superseded');
    requireActive(db, newId, 'the replacement');
    markSuperseded(db, oldId, newId, now);
    return get(db, oldId);
  });
}

function findSimilar(db, { type, title, body, scope }) {
  const match = ftsQuery(type === 'procedure' ? `${title} ${body}` : body);
  if (!match) return [];
  // Same scope, plus global: a project rule that overrides a global one is
  // legitimate, but whoever adds it should see what it overrides.
  const candidates = db
    .prepare(
      `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE memories_fts MATCH ? AND m.state = 'active' AND m.scope IN (?, 'global')
         AND (m.type = 'procedure') = ?
       ORDER BY bm25(memories_fts) LIMIT 8`,
    )
    .all(match, scope, type === 'procedure' ? 1 : 0);

  const text = (m) => (m.type === 'procedure' ? m.title : m.body);
  const mine = type === 'procedure' ? title : body;
  return candidates.filter((m) => overlap(mine, text(m)) >= SIMILAR_OVERLAP).slice(0, 3);
}

/**
 * Higher is better. Pure, so ranking can be tested without a database or a clock.
 *
 * Relevance is each row's BM25 relative to the best match, square-rooted. Raw
 * BM25 rewards short text so heavily that, among one-sentence memories, a terse
 * scanned fact would outrank the fuller sentence the user actually said. Damped
 * like this it still orders by relevance, but trust and scope can outweigh it.
 */
export function score(row, { projectScope, now, bestRank }) {
  const relevance = Math.sqrt(row.rank / bestRank); // bm25() is negative, most negative = best, so this is 0..1
  const scopeWeight =
    row.scope === projectScope ? PROJECT_MATCH_BOOST : row.scope === 'global' ? 1 : OTHER_PROJECT_PENALTY;
  const decayDays = DECAY_DAYS[row.type];
  const ageDays = (Date.parse(now) - Date.parse(row.valid_from)) / 86_400_000;
  const decay = decayDays ? Math.exp(-Math.max(0, ageDays) / decayDays) : 1;
  return relevance * scopeWeight * PROVENANCE_WEIGHT[row.provenance] * (0.5 + row.importance) * decay;
}

/** Memories put in front of someone count as used: where room is short, what is used often is shown first. */
export function markHits(db, ids, now) {
  if (ids.length === 0) return;
  db.prepare(`UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`).run(now, ...ids);
}

/**
 * What the index found, with the memories holding a Chinese, Japanese or Korean word of the search: the index keeps a
 * run of those characters as one word, so a word inside it is looked for in the text itself, under the same `filters`.
 * One found that way ranks by the share of those words it holds, the best the index found counting as all of them.
 * With no such word, the index alone answers, unchanged.
 */
function withCjk(db, terms, found, filters, params) {
  if (terms.length === 0) return found;
  const fields = ['title', 'cue', 'body', 'topic', 'keys'];
  const holds = terms.flatMap(() => fields.map((f) => `m.${f} LIKE ? ESCAPE '\\'`)).join(' OR ');
  const rows = db
    .prepare(`SELECT m.* FROM memories m WHERE (${holds})${filters.map((w) => ` AND ${w}`).join('')}`)
    .all(...terms.flatMap((t) => fields.map(() => containing(t))), ...params);
  const best = found.length > 0 ? found.reduce((min, row) => Math.min(min, row.rank), 0) : -1;
  const byId = new Map(found.map((row) => [row.id, row]));
  for (const row of rows) {
    const text = fields.map((f) => row[f] ?? '').join(' ').toLowerCase();
    const rank = (best * terms.filter((t) => text.includes(t)).length) / terms.length;
    const known = byId.get(row.id);
    if (!known || rank < known.rank) byId.set(row.id, { ...row, rank });
  }
  return [...byId.values()];
}

/**
 * Ranked search. Scope is `global` plus the named project; other projects stay
 * invisible unless `everywhere` is set — only their hit counts come back, so
 * the caller learns where to look without one project's memory leaking into
 * another's work. `record: false` is for a search nobody asked for: it counts
 * no hits and keeps no misses, and the caller decides what was used.
 * `since` and `before` (ISO times) hold it to a time: since, what was said or
 * last changed — replaced, let go — at or after it; before, what was said before it.
 */
export function search(db, query, opts = {}) {
  const match = ftsQuery(query);
  if (!match) throw new UsageError('nothing to search for');
  if (opts.type && !TYPES.includes(opts.type)) {
    // Said as the user knows them: a procedure is a workflow everywhere they look.
    throw new UsageError(`unknown type "${opts.type}" — one of: ${TYPES.map((t) => (t === 'procedure' ? 'workflow' : t)).join(', ')}`);
  }

  const projectScope = opts.project ? scopeFor(db, opts.project) : null;
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 8;

  const where = ['memories_fts MATCH ?'];
  const params = [match];
  if (!opts.all) where.push(`m.state = 'active'`);
  if (opts.type) {
    where.push('m.type = ?');
    params.push(opts.type);
  }
  if (opts.since) {
    where.push('(m.created_at >= ? OR m.invalid_at >= ?)');
    params.push(opts.since, opts.since);
  }
  // A memory is changed only after it is said: one said before then is all that happened before then.
  if (opts.before) {
    where.push('m.created_at < ?');
    params.push(opts.before);
  }

  const found = db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(' AND ')}`,
    )
    .all(...params);
  const rows = withCjk(db, cjkTerms(query), found, where.slice(1), params.slice(1));

  const inScope = (row) => opts.everywhere || row.scope === 'global' || row.scope === projectScope;
  // OR-ed words match on any one of them. Fine for words a caller picked; a caller searching with
  // words nobody picked — a sentence lifted from a reply — sets a floor on how many must be shared.
  const close = (row) => !opts.minShared || sharedStems(query, `${row.title ?? ''} ${row.cue ?? ''} ${row.body} ${row.keys ?? ''}`) >= opts.minShared;
  const candidates = rows.filter((row) => inScope(row) && close(row));
  // Not Math.min(...ranks): spread into arguments, a broad query's rows overflow the call stack.
  const bestRank = candidates.reduce((best, row) => Math.min(best, row.rank), Infinity);
  const results = candidates
    .map((row) => ({ ...row, score: score(row, { projectScope, now, bestRank }) }))
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit);

  const elsewhere = {};
  for (const row of rows) if (!inScope(row)) elsewhere[row.scope] = (elsewhere[row.scope] ?? 0) + 1;
  // Matches past the limit, counted, so a list cut short says so.
  const more = candidates.length - results.length;

  if (opts.record === false) return { results, elsewhere, more };
  if (results.length > 0) {
    markHits(db, results.map((r) => r.id), now);
  } else {
    // The record of what memory could not answer: the evidence for whether
    // keyword search is enough or embeddings are ever worth adding.
    // Kept like everything else here: without secrets, and short — a pasted log is not a question worth keeping whole.
    db.prepare('INSERT INTO search_misses (ts, query, scope) VALUES (?, ?, ?)').run(
      now,
      clip(redact(query).text, MISS_KEPT),
      opts.everywhere ? 'everywhere' : (projectScope ?? 'global'),
    );
  }

  return { results, elsewhere, more };
}

/** Every memory connected to `id` by supersession, oldest first. */
export function history(db, id) {
  get(db, id);
  const seen = new Map();
  const queue = [id];
  while (queue.length > 0) {
    const current = queue.pop();
    if (seen.has(current)) continue;
    const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(current);
    if (!row) continue;
    seen.set(current, row);
    if (row.superseded_by !== null) queue.push(row.superseded_by);
    for (const prev of db.prepare('SELECT id FROM memories WHERE superseded_by = ?').all(current)) queue.push(prev.id);
  }
  return [...seen.values()].sort((a, b) => a.valid_from.localeCompare(b.valid_from) || a.id - b.id);
}

/**
 * The search indexes keep a deleted entry's words until they next merge, unless told to drop them at once. The
 * setting stays on once made. FTS5 has it from SQLite 3.42, which every Node this runs on bundles; a build linked
 * against an older system SQLite still purges, leaving those words to the next merge.
 */
function eraseFromIndexes(db) {
  const [major, minor] = db.prepare('SELECT sqlite_version() AS v').get().v.split('.').map(Number);
  if (major === 3 && minor < 42) return;
  db.exec(`
    INSERT INTO memories_fts(memories_fts, rank) VALUES ('secure-delete', 1);
    INSERT INTO user_turns_fts(user_turns_fts, rank) VALUES ('secure-delete', 1);
  `);
}

/** Stops a memory being true. With `purge` it is erased outright, for things that should never have been stored. */
export function forget(db, id, { purge = false, now = new Date().toISOString() } = {}) {
  const row = get(db, id);
  if (purge) {
    tx(db, () => {
      eraseFromIndexes(db);
      // A scanned fact let go for good stays let go: only its digest is kept, never its words.
      noteRetired(db, id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      // Erasing the memory but keeping the sentence it came from would not be erasing it.
      if (row.source_turn !== null) db.prepare('DELETE FROM user_turns WHERE id = ?').run(row.source_turn);
    });
    // The write-ahead log still holds the pages as they were before the delete; copy it into the file and empty it.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ...row, state: 'purged' };
  }
  if (row.state === 'invalid') return row;
  noteRetired(db, id);
  db.prepare(`UPDATE memories SET state = 'invalid', invalid_at = ? WHERE id = ?`).run(now, id);
  return get(db, id);
}

/** The user said yes to a guess: from here on it carries the weight of something they stated. */
export function confirm(db, id, { byUser = true } = {}) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new Refusal(`m${id} is ${row.state} — only an unconfirmed memory can be confirmed`);
  // Held because what it says came from a page or an MCP server the model read: the model may not vouch for it.
  if (row.held_for === 'outside' && !byUser) throw new Refusal(`m${id} came from a conversation that read the web or an MCP server: only the user confirms it — on the memory page (/memory), or with sumo confirm in their own terminal`);
  db.prepare(`UPDATE memories SET state = 'active', provenance = 'stated' WHERE id = ?`).run(id);
  return get(db, id);
}

export function reject(db, id, now = new Date().toISOString()) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new Refusal(`m${id} is ${row.state} — only an unconfirmed memory can be rejected`);
  db.prepare(`UPDATE memories SET state = 'rejected', invalid_at = ? WHERE id = ?`).run(now, id);
  return get(db, id);
}

/** How long a gotcha an agent filed may go unshown before it is let go. */
export const GOTCHA_UNUSED_DAYS = 45;
const DAY_MS = 86_400_000;

/**
 * Lets go of the traps agents filed that nobody was ever shown: observed, unpinned, no hits, older than
 * GOTCHA_UNUSED_DAYS. Let go the way `sumo forget` does — state `invalid`, the row and its history kept. What the user
 * said, pinned, or was shown is never touched. Returns how many went.
 */
export function expireUnusedGotchas(db, now = new Date().toISOString()) {
  const before = new Date(Date.parse(now) - GOTCHA_UNUSED_DAYS * DAY_MS).toISOString();
  const unused = db
    .prepare(`SELECT id FROM memories WHERE type = 'gotcha' AND state = 'active' AND provenance = 'observed' AND pinned = 0 AND hits = 0 AND created_at < ?`)
    .all(before);
  tx(db, () => {
    for (const { id } of unused) forget(db, id, { now });
  });
  return unused.length;
}

/** The writers whose memories start as a model's guess; one confirmed by the user becomes `stated` and keeps no quote. */
const GUESSING_WRITERS = ['scribe', 'dream', 'worker'];
/** How old a project's scan may be before memory health names it. */
const SCAN_STALE_DAYS = 7;

/**
 * How memory is doing, as plain values for whoever says it — doctor, the memory status:
 * - `lastTurnAt`: when the user was last heard (null: never);
 * - `lastPass`: the last memory pass, `{ at, ok, error }` (null: never ran);
 * - `waiting`, `oldestWaitingDays`: guesses waiting for the user, and the age of the oldest;
 * - `guesses`: of the guesses settled, how many the user confirmed and rejected, and the share confirmed;
 * - `scans`: active projects whose scan is more than a week old, oldest first, with its age in days.
 */
export function memoryHealth(db, now = new Date().toISOString()) {
  const daysSince = (at) => Math.floor((Date.parse(now) - Date.parse(at)) / DAY_MS);
  const lastTurnAt = db.prepare('SELECT MAX(ts) AS at FROM user_turns').get().at ?? null;
  const pass = db.prepare(`SELECT ts, ok, note FROM model_runs WHERE kind IN ('scribe', 'dream') ORDER BY ts DESC, id DESC LIMIT 1`).get();
  const lastPass = pass ? { at: pass.ts, ok: pass.ok === 1, error: pass.ok === 1 ? null : pass.note } : null;
  const waitingRow = db.prepare(`SELECT COUNT(*) AS n, MIN(created_at) AS oldest FROM memories WHERE state = 'unconfirmed'`).get();
  const writers = GUESSING_WRITERS.map(() => '?').join(', ');
  const confirmed = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE provenance = 'stated' AND source_quote IS NULL AND written_by IN (${writers})`).get(...GUESSING_WRITERS).n;
  const rejected = db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE state = 'rejected'`).get().n;
  const scans = db
    .prepare(`SELECT slug, scanned_at FROM projects WHERE status = 'active' AND scanned_at IS NOT NULL ORDER BY scanned_at`)
    .all()
    .map((p) => ({ slug: p.slug, days: daysSince(p.scanned_at) }))
    .filter((p) => p.days > SCAN_STALE_DAYS);
  return {
    lastTurnAt,
    lastPass,
    waiting: waitingRow.n,
    oldestWaitingDays: waitingRow.oldest ? daysSince(waitingRow.oldest) : null,
    guesses: { confirmed, rejected, rate: confirmed + rejected > 0 ? confirmed / (confirmed + rejected) : null },
    scans,
  };
}

/** How long ago, in the largest whole unit: `3d ago`, `5h ago`, `just now`. */
function sinceSaid(at, now) {
  const hours = (Date.parse(now) - Date.parse(at)) / 3_600_000;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ago`;
  return hours >= 1 ? `${Math.floor(hours)}h ago` : 'just now';
}
/** A scan this old is a warning, not a note. */
const SCAN_WARN_DAYS = 30;

/**
 * Memory health said in one line, for doctor and the memory status: `{ ok, label, fix }`. Not ok — a warning — when the
 * last pass failed or a project's scan is a month old; `fix` says what to do about each.
 */
export function memoryHealthLine(health, now = new Date().toISOString()) {
  const parts = [
    health.lastTurnAt ? `last heard ${sinceSaid(health.lastTurnAt, now)}` : 'nothing heard yet',
    health.lastPass ? `last pass ${sinceSaid(health.lastPass.at, now)}${health.lastPass.ok ? '' : ', failed'}` : 'no memory pass yet',
    health.waiting > 0 ? `${health.waiting} guess${health.waiting === 1 ? '' : 'es'} waiting, the oldest ${health.oldestWaitingDays}d` : 'no guesses waiting',
  ];
  if (health.guesses.rate !== null) parts.push(`${Math.round(health.guesses.rate * 100)}% of guesses confirmed`);
  if (health.scans.length > 0) {
    const named = health.scans.slice(0, 3).map((p) => `${p.slug}, ${p.days}d`).join('; ');
    parts.push(`${health.scans.length} project scan${health.scans.length === 1 ? '' : 's'} over ${SCAN_STALE_DAYS} days old (${named}${health.scans.length > 3 ? '; …' : ''})`);
  }
  const failed = health.lastPass && !health.lastPass.ok;
  const old = health.scans.filter((p) => p.days > SCAN_WARN_DAYS);
  const fix = [failed ? `the last pass failed: ${health.lastPass.error}` : null, old.length > 0 ? `rescan: sumo project rescan ${old[0].slug}${old.length > 1 ? ` (and ${old.length - 1} more)` : ''}` : null].filter(Boolean).join('; ');
  return { ok: !failed && old.length === 0, label: `memory: ${parts.join(' · ')}`, fix };
}
