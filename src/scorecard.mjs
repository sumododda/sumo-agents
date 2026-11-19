import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ALL_MODELS, modelId, NAME_WIDTH } from './catalog.mjs';
import { getMeta, setMeta } from './db.mjs';

/**
 * How good each model is at each effort, from benchmarks other people publish: fetched once, by Discover (and the first
 * `sumo setup`), and saved; routing reads what was saved and fetches nothing. Three sources, none needing a key, each
 * scoring on its own scale — so a score is never averaged as it is: within each source it becomes a place among Sumo's
 * models, 0 the worst and 1 the best, and a route's score is the mean of its places in the sources that list it.
 * - CursorBench, as Epoch AI collects it (CC-BY): coding-agent tasks passed, and the cost of one, for every model and effort.
 * - LMArena's agent leaderboard (CC-BY-4.0): people's votes in agent sessions, per model and effort.
 * - Artificial Analysis's Intelligence Index, as modelgrep serves it: one general score per model.
 * Code reads every number; no model reads a page here.
 */
export const SOURCES = [
  { id: 'cursorbench', name: 'CursorBench, via Epoch AI', url: 'https://epoch.ai/data/benchmark_data.zip' },
  { id: 'arena', name: 'LMArena agent leaderboard', url: 'https://huggingface.co/datasets/lmarena-ai/leaderboard-dataset' },
  { id: 'intelligence', name: 'Artificial Analysis Intelligence Index, via modelgrep', url: 'https://modelgrep.com/api' },
];

const KEY = 'scorecard';
const TIMEOUT_MS = 30_000;
const ARENA_ROWS = 'https://datasets-server.huggingface.co/rows?dataset=lmarena-ai/leaderboard-dataset&config=agent&split=latest';
const MODELGREP = 'https://modelgrep.com/api/v1/models';
/** What the sources call an effort, as Sumo calls it; a level Sumo has no word for (none, minimal, unknown) is left out. */
const EFFORT_WORDS = { low: 'low', medium: 'medium', high: 'high', xhigh: 'xhigh', 'extra high': 'xhigh', max: 'max' };
/** A model's own row, when a source scores the model and not one effort of it. */
const ANY = '*';

/** A model's name as the sources and the API spell it, the same way: no maker, no punctuation, lower case — `Claude Haiku 5.5` and `anthropic/claude-haiku-5.5` are both `claude-haiku-5-5`. */
const plain = (name) => String(name).toLowerCase().replace(/^[^/]*\//, '').replace(/[\s._]+/g, '-').replace(/^-+|-+$/g, '');

/** The Sumo model a source's name means, or null for one Sumo does not run. */
function sumoModel(name, models) {
  const wanted = plain(name);
  return models.find((m) => plain(modelId(m)) === wanted) ?? null;
}

/** The effort a source's word means: a level Sumo has, `*` for none named, null for one Sumo has no word for. */
function effortOf(word) {
  if (word === undefined || word === null || String(word).trim() === '') return ANY;
  return EFFORT_WORDS[String(word).trim().toLowerCase()] ?? null;
}

/**
 * One entry per model and effort a source scores, keeping the higher score where it lists one twice. `tally`, when given, counts
 * what was left out and why: rows of models Sumo does not run, at an effort it has no word for, with no score, or listed twice.
 */
function entriesOf(rows, models, tally = null) {
  const kept = new Map();
  const count = (why) => tally && (tally[why] = (tally[why] ?? 0) + 1);
  for (const { name, effort: word, score, cost } of rows) {
    const model = sumoModel(name, models);
    const effort = effortOf(word);
    if (!model) count('model');
    else if (effort === null) count('effort');
    else if (!Number.isFinite(score)) count('score');
    else {
      const key = `${model}/${effort}`;
      if (kept.has(key)) count('twice');
      if (!kept.has(key) || kept.get(key).score < score) kept.set(key, { model, effort, score, cost: Number.isFinite(cost) ? cost : null });
    }
  }
  if (tally) tally.rows = rows.length;
  return [...kept.values()];
}

/** A CSV file's rows as objects by header: quoted fields may hold commas, newlines and doubled quotes. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quoted) {
      if (c === '"' && text[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      row.push(field);
      field = '';
    } else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else field += c;
  }
  if (field !== '' || row.length > 0) rows.push([...row, field]);
  const [header = [], ...body] = rows.filter((r) => r.some((f) => f !== ''));
  return body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ''])));
}

/** CursorBench's rows: `claude-opus-5-5_high` is a model and its effort; a name with no effort after it scores the model. */
export function fromCursorBench(csv, models = ALL_MODELS, tally = null) {
  const rows = parseCsv(csv).map((r) => {
    const version = r['Model version'] ?? '';
    const cut = version.lastIndexOf('_');
    const [name, effort] = cut > 0 ? [version.slice(0, cut), version.slice(cut + 1)] : [version, undefined];
    return { name, effort, score: Number.parseFloat(r.Score), cost: Number.parseFloat(r['Cost per task']) };
  });
  return entriesOf(rows, models, tally);
}

/** LMArena's rows: `Claude Opus 5.5 (High)` is a model and its effort; only the overall board counts. */
export function fromArena(rows, models = ALL_MODELS, tally = null) {
  const read = rows
    .filter((r) => (r.category ?? 'overall') === 'overall')
    .map((r) => {
      const named = /^(.*?)\s*\(([^)]*)\)\s*$/.exec(r.model_name ?? '');
      return { name: named ? named[1] : r.model_name, effort: named ? named[2] : undefined, score: r.score, cost: r.cost_per_task_p50 };
    });
  return entriesOf(read, models, tally);
}

