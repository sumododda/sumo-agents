import { markHits } from './memory.mjs';
import { aliasesOf, getProject, isScratch, scratchRules } from './projects.mjs';
import { clip, estimateTokens } from './text.mjs';

const CARD_BUDGET_TOKENS = 200;
const LINE_MAX = 110;

/** Lower number = kept first when the card has to shrink. Scanned facts are ranked by their key. */
const SCAN_PRIORITY = { instructions: 1, stack: 2, commands: 3, index: 7, workspaces: 9, gaps: 9, ci: 10, about: 11 };
const PRIORITY = { rule: 4, last: 5, gotcha: 6, workflow: 6, fact: 8 };

export function ago(iso, now) {
  const hours = (Date.parse(now) - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/** How long a guess is put to the user; after that it waits on the memory page and in search. */
const GUESS_ASKED_DAYS = 14;
const ASK_LINE_MAX = 120;

/**
 * What to put to the user about these scopes: guesses newer than two weeks, and notices whose two memories both
 * still stand — superseding or forgetting either settles one. The session-start block asks about everything and the
 * session's own project; a project's card asks about that project, wherever the session was started.
 */
export function askLines(db, { scopes, now, guesses: maxGuesses, notices: maxNotices }) {
  const marks = scopes.map(() => '?').join(', ');
  const since = new Date(Date.parse(now) - GUESS_ASKED_DAYS * 86_400_000).toISOString();
  const guesses = db.prepare(`SELECT * FROM memories WHERE state = 'unconfirmed' AND scope IN (${marks}) AND created_at >= ? ORDER BY id LIMIT ?`).all(...scopes, since, maxGuesses);
  const out = guesses.map((m) => `Ask the user (then sumo confirm|reject m${m.id}): is this right? "${clip(m.type === 'procedure' ? `workflow "${m.title}"` : m.body, ASK_LINE_MAX)}"`);
  const notices = db
    .prepare(
      `SELECT n.* FROM notices n
       JOIN memories a ON a.id = n.memory_a AND a.state = 'active' AND a.scope IN (${marks})
       JOIN memories b ON b.id = n.memory_b AND b.state = 'active' AND b.scope IN (${marks})
       ORDER BY n.id LIMIT ?`,
    )
    .all(...scopes, ...scopes, maxNotices);
  for (const n of notices) {
    const verb = n.kind === 'lookalike' ? 'look alike' : 'disagree';
    out.push(`Ask the user: m${n.memory_a} and m${n.memory_b} ${verb} — ${clip(n.note, ASK_LINE_MAX)} (sumo show both; settle with sumo supersede or sumo forget)`);
  }
  return out;
}

/** The most a card asks: room is kept for what the project is. */
const CARD_GUESSES = 2;
const CARD_NOTICES = 1;

/**
 * What an agent needs the moment a project comes up, under a hard budget.
 * To fit, whole lines are left out — and counted, so the card says how much it
 * is not showing. A single over-long line is clipped with a visible ellipsis;
 * `sumo show <id>` has the rest.
 */
export function card(db, nameOrAlias, { budget = CARD_BUDGET_TOKENS, now = new Date().toISOString(), asks = false } = {}) {
  const project = getProject(db, nameOrAlias);
  // Scratch has no memory to show: its card is how it is used.
  if (isScratch(project)) return [`<project ${project.slug}> ${project.path}`, ...scratchRules(), '</project>'].join('\n');
  const scope = `project:${project.slug}`;
  const rows = db
    .prepare(`SELECT * FROM memories WHERE scope = ? AND state = 'active' ORDER BY pinned DESC, importance DESC, hits DESC, id DESC`)
    .all(scope);

  const candidates = [];
  let order = 0;
  // A line that is a memory carries its id, so what the card shows can be counted as used.
  const offer = (priority, text, id = null) => candidates.push({ priority, order: order++, text: clip(text, LINE_MAX), id });

  // Asked of the user, so only where the user is: first, and whole — clipped, a question would lose what it asks.
  // A job's brief and `sumo project show` leave them out.
  if (asks) for (const text of askLines(db, { scopes: [scope], now, guesses: CARD_GUESSES, notices: CARD_NOTICES })) candidates.push({ priority: 0, order: order++, text, id: null });

  for (const m of rows.filter((r) => r.scan_key)) offer(SCAN_PRIORITY[m.scan_key] ?? 11, m.body, m.id);
  for (const m of rows.filter((r) => !r.scan_key && (r.type === 'preference' || r.type === 'decision'))) offer(PRIORITY.rule, `rule m${m.id}: ${m.body}`, m.id);

  const last = db.prepare('SELECT * FROM checkpoints WHERE project = ? ORDER BY ts DESC, id DESC LIMIT 1').get(project.slug);
  if (last) offer(PRIORITY.last, `last (${ago(last.ts, now)}): ${last.done}${last.next_step ? ` → next: ${last.next_step}` : ''}`);

  for (const m of rows.filter((r) => r.type === 'gotcha')) offer(PRIORITY.gotcha, `gotcha m${m.id}: ${m.body}`, m.id);
  for (const m of rows.filter((r) => r.type === 'procedure')) offer(PRIORITY.workflow, `workflow m${m.id}: "${m.title}"${m.cue ? ` (when: ${m.cue})` : ''} — follow it: sumo show m${m.id}`, m.id);
  for (const m of rows.filter((r) => !r.scan_key && r.type === 'fact')) offer(PRIORITY.fact, `fact m${m.id}: ${m.body}`, m.id);

  const aliases = aliasesOf(db, project.slug);
  const header = `<project ${project.slug}${project.status === 'archived' ? ' (archived)' : ''}> ${project.path}${aliases.length ? ` · also called: ${aliases.join(', ')}` : ''}`;
  const footer = '</project>';
  const more = (n) => `(+${n} more — sumo search "<topic>" --project ${project.slug})`;

  let used = estimateTokens(`${header}\n${footer}`);
  const kept = [];
  const byPriority = [...candidates].sort((a, b) => a.priority - b.priority || a.order - b.order);
  // Reserve room for the "+N more" line up front, so adding it can never push the card over.
  const reserve = estimateTokens(more(99)) + 1;
  for (const line of byPriority) {
    const cost = estimateTokens(line.text) + 1;
    if (used + cost > budget - reserve) continue;
    used += cost;
    kept.push(line);
  }

  // What the card puts in front of someone is used; what it leaves out is not, and stays a search away.
  markHits(db, kept.flatMap((l) => (l.id === null ? [] : [l.id])), now);

  const dropped = candidates.length - kept.length;
  const body = kept.sort((a, b) => a.priority - b.priority || a.order - b.order).map((l) => l.text);
  return [header, ...body, ...(dropped > 0 ? [more(dropped)] : []), footer].join('\n');
}
