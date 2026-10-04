import { createContext, Script } from 'node:vm';
import { head, stem, words } from './text.mjs';

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

const escaped = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * What is left of a shell command once its calls to `sumo` are taken out. Teaching or reading a workflow names
 * its own cue, so `sumo` is never held back by what it manages — but only `sumo` is let through: in
 * `sumo help; gh pr create` the second command is still judged. The command is cut where the shell would start
 * another one (; | & and a new line), outside quotes; a heredoc stays with the call that opens it.
 */
export function withoutSumoCalls(command) {
  const parts = [];
  let part = '';
  let quote = null;
  let heredocs = [];
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      part += ch;
      if (ch === '\\' && quote === '"') part += command[++i] ?? '';
      else if (ch === quote) quote = null;
    } else if (ch === '\\') {
      part += ch + (command[++i] ?? '');
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      part += ch;
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<' && /^<<-?\s*\\?['"]?[\w.-]/.test(command.slice(i, i + 12))) {
      const [opener, , end] = /^<<-?\s*\\?(['"]?)([\w.-]+)\1/.exec(command.slice(i));
      heredocs.push(end);
      part += opener;
      i += opener.length - 1;
    } else if (ch === '\n' && heredocs.length > 0) {
      // Each body runs to a line that is its delimiter alone, and belongs to the call that opened it.
      let at = i;
      for (const end of heredocs) {
        const rest = command.slice(at + 1);
        const close = new RegExp(`^[\\t ]*${escaped(end)}[\\t ]*$`, 'm').exec(rest);
        const last = at + (close ? close.index + close[0].length : rest.length);
        part += command.slice(at, last + 1);
        at = last + 1;
        if (at >= command.length) break;
      }
      heredocs = [];
      i = at - 1;
    } else if (ch === ';' || ch === '|' || ch === '\n' || (ch === '&' && !'<>'.includes(command[i - 1] ?? '') && command[i + 1] !== '>')) {
      parts.push(part);
      part = '';
    } else {
      part += ch;
    }
  }
  parts.push(part);
  return parts.filter((p) => p.trim() && !/^\s*(\S*\/)?sumo(\s|$)/.test(p)).join('\n');
}

/** How long one pattern may take over one command. A regular expression can take minutes over forty characters; a turn must not wait for it. */
const MATCH_MS = 50;
const matcher = createContext({});
const matching = new Script('pattern.test(text)');

/** Whether the pattern matches the text: true, false, or null when it ran out of time. */
export function matchWithin(pattern, text, ms = MATCH_MS) {
  matcher.pattern = pattern;
  matcher.text = text;
  try {
    return matching.runInContext(matcher, { timeout: ms });
  } catch {
    return null;
  }
}

function gateMatches(gate, command) {
  try {
    // A gate that runs out of time, like one that cannot be read, holds nothing back.
    return matchWithin(new RegExp(gate, 'i'), command) === true;
  } catch {
    return false; // checked when it was saved; if it is somehow bad, a gate that cannot be read holds nothing back
  }
}

export function renderWorkflow(w) {
  const body = w.body.length > BODY_MAX ? `${head(w.body, BODY_MAX)}\n… (the rest: sumo show m${w.id})` : w.body;
  return `<workflow m${w.id} "${w.title}">\n${body}\n</workflow>`;
}
