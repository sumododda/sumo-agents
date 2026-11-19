import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { raiseNotice } from './apply.mjs';
import { getMeta, setMeta, tx } from './db.mjs';
import { memoryModel } from './ledger.mjs';
import { storedKeys } from './memory.mjs';
import { callModel, logRun } from './model.mjs';
import { REPO_ROOT } from './paths.mjs';
import { redact } from './redact.mjs';
import { clip, stem, words } from './text.mjs';

/**
 * Memory's tidy, the second half of the one memory pass: weekly, memory itself is gone over — search terms filled in,
 * rules checked for being said twice, pairs judged. It reads memory only; conversations are read once, by the filing
 * half (scribe.mjs), which also asks the pair judge here about a new statement that looks like an old one.
 */

/** How long memory goes between tidies. */
const TIDY_EVERY_MS = 7 * 86_400_000;
/** Pairs put to the local model in one call, and calls in one tidy. */
const PAIRS_PER_CALL = 10;
const TIDY_JUDGE_CALLS = 3;
/** Memories given search terms in one tidy: what the local model answers well in one call. */
const KEYS_PER_TIDY = 20;
const LABELS = ['same', 'replaces', 'conflict', 'unrelated'];
/** A topic as the scribe gives one: a lowercase word. */
const TOPIC = /^[a-z][a-z0-9-]{1,23}$/;
const KEYS_CURSOR = 'dream.keys_cursor';
/** The last rule checked for being said already in other words: each is checked once. */
const REPEATS_CURSOR = 'dream.repeats_cursor';
/** Rules checked a call, and the most of the other rules in their scope shown beside them. */
const REPEATS_PER_CALL = 8;
const REPEAT_NEIGHBOURS = 40;
const LAST_TIDY = 'dream.last_tidy';
const NO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: null, cacheCreationTokens: null };

/** Where the pairs the repeat check named wait to be judged on their own. */
const NAMED_PAIRS = 'dream.named_pairs';

/** The pairs named that wait to be judged on their own, in the order named: `{ label, a, b, note }`, a < b. */
function namedPairs(db) {
  try {
    const named = JSON.parse(getMeta(db, NAMED_PAIRS) ?? '[]');
    return Array.isArray(named) ? named.filter((p) => Number.isInteger(p?.a) && Number.isInteger(p?.b)) : [];
  } catch {
    return [];
  }
}

/** What waits to be judged from here on: those named, less any judged now. */
const keepNamed = (db, named) => setMeta(db, NAMED_PAIRS, JSON.stringify(named));

/**
 * What a model reading a list of rules by number says of two of them waits until the pair is judged on its own: it
 * writes one number for another — a neighbour's for the one it meant — and a pair it never looked at side by side
 * would be a question for the user. Asked once: a pair raised, judged, or waiting already is not named again.
 */
function nameForJudging(db, { label, a, b, note }) {
  const [lo, hi] = a < b ? [a, b] : [b, a];
  if (db.prepare('SELECT 1 FROM notices WHERE memory_a = ? AND memory_b = ?').get(lo, hi)) return;
  if (db.prepare('SELECT 1 FROM memory_pairs WHERE a = ? AND b = ?').get(lo, hi)) return;
  const waiting = namedPairs(db);
  if (waiting.some((p) => p.a === lo && p.b === hi)) return;
  keepNamed(db, [...waiting, { label, a: lo, b: hi, note }]);
}

/** The memories the tidy steps read: active, the user's own rather than scanned from a repository, and not workflows. */
const tidyable = (db) => db.prepare(`SELECT * FROM memories WHERE state = 'active' AND scan_key IS NULL AND type != 'procedure' ORDER BY id`).all();

/** A stem that this many memories share says nothing about any two of them: it is left out of the index. */
const COMMON_STEM = 200;

