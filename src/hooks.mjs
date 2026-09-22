import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { card } from './card.mjs';
import { getMeta, openDb } from './db.mjs';
import { backup } from './export.mjs';
import { guardCommand, guardPath } from './guard.mjs';
import { agentType } from './jobs.mjs';
import { paths } from './paths.mjs';
import { prime } from './prime.mjs';
import { detect, touch } from './projects.mjs';
import { closingQuestions, recallBeforeAsking } from './recall.mjs';
import { line } from './render.mjs';
import { shouldRun, spawnDetached } from './scribe.mjs';
import { clearInjections, contextBand, contextNudge, contextUse, currentProject, endSession, ensureSession, injectedSlugs, markInjected, recordTurn, sessionsAwaitingDream } from './sessions.mjs';
import { claim, renderWorkflow } from './workflows.mjs';

const BACKUP_EVERY_MS = 7 * 24 * 3_600_000;
const SESSIONS_TO_DREAM = 3;

/** Each harness names its hook fields differently; this is the one place that knows Claude Code's. */
const READERS = {
  claude: (p) => ({
    sessionId: p.session_id,
    cwd: p.cwd ?? null,
    transcriptPath: p.transcript_path ?? null,
    source: p.source ?? null,
    // UserPromptSubmit carries it at the top level; an Agent tool call carries it in tool_input instead.
    prompt: p.prompt ?? p.tool_input?.prompt ?? '',
    toolName: p.tool_name ?? null,
    toolInput: p.tool_input ?? {},
    command: p.tool_input?.command ?? '',
    path: p.tool_input?.file_path ?? '',
    subagentType: p.tool_input?.subagent_type ?? null,
    model: p.tool_input?.model ?? null,
    agentId: p.agent_id ?? null,
    questions: Array.isArray(p.tool_input?.questions) ? p.tool_input.questions.map((q) => q?.question ?? '') : [],
    reply: p.last_assistant_message ?? '',
    stopHookActive: p.stop_hook_active === true,
  }),
};

const refuse = (reason) => JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } });

/** The guard, first and without memory: a destructive command or a secret file is refused on sight. */
const EARLY = {
  'pre-tool'(e) {
    if (e.toolName === 'Bash' && e.command) return guardCommand(e.command) ?? '';
    if (e.toolName === 'Read' && e.path) return guardPath(e.path) ?? '';
    return '';
  },
};

const alreadyKnown = (known) => `memory already holds\n${known.map(line).join('\n')}\nIf one of these answers your question, act on it instead of asking.`;

/** Global workflows always apply; a project's apply once that project has come up in the session. */
const scopesOf = (db, sessionId) => ['global', ...injectedSlugs(db, sessionId).map((slug) => `project:${slug}`)];

/** Appends one line to a job's route.log: requested vs. applied, so a mismatch can be seen. */
function logRoute(id, requested, applied, now) {
  try {
    const dir = join(paths().jobs, String(id));
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    appendFileSync(join(dir, 'route.log'), `${now} requested=${requested.model ?? '-'}/${requested.subagentType ?? '-'} applied=${applied.model}/${applied.subagentType}\n`, { mode: 0o600 });
  } catch {
    // Best effort: a route that cannot be logged is still enforced.
  }
}

/**
 * Enforces the route `mem job new` chose: an Agent call that starts a job (its prompt names
 * `mem job brief <id>`) has its model and sub-agent rewritten to that job's recorded route. A job
 * with no recorded route (created before this existed) is left untouched, and so is any Agent call
 * that does not name a job at all.
 */
function routeAgent(db, e, now) {
  const match = /mem job brief (\d+)/.exec(e.prompt);
  if (!match) return '';
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(Number(match[1]));
  if (!job?.model || !job?.effort) return '';
  const applied = { model: job.model, subagentType: agentType(job) };
  logRoute(job.id, { model: e.model, subagentType: e.subagentType }, applied, now);
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      updatedInput: { ...e.toolInput, model: applied.model, subagent_type: applied.subagentType },
    },
  });
}

/** What a compaction should be told to keep: the job in hand if there is one, otherwise the project the session is about. */
function focusOf(db, sessionId) {
  const job = db.prepare(`SELECT title FROM jobs WHERE status IN ('running', 'needs_input') ORDER BY id DESC LIMIT 1`).get();
  return job?.title ?? currentProject(db, sessionId) ?? 'the work in hand';
}

/**
 * How big this session has got. Said once per band — remembered the same way a
 * card that has been shown is remembered, so a compaction (which clears those)
 * lets it be said again, which is right: the context really did shrink.
 */
function sizeNudge(db, e, now) {
  const use = contextUse(e.transcriptPath);
  const band = use && contextBand(use.tokens);
  if (!band) return '';
  const slug = `context:${band}`;
  if (db.prepare('SELECT 1 FROM session_injections WHERE session_id = ? AND slug = ?').get(e.sessionId, slug)) return '';
  markInjected(db, e.sessionId, slug, now);
  return contextNudge(band, use.tokens, focusOf(db, e.sessionId));
}

