import { spawnSync } from 'node:child_process';
import { anthropicClient, loadedSdk, loadSdk, resolveAnthropicCredential } from './auth.mjs';
import { getMeta, setMeta } from './db.mjs';
import { UsageError } from './memory.mjs';

/**
 * The models Sumo can run on, under the names the router, `/model` and `sumo config` use. Four of Claude's have the short
 * names the router's rule, the advisor, the memory pass and hand-offs are written around; every other model the API lists
 * for this credential is known by its own id, and every model Cursor lists for CURSOR_API_KEY by `cursor/` and Cursor's id
 * (Cursor lists Claude's models too, under the same ids). Each has a switch. Discover (API models, on the settings page)
 * asks both which models there are and sets the switches from the answer; `sumo setup` asks Anthropic once. The chat, the
 * router, the passes and a job's run all read the switches as they are now.
 */
export const MODEL_IDS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
export const MODELS = Object.keys(MODEL_IDS);

/** The efforts Sumo asks for, lowest first: how much a model thinks before it acts. */
export const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * The two Cursor models Sumo named before Discover listed Cursor's whole catalog, kept by these names (jobs, settings and the
 * ledger say them). Each says what Cursor calls it and the settings it is asked with — the standard variant, never Fast, which
 * Composer defaults to at six times the price; `effort` names the setting Sumo's effort goes in, where the model takes one.
 */
const CURSOR_MODELS = {
  composer: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
  grok: { id: 'grok-4.7', params: [{ id: 'context', value: '256k' }, { id: 'fast', value: 'false' }], effort: 'reasoning_effort', efforts: ['low', 'medium', 'high', 'xhigh'] },
};
/** The six models Sumo names: Claude's four and Cursor's two. The routing bars were set on their places (src/scorecard.mjs). */
export const NAMED = [...MODELS, ...Object.keys(CURSOR_MODELS)];
/** What Sumo calls a model Cursor lists beyond its two: Cursor's id after `cursor/`, which no Anthropic id starts with. */
const CURSOR_PREFIX = 'cursor/';

export const modelId = (model) => MODEL_IDS[model] ?? CURSOR_MODELS[model]?.id ?? model;
/** A model by the name Sumo calls it, from its name or its API id; any other is its own name. */
export const modelName = (model) => NAMED.find((name) => name === model || modelId(name) === model) ?? model;
/** Which way a model is run, by its name or its id: through the Anthropic API, or the Cursor SDK. */
export const laneOf = (model) => (Object.hasOwn(CURSOR_MODELS, modelName(model)) || String(model).startsWith(CURSOR_PREFIX) ? 'cursor' : 'claude');

/**
 * US dollars per million tokens: input, output, and what a cache read costs relative to input — Sumo's own list, checked by
 * hand. Haiku has two rate cards, by the size of the prompt — everything read, from the cache or not — `over` is the dearer
 * one past that many tokens. A model not here is priced from the scorecard's list (`listedPrice`), or not at all.
 */
const PRICES = {
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.1, over: { tokens: 100_000, input: 0.5, output: 2.5, cacheRead: 0.1 } },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.05 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.025 },
  // Where a declined reply is run again (`fallbacks`): the API names the model by the category; the ledger must price what it answered on.
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.1 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.1 },
  // Cursor's own models, at the standard variants Sumo asks for (cursor.com/docs/models, Nov 18 2026). Paid plans draw them from
  // a weekly pool first: these are what the same tokens cost past it, so a job on them is never priced below what it could cost.
  // Cursor lists no cache-write rate; a write is priced as the others are.
  'composer-2.5': { input: 0.5, output: 2.5, cacheRead: 0.4 },
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.25 },
};

const STATE_KEY = 'models.state';
const CHECKED_KEY = 'models.checked';
/** What Discover last heard of each lane's models: `{ claude: [entry], cursor: [entry] }` (see `claudeEntry`, `cursorEntry`). */
const LISTED_KEY = 'models.listed';
/** Each model's list price, by Sumo's name, from the scorecard's source that publishes prices: `{ name: { input, output, cacheRead } }`. */
const LISTED_PRICES_KEY = 'models.prices';