/**
 * Pairs of memories worth asking about, most alike first: in one scope, or one of them global; and sharing three
 * stems, or two beside a topic or a search term — a topic alone is a shelf, not a likeness. Word overlap alone misses
 * the same rule in other words and two values for one setting, so code only picks the pairs and the local model says
 * what they are. A pair judged before, or already raised for the user, is never picked again. A memory is compared
 * only with those it shares a stem with, through an index, and only the best `limit` are kept as they are found:
 * thousands of memories cost a moment, not every pair of them.
 */
export function candidatePairs(db, limit = PAIRS_PER_CALL) {
  const rows = tidyable(db);
  const judged = new Set(db.prepare('SELECT a, b FROM memory_pairs').all().map((p) => `${p.a}:${p.b}`));
  for (const n of db.prepare('SELECT memory_a, memory_b FROM notices').all()) judged.add(`${Math.min(n.memory_a, n.memory_b)}:${Math.max(n.memory_a, n.memory_b)}`);
  for (const p of namedPairs(db)) judged.add(`${p.a}:${p.b}`);
  const stems = new Map(rows.map((m) => [m.id, new Set(words(m.body).map(stem))]));
  const keys = new Map(rows.map((m) => [m.id, new Set(String(m.keys ?? '').split(',').map((k) => k.trim()).filter(Boolean))]));
  const using = new Map();
  for (const m of rows) for (const s of stems.get(m.id)) (using.get(s) ?? using.set(s, []).get(s)).push(m);
  /** Negative when pair x goes before pair y: more alike first, then the newer. */
  const before = (x, y) => y.rank - x.rank || y.b.id - x.b.id;
  const best = [];
  for (const a of rows) {
    const shared = new Map();
    for (const s of stems.get(a.id)) {
      const others = using.get(s);
      if (others.length > COMMON_STEM) continue;
      for (const b of others) if (b.id > a.id) shared.set(b, (shared.get(b) ?? 0) + 1);
    }
    for (const [b, count] of shared) {
      if (count < 2) continue;
      if (a.scope !== b.scope && a.scope !== 'global' && b.scope !== 'global') continue;
      if (judged.has(`${a.id}:${b.id}`)) continue;
      const topic = Boolean(a.topic) && a.topic === b.topic;
      const term = [...keys.get(a.id)].some((k) => keys.get(b.id).has(k));
      if (count < 3 && !topic && !term) continue;
      const pair = { a, b, rank: count * 2 + (term ? 2 : 0) + (topic ? 1 : 0) };
      if (best.length >= limit && before(pair, best.at(-1)) >= 0) continue;
      const at = best.findIndex((p) => before(pair, p) < 0);
      best.splice(at === -1 ? best.length : at, 0, pair);
      if (best.length > limit) best.pop();
    }
  }
  return best;
}

const PAIRS_SCHEMA = {
  type: 'object',
  properties: {
    pairs: {
      type: 'array',
      items: { type: 'object', properties: { pair: { type: 'integer' }, label: { type: 'string', enum: LABELS } }, required: ['pair', 'label'], additionalProperties: false },
    },
  },
  required: ['pairs'],
  additionalProperties: false,
};

const KEYS_SCHEMA = {
  type: 'object',
  properties: {
    memories: {
      type: 'array',
      items: {
        type: 'object',
        properties: { id: { type: 'integer' }, topic: { type: 'string' }, keys: { type: 'array', items: { type: 'string' } } },
        required: ['id', 'topic', 'keys'],
        additionalProperties: false,
      },
    },
  },
  required: ['memories'],
  additionalProperties: false,
};

/** Whether the tidy steps may run: they call the local model only, never one that is paid for. */
const tidiesLocally = (db) => memoryModel(db) === 'local';

/** One call of the tidy steps to the local model, with the tidy's own instructions, and its ledger row. */
async function askLocal(db, { prompt, schema, kind, now }) {
  const system = readFileSync(join(REPO_ROOT, 'prompts', 'dream.md'), 'utf8').trim();
  const result = await callModel(db, { system, prompt, schema, model: 'local', kind });
  return { result, log: (note) => logRun(db, { kind: 'dream', model: 'local', result, note, now }) };
}

const added = (x, y) => ({ ...x, inputTokens: x.inputTokens + y.inputTokens, outputTokens: x.outputTokens + y.outputTokens, costUsd: x.costUsd + y.costUsd });

