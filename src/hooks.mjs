import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { card } from './card.mjs';
import { getMeta, openDb, setMeta } from './db.mjs';
import { backup } from './export.mjs';
import { guardCommand, guardPath } from './guard.mjs';
import { paths } from './paths.mjs';
import { prime } from './prime.mjs';
import { detect, touch } from './projects.mjs';
import { closingQuestions, recallBeforeAsking } from './recall.mjs';
import { line } from './render.mjs';
import { shouldRun, spawnDetached } from './scribe.mjs';
import { clearInjections, contextBand, contextNudge, contextUse, currentProject, endSession, ensureSession, injectedSlugs, markInjected, pruneStates, recordTurn, sessionsAwaitingDream } from './sessions.mjs';
import { claim, renderWorkflow, withoutSumoCalls } from './workflows.mjs';

/**
 * The session policy, as events: a session starts, the user speaks, a tool is
 * about to run, a turn ends, the session ends. `sumo chat` raises them in
 * process; `sumo hook <event>` raises one from JSON on stdin, for anything else
 * that drives a session. Every handler returns what should be put in front of
 * the model — text, or a decision as JSON — and nothing else.
 */

const BACKUP_EVERY_MS = 7 * 24 * 3_600_000;
const SESSIONS_TO_DREAM = 3;

/** The one event shape. Field names are what the payload carries; a missing one is simply absent. */
export function fieldsOf(p) {
  return {
    sessionId: p.session_id,
    cwd: p.cwd ?? null,
    transcriptPath: p.transcript_path ?? null,
    source: p.source ?? null,
    prompt: p.prompt ?? '',
    toolName: String(p.tool_name ?? '').toLowerCase(),
    command: p.tool_input?.command ?? '',
    path: p.tool_input?.path ?? p.tool_input?.file_path ?? '',
    agentId: p.agent_id ?? null,
    project: p.project ?? null,
    reply: p.last_assistant_message ?? '',
    contextTokens: Number.isFinite(p.context_tokens) ? p.context_tokens : null,
    stopHookActive: p.stop_hook_active === true,
  };
}

const deny = (reason) => JSON.stringify({ deny: reason });
const isRead = (tool) => tool === 'read' || tool === 'view';

/** The guard, first and without memory: a destructive command or a secret file is refused on sight. */
export function earlyRefusal(e) {
  if (e.toolName === 'bash' && e.command) return guardCommand(e.command, { cwd: e.cwd }) ?? '';
  if (isRead(e.toolName) && e.path) return guardPath(e.path) ?? '';
  return '';
}

const alreadyKnown = (known) => `memory already holds\n${known.map(line).join('\n')}\nIf one of these answers your question, act on it instead of asking.`;

/** Global workflows always apply; a project's apply once that project has come up in the session. */
const scopesOf = (db, sessionId) => ['global', ...injectedSlugs(db, sessionId).map((slug) => `project:${slug}`)];

/** What a fresh start should be told to keep: the job in hand if there is one, otherwise the project the session is about. */
function focusOf(db, sessionId) {
  const job = db.prepare(`SELECT title FROM jobs WHERE status IN ('running', 'needs_input') ORDER BY id DESC LIMIT 1`).get();
  return job?.title ?? currentProject(db, sessionId) ?? 'the work in hand';
}

/**
 * How big this session has got. Said once per band — remembered the same way a
 * card that has been shown is remembered, so a fresh start (which clears those)
 * lets it be said again, which is right: the context really did shrink.
 */
function sizeNudge(db, e, now) {
  const tokens = e.contextTokens ?? contextUse(e.transcriptPath)?.tokens ?? null;
  const band = tokens !== null && contextBand(tokens);
  if (!band) return '';
  const slug = `context:${band}`;
  if (db.prepare('SELECT 1 FROM session_injections WHERE session_id = ? AND slug = ?').get(e.sessionId, slug)) return '';
  markInjected(db, e.sessionId, slug, now);
  return contextNudge(band, tokens, focusOf(db, e.sessionId));
}