/**
 * What was last read of the listing and the list prices, kept for the lookups that have no database at hand — a request's
 * effort, a ledger row's price, the job ladder's order. Every function here that takes the database reads them again first,
 * and a model is never run before one has (its switch is read): so they are never older than the database they came from.
 */
const seen = { listed: { claude: [], cursor: [] }, prices: {}, ladder: null };

const readJson = (db, key, empty) => {
  try {
    return JSON.parse(getMeta(db, key) ?? 'null') ?? empty;
  } catch {
    return empty;
  }
};

/** Reads the listing and the list prices again from the database, into `seen`. */
export function readListing(db) {
  const listed = readJson(db, LISTED_KEY, {});
  seen.listed = { claude: Array.isArray(listed.claude) ? listed.claude : [], cursor: Array.isArray(listed.cursor) ? listed.cursor : [] };
  seen.prices = readJson(db, LISTED_PRICES_KEY, {});
  seen.ladder = null;
  return seen;
}

const NAMED_IDS = new Set(MODELS.map((name) => MODEL_IDS[name]));
const NAMED_CURSOR_IDS = new Set(Object.values(CURSOR_MODELS).map((m) => m.id));

/** The listing's entry for a model by its name, with its lane: what Discover heard of it. Null for one it never listed. */
function entryOf(name) {
  if (laneOf(name) === 'cursor') {
    const id = Object.hasOwn(CURSOR_MODELS, name) ? CURSOR_MODELS[name].id : String(name).slice(CURSOR_PREFIX.length);
    return seen.listed.cursor.find((e) => e.id === id) ?? null;
  }
  return seen.listed.claude.find((e) => e.id === modelId(name)) ?? null;
}

/** Saves the list prices the scorecard's source publishes, by Sumo's name: they price a model Sumo's own list has not. */
export function saveListedPrices(db, prices) {
  setMeta(db, LISTED_PRICES_KEY, JSON.stringify(prices));
  readListing(db);
}

/** A model's price per million tokens: Sumo's own list first, then the scorecard's list price; null when neither has it. */
export function listedPrice(model) {
  return PRICES[modelId(model)] ?? seen.prices[modelName(model)] ?? null;
}

/** Names sorted cheapest first by their output price, then input; the ones with no price after, Claude's then Cursor's, by name. */
function sorted(names) {
  const key = (name) => listedPrice(name);
  return [...names].sort((a, b) => {
    const [pa, pb] = [key(a), key(b)];
    // On equal prices Claude's own before the same through Cursor, so a tie never goes to the twin.
    if (pa && pb) return pa.output - pb.output || pa.input - pb.input || (laneOf(a) === laneOf(b) ? 0 : laneOf(a) === 'claude' ? -1 : 1) || a.localeCompare(b);
    if (pa || pb) return pa ? -1 : 1;
    return (laneOf(a) === laneOf(b) ? 0 : laneOf(a) === 'claude' ? -1 : 1) || a.localeCompare(b);
  });
}

/** Every model Sumo knows now: the named ones and every one Discover listed, cheapest first (`sorted`) — what the switches and `sumo models` cover. */
export function allModels(db) {
  if (db) readListing(db);
  const claude = seen.listed.claude.filter((e) => !NAMED_IDS.has(e.id)).map((e) => e.id);
  const cursor = seen.listed.cursor.filter((e) => !NAMED_CURSOR_IDS.has(e.id)).map((e) => `${CURSOR_PREFIX}${e.id}`);
  return sorted([...NAMED, ...claude, ...cursor]);
}

/**
 * The job ladder, weakest first: every model with a price, cheapest first — what a retry climbs, `jobs.floor` cuts and routing
 * weighs. A model with no price is run only when asked for by name: routing could not weigh it against the others, nor a
 * budget hold it.
 */
export const modelLadder = (db) => allModels(db).filter((name) => listedPrice(name));

/** Where a model stands on the job ladder as last read, 0 the cheapest; -1 for one not on it. */
export function ladderRank(model) {
  // Sorted once per read: routing compares routes by it many times over.
  seen.ladder ??= modelLadder();
  return seen.ladder.indexOf(model);
}

/** A model's name and what it is as a person reads it: the listing's own name for it, where Discover heard one. */
export const labelOf = (name) => entryOf(name)?.label ?? null;

