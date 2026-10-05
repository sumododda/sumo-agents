import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { resolveAnthropicCredential } from './auth.mjs';
import { MODELS, offLine, usableModels } from './catalog.mjs';
import { getMeta, openDb, setMeta, tx } from './db.mjs';
import { localServerStatus } from './local-server.mjs';
import { callModel, failure, logRun } from './model.mjs';
import { ENTRY, paths, REPO_ROOT } from './paths.mjs';
import { aliasesOf, listProjects } from './projects.mjs';
import { line } from './render.mjs';
import { currentProject, markScribed, pendingTurns } from './sessions.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { ftsQuery } from './text.mjs';
import { assistantReplies } from './transcript.mjs';

const LOCK_STALE_MS = 5 * 60_000;
const QUIET_MS = 5 * 60_000;
const TURNS_TO_RUN = 3;
const MAX_REPLIES_PER_SESSION = 6;
const MAX_RELATED = 10;

/** Words that mark a sentence as a standing instruction, which is worth filing right away rather than in the next batch. */
const DURABLE = /\b(always|never|from now on|going forward|remember|don'?t ever|i (prefer|like|want|hate|use)|we (use|moved|switched|decided)|make sure|by default|every time|stop (doing|using))\b/i;

export const looksDurable = (text) => DURABLE.test(text);

/**
 * Whether the writer should run now. It is batched on purpose: each call
 * carries a few thousand tokens of fixed overhead, so one call per message
 * would cost many times more for the same memories.
 */
export function shouldRun(db, { event, now }) {
  const pending = pendingTurns(db);
  if (pending.length === 0) return false;
  if (event !== 'stop') return true; // session start and end always sweep up what is left
  if (pending.some((t) => looksDurable(t.text)) || pending.length >= TURNS_TO_RUN) return true;
  const last = getMeta(db, 'scribe.last_run');
  return !last || Date.parse(now) - Date.parse(last) >= QUIET_MS;
}

/**
 * Starts `sumo <args>` and lets go of it, so the hook that asked returns at once.
 * SUMO_AGENTS_SPAWN_LOG records the request instead of acting on it, which is
 * how the tests check *that* a run was asked for without racing a real one.
 */
export function spawnDetached(args) {
  if (process.env.SUMO_AGENTS_SPAWN_LOG) {
    appendFileSync(process.env.SUMO_AGENTS_SPAWN_LOG, `${args.join(' ')}\n`);
    return;
  }
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], {
    detached: true,
    stdio: 'ignore',
    env: process.env,
  });
  // A run that cannot be started is that run's loss: left unheard, the failure would end the process that asked for it.
  child.on('error', () => {});
  child.unref();
}

/**
 * Whether the run that took a lock is still going. Its pid says so; a model call that is retried can outlast any
 * fixed age. Only a lock that died before it named a pid is judged by its age.
 */
function held(file) {
  const pid = Number(readFileSync(file, 'utf8'));
  if (!Number.isInteger(pid) || pid <= 0) return Date.now() - statSync(file).mtimeMs <= LOCK_STALE_MS;
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM'; // alive, and someone else's
  }
}

/** One writer at a time. A lock whose run has died is taken over. */
export async function withLock(name, fn) {
  const file = join(paths().home, `${name}.lock`);
  let fd;
  // Serialize observation, replacement and PID publication so a paused owner cannot lose its fresh lock.
  const db = openDb();
  try {
    fd = tx(db, () => {
      try {
        if (!held(file)) rmSync(file);
      } catch (cause) {
        if (cause.code !== 'ENOENT') throw cause;
      }
      let acquired;
      try {
        acquired = openSync(file, 'wx', 0o600);
      } catch (cause) {
        if (cause.code !== 'EEXIST') throw cause;
        return undefined;
      }
      try {
        writeSync(acquired, String(process.pid));
      } catch (cause) {
        closeSync(acquired);
        rmSync(file);
        throw cause;
      }
      return acquired;
    });
  } finally {
    db.close();
  }
  if (fd === undefined) return { skipped: 'another run is in progress' };
  try {
    return await fn();
  } finally {
    closeSync(fd);
    // Only while it is still ours: a lock taken over meanwhile belongs to the run that took it.
    try {
      if (readFileSync(file, 'utf8') === String(process.pid)) rmSync(file);
    } catch {
      // Already gone.
    }
  }
}

