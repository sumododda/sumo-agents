import { getMeta, setMeta, tx } from './db.mjs';
import * as memory from './memory.mjs';
import { line } from './render.mjs';
import { addCheckpoint, currentProject, outsideReadsOf } from './sessions.mjs';
import { asksForWork, onlyAlternative, overlap, sameWayRound, sharedStems } from './text.mjs';

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
/** What the slow pass proposes from a sentence already filed is that memory again when it shares this much with it. */
const ALREADY_FILED = 0.5;
/** "use eslint for linting" / "use biome for linting": three words of four. Close enough to ask about, too different to call a repeat. */
const LOOKS_ALIKE = 0.7;

/**
 * How much of memory the slow pass may retire in one go. A playbook a model was asked to rewrite whole shrank to a
 * fraction of itself, and the agent did worse with it than with none. A few replacements a pass — a correction the user
 * kept repeating — are its job; past either bound it is rewriting, and none of its replacements is taken.
 */
const MAX_RETIRED = 10;
const MAX_RETIRED_SHARE = 0.25;
/** What retires a memory. Everything else a pass may do only adds. */
const RETIRING = ['supersede'];

const OPS_BY_SOURCE = {
  scribe: ['add', 'supersede', 'gotcha', 'checkpoint'],
  dream: ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'same', 'procedure'],
  // A delegated sub-agent's report: it may tell us about traps it hit, and nothing else.
  worker: ['gotcha'],
};

class Rejected extends Error {}

const normalize = (text) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

/**
 * The sentences a quote was taken from, whole: the shortest run of the turn's sentences that holds every quoted word.
 * The model picks where a quote starts and ends; what the user was doing in that sentence is not its to trim away.
 */
function sentencesAround(text, quote) {
  const sentences = text.split(/(?<=[.!?])\s+|\n+/).map(normalize).filter(Boolean);
  // One pass: where each sentence starts in the turn as normalized, then the ones the quote's span touches.
  const starts = [];
  let at = 0;
  for (const s of sentences) {
    starts.push(at);
    at += s.length + 1;
  }
  const from = sentences.join(' ').indexOf(normalize(quote));
  if (from === -1) return text;
  const to = from + normalize(quote).length;
  return sentences.filter((s, i) => starts[i] < to && starts[i] + s.length > from).join(' ');
}

/** The clauses of the quote's sentence that the quote touches, whole — split at commas, semicolons, colons, dashes and "but". */
function clausesAround(text, quote) {
  const sentence = sentencesAround(text, quote);
  const q = normalize(quote);
  const from = sentence.indexOf(q);
  if (from === -1) return sentence;
  const to = from + q.length;
  const parts = [];
  const cut = /[,;:]|\s[—–-]\s|\sbut\s/g;
  let start = 0;
  for (const m of sentence.matchAll(cut)) {
    parts.push([start, m.index]);
    start = m.index + m[0].length;
  }
  parts.push([start, sentence.length]);
  // The touched clauses are side by side: one slice of the sentence keeps the commas between them, which say what is set aside.
  const touched = parts.filter(([a, b]) => a < to && b > from);
  return sentence.slice(touched[0][0], touched.at(-1)[1]).trim();
}

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
  // The words, without the quote marks or the full stop a model may put round them.
  const said = op.quote.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.!?]+$/, '');
  const quote = normalize(said);
  if (quote.length < QUOTE_MIN_CHARS || quote.split(' ').length < QUOTE_MIN_WORDS) return { turn: named, verified: false, why: 'the quote is too short to prove anything' };

  const candidates = [...(named ? [named] : []), ...[...turns.values()].filter((t) => t !== named)];
  const source = candidates.find((t) => normalize(t.text).includes(quote));
  if (!source) return { turn: named, verified: false, why: 'the user never typed the quoted words' };
  if (overlap(body, source.text) < BODY_MATCHES_TURN) return { turn: source, verified: false, why: 'the quote is real but the memory is about something else' };
  // The user's words, turned round — "never" filed from an "always" — are not the user's word. Judged on the clauses the quote
  // is in, whole: "we use biome now, not eslint" negates the old tool, not the rule; a quote cut short of its "never" still has it.
  // An alternative set aside ("…, never npm") is looked for in the whole sentence: a quote that stops at the comma left it
  // there. A quote of nothing but the alternative is judged with the sentence it is set against.
  const sentence = sentencesAround(source.text, said);
  const clauses = clausesAround(source.text, said);
  if (!sameWayRound(body, onlyAlternative(clauses) ? sentence : clauses, sentence)) return { turn: source, verified: false, why: 'the quote is real but the memory says it the other way round' };
  return { turn: source, verified: true, why: null };
}