/** The other gate, at its second door: a question on its way to the user through the question tool. */
function holdQuestion(db, e, now) {
  ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
  const known = recallBeforeAsking(db, { sessionId: e.sessionId, agentId: e.agentId, asked: e.questions.join(' '), now });
  if (known.length === 0) return '';
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: `Not yet: ${alreadyKnown(known)} If none does, ask again.` },
  });
}

const HANDLERS = {
  'session-start'(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    // A compaction wipes the cards from context; forgetting they were shown lets them come back.
    if (e.source === 'compact') clearInjections(db, e.sessionId);

    if (shouldRun(db, { event: 'session-start', now })) spawnDetached(['scribe', 'run']);
    if (sessionsAwaitingDream(db, now, SESSIONS_TO_DREAM).length >= SESSIONS_TO_DREAM) spawnDetached(['dream', 'run']);

    const last = getMeta(db, 'last_backup');
    if (!last || Date.parse(now) - Date.parse(last) > BACKUP_EVERY_MS) backup(db, new Date(now));

    return prime(db, { now });
  },

  prompt(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    if (recordTurn(db, { sessionId: e.sessionId, text: e.prompt, now }) === null) return '';

    const shown = new Set(injectedSlugs(db, e.sessionId));
    const cards = [];
    for (const slug of detect(db, e.prompt)) {
      touch(db, slug, now);
      if (shown.has(slug)) continue;
      markInjected(db, e.sessionId, slug, now);
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
    if (e.toolName === 'AskUserQuestion') return holdQuestion(db, e, now);
    if (e.toolName === 'Agent') return routeAgent(db, e, now);
    if (e.toolName !== 'Bash' || !e.command) return '';
    // Teaching or reading a workflow names its own cue; `mem` must never be gated by what it manages.
    if (/(^|[;&|]\s*)(\S*\/)?mem\s/.test(e.command)) return '';
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });

    const due = claim(db, { sessionId: e.sessionId, agentId: e.agentId, text: e.command, scopes: scopesOf(db, e.sessionId), forCommand: true, now });
    if (due.length === 0) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'deny',
        permissionDecisionReason:
          `Not yet. The user taught a workflow for exactly this, and it has not been followed in this session:\n${due.map(renderWorkflow).join('\n')}\n` +
          'Do its steps in order — some come before this command — then run the command again.',
      },
    });
  },

  stop(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    if (shouldRun(db, { event: 'stop', now })) spawnDetached(['scribe', 'run']);

    // The other gate: a turn that ends by asking the user something memory may already hold.
    // Already continuing because of it → whatever the turn ends on now goes to the user.
    if (e.stopHookActive || !e.reply) return '';
    const known = recallBeforeAsking(db, { sessionId: e.sessionId, asked: closingQuestions(e.reply), now });
    if (known.length === 0) return '';
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'Stop',
        additionalContext: `Before the user answers that: ${alreadyKnown(known)} If none does, the question stands — say so in one line.`,
      },
    });
  },

  'session-end'(db, e, now) {
    ensureSession(db, { id: e.sessionId, harness: e.harness, cwd: e.cwd, transcriptPath: e.transcriptPath, now });
    endSession(db, e.sessionId, now);
    if (shouldRun(db, { event: 'session-end', now })) spawnDetached(['scribe', 'run']);
    return '';
  },
};

/**
 * Runs one hook and returns what should be printed into the session.
 *
 * It never throws and never exits non-zero: memory is a convenience, and a
 * convenience that can break the session it serves is worse than none. Whatever
 * goes wrong is written to logs/hook.log and the session simply carries on
 * without this hook's contribution.
 */
export function runHook(event, harness, stdin) {
  // The cheap-model call is itself a Claude Code run; without this its prompt
  // would be recorded as something the user said and would trigger another call.
  if (process.env.SUMO_AGENTS_SCRIBE === '1') return '';
  let db = null;
  try {
    const handler = HANDLERS[event];
    const reader = READERS[harness];
    if (!handler || !reader) throw new Error(`no handler for ${harness} ${event}`);
    const fields = reader(JSON.parse(stdin || '{}'));
    if (!fields.sessionId) throw new Error('the hook payload had no session id');
    const refused = EARLY[event]?.(fields);
    if (refused) return refuse(refused);
    db = openDb();
    return handler(db, { ...fields, harness }, new Date().toISOString());
  } catch (cause) {
    try {
      mkdirSync(paths().logs, { recursive: true, mode: 0o700 });
      appendFileSync(join(paths().logs, 'hook.log'), `${new Date().toISOString()} ${harness} ${event}: ${cause.stack ?? cause}\n`);
    } catch {
      // If even the log cannot be written there is nothing left to do but stay out of the way.
    }
    return '';
  } finally {
    db?.close();
  }
}