export function projectEnum(db) {
  return listProjects(db, { includeArchived: true }).map((p) => p.slug);
}

export function knownProjectsLine(db) {
  const all = listProjects(db);
  if (all.length === 0) return 'Known projects: none';
  return `Known projects: ${all.map((p) => [p.slug, ...aliasesOf(db, p.slug)].join(' / ')).join(' · ')}`;
}

/** The JSON shape the model must answer in. Each operation is a closed branch, avoiding an exponential set of optional fields. */
export function opsSchema(db, ops) {
  const slugs = projectEnum(db);
  const field = {
    type: { type: 'string', enum: ['preference', 'fact', 'decision'] },
    scope: { type: 'string', enum: ['global', ...slugs.map((s) => `project:${s}`)] },
    topic: { type: 'string', description: 'one lowercase word: git, testing, style, writing, tooling, deploy…' },
    body: { type: 'string', description: 'one plain sentence, written as a standing fact or rule' },
    turn: { type: ['integer', 'null'], description: 'the number from the [tN] tag, or null when this is an inferred pattern' },
    quote: { type: ['string', 'null'], description: 'an exact run of words from that user turn, or null when this is an inferred pattern' },
  };
  const branch = (op, properties) => {
    const all = { op: { type: 'string', enum: [op] }, ...properties };
    return { type: 'object', properties: all, required: Object.keys(all), additionalProperties: false };
  };
  const branches = {
    add: branch('add', { type: field.type, scope: field.scope, topic: field.topic, body: field.body, turn: field.turn, quote: field.quote }),
    supersede: branch('supersede', {
      old: { type: 'integer', description: 'the id of the existing memory this replaces' },
      type: field.type, scope: field.scope, topic: field.topic, body: field.body, turn: field.turn, quote: field.quote,
    }),
    gotcha: branch('gotcha', { scope: field.scope, body: field.body }),
    checkpoint: slugs.length > 0
      ? branch('checkpoint', { project: { type: 'string', enum: slugs }, done: { type: 'string' }, next: { type: ['string', 'null'] } })
      : null,
    contradiction: branch('contradiction', { ids: { type: 'array', items: { type: 'integer' } }, note: { type: 'string' } }),
    procedure: branch('procedure', { scope: field.scope, title: { type: 'string' }, cue: { type: 'string' }, body: field.body }),
  };
  return {
    type: 'object',
    properties: { ops: { type: 'array', items: { anyOf: ops.map((op) => branches[op]).filter(Boolean) } } },
    required: ['ops'],
    additionalProperties: false,
  };
}

export function relatedMemories(db, texts, scopes) {
  const seen = new Map();
  for (const text of texts) {
    const match = ftsQuery(text);
    if (!match) continue;
    const rows = db
      .prepare(
        `SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
         WHERE memories_fts MATCH ? AND m.state = 'active' AND m.scan_key IS NULL
           AND m.scope IN (${scopes.map(() => '?').join(', ')})
         ORDER BY bm25(memories_fts) LIMIT 3`,
      )
      .all(match, ...scopes);
    for (const row of rows) seen.set(row.id, row);
  }
  return [...seen.values()].slice(0, MAX_RELATED);
}

