import { tx } from './db.mjs';
import * as memory from './memory.mjs';
import { line } from './render.mjs';
import { addCheckpoint, currentProject, outsideReadsOf } from './sessions.mjs';
import { asksForWork, coverage, overlap, saysAs, sharedStems, standsAlone, words } from './text.mjs';

/**
 * The only door through which a model's suggestion becomes a memory.
 *
 * A model proposes; this code decides. Nothing here trusts the model's word:
 * a claim that the user said something is checked against what the user
 * actually typed, in the turn the model names, and anything that cannot be
 * checked is dropped with its reason — never kept as a guess for the user to
 * settle. One bad operation is dropped and logged; it never takes the good
 * ones down with it.
 *
 * What the user stated is stored in the user's own words: the model points at a turn and quotes it, and the memory is
 * the paragraph of that turn the quote sits in, whole and as typed. The model writes no sentence that is kept, so a memory cannot
 * say what the user did not type — no list of opposites or borrowed words has to catch a paraphrase that went wrong
 * (two independent reviews, Nov 18 2026, got eleven of twelve such paraphrases past the lists).
 */

/**
 * The rules below as a version: part of the extractor's version (ledger.mjs), so memories derived under other rules
 * can be told apart and rebuilt. Bump it whenever what is accepted, dropped or replaced here changes.
 */
export const APPLY_RULES = '2026-11-18.7';

const STATED_TYPES = ['preference', 'fact', 'decision'];
const BODY_MAX = 300;
/** Enough to be unmistakable, short enough that a real "no emojis" still counts. */
const QUOTE_MIN_WORDS = 2;
const QUOTE_MIN_CHARS = 6;
/**
 * Two statements may be about one thing when they share this much of the shorter one's words, and two words at
 * least. It is enough to ask about the pair, never to retire a memory: "never force-push on slate" and "always push
 * slate tags after a release" pass it.
 */
const BODY_MATCHES_TURN = 0.3;
/**
 * A statement replaces a derived memory by itself only when each holds this share of the other's words — one word
 * changed in a sentence of four. Anything looser is the pair judge's to call a replacement.
 */
const SAME_MATTER = 0.75;
/** A quote longer than this is not a statement picked out: it is a paragraph. */
const QUOTE_MAX_WORDS = 40;
/** A memory the chat saved from a turn is in what is filed from that turn when this share of its words is. */
const SAID_HERE = 0.8;
/** A turn of this many lines or more holds something pasted: only its first and last line are taken as the user's own. */
const PASTED_LINES = 3;
/** What stands for a line break in a memory's one line: a paragraph of several lines is kept as it was typed, on one. */
const LINE_BREAK = ' / ';
/** A turn past this length is mostly something pasted: only what opens or closes it is taken as the user's own. */
const LONG_TURN_CHARS = 1500;
const LONG_TURN_OWN = 500;
/** "use eslint for linting" / "use biome for linting": three words of four. Close enough to ask about, too different to call a repeat. */
const LOOKS_ALIKE = 0.7;

/**
 * How much of memory a pass may retire in one go. A playbook a model was asked to rewrite whole shrank to a
 * fraction of itself, and the agent did worse with it than with none. A few replacements a pass — a correction the user
 * kept repeating — are its job; past either bound it is rewriting, and none of its replacements is taken.
 */
const MAX_RETIRED = 10;
const MAX_RETIRED_SHARE = 0.25;
/** What retires a memory. Everything else a pass may do only adds. */
const RETIRING = ['supersede'];

const OPS_BY_SOURCE = {
  scribe: ['add', 'supersede', 'gotcha', 'checkpoint'],
  dream: ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'same'],
  // A delegated sub-agent's report: it may tell us about traps it hit, and nothing else.
  worker: ['gotcha'],
};

class Rejected extends Error {}
/** Dropped because memory holds it already, or held it until the user let it go: nothing wrong with the proposal. */
class Known extends Rejected {}

const normalize = (text) => text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
/** Runs of space made one, and nothing else: how the user's words are stored. */
const spaced = (text) => text.replace(/\s+/g, ' ').trim();
/** Case and the shape of quote marks aside, letter for letter: a place in the one is the same place in the other. */
const folded = (text) => {
  const lower = text.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"');
  return lower.length === text.length ? lower : text;
};