/** modelgrep's rows: one Intelligence Index per model, at no effort in particular. */
export function fromIntelligence(rows, models = ALL_MODELS, tally = null) {
  return entriesOf(rows.map((r) => ({ name: r.id, score: r.benchmarks?.artificial_analysis?.intelligence })), models, tally);
}

/** The models a source's entries score, each once. */
const modelsIn = (entries) => [...new Set(entries.map((e) => e.model))];

/**
 * Each entry's place among the others in its source: 0 the lowest score, 1 the highest, ties sharing a place. A source that
 * scores fewer than two of Sumo's models says nothing: one model's efforts placed against each other would put its lower one at
 * the bottom of Sumo's models, below models the source never ranked.
 */
function placed(entries) {
  if (modelsIn(entries).length < 2) return [];
  const sorted = entries.map((e) => e.score).sort((a, b) => a - b);
  const rank = (score) => {
    const first = sorted.indexOf(score);
    const last = sorted.lastIndexOf(score);
    return (first + last) / 2 / (sorted.length - 1);
  };
  return entries.map((e) => ({ ...e, place: rank(e.score) }));
}

/** Bytes as a person reads them. */
const sized = (n) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : n >= 1000 ? `${(n / 1000).toFixed(1)} KB` : `${n} B`);
/** How long a source that failed is given before it is tried once more: a dropped connection is often back by then. */
const RETRY_MS = 2000;
/** The most one answer may send — the archive is 2.3 MB today — and the longest one source may take, every page of it, each try. */
const MAX_BYTES = 32 * 1024 * 1024;
const SOURCE_MS = 90_000;
/**
 * Why a request failed, in words: a timeout is said as one, not as an abort — the source's own deadline (`limits`) apart from
 * one request's — and Node's bare "fetch failed" with what was under it: the connection reset, the name not found, the
 * certificate refused.
 */
function failedBecause(cause, limits) {
  if (limits?.deadline?.aborted) return `not read in ${limits.sourceMs / 1000} s, the most a source is given`;
  if (cause?.name === 'TimeoutError') return `no answer in ${TIMEOUT_MS / 1000} s`;
  const under = cause?.cause;
  const detail = under && (under.code || under.message) ? ` (${[under.code, under.code ? null : under.message].filter(Boolean).join(': ')})` : '';
  return `${String(cause?.message ?? cause)}${detail}`.slice(0, 200);
}

/**
 * One GET, said as it goes (`say`): the address, then the status, the size and the time. The body comes back as bytes, read
 * no further than `limits.maxBytes`, and the request ends at `limits.deadline`, the source's, if that comes first.
 */
async function get(fetchImpl, url, say, limits) {
  say(`GET ${url}`);
  const started = Date.now();
  limits.deadline.throwIfAborted();
  const res = await fetchImpl(url, { signal: AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), limits.deadline]), headers: { 'user-agent': 'sumo-agents' } });
  const tooBig = () => new Error(`sent more than ${sized(limits.maxBytes)}, the most a source may send`);
  if (Number(res.headers.get('content-length')) > limits.maxBytes) throw tooBig();
  const chunks = [];
  let length = 0;
  for await (const chunk of res.body ?? []) {
    length += chunk.length;
    if (length > limits.maxBytes) throw tooBig();
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  say(`  ${res.status} · ${sized(body.length)} · ${((Date.now() - started) / 1000).toFixed(2)} s`);
  if (!res.ok) throw new Error(`answered ${res.status}`);
  return body;
}