/** What the writer is shown: the user's words, the assistant's replies around them, and nothing else. */
export function buildBundle(db) {
  const turns = pendingTurns(db);
  if (turns.length === 0) return null;

  const bySession = new Map();
  for (const t of turns) bySession.set(t.session_id, [...(bySession.get(t.session_id) ?? []), t]);

  const scopes = new Set(['global']);
  const sections = [];
  for (const [sessionId, sessionTurns] of bySession) {
    const project = currentProject(db, sessionId);
    if (project) scopes.add(`project:${project}`);
    const session = db.prepare('SELECT transcript_path FROM sessions WHERE id = ?').get(sessionId);
    const replies = session?.transcript_path ? assistantReplies(session.transcript_path, sessionTurns[0].ts).slice(-MAX_REPLIES_PER_SESSION) : [];

    const events = [
      ...sessionTurns.map((t) => ({ ts: t.ts, text: `[t${t.id}] user: ${t.text}` })),
      ...replies.map((r) => ({ ts: r.ts, text: `[assistant]: ${r.text}` })),
    ].sort((a, b) => a.ts.localeCompare(b.ts));

    sections.push(
      `--- session${project ? ` (the conversation is about the project "${project}": statements that are not clearly general belong to project:${project})` : ' (no project in focus: scope is global unless a project is named)'}`,
      ...events.map((e) => e.text),
    );
  }

  const related = relatedMemories(db, turns.map((t) => t.text), [...scopes]);
  const prompt = [
    knownProjectsLine(db),
    related.length > 0 ? `Existing memories that may be related (use supersede, not add, when one of these is being replaced):\n${related.map(line).join('\n')}` : 'Existing related memories: none',
    ...sections,
  ].join('\n');

  return { prompt, turns: new Map(turns.map((t) => [t.id, t])) };
}

/** The API model a pass is retried on when the local one could not answer: the cheapest one that is on, or none. */
const fallbackModel = (db) => usableModels(db)[0] ?? null;

/** Shared by the writer and the consolidation pass: ask, validate, record what it cost. */
export async function askAndApply(db, { kind, promptFile, bundle, ops, sessionId, now }) {
  let model = getMeta(db, `config.${kind}.model`) ?? CONFIG_DEFAULTS[`${kind}.model`];
  const system = readFileSync(join(REPO_ROOT, 'prompts', promptFile), 'utf8').trim();
  const schema = opsSchema(db, ops);
  // A writer set to a model the user has since turned off is not called: the refusal is the pass's failure, in the ledger like any other.
  const off = MODELS.includes(model) ? offLine(db, model, `sumo config ${kind}.model local`) : null;
  let result = off ? failure(off) : await callModel(db, { system, prompt: bundle.prompt, schema, model, kind });
  // A local answer that failed (server down, bundle past its context, answer cut off) is one failed row, then one more try —
  // when a credential is there to pay for it and a model is on to take it.
  const fallback = !result.ok && model === 'local' && resolveAnthropicCredential() ? fallbackModel(db) : null;
  if (fallback) {
    logRun(db, { kind, model, result, note: `${result.error} — retrying on ${fallback}`, now });
    model = fallback;
    result = await callModel(db, { system, prompt: bundle.prompt, schema, model, kind });
  }

  if (!result.ok) {
    logRun(db, { kind, model, result, note: result.error, now });
    return { ok: false, error: result.error, applied: [], dropped: [], usage: result.usage };
  }
  // An answer in the wrong shape is a failed call, not an empty one: what it was shown must be read again.
  if (!Array.isArray(result.data?.ops)) {
    const error = 'the answer had no list of operations';
    logRun(db, { kind, model, result: { ...result, ok: false }, note: error, now });
    return { ok: false, error, applied: [], dropped: [], usage: result.usage };
  }
  const outcome = applyOps(db, result.data.ops, { source: kind, turns: bundle.turns, sessionId, now });
  logRun(db, { kind, model, result, note: `applied=${outcome.applied.length} dropped=${outcome.dropped.length}`, now });
  for (const reason of outcome.dropped) appendFileSync(join(paths().logs, 'scribe.log'), `${now}   dropped — ${reason}\n`);
  return { ok: true, error: null, ...outcome, usage: result.usage };
}