/**
 * A turn as its paragraphs — the blocks between blank lines, the whole turn when it has none — each with its lines
 * (their spaces made one, and where each starts in the turn), whether it holds something pasted (a fenced code
 * block, a line quoted with `>`), and its `body`: the paragraph whole, as typed, its line breaks written " / ".
 *
 * sumo cuts nothing out of what the user typed: every cut that was tried — the sentence, the line, the words after
 * "e.g." — at some point kept the half that said the opposite ("Things I never want you to do:" over a list; "Don't.
 * Ever. Push straight to main."). A turn that fits in one memory is stored whole; of a longer one, a paragraph that
 * stands by itself (`placeOf`).
 */
function paragraphsOf(text) {
  const paragraphs = [];
  let current = null;
  let at = 0;
  let fenced = false;
  for (const raw of text.split('\n')) {
    const start = at;
    at += raw.length + 1;
    const fence = /^\s*(?:```|~~~)/.test(raw);
    // A blank line ends a paragraph — not inside a code block, which is one thing however it is spaced.
    if (!raw.trim() && !fenced) {
      current = null;
      continue;
    }
    if (!current) paragraphs.push((current = { lines: [], pasted: false }));
    if (fence || fenced || /^\s*>/.test(raw)) current.pasted = true;
    if (fence) fenced = !fenced;
    if (raw.trim()) current.lines.push({ start, text: spaced(raw) });
  }
  for (const p of paragraphs) p.body = p.lines.map((l) => l.text).join(LINE_BREAK);
  return paragraphs;
}

/** What opens a list item: a dash, a star, a bullet, a plus, a number. */
const LIST_ITEM = /^(?:[-*•+]|\d+[.)])\s/;

/**
 * Whether a paragraph of a turn can be taken without the one before it: not when that one leads into it (it ends in
 * a colon or a comma), not when it is a list or opens with a list item, a caret pointing back, or a small letter —
 * a continuation. "Things I never want you to do:", a blank line, and then the list was stored as the list.
 */
function standsApart(paragraphs, i) {
  const lines = paragraphs[i].lines.map((l) => l.text);
  if (i > 0 && /[:,]$/.test(paragraphs[i - 1].body)) return false;
  return !lines.every((l) => LIST_ITEM.test(l)) && !LIST_ITEM.test(lines[0]) && !lines[0].startsWith('^') && !/^\p{Ll}/u.test(lines[0]);
}

/**
 * What of a turn a quote stands for, as the user's own words: `{ paragraph }`, the body to store — or `{ why }` it
 * cannot be taken. A quote sits on one line, in a paragraph that holds nothing pasted, and in a turn of three lines or
 * more on the first or the last: a page pasted between what the user typed is lines like any other, however short
 * ("the README says:", the page's line, "thoughts"). A turn that fits in one memory, and holds nothing pasted, is
 * taken whole: a line break between what negates and what is negated cuts nothing off. Of a longer turn the quote's
 * paragraph is taken — opening or closing a turn long enough to be mostly a paste, and only one that stands apart
 * from the paragraph before it.
 */
function placeOf(text, quote) {
  const sought = folded(quote);
  const paragraphs = paragraphsOf(text);
  const whole = paragraphs.map((p) => p.body).join(LINE_BREAK);
  const fits = whole.length <= BODY_MAX && !paragraphs.some((p) => p.pasted);
  const lines = paragraphs.flatMap((p) => p.lines);
  const why = { pasted: false, inner: false, middle: false, leaning: false };
  for (const [i, p] of paragraphs.entries()) {
    for (const line of p.lines) {
      const from = folded(line.text).indexOf(sought);
      if (from === -1) continue;
      const [starts, ends] = [line.start + from, line.start + from + sought.length];
      if (p.pasted) why.pasted = true;
      else if (lines.length >= PASTED_LINES && line !== lines[0] && line !== lines.at(-1)) why.inner = true;
      else if (fits) return { paragraph: whole };
      else if (text.length > LONG_TURN_CHARS && ends > LONG_TURN_OWN && starts < text.length - LONG_TURN_OWN) why.middle = true;
      // One too long to keep is said to be that, below: the reason that needs no reading of its first letter.
      else if (p.body.length <= BODY_MAX && !standsApart(paragraphs, i)) why.leaning = true;
      else return { paragraph: p.body };
    }
  }
  if (why.middle) return { why: `the quote is from the middle of a long turn: past ${LONG_TURN_CHARS.toLocaleString('en-US')} characters only its first and last ${LONG_TURN_OWN} are taken as the user's own` };
  if (why.inner) return { why: "the quote is from a line in the middle of a turn of three lines or more: only its first and last line are taken as the user's own" };
  if (why.leaning) return { why: 'the paragraph does not stand by itself (it follows one that leads into it, is a list, or opens as a continuation), and the turn is too long to keep whole' };
  if (why.pasted) return { why: 'the quote is from a pasted block — code, or a quoted line — or the paragraph it sits in holds one' };
  return { why: 'the quote runs across a line break: a statement is on one line' };
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

/** A turn's number as a model writes it: 12, or "t12" copied whole from the tag. */
const turnOf = (raw) => Number(/^t?(\d+)$/i.exec(String(raw ?? '').trim())?.[1] ?? NaN);

/**
 * What the user stated, in their words: the turn a model names, its quote, and — as the memory's body — the whole
 * turn when it fits in one memory, else the paragraph of it the quote sits in — exactly as typed, runs of space made
 * one and line breaks written " / ". Nothing is cut out of it, and whatever the model wrote as a body is not looked at here. Only the named turn is looked in: a quote found somewhere else in what the model was
 * shown is one turn's words under another's number, and which turn a statement came from is what a memory cites.
 * Throws why it is not kept; nothing that cannot be shown to be the user's own words is kept in any state.
 */
function stated(op, turns) {
  const not = (why) => new Rejected(`not the user's words, not kept — ${why}`);
  const turn = turns.get(turnOf(op.turn)) ?? null;
  if (!turn) throw not('it names no turn the model was shown');
  if (typeof op.quote !== 'string' || !op.quote.trim()) throw not('no quote given');
  // The words, without the quote marks or the full stop a model may put round them.
  const said = op.quote.trim().replace(/^["'“‘]+|["'”’]+$/g, '').replace(/[.!?]+$/, '');
  const quote = normalize(said);
  if (quote.length < QUOTE_MIN_CHARS || quote.split(' ').length < QUOTE_MIN_WORDS) throw not('the quote is too short to prove anything');
  if (!normalize(turn.text).includes(quote)) throw not('the user never typed the quoted words in the turn it names');
  if (quote.split(' ').length > QUOTE_MAX_WORDS) throw not(`the quote is over ${QUOTE_MAX_WORDS} words: it picks out a statement, it is not the statement`);
  const place = placeOf(turn.text, spaced(said));
  if (place.why) throw not(place.why);
  const { paragraph } = place;
  // Asked, not stated — also when it holds the words of a rule: "Do I want you to always force-push to main?".
  if (/\?["'”’)\]]*$/.test(paragraph)) throw new Rejected('the quote is from a question; it states nothing');
  // The words being the user's is not enough: asked to describe or fix something, the user stated nothing that lasts.
  // Judged on the quote and on the whole paragraph it came from, so a quote cut short of its "delegate" proves no more than what it sits in.
  if (asksForWork(said) || asksForWork(paragraph)) throw new Rejected('the quote is from a sentence that asks for work or an answer; it states nothing that lasts');
  // Nor is agreeing: "ok that plan sounds good" is the user's, and the plan was the assistant's.
  if (!standsAlone(paragraph)) throw new Rejected('the sentence agrees or points at something said elsewhere, and says nothing by itself');
  // Whole, or not at all: a part of it can say the opposite of it ("it is not the case … that we always deploy on
  // fridays without review"). What was said stays in the journal.
  if (paragraph.length > BODY_MAX) throw new Rejected(`the paragraph is over ${BODY_MAX} characters: too long to keep whole, and a part of it is not what was said — it stays in the journal, where sumo search finds it`);
  return { turn, body: paragraph, quote: op.quote.trim() };
}

/**
 * A memory in this scope that looks like this one. `same` means it says the same thing in the same
 * words. Merely looking alike is a different and more dangerous case: "slate uses pnpm" and "slate
 * uses bun" share every word but one, and the second is a correction, not a repeat. Treating it as
 * already known would leave memory wrong for good — so look-alikes are never dropped, only flagged.
 */
// Identifier case and punctuation carry meaning (Release/release, feature/a/feature-a).
// The full stop a sentence ends on does not: the same rule typed with and without one is one rule.
const statementOf = (text) => text.replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim().replace(/[.!?]+$/, '');

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

/**
 * The same sentence is often proposed twice from one turn — once by a retry, once by the chat model saving it
 * directly, once by an extractor from before memories were the user's own sentences. A repeat is the same statement,
 * or one drawn from the same words: its quote holds this one's, or this one's holds its. Only a memory that still
 * holds it, or one a later statement replaced, is a repeat: one let go is the user's (`letGo` keeps that out) or else
 * a rebuild's or a migration's, which must not keep the user's own words out for ever.
 */
function savedFromTurn(db, turnId, scope, body, exclude, quote) {
  if (turnId === null) return null;
  const fromTurn = db.prepare(`SELECT * FROM memories WHERE source_turn = ? AND scope = ? AND state IN ('active', 'superseded') AND id IS NOT ?`).all(turnId, scope, exclude ?? null);
  const said = typeof quote === 'string' ? normalize(quote) : '';
  const sameWords = (m) => {
    const theirs = m.source_quote ? normalize(m.source_quote) : '';
    return Boolean(said) && Boolean(theirs) && (said.includes(theirs) || theirs.includes(said));
  };
  return fromTurn.find((m) => statementOf(body) === statementOf(m.body) || sameWords(m)) ?? null;
}

/**
 * A memory the user let go — forgot or rejected — after the turn in hand was said, that this sentence would bring
 * back: one drawn from the same words of this very turn — its quote holds this one's, or this one's holds its, so
 * the other sentences of the turn are not let go with it — or one that says what the sentence says: the same words,
 * or nearly the same either way (`saysAs`). Sharing words is not saying it: "slate uses bun for installs now" is the correction of a
 * forgotten "slate uses pnpm for installs", and was dropped as it. In every scope: let go under one, it does not come back under
 * another. Reading a conversation again must not return what they threw out; said again later, it is theirs again.
 * Only the user's letting go counts, never a rebuild's, a migration's or a trap's expiry.
 */
function letGo(db, body, turn, quote) {
  // A turn handed in without its time cannot be placed before or after anything.
  if (typeof turn.ts !== 'string') return null;
  const gone = db
    .prepare(
      `SELECT m.*, (SELECT MAX(e.ts) FROM memory_events e WHERE e.memory_id = m.id AND e.op IN ('forgotten', 'rejected')
                     AND e.actor IN ('user', 'model-shell', 'unknown') AND COALESCE(e.reason, '') != 'rebuilt') AS let_go_at
       FROM memories m WHERE m.type != 'procedure' AND m.state IN ('rejected', 'invalid') ORDER BY m.id`,
    )
    .all()
    .filter((m) => m.let_go_at !== null && m.let_go_at >= turn.ts);
  const said = normalize(quote);
  const sameWords = (m) => m.source_turn === turn.id && Boolean(m.source_quote) && (said.includes(normalize(m.source_quote)) || normalize(m.source_quote).includes(said));
  // Saved from this turn by the chat, which keeps no quote: let go, it takes with it whatever of the turn holds its words.
  const savedHere = (m) => m.source_turn === turn.id && !m.source_quote && coverage(m.body, body) >= SAID_HERE;
  return gone.find((m) => sameWords(m) || savedHere(m) || statementOf(m.body) === statementOf(body) || saysAs(body, m.body) || saysAs(m.body, body)) ?? null;
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

/** Two active memories that look alike but are not the same: only the user can say whether one replaces the other. */
function flagLookalike(db, saved, other, now) {
  raiseNotice(db, { kind: 'lookalike', a: saved.id, b: other.id, note: 'they look alike — if the newer one replaces the older, supersede it; if both hold, leave them', now });
}

/** A pair the pass had judged as it filed is never asked about again by the tidy. */
function noteJudged(db, a, b, label, now) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  db.prepare('INSERT OR IGNORE INTO memory_pairs (a, b, label, judged_at) VALUES (?, ?, ?, ?)').run(lo, hi, label, now);
}

/**
 * One statement of the user's through the rules. `supersedes` is the memory it replaces; `beside` one it was meant to
 * replace and may not — `why` says so (too wide a rewrite, a memory the user wrote, a pair nobody called a
 * replacement): the statement is kept, that memory left, and the user asked about the two.
 */
function addStated(db, op, ctx, { supersedes, beside, why = ctx.refused, pending } = {}) {
  if (!STATED_TYPES.includes(op.type)) throw new Rejected(`type "${op.type}" cannot come from a model — one of: ${STATED_TYPES.join(', ')}`);
  const { turn, body, quote } = stated(op, ctx.turns);
  // No scope given: what was said in the middle of work on a project belongs to that project.
  const focus = op.scope === undefined ? currentProject(db, turn.session_id) : null;
  const { scope, project } = resolveScope(db, focus ? `project:${focus}` : op.scope);
  /** What this statement is, for whoever asks what the rules let through; `existing` when memory holds it already. */
  const passed = (existing = null, more = {}) => ctx.filed.push({ turnId: turn.id, type: op.type, scope, body, quote, existing, replaces: null, mayReplace: null, later: null, ...more });
  /** An older statement than the memory that covers its matter: not filed over what the user said after it. */
  const saidBefore = (m) => {
    passed(m.id, { later: m.id });
    return new Known(`said before m${m.id}, which holds what the user said after it`);
  };
  const thrownOut = letGo(db, body, turn, quote);
  if (thrownOut) {
    passed(thrownOut.id);
    throw new Known(`the user let this go (m${thrownOut.id})`);
  }

  const again = savedFromTurn(db, turn.id, scope, body, supersedes ?? beside, quote);
  if (again) {
    passed(again.id);
    throw new Known(`already saved from this turn as m${again.id}`);
  }

  // What is being replaced naturally resembles its replacement, so it is left out of the comparison.
  const twin = lookalike(db, scope, body, supersedes ?? beside);
  // The same statement, active: known. One the user refused as a guess, or that is held for them, they have now said.
  if (twin?.same && twin.memory.state === 'active') {
    const known = twin.memory;
    passed(known.id);
    if (supersedes === undefined) throw new Known(`already known as m${known.id}`);
    // The statement was filed earlier; only now is it clear what it replaces.
    memory.supersede(db, supersedes, known.id, ctx.now, { actor: ctx.source, runId: ctx.runId });
    return `m${known.id} now replaces m${supersedes}`;
  }

  // A look-alike is a fact that may have changed ("slate uses pnpm" / "slate uses bun"). Code picked the pair; what it
  // is was asked of the model before this call (`ctx.labels`, by the operation's place in the answer). Not asked — no
  // local model to ask — it is put to the user as a notice. Asked and not answered, both stand.
  const alike = twin && !twin.same ? twin.memory : null;
  // Read late — a rebuild, a pass that was paused — an old turn's statement meets the memory of a later one that looks
  // like it. It never replaces that memory ("quartz uses yarn" once replaced a later "quartz uses deno"); whether it is
  // the thing that memory corrected, and so not filed at all, is judged below — sharing words is not being it, and
  // "slate tests run on node 22" is not what "slate builds run on node 22" corrected.
  const older = Boolean(alike) && saidLater(db, alike, turn);
  const judged = alike && ctx.labels ? ctx.labels.get(ctx.index) : null;
  const label = alike && judged?.old === alike.id ? judged.label : null;
  if (alike && !ctx.labels) ctx.pairs.push({ index: ctx.index, old: alike, type: op.type, scope, body, said: turn.ts });
  if (label === 'same') {
    passed(alike.id);
    throw new Known(`already known as m${alike.id}, in other words`);
  }
  // A replacement a pass may not make (too wide a rewrite) leaves both standing, and the user is asked.
  // Nearly the same words as what was said after it, and the judge says the two are one matter: the later one stands
  // in its place. Anything less sure is filed beside it, and the user asked.
  if (older && sameMatter(body, alike.body) && (label === 'replaces' || label === 'conflict')) throw saidBefore(alike);
  // Nor one of a memory the user wrote themselves: that is theirs to replace. Nor of one said after this.
  const replaces = label === 'replaces' && !ctx.refused && alike.derived_by !== null && !older ? alike.id : null;

  const { memory: saved } = memory.add(db, {
    type: op.type,
    body,
    project,
    topic: typeof op.topic === 'string' ? op.topic : undefined,
    // Search terms only, checked where they are stored: a bad one is dropped there, never the memory. A sentence the
    // model wrote of its own is no more than that — its words that the user's sentence lacks help the memory be found.
    keys: [...(Array.isArray(op.keys) ? op.keys : []), ...(typeof op.body === 'string' ? words(op.body) : [])],
    provenance: 'stated',
    supersedes: supersedes ?? replaces ?? undefined,
    writtenBy: ctx.source,
    derivedBy: ctx.derivedBy ?? ctx.source,
    runId: ctx.runId,
    sourceSession: turn.session_id,
    sourceTurn: turn.id,
    sourceQuote: quote,
    now: ctx.now,
  });
  const unjudged = alike && !ctx.labels ? alike.id : null;
  passed(null, { replaces: supersedes ?? replaces, mayReplace: pending ?? (unjudged !== null && !older && alike.derived_by !== null ? unjudged : null), mayBeOlder: older ? unjudged : null });
  // Replacing what the model was asked to replace and what it was judged to replace: both are retired, history kept.
  if (replaces !== null && supersedes !== undefined) memory.supersede(db, replaces, saved.id, ctx.now, { actor: ctx.source, runId: ctx.runId });
  if (label) noteJudged(db, saved.id, alike.id, label, ctx.now);
  if (alike && (!ctx.labels || (label === 'replaces' && replaces === null))) flagLookalike(db, saved, alike, ctx.now);
  if (label === 'conflict') raiseNotice(db, { kind: 'contradiction', a: saved.id, b: alike.id, note: 'they cannot both be true — only the user knows which holds', now: ctx.now });
  if (beside !== undefined) flagLookalike(db, saved, { id: beside }, ctx.now);
  const said =
    beside !== undefined ? ` — m${beside} is left as it is, and the user is asked: ${why}`
    : replaces !== null ? ` — it replaces m${replaces}`
    : label === 'conflict' ? ` — raised for the user: it cannot be true beside m${alike.id}`
    : '';
  return `saved ${line(saved)}${said}`;
}

const aboutOneThing = (a, b) => overlap(a, b) >= BODY_MATCHES_TURN && sharedStems(a, b) >= 2;
const sameMatter = (a, b) => coverage(a, b) >= SAME_MATTER && coverage(b, a) >= SAME_MATTER;

/**
 * Whether a memory holds something said after a turn: the time of the turn it was drawn from, or of its filing when
 * it cites none. A turn handed in without its time is not placed.
 */
function saidLater(db, m, turn) {
  if (typeof turn.ts !== 'string') return false;
  const at = (m.source_turn === null || m.source_turn === undefined ? null : db.prepare('SELECT ts FROM user_turns WHERE id = ?').get(m.source_turn)?.ts) ?? m.created_at;
  return typeof at === 'string' && at > turn.ts;
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
    // Compared as the user's own words, the paragraph that would be stored — never as a model worded it.
    const { body, turn } = stated(op, ctx.turns);
    const related = old?.state === 'active' && old.type !== 'procedure' && (reach === old.scope || reach === 'global') && aboutOneThing(body, old.body);
    if (!related) return addStated(db, { ...op, type }, ctx);
    const next = { ...op, scope: op.scope ?? old.scope, type };
    const beside = (why, pending) => addStated(db, next, ctx, { beside: old.id, why, pending });
    // What the memory holds was said after this: it is not replaced by it, whatever the model names as replacing what.
    // The statement goes through as any other, and meets that memory there if the two look alike.
    if (saidLater(db, old, turn)) return addStated(db, { ...op, type }, ctx);
    // What the user wrote themselves is never a pass's to retire, whatever a model says replaces it: "never force-push
    // on slate" was once superseded by "always push slate tags after a release". Both stand, and the user is asked.
    if (old.derived_by === null) return beside(`the user wrote m${old.id} themselves, and a pass does not replace what they wrote`);
    // Refused as too wide a rewrite, the user's words from the conversation just read are still theirs: kept beside the old.
    if (ctx.refused) return beside(ctx.refused);
    if (sameMatter(body, old.body)) return addStated(db, next, ctx, { supersedes: old.id });
    // Sharing words is not being about one thing. The model that read the conversation named the memory; the pair
    // judge, shown only the two, must agree — asked before this call, like any look-alike: that the new one replaces
    // the old, or that the two cannot both be true, which of a memory and what the user has just said is the same
    // verdict ("slate uses pnpm, never npm" / "in slate we moved from pnpm to bun last week" it calls a conflict).
    if (!ctx.labels) ctx.pairs.push({ index: ctx.index, old, type, scope: reach ?? old.scope, body, said: turn.ts });
    const judged = ctx.labels?.get(ctx.index);
    if (judged?.old === old.id && (judged.label === 'replaces' || judged.label === 'conflict')) return addStated(db, next, ctx, { supersedes: old.id });
    return beside('the two share words, and nothing says the new one replaces the old', ctx.labels ? undefined : old.id);
  },

  /** Something learned by doing the work, not something the user said — so no quote, and only this one kind. */
  gotcha(db, op, ctx) {
    const body = cleanBody(op);
    const { scope, project } = resolveScope(db, op.scope);
    // A trap met twice is written up twice, in other words: the one already here stands for both.
    const twin = lookalike(db, scope, body);
    if (twin) throw new Rejected(`already known as m${twin.memory.id}`);
    // A trap read in a conversation that searched or fetched the web, or called an MCP server, may be what a page told
    // it: held for the user, never filed as observed — the one thing still held, since guesses are not kept. A gotcha
    // names no turn, so every conversation the pass read counts.
    const outside = outsideReadsOf(db, [ctx.sessionId, ...[...(ctx.turns?.values() ?? [])].map((t) => t.session_id)]);
    const { memory: saved } = memory.add(db, {
      type: 'gotcha', body, project, keys: op.keys, provenance: 'observed', heldFor: outside.length > 0 ? 'outside' : undefined,
      writtenBy: ctx.source, derivedBy: ctx.derivedBy ?? ctx.source, runId: ctx.runId, now: ctx.now,
    });
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
   * Two memories that cannot both be true. Never resolved here: only the user knows which one is. Only memories still
   * active can be named.
   */
  contradiction(db, op, ctx) {
    const [a, b] = (Array.isArray(op.ids) ? op.ids : []).map(idOf);
    if (!a || !b || a === b) throw new Rejected('a contradiction names two different memories');
    for (const id of [a, b]) if (memory.get(db, id).state !== 'active') throw new Rejected(`m${id} is not active`);
    // Two things that clash are about something in common, or the note says what each is about: a memory sharing no word
    // with either is a wrong number, not a clash to put to the user.
    const said = typeof op.note === 'string' ? op.note : '';
    for (const [x, y] of [[a, b], [b, a]]) {
      if (sharedStems(memory.get(db, x).body, `${memory.get(db, y).body} ${said}`) === 0) throw new Rejected(`m${x} shares no word with m${y} or the note — not the memory meant`);
    }
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.trim().slice(0, 200) : 'they cannot both be true';
    if (!raiseNotice(db, { kind: 'contradiction', a: lo, b: hi, note, now: ctx.now })) throw new Rejected('already raised');
    return `raised for the user: m${lo} vs m${hi} — ${note}`;
  },

  /**
   * Two memories that say one thing in other words — what no word overlap finds. Raised as a look-alike for the user to
   * settle; nothing is retired here. Only memories still active can be named.
   */
  same(db, op, ctx) {
    const [a, b] = (Array.isArray(op.ids) ? op.ids : []).map(idOf);
    if (!a || !b || a === b) throw new Rejected('same names two different memories');
    for (const id of [a, b]) if (memory.get(db, id).state !== 'active') throw new Rejected(`m${id} is not active`);
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const note = typeof op.note === 'string' && op.note.trim() ? op.note.replace(/\s+/g, ' ').trim().slice(0, 200) : 'they say one thing in other words';
    if (!raiseNotice(db, { kind: 'lookalike', a: lo, b: hi, note, now: ctx.now })) throw new Rejected('already raised');
    return `raised for the user: m${lo} and m${hi} say the same thing — ${note}`;
  },
};

/** Each operation in turn. With `refused` — why — every one that would retire a memory is dropped for that reason. */
function applyEach(db, ops, ctx, refused = null) {
  const applied = [];
  const dropped = [];
  const repeats = [];
  const run = { ...ctx, refused, pairs: [], filed: [] };
  const allowed = OPS_BY_SOURCE[ctx.source] ?? [];
  ops.forEach((op, index) => {
    const name = op?.op;
    try {
      if (!allowed.includes(name)) throw new Rejected(`operation "${name}" is not allowed from ${ctx.source}`);
      // A rewrite too wide to take: from a file of operations the replacement is dropped whole; the pass that read the
      // conversation keeps what the user said and retires nothing (`supersede`).
      if (refused && RETIRING.includes(name) && ctx.source !== 'scribe') {
        const old = idOf(op.old);
        throw new Rejected(`${Number.isNaN(old) ? 'what it replaces' : `m${old}`} is left as it is — ${refused}`);
      }
      applied.push(HANDLERS[name](db, op, { ...run, index }));
    } catch (cause) {
      // Rejected and UsageError are verdicts on the model's suggestion; anything else is a bug and must surface.
      if (!(cause instanceof Rejected) && !(cause instanceof memory.UsageError)) throw cause;
      dropped.push(`${name ?? '?'}: ${cause.message}`);
      if (cause instanceof Known) repeats.push(dropped.at(-1));
    }
  });
  return { applied, dropped, repeats, pairs: run.pairs, filed: run.filed, refused };
}

/** Every active memory's scope by id: what `tooWide` counts a change against. */
export const activeScopes = (db) => new Map(db.prepare(`SELECT id, scope FROM memories WHERE state = 'active'`).all().map((m) => [m.id, m.scope]));

/** Why the memories retired since `before` (`activeScopes` then) are too many to take, or null. */
export function tooWide(db, before) {
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
 * @param ctx.source     'scribe' | 'dream' | 'worker' — decides which operations are even allowed
 * @param ctx.turns      Map of turn id → user_turns row the model was shown
 * @param ctx.derivedBy  the extractor's version, written on what is filed; `ctx.runId` the ledger row of the call
 * @param ctx.labels     Map of an operation's place in `ops` → `{ old, label }`: what the pair judge said of the
 *                       look-alike that operation's statement has. Absent, a look-alike becomes a notice.
 * @param ctx.dry        true to change nothing: the answer is what would have happened
 *
 * Returns `applied` and `dropped` (lines; `repeats` are those of `dropped` that only say memory holds it already),
 * `written` (ids of the memories this call made), `pairs` (each statement
 * that has a look-alike nobody judged: `{ index, old, type, scope, body, said }`, `said` when its turn was) and
 * `filed` (each statement that passed the rules: `{ turnId, type, scope, body, quote, existing, replaces, mayReplace,
 * later }` — `existing` the memory already holding it, or null; `replaces` the memory it retires; `mayReplace` one it
 * retires if the pair judge, not yet asked, agrees; `mayBeOlder` a memory said after it, in whose place it is not
 * filed if the judge calls the two one matter; `later` that memory, once the judge has),
 * and `refused`: why nothing was retired, when the answer would have retired too much, else null.
 */
export function applyOps(db, ops, ctx) {
  if (!Array.isArray(ops)) return { applied: [], dropped: ['the answer had no list of operations'], written: [], repeats: [], pairs: [], filed: [], refused: null };

  return tx(db, () => {
    // `written`: the memories this call made, by id. The transaction holds the write lock, so every id past the highest
    // at its start is this call's — never another process's that finished a moment before or after.
    const from = db.prepare('SELECT COALESCE(MAX(id), 0) AS id FROM memories').get().id;
    // The answer is tried first and counted, then kept or undone: what it would retire is known exactly that way — a
    // replacement aimed at the wrong memory retires nothing. Too wide, it is applied again without what retires
    // anything, and what it adds is kept.
    const before = activeScopes(db);
    const attempt = (refused, keep) => {
      db.exec('SAVEPOINT apply_ops');
      const outcome = applyEach(db, ops, ctx, refused);
      const wide = refused ? null : tooWide(db, before);
      if (wide || !keep) db.exec('ROLLBACK TO apply_ops');
      db.exec('RELEASE apply_ops');
      return { outcome, wide };
    };
    const tried = attempt(null, !ctx.dry);
    const outcome = tried.wide ? attempt(tried.wide, !ctx.dry).outcome : tried.outcome;
    return { ...outcome, written: ctx.dry ? [] : db.prepare('SELECT id FROM memories WHERE id > ? ORDER BY id').all(from).map((m) => m.id) };
  });
}