const HANDLERS = {
  'session-start'(db, e, now) {
    ensureSession(db, { id: e.sessionId, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    // A fresh start wipes the cards from context; forgetting they were shown lets them come back.
    if (e.source === 'compact' || e.source === 'new') clearInjections(db, e.sessionId);

    if (shouldRun(db, { event: 'session-start', now })) spawnDetached(['scribe', 'run']);
    if (sessionsAwaitingDream(db, now, SESSIONS_TO_DREAM).length >= SESSIONS_TO_DREAM) spawnDetached(['dream', 'run']);

    const last = getMeta(db, 'last_backup');
    if (!last || Date.parse(now) - Date.parse(last) > BACKUP_EVERY_MS) {
      try {
        backup(db, new Date(now));
      } catch (cause) {
        // Housekeeping: a snapshot that cannot be written costs the backup, never the session its memory. The block says it instead.
        setMeta(db, 'backup.failed', String(cause.message).slice(0, 200));
      }
    }
    try {
      pruneStates(now);
    } catch (cause) {
      // Housekeeping too: a saved session that cannot be let go stays, and is said in the hook log, never to the session starting.
      logFailure('session-start prune', cause);
    }

    return prime(db, { now });
  },

  prompt(db, e, now) {
    ensureSession(db, { id: e.sessionId, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    if (recordTurn(db, { sessionId: e.sessionId, text: e.prompt, now }) === null) return '';

    const shown = new Set(injectedSlugs(db, e.sessionId));
    const cards = [];
    for (const slug of detect(db, e.prompt)) {
      touch(db, slug, now);
      // Every mention is stamped, not only the first: the project named last is the one the session is about, also when its card was shown before.
      markInjected(db, e.sessionId, slug, now);
      if (shown.has(slug)) continue;
      cards.push(card(db, slug, { now }));
    }

    const asked = claim(db, { sessionId: e.sessionId, text: e.prompt, scopes: scopesOf(db, e.sessionId), now });
    if (asked.length > 0) {
      cards.push(`The user taught a workflow for what they are asking — follow it exactly, in order:\n${asked.map(renderWorkflow).join('\n')}`);
    }

    const size = sizeNudge(db, e, now);
    if (size) cards.push(size);
    return cards.join('\n');
  },

  /**
   * The gate. A shell command that is the thing a workflow is about does not run until that
   * workflow's steps are in front of whoever is running it. Once per session per agent: the point
   * is to put the steps there at the moment of action, not to argue.
   */
  'pre-tool'(db, e, now) {
    if (e.toolName !== 'bash' || !e.command) return '';
    // Teaching or reading a workflow names its own cue; `sumo` must never be gated by what it manages — and nothing else rides through on it.
    const judged = withoutSumoCalls(e.command);
    if (!judged) return '';
    ensureSession(db, { id: e.sessionId, cwd: e.cwd, transcriptPath: e.transcriptPath, now });

    const due = claim(db, { sessionId: e.sessionId, agentId: e.agentId, text: judged, scopes: [...scopesOf(db, e.sessionId), ...(e.project ? [`project:${e.project}`] : [])], forCommand: true, now });
    if (due.length === 0) return '';
    return deny(
      `Not yet. The user taught a workflow for exactly this, and it has not been followed in this session:\n${due.map(renderWorkflow).join('\n')}\n` +
        'Do its steps in order — some come before this command — then run the command again.',
    );
  },

  stop(db, e, now) {
    ensureSession(db, { id: e.sessionId, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    if (shouldRun(db, { event: 'stop', now })) spawnDetached(['scribe', 'run']);

    // The other gate: a turn that ends by asking the user something memory may already hold.
    // Already continuing because of it → whatever the turn ends on now goes to the user.
    if (e.stopHookActive || !e.reply) return '';
    const known = recallBeforeAsking(db, { sessionId: e.sessionId, asked: closingQuestions(e.reply), now });
    if (known.length === 0) return '';
    return JSON.stringify({ context: `Before the user answers that: ${alreadyKnown(known)} If none does, the question stands — say so in one line.` });
  },

  'session-end'(db, e, now) {
    ensureSession(db, { id: e.sessionId, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    endSession(db, e.sessionId, now);
    if (shouldRun(db, { event: 'session-end', now })) spawnDetached(['scribe', 'run']);
    return '';
  },
};

/** One event, in process: the guard first, then the handler. Throws only for an unknown event or a payload with no session. */
export function handleEvent(db, event, payload, now = new Date().toISOString()) {
  const handler = HANDLERS[event];
  if (!handler) throw new Error(`no handler for ${event}`);
  const e = fieldsOf(payload);
  if (!e.sessionId) throw new Error('the event had no session id');
  const refused = event === 'pre-tool' ? earlyRefusal(e) : '';
  if (refused) return deny(refused);
  return handler(db, e, now);
}

/** What went wrong, in logs/hook.log. If even the log cannot be written there is nothing left to do but stay out of the way. */
function logFailure(what, cause) {
  try {
    mkdirSync(paths().logs, { recursive: true, mode: 0o700 });
    appendFileSync(join(paths().logs, 'hook.log'), `${new Date().toISOString()} ${what}: ${cause.stack ?? cause}\n`);
  } catch {
    // Said above.
  }
}

/**
 * One event from outside the process, JSON on stdin. It never throws and never
 * exits non-zero: memory is a convenience, and a convenience that can break the
 * session it serves is worse than none. Whatever goes wrong is written to
 * logs/hook.log and the session simply carries on without this contribution.
 */
export function runHook(event, stdin) {
  let db = null;
  try {
    const payload = JSON.parse(stdin || '{}');
    // The guard needs no database, and a database that cannot be opened must not stop it.
    const refused = event === 'pre-tool' ? earlyRefusal(fieldsOf(payload)) : '';
    if (refused) return deny(refused);
    db = openDb();
    return handleEvent(db, event, payload);
  } catch (cause) {
    logFailure(event, cause);
    return '';
  } finally {
    db?.close();
  }
}
