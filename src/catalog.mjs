import { spawnSync } from 'node:child_process';
import { anthropicClient, loadedSdk, loadSdk, resolveAnthropicCredential } from './auth.mjs';
import { getMeta, setMeta } from './db.mjs';
import { UsageError } from './memory.mjs';

/**
 * The models Sumo can run on: the short names the router, `/model` and `sumo config` use, cheapest
 * first, and the API model each one means. Each has a switch. `sumo setup` asks the API once which
 * of them this credential can use and sets the switches from the answer; the settings page asks again
 * (API models › Discover) and sets one by hand. The chat, the router, the passes and a
 * job's run all read the switches as they are now.
 */
export const MODEL_IDS = {
  haiku: 'claude-haiku-5-5',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
export const MODELS = Object.keys(MODEL_IDS);

/**
 * The models Sumo runs through the Cursor SDK (src/cursor.mjs), for chat turns and jobs: the memory pass, the advisor,
 * compaction and hand-offs stay on Claude. Each says what Cursor calls it and the settings it is asked with — the standard variant, never Fast, which
 * Composer defaults to at six times the price; `effort` names the setting Sumo's effort goes in, where the model takes one.
 */
export const CURSOR_MODELS = {
  composer: { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
  grok: { id: 'grok-4.7', params: [{ id: 'context', value: '256k' }, { id: 'fast', value: 'false' }], effort: 'reasoning_effort' },
};
/** Every model Sumo knows, Claude's then Cursor's: what the switches, `sumo models` and Discover cover. */
export const ALL_MODELS = [...MODELS, ...Object.keys(CURSOR_MODELS)];
/** The models a job may run on, weakest first: the ladder a retry climbs and `jobs.floor` cuts. Cursor's sit above haiku. */
export const JOB_MODELS = ['haiku', 'composer', 'grok', 'sonnet', 'opus', 'fable'];
/** How wide a model's name is set in a list, so the columns after it line up: the longest name. */
export const NAME_WIDTH = Math.max(...ALL_MODELS.map((name) => name.length));
export const modelId = (model) => MODEL_IDS[model] ?? CURSOR_MODELS[model]?.id ?? model;
/** A model by the name Sumo calls it, from its name or its API id; one the list does not know, as it was given. */
export const modelName = (model) => ALL_MODELS.find((name) => name === model || modelId(name) === model) ?? model;
/** Which way a model is run, by its name or its id: through the Anthropic API, or the Cursor SDK. */
export const laneOf = (model) => (Object.hasOwn(CURSOR_MODELS, modelName(model)) ? 'cursor' : 'claude');

const STATE_KEY = 'models.state';
const CHECKED_KEY = 'models.checked';
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
  const fresh = (name) => (laneOf(name) === 'cursor' ? { on: false, note: 'not discovered yet' } : { on: true, note: 'not checked' });
  return Object.fromEntries(ALL_MODELS.map((name) => [name, stored[name] ? { on: stored[name].on !== false, note: stored[name].note ?? fresh(name).note } : fresh(name)]));
}

const writeStates = (db, states) => setMeta(db, STATE_KEY, JSON.stringify(states));

/** The models the chat, the router and the passes may use, cheapest first: Claude's. */
export function usableModels(db) {
  const states = modelStates(db);
  return MODELS.filter((name) => states[name].on);
}

/** Whether this shell can run Cursor's models: they need CURSOR_API_KEY, and a switch left on by an earlier Discover does not. */
export const cursorKeyIn = (env = process.env) => Boolean(env.CURSOR_API_KEY?.trim());

/** The models a job or a chat turn may be routed to, weakest first: Claude's that are on, and Cursor's that are on while this shell has its key. */
export function usableJobModels(db, env = process.env) {
  const states = modelStates(db);
  return JOB_MODELS.filter((name) => states[name].on && (laneOf(name) === 'claude' || cursorKeyIn(env)));
}

/** When the API was last asked which models it has, or null while it never was. */
export const modelsChecked = (db) => getMeta(db, CHECKED_KEY);

/** `name` is a model Sumo knows, or a usage error listing them — after `also`, the other values the setting takes. */
export function knownModel(name, also = [], models = MODELS) {
  if (!models.includes(name)) throw new UsageError(`no such model "${name}" — one of: ${[...also, ...models].join(', ')}`);
}

/** Why `name` cannot be used right now, with the way out (`orElse` is another one), or null while it can. */
export function offLine(db, name, orElse, env = process.env) {
  const or = orElse ? `, or ${orElse}` : '';
  if (!modelStates(db)[name].on) return `${name} is off — turn it on under API models, on the settings page (sumo config)${or}`;
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
  knownModel(name, [], ALL_MODELS);
  const states = modelStates(db);
  states[name] = { on, note: `turned ${on ? 'on' : 'off'} ${day(now)}` };
  writeStates(db, states);
  return states[name];
}

/** One line per model: its name, its switch, the API id and the note — what `sumo models` prints. */
export function modelLines(db, names = ALL_MODELS) {
  const states = modelStates(db);
  return names.map((name) => `${name.padEnd(NAME_WIDTH)} ${states[name].on ? 'on ' : 'off'}  ${modelId(name).padEnd(26)} ${states[name].note}${laneOf(name) === 'cursor' ? ' · through Cursor' : ''}`);
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

/** The stand-in's answer to "which models are there": `{ found: [names], errors: { name: why } }`; anything else is a failed check. */
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
  return Object.fromEntries(MODELS.map((name) => [name, found.has(name) ? 'found' : Object.hasOwn(errors, name) ? String(errors[name]) : 'missing']));
}

/** One GET /v1/models/<id> per model, together: found, missing, or what went wrong asking. */
async function askApi() {
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) return askStandIn(standIn);
  const credential = resolveAnthropicCredential();
  if (!credential) return { error: 'no Anthropic credential — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in this shell' };
  const Anthropic = await loadSdk();
  const client = anthropicClient({ timeout: TIMEOUT_MS }, credential);
  const options = credential.type === 'oauth' ? { headers: { 'anthropic-beta': OAUTH_BETA } } : {};
  const entries = await Promise.all(
    MODELS.map(async (name) => {
      try {
        await client.models.retrieve(MODEL_IDS[name], options);
        return [name, 'found'];
      } catch (cause) {
        return [name, cause instanceof Anthropic.NotFoundError ? 'missing' : describeApiError(cause)];
      }
    }),
  );
  return Object.fromEntries(entries);
}

