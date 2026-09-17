import { tx } from './db.mjs';
import * as memory from './memory.mjs';
import { line } from './render.mjs';
import { addCheckpoint, currentProject } from './sessions.mjs';
import { overlap, sameWords } from './text.mjs';

/**
 * The only door through which a model's suggestion becomes a memory.
 *
 * A model proposes; this code decides. Nothing here trusts the model's word:
 * a claim that the user said something is checked against what the user
 * actually typed, and anything that cannot be checked is held back as a guess
 * for the user to confirm. One bad operation is dropped and logged; it never
 * takes the good ones down with it.
 */

const STATED_TYPES = ['preference', 'fact', 'decision'];
const BODY_MAX = 300;
/** Enough to be unmistakable, short enough that a real "no emojis" still counts. */
const QUOTE_MIN_WORDS = 2;
const QUOTE_MIN_CHARS = 6;
/** A paraphrase shares words with its source. Below this, the quote is real but the claim is about something else. */
const BODY_MATCHES_TURN = 0.34;
const SAME_STATEMENT = 0.8;
/** "use eslint for linting" / "use biome for linting": three words of four. Close enough to ask about, too different to call a repeat. */
const LOOKS_ALIKE = 0.7;
const SAME_FROM_TURN = 0.6;

const OPS_BY_SOURCE = {
  scribe: ['add', 'supersede', 'gotcha', 'checkpoint'],
  dream: ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'procedure'],
  // A delegated sub-agent's report: it may tell us about traps it hit, and nothing else.
  worker: ['gotcha'],
};

class Rejected extends Error {}

const normalize = (text) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function resolveScope(db, scope) {
  if (scope === 'global' || scope === undefined) return { scope: 'global', project: undefined };
  const match = /^project:(.+)$/.exec(String(scope));
  if (!match) throw new Rejected(`scope "${scope}" is neither global nor project:<name>`);
  try {
    const slug = memory.resolveProject(db, match[1]);
    return { scope: `project:${slug}`, project: slug };
  } catch {
    throw new Rejected(`unknown project in scope "${scope}"`);
  }
}

function cleanBody(op) {
  const body = typeof op.body === 'string' ? op.body.replace(/\s+/g, ' ').trim() : '';
  if (!body) throw new Rejected('empty body');
  if (body.length > BODY_MAX) throw new Rejected(`body over ${BODY_MAX} characters — a memory is one statement`);
  return body;
}

/**
 * Did the user really say it? The quoted words must appear in something the
 * user typed, and the memory must be about that sentence. The turn the model
 * names is tried first, then every other turn it was shown: models mix up turn
 * numbers, and the words being the user's own is what matters, not the label.
 */
function verify(op, body, turns) {
  const named = turns.get(Number(op.turn)) ?? null;
  if (typeof op.quote !== 'string' || !op.quote.trim()) return { turn: named, verified: false, why: 'no quote given' };
  const quote = normalize(op.quote);
  if (quote.length < QUOTE_MIN_CHARS || quote.split(' ').length < QUOTE_MIN_WORDS) return { turn: named, verified: false, why: 'the quote is too short to prove anything' };

  const candidates = [...(named ? [named] : []), ...[...turns.values()].filter((t) => t !== named)];
  const source = candidates.find((t) => normalize(t.text).includes(quote));
  if (!source) return { turn: named, verified: false, why: 'the user never typed the quoted words' };
  if (overlap(body, source.text) < BODY_MATCHES_TURN) return { turn: source, verified: false, why: 'the quote is real but the memory is about something else' };
  return { turn: source, verified: true, why: null };
}

/**
 * A memory in this scope that looks like this one. `same` means it says the same thing in the same
 * words. Merely looking alike is a different and more dangerous case: "slate uses pnpm" and "slate
 * uses bun" share every word but one, and the second is a correction, not a repeat. Treating it as
 * already known would leave memory wrong for good — so look-alikes are never dropped, only flagged.
 */
function lookalike(db, scope, body, exclude) {
  const inScope = db
    .prepare(`SELECT * FROM memories WHERE scope = ? AND type != 'procedure' AND state IN ('active', 'unconfirmed', 'rejected') AND id IS NOT ?`)
    .all(scope, exclude ?? null);
  const same = inScope.find((m) => sameWords(body, m.body) >= SAME_STATEMENT);
  if (same) return { memory: same, same: true };
  const alike = inScope.find((m) => m.state === 'active' && overlap(body, m.body) >= LOOKS_ALIKE);
  return alike ? { memory: alike, same: false } : null;
}

