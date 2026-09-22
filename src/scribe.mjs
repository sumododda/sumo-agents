import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { getMeta, setMeta } from './db.mjs';
import { callModel, logRun } from './model.mjs';
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
 * Starts `mem <args>` and lets go of it, so the hook that asked returns at once.
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
  child.unref();
}

/** One writer at a time. A lock older than five minutes belongs to a run that died. */
export function withLock(name, fn) {
  const file = join(paths().home, `${name}.lock`);
  try {
    if (Date.now() - statSync(file).mtimeMs > LOCK_STALE_MS) rmSync(file);
  } catch {
    // No lock yet.
  }
  let fd;
  try {
    fd = openSync(file, 'wx', 0o600);
  } catch {
    return { skipped: 'another run is in progress' };
  }
  try {
    writeSync(fd, String(process.pid));
    return fn();
  } finally {
    closeSync(fd);
    rmSync(file, { force: true });
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

/** The JSON shape the model must answer in. Scopes are an enum of real projects, so it cannot invent one. */
export function opsSchema(db, ops) {
  const slugs = projectEnum(db);
  const properties = {
    op: { enum: ops },
    type: { enum: ['preference', 'fact', 'decision'] },
    scope: { enum: ['global', ...slugs.map((s) => `project:${s}`)] },
    topic: { type: 'string', description: 'one lowercase word: git, testing, style, writing, tooling, deploy…' },
    body: { type: 'string', description: 'one plain sentence, written as a standing fact or rule' },
    turn: { type: 'integer', description: 'the number from the [tN] tag of the user turn this came from' },
    quote: { type: 'string', description: 'an exact, contiguous run of words copied from that user turn' },
    old: { type: 'integer', description: 'for supersede: the id of the existing memory this replaces' },
    done: { type: 'string' },
    next: { type: 'string' },
    ids: { type: 'array', items: { type: 'integer' } },
    note: { type: 'string' },
    title: { type: 'string' },
    cue: { type: 'string' },
  };
  if (slugs.length > 0) properties.project = { enum: slugs };
  return { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties, required: ['op'] } } }, required: ['ops'] };
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

/** Shared by the writer and the consolidation pass: ask, validate, record what it cost. */
export function askAndApply(db, { kind, promptFile, bundle, ops, sessionId, now }) {
  const model = getMeta(db, `config.${kind}.model`) ?? CONFIG_DEFAULTS[`${kind}.model`];
  const system = readFileSync(join(REPO_ROOT, 'prompts', promptFile), 'utf8').trim();
  const result = callModel(db, { system, prompt: bundle.prompt, schema: opsSchema(db, ops), model });

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

/**
 * Files what was said since the last run. Turns are marked done only after the
 * answer was applied, so a failed call costs nothing but a retry.
 */
export function runScribe(db, { now = new Date().toISOString() } = {}) {
  if ((getMeta(db, 'config.scribe.model') ?? CONFIG_DEFAULTS['scribe.model']) === 'off') return { skipped: 'scribe.model is off' };

  return withLock('scribe', () => {
    const bundle = buildBundle(db);
    if (!bundle) return { skipped: 'nothing new was said' };

    const sessions = new Set([...bundle.turns.values()].map((t) => t.session_id));
    const outcome = askAndApply(db, {
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

export function scribeStatus(db) {
  const failures = Number(getMeta(db, 'scribe.failures') ?? 0);
  return [
    `model: ${getMeta(db, 'config.scribe.model') ?? CONFIG_DEFAULTS['scribe.model']}`,
    `turns waiting: ${pendingTurns(db, 1000).length}`,
    `last run: ${getMeta(db, 'scribe.last_run') ?? 'never'}`,
    failures > 0 ? `failing: ${failures} in a row — ${getMeta(db, 'scribe.last_error')}` : 'healthy',
  ];
}

export function modelStats(db) {
  const rows = db
    .prepare(
      `SELECT kind, COUNT(*) AS runs, SUM(ok) AS ok, SUM(input_tokens) AS input, SUM(output_tokens) AS output, SUM(cost_usd) AS cost
       FROM model_runs GROUP BY kind ORDER BY kind`,
    )
    .all();
  if (rows.length === 0) return ['no cheap-model runs yet'];
  return rows.map((r) => `${r.kind}: ${r.runs} runs (${r.ok} ok) · ${r.input} tokens in · ${r.output} out · $${(r.cost ?? 0).toFixed(4)}`);
}