/**
 * The efforts a model takes, lowest first, as Sumo spells them; null for one that takes none (Composer). Claude's four take
 * every one; any other model, the ones its listing named.
 */
export function effortsOf(model) {
  const name = modelName(model);
  if (MODELS.includes(name)) return EFFORTS;
  if (Object.hasOwn(CURSOR_MODELS, name)) return CURSOR_MODELS[name].efforts ?? null;
  const entry = entryOf(name);
  if (!entry) return laneOf(name) === 'claude' ? EFFORTS : null;
  return entry.efforts?.length > 0 ? entry.efforts : null;
}

/**
 * The effort a model is asked at for `effort`: the highest it takes at or below it, else the lowest it takes; null for a model
 * that takes none. An effort Sumo has no word for (an old job's `none`) is passed on as it is.
 */
export function effortOn(model, effort) {
  const takes = effortsOf(model);
  if (!takes) return null;
  if (!EFFORTS.includes(effort)) return effort;
  const at = EFFORTS.indexOf(effort);
  return takes.filter((e) => EFFORTS.indexOf(e) <= at).at(-1) ?? takes[0];
}

/** Whether two names are one model: the same API id, or one run through Cursor under the other's id (`cursor/claude-opus-5-5` is opus). */
export function sameModel(a, b) {
  const plain = (m) => modelId(m).replace(CURSOR_PREFIX, '');
  return plain(a) === plain(b);
}

/** A route's model and effort, split at the last slash: a Cursor model's name has one of its own (`cursor/gpt-5.5/medium`). */
export const splitRoute = (route) => {
  const at = String(route).lastIndexOf('/');
  return [route.slice(0, at), route.slice(at + 1)];
};

/** How wide a model's name is set in a list of them, so the columns after it line up. */
export const nameWidth = (names) => Math.max(0, ...names.map((name) => name.length));
const TIMEOUT_MS = 30_000;
/** What a Claude Code OAuth token needs on a request outside the Messages API. */
const OAUTH_BETA = 'oauth-2025-04-20';

const day = (now) => String(now).slice(0, 10);

/**
 * Every model's switch and the note that explains it. A Claude model is on, and "not checked", until something is recorded;
 * a Cursor model is off until Discover finds it, since without CURSOR_API_KEY it cannot run at all.
 */
export function modelStates(db) {
  let stored = {};
  try {
    stored = JSON.parse(getMeta(db, STATE_KEY) ?? '{}');
  } catch {
    stored = {};
  }
  // Claude's four are on until something is recorded; any other model is off until a Discover finds it answering.
  const fresh = (name) => (MODELS.includes(name) ? { on: true, note: 'not checked' } : { on: false, note: 'not discovered yet' });
  return Object.fromEntries(allModels(db).map((name) => [name, stored[name] ? { on: stored[name].on !== false, note: stored[name].note ?? fresh(name).note } : fresh(name)]));
}

/**
 * Writes the switches, keeping the ones of models not listed now: a model a later Discover lists again comes back as the user
 * left it — off by hand stays off.
 */
function writeStates(db, states) {
  setMeta(db, STATE_KEY, JSON.stringify({ ...readJson(db, STATE_KEY, {}), ...states }));
}

/** The models the chat, the router and the passes may use, cheapest first: Claude's. */
export function usableModels(db) {
  const states = modelStates(db);
  return MODELS.filter((name) => states[name].on);
}

/** Whether this shell can run Cursor's models: they need CURSOR_API_KEY, and a switch left on by an earlier Discover does not. */
export const cursorKeyIn = (env = process.env) => Boolean(env.CURSOR_API_KEY?.trim());

/** The models that are on and can run in this shell — Cursor's only while it has CURSOR_API_KEY — cheapest first: what `/model` offers. */
export function onModels(db, env = process.env) {
  const states = modelStates(db);
  return allModels(db).filter((name) => states[name].on && (laneOf(name) === 'claude' || cursorKeyIn(env)));
}

/** The models a job or a chat turn may be routed to, weakest first: the ones on the job ladder (`modelLadder`) that are on and can run here. */
export const usableJobModels = (db, env = process.env) => onModels(db, env).filter((name) => listedPrice(name));

/** When the API was last asked which models it has, or null while it never was. */
export const modelsChecked = (db) => getMeta(db, CHECKED_KEY);

