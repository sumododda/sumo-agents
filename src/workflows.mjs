import { stem, words } from './text.mjs';

/**
 * A taught workflow is worth nothing if it is only remembered when someone
 * thinks to look. These are the two moments it has to show up by itself, both
 * decided by plain word matching — no model, no tokens until one fires:
 *
 *   the user asks for the thing       → the steps ride in with their message
 *   the agent is about to do the thing → the command is held back until the
 *                                        steps are in front of it
 *
 * A workflow says which commands it comes before in one of two ways. Stated: a
 * `gate`, a regular expression written when the workflow was taught — precise,
 * and the only thing consulted when present. Guessed: failing that, every word
 * of its cue turning up in the command — crude, so it needs two words to count.
 *
 * The second moment exists because of a real failure: an agent that had been
 * taught "before creating a PR, do X and Y" committed, pushed and reached for
 * `pr create` deep in a long task, with the workflow listed at the top of its
 * context the whole time. A line in a prompt is a request. A gate is not.
 */

const BODY_MAX = 3000;
/** One word ("ship") turns up in commands by accident; two ("create", "pr") do not. */
const MIN_WORDS_TO_GATE_A_COMMAND = 2;

/** "PR" and "pull request" are one thing said two ways, and either may be in the cue or the message. */
const stemsOf = (text) => new Set(words(text.replace(/pull[\s-]+requests?/gi, 'pr')).map(stem));

/** The words that mean "this workflow": its cue, or its title when it has none. */
function triggerStems(workflow) {
  return [...stemsOf(workflow.cue || workflow.title)];
}

function key(workflow, agentId) {
  // A sub-agent has its own context: steps shown to the main agent were never shown to it.
  return `workflow:m${workflow.id}${agentId ? `@${agentId}` : ''}`;
}

/**
 * Active workflows in scope whose trigger words all appear in `text`, and whose
 * steps this agent has not been given yet in this session. Marks them as given.
 */
export function claim(db, { sessionId, agentId = null, text, scopes, forCommand = false, now }) {
  const have = stemsOf(text);
  const given = new Set(db.prepare('SELECT slug FROM session_injections WHERE session_id = ?').all(sessionId).map((r) => r.slug));
  const rows = db
    .prepare(`SELECT * FROM memories WHERE type = 'procedure' AND state = 'active' AND scope IN (${scopes.map(() => '?').join(', ')}) ORDER BY id`)
    .all(...scopes);

  const found = rows.filter((w) => !given.has(key(w, agentId)) && (forCommand && w.gate ? gateMatches(w.gate, text) : cueMatches(w, have, forCommand)));

  for (const w of found) {
    db.prepare('INSERT OR REPLACE INTO session_injections (session_id, slug, ts) VALUES (?, ?, ?)').run(sessionId, key(w, agentId), now);
    db.prepare('UPDATE memories SET hits = hits + 1, last_hit_at = ? WHERE id = ?').run(now, w.id);
  }
  return found;
}

function cueMatches(workflow, have, forCommand) {
  const need = triggerStems(workflow);
  return need.length >= (forCommand ? MIN_WORDS_TO_GATE_A_COMMAND : 1) && need.every((s) => have.has(s));
}

function gateMatches(gate, command) {
  try {
    return new RegExp(gate, 'i').test(command);
  } catch {
    return false; // checked when it was saved; if it is somehow bad, a gate that cannot be read holds nothing back
  }
}

export function renderWorkflow(w) {
  const body = w.body.length > BODY_MAX ? `${w.body.slice(0, BODY_MAX)}\n… (the rest: mem show m${w.id})` : w.body;
  return `<workflow m${w.id} "${w.title}">\n${body}\n</workflow>`;
}
