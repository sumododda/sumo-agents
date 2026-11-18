import { card } from './card.mjs';
import { getMeta, openDb, setMeta, tx } from './db.mjs';
import { backup } from './export.mjs';
import { guardCommand, guardPath } from './guard.mjs';
import { autoGuides, firingGuides, matchGuide, renderGuide } from './guides.mjs';
import { appendLog } from './logs.mjs';
import { expireUnusedGotchas, GOTCHA_UNUSED_DAYS } from './memory.mjs';
import { prime } from './prime.mjs';
import { detect, freshen, keepScratch, projectAt, touch } from './projects.mjs';
import { closingQuestions, recallBeforeAsking } from './recall.mjs';
import { line } from './render.mjs';
import { shouldRun, spawnDetached } from './scribe.mjs';
import { tidyDue } from './dream.mjs';
import { clearInjections, contextBand, contextNudge, contextUse, currentProject, endedThen, endSession, ensureSession, heardSession, injectedSlugs, markInjected, noteHeard, pruneStates, recordReply, recordTurn, replyText, turnText } from './sessions.mjs';
import { drainSpool, retrySetAside, spoolEvent } from './spool.mjs';
import { claim, renderWorkflow, withoutSumoCalls } from './workflows.mjs';

/**
 * The session policy, as events: a session starts, the user speaks, a tool is
 * about to run, a turn ends, the session ends. `sumo chat` raises them in
 * process; `sumo hook <event>` raises one from JSON on stdin, for anything else
 * that drives a session. Every handler returns what should be put in front of
 * the model — text, or a decision as JSON — and nothing else.
 */

const BACKUP_EVERY_MS = 7 * 24 * 3_600_000;

/** The one event shape. Field names are what the payload carries; a missing one is simply absent. */
function fieldsOf(p) {
  return {
    sessionId: p.session_id,
    cwd: p.cwd ?? null,
    transcriptPath: p.transcript_path ?? null,
    source: p.source ?? null,
    prompt: p.prompt ?? '',
    toolName: String(p.tool_name ?? '').toLowerCase(),
    command: p.tool_input?.command ?? '',
    question: p.tool_input?.question ?? '',
    path: p.tool_input?.path ?? p.tool_input?.file_path ?? '',
    agentId: p.agent_id ?? null,
    project: p.project ?? null,
    reply: p.last_assistant_message ?? '',
    contextTokens: Number.isFinite(p.context_tokens) ? p.context_tokens : null,
    stopHookActive: p.stop_hook_active === true,
    // A guide the user named by its command; the files the turn edited after a declared check last ran, and those checks.
    guide: p.guide ?? null,
    edited: Array.isArray(p.edited) ? p.edited.map(String) : [],
    checks: Array.isArray(p.checks) ? p.checks.map(String) : [],
  };
}

const deny = (reason) => JSON.stringify({ deny: reason });
const isRead = (tool) => tool === 'read' || tool === 'view';

/** The guard, first and without memory: a destructive command or a secret file is refused on sight. */
function earlyRefusal(e) {
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
  return contextNudge(band, focusOf(db, e.sessionId));
}

/**
 * The guide for the kind of work the message asks for, once per session — unless a taught workflow matched the
 * same message: the user's own way of doing the thing wins. One named by its command (`/fix`) goes in whatever
 * was shown before, and whatever the switch says: the user asked for it.
 */
function guideDue(db, e, now, taught) {
  const name = e.guide ?? (!taught && autoGuides() ? matchGuide(e.prompt) : null);
  if (!name || !firingGuides().some((g) => g.name === name)) return '';
  const slug = `guide:${name}`;
  if (!e.guide && db.prepare('SELECT 1 FROM session_injections WHERE session_id = ? AND slug = ?').get(e.sessionId, slug)) return '';
  markInjected(db, e.sessionId, slug, now);
  return renderGuide(name);
}

/**
 * An edit nothing has checked is not done, whatever the reply says. The chat says which files the turn edited after
 * the last of the project's declared checks ran, and which those checks are; the fact is put in front of the model
 * and the turn goes on. An edit made through the shell is not seen, and a harness that says nothing of edits is
 * left alone.
 */
