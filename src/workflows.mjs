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

/** Where an unquoted word ends for the shell. */
const WORD_END = /[\s;|&<>()]/;
const SUMO_CALL = /^\s*(\S*\/)?sumo(\s|$)/;

/**
 * The delimiter a heredoc opener names: the word after `<<` or `<<-` with its quotes removed, as the shell reads it,
 * so `E"O"F`, `E\OF` and `"EOF"x` mean EOF, EOF and EOFx. null when there is no word, or a quote in it never closes
 * on the line — then the opener is no heredoc, and its characters are read as any others.
 */
function heredocOpener(command, at) {
  let i = at + /^<<-?[\t ]*/.exec(command.slice(at))[0].length;
  let delimiter = '';
  while (i < command.length && !WORD_END.test(command[i])) {
    const ch = command[i];
    if (ch === "'" || ch === '"') {
      const close = command.indexOf(ch, i + 1);
      if (close === -1 || command.slice(i, close).includes('\n')) return null;
      delimiter += command.slice(i + 1, close);
      i = close + 1;
    } else if (ch === '\\') {
      delimiter += command[i + 1] ?? '';
      i += 2;
    } else {
      delimiter += ch;
      i++;
    }
  }
  return delimiter ? { delimiter, length: i - at } : null;
}

/**
 * The span of the substitution or arithmetic opening at `at` (`$(`, `((` or a backtick): where it ends — a quote
 * inside it is skipped, so a `)` in one does not close it — and, for a command substitution, the command inside.
 */
function substitution(command, at) {
  if (command[at] === '`') {
    let j = at + 1;
    for (; j < command.length && command[j] !== '`'; j++) if (command[j] === '\\') j++;
    return { end: Math.min(j, command.length - 1), inner: command.slice(at + 1, j) };
  }
  const arithmetic = command.startsWith('$((', at) || command.startsWith('((', at);
  const open = command.indexOf('(', at);
  let depth = 0;
  let quote = null;
  let j = open;
  for (; j < command.length; j++) {
    const ch = command[j];
    if (quote) {
      if (ch === '\\' && quote === '"') j++;
      else if (ch === quote) quote = null;
    } else if (ch === "'" || ch === '"') quote = ch;
    else if (ch === '\\') j++;
    else if (ch === '(') depth++;
    else if (ch === ')' && --depth === 0) break;
  }
  const end = Math.min(j, command.length - 1);
  return { end, inner: arithmetic ? null : command.slice(open + 1, end) };
}

/**
 * What is left of a shell command once its calls to `sumo` are taken out. Teaching or reading a workflow names
 * its own cue, so `sumo` is never held back by what it manages — but only `sumo` is let through: in
 * `sumo help; gh pr create` the second command is still judged. The command is cut where the shell would start
 * another one (; | & and a new line), outside quotes; a heredoc stays with the call that opens it. What a sumo
 * call substitutes in (`$(…)` or backticks, inside double quotes too) is run by the shell, so it is judged on its
 * own; what the call merely quotes is not.
 */
export function withoutSumoCalls(command) {
  const parts = [];
  let part = '';
  let subs = [];
  let quote = null; // "'", '"', or "$'" — ANSI-C quoting, where a backslash escapes the quote
  let heredocs = [];
  let opened = null;
  const flush = () => {
    parts.push({ text: part, subs });
    part = '';
    subs = [];
  };
  const takeSubstitution = (i) => {
    const { end, inner } = substitution(command, i);
    if (inner !== null) subs.push(inner);
    part += command.slice(i, end + 1);
    return end;
  };
  for (let i = 0; i < command.length; i++) {
    const ch = command[i];
    if (quote) {
      if (quote === '"' && (command.startsWith('$(', i) || ch === '`')) {
        i = takeSubstitution(i); // still run by the shell inside double quotes
      } else {
        part += ch;
        if (ch === '\\' && quote !== "'") part += command[++i] ?? '';
        else if (ch === quote.at(-1)) quote = null;
      }
    } else if (ch === '\\') {
      part += ch + (command[++i] ?? '');
    } else if (command.startsWith("$'", i)) {
      quote = "$'";
      part += "$'";
      i++;
    } else if (ch === "'" || ch === '"') {
      quote = ch;
      part += ch;
    } else if (command.startsWith('$(', i) || command.startsWith('((', i) || ch === '`') {
      // A substitution or arithmetic: a `<<` inside is a shift, or the substitution's own, never this command's heredoc.
      i = takeSubstitution(i);
    } else if (command.startsWith('$[', i)) {
      // The old spelling of arithmetic: opaque to its closing bracket.
      const close = command.indexOf(']', i + 1);
      const end = close === -1 ? command.length - 1 : close;
      part += command.slice(i, end + 1);
      i = end;
    } else if (ch === '#' && (i === 0 || /[\s;&|(]/.test(command[i - 1]))) {
      // A comment runs to the end of its line, and a `<<` in it opens nothing; the line's end is still read below.
      const close = command.indexOf('\n', i);
      const end = close === -1 ? command.length : close;
      part += command.slice(i, end);
      i = end - 1;
    } else if (ch === '<' && command[i + 1] === '<' && command[i + 2] !== '<' && command[i - 1] !== '<' && (opened = heredocOpener(command, i))) {
      heredocs.push(opened.delimiter);
      part += command.slice(i, i + opened.length);
      i += opened.length - 1;
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
      flush();
    } else {
      part += ch;
    }
  }
  flush();
  // A sumo call is judged only by what it runs: the commands it substitutes in, which may hold sumo calls of their own.
  return parts
    .flatMap((p) => (SUMO_CALL.test(p.text) ? p.subs.map(withoutSumoCalls) : [p.text]))
    .filter((text) => text.trim())
    .join('\n');
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