/** `name` is a model Sumo knows, or a usage error listing them — after `also`, the other values the setting takes. */
export function knownModel(name, also = [], models = MODELS) {
  if (!models.includes(name)) throw new UsageError(`no such model "${name}" — one of: ${[...also, ...models].join(', ')}`);
}

/**
 * Whether Sumo knows `name` now, or knew it once — a model a later Discover no longer lists keeps its switch — so its switch is
 * read before it runs. A model never listed (an API id a chat was started on) is passed on as it is.
 */
export const switched = (db, name) => allModels(db).includes(name) || Object.hasOwn(readJson(db, STATE_KEY, {}), name);

/** Why `name` cannot be used right now, with the way out (`orElse` is another one), or null while it can. */
export function offLine(db, name, orElse, env = process.env) {
  const or = orElse ? `, or ${orElse}` : '';
  const state = modelStates(db)[name];
  if (!state) return `${name} is not among the models Sumo knows now — API models › Discover, on the settings page (sumo config), lists them again${or}`;
  if (!state.on) return `${name} is off — turn it on under API models, on the settings page (sumo config)${or}`;
  if (laneOf(name) === 'cursor' && !cursorKeyIn(env)) return `${name} runs through Cursor, and this shell has no CURSOR_API_KEY — export it in the shell sumo starts from${or}`;
  return null;
}

/** `name` is on, or a usage error saying how to turn it on. */
export function assertOn(db, name, orElse) {
  const line = offLine(db, name, orElse);
  if (line) throw new UsageError(line);
}

/** Turns one model on or off by hand. */
export function setModel(db, name, on, now = new Date().toISOString()) {
  knownModel(name, [], allModels(db));
  const states = modelStates(db);
  states[name] = { on, note: `turned ${on ? 'on' : 'off'} ${day(now)}` };
  writeStates(db, states);
  return states[name];
}

/**
 * One line per model, cheapest first: its name, its switch, the API id (or, for one known by its id, the name its maker gives
 * it) and the note — what `sumo models` prints.
 */
export function modelLines(db, names = allModels(db)) {
  const states = modelStates(db);
  const width = nameWidth(names);
  const what = (name) => (NAMED.includes(name) ? modelId(name) : (labelOf(name) ?? ''));
  const after = (name) => `${laneOf(name) === 'cursor' ? ' · through Cursor' : ''}${listedPrice(name) ? '' : ' · no price known'}`;
  return names.map((name) => `${name.padEnd(width)} ${states[name].on ? 'on ' : 'off'}  ${what(name).padEnd(26)} ${states[name].note}${after(name)}`);
}

/** What went wrong with an API call, in one line a person can act on. */
export function describeApiError(cause) {
  // Only the SDK makes these errors: with it not loaded, none can be one of them.
  const Anthropic = loadedSdk();
  if (!Anthropic) return String(cause?.message ?? cause).slice(0, 300);
  if (cause instanceof Anthropic.AuthenticationError) return 'the Anthropic credential is missing or invalid — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the shell that runs sumo';
  if (cause instanceof Anthropic.RateLimitError) return 'the API is rate-limiting this key — try again in a minute';
  if (cause instanceof Anthropic.APIError) return `the API answered ${cause.status ?? 'an error'}: ${String(cause.message).slice(0, 300)}`;
  return String(cause?.message ?? cause).slice(0, 300);
}

/**
 * A model as the Anthropic API lists it, as the listing keeps it: its id, its name, the efforts it takes, and what Sumo's
 * requests need that it lacks — adaptive thinking, an effort, and clearing old tool results server-side go on every one, and
 * a model without one of them would refuse every request (Claude Haiku 4.5 and the other models before Opus 4.6 lack them).
 */
function claudeEntry(m) {
  const c = m.capabilities ?? {};
  const lacks = [
    c.thinking?.types?.adaptive?.supported ? null : 'adaptive thinking',
    c.effort?.supported ? null : 'effort',
    c.context_management?.clear_tool_uses_20250919?.supported ? null : 'tool-result clearing',
  ].filter(Boolean);
  return { id: m.id, label: m.display_name ?? m.id, efforts: EFFORTS.filter((e) => c.effort?.[e]?.supported), ...(lacks.length > 0 ? { lacks } : {}) };
}

