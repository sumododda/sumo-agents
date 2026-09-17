import { tx } from './db.mjs';
import { redact } from './redact.mjs';
import { ftsQuery, overlap, sharedStems } from './text.mjs';

export const TYPES = ['preference', 'fact', 'decision', 'gotcha', 'procedure'];

const IMPORTANCE = { preference: 0.8, procedure: 0.8, decision: 0.7, gotcha: 0.6, fact: 0.5 };
const PROVENANCE_WEIGHT = { stated: 1, observed: 0.9, scanned: 0.7, inferred: 0.5 };
/** Days for a memory's rank to fall to 1/e. Absent means it does not age: a preference stays true until superseded. */
const DECAY_DAYS = { fact: 365, gotcha: 365 };
const PROJECT_MATCH_BOOST = 1.5;
const OTHER_PROJECT_PENALTY = 0.5;
const SIMILAR_OVERLAP = 0.5;

/** Commands no gate may ever catch: a pattern that matches these would hold back everything. */
const NEVER_GATED = ['', 'ls', 'cd src', 'git status', 'cat README.md'];

/** A mistake in how `mem` was called (exit 2), as opposed to something going wrong (exit 1). */
export class UsageError extends Error {}

/**
 * A gate is a regular expression over a shell command: the commands a workflow has to come before.
 * It is written once, by whoever teaches the workflow, and shown to the user — stated, not guessed.
 */
export function checkGate(raw) {
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
  return pattern;
}

export function setGate(db, id, raw) {
  const row = get(db, id);
  if (row.type !== 'procedure') throw new UsageError(`m${id} is not a workflow — only a workflow can gate a command`);
  const gate = raw === null ? null : checkGate(raw);
  db.prepare('UPDATE memories SET gate = ? WHERE id = ?').run(gate, id);
  return get(db, id);
}

export function parseId(raw) {
  const match = /^m?(\d+)$/.exec(String(raw ?? '').trim());
  if (!match) throw new UsageError(`"${raw}" is not a memory id — ids look like m12`);
  return Number(match[1]);
}

export function resolveProject(db, nameOrAlias) {
  const key = nameOrAlias.toLowerCase();
  const row =
    db.prepare('SELECT slug FROM projects WHERE slug = ?').get(key) ??
    db.prepare('SELECT slug FROM project_aliases WHERE alias = ?').get(key);
  if (!row) {
    throw new UsageError(`unknown project "${nameOrAlias}" — register it first: mem project add <path>`);
  }
  return row.slug;
}

function scopeFor(db, project) {
  return project ? `project:${resolveProject(db, project)}` : 'global';
}

export function get(db, id) {
  const row = db.prepare('SELECT * FROM memories WHERE id = ?').get(id);
  if (!row) throw new UsageError(`no memory m${id}`);
  return row;
}

function requireActive(db, id, verb) {
  const row = get(db, id);
  if (row.state !== 'active') throw new UsageError(`m${id} is ${row.state} — only an active memory can be ${verb}`);
  return row;
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

  const cleaned = redact(input.body ?? '');
  // A memory is one statement; only a procedure is allowed to be a document.
  const body = input.type === 'procedure' ? cleaned.text.trim() : cleaned.text.replace(/\s+/g, ' ').trim();
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
        `INSERT INTO memories (type, scope, title, cue, gate, body, topic, provenance, state, pinned, importance,
                               scan_key, written_by, source_session, source_turn, source_quote, valid_from, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        input.type,
        scope,
        input.title?.trim() || null,
        input.cue?.trim() || null,
        gate,
        body,
        input.topic?.trim().toLowerCase() || null,
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

    return { memory: get(db, id), similar, redacted: cleaned.count };
  });
}

function markSuperseded(db, oldId, newId, now) {
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

/**
 * Ranked search. Scope is `global` plus the named project; other projects stay
 * invisible unless `everywhere` is set — only their hit counts come back, so
 * the caller learns where to look without one project's memory leaking into
 * another's work.
 */
export function search(db, query, opts = {}) {
  const match = ftsQuery(query);
  if (!match) throw new UsageError('nothing to search for');
  if (opts.type && !TYPES.includes(opts.type)) {
    throw new UsageError(`unknown type "${opts.type}" — one of: ${TYPES.join(', ')}`);
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

  const rows = db
    .prepare(
      `SELECT m.*, bm25(memories_fts) AS rank FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
       WHERE ${where.join(' AND ')}`,
    )
    .all(...params);

  const inScope = (row) => opts.everywhere || row.scope === 'global' || row.scope === projectScope;
  // OR-ed words match on any one of them. Fine for words a caller picked; a caller searching with
  // words nobody picked — a sentence lifted from a reply — sets a floor on how many must be shared.
  const close = (row) => !opts.minShared || sharedStems(query, `${row.title ?? ''} ${row.cue ?? ''} ${row.body}`) >= opts.minShared;
  const candidates = rows.filter((row) => inScope(row) && close(row));
  const bestRank = Math.min(...candidates.map((row) => row.rank));
  const results = candidates
    .map((row) => ({ ...row, score: score(row, { projectScope, now, bestRank }) }))
    .sort((a, b) => b.score - a.score || b.id - a.id)
    .slice(0, limit);

  const elsewhere = {};
  for (const row of rows) if (!inScope(row)) elsewhere[row.scope] = (elsewhere[row.scope] ?? 0) + 1;

  if (results.length > 0) {
    const ids = results.map((r) => r.id);
    db.prepare(
      `UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id IN (${ids.map(() => '?').join(', ')})`,
    ).run(now, ...ids);
  } else {
    // The record of what memory could not answer: the evidence for whether
    // keyword search is enough or embeddings are ever worth adding.
    db.prepare('INSERT INTO search_misses (ts, query, scope) VALUES (?, ?, ?)').run(
      now,
      query,
      opts.everywhere ? 'everywhere' : (projectScope ?? 'global'),
    );
  }

  return { results, elsewhere };
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

/** Stops a memory being true. With `purge` it is erased outright, for things that should never have been stored. */
export function forget(db, id, { purge = false, now = new Date().toISOString() } = {}) {
  const row = get(db, id);
  if (purge) {
    tx(db, () => {
      db.prepare('DELETE FROM memories WHERE id = ?').run(id);
      // Erasing the memory but keeping the sentence it came from would not be erasing it.
      if (row.source_turn !== null) db.prepare('DELETE FROM user_turns WHERE id = ?').run(row.source_turn);
    });
    return { ...row, state: 'purged' };
  }
  if (row.state === 'invalid') return row;
  db.prepare(`UPDATE memories SET state = 'invalid', invalid_at = ? WHERE id = ?`).run(now, id);
  return get(db, id);
}

/** The user said yes to a guess: from here on it carries the weight of something they stated. */
export function confirm(db, id) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new UsageError(`m${id} is ${row.state} — only an unconfirmed memory can be confirmed`);
  db.prepare(`UPDATE memories SET state = 'active', provenance = 'stated' WHERE id = ?`).run(id);
  return get(db, id);
}

export function reject(db, id, now = new Date().toISOString()) {
  const row = get(db, id);
  if (row.state !== 'unconfirmed') throw new UsageError(`m${id} is ${row.state} — only an unconfirmed memory can be rejected`);
  db.prepare(`UPDATE memories SET state = 'rejected', invalid_at = ? WHERE id = ?`).run(now, id);
  return get(db, id);
}
