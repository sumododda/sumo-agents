import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { keepNamed, namedPairs, nameForJudging, raiseNotice } from './apply.mjs';
import { getMeta, setMeta, tx } from './db.mjs';
import { storedKeys } from './memory.mjs';
import { callModel, logRun } from './model.mjs';
import { REPO_ROOT } from './paths.mjs';
import { redact } from './redact.mjs';
import { knownProjectsLine, askAndApply, relatedMemories, runScribe, withLock, writerOff } from './scribe.mjs';
import { line } from './render.mjs';
import { sessionsAwaitingDream } from './sessions.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { clip, stem, words } from './text.mjs';

/** Finished sessions waiting that make a pass worth running by itself. */
export const SESSIONS_TO_TIDY = 3;
/** How long memory goes between tidies — pairs judged, search terms filled in — when no conversation brings one sooner. */
const TIDY_EVERY_MS = 7 * 86_400_000;
/** The oldest memories a pass reads beside the related and the newest, moving on each pass so nothing old goes unread for long. */
const SWEEP_SLICE = 20;
/** Pairs put to the local model in one call, and calls in one pass: one when conversations bring it, a few when it is the weekly tidy. */
const PAIRS_PER_CALL = 10;
const JUDGE_CALLS = 1;
const TIDY_JUDGE_CALLS = 3;
/** Memories given search terms in one tidy: what the local model answers well in one call. */
const KEYS_PER_TIDY = 20;
const LABELS = ['same', 'replaces', 'conflict', 'unrelated'];
/** A topic as the scribe gives one: a lowercase word. */
const TOPIC = /^[a-z][a-z0-9-]{1,23}$/;
const SWEEP_CURSOR = 'dream.sweep_cursor';
const KEYS_CURSOR = 'dream.keys_cursor';
/** The last rule checked for being said already in other words: each is checked once. */
const REPEATS_CURSOR = 'dream.repeats_cursor';
/** Rules checked a call, and the most of the other rules in their scope shown beside them. */
const REPEATS_PER_CALL = 8;
const REPEAT_NEIGHBOURS = 40;
const LAST_TIDY = 'dream.last_tidy';
const NO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: null, cacheCreationTokens: null };

const MAX_SESSIONS = 5;
const TURN_MAX = 600;
/** Each session's share of what fits the local model's context: its latest turns, as many as fit. The writer has filed every one already. */
const SESSION_CHARS = 8_000;

/** The last of a session's turns that fit its share, each clipped; the rest are counted, not shown. */
function latestThatFit(turns) {
  const shown = [];
  let used = 0;
  for (const t of [...turns].reverse()) {
    const line = `[t${t.id}] user: ${clip(t.text, TURN_MAX)}`;
    if (shown.length > 0 && used + line.length > SESSION_CHARS) break;
    shown.unshift(line);
    used += line.length;
  }
  const left = turns.length - shown.length;
  return left > 0 ? [`[${left} earlier turn${left === 1 ? '' : 's'} not shown]`, ...shown] : shown;
}
const MAX_MEMORIES = 60;

/**
 * The slow pass. The writer files each conversation as it happens; this one
 * reads several finished conversations side by side, which is the only way to
 * see what no single one shows: a correction the user keeps repeating, two
 * memories that cannot both be true, a routine worth naming.
 */
function buildBundle(db, sessions) {
  const ids = sessions.map((s) => s.id);
  const marks = ids.map(() => '?').join(', ');
  const turns = db.prepare(`SELECT * FROM user_turns WHERE session_id IN (${marks}) ORDER BY id`).all(...ids);
  const checkpoints = db.prepare(`SELECT * FROM checkpoints WHERE session_id IN (${marks}) ORDER BY id`).all(...ids);
  const projects = db.prepare(`SELECT DISTINCT slug FROM session_injections WHERE session_id IN (${marks}) AND slug NOT LIKE '%:%'`).all(...ids).map((r) => r.slug);

  const scopes = ['global', ...projects.map((p) => `project:${p}`)];
  const { memories, cursor } = shownMemories(db, scopes, turns.map((t) => t.text));

  const sections = [];
  for (const session of sessions) {
    sections.push(`--- session started ${session.started_at.slice(0, 16)}`);
    sections.push(...latestThatFit(turns.filter((x) => x.session_id === session.id)));
    for (const c of checkpoints.filter((x) => x.session_id === session.id)) sections.push(`[done in ${c.project}]: ${c.done}${c.next_step ? ` → next: ${c.next_step}` : ''}`);
  }

  const prompt = [
    knownProjectsLine(db),
    memories.length > 0 ? `What is already remembered:\n${memories.map(line).join('\n')}` : 'Nothing is remembered yet.',
    ...sections,
  ].join('\n');
  // What it was shown is what it may name as saying the same thing.
  return { prompt, turns: new Map(turns.map((t) => [t.id, t])), shown: new Set(memories.map((m) => m.id)), cursor };
}