/**
 * The stand-in's answer to "which models are there": `{ found: [names], errors: { name: why }, listed: [models as the API
 * lists them] }`, `listed` optional; anything else is a failed check.
 */
function askStandIn(standIn) {
  const run = spawnSync(standIn, [], { input: JSON.stringify({ kind: 'models', models: MODEL_IDS }), encoding: 'utf8', timeout: TIMEOUT_MS });
  if (run.error) return { error: `could not run ${standIn}: ${run.error.message}` };
  let answer;
  try {
    answer = JSON.parse(run.stdout);
  } catch {
    return { error: (run.stderr || run.stdout).trim().slice(0, 200) || `exit ${run.status}` };
  }
  if (!answer || typeof answer !== 'object') return { error: `${standIn} answered ${String(run.stdout).trim().slice(0, 80)}, not a list of models` };
  const found = new Set(answer.found ?? []);
  const errors = answer.errors ?? {};
  const answers = Object.fromEntries(MODELS.map((name) => [name, found.has(name) ? 'found' : Object.hasOwn(errors, name) ? String(errors[name]) : 'missing']));
  const refused = answer.refused ?? {};
  const tried = (_db, name) => (Object.hasOwn(refused, modelId(name)) ? { ok: false, refused: String(refused[modelId(name)]) } : { ok: true });
  return { answers, listed: Array.isArray(answer.listed) ? answer.listed : [], tried };
}

/** Tries a model once through the API (`tryClaudeModel`): loaded when asked, as loop.mjs reads this module. */
const tryThroughClaude = async (db, name) => (await import('./loop.mjs')).tryClaudeModel(db, name);

/** Every model the API lists for this credential, page by page: Sumo's four found or missing among them, and the whole list. */
async function askApi() {
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) return askStandIn(standIn);
  const credential = resolveAnthropicCredential();
  if (!credential) return { error: 'no Anthropic credential — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in this shell' };
  await loadSdk();
  const client = anthropicClient({ timeout: TIMEOUT_MS }, credential);
  const options = credential.type === 'oauth' ? { headers: { 'anthropic-beta': OAUTH_BETA } } : {};
  const listed = [];
  try {
    for await (const m of client.models.list({ limit: 100 }, options)) listed.push(m);
  } catch (cause) {
    return { error: describeApiError(cause) };
  }
  const ids = new Set(listed.map((m) => m.id));
  return { answers: Object.fromEntries(MODELS.map((name) => [name, ids.has(MODEL_IDS[name]) ? 'found' : 'missing'])), listed };
}

/** The listing with one lane's models put in: what Discover heard of them, kept for every lookup after. */
function saveListed(db, lane, entries) {
  const listed = readJson(db, LISTED_KEY, {});
  setMeta(db, LISTED_KEY, JSON.stringify({ ...listed, [lane]: entries }));
  readListing(db);
}

/** A model the user turned off stays off: Discover says what this login can use, not what the user wants used. */
const offByHand = (state) => Boolean(state) && !state.on && /^turned off /.test(state.note ?? '');

/**
 * Asks the API which models this credential can use — every one it lists — and sets the switches from the answer. A listed
 * model is not one this login may run (a Claude Code login is refused a model that needs a newer Claude Code), so each one
 * Sumo can drive is tried once with a one-word question (`tryClaudeModel`): answered → on, unless the user turned it off by
 * hand; refused → off, with the API's reason; not tried (the connection failed) → as it was, saying why. A model Sumo cannot
 * drive (`claudeEntry`) is listed, and off, saying what it lacks; one of the four not listed is off. An answer with none of
 * the four found and nothing else listed is a failed check, not an API that has none: nothing is changed and the reason is
 * returned. Never throws.
 */
