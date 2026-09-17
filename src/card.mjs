import { aliasesOf, getProject } from './projects.mjs';
import { clip, estimateTokens } from './text.mjs';

const CARD_BUDGET_TOKENS = 200;
const LINE_MAX = 110;

/** Lower number = kept first when the card has to shrink. Scanned facts are ranked by their key. */
const SCAN_PRIORITY = { instructions: 1, stack: 2, commands: 3, index: 7, workspaces: 9, ci: 10, about: 11 };
const PRIORITY = { rule: 4, last: 5, gotcha: 6, workflow: 6, fact: 8 };

export function ago(iso, now) {
  const hours = (Date.parse(now) - Date.parse(iso)) / 3_600_000;
  if (hours < 1) return 'just now';
  if (hours < 48) return `${Math.round(hours)}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

/**
 * What an agent needs the moment a project comes up, under a hard budget.
 * To fit, whole lines are left out — and counted, so the card says how much it
 * is not showing. A single over-long line is clipped with a visible ellipsis;
 * `mem show <id>` has the rest.
 */
export function card(db, nameOrAlias, { budget = CARD_BUDGET_TOKENS, now = new Date().toISOString() } = {}) {
  const project = getProject(db, nameOrAlias);
  const scope = `project:${project.slug}`;
  const rows = db
    .prepare(`SELECT * FROM memories WHERE scope = ? AND state = 'active' ORDER BY pinned DESC, importance DESC, hits DESC, id DESC`)
    .all(scope);

  const candidates = [];
  let order = 0;
  const offer = (priority, text) => candidates.push({ priority, order: order++, text: clip(text, LINE_MAX) });

  for (const m of rows.filter((r) => r.scan_key)) offer(SCAN_PRIORITY[m.scan_key] ?? 11, m.body);
  for (const m of rows.filter((r) => !r.scan_key && (r.type === 'preference' || r.type === 'decision'))) offer(PRIORITY.rule, `rule m${m.id}: ${m.body}`);

  const last = db.prepare('SELECT * FROM checkpoints WHERE project = ? ORDER BY ts DESC, id DESC LIMIT 1').get(project.slug);
  if (last) offer(PRIORITY.last, `last (${ago(last.ts, now)}): ${last.done}${last.next_step ? ` → next: ${last.next_step}` : ''}`);

  for (const m of rows.filter((r) => r.type === 'gotcha')) offer(PRIORITY.gotcha, `gotcha m${m.id}: ${m.body}`);
  for (const m of rows.filter((r) => r.type === 'procedure')) offer(PRIORITY.workflow, `workflow m${m.id}: "${m.title}"${m.cue ? ` (when: ${m.cue})` : ''} — follow it: mem show m${m.id}`);
  for (const m of rows.filter((r) => !r.scan_key && r.type === 'fact')) offer(PRIORITY.fact, `fact m${m.id}: ${m.body}`);

  const aliases = aliasesOf(db, project.slug);
  const header = `<project ${project.slug}${project.status === 'archived' ? ' (archived)' : ''}> ${project.path}${aliases.length ? ` · also called: ${aliases.join(', ')}` : ''}`;
  const footer = '</project>';
  const more = (n) => `(+${n} more — mem search "<topic>" --project ${project.slug})`;

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

  const dropped = candidates.length - kept.length;
  const body = kept.sort((a, b) => a.priority - b.priority || a.order - b.order).map((l) => l.text);
  return [header, ...body, ...(dropped > 0 ? [more(dropped)] : []), footer].join('\n');
}
