import { search } from './memory.mjs';
import { currentProject, markInjected } from './sessions.mjs';

/**
 * "Search memory before asking the user" was a line in the instructions, and an
 * agent asked anyway: given a task, it ended its turn on a question with memory
 * unread, and searched only once the user told it to. Same lesson as the
 * workflow gate — a line in a prompt is a request — so the search now happens
 * by itself, at the
 * two moments it matters: a turn about to end on a question, and a question
 * about to go out through the question tool. Plain code, no model, and no
 * tokens unless memory has something close to what was asked.
 */

/** A turn is handed to the user by its last lines; a "?" further up was thinking aloud. */
const CLOSING_CHARS = 300;
/** Nobody chose a question's words for searching: one in common with a memory is an accident, two are not. */
const MIN_SHARED_WORDS = 2;

// A sub-agent has its own context: a memory handed to the main agent was never handed to it.
const key = (memory, agentId) => `recall:m${memory.id}${agentId ? `@${agentId}` : ''}`;

export function closingQuestions(reply) {
  return (reply.slice(-CLOSING_CHARS).match(/[^.!?\n]*\?/g) ?? []).join(' ');
}

/**
 * Memories close to the question `asked`, in the session's scope, that this
 * agent has not been handed yet in this session. Marks them as handed over: a
 * memory holds a question back once, and asking again after that is an informed choice.
 */
export function recallBeforeAsking(db, { sessionId, agentId = null, asked, now }) {
  if (!/[\p{L}\p{N}]/u.test(asked)) return [];

  const { results } = search(db, asked, { project: currentProject(db, sessionId), minShared: MIN_SHARED_WORDS, now });
  const handed = new Set(db.prepare(`SELECT slug FROM session_injections WHERE session_id = ? AND slug LIKE 'recall:%'`).all(sessionId).map((r) => r.slug));
  const fresh = results.filter((m) => !handed.has(key(m, agentId)));
  for (const m of fresh) markInjected(db, sessionId, key(m, agentId), now);
  return fresh;
}