export async function discoverModels(db, { now = new Date().toISOString(), tryModel = null } = {}) {
  const asked = await askApi();
  if (asked.error) return { ok: false, error: asked.error };
  const { answers } = asked;
  const listedFour = MODELS.filter((name) => answers[name] === 'found');
  const missing = MODELS.filter((name) => answers[name] === 'missing');
  const errors = Object.fromEntries(MODELS.filter((name) => answers[name] !== 'found' && answers[name] !== 'missing').map((name) => [name, answers[name]]));
  const entries = asked.listed.map(claudeEntry);
  const others = entries.filter((e) => !NAMED_IDS.has(e.id));
  if (listedFour.length === 0 && others.length === 0) {
    // Any model that could not be asked says more than the ones that were not there: a connection that failed is not a credential that cannot see.
    const failed = Object.values(errors);
    const error = failed.length > 0 ? failed[0] : 'the API found none of the models Sumo knows — the credential may not be allowed to see them';
    return { ok: false, error };
  }
  saveListed(db, 'claude', entries);
  // The four as their own names, the rest by their ids; one the list did not describe (an older stand-in) is not tried.
  const described = new Set(entries.map((e) => e.id));
  const runnable = [...listedFour.filter((name) => described.has(MODEL_IDS[name])), ...others.filter((e) => !e.lacks).map((e) => e.id)];
  // What tries each model: one handed in, else the stand-in's answers, else the API itself.
  const tried = tryModel ?? asked.tried ?? tryThroughClaude;
  const outcomes = await inTurns(runnable, TRIES_AT_ONCE, async (name) => {
    try {
      return await tried(db, name);
    } catch (cause) {
      return { ok: false, error: String(cause?.message ?? cause).replace(/\s+/g, ' ').slice(0, 200) };
    }
  });
  const outcome = new Map(runnable.map((name, i) => [name, outcomes[i]]));
  const states = modelStates(db);
  const result = { ok: true, found: [], missing, errors, more: [], refused: [], cannot: [] };
  for (const [name, error] of Object.entries(errors)) states[name] = { on: states[name].on, note: `not checked — ${error}` };
  for (const name of missing) states[name] = { on: false, note: `not found ${day(now)}` };
  for (const name of [...listedFour, ...others.map((e) => e.id)]) {
    const lacks = others.find((e) => e.id === name)?.lacks;
    const answer = outcome.get(name) ?? { ok: true };
    if (lacks) {
      if (!offByHand(states[name])) states[name] = { on: false, note: `found ${day(now)} — Sumo cannot run it: no ${lacks.join(', no ')}` };
      result.cannot.push(name);
    } else if (answer.ok) {
      if (!offByHand(states[name])) states[name] = { on: true, note: `found ${day(now)}` };
      (MODELS.includes(name) ? result.found : result.more).push(name);
    } else if (answer.refused) {
      if (!offByHand(states[name])) states[name] = { on: false, note: `found ${day(now)} — the API refused it for this login: ${answer.refused}` };
      result.refused.push(name);
    } else {
      if (!offByHand(states[name])) states[name] = { on: states[name].on, note: `found ${day(now)} — not tried: ${answer.error}` };
      result.errors[name] = answer.error;
    }
  }
  writeStates(db, states);
  setMeta(db, CHECKED_KEY, now);
  return result;
}

/** A finished discovery in one line: what was found, what was turned off, what could not be checked. */
export function discoverySummary({ found, missing, errors, more = [], refused = [], cannot = [] }) {
  const parts = [`found: ${[...found, ...more].join(', ') || 'none of its four'}`];
  if (refused.length > 0) parts.push(`refused for this login, off: ${refused.join(', ')}`);
  if (cannot.length > 0) parts.push(`listed, but Sumo cannot run them, off: ${cannot.join(', ')}`);
  if (missing.length > 0) parts.push(`not found, turned off: ${missing.join(', ')}`);
  const failed = Object.entries(errors);
  if (failed.length > 0) parts.push(`not checked: ${failed.map(([name, error]) => `${name} (${error})`).join(', ')}`);
  return parts.join(' — ');
}

/** Which models Cursor has for this key, as it lists them. Loaded only here, so a command that never asks never loads the SDK. */
async function listCursorModels(apiKey) {
  const { Cursor } = await import('@cursor/sdk');
  return Cursor.models.list({ apiKey });
}

/** Tries a model once through Cursor (`tryCursorModel`): loaded when asked, as cursor.mjs reads this module. */
const tryThroughCursor = async (db, name) => (await import('./cursor.mjs')).tryCursorModel(db, name);

/**
 * The stand-in's answer to "which models has Cursor": `{ models: [as Cursor lists them], refused: { id: why } }`, or the
 * older `{ ids: [...] }`; anything else is a failed check. What it refused is what a model tried on it would answer.
 */