const describe = (m) => `m${m.id} (${m.type}, ${m.scope}, ${String(m.created_at).slice(0, 10)}): ${clip(m.body, 300)}`;

/**
 * The pairs a pass named that are still worth asking about, the first `limit` of them, as `{ a, b, named }`. One whose
 * memory is gone, or no longer active, waits no longer.
 */
function namedToJudge(db, limit = PAIRS_PER_CALL) {
  const row = db.prepare(`SELECT * FROM memories WHERE id = ? AND state = 'active'`);
  const named = namedPairs(db).map((p) => ({ a: row.get(p.a), b: row.get(p.b), named: p }));
  const live = named.filter((p) => p.a && p.b);
  if (live.length < named.length) keepNamed(db, live.map((p) => p.named));
  return live.slice(0, limit);
}

/**
 * Pairs judged, and what the judgement means raised for the user: the same thing said twice, one that may replace
 * the other, or two that cannot both be true — the look-alike and contradiction notices the block already asks about.
 * Nothing is superseded or forgotten here; the user settles it. Every pair answered is kept, so it is asked once. The
 * repeat check names pairs too — a rule said twice — and those are judged first, side by side like the rest: raised
 * as the judgement says, the note it was named with kept when it is judged the way it was named.
 */
async function judgePairs(db, { calls, now }) {
  const out = { applied: [], dropped: [], usage: NO_USAGE, calls: 0, error: null };
  for (let call = 0; call < calls; call++) {
    const named = namedToJudge(db);
    const pairs = [...named, ...(named.length < PAIRS_PER_CALL ? candidatePairs(db, PAIRS_PER_CALL - named.length) : [])];
    if (pairs.length === 0) break;
    const prompt = ['Pairs to judge — how memory A relates to memory B in each:', ...pairs.flatMap(({ a, b }, i) => [`[p${i + 1}]`, `  A: ${describe(a)}`, `  B: ${describe(b)}`])].join('\n');
    const { result, log } = await askLocal(db, { prompt, schema: PAIRS_SCHEMA, kind: 'dream-pairs', now });
    out.calls++;
    out.usage = added(out.usage, result.usage);
    // A model that could not answer leaves the tidy owed; an answer in the wrong shape is a bad answer, dropped.
    if (!result.ok) {
      out.error = result.error;
      log(result.error);
      break;
    }
    const labels = Array.isArray(result.data?.pairs) ? result.data.pairs : null;
    if (!labels) {
      out.dropped.push('pairs: the answer had no list of pairs');
      log('the answer had no list of pairs');
      break;
    }
    let judged = 0;
    tx(db, () => {
      for (const answer of labels) {
        const pair = pairs[Number(answer?.pair) - 1];
        if (!pair || !LABELS.includes(answer?.label)) {
          out.dropped.push(`pair ${JSON.stringify(answer?.pair)}: not one of the pairs asked, or no label`);
          continue;
        }
        const { a, b, named: asked } = pair;
        if (db.prepare('SELECT 1 FROM memory_pairs WHERE a = ? AND b = ?').get(a.id, b.id)) continue;
        db.prepare('INSERT INTO memory_pairs (a, b, label, judged_at) VALUES (?, ?, ?, ?)').run(a.id, b.id, answer.label, now);
        judged++;
        const [older, newer] = a.created_at <= b.created_at ? [a, b] : [b, a];
        const raised =
          answer.label === 'same' ? { kind: 'lookalike', note: 'they say the same thing — forget one, or supersede the older with the newer', said: 'say the same thing' }
          : answer.label === 'replaces' ? { kind: 'lookalike', note: `m${newer.id} is newer and may replace m${older.id} — if it does, supersede m${older.id} with it; if both hold, leave them`, said: `may be replaced by m${newer.id}` }
          : answer.label === 'conflict' ? { kind: 'contradiction', note: 'they cannot both be true — only the user knows which holds', said: 'cannot both be true' }
          : null;
        if (!raised) {
          if (asked) out.dropped.push(`m${a.id} and m${b.id}, named as ${asked.label === 'same' ? 'saying the same thing' : 'a clash'}: judged on their own, they are unrelated`);
          continue;
        }
        const kept = asked?.label === answer.label ? asked.note : null;
        if (raiseNotice(db, { kind: raised.kind, a: a.id, b: b.id, note: kept ?? raised.note, now })) out.applied.push(`raised for the user: m${a.id} and m${b.id} ${raised.said}${kept ? ` — ${kept}` : ''}`);
      }
      // What was judged waits no longer; a pair the answer left out is asked again.
      if (named.length > 0) keepNamed(db, namedPairs(db).filter((p) => !db.prepare('SELECT 1 FROM memory_pairs WHERE a = ? AND b = ?').get(p.a, p.b)));
    });
    log(`judged ${judged} of ${pairs.length} pairs`);
    // Nothing judged: the same pairs would be asked again in the same words.
    if (judged === 0) break;
  }
  return out;
}