/**
 * A memory in this scope that looks like this one. `same` means it says the same thing in the same
 * words. Merely looking alike is a different and more dangerous case: "slate uses pnpm" and "slate
 * uses bun" share every word but one, and the second is a correction, not a repeat. Treating it as
 * already known would leave memory wrong for good — so look-alikes are never dropped, only flagged.
 */
// Identifier case and punctuation carry meaning (Release/release, feature/a/feature-a).
const statementOf = (text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();

function lookalike(db, scope, body, exclude) {
  const inScope = db
    .prepare(`SELECT * FROM memories WHERE scope = ? AND type != 'procedure' AND state IN ('active', 'unconfirmed', 'rejected') AND id IS NOT ?`)
    .all(scope, exclude ?? null);
  // Only the same statement is a repeat: case and punctuation can change a branch, path or version.
  const said = statementOf(body);
  const same = inScope.find((m) => statementOf(m.body) === said);
  if (same) return { memory: same, same: true };
  const alike = inScope.find((m) => m.state === 'active' && overlap(body, m.body) >= LOOKS_ALIKE);
  return alike ? { memory: alike, same: false } : null;
}

/** A guess already put to the user in other words — still waiting, or refused: asked once is enough. */
function askedBefore(db, scope, body) {
  const asked = db.prepare(`SELECT * FROM memories WHERE scope = ? AND type != 'procedure' AND state IN ('unconfirmed', 'rejected')`).all(scope);
  return asked.find((m) => statementOf(m.body) !== statementOf(body) && overlap(body, m.body) >= LOOKS_ALIKE) ?? null;
}

/**
 * The same sentence is often proposed twice from one turn — once by a retry, once by the chat model saving it directly.
 * A repeat quotes the same words; two rules given in one sentence quote different ones, and are both kept.
 */
function savedFromTurn(db, turnId, scope, body, exclude, quote) {
  if (turnId === null) return null;
  const fromTurn = db.prepare(`SELECT * FROM memories WHERE source_turn = ? AND scope = ? AND state != 'unconfirmed' AND id IS NOT ?`).all(turnId, scope, exclude ?? null);
  const said = typeof quote === 'string' ? normalize(quote) : '';
  const quotesAgree = (m) => {
    const theirs = m.source_quote ? normalize(m.source_quote) : '';
    return !said || !theirs || said.includes(theirs) || theirs.includes(said);
  };
  return fromTurn.find((m) => statementOf(body) === statementOf(m.body) && quotesAgree(m)) ?? null;
}

/**
 * Something only the user can settle about two memories, put in the block until it stops being true: `lookalike` or
 * `contradiction`, the pair stored lowest id first. One pair is raised once, whatever its kind; false when it already was.
 */
export function raiseNotice(db, { kind, a, b, note, now }) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (db.prepare('SELECT 1 FROM notices WHERE memory_a = ? AND memory_b = ?').get(lo, hi)) return false;
  db.prepare('INSERT INTO notices (kind, memory_a, memory_b, note, created_at) VALUES (?, ?, ?, ?, ?)').run(kind, lo, hi, note, now);
  return true;
}

/** Where the pairs a pass named wait to be judged on their own. */
const NAMED_PAIRS = 'dream.named_pairs';

/** The pairs a pass named that wait to be judged on their own, in the order named: `{ label, a, b, note }`, a < b. */
export function namedPairs(db) {
  try {
    const named = JSON.parse(getMeta(db, NAMED_PAIRS) ?? '[]');
    return Array.isArray(named) ? named.filter((p) => Number.isInteger(p?.a) && Number.isInteger(p?.b)) : [];
  } catch {
    return [];
  }
}

/** What waits to be judged from here on: those named, less any judged now. */
export const keepNamed = (db, named) => setMeta(db, NAMED_PAIRS, JSON.stringify(named));

/**
 * What a pass that read memories by number says of two of them waits until the pair is judged on its own (dream.mjs):
 * reading sixty memories and a dozen turns, a small model writes one number for another — a turn's for a memory's, a
 * neighbour's for the one it meant — and a pair it never looked at side by side would be a question for the user. The
 * reason it is not named, or null: asked once — a pair raised, judged, or waiting already is not named again.
 */