/** The same sentence is often proposed twice from one turn — once by a retry, once by the chat model saving it directly. */
function savedFromTurn(db, turnId, body, exclude) {
  if (turnId === null) return null;
  const fromTurn = db.prepare(`SELECT * FROM memories WHERE source_turn = ? AND state != 'unconfirmed' AND id IS NOT ?`).all(turnId, exclude ?? null);
  return fromTurn.find((m) => overlap(body, m.body) >= SAME_FROM_TURN) ?? null;
}

/** Two active memories that look alike but are not the same: only the user can say whether one replaces the other. */
function flagLookalike(db, saved, other, now) {
  const [lo, hi] = saved.id < other.id ? [saved.id, other.id] : [other.id, saved.id];
  if (db.prepare('SELECT 1 FROM notices WHERE memory_a = ? AND memory_b = ?').get(lo, hi)) return;
  db.prepare(`INSERT INTO notices (kind, memory_a, memory_b, note, created_at) VALUES ('lookalike', ?, ?, ?, ?)`).run(
    lo, hi, 'they look alike — if the newer one replaces the older, supersede it; if both hold, leave them', now,
  );
}

/** The user has now said, in so many words, what was only a guess: the guess becomes a stated memory. */
function promote(db, guess, { turn, quote, supersedes, now }) {
  db.prepare(`UPDATE memories SET state = 'active', provenance = 'stated', source_session = ?, source_turn = ?, source_quote = ? WHERE id = ?`).run(
    turn.session_id, turn.id, quote, guess.id,
  );
  if (supersedes !== undefined) memory.supersede(db, supersedes, guess.id, now);
  return memory.get(db, guess.id);
}

function addStated(db, op, ctx, { supersedes } = {}) {
  if (!STATED_TYPES.includes(op.type)) throw new Rejected(`type "${op.type}" cannot come from a model — one of: ${STATED_TYPES.join(', ')}`);
  const body = cleanBody(op);
  const { turn, verified, why } = verify(op, body, ctx.turns);
  // No scope given: what was said in the middle of work on a project belongs to that project.
  const focus = op.scope === undefined && turn ? currentProject(db, turn.session_id) : null;
  const { scope, project } = resolveScope(db, focus ? `project:${focus}` : op.scope);

  const again = savedFromTurn(db, turn?.id ?? null, body, supersedes);
  if (again) throw new Rejected(`already saved from this turn as m${again.id}`);

  // What is being replaced naturally resembles its replacement, so it is left out of the comparison.
  const twin = lookalike(db, scope, body, supersedes);
  if (twin?.same) {
    const known = twin.memory;
    if (known.state === 'unconfirmed' && verified) {
      return `saved ${line(promote(db, known, { turn, quote: op.quote.trim(), supersedes, now: ctx.now }))}`;
    }
    if (known.state === 'active' && verified && supersedes !== undefined) {
      // The statement was filed earlier; only now is it clear what it replaces.
      memory.supersede(db, supersedes, known.id, ctx.now);
      return `m${known.id} now replaces m${supersedes}`;
    }
    if (known.state === 'rejected' && !verified) throw new Rejected(`the user already said no to this (m${known.id})`);
    if (known.state !== 'rejected') throw new Rejected(`already known as m${known.id}`);
  }

  const { memory: saved } = memory.add(db, {
    type: op.type,
    body,
    project,
    topic: typeof op.topic === 'string' ? op.topic : undefined,
    provenance: verified ? 'stated' : 'inferred',
    // A guess must never be able to hide something true: only a verified statement supersedes.
    supersedes: verified ? supersedes : undefined,
    writtenBy: ctx.source,
    sourceSession: turn?.session_id ?? null,
    sourceTurn: turn?.id ?? null,
    sourceQuote: verified ? op.quote.trim() : null,
    now: ctx.now,
  });
  if (verified && twin && !twin.same) flagLookalike(db, saved, twin.memory, ctx.now);
  return verified ? `saved ${line(saved)}` : `held for confirmation ${line(saved)} — ${why}`;
}