/**
 * Asks the API which of Sumo's models this credential can use, and sets the switches from the answer:
 * found → on, not there → off; a model whose own check errored is left as it was, with the error in its
 * note. An answer with none of them found is a failed check, not an API that has none: nothing is changed
 * and the reason is returned. Never throws.
 */
export async function discoverModels(db, { now = new Date().toISOString() } = {}) {
  const answers = await askApi();
  if (answers.error) return { ok: false, error: answers.error };
  const found = MODELS.filter((name) => answers[name] === 'found');
  const missing = MODELS.filter((name) => answers[name] === 'missing');
  const errors = Object.fromEntries(MODELS.filter((name) => answers[name] !== 'found' && answers[name] !== 'missing').map((name) => [name, answers[name]]));
  if (found.length === 0) {
    // Any model that could not be asked says more than the ones that were not there: a connection that failed is not a credential that cannot see.
    const failed = Object.values(errors);
    const error = failed.length > 0 ? failed[0] : 'the API found none of the models Sumo knows — the credential may not be allowed to see them';
    return { ok: false, error };
  }
  const states = modelStates(db);
  // A model the user turned off stays off: the API says what this credential can use, not what the user wants used.
  const offByHand = (name) => !states[name].on && /^turned off /.test(states[name].note ?? '');
  for (const name of found) if (!offByHand(name)) states[name] = { on: true, note: `found ${day(now)}` };
  for (const name of missing) states[name] = { on: false, note: `not found ${day(now)}` };
  for (const [name, error] of Object.entries(errors)) states[name] = { on: states[name].on, note: `not checked — ${error}` };
  writeStates(db, states);
  setMeta(db, CHECKED_KEY, now);
  return { ok: true, found, missing, errors };
}

/** A finished discovery in one line: what was found, what was turned off, what could not be checked. */
export function discoverySummary({ found, missing, errors }) {
  const parts = [`found: ${found.join(', ')}`];
  if (missing.length > 0) parts.push(`not found, turned off: ${missing.join(', ')}`);
  const failed = Object.entries(errors);
  if (failed.length > 0) parts.push(`not checked: ${failed.map(([name, error]) => `${name} (${error})`).join(', ')}`);
  return parts.join(' — ');
}

/** Which models Cursor has for this key: every id and alias it lists. Loaded only here, so a command that never asks never loads the SDK. */
async function listCursorModels(apiKey) {
  const { Cursor } = await import('@cursor/sdk');
  const models = await Cursor.models.list({ apiKey });
  return models.flatMap((m) => [m.id, ...(m.aliases ?? [])]);
}

/** The stand-in's answer to "which models has Cursor": `{ ids: [...] }`; anything else is a failed check. */
function askStandInCursor(standIn) {
  const run = spawnSync(standIn, [], { input: JSON.stringify({ kind: 'cursor-models' }), encoding: 'utf8', timeout: TIMEOUT_MS });
  try {
    const answer = JSON.parse(run.stdout);
    if (Array.isArray(answer?.ids)) return answer.ids;
  } catch {
    // Said below.
  }
  throw new Error((run.stderr || run.stdout || '').trim().slice(0, 200) || `exit ${run.status}`);
}

/**
 * Asks Cursor which of Sumo's Cursor models this CURSOR_API_KEY can use, and sets their switches: found → on, unless the user
 * turned it off by hand; not there → off. Without a key nothing is asked and nothing changes. Never throws. Cursor's list
 * does not say what the account's plan covers: a model the plan leaves out is found here and refused when a job runs on it.
 */
export async function discoverCursor(db, { now = new Date().toISOString(), list = listCursorModels } = {}) {
  const key = process.env.CURSOR_API_KEY?.trim();
  if (!key) return { ok: false, error: 'no CURSOR_API_KEY in this shell — export it, then Discover again' };
  let ids;
  try {
    const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
    ids = new Set(standIn ? askStandInCursor(standIn) : await list(key));
  } catch (cause) {
    return { ok: false, error: String(cause?.message ?? cause).replace(/\s+/g, ' ').slice(0, 200) };
  }
  const names = Object.keys(CURSOR_MODELS);
  const found = names.filter((name) => ids.has(CURSOR_MODELS[name].id));
  const missing = names.filter((name) => !ids.has(CURSOR_MODELS[name].id));
  const states = modelStates(db);
  const offByHand = (name) => !states[name].on && /^turned off /.test(states[name].note ?? '');
  for (const name of found) if (!offByHand(name)) states[name] = { on: true, note: `found ${day(now)}` };
  for (const name of missing) states[name] = { on: false, note: `not found ${day(now)}` };
  writeStates(db, states);
  return { ok: true, found, missing };
}

/** Cursor's part of a discovery in one line. */
export function cursorSummary(result) {
  if (!result.ok) return `Cursor: not checked — ${result.error}`;
  const parts = [`Cursor: found ${result.found.length > 0 ? result.found.join(', ') : 'none of its models'}`];
  if (result.missing.length > 0) parts.push(`not found, turned off: ${result.missing.join(', ')}`);
  return parts.join(' — ');
}