/** Every page of a listing that says how many rows it has, `limit` at a time, until the source's deadline. */
async function allPages(fetchImpl, url, say, limits, { limit, rowsOf, totalOf, size = 'length' }) {
  const rows = [];
  for (let at = 0; at < 2000; at += limit) {
    const page = JSON.parse(await get(fetchImpl, `${url}${url.includes('?') ? '&' : '?'}offset=${at}&${size}=${limit}`, say, limits));
    rows.push(...rowsOf(page));
    if (rows.length >= totalOf(page) || rowsOf(page).length === 0) break;
  }
  say(`  ${rows.length} rows`);
  return rows;
}

/** The one file Sumo reads out of Epoch's archive, with the unzip macOS ships: no library to unpack it. */
function cursorBenchCsv(bytes) {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-scorecard-'));
  try {
    const file = join(dir, 'benchmark_data.zip');
    writeFileSync(file, bytes);
    return execFileSync('/usr/bin/unzip', ['-p', file, 'cursorbench_external.csv'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** How each source is read: its requests, said as they go and held to `limits`, then its rows read for Sumo's models. */
const READERS = {
  cursorbench: async (fetchImpl, say, tally, limits) => {
    const csv = cursorBenchCsv(await get(fetchImpl, SOURCES[0].url, say, limits));
    say('  unzipped cursorbench_external.csv');
    return fromCursorBench(csv, ALL_MODELS, tally);
  },
  arena: async (fetchImpl, say, tally, limits) =>
    fromArena(await allPages(fetchImpl, ARENA_ROWS, say, limits, { limit: 100, rowsOf: (p) => (p.rows ?? []).map((r) => r.row), totalOf: (p) => p.num_rows_total ?? 0 }), ALL_MODELS, tally),
  intelligence: async (fetchImpl, say, tally, limits) =>
    fromIntelligence(await allPages(fetchImpl, MODELGREP, say, limits, { limit: 200, size: 'limit', rowsOf: (p) => p.data ?? [], totalOf: (p) => p.meta?.total ?? 0 }), ALL_MODELS, tally),
};

/** What a source's rows came to: how many were kept, for which models, and what was left out and why. */
function keptLines(entries, tally) {
  const per = ALL_MODELS.map((m) => [m, entries.filter((e) => e.model === m).length]).filter(([, n]) => n > 0);
  const lines = [`kept ${entries.length} of ${tally.rows} rows${per.length > 0 ? `: ${per.map(([m, n]) => `${m} ${n}`).join(', ')}` : ''}`];
  const why = { model: "of models Sumo doesn't run", effort: 'at an effort Sumo has no word for', score: 'with no score', twice: 'listed twice (the better kept)' };
  const left = Object.entries(why).filter(([k]) => tally[k] > 0).map(([k, said]) => `${tally[k]} ${said}`);
  if (left.length > 0) lines.push(`left out ${left.join(', ')}`);
  return lines;
}

/** Why a source's entries place nothing (see `placed`), or null when they place Sumo's models. */
function unplaced(entries) {
  const models = modelsIn(entries);
  if (models.length === 0) return "none of Sumo's models is listed";
  return models.length === 1 ? `only ${models[0]} of Sumo's models is listed: nothing to rank it against` : null;
}

/** Where a source placed Sumo's routes: its best and its worst, by score. */
function placeLine(entries) {
  const none = unplaced(entries);
  if (none) return none;
  const sorted = [...entries].sort((a, b) => b.score - a.score);
  const route = (e) => `${e.model}${e.effort === ANY ? '' : `/${e.effort}`}`;
  // A source's own score, to three places: enough to see the order, not the noise of a float.
  const own = (e) => Number(e.score.toFixed(3));
  return `places: best ${route(sorted[0])} (${own(sorted[0])}) 1.00 · worst ${route(sorted.at(-1))} (${own(sorted.at(-1))}) 0.00`;
}

/**
 * One source read, its steps said as they happen, tried once more when it fails. What it came to is told to `onSource` as soon
 * as it is known — `{ id, name, url, ok, steps, ms }` — so a slow source never holds the others back from the screen.
 */
async function readSource(source, fetchImpl, onSource, { retryMs = RETRY_MS, maxBytes = MAX_BYTES, sourceMs = SOURCE_MS } = {}) {
  const steps = [];
  const say = (line) => steps.push(line);
  const started = Date.now();
  let got = null;
  for (let attempt = 1; attempt <= 2 && !got; attempt += 1) {
    const tally = {};
    const limits = { maxBytes, sourceMs, deadline: AbortSignal.timeout(sourceMs) };
    try {
      const entries = await READERS[source.id](fetchImpl, say, tally, limits);
      steps.push(...keptLines(entries, tally));
      const none = unplaced(entries);
      got = none ? { error: none } : { entries: placed(entries) };
      say(placeLine(entries));
    } catch (cause) {
      say(`failed: ${failedBecause(cause, limits)}${attempt === 1 ? ` — trying once more in ${retryMs / 1000} s` : ''}`);
      if (attempt === 2) got = { error: failedBecause(cause, limits) };
      else await new Promise((resolve) => setTimeout(resolve, retryMs));
    }
  }
  onSource?.({ id: source.id, name: source.name, url: source.url, ok: !got.error, steps, ms: Date.now() - started });
  return got;
}

/** The three sources as they are published now, each read on its own: one that fails is its error, never the others'. */
async function fetchSources(fetchImpl, onSource, limits) {
  const read = await Promise.all(SOURCES.map((s) => readSource(s, fetchImpl, onSource, limits)));
  return Object.fromEntries(SOURCES.map((s, i) => [s.id, read[i]]));
}

/** Under a stand-in (`SUMO_AGENTS_MODEL_CMD`), the sources are what it answers to `{ kind: 'scorecard' }`, entries already read: the suite never reaches the web. */
function askStandIn(standIn, onSource) {
  const run = spawnSync(standIn, [], { input: JSON.stringify({ kind: 'scorecard' }), encoding: 'utf8', timeout: TIMEOUT_MS });
  let answer = null;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    // Said below.
  }
  const why = (run.stderr || run.stdout || '').trim().slice(0, 200) || `exit ${run.status}`;
  return Object.fromEntries(
    SOURCES.map((source) => {
      const got = answer && typeof answer === 'object' ? (answer[source.id] ?? { error: 'no answer' }) : { error: why };
      const none = got.error ? null : unplaced(got.entries ?? []);
      const steps = [`asked the stand-in (${standIn})`, ...(got.error ? [`failed: ${got.error}`] : [`kept ${got.entries?.length ?? 0} rows`, placeLine(got.entries ?? [])])];
      onSource?.({ id: source.id, name: source.name, url: source.url, ok: !got.error && !none, steps, ms: 0 });
      return [source.id, got.error ? got : none ? { error: none } : { entries: placed(got.entries) }];
    }),
  );
}

/** The scorecard as saved, or null while none was ever fetched. */
export function savedScorecard(db) {
  try {
    const card = JSON.parse(getMeta(db, KEY) ?? 'null');
    return card && typeof card === 'object' && card.sources ? card : null;
  } catch {
    return null;
  }
}

/**
 * Fetches the sources and saves the scorecard: each source's entries for Sumo's models, placed among themselves. A source
 * that cannot be read now keeps what was saved from it last, with the day it was read; one never read is left out. Each source
 * is told to `onSource` as it is read (see `readSource`). Never
 * throws: `ok` is false only when no source has anything for Sumo's models.
 */
export async function refreshScorecard(db, { fetchImpl = fetch, now = new Date().toISOString(), onSource = null, retryMs = RETRY_MS, maxBytes = MAX_BYTES, sourceMs = SOURCE_MS } = {}) {
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  const fetched = standIn ? askStandIn(standIn, onSource) : await fetchSources(fetchImpl, onSource, { retryMs, maxBytes, sourceMs });
  const before = savedScorecard(db)?.sources ?? {};
  const sources = {};
  const failed = {};
  for (const { id } of SOURCES) {
    const got = fetched[id] ?? { error: 'no answer' };
    const entries = got.error ? null : got.entries;
    // Each entry keeps the API id of the model it scored: when the catalog moves a name to another version, it is not read for it.
    if (entries && entries.length > 0) sources[id] = { at: now, entries: entries.map((e) => ({ ...e, id: modelId(e.model) })) };
    else {
      failed[id] = got.error ?? 'none of Sumo\'s models is listed';
      if (before[id]) sources[id] = before[id];
    }
  }
  if (Object.keys(sources).length === 0) return { ok: false, error: Object.values(failed)[0] ?? 'nothing fetched', failed };
  setMeta(db, KEY, JSON.stringify({ at: now, sources }));
  return { ok: true, read: SOURCES.filter((s) => !failed[s.id]).map((s) => s.id), failed, kept: Object.keys(failed).filter((id) => sources[id]) };
}

/** A finished refresh in one line, for setup and the settings page. */
export function scorecardSummary(result) {
  if (!result.ok) return `scorecard not fetched — ${result.error}`;
  const name = (id) => SOURCES.find((s) => s.id === id).name;
  const parts = [`scorecard from ${result.read.map(name).join('; ') || 'no source today'}`];
  const failed = Object.entries(result.failed);
  if (failed.length > 0) parts.push(`not read: ${failed.map(([id, why]) => `${name(id)} (${why}${result.kept.includes(id) ? '; the last copy is kept' : ''})`).join(', ')}`);
  return parts.join(' — ');
}

/**
 * A source's entry for one route: the model at that effort; else, where the source lists the model at other efforts, the
 * nearest of them (the lower on a tie); else the model's own row. Every route of a model so draws on the same sources — a
 * source that lists only some efforts would otherwise lift the routes it leaves out above the ones it ranks. Only entries for
 * the model the catalog runs under that name now count.
 */
function entryFor(source, model, effort, efforts) {
  const own = source.entries.filter((e) => e.model === model && e.id === modelId(model));
  const exact = own.find((e) => e.effort === effort);
  if (exact) return exact;
  const at = efforts.indexOf(effort);
  const levels = own.filter((e) => efforts.includes(e.effort)).sort((a, b) => Math.abs(efforts.indexOf(a.effort) - at) - Math.abs(efforts.indexOf(b.effort) - at) || efforts.indexOf(a.effort) - efforts.indexOf(b.effort));
  return levels[0] ?? own.find((e) => e.effort === ANY) ?? null;
}

/**
 * One route on the saved scorecard: its score (the mean of its places, 0–1), the sources behind it, and what one task costs
 * on it where a source says. `efforts` is route.mjs's list, lowest first. Null when no source lists the model.
 */
export function routeScore(card, model, effort, efforts) {
  const found = Object.values(card?.sources ?? {}).map((s) => entryFor(s, model, effort, efforts)).filter(Boolean);
  if (found.length === 0) return null;
  // A cost is a cost at this effort: one borrowed from another effort would price the route at the wrong level.
  const cost = found.find((e) => e.cost !== null && (e.effort === effort || e.effort === ANY))?.cost ?? null;
  return { score: found.reduce((sum, e) => sum + e.place, 0) / found.length, sources: found.length, cost };
}

/** One route's cell: its score, and what a task costs on it where a source says. Null when no source lists the model. */
function cellOf(card, model, effort, efforts) {
  const r = routeScore(card, model, effort, efforts);
  return r && `${r.score.toFixed(2)}${r.cost === null ? '' : ` $${r.cost.toFixed(2)}`}`;
}

/** Where the saved scorecard came from: the day it was fetched, and each source, with its own day where it was kept from an earlier one. */
function fromLine(card) {
  const day = card.at.slice(0, 10);
  const from = SOURCES.filter((s) => card.sources[s.id]).map((s) => (card.sources[s.id].at.slice(0, 10) === day ? s.name : `${s.name} (${card.sources[s.id].at.slice(0, 10)})`));
  return `fetched ${day} from ${from.join('; ')}`;
}
const READING = "a score is a model's place among Sumo's models, 0 to 1, averaged over the sources; a cost is one task's";

/** What `sumo models` adds: when the scorecard was fetched and from what, then each model's score and cost per task at each effort. */
export function scorecardLines(db, efforts, models = ALL_MODELS) {
  const card = savedScorecard(db);
  if (!card) return ['scorecard: not fetched — API models › Discover, on the settings page (sumo config), fetches it'];
  const lines = [`scorecard: ${fromLine(card)}`, `  ${READING}`];
  for (const model of models) {
    const cells = efforts.map((effort) => [effort, cellOf(card, model, effort, efforts)]).filter(([, cell]) => cell).map(([effort, cell]) => `${effort} ${cell}`);
    lines.push(`  ${model.padEnd(NAME_WIDTH)} ${cells.length > 0 ? cells.join(' · ') : 'not listed by any source'}`);
  }
  return lines;
}

/** What `/scorecard` ends on, in Markdown for the chat to draw: how the refresh went, then the saved scorecard as a table. */
export function scorecardReport(db, result, efforts, models = ALL_MODELS) {
  const card = savedScorecard(db);
  if (!card) return scorecardSummary(result);
  const rows = models.map((m) => `| ${m} | ${efforts.map((e) => cellOf(card, m, e, efforts) ?? '—').join(' | ')} |`);
  const table = [`| | ${efforts.join(' | ')} |`, `|---|${efforts.map(() => '---').join('|')}|`, ...rows];
  return [scorecardSummary(result), '', `Saved: ${fromLine(card)}.`, '', ...table, '', `${READING[0].toUpperCase()}${READING.slice(1)}.`].join('\n');
}
