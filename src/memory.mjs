import { createHash } from 'node:crypto';
import { getMeta, setMeta, tx } from './db.mjs';
import { redact } from './redact.mjs';
import { cjkTerms, clip, containing, ftsAllQuery, ftsQuery, overlap, sharedStems, stem, termsHeld, words } from './text.mjs';
import { matchWithin } from './workflows.mjs';

/** How much of a search that found nothing is kept as the record of it. */
const MISS_KEPT = 200;
/** A search of several words that had to settle for any of them, and whose best result holds fewer of them than this, answered nothing. */
export const LOOSE_BELOW = 2;

const TYPES = ['preference', 'fact', 'decision', 'gotcha', 'procedure'];

const IMPORTANCE = { preference: 0.8, procedure: 0.8, decision: 0.7, gotcha: 0.6, fact: 0.5 };
const PROVENANCE_WEIGHT = { stated: 1, observed: 0.9, scanned: 0.7, inferred: 0.5 };
/**
 * Why a memory waits unconfirmed for the user: its conversation read the web or an MCP server ('outside', only the user
 * confirms), or the model saved from its shell what the user never typed ('shell').
 */
const HELD_FOR = ['outside', 'shell'];
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
 * One line of a memory's history (`memory_events`): what happened to it, when, by whom — `actor` is the writer of an
 * add, 'user' or 'model-shell' where the caller says who asked, else 'sumo' — and in which pass (`runId`, an
 * extractions row). Never the memory's words: the history outlives a purge of it.
 */
function noteEvent(db, id, op, { actor = 'sumo', runId = null, reason = null, now }) {
  db.prepare('INSERT INTO memory_events (ts, memory_id, op, actor, run_id, reason) VALUES (?, ?, ?, ?, ?, ?)').run(now, id, op, actor ?? 'sumo', runId ?? null, reason ?? null);
}

/**
 * Stores one memory. Returns it with any active memories that look like the
 * same statement, so the caller can supersede instead of piling up duplicates.
 * `derivedBy` is the extractor version that drew it from the journal (absent: primary, the user's to keep);
 * `runId` is the extractions row of the pass that filed it; `edit` says the memory it supersedes is this one reworded.
 */
export function add(db, input) {
  if (!TYPES.includes(input.type)) {
    throw new UsageError(`unknown type "${input.type}" — one of: ${TYPES.join(', ')}`);
  }
  // Held for the user, and only for one of two reasons: nothing else is ever unconfirmed — a guess is not kept.
  const heldFor = input.heldFor ?? null;
  if (heldFor !== null && !HELD_FOR.includes(heldFor)) throw new UsageError(`unknown reason to hold a memory "${heldFor}" — one of: ${HELD_FOR.join(', ')}`);
  const provenance = heldFor ? 'inferred' : (input.provenance ?? 'stated');
  if (!(provenance in PROVENANCE_WEIGHT)) throw new UsageError(`unknown provenance "${provenance}"`);
  if (provenance === 'inferred' && !heldFor) throw new UsageError('a guess is not kept: a memory is held for the user only with why (heldFor)');

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

    const writer = input.writtenBy ?? 'chat-model';
    const runId = input.runId ?? null;
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO memories (type, scope, title, cue, gate, body, topic, keys, provenance, state, pinned, importance,
                               scan_key, written_by, source_session, source_turn, source_quote, valid_from, created_at, derived_by, held_for)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        heldFor ? 'unconfirmed' : 'active',
        input.pin ? 1 : 0,
        IMPORTANCE[input.type],
        input.scanKey ?? null,
        writer,
        input.sourceSession ?? null,
        input.sourceTurn ?? null,
        input.sourceQuote ?? null,
        now,
        now,
        // Null is what the user said to remember; a version is what an extractor drew from the journal, and may be rebuilt.
        input.derivedBy ?? null,
        heldFor,
      );
    const id = Number(lastInsertRowid);
    noteEvent(db, id, 'added', { actor: writer, runId, now });
    // An edit is the user keeping the memory in other words: its history says so, and it is never counted as thrown out.
    if (replaced) markSuperseded(db, replaced.id, id, now, { actor: writer, runId, op: input.edit ? 'edited' : 'superseded' });

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

