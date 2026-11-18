import { spawn } from 'node:child_process';
import { appendFileSync, closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { resolveAnthropicCredential } from './auth.mjs';
import { MODELS, offLine, usableModels } from './catalog.mjs';
import { getMeta, openDb, tx } from './db.mjs';
import { judgeNewPairs } from './dream.mjs';
import { extractorVersion, filingState, notePass } from './ledger.mjs';
import { callModel, failure, logRun } from './model.mjs';
import { appendLog } from './logs.mjs';
import { paths, REPO_ROOT, SELF } from './paths.mjs';
import { aliasesOf, listProjects } from './projects.mjs';
import { line } from './render.mjs';
import { currentProject, markScribed, sessionJournal, sessionsAwaitingExtraction, turnsAwaitingExtraction } from './sessions.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { ftsQuery, head } from './text.mjs';
import { abridge } from './transcript.mjs';

const LOCK_STALE_MS = 5 * 60_000;
const MAX_RELATED = 10;
/** Conversations one pass reads, and model calls it makes: the rest wait for the next pass, which is a session away. */
const MAX_SESSIONS = 5;
const MAX_CALLS = 8;
/** Calls on the hosted fallback a pass started by itself may make: nobody is there to see what a longer run costs. */
const MAX_PAID_AUTO = 2;
/**
 * How much of a conversation one model call reads, so a batch always fits the local model's 32k context with room to
 * think and answer. Counted in characters, which a pasted log turns into more tokens than prose does — the room is
 * left for that. A long conversation is read in several calls.
 */
const BATCH_CHARS = 40_000;
/** How often one batch is tried before it is split in half, and one turn alone before it is set aside. */
const ATTEMPTS = 3;
const NO_USAGE = { inputTokens: 0, outputTokens: 0, costUsd: 0, cacheReadTokens: null, cacheCreationTokens: null };
const added = (x, y) => ({ ...x, inputTokens: x.inputTokens + y.inputTokens, outputTokens: x.outputTokens + y.outputTokens, costUsd: x.costUsd + y.costUsd });

/** The model the pass is set to: `memory.model`, the one setting. */
const memoryModel = (db) => getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model'];
/** Whether the user turned the writer off: nothing gets filed, so nothing should wait for it to be. */
const writerOff = (db) => memoryModel(db) === 'off';

/**
 * Whether a session starting or ending should start the memory pass: a finished conversation waits to be read, and
 * filing is neither off nor paused. A conversation is read once, when it is over — a turn ending starts nothing.
 */
export function shouldRun(db, { now }) {
  if (writerOff(db)) return false;
  if (sessionsAwaitingExtraction(db, { now, limit: 1 }).length === 0) return false;
  return !filingState(db, now).paused;
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
  const child = spawn(SELF[0], [...SELF.slice(1), ...args], {
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

function projectEnum(db) {
  return listProjects(db, { includeArchived: true }).map((p) => p.slug);
}

function knownProjectsLine(db) {
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
    // Only a trap has a sentence the model writes. What the user stated is stored in their words: no body is asked for.
    body: { type: 'string', description: 'one plain sentence, written as a standing fact or rule' },
    // Never null: a statement with no turn and no words of the user's behind it is a guess, and guesses are not kept.
    turn: { type: 'integer', description: 'the number from the [tN] tag of the user turn it was said in' },
    quote: { type: 'string', description: "the user's exact words, copied from that turn letter for letter, on one line: they are stored as the memory, so do not reword, shorten or correct them" },
    // Required like the rest, and may be empty: an optional field is a combination more for the grammar to compile.
    keys: { type: 'array', items: { type: 'string' }, description: 'up to 6 short lowercase search terms it is about that are not among its own words, or []' },
  };
  const branch = (op, properties) => {
    const all = { op: { type: 'string', enum: [op] }, ...properties };
    return { type: 'object', properties: all, required: Object.keys(all), additionalProperties: false };
  };
  const branches = {
    add: branch('add', { type: field.type, scope: field.scope, topic: field.topic, turn: field.turn, quote: field.quote, keys: field.keys }),
    supersede: branch('supersede', {
      old: { type: 'integer', description: 'the id of the existing memory this replaces' },
      type: field.type, scope: field.scope, topic: field.topic, turn: field.turn, quote: field.quote, keys: field.keys,
    }),
    gotcha: branch('gotcha', { scope: field.scope, body: field.body, keys: field.keys }),
    checkpoint: slugs.length > 0
      ? branch('checkpoint', { project: { type: 'string', enum: slugs }, done: { type: 'string' }, next: { type: ['string', 'null'] } })
      : null,
  };
  return {
    type: 'object',
    properties: { ops: { type: 'array', items: { anyOf: ops.map((op) => branches[op]).filter(Boolean) } } },
    required: ['ops'],
    additionalProperties: false,
  };
}

function relatedMemories(db, texts, scopes) {
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

/** The most of one turn a model call is shown, and of the replies after it. */
const TURN_SHOWN = 30_000;
const REPLIES_PER_TURN = 2;

/**
 * A turn as the model is shown it: whole when it fits, else its head and its tail — a pasted log says what it is at
 * the top and how it ended at the bottom. The journal keeps the turn whole, and a quote is checked against that.
 */
function shownTurn(text) {
  if (text.length <= TURN_SHOWN) return text;
  const half = Math.floor(TURN_SHOWN / 2);
  const tail = text.slice(-half);
  // Either cut can fall inside an emoji; a lone half of one makes the whole request one the API refuses.
  return `${head(text, half)}\n[… ${text.length - 2 * half} characters of this turn not shown …]\n${/^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail}`;
}

/**
 * A conversation's turns that wait to be read, each with the replies that answered it, in the order of their ids —
 * the order the ledger's `first_turn`…`last_turn` ranges are in, which a turn replayed late does not share with time.
 */
function unitsOf(journal, waiting) {
  const units = [];
  let current = null;
  for (const entry of journal) {
    if (entry.kind === 'turn') {
      current = waiting.has(entry.id) ? { turn: entry, text: shownTurn(entry.text), replies: [] } : null;
      if (current) units.push(current);
    } else if (current) {
      current.replies = [...current.replies, { ts: entry.ts, text: abridge(entry.text) }].slice(-REPLIES_PER_TURN);
    }
  }
  for (const unit of units) unit.size = unit.text.length + unit.replies.reduce((n, r) => n + r.text.length, 0);
  return units.sort((a, b) => a.turn.id - b.turn.id);
}

/** The turns one model call reads: the first of those waiting, as many as fit, and always at least one. */
function naturalBatch(units) {
  const batch = [];
  let used = 0;
  for (const unit of units) {
    if (batch.length > 0 && used + unit.size > BATCH_CHARS) break;
    batch.push(unit);
    used += unit.size;
  }
  return batch;
}

/**
 * What the model is shown for one batch: today's date, the projects, memories that may be related, then the user's
 * words with the assistant's replies to them, as they were said — and nothing else. `related` false leaves memory
 * out: what an extractor would file from a conversation is then a matter of the conversation alone.
 */
function bundleOf(db, sessionId, batch, { now, related = true }) {
  const project = batch.map((u) => u.turn.project).filter(Boolean).at(-1) ?? currentProject(db, sessionId);
  const scopes = ['global', ...(project ? [`project:${project}`] : [])];
  const said = [...batch].sort((a, b) => a.turn.ts.localeCompare(b.turn.ts) || a.turn.id - b.turn.id);
  const known = related ? relatedMemories(db, batch.map((u) => u.turn.text), scopes) : [];
  const prompt = [
    `Today's date: ${now.slice(0, 10)}`,
    knownProjectsLine(db),
    ...(related ? [known.length > 0 ? `Existing memories that may be related (use supersede, not add, when one of these is being replaced):\n${known.map(line).join('\n')}` : 'Existing related memories: none'] : []),
    `--- session${project ? ` (the conversation is about the project "${project}": statements that are not clearly general belong to project:${project})` : ' (no project in focus: scope is global unless a project is named)'}`,
    ...said.flatMap((u) => [`[t${u.turn.id}] user: ${u.text}`, ...u.replies.map((r) => `[assistant]: ${r.text}`)]),
  ].join('\n');
  return { prompt, turns: new Map(batch.map((u) => [u.turn.id, u.turn])) };
}

/**
 * How often this exact batch has failed under this extractor, by its own fault: a row's `attempts` is the number of
 * tries that count, its own included, and a try made while the model answered nothing at all does not (`runScribe`).
 */
const failedTimes = (db, sessionId, version, batch) =>
  db
    .prepare(`SELECT COALESCE(MAX(attempts), 0) AS n FROM extractions WHERE session_id = ? AND extractor_version = ? AND first_turn = ? AND last_turn = ? AND status = 'failed'`)
    .get(sessionId, version, batch[0].turn.id, batch.at(-1).turn.id).n;

/**
 * The next batch of a conversation to read, or null when nothing of it waits: `{ batch, attempts }`. A batch that has
 * failed three times is not asked again whole — its first half is, and so on down; a single turn that failed three
 * times alone comes back with `quarantine`, to be set aside so the turns after it are read.
 */
function nextBatch(db, sessionId, version) {
  // Read under any extractor is read: only a rebuild reads a conversation again under this one.
  const waiting = turnsAwaitingExtraction(db, sessionId);
  if (waiting.length === 0) return null;
  let batch = naturalBatch(unitsOf(sessionJournal(db, sessionId), new Set(waiting.map((t) => t.id))));
  for (;;) {
    const failed = failedTimes(db, sessionId, version, batch);
    if (failed < ATTEMPTS) return { batch, attempts: failed + 1 };
    if (batch.length === 1) return { batch, attempts: failed, quarantine: true };
    batch = batch.slice(0, Math.ceil(batch.length / 2));
  }
}

/** Exactly what the next pass asked for by hand would send first, or null when no conversation waits to be read. */
export function buildBundle(db, { now = new Date().toISOString() } = {}) {
  const version = extractorVersion(db);
  for (const session of sessionsAwaitingExtraction(db, { now, limit: MAX_SESSIONS, includeOpen: true })) {
    const next = nextBatch(db, session.id, version);
    if (next && !next.quarantine) return bundleOf(db, session.id, next.batch, { now });
  }
  return null;
}

/** The API model a call is retried on when the local one could not answer: the cheapest one that is on, or none. */
const fallbackModel = (db) => usableModels(db)[0] ?? null;
const EXTRACTS = ['add', 'supersede', 'gotcha', 'checkpoint'];

/**
 * One batch put to the model `memory.model` names: `{ ok, error, ops, usage, model, result, fallbackUsed }`. A local
 * model that could not answer (server down, bundle past its context, answer cut off) is one failed row of the model
 * ledger, then one more try on the hosted fallback — when a credential is there to pay for it and a model is on to
 * take it — and `fallbackUsed` says so; `fallback: false` keeps the call on the model as set, for a pass that has
 * paid for as much as it may. `quiet` keeps the model ledger out of it: a dry run writes nothing.
 */
async function ask(db, { bundle, now, quiet = false, fallback: mayPay = true }) {
  let model = memoryModel(db);
  const log = (result, note) => {
    if (!quiet) logRun(db, { kind: 'scribe', model, result, note, now });
  };
  const system = readFileSync(join(REPO_ROOT, 'prompts', 'scribe.md'), 'utf8').trim();
  const schema = opsSchema(db, EXTRACTS);
  // A writer set to a model the user has since turned off is not called: the refusal is the pass's failure, in the ledger like any other.
  const off = MODELS.includes(model) ? offLine(db, model, 'set Memory › Filed by to local there') : null;
  let result = off ? failure(off) : await callModel(db, { system, prompt: bundle.prompt, schema, model, kind: 'scribe' });
  // A local answer that failed (server down, bundle past its context, answer cut off) is one failed row, then one more try —
  // when a credential is there to pay for it and a model is on to take it.
  const fallback = mayPay && !result.ok && model === 'local' && resolveAnthropicCredential() ? fallbackModel(db) : null;
  if (fallback) {
    log(result, `${result.error} — retrying on ${fallback}`);
    model = fallback;
    result = await callModel(db, { system, prompt: bundle.prompt, schema, model, kind: 'scribe' });
  }
  const answered = { usage: result.usage, model, result, fallbackUsed: Boolean(fallback), log };
  if (!result.ok) {
    log(result, result.error);
    return { ...answered, ok: false, error: result.error, ops: null };
  }
  // An answer in the wrong shape is a failed call, not an empty one: what it was shown must be read again.
  if (!Array.isArray(result.data?.ops)) {
    const error = 'the answer had no list of operations';
    log({ ...result, ok: false }, error);
    return { ...answered, ok: false, error, ops: null };
  }
  return { ...answered, ok: true, error: null, ops: result.data.ops };
}

/**
 * What the pair judge says of each statement in `ops` that has a look-alike in memory — a fact that may have changed.
 * Code picks the pairs (a dry run of the rules); the local model only labels them. `labels` is undefined when nobody
 * could be asked: the rules then put each pair to the user as a notice. Only the local model judges, never a paid one.
 */
export async function labelsFor(db, ops, ctx) {
  if (memoryModel(db) !== 'local') return { labels: undefined, usage: NO_USAGE };
  const { pairs } = applyOps(db, ops, { ...ctx, dry: true });
  if (pairs.length === 0) return { labels: undefined, usage: NO_USAGE };
  return judgeNewPairs(db, pairs, ctx.now);
}

/** A model's operations through the rules: look-alikes judged first, then everything applied in one transaction. */
async function fileOps(db, ops, ctx) {
  const { labels, usage } = await labelsFor(db, ops, ctx);
  return { ...applyOps(db, ops, { ...ctx, labels }), usage };
}

/**
 * One batch read and filed, with its row of the extraction ledger: written `running` before the model is called, so a
 * pass that dies leaves the attempt behind it; closed `ok` with the model's answer as it came, or `failed` with why.
 */
async function readBatch(db, { sessionId, batch, attempts, version, now, fallback }) {
  const bundle = bundleOf(db, sessionId, batch, { now });
  const ids = batch.map((u) => u.turn.id);
  const runId = Number(
    db
      .prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at) VALUES (?, ?, 'running', ?, ?, ?, ?)`)
      .run(sessionId, version, attempts, ids[0], ids.at(-1), now).lastInsertRowid,
  );
  const close = (status, { ops = null, error = null } = {}) =>
    db.prepare('UPDATE extractions SET status = ?, ops_json = ?, error = ?, ended_at = ? WHERE id = ?').run(status, ops === null ? null : JSON.stringify(ops), error, now, runId);

  const asked = await ask(db, { bundle, now, fallback });
  if (!asked.ok) {
    close('failed', { error: asked.error });
    return { ok: false, error: asked.error, usage: asked.usage, fallbackUsed: asked.fallbackUsed, attempts, runId };
  }
  let outcome;
  try {
    outcome = await fileOps(db, asked.ops, { source: 'scribe', turns: bundle.turns, sessionId, now, derivedBy: version, runId });
  } catch (cause) {
    // A bug in the rules is this attempt's failure too, and still surfaces.
    close('failed', { ops: asked.ops, error: `could not be applied: ${cause.message}` });
    throw cause;
  }
  // Closed and marked together: a turn is never both read and still owed.
  tx(db, () => {
    close('ok', { ops: asked.ops });
    markScribed(db, ids);
  });
  asked.log(asked.result, `applied=${outcome.applied.length} dropped=${outcome.dropped.length}`);
  for (const reason of outcome.dropped) appendLog('scribe.log', `${now}   dropped — ${reason}\n`);
  if (outcome.refused) appendLog('scribe.log', `${now}   nothing retired — ${outcome.refused}\n`);
  return { ok: true, error: null, ...outcome, usage: added(asked.usage, outcome.usage), fallbackUsed: asked.fallbackUsed, model: asked.model, turns: ids.length };
}

/** A turn that failed three times alone is set aside, in the ledger and counted, so the turns after it are read. */
function quarantine(db, { sessionId, turn, attempts, version, now }) {
  const last = db
    .prepare(`SELECT error FROM extractions WHERE session_id = ? AND extractor_version = ? AND first_turn = ? AND last_turn = ? AND status = 'failed' ORDER BY id DESC LIMIT 1`)
    .get(sessionId, version, turn.id, turn.id);
  tx(db, () => {
    db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, error, started_at, ended_at) VALUES (?, ?, 'quarantined', ?, ?, ?, ?, ?, ?)`)
      .run(sessionId, version, attempts, turn.id, turn.id, last?.error ?? null, now, now);
    markScribed(db, [turn.id]);
  });
  return `t${turn.id} was set aside: read alone it failed ${attempts} times — ${last?.error ?? 'no reason kept'}`;
}

/**
 * Whether the model answers at all: one turn that says nothing, put to it as any batch is. A batch that fails while
 * this is answered failed by its own fault; one that fails while this fails too says nothing about the batch.
 * `{ ok, fallbackUsed }`.
 */
async function modelAnswers(db, now, fallback) {
  const turn = { id: 0, session_id: '', ts: now, text: 'hello', project: null };
  const bundle = bundleOf(db, '', [{ turn, text: turn.text, replies: [] }], { now, related: false });
  const asked = await ask(db, { bundle, now, quiet: true, fallback });
  // In the model ledger when it read or cost something; a call that reached no model is the failed row already there.
  if (asked.usage.inputTokens + asked.usage.outputTokens > 0) {
    logRun(db, { kind: 'scribe', model: asked.model, result: asked.ok ? asked.result : { ...asked.result, ok: false }, note: `asked whether the model answers at all: ${asked.ok ? 'it does' : asked.error}`, now });
  }
  return { ok: asked.ok, fallbackUsed: asked.fallbackUsed };
}

/**
 * The filing half of the memory pass: each finished conversation read once, in batches that fit the local model, and
 * what the user stated in it filed. `auto` is a pass a session started by itself: it reads only conversations that
 * are over, and nothing while filing is paused (ledger.mjs). Asked for by hand it also reads conversations still
 * going on, and is how a paused filing is tried again.
 *
 * One batch failing stops only its own conversation for this pass, and is tried again by the next: three failures
 * and it is read in halves, down to the one turn that cannot be read, which is set aside. That ladder is for a batch
 * the model cannot read; a model that answers nothing at all is another matter — the pass fails, the try is not held
 * against the batch, and three such passes in a row pause filing.
 */
export async function runScribe(db, { now = new Date().toISOString(), auto = false } = {}) {
  if (writerOff(db)) return { skipped: 'memory.model is off' };

  return withLock('scribe', async () => {
    const version = extractorVersion(db);
    const state = filingState(db, now);
    if (auto && state.paused) return { skipped: `filing is paused: ${state.reason}`, paused: true };
    // The lock is ours: a row still `running` belongs to a pass that died, and is one failed attempt.
    db.prepare(`UPDATE extractions SET status = 'failed', error = 'the pass that started it died before it finished', ended_at = ? WHERE status = 'running'`).run(now);

    const sessions = sessionsAwaitingExtraction(db, { now, limit: MAX_SESSIONS, includeOpen: !auto });
    if (sessions.length === 0) return { skipped: 'nothing new was said' };

    const pass = { applied: [], dropped: [], notes: [], usage: NO_USAGE, turns: 0, stuck: 0, down: false, error: null, fallbackUsed: false, direct: false, written: [] };
    let calls = 0;
    let alive = false;
    // What the hosted fallback was asked, answered or not: a pass nobody asked for pays for two such calls and no more.
    let paid = 0;
    const mayPay = () => !auto || paid < MAX_PAID_AUTO;
    reading: for (const session of sessions) {
      while (calls < MAX_CALLS) {
        const next = nextBatch(db, session.id, version);
        if (!next) break;
        if (next.quarantine) {
          pass.notes.push(quarantine(db, { sessionId: session.id, turn: next.batch[0].turn, attempts: next.attempts, version, now }));
          continue;
        }
        if (!mayPay()) {
          pass.notes.push(`the hosted fallback read ${paid} batches, as many as a pass started by itself may pay for: the other conversations wait for the local model, or for sumo memory run`);
          break reading;
        }
        calls++;
        const outcome = await readBatch(db, { sessionId: session.id, batch: next.batch, attempts: next.attempts, version, now, fallback: true });
        if (outcome.fallbackUsed) paid++;
        pass.usage = added(pass.usage, outcome.usage);
        pass.fallbackUsed ||= outcome.fallbackUsed;
        if (outcome.ok) {
          alive = true;
          pass.direct ||= !outcome.fallbackUsed;
          pass.turns += outcome.turns;
          pass.applied.push(...outcome.applied);
          pass.dropped.push(...outcome.dropped);
          pass.written.push(...outcome.written);
          if (outcome.fallbackUsed) pass.notes.push(`the local model could not answer: read on ${outcome.model} instead`);
          continue;
        }
        pass.error = outcome.error;
        // Nothing has shown the model answers in this pass: is it this batch, or is the model not answering anything?
        if (!alive) {
          const answers = await modelAnswers(db, now, mayPay());
          if (answers.fallbackUsed) paid++;
          alive = answers.ok;
        }
        if (!alive) {
          db.prepare('UPDATE extractions SET attempts = attempts - 1 WHERE id = ?').run(outcome.runId);
          pass.down = true;
          break reading;
        }
        // Its third failure: asked again at once in halves, or set aside if it is one turn — the next look says which.
        if (outcome.attempts >= ATTEMPTS) continue;
        // Otherwise the rest of this conversation waits behind it; the other conversations do not.
        pass.stuck++;
        break;
      }
    }

    notePass(db, { ok: !pass.down, error: pass.error, fallbackUsed: pass.fallbackUsed, direct: pass.direct });
    if (pass.down) return { ok: false, error: pass.error, applied: [], dropped: [], notes: pass.notes, usage: pass.usage };
    if (pass.stuck > 0) pass.notes.push(`${pass.stuck} conversation${pass.stuck === 1 ? '' : 's'} could not be read and wait${pass.stuck === 1 ? 's' : ''} for the next pass — ${pass.error}`);
    return { ok: true, error: null, applied: pass.applied, dropped: pass.dropped, notes: [...new Set(pass.notes)], usage: pass.usage, turns: pass.turns, written: pass.written };
  });
}

/**
 * The current extractor over journal turns, changing nothing: what it would file from them, judged by the rules as
 * memory stands. `{ ok, error, wouldFile, dropped, batches }` — `wouldFile` as `applyOps` gives `filed`, `dropped`
 * the proposals the rules refused; `batches` what was read, as `{ sessionId, turnIds, ops }`, for whoever then applies it (rebuild.mjs).
 * The model is shown the conversation and no memory, so the answer is the conversation's alone. Only what the user
 * stated is asked of it here: a trap or a checkpoint drawn from a reply cites no turn to be rebuilt from.
 */
export async function extract(db, { turnIds, now = new Date().toISOString() }) {
  const out = { ok: true, error: null, wouldFile: [], dropped: [], batches: [], usage: NO_USAGE };
  if (writerOff(db)) return { ...out, ok: false, error: 'memory.model is off' };
  const wanted = [...new Set(turnIds)].filter(Number.isInteger);
  const bySession = new Map();
  for (const id of wanted) {
    const row = db.prepare('SELECT id, session_id FROM user_turns WHERE id = ?').get(id);
    if (row) bySession.set(row.session_id, [...(bySession.get(row.session_id) ?? []), row.id]);
  }
  for (const [sessionId, ids] of bySession) {
    let rest = unitsOf(sessionJournal(db, sessionId), new Set(ids));
    while (rest.length > 0) {
      const batch = naturalBatch(rest);
      rest = rest.slice(batch.length);
      const bundle = bundleOf(db, sessionId, batch, { now, related: false });
      const asked = await ask(db, { bundle, now, quiet: true });
      out.usage = added(out.usage, asked.usage);
      if (!asked.ok) {
        out.ok = false;
        out.error = asked.error;
        continue;
      }
      const ops = asked.ops.filter((op) => op?.op === 'add' || op?.op === 'supersede');
      const dry = applyOps(db, ops, { source: 'scribe', turns: bundle.turns, sessionId, now, dry: true });
      out.wouldFile.push(...dry.filed);
      // What memory holds already was not refused: it is in `wouldFile`, with the memory that holds it.
      out.dropped.push(...dry.dropped.filter((reason) => !dry.repeats.includes(reason)));
      out.batches.push({ sessionId, turnIds: batch.map((u) => u.turn.id), ops, turns: bundle.turns });
    }
  }
  return out;
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
  // Token counts run to millions: grouped by thousands, they read at a glance.
  const n = (count) => (count ?? 0).toLocaleString('en-US');
  return rows.map(
    (r) => `${r.kind}: ${r.runs} run${r.runs === 1 ? '' : 's'} (${r.ok} ok) · ${n(r.input)} tokens in · ${n(r.output)} out · $${(r.cost ?? 0).toFixed(4)} · cache ${n(r.cache_read)} read · ${n(r.cache_write)} written`,
  );
}

/** What a pass did, as a person reads it: how much it read and cost, each thing it filed or dropped, and what it has to say of itself. */
export function outcomeLines(outcome) {
  if (outcome.skipped) return [`nothing to do — ${outcome.skipped}`];
  if (!outcome.ok) return [`failed — ${outcome.error}`, ...(outcome.notes ?? []).map((l) => `  ${l}`)];
  const cost = `${outcome.usage.inputTokens.toLocaleString('en-US')} tokens in, ${outcome.usage.outputTokens.toLocaleString('en-US')} out, $${outcome.usage.costUsd.toFixed(4)}`;
  return [
    outcome.turns === undefined ? `went over memory (${cost})` : `read ${outcome.turns} turns (${cost})`,
    ...outcome.applied.map((l) => `  ${l}`),
    ...outcome.dropped.map((l) => `  dropped — ${l}`),
    ...(outcome.notes ?? []).map((l) => `  ${l}`),
    ...(outcome.applied.length + outcome.dropped.length === 0 ? [outcome.turns === undefined ? '  nothing to raise or fill in' : '  nothing worth remembering'] : []),
  ];
}
