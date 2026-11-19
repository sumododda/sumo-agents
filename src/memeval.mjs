import { getMeta, setMeta } from './db.mjs';
import { extractorVersion, memoryModel } from './ledger.mjs';
import { UsageError } from './memory.mjs';
import { dryExtract } from './rebuild.mjs';
import { searchAll } from './search.mjs';
import { clip, saysAs } from './text.mjs';

/**
 * `sumo memory eval`: memory measured on the owner's own history, so a change to the search or to the extractor is a
 * number and not a feeling. It reports; it gates nothing by itself.
 *
 * Without a model: every search that once found nothing (`search_misses`) is run again through today's search.
 * With the extractor: the turns behind memories the user threw out must not be filed again, and the turns behind
 * what the user stated — and still holds — must be. Each of those is a model call, so it is bounded.
 */

/** How many of each kind the extractor is replayed on unless `--limit` says. */
const REPLAYED = 20;
/** How many of the searches that still find nothing are named. */
const STILL_SHOWN = 10;
/** A memory forgotten this long after it was filed went stale; it was not junk (the ledger's junk rate draws the same line). */
const JUNK_WITHIN_DAYS = 30;
/** The last score of this extractor, and the last of another: `{ last, other }`, each `{ version, score, cases, at }`. */
const KEPT = 'memory.eval';
const SHOWN = 80;

/**
 * Every recorded miss through today's search, as the one who asked would run it — same words, same scope — but
 * unrecorded (`record: false`): the search would count what it shows as used and keep a miss of its own, and an eval
 * that grew the list it measures would measure itself. A miss still found only loosely is still a miss, as the search
 * itself has it.
 */
function replayMisses(db, now) {
  const rows = db.prepare('SELECT query, scope, COUNT(*) AS times, MAX(ts) AS ts FROM search_misses GROUP BY query, scope ORDER BY ts DESC').all();
  const still = [];
  for (const miss of rows) {
    const where = miss.scope === 'everywhere' ? { everywhere: true } : miss.scope.startsWith('project:') ? { project: miss.scope.slice('project:'.length) } : {};
    let found = false;
    try {
      const answer = searchAll(db, miss.query, { ...where, now, record: false });
      found = answer.memories.length + answer.conversations.length > 0 && !answer.loose;
    } catch (cause) {
      // A project since removed, or words the search takes none of: still nothing.
      if (!(cause instanceof UsageError)) throw cause;
    }
    if (!found) still.push(miss);
  }
  const total = rows.reduce((n, r) => n + r.times, 0);
  const missing = still.reduce((n, r) => n + r.times, 0);
  return { total, found: total - missing, still: still.slice(0, STILL_SHOWN).map(({ query, scope }) => ({ query, scope })), stillMore: Math.max(0, still.length - STILL_SHOWN) };
}

/**
 * The memories the extractor is judged on, newest first, each with the turn it came from still in the journal.
 * `negatives`: what the user rejected, or forgot within a month of its filing — never what a migration or a rebuild
 * retired, nor a trap an agent filed that nobody was shown (let go by age, not by the user).
 * `positives`: what the user stated and still holds, with the words it was drawn from.
 */
function cases(db, limit) {
  const from = `SELECT m.id, m.body, m.source_turn AS turn, m.source_quote AS quote FROM memories m JOIN user_turns t ON t.id = m.source_turn`;
  const negatives = db
    .prepare(
      `${from} WHERE (m.state = 'rejected' OR (m.state = 'invalid' AND julianday(m.invalid_at) - julianday(m.created_at) <= ?))
         AND NOT (m.type = 'gotcha' AND m.provenance = 'observed')
         AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id = m.id AND (e.actor = 'migration' OR e.reason = 'rebuilt'))
       ORDER BY m.id DESC LIMIT ?`,
    )
    .all(JUNK_WITHIN_DAYS, limit);
  const positives = db.prepare(`${from} WHERE m.state = 'active' AND m.provenance = 'stated' AND m.source_quote IS NOT NULL ORDER BY m.id DESC LIMIT ?`).all(limit);
  return { negatives, positives };
}

const flat = (text) => String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim();
/** Whether two quotes of one turn are the same words: one holds the other. */
const sameWords = (a, b) => Boolean(flat(a)) && Boolean(flat(b)) && (flat(a).includes(flat(b)) || flat(b).includes(flat(a)));
/**
 * Whether a statement the extractor would file is this memory again: the same row; drawn from the same words of the
 * same turn — what is filed now is the user's sentence as typed, and a memory from before may say it in an
 * extractor's words, so the turn and the quote are compared first — or the same words the same way round.
 */
const again = (memory, filed) =>
  filed.existing === memory.id || (filed.turnId === memory.turn && sameWords(filed.quote, memory.quote)) || saysAs(memory.body, filed.body) || saysAs(filed.body, memory.body);