function askStandInCursor(standIn) {
  const run = spawnSync(standIn, [], { input: JSON.stringify({ kind: 'cursor-models' }), encoding: 'utf8', timeout: TIMEOUT_MS });
  try {
    const answer = JSON.parse(run.stdout);
    const refused = answer?.refused ?? {};
    const tried = (_db, name) => {
      const id = entryOf(name)?.id;
      return Object.hasOwn(refused, id) ? { ok: false, refused: String(refused[id]) } : { ok: true };
    };
    if (Array.isArray(answer?.models)) return { models: answer.models, tried };
    if (Array.isArray(answer?.ids)) return { models: answer.ids.map((id) => ({ id, displayName: id })), tried };
  } catch {
    // Said below.
  }
  throw new Error((run.stderr || run.stdout || '').trim().slice(0, 200) || `exit ${run.status}`);
}

/** Where Cursor's settings put an effort, by the names its models give that setting. */
const EFFORT_SETTINGS = ['effort', 'reasoning_effort', 'reasoning'];
/** An effort as Cursor spells it, as Sumo does: GPT's `extra-high` is Sumo's xhigh; a level Sumo has no word for (none, minimal) is none of its. */
const sumoEffort = (value) => (value === 'extra-high' ? 'xhigh' : EFFORTS.includes(value) ? value : null);

/**
 * A model as Cursor lists it, as the listing keeps it: its id and name, and the settings it is asked with — the standard variant
 * (never Fast, never one only Max mode runs), the model's own default where it has one — `base` for no effort and `at` for
 * each effort it takes. A model with no such variant `lacks` one: everything it runs costs more than its list price.
 */
function cursorEntry(m) {
  const params = (v) => (v.params ?? []).map(({ id, value }) => ({ id, value }));
  const variants = (m.variants ?? []).filter((v) => !v.isMaxMode && !(v.params ?? []).some((p) => p.id === 'fast' && p.value !== 'false'));
  const base = params(variants.find((v) => v.isDefault) ?? variants[0] ?? { params: [] });
  const entry = { id: m.id, label: m.displayName ?? m.id, base };
  if ((m.variants ?? []).length > 0 && variants.length === 0) return { ...entry, lacks: ['a standard variant'] };
  const setting = (m.parameters ?? []).find((p) => EFFORT_SETTINGS.includes(p.id))?.id;
  if (!setting) return entry;
  // For each effort, the variant at it that differs from the base in nothing else, else the first at it.
  const at = {};
  for (const effort of EFFORTS) {
    const here = variants.map(params).filter((ps) => ps.some((p) => p.id === setting && sumoEffort(p.value) === effort));
    const same = here.find((ps) => base.every((b) => b.id === setting || ps.some((p) => p.id === b.id && p.value === b.value)));
    if (here.length > 0) at[effort] = same ?? here[0];
  }
  return { ...entry, efforts: EFFORTS.filter((e) => at[e]), at };
}

/** The name Sumo calls a model Cursor lists: one of its two by their names, any other as `cursor/` and its id. */
const cursorName = (id) => Object.keys(CURSOR_MODELS).find((name) => CURSOR_MODELS[name].id === id) ?? `${CURSOR_PREFIX}${id}`;

/** The selection Cursor is sent for a model, by Sumo's name or id, at an effort: `{ id, params }`, or null for one never listed. */
export function cursorSelection(model, effort) {
  const name = modelName(model);
  // Only an effort Sumo has a word for is passed on: an old job's `none` leaves the model at its own default.
  const on = EFFORTS.includes(effort) ? effortOn(name, effort) : null;
  if (Object.hasOwn(CURSOR_MODELS, name)) {
    const known = CURSOR_MODELS[name];
    return { id: known.id, params: [...known.params, ...(known.effort && on ? [{ id: known.effort, value: on }] : [])] };
  }
  const entry = entryOf(name);
  return entry ? { id: entry.id, params: (on && entry.at?.[on]) || entry.base } : null;
}

/** Runs `work` on each item, `width` at a time, answering in the items' order. */
async function inTurns(items, width, work) {
  const out = new Array(items.length);
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const at = next++;
      out[at] = await work(items[at]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(width, items.length) }, lane));
  return out;
}