/**
 * What a pass is shown of memory, at most MAX_MEMORIES: the memories most related to what was said, a slice of the
 * oldest that moves on with every pass — from where the last one stopped, round to the start again — and the newest
 * for the rest. All of them when there are no more than that. Returns them by id, with where the slice stopped.
 */
function shownMemories(db, scopes, texts) {
  const pool = db.prepare(`SELECT * FROM memories WHERE state = 'active' AND scan_key IS NULL AND scope IN (${scopes.map(() => '?').join(', ')}) ORDER BY id`).all(...scopes);
  if (pool.length <= MAX_MEMORIES) return { memories: pool, cursor: null };
  const chosen = new Map(relatedMemories(db, texts, scopes).map((m) => [m.id, m]));
  const from = Number(getMeta(db, SWEEP_CURSOR) ?? 0);
  const slice = [...pool.filter((m) => m.id > from), ...pool.filter((m) => m.id <= from)].filter((m) => !chosen.has(m.id)).slice(0, SWEEP_SLICE);
  for (const m of slice) chosen.set(m.id, m);
  for (const m of [...pool].reverse()) {
    if (chosen.size >= MAX_MEMORIES) break;
    chosen.set(m.id, m);
  }
  return { memories: [...chosen.values()].sort((a, b) => a.id - b.id), cursor: slice.at(-1)?.id ?? null };
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
const tidiesLocally = (db) => (getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model']) === 'local';

/** One call of the tidy steps to the local model, with the consolidation pass's own instructions, and its ledger row. */
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
 * Nothing is superseded or forgotten here; the user settles it. Every pair answered is kept, so it is asked once. A
 * model reading a list names pairs too — a rule said twice, a clash — and those are judged first, side by side like
 * the rest: raised as the judgement says, the note it was named with kept when it is judged the way it was named.
 * `fill` false judges only those.
 */
async function judgePairs(db, { calls, now, fill = true }) {
  const out = { applied: [], dropped: [], usage: NO_USAGE, calls: 0, error: null };
  for (let call = 0; call < calls; call++) {
    const named = namedToJudge(db);
    const pairs = [...named, ...(fill && named.length < PAIRS_PER_CALL ? candidatePairs(db, PAIRS_PER_CALL - named.length) : [])];
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
    'Rules said twice — for each rule checked, the rule in the list that says the same thing in other words, if one does:',
    'Rules checked:',
    ...batch.map((m) => `[m${m.id}] ${clip(m.body, 300)}`),
    'All rules:',
    ...[...shown.values()].sort((x, y) => x.id - y.id).map(describe),
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
      const a = shown.get(Number(answer?.rule));
      const b = shown.get(Number(answer?.same_as));
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
 * Whether the weekly tidy is owed: a week since the last one, with something to tidy. Never tidied, the week runs from
 * the oldest memory — memory a day old has nothing to tidy yet.
 */
function tidyOwed(db, now) {
  const since = getMeta(db, LAST_TIDY) ?? db.prepare(`SELECT MIN(created_at) AS at FROM memories WHERE state = 'active' AND scan_key IS NULL`).get()?.at;
  if (!since || Date.parse(now) - Date.parse(since) < TIDY_EVERY_MS) return false;
  return Boolean(db.prepare(`SELECT 1 FROM memories WHERE state = 'active' AND scan_key IS NULL LIMIT 1`).get());
}

/**
 * Whether a consolidation pass is worth running by itself now: three finished sessions are waiting to be read side by
 * side, or a week has gone since memory was last tidied and there is memory to tidy. Pure: it reads, never runs.
 */
export function tidyDue(db, now = new Date().toISOString()) {
  return sessionsAwaitingDream(db, now, SESSIONS_TO_TIDY).length >= SESSIONS_TO_TIDY || tidyOwed(db, now);
}

/**
 * The tidy steps of a pass: weekly, search terms filled in; rules checked for being said twice; and pairs judged — those
 * the check named first — in one call, or a few in the weekly tidy.
 */
async function tidyMemory(db, { weekly, now }) {
  const steps = [];
  if (weekly) steps.push(await fillKeys(db, { now }));
  steps.push(await checkRepeats(db, { now }));
  steps.push(await judgePairs(db, { calls: weekly ? TIDY_JUDGE_CALLS : JUDGE_CALLS, now }));
  return {
    applied: steps.flatMap((s) => s.applied),
    dropped: steps.flatMap((s) => s.dropped),
    usage: steps.reduce((u, s) => added(u, s.usage), NO_USAGE),
    calls: steps.reduce((n, s) => n + s.calls, 0),
    error: steps.find((s) => s.error)?.error ?? null,
  };
}

/**
 * The pairs the reading of the conversations named — a clash, one thing said twice — judged on their own before anything
 * is put to the user. With no local model to judge them (the tidy steps never call a paid one), they are raised as named.
 */
async function settleNamed(db, { now }) {
  if (namedPairs(db).length === 0) return { applied: [], dropped: [], usage: NO_USAGE };
  if (tidiesLocally(db)) {
    const judged = await judgePairs(db, { calls: 1, now, fill: false });
    // Not answered, they wait for the next tidy, which judges them first.
    return judged.error ? { ...judged, dropped: [...judged.dropped, `the pairs named wait to be judged: ${judged.error}`] } : judged;
  }
  const applied = [];
  tx(db, () => {
    for (const { a, b, named } of namedToJudge(db, Infinity)) {
      const [kind, said] = named.label === 'same' ? ['lookalike', 'say the same thing'] : ['contradiction', 'cannot both be true'];
      const note = named.note ?? `they ${said}`;
      if (raiseNotice(db, { kind, a: a.id, b: b.id, note, now })) applied.push(`raised for the user: m${a.id} and m${b.id} ${said} — ${note}`);
    }
    keepNamed(db, []);
  });
  return { applied, dropped: [], usage: NO_USAGE };
}

/**
 * The consolidation pass, which is also memory's tidy: the conversations waiting are read side by side, and memory
 * itself is gone over — pairs judged, and weekly, search terms filled in. `sweep` asks for the weekly part now; it is
 * done anyway once a week has gone. With no conversation waiting and no tidy owed, there is nothing to do.
 */
export async function runDream(db, { now = new Date().toISOString(), force = false, sweep = false, file = true } = {}) {
  // Anything still unfiled belongs to the writer first; consolidation reads its results. The memory pass files first
  // itself, so it can say what the filing did, and asks for none here.
  if (file) await runScribe(db, { now });

  return withLock('dream', async () => {
    // A conversation the writer has not finished filing (it is busy, failing, or behind) waits for it.
    const unfiled = new Set(writerOff(db) ? [] : db.prepare('SELECT DISTINCT session_id FROM user_turns WHERE scribed = 0').all().map((r) => r.session_id));
    const over = sessionsAwaitingDream(db, now, MAX_SESSIONS).filter((s) => !unfiled.has(s.id));
    // Forced, a pass also reads conversations still going on, after the finished ones. It never closes them:
    // what is said in the rest of one is read once it is over.
    const open = force
      ? sessionsAwaitingDream(db, now, MAX_SESSIONS, { includeOpen: true }).filter((s) => !unfiled.has(s.id) && !over.some((o) => o.id === s.id))
      : [];
    const sessions = [...over, ...open].slice(0, MAX_SESSIONS).sort((a, b) => a.started_at.localeCompare(b.started_at));
    const weekly = sweep || tidyOwed(db, now);
    if (sessions.length === 0 && !weekly) return { skipped: 'no finished sessions are waiting' };

    // Memory is tidied first, so what the conversations bring is read against it as it now stands.
    const tidy = tidiesLocally(db) ? await tidyMemory(db, { weekly, now }) : { applied: [], dropped: [], usage: NO_USAGE, calls: 0, error: null };
    // A tidy the local model could not answer is owed still; one that had nothing to ask is done.
    if (weekly && !tidy.error) setMeta(db, LAST_TIDY, now);
    if (sessions.length === 0) {
      if (tidy.calls === 0) return { skipped: 'no finished sessions are waiting, and memory has nothing to tidy' };
      if (tidy.error && tidy.applied.length === 0) return { ok: false, error: tidy.error, applied: [], dropped: tidy.dropped, usage: tidy.usage };
      return { ok: true, error: null, applied: tidy.applied, dropped: tidy.dropped, usage: tidy.usage, sessions: 0 };
    }

    const bundle = buildBundle(db, sessions);
    let lastTurn = 0;
    for (const id of bundle.turns.keys()) lastTurn = id;
    const outcome = await askAndApply(db, {
      kind: 'dream', promptFile: 'dream.md', bundle,
      ops: ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'same', 'procedure'], sessionId: null, now,
    });
    if (outcome.ok && over.length > 0) {
      // A resumed session may have received a new turn while the model read the snapshot.
      db.prepare(`UPDATE sessions SET dream_state = 'done' WHERE id IN (${over.map(() => '?').join(', ')})
        AND NOT EXISTS (SELECT 1 FROM user_turns t WHERE t.session_id = sessions.id AND t.id > ?)`)
        .run(...over.map((s) => s.id), lastTurn);
    }
    // The slice of the oldest moves on only past a pass that read it.
    if (outcome.ok && bundle.cursor !== null) setMeta(db, SWEEP_CURSOR, bundle.cursor);
    const named = outcome.ok ? await settleNamed(db, { now }) : { applied: [], dropped: [], usage: NO_USAGE };
    return {
      ...outcome,
      applied: [...tidy.applied, ...outcome.applied, ...named.applied],
      dropped: [...tidy.dropped, ...outcome.dropped, ...named.dropped],
      usage: added(added(tidy.usage, outcome.usage ?? NO_USAGE), named.usage),
      sessions: sessions.length,
    };
  });
}