export function nameForJudging(db, { label, a, b, note }) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (db.prepare('SELECT 1 FROM notices WHERE memory_a = ? AND memory_b = ?').get(lo, hi)) return 'already raised';
  const judged = db.prepare('SELECT label FROM memory_pairs WHERE a = ? AND b = ?').get(lo, hi);
  if (judged) return `m${lo} and m${hi} were judged on their own already: ${judged.label}`;
  const waiting = namedPairs(db);
  if (waiting.some((p) => p.a === lo && p.b === hi)) return 'already waiting to be judged';
  keepNamed(db, [...waiting, { label, a: lo, b: hi, note }]);
  return null;
}

/** Two active memories that look alike but are not the same: only the user can say whether one replaces the other. */
function flagLookalike(db, saved, other, now) {
  raiseNotice(db, { kind: 'lookalike', a: saved.id, b: other.id, note: 'they look alike — if the newer one replaces the older, supersede it; if both hold, leave them', now });
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
  // The words being the user's is not enough: asked to describe or fix something, the user stated nothing that lasts.
  // Judged on the quote and on the whole sentence it came from, so a quote cut short of its "delegate" proves no more than the sentence.
  if (verified && (asksForWork(op.quote) || asksForWork(sentencesAround(turn.text, op.quote)))) {
    throw new Rejected('the quote is from a sentence that asks for work or an answer; it states nothing that lasts');
  }
  // A guess costs the user a question; one drawn from a request — describe this, fix that — is the model answering it, not the user saying it.
  if (!verified && turn && asksForWork(turn.text)) throw new Rejected(`a guess from a request, not kept — ${why}`);
  // No scope given: what was said in the middle of work on a project belongs to that project.
  const focus = op.scope === undefined && turn ? currentProject(db, turn.session_id) : null;
  const { scope, project } = resolveScope(db, focus ? `project:${focus}` : op.scope);
  // Nor is a guess kept that shares nothing with the turn it names: that is the assistant's reply, or what is remembered already,
  // said in the user's name. The slow pass alone may guess past that — a pattern across conversations is what it reads for.
  const aboutTurn = ctx.source === 'dream' || (turn !== null && overlap(body, turn.text) >= BODY_MATCHES_TURN);
  if (!verified && !aboutTurn) throw new Rejected(`a guess about nothing the user typed, not kept — ${why}`);
  const asked = verified ? null : askedBefore(db, scope, body);
  if (asked) throw new Rejected(`a guess like m${asked.id}, which is ${asked.state} — not kept`);

  const again = savedFromTurn(db, turn?.id ?? null, scope, body, supersedes, op.quote);
  if (again) throw new Rejected(`already saved from this turn as m${again.id}`);
  // The slow pass reads conversations the writer has filed already: a sentence it filed is not filed again in other
  // words. Another rule from the same sentence, sharing little with what was filed, is one of its own.
  if (ctx.source === 'dream' && turn && supersedes === undefined) {
    const filed = db.prepare(`SELECT id, body FROM memories WHERE source_turn = ? AND state = 'active'`).all(turn.id).find((m) => overlap(body, m.body) >= ALREADY_FILED);
    if (filed) throw new Rejected(`already filed from that sentence: m${filed.id}`);
  }

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
    // Search terms only, checked where they are stored: a bad one is dropped there, never the memory.
    keys: op.keys,
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

/** The scope a model named, as it is stored; null when it names nothing that exists. */
function reachOf(db, scope) {
  try {
    return resolveScope(db, scope).scope;
  } catch {
    return null;
  }
}

/** A memory id as a person or a file writes it — 12 or "m12" — or NaN; the passes' schema gives numbers, `sumo apply` may not. */
const idOf = (raw) => Number(/^m?(\d+)$/.exec(String(raw ?? '').trim())?.[1] ?? NaN);

const HANDLERS = {
  add: (db, op, ctx) => addStated(db, op, ctx),

  supersede(db, op, ctx) {
    const old = db.prepare('SELECT * FROM memories WHERE id = ?').get(idOf(op.old)) ?? null;
    const type = STATED_TYPES.includes(op.type) ? op.type : STATED_TYPES.includes(old?.type) ? old.type : 'fact';
    // A real statement aimed at the wrong target — a memory that is gone, or one about something
    // else — is still a real statement. It is kept; it just does not get to replace anything.
    // Nor does it replace a taught workflow — its steps and its gate are not a sentence to overwrite — or a memory of another
    // reach: a rule said for one project leaves the one that holds everywhere, and the one of another project, in force.
    const reach = op.scope ? reachOf(db, op.scope) : (old?.scope ?? null);
    const related = old?.state === 'active' && old.type !== 'procedure' && (reach === old.scope || reach === 'global') && overlap(cleanBody(op), old.body) >= BODY_MATCHES_TURN;
    if (!related) return addStated(db, { ...op, type }, ctx);
    return addStated(db, { ...op, scope: op.scope ?? old.scope, type }, ctx, { supersedes: old.id });
  },

  /** Something learned by doing the work, not something the user said — so no quote, and only this one kind. */
  gotcha(db, op, ctx) {
    const body = cleanBody(op);
    const { scope, project } = resolveScope(db, op.scope);
    // A trap met twice is written up twice, in other words: the one already here stands for both.
    const twin = lookalike(db, scope, body);
    if (twin) throw new Rejected(`already known as m${twin.memory.id}`);
    // A trap read in a conversation that searched or fetched the web, or called an MCP server, may be what a page told
    // it: held for the user, never filed as observed. A gotcha names no turn, so every conversation the pass read counts.
    const outside = outsideReadsOf(db, [ctx.sessionId, ...[...(ctx.turns?.values() ?? [])].map((t) => t.session_id)]);
    const { memory: saved } = memory.add(db, { type: 'gotcha', body, project, keys: op.keys, provenance: outside.length > 0 ? 'inferred' : 'observed', writtenBy: ctx.source, now: ctx.now });
    if (outside.length > 0) db.prepare(`UPDATE memories SET held_for = 'outside' WHERE id = ?`).run(saved.id);
    if (outside.length > 0) return `held for confirmation ${line(saved)} — the conversation read ${outside.join(', ')}, and a trap it passes on may be what it was told`;
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

  /**
   * Two memories that cannot both be true. Never resolved here: only the user knows which one is. Only memories the pass
   * was shown, still active, can be named: one it never saw is a wrong number, whatever the note says.
   */
  contradiction(db, op, ctx) {
    const [a, b] = (Array.isArray(op.ids) ? op.ids : []).map(idOf);
    if (!a || !b || a === b) throw new Rejected('a contradiction names two different memories');
    for (const id of [a, b]) {
      if (ctx.shown && !ctx.shown.has(id)) throw new Rejected(`m${id} is not one of the memories this pass was shown`);
      if (memory.get(db, id).state !== 'active') throw new Rejected(`m${id} is not active`);
    }
    // Two things that clash are about something in common, or the note says what each is about: a memory sharing no word
    // with either is a wrong number, not a clash to put to the user.
    const said = typeof op.note === 'string' ? op.note : '';
    for (const [x, y] of [[a, b], [b, a]]) {
      if (sharedStems(memory.get(db, x).body, `${memory.get(db, y).body} ${said}`) === 0) throw new Rejected(`m${x} shares no word with m${y} or the note — not the memory meant`);
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.trim().slice(0, 200) : 'they cannot both be true';
    if (ctx.shown) return judgedFirst(db, { label: 'conflict', lo, hi, note, said: 'cannot both be true' });
    if (!raiseNotice(db, { kind: 'contradiction', a: lo, b: hi, note, now: ctx.now })) throw new Rejected('already raised');
    return `raised for the user: m${lo} vs m${hi} — ${note}`;
  },

  /**
   * Two memories that say one thing in other words — what no word overlap finds. Raised as a look-alike for the user to
   * settle; nothing is retired here. Only memories the pass was shown, still active, can be named.
   */
  same(db, op, ctx) {
    const [a, b] = (Array.isArray(op.ids) ? op.ids : []).map(idOf);
    if (!a || !b || a === b) throw new Rejected('same names two different memories');
    for (const id of [a, b]) {
      if (ctx.shown && !ctx.shown.has(id)) throw new Rejected(`m${id} is not one of the memories this pass was shown`);
      if (memory.get(db, id).state !== 'active') throw new Rejected(`m${id} is not active`);
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.replace(/\s+/g, ' ').trim().slice(0, 200) : 'they say one thing in other words';
    if (ctx.shown) return judgedFirst(db, { label: 'same', lo, hi, note, said: 'say the same thing' });
    if (!raiseNotice(db, { kind: 'lookalike', a: lo, b: hi, note, now: ctx.now })) throw new Rejected('already raised');
    return `raised for the user: m${lo} and m${hi} say the same thing — ${note}`;
  },

  /** A workflow the model thinks it saw the user repeat. Always a proposal. */
  procedure(db, op, ctx) {
    const title = typeof op.title === 'string' ? op.title.trim() : '';
    const body = typeof op.body === 'string' ? op.body.trim() : '';
    if (!title || !body) throw new Rejected('a procedure needs a title and steps');
    const { scope, project } = resolveScope(db, op.scope);
    // A routine is walked through more than once: what starts it, said in one turn only, was a one-off ask. Said nowhere, it is
    // the model's own words for a pattern, and the user is asked.
    const trigger = (typeof op.cue === 'string' && op.cue.trim() ? op.cue : title).replace(/\s+/g, ' ').trim();
    const turns = db.prepare('SELECT text FROM user_turns ORDER BY id DESC LIMIT 2000').all();
    if (turns.filter((t) => overlap(trigger, t.text) >= SAME_STATEMENT).length === 1) throw new Rejected(`a routine is something done more than once, and "${trigger.slice(0, 80)}" was said once`);
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

/** A pair a pass that read memories by number named, put to the pair judge before the user (`nameForJudging`). */
function judgedFirst(db, { label, lo, hi, note, said }) {
  const not = nameForJudging(db, { label, a: lo, b: hi, note });
  if (not) throw new Rejected(not);
  return `to be judged on their own: m${lo} and m${hi} ${said} — ${note}`;
}

/** Each operation in turn. With `refused` — why — every one that would retire a memory is dropped for that reason. */
function applyEach(db, ops, ctx, refused = null) {
  const applied = [];
  const dropped = [];
  const allowed = OPS_BY_SOURCE[ctx.source] ?? [];
  for (const op of ops) {
    const name = op?.op;
    try {
      if (!allowed.includes(name)) throw new Rejected(`operation "${name}" is not allowed from ${ctx.source}`);
      if (refused && RETIRING.includes(name)) {
        const old = idOf(op.old);
        throw new Rejected(`${Number.isNaN(old) ? 'what it replaces' : `m${old}`} is left as it is — ${refused}`);
      }
      applied.push(HANDLERS[name](db, op, ctx));
    } catch (cause) {
      // Rejected and UsageError are verdicts on the model's suggestion; anything else is a bug and must surface.
      if (!(cause instanceof Rejected) && !(cause instanceof memory.UsageError)) throw cause;
      dropped.push(`${name ?? '?'}: ${cause.message}`);
    }
  }
  return { applied, dropped };
}

/** Why the memories retired since `before` (id → scope of every active memory then) are too many to take, or null. */
function tooWide(db, before) {
  const still = new Set(db.prepare(`SELECT id FROM memories WHERE state = 'active'`).all().map((m) => m.id));
  const retired = [...before].filter(([id]) => !still.has(id)).map(([, scope]) => scope);
  const wide = ': a rewrite that wide is not taken from a model';
  if (retired.length > MAX_RETIRED) return `this pass would retire ${retired.length} memories at once, more than ${MAX_RETIRED}${wide}`;
  const had = [...before.values()];
  for (const scope of new Set(retired)) {
    const gone = retired.filter((s) => s === scope).length;
    const total = had.filter((s) => s === scope).length;
    // One at a time is never a rewrite: a scope of three must still be able to have one of them replaced.
    if (gone > 1 && gone > total * MAX_RETIRED_SHARE) return `this pass would retire ${gone} of the ${total} memories in ${scope}, more than a quarter${wide}`;
  }
  return null;
}

/**
 * @param ops      what the model returned
 * @param ctx.source   'scribe' | 'dream' — decides which operations are even allowed
 * @param ctx.turns    Map of turn id → user_turns row the model was shown
 */
export function applyOps(db, ops, ctx) {
  if (!Array.isArray(ops)) return { applied: [], dropped: ['the answer had no list of operations'], written: [] };

  return tx(db, () => {
    // `written`: the memories this call made, by id. The transaction holds the write lock, so every id past the highest
    // at its start is this call's — never another process's that finished a moment before or after.
    const from = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM memories').get().id;
    const made = (outcome) => ({ ...outcome, written: db.prepare('SELECT id FROM memories WHERE id > ? ORDER BY id').all(from).map((m) => m.id) });
    if (ctx.source !== 'dream') return made(applyEach(db, ops, ctx));
    // The slow pass's answer is tried first and counted, then kept or undone: what it would retire is known exactly
    // that way — a replacement that is only a guess, or aimed at the wrong memory, retires nothing. Too wide, it is
    // applied again without what retires anything, and what it adds is kept.
    const before = new Map(db.prepare(`SELECT id, scope FROM memories WHERE state = 'active'`).all().map((m) => [m.id, m.scope]));
    db.exec('SAVEPOINT dream_ops');
    const tried = applyEach(db, ops, ctx);
    const refused = tooWide(db, before);
    if (refused) db.exec('ROLLBACK TO dream_ops');
    db.exec('RELEASE dream_ops');
    return made(refused ? applyEach(db, ops, ctx, refused) : tried);
  });
}
