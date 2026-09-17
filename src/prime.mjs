import { homedir } from 'node:os';
import { ago } from './card.mjs';
import { getMeta } from './db.mjs';
import { listProjects } from './projects.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { clip, estimateTokens } from './text.mjs';

const LINE_MAX = 120;
const MAX_PROJECTS = 12;
const MAX_LEFT_OFF = 3;
const MAX_CONFIRM = 3;
const MAX_NOTICES = 2;
const SCRIBE_FAILURES_TO_WARN = 3;

const tilde = (path) => (path.startsWith(homedir()) ? `~${path.slice(homedir().length)}` : path);

/**
 * The block every session starts with. It is generated, never hand-kept, and
 * it has a hard ceiling — which is the whole answer to "memory files grow until
 * they are the problem". Everything that does not fit is reachable by search,
 * and the block says so rather than silently pretending to be complete.
 */
export function prime(db, { budget, now = new Date().toISOString() } = {}) {
  const limit = budget ?? Number(getMeta(db, 'config.prime.budget') ?? CONFIG_DEFAULTS['prime.budget']);
  const machine = getMeta(db, 'machine');
  const open = `<sumo-memory${machine ? ` machine="${machine}"` : ''}>`;
  const close = '</sumo-memory>';

  // The small, time-sensitive sections are fixed first; preferences get whatever room is left.
  const fixed = [...workflows(db), ...projectsLine(db), ...leftOff(db, now), ...jobs(db, now), ...toConfirm(db), ...warnings(db)];
  const spent = estimateTokens([open, ...fixed, close].join('\n'));
  const prefs = preferences(db, limit - spent);

  const lines = [open, ...prefs, ...fixed, close];
  if (lines.length === 2) lines.splice(1, 0, 'Nothing remembered yet. It fills in as the user talks.');
  return lines.join('\n');
}

function preferences(db, room) {
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE scope = 'global' AND state = 'active' AND type IN ('preference', 'decision')
       ORDER BY pinned DESC, importance DESC, hits DESC, id DESC`,
    )
    .all();
  if (rows.length === 0) return [];

  // Room for the heading, written at its longest, is set aside before any line is chosen.
  const heading = (shown, rest) =>
    rest.length === 0
      ? 'Preferences:'
      : `Preferences (${shown} of ${rows.length} shown · more on: ${topics(rest)} — mem search before assuming):`;
  let used = estimateTokens(heading(rows.length, rows)) + 1;

  const shown = [];
  for (const m of rows) {
    const text = `- m${m.id} ${clip(m.body, LINE_MAX)}`;
    const cost = estimateTokens(text) + 1;
    if (used + cost > room) break;
    used += cost;
    shown.push(text);
  }
  const rest = rows.slice(shown.length);
  return [heading(shown.length, rest), ...shown];
}

/** What the hidden preferences are about, so the agent knows what to search for instead of assuming there is nothing. */
function topics(rows) {
  const counts = new Map();
  for (const m of rows) counts.set(m.topic ?? 'other', (counts.get(m.topic ?? 'other') ?? 0) + 1);
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 6)
    .map(([topic, n]) => `${topic}(${n})`)
    .join(' ');
}

function workflows(db) {
  const rows = db.prepare(`SELECT * FROM memories WHERE scope = 'global' AND state = 'active' AND type = 'procedure' ORDER BY hits DESC, id DESC LIMIT 10`).all();
  if (rows.length === 0) return [];
  return [`Workflows — before doing what one covers, run mem show <id> and follow it: ${rows.map((m) => `m${m.id} "${m.title}"${m.cue ? ` — when: ${m.cue}` : ''}`).join(' · ')}`];
}

function projectsLine(db) {
  const all = listProjects(db);
  if (all.length === 0) return [];
  const shown = all.slice(0, MAX_PROJECTS).map((p) => `${p.slug} (${tilde(p.path)})`);
  const more = all.length > MAX_PROJECTS ? ` · +${all.length - MAX_PROJECTS} more: mem project list` : '';
  return [`Projects: ${shown.join(' · ')}${more}`];
}

function leftOff(db, now) {
  const rows = db
    .prepare(
      `SELECT c.* FROM checkpoints c
       JOIN (SELECT project, MAX(id) AS id FROM checkpoints GROUP BY project) latest ON latest.id = c.id
       JOIN projects p ON p.slug = c.project AND p.status = 'active'
       ORDER BY c.ts DESC LIMIT ?`,
    )
    .all(MAX_LEFT_OFF);
  return rows.map((c) => clip(`Left off: ${c.project} — ${c.done}${c.next_step ? ` → next: ${c.next_step}` : ''} (${ago(c.ts, now)})`, LINE_MAX * 2));
}

function jobs(db, now) {
  const rows = db.prepare(`SELECT * FROM jobs WHERE status IN ('running', 'needs_input') ORDER BY updated_at DESC LIMIT 5`).all();
  return rows.map((j) => `Job j${j.id} ${j.project} "${clip(j.title, 60)}" ${j.status.toUpperCase()} (${ago(j.updated_at, now)}) → mem job show ${j.id}`);
}

function toConfirm(db) {
  const guesses = db.prepare(`SELECT * FROM memories WHERE state = 'unconfirmed' ORDER BY id LIMIT ?`).all(MAX_CONFIRM);
  const out = guesses.map(
    (m) => `Ask the user (then mem confirm|reject m${m.id}): is this right? "${clip(m.type === 'procedure' ? `workflow "${m.title}"` : m.body, LINE_MAX)}"`,
  );
  // A notice stands only while both memories are still true; superseding or forgetting either settles it.
  const notices = db
    .prepare(
      `SELECT n.* FROM notices n
       JOIN memories a ON a.id = n.memory_a AND a.state = 'active'
       JOIN memories b ON b.id = n.memory_b AND b.state = 'active'
       ORDER BY n.id LIMIT ?`,
    )
    .all(MAX_NOTICES);
  for (const n of notices) {
    const verb = n.kind === 'lookalike' ? 'look alike' : 'disagree';
    out.push(`Ask the user: m${n.memory_a} and m${n.memory_b} ${verb} — ${clip(n.note, LINE_MAX)} (mem show both; settle with mem supersede or mem forget)`);
  }
  return out;
}

function warnings(db) {
  const failures = Number(getMeta(db, 'scribe.failures') ?? 0);
  if (failures < SCRIBE_FAILURES_TO_WARN) return [];
  return [`Warning: the background memory writer has failed ${failures} times in a row — nothing new is being remembered. Tell the user; mem scribe status shows why.`];
}