/**
 * A statement about to be filed that looks like a memory already there — "slate uses pnpm", then "slate uses bun":
 * the fact may have changed. Code picked each pair (`pairs`, as `applyOps` gives them); the local model says what it
 * is, with the same four labels the tidy uses. Returns `labels`, a Map from each statement's place in the answer it
 * came in to `{ old, label }` — only for pairs asked and labels of the four — or undefined when the model could not
 * be asked or did not answer in shape: the pairs then go to the user as notices, as they always did.
 */
export async function judgeNewPairs(db, pairs, now) {
  const today = now.slice(0, 10);
  const prompt = [
    // Each with the day it was said: a rebuild reads old turns, and "just said" made an old statement the newer one.
    'Pairs to judge — how memory A relates to memory B in each (B is a statement of the user\'s, not yet filed; each has the day it was said):',
    ...pairs.flatMap(({ old, type, scope, body, said }, i) => [`[p${i + 1}]`, `  A: ${describe(old)}`, `  B: new (${type}, ${scope}, ${(said ?? today).slice(0, 10)}): ${clip(body, 300)}`]),
  ].join('\n');
  const { result, log } = await askLocal(db, { prompt, schema: PAIRS_SCHEMA, kind: 'dream-pairs', now });
  if (!result.ok) {
    log(result.error);
    return { labels: undefined, usage: result.usage };
  }
  const answers = Array.isArray(result.data?.pairs) ? result.data.pairs : null;
  if (!answers) {
    log('the answer had no list of pairs');
    return { labels: undefined, usage: result.usage };
  }
  const labels = new Map();
  for (const answer of answers) {
    const pair = pairs[Number(answer?.pair) - 1];
    if (pair && LABELS.includes(answer?.label)) labels.set(pair.index, { old: pair.old.id, label: answer.label });
  }
  log(`judged ${labels.size} of ${pairs.length} new statements against what they look like`);
  return { labels, usage: result.usage };
}

const REPEATS_SCHEMA = {
  type: 'object',
  properties: {
    repeats: {
      type: 'array',
      items: { type: 'object', properties: { rule: { type: 'integer' }, same_as: { type: 'integer' } }, required: ['rule', 'same_as'], additionalProperties: false },
    },
  },
  required: ['repeats'],
  additionalProperties: false,
};

/**
 * The same rule said twice in other words — "I prefer short answers", then "keep your replies brief" — shares no word,
 * so no pair index finds it. Each rule not yet checked is shown beside the other rules where it applies, and the local
 * model names any it says again: one call for a batch, each rule checked once (mem0 checks a new fact against its
 * neighbours the same way). What it names is judged on its own next, and raised for the user only as that judgement
 * says; nothing is retired here.
 */