function markSuperseded(db, oldId, newId, now, { actor, runId, op = 'superseded' } = {}) {
  noteRetired(db, oldId);
  db.prepare(`UPDATE memories SET state = 'superseded', superseded_by = ?, invalid_at = ? WHERE id = ?`).run(
    newId,
    now,
    oldId,
  );
  noteEvent(db, oldId, op, { actor, runId, reason: `by m${newId}`, now });
}

/** Links two memories that already exist: `oldId` stops being true because of `newId`. `actor` and `runId` say who asked, and in which pass. */
export function supersede(db, oldId, newId, now = new Date().toISOString(), { actor, runId } = {}) {
  if (oldId === newId) throw new UsageError('a memory cannot supersede itself');
  return tx(db, () => {
    requireActive(db, oldId, 'superseded');
    requireActive(db, newId, 'the replacement');
    markSuperseded(db, oldId, newId, now, { actor, runId });
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

/** The fields of a memory that are searched, in the order the index holds them. */
const SEARCHED = ['title', 'cue', 'body', 'topic', 'keys'];
/**
 * How much a word found in each of them counts, in that order: a title and the search terms a writer added say what a
 * memory is about; a word somewhere in a long body says less.
 */
const RANKED = 'bm25(memories_fts, 3.0, 1.0, 1.0, 2.0, 2.0)';
const searchedText = (row) => SEARCHED.map((f) => row[f] ?? '').join(' ');

/**
 * What the index found, with the memories holding a Chinese, Japanese or Korean word of the search: the index keeps a
 * run of those characters as one word, so a word inside it is looked for in the text itself, under the same `filters`.
 * One found that way ranks by the share of those words it holds, the best the index found counting as all of them.
 * With no such word, the index alone answers, unchanged.
 */
function withCjk(db, terms, found, filters, params) {
  if (terms.length === 0) return found;
  const holds = terms.flatMap(() => SEARCHED.map((f) => `m.${f} LIKE ? ESCAPE '\\'`)).join(' OR ');
  const rows = db
    .prepare(`SELECT m.* FROM memories m WHERE (${holds})${filters.map((w) => ` AND ${w}`).join('')}`)
    .all(...terms.flatMap((t) => SEARCHED.map(() => containing(t))), ...params);
  const best = found.length > 0 ? found.reduce((min, row) => Math.min(min, row.rank), 0) : -1;
  const byId = new Map(found.map((row) => [row.id, row]));
  for (const row of rows) {
    const text = searchedText(row).toLowerCase();
    const rank = (best * terms.filter((t) => text.includes(t)).length) / terms.length;
    const known = byId.get(row.id);
    if (!known || rank < known.rank) byId.set(row.id, { ...row, rank });
  }
  return [...byId.values()];
}

/**
 * The memories under `filters` that hold every word of the search (`every`), or any of them. Every word: the index
 * answers for the words it keeps apart, and a Chinese, Japanese or Korean word must be in the text itself.
 */
function matching(db, query, every, filters, params) {
  const cjk = cjkTerms(query);
  const also = filters.map((w) => ` AND ${w}`).join('');
  const indexed = (match, extra = '', extraParams = []) =>
    db
      .prepare(`SELECT m.*, ${RANKED} AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid WHERE memories_fts MATCH ?${extra}${also}`)
      .all(match, ...extraParams, ...params);
  if (!every) return withCjk(db, cjk, indexed(ftsQuery(query)), filters, params);
  const holds = cjk.map(() => ` AND (${SEARCHED.map((f) => `m.${f} LIKE ? ESCAPE '\\'`).join(' OR ')})`).join('');
  const patterns = cjk.flatMap((t) => SEARCHED.map(() => containing(t)));
  const match = ftsAllQuery(query);
  if (match) return indexed(match, holds, patterns);
  // Only words the index cannot tell apart: the text itself answers, and none ranks above another.
  return db.prepare(`SELECT m.*, -1.0 AS rank FROM memories m WHERE 1 = 1${holds}${also}`).all(...patterns, ...params);
}

/** Keeps the record of what a search could not answer: without secrets, and short — a pasted log is not a question worth keeping whole. */
export function recordMiss(db, query, scope, now) {
  db.prepare('INSERT INTO search_misses (ts, query, scope) VALUES (?, ?, ?)').run(now, clip(redact(query).text, MISS_KEPT), scope);
}

/**
 * Ranked search. Scope is `global` plus the named project; other projects stay
 * invisible unless `everywhere` is set — only their hit counts come back, so
 * the caller learns where to look without one project's memory leaking into
 * another's work. `record: false` is for a search nobody asked for, or one whose
 * caller decides what was shown: it counts no hits and keeps no misses.
 * `since` and `before` (ISO times) hold it to a time: since, what was said or
 * last changed — replaced, let go — at or after it; before, what was said before it.
 *
 * All the words first: only when no memory in scope holds every one of them is it tried with any of them
 * (`fellBack`). `terms: 'all' | 'any'` asks for one of the two alone. `best` is the most of the search's words one of
 * the results holds; a search of several words that fell back and whose best holds fewer than two is `loose`: something
 * is shown, and it is still kept as a miss — one word in common is an accident, not an answer.
 */
export function search(db, query, opts = {}) {
  if (!ftsQuery(query)) throw new UsageError('nothing to search for');
  if (opts.type && !TYPES.includes(opts.type)) {
    // Said as the user knows them: a procedure is a workflow everywhere they look.
    throw new UsageError(`unknown type "${opts.type}" — one of: ${TYPES.map((t) => (t === 'procedure' ? 'workflow' : t)).join(', ')}`);
  }

  const projectScope = opts.project ? scopeFor(db, opts.project) : null;
  const now = opts.now ?? new Date().toISOString();
  const limit = opts.limit ?? 8;

  const where = [];
  const params = [];
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

  const inScope = (row) => opts.everywhere || row.scope === 'global' || row.scope === projectScope;
  // Any-word matches are on any one of them. Fine for words a caller picked; a caller searching with
  // words nobody picked — a sentence lifted from a reply — sets a floor on how many must be shared.
  const close = (row) => !opts.minShared || sharedStems(query, `${row.title ?? ''} ${row.cue ?? ''} ${row.body} ${row.keys ?? ''}`) >= opts.minShared;
  const several = new Set(words(query)).size > 1;
  let rows = [];
  let candidates = [];
  let fellBack = false;
  for (const every of opts.terms === 'any' ? [false] : opts.terms === 'all' || !several ? [true] : [true, false]) {
    rows = matching(db, query, every, where, params);
    candidates = rows.filter((row) => inScope(row) && close(row));
    fellBack = !every && opts.terms !== 'any';
    if (candidates.length > 0) break;
  }
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
  const best = results.reduce((most, row) => Math.max(most, termsHeld(query, searchedText(row))), 0);
  const loose = fellBack && results.length > 0 && best < LOOSE_BELOW;
  const found = { results, elsewhere, more, fellBack, best, loose };

  if (opts.record === false) return found;
  // Shown to someone who asked: used. What was matched and left out for scope or room was not.
  markHits(db, results.map((r) => r.id), now);
  // The record of what memory could not answer: the evidence for whether
  // keyword search is enough or embeddings are ever worth adding.
  if (results.length === 0 || loose) recordMiss(db, query, opts.everywhere ? 'everywhere' : (projectScope ?? 'global'), now);
  return found;
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
    INSERT INTO replies_fts(replies_fts, rank) VALUES ('secure-delete', 1);
  `);
}

const sameLetters = (text) => text.toLowerCase().replace(/\s+/g, ' ').trim();

/** A phrase shorter than both of these is too common to erase by: "we use bun" stands in conversations that are not about it. */
const PHRASE_MIN_WORDS = 5;
const PHRASE_MIN_CHARS = 25;

/**
 * Whether a text says any of `phrases` whole, whatever the case or the line breaks — a phrase counting only when it
 * is at least five words or twenty-five characters; never, when no phrase is that long.
 */
export function saying(phrases) {
  const needles = [...new Set(phrases.filter(Boolean).map(sameLetters))].filter((n) => n.length >= PHRASE_MIN_CHARS || n.split(' ').length >= PHRASE_MIN_WORDS);
  return (text) => needles.length > 0 && needles.some((n) => sameLetters(String(text ?? '')).includes(n));
}

const hasTable = (db, name) => db.prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`).get(name) !== undefined;

/**
 * What of the journal a purge of this memory erases: the turn it cites, and every turn and reply, in any
 * conversation, that holds its whole body or the whole of the words it was drawn from — when that phrase is long
 * enough to be this memory's and not three words any conversation may hold (`saying`). A purge once took a long
 * plan in another conversation with a memory that said "we use bun". What only mentions part of it stays, and the
 * purge says so. `{ source, turns, replies, sessions }`: `source` the cited turn's id when it is here; `turns` and
 * `replies` as `{ id, ts, text }`, to be shown before they go.
 */
export function purgeReach(db, row) {
  const says = saying([row.source_quote, row.body]);
  const source = row.source_turn === null || row.source_turn === undefined ? null : (db.prepare('SELECT id, session_id FROM user_turns WHERE id = ?').get(row.source_turn) ?? null);
  const turns = [];
  const replies = [];
  const sessions = new Set([row.source_session ?? source?.session_id].filter(Boolean));
  // One row at a time: a journal of pasted logs is not read into memory whole.
  for (const t of db.prepare('SELECT id, session_id, ts, text FROM user_turns ORDER BY id').iterate()) {
    if (t.id !== source?.id && !says(t.text)) continue;
    turns.push({ id: t.id, ts: t.ts, text: t.text });
    sessions.add(t.session_id);
  }
  // A copy from before replies were kept has none.
  if (hasTable(db, 'replies')) {
    for (const r of db.prepare('SELECT id, session_id, ts, text FROM replies ORDER BY id').iterate()) {
      if (!says(r.text)) continue;
      replies.push({ id: r.id, ts: r.ts, text: r.text });
      sessions.add(r.session_id);
    }
  }
  return { source: source?.id ?? null, turns, replies, sessions: [...sessions] };
}

/** Every string a value holds, at any depth. */
const stringsIn = (value) => (typeof value === 'string' ? [value] : value && typeof value === 'object' ? Object.values(value).flatMap(stringsIn) : []);

/** What the passes proposed (`extractions.ops_json`) cleared wherever `which(row)` says: they keep that they ran. Returns how many. */
function clearProposals(db, which) {
  if (!hasTable(db, 'extractions')) return 0;
  let cleared = 0;
  for (const x of db.prepare('SELECT id, session_id, ops_json FROM extractions WHERE ops_json IS NOT NULL').all()) {
    if (!which(x)) continue;
    db.prepare('UPDATE extractions SET ops_json = NULL WHERE id = ?').run(x.id);
    cleared++;
  }
  return cleared;
}

/**
 * Erases what `purgeReach` finds, and what the passes over those conversations proposed: a pass keeps the model's
 * answer, the quote among it — those of the conversations touched, of the passes that filed the memory (`runs`), and
 * any other whose answer says it. The same rule for the database and for each backup. Returns the reach, with `ops`
 * the answers cleared.
 */
export function eraseSaid(db, row, { runs = [] } = {}) {
  const reach = purgeReach(db, row);
  for (const { id } of reach.turns) db.prepare('DELETE FROM user_turns WHERE id = ?').run(id);
  for (const { id } of reach.replies) db.prepare('DELETE FROM replies WHERE id = ?').run(id);
  const says = saying([row.source_quote, row.body]);
  const proposed = (json) => {
    try {
      return stringsIn(JSON.parse(json));
    } catch {
      return [json];
    }
  };
  const ops = clearProposals(db, (x) => reach.sessions.includes(x.session_id) || runs.includes(x.id) || proposed(x.ops_json).some(says));
  return { ...reach, ops };
}

const JOURNAL_TABLE = { turn: 'user_turns', reply: 'replies' };

/**
 * One turn or reply erased from a database — this one, or a backup: the row with that id and those very words (in a
 * copy, the number alone may be another row), and what the passes over its conversation proposed. False when the
 * row is not there.
 */
export function eraseRow(db, { kind, id, text, session_id: session }) {
  const table = JOURNAL_TABLE[kind];
  if (!hasTable(db, table) || Number(db.prepare(`DELETE FROM ${table} WHERE id = ? AND text = ?`).run(id, text).changes) === 0) return false;
  clearProposals(db, (x) => x.session_id === session);
  return true;
}

/**
 * `sumo forget --purge t12`: one turn or reply erased for good — what a memory's purge leaves when a conversation
 * only mentions part of it. `entry` is the journal row (`journalEntry` in sessions.mjs). Returns the ids of the
 * memories that cite the turn: they hold its words still, and are the user's to purge or keep.
 */
export function purgeRow(db, entry) {
  const cites = entry.kind === 'turn' ? db.prepare('SELECT id FROM memories WHERE source_turn = ? ORDER BY id').all(entry.id).map((m) => m.id) : [];
  tx(db, () => {
    eraseFromIndexes(db);
    eraseRow(db, entry);
  });
  // As for a memory: the write-ahead log still holds the pages as they were.
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  return cites;
}

/**
 * Stops a memory being true. With `purge` it is erased outright, for things that should never have been stored: the
 * memory, the sentence it came from, and every turn and reply of the journal that says it whole (`eraseSaid`;
 * `erased_turns` and `erased_replies` are those rows). `actor`, `runId` and `reason` go into its history; `op`
 * names a letting-go that is not the user's.
 */
export function forget(db, id, { purge = false, now = new Date().toISOString(), actor, runId, reason, op = 'forgotten' } = {}) {
  const row = get(db, id);
  if (purge) {
    let erased = null;
    tx(db, () => {
      eraseFromIndexes(db);
      // A scanned fact let go for good stays let go: only its digest is kept, never its words.
      noteRetired(db, id);
      const runs = db.prepare('SELECT run_id FROM memory_events WHERE memory_id = ? AND run_id IS NOT NULL').all(id).map((e) => e.run_id);
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      // Erasing the memory but keeping the sentence it came from, or an answer that said it back, would not be erasing it.
      erased = eraseSaid(db, row, { runs });
      noteEvent(db, id, 'purged', { actor, runId, now });
    });
    // The write-ahead log still holds the pages as they were before the delete; copy it into the file and empty it.
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    return { ...row, state: 'purged', erased_source: erased.source, erased_turns: erased.turns, erased_replies: erased.replies };
  }
  if (row.state === 'invalid') return row;
  return tx(db, () => {
    noteRetired(db, id);
    db.prepare(`UPDATE memories SET state = 'invalid', invalid_at = ? WHERE id = ?`).run(now, id);
    noteEvent(db, id, op, { actor, runId, reason, now });
    return get(db, id);
  });
}

/**
 * The user said yes to a memory held for them: from here on it carries the weight of something they stated, and it is
 * theirs — primary (`derived_by` cleared), never rebuilt with what an extractor drew.
 */
export function confirm(db, id, { byUser = true, now = new Date().toISOString() } = {}) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new Refusal(`m${id} is ${row.state} — only an unconfirmed memory can be confirmed`);
  // Held because what it says came from a page or an MCP server the model read: the model may not vouch for it.
  if (row.held_for === 'outside' && !byUser) throw new Refusal(`m${id} came from a conversation that read the web or an MCP server: only the user confirms it — on the memory page (/memory), or with sumo confirm in their own terminal`);
  return tx(db, () => {
    db.prepare(`UPDATE memories SET state = 'active', provenance = 'stated', derived_by = NULL WHERE id = ?`).run(id);
    noteEvent(db, id, 'confirmed', { actor: byUser ? 'user' : 'model-shell', now });
    return get(db, id);
  });
}

export function reject(db, id, now = new Date().toISOString(), { actor } = {}) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new Refusal(`m${id} is ${row.state} — only an unconfirmed memory can be rejected`);
  return tx(db, () => {
    db.prepare(`UPDATE memories SET state = 'rejected', invalid_at = ? WHERE id = ?`).run(now, id);
    noteEvent(db, id, 'rejected', { actor, now });
    return get(db, id);
  });
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
    for (const { id } of unused) forget(db, id, { now, op: 'expired', reason: `never shown in ${GOTCHA_UNUSED_DAYS} days` });
  });
  return unused.length;
}
