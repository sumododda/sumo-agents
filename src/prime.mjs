import { homedir } from 'node:os';
import { ago, askLines } from './card.mjs';
import { getMeta, setMeta } from './db.mjs';
import { paths } from './paths.mjs';
import { isScratch, listProjects, SCRATCH_DAYS } from './projects.mjs';
import { filingState } from './ledger.mjs';
import { lastHeard } from './sessions.mjs';
import { spoolWaitingSince } from './spool.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { clip, estimateTokens } from './text.mjs';

const LINE_MAX = 120;
const NAME_MAX = 60;
const MAX_PROJECTS = 12;
const MAX_LEFT_OFF = 3;
/** Where a project was left is news for two weeks; after that it is its card's last line, and search's. */
const LEFT_OFF_DAYS = 14;
const MAX_CONFIRM = 3;
/** The block's ceiling, in tokens: what does not fit is found by search. */
const PRIME_BUDGET = 800;
const MAX_NOTICES = 2;
const SCRIBE_FAILURES_TO_WARN = 3;
/** An event waiting in the spool this long is said in the block: the next thing said should have replayed it. */
const SPOOL_WAIT_SAID_MS = 3_600_000;
/** A preference never used, and said more days ago than this, is the first to leave the block when room is short. */
const UNUSED_DAYS = 60;

// Only a whole leading directory: /Users/sumo2 is not inside /Users/sumo.
const tilde = (path) => (path === homedir() || path.startsWith(`${homedir()}/`) ? `~${path.slice(homedir().length)}` : path);

/**
 * The block every session starts with. It is generated, never hand-kept, and
 * it has a hard ceiling — which is the whole answer to "memory files grow until
 * they are the problem". Everything that does not fit is reachable by search,
 * and the block says so rather than silently pretending to be complete.
 */
export function prime(db, { budget, project = null, now = new Date().toISOString() } = {}) {
  // A budget that is not a number would hold nothing back: the default stands in for it.
  const limit = Number.isInteger(budget) && budget > 0 ? budget : PRIME_BUDGET;
  const machine = getMeta(db, 'machine');
  const open = `<sumo-memory${machine ? ` machine="${machine}"` : ''}>`;
  const close = '</sumo-memory>';

  // The small, time-sensitive sections are fixed first; preferences get whatever room is left.
  // Preserve the compact layout normally; when it cannot fit, keep time-sensitive lines first.
  const sections = [workflows(db), projectsLine(db), leftOff(db, now), jobs(db, now), toConfirm(db, { project, now }), warnings(db, now)];
  // Where the work with no project goes is said every time, and is not something remembered.
  const remembered = sections.flat().length;
  sections.splice(2, 0, scratchLine());
  const fixed = sections.flat();
  const spent = estimateTokens([open, ...fixed, close].join('\n'));
  const prefs = preferences(db, limit - spent, now);

  const lines = [open, ...prefs, ...fixed, close];
  if (prefs.length + remembered === 0) lines.splice(1, 0, 'Nothing remembered yet. It fills in as the user talks.');
  const block = lines.join('\n');
  if (estimateTokens(block) <= limit) return block;

  // What is left out for room is counted where the block says more is behind search: never a silent cut.
  const more = (left) => `More memory${left > 0 ? ` (${left} line${left === 1 ? '' : 's'} left out for room)` : ''}: sumo search · sumo project list · sumo job list`;
  const wrap = (body) => [open, ...body, close].join('\n');
  const wanted = [...sections.slice().reverse().flat(), ...prefs];
  // A budget too small for even the envelope carries a bounded pointer instead.
  if (estimateTokens(wrap([more(wanted.length)])) > limit) return clip('Memory: sumo search', limit * 4);
  const kept = [];
  // Room for the count is set aside at its longest, so saying it can never push the block over.
  for (const text of wanted) {
    if (estimateTokens(wrap([...kept, text, more(wanted.length)])) <= limit) kept.push(text);
  }
  return wrap([...kept, more(wanted.length - kept.length)]);
}

/**
 * The user's global preferences and decisions under a budget: a heading, then one line each. Pinned come first, then
 * the weightier kind; within those, what was used last — found by a search, or handed over before a question — comes
 * first, and one not used yet counts from the day it was said. So where room is short, one never used and said more
 * than UNUSED_DAYS ago leaves first, then the least recently used. Left out is not lost: a search finds it, and being
 * found brings it back.
 */