/** How many models Discover tries at once, on each side: a try takes a few seconds, and on Cursor each is an agent of the SDK's in this process. */
const TRIES_AT_ONCE = 8;

/**
 * Asks Cursor which models this CURSOR_API_KEY can use — every one it lists — and sets their switches. Cursor's list does not say
 * what the key's plan covers (a model it leaves out is listed, and refused when run, at no cost), so each listed model is tried
 * once with a one-word question (`tryCursorModel`, a few thousand tokens where it runs): answered → on, unless the user turned
 * it off by hand; refused → off, with Cursor's reason; not tried (the connection failed) → as it was. Composer and Grok, not
 * listed → off. Without a key nothing is asked and nothing changes. Never throws.
 */
export async function discoverCursor(db, { now = new Date().toISOString(), list = listCursorModels, tryModel = null } = {}) {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) return { ok: false, error: 'no CURSOR_API_KEY in this shell — export it, then Discover again' };
  let models;
  // What tries each model: one handed in, else the stand-in's answers, else Cursor itself.
  let tried = tryModel ?? tryThroughCursor;
  try {
    const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
    if (standIn) ({ models, tried } = askStandInCursor(standIn));
    else models = await list(key);
    if (tryModel) tried = tryModel;
  } catch (cause) {
    return { ok: false, error: String(cause?.message ?? cause).replace(/\s+/g, ' ').slice(0, 200) };
  }
  const entries = models.map(cursorEntry);
  saveListed(db, 'cursor', entries);
  const runnable = entries.filter((e) => !e.lacks);
  const answers = await inTurns(runnable, TRIES_AT_ONCE, async (e) => {
    try {
      return await tried(db, cursorName(e.id));
    } catch (cause) {
      return { ok: false, error: String(cause?.message ?? cause).replace(/\s+/g, ' ').slice(0, 200) };
    }
  });
  const states = modelStates(db);
  const result = { ok: true, found: [], refused: [], cannot: [], errors: {}, missing: [] };
  runnable.forEach((e, i) => {
    const name = cursorName(e.id);
    const answer = answers[i];
    if (answer.ok) {
      if (!offByHand(states[name])) states[name] = { on: true, note: `found ${day(now)}` };
      result.found.push(name);
    } else if (answer.refused) {
      if (!offByHand(states[name])) states[name] = { on: false, note: `found ${day(now)} — Cursor refused it for this key: ${answer.refused.slice(0, 160)}` };
      result.refused.push(name);
    } else {
      if (!offByHand(states[name])) states[name] = { on: states[name].on, note: `found ${day(now)} — not tried: ${answer.error}` };
      result.errors[name] = answer.error;
    }
  });
  for (const e of entries.filter((x) => x.lacks)) {
    const name = cursorName(e.id);
    if (!offByHand(states[name])) states[name] = { on: false, note: `found ${day(now)} — Sumo cannot run it: no ${e.lacks.join(', no ')}` };
    result.cannot.push(name);
  }
  const listedIds = new Set(entries.map((e) => e.id));
  for (const name of Object.keys(CURSOR_MODELS).filter((n) => !listedIds.has(CURSOR_MODELS[n].id))) {
    states[name] = { on: false, note: `not found ${day(now)}` };
    result.missing.push(name);
  }
  writeStates(db, states);
  return result;
}

/** Cursor's part of a discovery in one line: what runs on this key by name; what does not, counted, as `sumo models` lists them. */
export function cursorSummary(result) {
  if (!result.ok) return `Cursor: not checked — ${result.error}`;
  const parts = [`Cursor: ${result.found.length > 0 ? `runs ${result.found.join(', ')}` : 'runs none of the models it lists'}`];
  if (result.refused.length > 0) parts.push(`${result.refused.length} refused for this key, off`);
  if (result.cannot.length > 0) parts.push(`${result.cannot.length} Sumo cannot run, off`);
  const failed = Object.keys(result.errors);
  if (failed.length > 0) parts.push(`not tried: ${failed.join(', ')} (${Object.values(result.errors)[0]})`);
  if (result.missing.length > 0) parts.push(`not found, turned off: ${result.missing.join(', ')}`);
  return parts.join(' — ');
}