/** Whether the user turned the writer off: nothing gets filed, so nothing should wait for it to be. */
export const writerOff = (db) => (getMeta(db, 'config.scribe.model') ?? CONFIG_DEFAULTS['scribe.model']) === 'off';

/**
 * Files what was said since the last run. Turns are marked done only after the
 * answer was applied, so a failed call costs nothing but a retry.
 */
export async function runScribe(db, { now = new Date().toISOString() } = {}) {
  if (writerOff(db)) return { skipped: 'scribe.model is off' };

  return withLock('scribe', async () => {
    const bundle = buildBundle(db);
    if (!bundle) return { skipped: 'nothing new was said' };

    const sessions = new Set([...bundle.turns.values()].map((t) => t.session_id));
    const outcome = await askAndApply(db, {
      kind: 'scribe', promptFile: 'scribe.md', bundle, ops: ['add', 'supersede', 'gotcha', 'checkpoint'],
      sessionId: sessions.size === 1 ? [...sessions][0] : null, now,
    });

    setMeta(db, 'scribe.last_run', now);
    if (outcome.ok) {
      markScribed(db, [...bundle.turns.keys()]);
      setMeta(db, 'scribe.failures', 0);
    } else {
      setMeta(db, 'scribe.failures', Number(getMeta(db, 'scribe.failures') ?? 0) + 1);
      setMeta(db, 'scribe.last_error', outcome.error);
    }
    return { ...outcome, turns: bundle.turns.size };
  });
}

export async function scribeStatus(db) {
  const failures = Number(getMeta(db, 'scribe.failures') ?? 0);
  const model = getMeta(db, 'config.scribe.model') ?? CONFIG_DEFAULTS['scribe.model'];
  return [
    `model: ${model}`,
    ...(model === 'local' ? [await localServerStatus(db, { file: getMeta(db, 'config.model.file') ?? CONFIG_DEFAULTS['model.file'] })] : []),
    `turns waiting: ${pendingTurns(db, 1000).length}`,
    `last run: ${getMeta(db, 'scribe.last_run') ?? 'never'}`,
    failures > 0 ? `failing: ${failures} in a row — ${getMeta(db, 'scribe.last_error')}` : 'healthy',
  ];
}

export function modelStats(db) {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS runs, SUM(ok) AS ok, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost,
              SUM(cache_read_tokens) AS cache_read, SUM(cache_creation_tokens) AS cache_write
       FROM model_runs GROUP BY kind ORDER BY kind`,
    )
    .all();
  if (rows.length === 0) return ['no cheap-model runs yet'];
  return rows.map(
    (r) => `${r.kind}: ${r.runs} runs (${r.ok} ok) · ${r.input} tokens in · ${r.output} out · $${(r.cost ?? 0).toFixed(4)} · cache ${r.cache_read ?? 0} read · ${r.cache_write ?? 0} written`,
  );
}

/** What a pass did, as a person reads it: how much it read and cost, and each thing it filed or dropped. */
export function outcomeLines(outcome) {
  if (outcome.skipped) return [`nothing to do — ${outcome.skipped}`];
  if (!outcome.ok) return [`failed — ${outcome.error}`];
  const cost = `${outcome.usage.inputTokens} tokens in, ${outcome.usage.outputTokens} out, $${outcome.usage.costUsd.toFixed(4)}`;
  return [
    `read ${outcome.turns ?? outcome.sessions} ${outcome.turns === undefined ? 'sessions' : 'turns'} (${cost})`,
    ...outcome.applied.map((l) => `  ${l}`),
    ...outcome.dropped.map((l) => `  dropped — ${l}`),
    ...(outcome.applied.length + outcome.dropped.length === 0 ? ['  nothing worth remembering'] : []),
  ];
}