export function preferences(db, room, now = new Date().toISOString()) {
  const unusedSince = new Date(Date.parse(now) - UNUSED_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT * FROM memories WHERE scope = 'global' AND state = 'active' AND type IN ('preference', 'decision')
       ORDER BY pinned DESC, importance DESC, (last_hit_at IS NULL AND created_at < ?), COALESCE(last_hit_at, created_at) DESC, hits DESC, id DESC`,
    )
    .all(unusedSince);
  if (rows.length === 0) return [];

  // Room for the heading, written at its longest, is set aside before any line is chosen.
  const heading = (shown, rest) =>
    rest.length === 0
      ? 'Preferences:'
      : `Preferences (${shown} of ${rows.length} shown · more on: ${topics(rest)} — sumo search before assuming):`;
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
  // Named, not quoted in full: sumo show has the rest, and the block has a ceiling to keep.
  return [`Workflows — before doing what one covers, run sumo show <id> and follow it: ${rows.map((m) => `m${m.id} "${clip(m.title, NAME_MAX)}"${m.cue ? ` — when: ${clip(m.cue, NAME_MAX)}` : ''}`).join(' · ')}`];
}

function projectsLine(db) {
  const all = listProjects(db).filter((p) => !isScratch(p));
  if (all.length === 0) return [];
  const shown = all.slice(0, MAX_PROJECTS).map((p) => `${p.slug} (${tilde(p.path)})`);
  const more = all.length > MAX_PROJECTS ? ` · +${all.length - MAX_PROJECTS} more: sumo project list` : '';
  return [`Projects: ${shown.join(' · ')}${more}`];
}

function scratchLine() {
  return [`Scratch: ${tilde(paths().scratch)} — work that belongs to no project goes here, a folder per chore; one idle ${SCRATCH_DAYS} days is deleted`];
}

function leftOff(db, now) {
  const since = new Date(Date.parse(now) - LEFT_OFF_DAYS * 86_400_000).toISOString();
  const rows = db
    .prepare(
      `SELECT c.* FROM checkpoints c
       JOIN (SELECT project, MAX(id) AS id FROM checkpoints GROUP BY project) latest ON latest.id = c.id
       JOIN projects p ON p.slug = c.project AND p.status = 'active'
       WHERE c.ts >= ?
       ORDER BY c.ts DESC LIMIT ?`,
    )
    .all(since, MAX_LEFT_OFF);
  return rows.map((c) => clip(`Left off: ${c.project} — ${c.done}${c.next_step ? ` → next: ${c.next_step}` : ''} (${ago(c.ts, now)})`, LINE_MAX * 2));
}

function jobs(db, now) {
  const rows = db.prepare(`SELECT * FROM jobs WHERE status IN ('running', 'needs_input') ORDER BY updated_at DESC LIMIT 5`).all();
  return rows.map((j) => `Job j${j.id} ${j.project} "${clip(j.title, 60)}" ${j.status.toUpperCase()} (${ago(j.updated_at, now)}) → sumo job show ${j.id}`);
}

/**
 * What to put to the user at the start: memories held for them (their conversation read the web or an MCP server, or
 * the model's shell saved what they never typed), and notices — about everything and about this session's project, each held memory for two weeks. One about
 * another project is asked with that project's card, when it comes up.
 */
function toConfirm(db, { project = null, now }) {
  return askLines(db, { scopes: ['global', ...(project ? [`project:${project}`] : [])], now, held: MAX_CONFIRM, notices: MAX_NOTICES });
}

/** Where it is kept that a sumo command was run from inside Claude Code, and when: the evidence that it is in use. */
const USED_CLAUDE = 'used.claude';
/** The stamp is renewed this often at most: a command pays one read for it, and a write an hour. */
const USE_STAMPED_EVERY_MS = 3_600_000;
/** Claude Code used this much later than it was last heard is Claude Code not being heard: a prompt comes before a command. */
const UNHEARD_AFTER_MS = 86_400_000;
/** A use this old is a harness the user left, not one that is failing now. */
const LEFT_DAYS = 60;
const DAY_MS = 86_400_000;

/**
 * Notes that a sumo command is being run from inside Claude Code (`CLAUDECODE=1`, which it sets in its shell) — never
 * from sumo's own chat or a job started there. Called by the command line for the commands that open memory, never by
 * a hook: a hook running is the hearing itself, not evidence of use without it.
 */
export function noteUsedFrom(db, env = process.env, now = new Date().toISOString()) {
  if (env.CLAUDECODE !== '1' || env.SUMO_TOOL || env.SUMO_JOB) return;
  const last = getMeta(db, USED_CLAUDE);
  if (!last || Date.parse(now) - Date.parse(last) >= USE_STAMPED_EVERY_MS) setMeta(db, USED_CLAUDE, now);
}

/**
 * Whether memory is still hearing the user, judged on evidence of use and never on silence alone. Capture once stopped
 * for five weeks — the hook lines had gone from Claude Code — while sumo commands went on being run from it: that is
 * the failure, and `deaf` is 'claude' when a command was run from Claude Code more than a day after the last turn
 * heard from it (or with none ever heard). Silence by itself is a holiday: back after eight days, nothing has been
 * missed. sumo's own chat records in process and cannot go deaf, so its silence, however long, is only said. `fix`
 * says what to do, `heard` when each harness was last heard, `used` when a command last ran from Claude Code.
 */
export function heartbeat(db, now = new Date().toISOString()) {
  const heard = { claude: lastHeard(db, 'claude'), sumo: lastHeard(db, 'sumo') };
  const lastAt = lastHeard(db);
  const used = getMeta(db, USED_CLAUDE);
  const inUse = used && Date.parse(now) - Date.parse(used) <= LEFT_DAYS * DAY_MS;
  if (inUse && (!heard.claude || Date.parse(used) - Date.parse(heard.claude) > UNHEARD_AFTER_MS)) {
    const days = heard.claude ? Math.floor((Date.parse(now) - Date.parse(heard.claude)) / DAY_MS) : null;
    const since = days === null ? 'no turn has ever come from it' : `no turn has come from it for ${days} day${days === 1 ? '' : 's'}`;
    const fix = `Claude Code is not being heard: sumo commands are run from it and ${since}, so what is said there is not kept. Its hook lines are missing or failing — sumo help hooks prints them, and logs/hook.log says what failed`;
    return { heard, lastAt, used, deaf: 'claude', fix };
  }
  return { heard, lastAt, used, deaf: null, fix: '' };
}

function warnings(db, now) {
  const out = [];
  // AGENTS.md says a background writer files what the user says; with it off, nothing does unless the model is told.
  if ((getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model']) === 'off') {
    out.push('The memory pass is off (memory.model): save what the user states that should last, as it is said, with sumo add.');
  }
  // As the ledger counts them, which is what the status says: failures kept under an extractor since changed are not this one's.
  const filing = filingState(db, now);
  const failures = filing.failures;
  if (filing.fallbackUsed) out.push('Warning: the memory pass last ran on the hosted fallback — the local model could not answer, and each conversation read that way is paid for. Tell the user; sumo memory status says how the local model is.');
  if (failures >= SCRIBE_FAILURES_TO_WARN) out.push(`Warning: the background memory writer has failed ${failures} times in a row — nothing new is being remembered. Tell the user; sumo memory status shows why.`);
  // What waits in the spool is replayed by the next event that gets through: still there an hour on, it is not getting through.
  const spool = spoolWaitingSince();
  const waited = spool.since === null ? 0 : Date.parse(now) - spool.since;
  if (waited > SPOOL_WAIT_SAID_MS) {
    const hours = Math.floor(waited / 3_600_000);
    out.push(`Warning: ${spool.waiting} thing${spool.waiting === 1 ? '' : 's'} said in a session ${spool.waiting === 1 ? 'is' : 'are'} still waiting to be written to memory, the oldest for ${hours} hour${hours === 1 ? '' : 's'} — the database could not take them. Tell the user; sumo memory check says where they wait and why.`);
  }
  const backup = getMeta(db, 'backup.failed');
  if (backup) out.push(`Warning: the weekly backup could not be written (${backup}). Tell the user; sumo backup tries again.`);
  // A harness in use and not heard is said where every session starts: the one place it cannot hide.
  const beat = heartbeat(db, now);
  if (beat.deaf) out.push(`Warning: ${beat.fix}. Tell the user.`);
  return out;
}