/**
 * The extractor run again over the turns behind those memories, one turn a call, writing nothing (`extract` is
 * `dryExtract`). Stops at the first turn the model could not be asked about and says why: a score over part of the
 * cases compares with nothing. `{ ran, failed, error, negatives: { cases, kept, refiled }, positives: { cases, kept, missed } }`,
 * `refiled` and `missed` naming the memories; `failed` when there were cases and the model was off or could not be asked.
 */
async function replayExtractor(db, { limit, now, extract }) {
  const { negatives, positives } = cases(db, limit);
  const out = { ran: false, failed: false, error: null, negatives: { cases: negatives.length, kept: 0, refiled: [] }, positives: { cases: positives.length, kept: 0, missed: [] } };
  if (memoryModel(db) === 'off') return { ...out, failed: true, error: 'the memory pass is off (memory.model) — Memory › Filed by, on the settings page (sumo config), turns it on' };
  if (negatives.length + positives.length === 0) return { ...out, error: 'no memory with the turn it came from to replay yet' };
  const read = new Map();
  const filedFrom = async (turn) => {
    if (!read.has(turn)) {
      const answer = await extract(db, { turnIds: [turn], now });
      if (!answer.ok) throw new UsageError(answer.error ?? 'the model gave no answer');
      read.set(turn, answer.wouldFile);
    }
    return read.get(turn);
  };
  const named = (m) => ({ id: m.id, body: clip(m.body, SHOWN) });
  try {
    for (const m of negatives) {
      if ((await filedFrom(m.turn)).some((filed) => again(m, filed))) out.negatives.refiled.push(named(m));
      else out.negatives.kept++;
    }
    for (const m of positives) {
      if ((await filedFrom(m.turn)).some((filed) => again(m, filed))) out.positives.kept++;
      else out.positives.missed.push(named(m));
    }
  } catch (cause) {
    if (!(cause instanceof UsageError)) throw cause;
    return { ...out, failed: true, error: `the model could not be asked — ${cause.message}` };
  }
  return { ...out, ran: true };
}

/**
 * The whole eval: `{ misses, version, replay, score, cases, previous, worse }`. `score` is the share of the replayed
 * cases the extractor got right (junk kept out, stated kept in), null when the replay did not run through. A score is
 * remembered per extractor version; `previous` is the last one recorded under a different version, and `worse` says
 * this one is below it. `extract` is `dryExtract` unless a test hands in another.
 */
export async function memoryEval(db, { limit = REPLAYED, now = new Date().toISOString(), extract = dryExtract } = {}) {
  const misses = replayMisses(db, now);
  const version = extractorVersion(db);
  const replay = await replayExtractor(db, { limit, now, extract });
  const kept = JSON.parse(getMeta(db, KEPT) || '{}');
  const previous = kept.last && kept.last.version !== version ? kept.last : (kept.other ?? null);
  if (!replay.ran) return { misses, version, replay, score: null, cases: 0, previous, worse: false };
  const count = replay.negatives.cases + replay.positives.cases;
  const score = (replay.negatives.kept + replay.positives.kept) / count;
  setMeta(db, KEPT, JSON.stringify({ last: { version, score, cases: count, at: now }, other: previous }));
  return { misses, version, replay, score, cases: count, previous, worse: previous !== null && score < previous.score };
}

const percent = (share) => `${Math.round(share * 100)}%`;

/**
 * The eval as a person reads it; exit 1 when this extractor scores below the last other one, both scores named — and
 * when it could not be measured at all (the model off, or down): "not replayed" is not a pass.
 */
export function evalLines(result) {
  const { misses, version, replay, score, previous, worse } = result;
  const lines = [
    misses.total === 0 ? 'search: no search has been recorded as finding nothing' : `search: ${misses.found} of ${misses.total} recorded misses now find something`,
    ...misses.still.map((m) => `  still nothing: "${clip(m.query, SHOWN)}" (${m.scope})`),
    ...(misses.stillMore > 0 ? [`  … and ${misses.stillMore} more`] : []),
  ];
  if (!replay.ran) lines.push(`extractor ${version}: not replayed — ${replay.error}`);
  else {
    const { negatives, positives } = replay;
    lines.push(
      `extractor ${version}: ${percent(score)} of ${result.cases} cases`,
      `  thrown out by you: ${negatives.kept} of ${negatives.cases} stay out, ${negatives.refiled.length} would be filed again`,
      ...negatives.refiled.map((m) => `    filed again: m${m.id} ${m.body}`),
      `  stated by you: ${positives.kept} of ${positives.cases} would be kept, ${positives.missed.length} missed`,
      ...positives.missed.map((m) => `    missed: m${m.id} ${m.body}`),
    );
  }
  if (previous) lines.push(`${worse ? 'worse' : 'before'}: extractor ${previous.version} scored ${percent(previous.score)} of ${previous.cases} cases on ${previous.at.slice(0, 10)}${worse ? ` — ${version} scores ${percent(score)}` : ''}`);
  return worse || replay.failed ? Object.assign(lines, { exitCode: 1 }) : lines;
}