function unchecked(db, e) {
  if (e.edited.length === 0 || !autoGuides()) return '';
  const first = e.edited.slice(0, 3);
  const rest = e.edited.length > 3 ? `${e.edited.length - 3} more` : first.length > 1 ? first.pop() : null;
  const shown = rest ? `${first.join(', ')} and ${rest}` : first[0];
  const were = e.edited.length === 1 ? 'was' : 'were';
  const them = e.edited.length === 1 ? 'it' : 'them';
  const next =
    e.checks.length > 0
      ? `nothing has checked ${them} since. The project's check is ${e.checks.map((c) => `\`${c}\``).join(' and ')} — run it and say what it showed, or say why it does not apply.`
      : 'nothing ran after. This project declares no check — run what proves the change (the reproduction, or the test you wrote), or say why nothing does.';
  return `<check>\nNot done yet: ${shown} ${were} edited and ${next}\n</check>`;
}

/** The memory pass as a session starts it by itself: finished conversations only, and nothing filed while filing is paused. */
const PASS = ['memory', 'run', '--auto'];

/** The ways a session starts with its context wiped: Claude Code's compact and clear, the chat's /new. */
const CARDS_GONE = new Set(['compact', 'clear', 'new']);

const HANDLERS = {
  'session-start'(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    // A fresh start wipes the cards from context; forgetting they were shown lets them come back. Claude Code names its
    // start startup, resume, clear or compact: a resume still holds the cards, a clear or a compaction does not.
    if (CARDS_GONE.has(e.source)) clearInjections(db, e.sessionId);

    // One memory pass: it reads the conversations that have finished since the last one, and tidies when a week has gone by.
    if (shouldRun(db, { now }) || tidyDue(db, now)) spawnDetached(PASS);

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
    try {
      keepScratch(db, now);
    } catch (cause) {
      // And this: scratch that cannot be made or tidied is said in the hook log; the session still gets its memory.
      logFailure('session-start scratch', cause);
    }
    try {
      // A trap nobody was ever shown, filed by an agent and never confirmed, lets go after a while; history keeps it.
      const expired = expireUnusedGotchas(db, now);
      if (expired > 0) appendLog('hook.log', `${now} session-start: ${expired} gotcha${expired === 1 ? '' : 's'} never shown in ${GOTCHA_UNUSED_DAYS} days let go (sumo history shows them)\n`);
    } catch (cause) {
      logFailure('session-start expire', cause);
    }

    // The questions put to the user are this session's: about everything, or the project it was started in.
    return prime(db, { now, project: currentProject(db, e.sessionId) ?? (e.cwd ? projectAt(db, e.cwd) : null) });
  },

  prompt(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    const turn = recordTurn(db, { sessionId: e.sessionId, text: e.prompt, now });
    if (turn === null) {
      noteHeard(db, e.harness, now);
      return '';
    }

    const shown = new Set(injectedSlugs(db, e.sessionId));
    const cards = [];
    // A session started inside a project, whose first words name none, is about that project: it is the one meant.
    const named = detect(db, e.prompt);
    const here = named.length === 0 && shown.size === 0 && e.cwd ? projectAt(db, e.cwd) : null;
    for (const slug of here ? [here] : named) {
      touch(db, slug, now);
      // Every mention is stamped, not only the first: the project named last is the one the session is about, also when its card was shown before.
      markInjected(db, e.sessionId, slug, now);
      if (shown.has(slug)) continue;
      // The card is built from the repository as it is now: a scan a week old, or older than a file it reads, is redone.
      try {
        freshen(db, slug, now);
      } catch (cause) {
        logFailure('prompt rescan', cause);
      }
      // Its questions come with it, unless the block this session started with asked them: a session started inside the project.
      cards.push(card(db, slug, { now, asks: slug !== (e.cwd ? projectAt(db, e.cwd) : null) }));
    }
    // The turn was stamped before its own words were read: one that names a project is about that project.
    if (here || named.length > 0) db.prepare('UPDATE user_turns SET project = ? WHERE id = ?').run(currentProject(db, e.sessionId), turn);

    const asked = claim(db, { sessionId: e.sessionId, text: e.prompt, scopes: scopesOf(db, e.sessionId), now });
    if (asked.length > 0) {
      cards.push(`The user taught a workflow for what they are asking — follow it exactly, in order:\n${asked.map(renderWorkflow).join('\n')}`);
    }
    const guide = guideDue(db, e, now, asked.length > 0);
    if (guide) cards.push(guide);

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
    // A question on its way to the user: what memory holds close to it is read first, and holds it back once.
    if (e.toolName === 'ask') {
      ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
      const known = recallBeforeAsking(db, { sessionId: e.sessionId, agentId: e.agentId, asked: e.question, now });
      return known.length > 0 ? deny(`Not asked yet: ${alreadyKnown(known)} If none does, ask again.`) : '';
    }
    if (e.toolName !== 'bash' || !e.command) return '';
    // Teaching or reading a workflow names its own cue; `sumo` must never be gated by what it manages — and nothing else rides through on it.
    const judged = withoutSumoCalls(e.command);
    if (!judged) return '';
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });

    const due = claim(db, { sessionId: e.sessionId, agentId: e.agentId, text: judged, scopes: [...scopesOf(db, e.sessionId), ...(e.project ? [`project:${e.project}`] : [])], forCommand: true, now });
    if (due.length === 0) return '';
    return deny(
      `Not yet. The user taught a workflow for exactly this, and it has not been followed in this session:\n${due.map(renderWorkflow).join('\n')}\n` +
        'Do its steps in order — some come before this command — then run the command again.',
    );
  },

  stop(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    // The journal first: what the assistant ended the turn on, whether or not a gate then sends the turn on.
    if (e.reply) recordReply(db, { sessionId: e.sessionId, text: e.reply, now });

    // The other gates: a turn that ends on an edit nothing checked, or by asking the user something memory may
    // already hold. Already continuing because of one → whatever the turn ends on now goes to the user.
    if (e.stopHookActive) return '';
    const known = e.reply ? recallBeforeAsking(db, { sessionId: e.sessionId, asked: closingQuestions(e.reply), now }) : [];
    const held = [unchecked(db, e), known.length > 0 ? `Before the user answers that: ${alreadyKnown(known)} If none does, the question stands — say so in one line.` : ''].filter(Boolean);
    return held.length > 0 ? JSON.stringify({ context: held.join('\n') }) : '';
  },

  'session-end'(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    endSession(db, e.sessionId, now);
    // The conversation is over: it is read for memory now, once.
    if (shouldRun(db, { now })) spawnDetached(PASS);
    return '';
  },
};

/**
 * One event, in process: the guard first, then the handler. Throws only for an unknown event or a payload with no
 * session. `harness` is who drives the session — sumo's own chat and jobs unless said; `runHook` says 'claude' — and
 * is written on a session's row when it is first heard of. Events an earlier hook could not write are replayed first.
 */
export function handleEvent(db, event, payload, now = new Date().toISOString(), { harness = 'sumo' } = {}) {
  const handler = HANDLERS[event];
  if (!handler) throw new Error(`no handler for ${event}`);
  const e = { ...fieldsOf(payload), harness };
  if (!e.sessionId) throw new Error('the event had no session id');
  const refused = event === 'pre-tool' ? earlyRefusal(e) : '';
  if (refused) return deny(refused);
  drain(db);
  return handler(db, e, now);
}

/** The events with something for the journal: a session's row, a turn, a reply, a goodbye. A tool about to run has nothing. */
const JOURNALED = new Set(['session-start', 'prompt', 'stop', 'session-end']);
/** The harness `sumo hook` is wired into. */
const HOOKED = 'claude';

/**
 * An event that could not be written, kept in the spool for the next one that gets through: only what the journal
 * needs — who, when, where, and the words, redacted and cut as the journal would keep them. Never the tool's input, the
 * gates or the cards: those were for the moment that has passed. A slash command or a turn that ended on nothing has
 * nothing to keep.
 */
function keepForLater(event, payload, at) {
  const e = fieldsOf(payload);
  if (!JOURNALED.has(event) || !e.sessionId) return;
  const said = event === 'prompt' ? turnText(e.prompt) : event === 'stop' ? replyText(e.reply) : null;
  if ((event === 'prompt' || event === 'stop') && !said) return;
  const text = (value) => (typeof value === 'string' ? value : null);
  spoolEvent({ v: 1, at, event, harness: HOOKED, session_id: String(e.sessionId), cwd: text(e.cwd), transcript_path: text(e.transcriptPath), ...(said ? { text: said.text, full_len: said.fullLen, redacted: said.redacted } : {}) });
}

/** A line of the spool that is not an event: no later try would make it one, so it is set aside at once. */
function notAnEvent(why) {
  return Object.assign(new Error(why), { bad: true });
}

/**
 * One spooled event written into the journal with the time it happened: the session's row, and the turn, the reply or
 * the goodbye. Nothing else an event does is done again — no card, no gate, no memory pass woken, no backup.
 */
function replay(db, line) {
  if (line.v !== 1 || !JOURNALED.has(line.event)) throw notAnEvent('not an event this version replays');
  if (typeof line.session_id !== 'string' || !line.session_id) throw notAnEvent('no session id');
  const happened = typeof line.at === 'string' ? Date.parse(line.at) : NaN;
  if (Number.isNaN(happened)) throw notAnEvent('no time it happened');
  const at = new Date(happened).toISOString();
  const text = (value) => (typeof value === 'string' ? value : null);
  const kept = { text: line.text, fullLen: line.full_len, redacted: line.redacted };
  if ((line.event === 'prompt' || line.event === 'stop') && typeof line.text !== 'string') throw notAnEvent('no words');
  heardSession(db, { id: line.session_id, harness: text(line.harness) ?? HOOKED, cwd: text(line.cwd), transcriptPath: text(line.transcript_path), now: at });
  if (line.event === 'prompt') recordTurn(db, { sessionId: line.session_id, now: at, kept });
  if (line.event === 'stop') recordReply(db, { sessionId: line.session_id, now: at, kept });
  if (line.event === 'session-end') endedThen(db, line.session_id, at);
}

/** What waits in the spool, into the journal, before the event in hand. It never stops that event: what went wrong is logged, and the lines wait on. */
function drain(db) {
  try {
    const done = drainSpool((line) => replay(db, line), { within: (fn) => tx(db, fn) });
    if (!done) return;
    const parts = [`${done.replayed} replayed`, done.retried > 0 ? `${done.retried} to try again` : '', done.bad > 0 ? `${done.bad} set aside in spool/events.bad.jsonl (sumo memory check counts them)` : ''].filter(Boolean);
    appendLog('hook.log', `${new Date().toISOString()} spool: ${parts.join(', ')}\n`);
  } catch (cause) {
    logFailure('spool', cause);
  }
}

/** The lines set aside in the spool tried again, for `sumo memory check --fix`: `{ replayed, left }`. */
export const replaySetAside = (db) => retrySetAside((line) => replay(db, line), { within: (fn) => tx(db, fn) });

/** What went wrong, in logs/hook.log. If even the log cannot be written there is nothing left to do but stay out of the way. */
function logFailure(what, cause) {
  try {
    appendLog('hook.log', `${new Date().toISOString()} ${what}: ${cause.stack ?? cause}\n`);
  } catch {
    // Said above.
  }
}

/**
 * One event from outside the process, JSON on stdin. It never throws and never
 * exits non-zero: memory is a convenience, and a convenience that can break the
 * session it serves is worse than none. Whatever goes wrong is written to
 * logs/hook.log and the session simply carries on without this contribution —
 * but what was said is not lost with it: an event the database could not take,
 * or a handler broke on, waits in the spool for the next one that gets through.
 */
export function runHook(event, stdin) {
  let db = null;
  let payload = null;
  const now = new Date().toISOString();
  try {
    payload = JSON.parse(stdin || '{}');
    // The guard needs no database, and a database that cannot be opened must not stop it.
    const refused = event === 'pre-tool' ? earlyRefusal(fieldsOf(payload)) : '';
    if (refused) return deny(refused);
    db = openDb();
    return handleEvent(db, event, payload, now, { harness: HOOKED });
  } catch (cause) {
    logFailure(event, cause);
    try {
      if (payload && typeof payload === 'object') keepForLater(event, payload, now);
    } catch (unkept) {
      logFailure(`${event} spool`, unkept);
    }
    return '';
  } finally {
    try {
      db?.close();
    } catch (cause) {
      logFailure(`${event} close`, cause);
    }
  }
}
