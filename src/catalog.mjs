import Anthropic from '@anthropic-ai/sdk';
import { spawnSync } from 'node:child_process';
import { anthropicClient, resolveAnthropicCredential } from './auth.mjs';
import { getMeta, setMeta } from './db.mjs';
import { UsageError } from './memory.mjs';

/**
 * The models Sumo can run on: the short names the router, `/model` and `sumo config` use, cheapest
 * first, and the API model each one means. Each has a switch. `sumo setup` asks the API once which
 * of them this credential can use and sets the switches from the answer; `sumo models discover` asks
 * again; `sumo models enable|disable <name>` sets one by hand. The chat, the router, the passes and a
 * job's run all read the switches as they are now.
 */
export const MODEL_IDS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-5-5',
  opus: 'claude-opus-5-5',
  fable: 'claude-fable-5-1',
};
export const MODELS = Object.keys(MODEL_IDS);

export const modelId = (model) => MODEL_IDS[model] ?? model;

const STATE_KEY = 'models.state';
const CHECKED_KEY = 'models.checked';
const TIMEOUT_MS = 30_000;
/** What a Claude Code OAuth token needs on a request outside the Messages API. */
const OAUTH_BETA = 'oauth-2025-04-20';

const day = (now) => String(now).slice(0, 10);

/** Every model's switch and the note that explains it — on, and "not checked", until something is recorded. */
export function modelStates(db) {
  let stored = {};
  try {
    stored = JSON.parse(getMeta(db, STATE_KEY) ?? '{}');
  } catch {
    stored = {};
  }
  return Object.fromEntries(MODELS.map((name) => [name, { on: stored[name]?.on !== false, note: stored[name]?.note ?? 'not checked' }]));
}

const writeStates = (db, states) => setMeta(db, STATE_KEY, JSON.stringify(states));

/** The models the chat, the router and the passes may use, cheapest first. */
export function usableModels(db) {
  const states = modelStates(db);
  return MODELS.filter((name) => states[name].on);
}

/** When the API was last asked which models it has, or null while it never was. */
export const modelsChecked = (db) => getMeta(db, CHECKED_KEY);

/** `name` is a model Sumo knows, or a usage error listing them — after `also`, the other values the setting takes. */
export function knownModel(name, also = []) {
  if (!MODELS.includes(name)) throw new UsageError(`no such model "${name}" — one of: ${[...also, ...MODELS].join(', ')}`);
}

/** Why `name` cannot be used right now, with the way out (`orElse` is another one), or null while it is on. */
export function offLine(db, name, orElse) {
  if (modelStates(db)[name].on) return null;
  return `${name} is off — sumo models enable ${name}${orElse ? `, or ${orElse}` : ''}`;
}

/** `name` is on, or a usage error saying how to turn it on. */
export function assertOn(db, name, orElse) {
  const line = offLine(db, name, orElse);
  if (line) throw new UsageError(line);
}

/** Turns one model on or off by hand. */
export function setModel(db, name, on, now = new Date().toISOString()) {
  knownModel(name);
  const states = modelStates(db);
  states[name] = { on, note: `turned ${on ? 'on' : 'off'} ${day(now)}` };
  writeStates(db, states);
  return states[name];
}

/** One line per model: its name, its switch, the API id and the note — what `sumo models` prints. */
export function modelLines(db, names = MODELS) {
  const states = modelStates(db);
  return names.map((name) => `${name.padEnd(7)} ${states[name].on ? 'on ' : 'off'}  ${MODEL_IDS[name].padEnd(26)} ${states[name].note}`);
}

/** What went wrong with an API call, in one line a person can act on. */
export function describeApiError(cause) {
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