async function checkRepeats(db, { now }) {
  const out = { applied: [], dropped: [], usage: NO_USAGE, calls: 0, error: null };
  const rules = tidyable(db).filter((m) => m.type === 'preference' || m.type === 'decision');
  const from = Number(getMeta(db, REPEATS_CURSOR) ?? 0);
  const batch = rules.filter((m) => m.id > from).slice(0, REPEATS_PER_CALL);
  if (batch.length === 0) return out;
  const reaches = new Set(batch.map((m) => m.scope));
  const near = rules.filter((m) => m.scope === 'global' || reaches.has(m.scope) || reaches.has('global')).slice(-REPEAT_NEIGHBOURS);
  const shown = new Map([...near, ...batch].map((m) => [m.id, m]));
  if (shown.size < 2) {
    setMeta(db, REPEATS_CURSOR, batch.at(-1).id);
    return out;
  }
  const prompt = [
    // One list, said plainly to be the user's words as typed. Shown the rules twice — those checked, then all — the
    // local model named "I prefer short answers, everywhere" and "keep your replies brief, always, in every project"
    // or missed them according to what kind a third rule was; asked this way it named them every time, and two other
    // pairs, and nothing among rules that differ (tried on the local model, Nov 18 2026). Code keeps only an answer
    // about a rule being checked.
    "Rules said twice — these are the user's own words, as they typed them. Name every two that ask for the same thing in other words (rule: the later one, same_as: the earlier):",
    ...[...shown.values()].sort((x, y) => x.id - y.id).map((m) => `m${m.id} (${m.type}, ${m.scope}): ${clip(m.body, 300)}`),
  ].join('\n');
  const { result, log } = await askLocal(db, { prompt, schema: REPEATS_SCHEMA, kind: 'dream-repeats', now });
  out.calls = 1;
  out.usage = result.usage;
  if (!result.ok) {
    out.error = result.error;
    log(result.error);
    return out;
  }
  const answers = Array.isArray(result.data?.repeats) ? result.data.repeats : null;
  // Checked, whatever came back: a bad answer is not asked again in the same words.
  setMeta(db, REPEATS_CURSOR, batch.at(-1).id);
  if (!answers) {
    out.dropped.push('repeats: the answer had no list');
    log('the answer had no list of repeats');
    return out;
  }
  const checked = new Set(batch.map((m) => m.id));
  tx(db, () => {
    for (const answer of answers) {
      // Either way round: the pair is the answer, and one of the two must be a rule this call checks.
      const named = [shown.get(Number(answer?.rule)), shown.get(Number(answer?.same_as))];
      const [a, b] = named[0] && !checked.has(named[0].id) ? [named[1], named[0]] : named;
      if (!a || !b || a.id === b.id || !checked.has(a.id)) {
        out.dropped.push(`repeat m${JSON.stringify(answer?.rule)} of m${JSON.stringify(answer?.same_as)}: not a rule checked and another rule shown`);
        continue;
      }
      if (a.scope !== b.scope && a.scope !== 'global' && b.scope !== 'global') {
        out.dropped.push(`repeat m${a.id} of m${b.id}: they hold in different projects`);
        continue;
      }
      // Named without a note of its own: the judgement says it.
      nameForJudging(db, { label: 'same', a: a.id, b: b.id, note: null });
    }
  });
  log(`checked ${batch.length} rules for repeats`);
  return out;
}

/**
 * Search terms and a topic for memories that have none, so a search in other words finds them: the next batch from
 * where the last tidy stopped. Each term passes the same check as the scribe's (`storedKeys`); a bad one is dropped,
 * never stored, and a topic is a lowercase word or nothing. What a memory already has is never replaced.
 */