const HANDLERS = {
  add: (db, op, ctx) => addStated(db, op, ctx),

  supersede(db, op, ctx) {
    const old = db.prepare('SELECT * FROM memories WHERE id = ?').get(Number(op.old)) ?? null;
    const type = STATED_TYPES.includes(op.type) ? op.type : STATED_TYPES.includes(old?.type) ? old.type : 'fact';
    // A real statement aimed at the wrong target — a memory that is gone, or one about something
    // else — is still a real statement. It is kept; it just does not get to replace anything.
    const related = old?.state === 'active' && overlap(cleanBody(op), old.body) >= BODY_MATCHES_TURN;
    if (!related) return addStated(db, { ...op, type }, ctx);
    return addStated(db, { ...op, scope: op.scope ?? old.scope, type }, ctx, { supersedes: old.id });
  },

  /** Something learned by doing the work, not something the user said — so no quote, and only this one kind. */
  gotcha(db, op, ctx) {
    const body = cleanBody(op);
    const { scope, project } = resolveScope(db, op.scope);
    const twin = lookalike(db, scope, body);
    if (twin?.same) throw new Rejected(`already known as m${twin.memory.id}`);
    const { memory: saved } = memory.add(db, { type: 'gotcha', body, project, provenance: 'observed', writtenBy: ctx.source, now: ctx.now });
    return `saved ${line(saved)}`;
  },

  checkpoint(db, op, ctx) {
    let project;
    try {
      project = memory.resolveProject(db, String(op.project ?? ''));
    } catch {
      throw new Rejected(`checkpoint for unknown project "${op.project}"`);
    }
    const done = typeof op.done === 'string' ? op.done.replace(/\s+/g, ' ').trim().slice(0, BODY_MAX) : '';
    if (!done) throw new Rejected('checkpoint says nothing was done');
    const next = typeof op.next === 'string' && op.next.trim() ? op.next.replace(/\s+/g, ' ').trim().slice(0, 200) : null;
    addCheckpoint(db, { sessionId: ctx.sessionId ?? null, project, done, next, now: ctx.now });
    return `checkpoint ${project}: ${done}${next ? ` → next: ${next}` : ''}`;
  },

  /** Two memories that cannot both be true. Never resolved here: only the user knows which one is. */
  contradiction(db, op, ctx) {
    const [a, b] = (Array.isArray(op.ids) ? op.ids : []).map(Number);
    if (!a || !b || a === b) throw new Rejected('a contradiction names two different memories');
    for (const id of [a, b]) if (memory.get(db, id).state !== 'active') throw new Rejected(`m${id} is not active`);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    if (db.prepare('SELECT 1 FROM notices WHERE memory_a = ? AND memory_b = ?').get(lo, hi)) throw new Rejected('already raised');
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.trim().slice(0, 200) : 'they cannot both be true';
    db.prepare(`INSERT INTO notices (kind, memory_a, memory_b, note, created_at) VALUES ('contradiction', ?, ?, ?, ?)`).run(lo, hi, note, ctx.now);
    return `raised for the user: m${lo} vs m${hi} — ${note}`;
  },

  /** A workflow the model thinks it saw the user repeat. Always a proposal. */
  procedure(db, op, ctx) {
    const title = typeof op.title === 'string' ? op.title.trim() : '';
    const body = typeof op.body === 'string' ? op.body.trim() : '';
    if (!title || !body) throw new Rejected('a procedure needs a title and steps');
    const { scope, project } = resolveScope(db, op.scope);
    const existing = db.prepare(`SELECT * FROM memories WHERE scope = ? AND type = 'procedure' AND state IN ('active', 'unconfirmed', 'rejected')`).all(scope);
    const twin = existing.find((m) => overlap(title, m.title) >= SAME_STATEMENT);
    if (twin) throw new Rejected(`a workflow like this exists already (m${twin.id}, ${twin.state})`);
    const { memory: saved } = memory.add(db, {
      type: 'procedure', title, cue: typeof op.cue === 'string' ? op.cue : undefined, body: body.slice(0, 2000), project,
      provenance: 'inferred', writtenBy: ctx.source, now: ctx.now,
    });
    return `held for confirmation ${line(saved)}`;
  },
};

/**
 * @param ops      what the model returned
 * @param ctx.source   'scribe' | 'dream' — decides which operations are even allowed
 * @param ctx.turns    Map of turn id → user_turns row the model was shown
 */
export function applyOps(db, ops, ctx) {
  const applied = [];
  const dropped = [];
  if (!Array.isArray(ops)) return { applied, dropped: ['the answer had no list of operations'] };
  const allowed = OPS_BY_SOURCE[ctx.source] ?? [];

  tx(db, () => {
    for (const op of ops) {
      const name = op?.op;
      try {
        if (!allowed.includes(name)) throw new Rejected(`operation "${name}" is not allowed from ${ctx.source}`);
        applied.push(HANDLERS[name](db, op, ctx));
      } catch (cause) {
        // Rejected and UsageError are verdicts on the model's suggestion; anything else is a bug and must surface.
        if (!(cause instanceof Rejected) && !(cause instanceof memory.UsageError)) throw cause;
        dropped.push(`${name ?? '?'}: ${cause.message}`);
      }
    }
  });
  return { applied, dropped };
}