async function fillKeys(db, { now }) {
  const out = { applied: [], dropped: [], usage: NO_USAGE, calls: 0, error: null };
  const lacking = tidyable(db).filter((m) => m.keys === null || m.topic === null);
  const from = Number(getMeta(db, KEYS_CURSOR) ?? 0);
  const batch = [...lacking.filter((m) => m.id > from), ...lacking.filter((m) => m.id <= from)].slice(0, KEYS_PER_TIDY);
  if (batch.length === 0) return out;
  const prompt = ['Search terms — a topic and keys for each memory:', ...batch.map((m) => `[m${m.id}] ${clip(m.body, 300)}`)].join('\n');
  const { result, log } = await askLocal(db, { prompt, schema: KEYS_SCHEMA, kind: 'dream-keys', now });
  out.calls = 1;
  out.usage = result.usage;
  if (!result.ok) {
    out.error = result.error;
    log(result.error);
    return out;
  }
  const answers = Array.isArray(result.data?.memories) ? result.data.memories : null;
  if (!answers) {
    out.dropped.push('search terms: the answer had no list of memories');
    log('the answer had no list of memories');
    setMeta(db, KEYS_CURSOR, batch.at(-1).id);
    return out;
  }
  const asked = new Map(batch.map((m) => [m.id, m]));
  const given = [];
  tx(db, () => {
    for (const answer of answers) {
      const m = asked.get(Number(answer?.id));
      if (!m) {
        out.dropped.push(`search terms for m${JSON.stringify(answer?.id)}: not one of the memories asked`);
        continue;
      }
      const topic = m.topic === null && typeof answer.topic === 'string' && TOPIC.test(answer.topic.trim()) && redact(answer.topic).count === 0 ? answer.topic.trim() : null;
      const keys = m.keys === null ? storedKeys(answer.keys, m.body) : null;
      if (!topic && !keys) continue;
      db.prepare('UPDATE memories SET topic = COALESCE(topic, ?), keys = COALESCE(keys, ?) WHERE id = ?').run(topic, keys, m.id);
      asked.delete(m.id);
      given.push(`m${m.id}`);
    }
  });
  setMeta(db, KEYS_CURSOR, batch.at(-1).id);
  if (given.length > 0) out.applied.push(`search terms for ${given.length} memor${given.length === 1 ? 'y' : 'ies'}: ${given.join(', ')}`);
  log(`search terms for ${given.length} of ${batch.length}`);
  return out;
}

/**
 * Whether the weekly tidy is due: a week since the last one, with something to tidy. Never tidied, the week runs from
 * the oldest memory — memory a day old has nothing to tidy yet. Pure: it reads, never runs.
 */
export function tidyDue(db, now = new Date().toISOString()) {
  const since = getMeta(db, LAST_TIDY) ?? db.prepare(`SELECT MIN(created_at) AS at FROM memories WHERE state = 'active' AND scan_key IS NULL`).get()?.at;
  if (!since || Date.parse(now) - Date.parse(since) < TIDY_EVERY_MS) return false;
  return Boolean(db.prepare(`SELECT 1 FROM memories WHERE state = 'active' AND scan_key IS NULL LIMIT 1`).get());
}

/**
 * The tidy: search terms filled in; rules checked for being said twice; and pairs judged — those the check named
 * first. Run when the week is up, or now when asked (`sumo memory run --tidy`); the caller decides which, and holds
 * the lock. It calls the local model only, never one that is paid for: set to another model, there is nothing it does.
 * A tidy the local model could not answer stays due.
 */
export async function runDream(db, { now = new Date().toISOString() } = {}) {
  if (!tidiesLocally(db)) {
    setMeta(db, LAST_TIDY, now);
    return { skipped: 'memory is tidied by the local model only, and memory.model is not local' };
  }
  const steps = [await fillKeys(db, { now }), await checkRepeats(db, { now }), await judgePairs(db, { calls: TIDY_JUDGE_CALLS, now })];
  const tidy = {
    applied: steps.flatMap((s) => s.applied),
    dropped: steps.flatMap((s) => s.dropped),
    usage: steps.reduce((u, s) => added(u, s.usage), NO_USAGE),
    calls: steps.reduce((n, s) => n + s.calls, 0),
    error: steps.find((s) => s.error)?.error ?? null,
  };
  if (!tidy.error) setMeta(db, LAST_TIDY, now);
  if (tidy.calls === 0) return { skipped: 'memory has nothing to tidy' };
  if (tidy.error && tidy.applied.length === 0) return { ok: false, error: tidy.error, applied: [], dropped: tidy.dropped, usage: tidy.usage };
  return { ok: true, error: null, applied: tidy.applied, dropped: tidy.dropped, usage: tidy.usage };
}
