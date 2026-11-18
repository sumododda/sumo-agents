import { getMeta, setMeta } from './db.mjs';
import { replaySetAside } from './hooks.mjs';
import { tidyDue } from './dream.mjs';
import { emptyRun, extractorVersion, filingState } from './ledger.mjs';
import { localServerStatus } from './local-server.mjs';
import { paths } from './paths.mjs';
import { heartbeat } from './prime.mjs';
import { modelStats } from './scribe.mjs';
import { searchAll } from './search.mjs';
import { lastHeard, sessionsAwaitingExtraction } from './sessions.mjs';
import { CONFIG_DEFAULTS, modelFileOf } from './setup.mjs';
import { spoolStatus } from './spool.mjs';
import { STOPWORDS } from './text.mjs';

/**
 * Memory checking itself, so a failure is loud: whether the user is still heard, whether what was heard can be found,
 * whether anything waits where nobody looks. Capture once stopped for 35 days, with sumo commands run from Claude Code
 * all the while, and the only sign was "last heard 35d ago" inside a line marked ok. Loaded only by the commands that report — `sumo memory status|check`, `sumo doctor`,
 * the line a memory command prints inside a harness that is not heard — never by a hook.
 */

const DAY_MS = 86_400_000;
const many = (n, one, more = `${one}s`) => `${n} ${n === 1 ? one : more}`;

/** How long ago, in the largest whole unit: `3d ago`, `5h ago`, `just now`. */
function sinceSaid(at, now) {
  const hours = (Date.parse(now) - Date.parse(at)) / 3_600_000;
  if (hours >= 24) return `${Math.floor(hours / 24)}d ago`;
  return hours >= 1 ? `${Math.floor(hours)}h ago` : 'just now';
}

/** How old a project's scan may be before memory health names it. */
const SCAN_STALE_DAYS = 7;
/** A scan this old is a warning, not a note. */
const SCAN_WARN_DAYS = 30;

/** A finished conversation still unread after this long is not waiting its turn: nothing is reading. */
const UNREAD_FAIL_MS = 48 * 3_600_000;
/** This many conversations read in a row with nothing filed is said: one is normal, ten are a model that answers nothing. */
const EMPTY_RUN_WARN = 10;

/**
 * The finished conversations still unread 48 hours after they went quiet, while the writer is on: `{ count, since }`,
 * `since` when the oldest of them finished — its goodbye, or the last thing said or answered in it. A pass is started
 * whenever a session starts or ends, so a conversation waits minutes; thirty once waited for weeks, and one left open
 * for two days waited beside a status that counted it, behind checks that were all ok. Judged by the clock alone: a
 * journal with nothing unread is never at fault for being quiet, and one conversation left unread over a holiday is
 * said — the command that reads it is in the line.
 */
function unreadLong(db, now) {
  if ((getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model']) === 'off') return { count: 0, since: null };
  const cutoff = new Date(Date.parse(now) - UNREAD_FAIL_MS).toISOString();
  const answered = db.prepare('SELECT MAX(ts) AS at FROM replies WHERE session_id = ?');
  const quietSince = (s) => {
    if (s.ended_at) return s.ended_at;
    const said = s.last_turn_at ?? s.started_at;
    const reply = answered.get(s.id).at;
    return reply && reply > said ? reply : said;
  };
  const finished = sessionsAwaitingExtraction(db, { now, limit: 1000 }).map(quietSince).filter((at) => at < cutoff).sort();
  return { count: finished.length, since: finished[0] ?? null };
}

/**
 * How memory is doing, as plain values for whoever says it — doctor, the memory status:
 * - `beat`: whether a harness in use is still heard, and when each last was (`heartbeat` in prime.mjs);
 * - `filing`: how the memory pass's filing stands (`filingState` in ledger.mjs);
 * - `scans`: active projects whose scan is more than a week old, oldest first, with its age in days;
 * - `unread`: finished conversations left unread for over 48 hours (`unreadLong`);
 * - `emptyRun`: how many conversations read last, in a row, filed nothing (ledger.mjs).
 * `filing` is handed in by a caller that already read it.
 */
export function memoryHealth(db, now = new Date().toISOString(), { filing = filingState(db, now) } = {}) {
  const scans = db
    .prepare(`SELECT slug, scanned_at FROM projects WHERE status = 'active' AND scanned_at IS NOT NULL ORDER BY scanned_at`)
    .all()
    .map((p) => ({ slug: p.slug, days: Math.floor((Date.parse(now) - Date.parse(p.scanned_at)) / DAY_MS) }))
    .filter((p) => p.days > SCAN_STALE_DAYS);
  return { beat: heartbeat(db, now), filing, scans, unread: unreadLong(db, now), emptyRun: emptyRun(db) };
}

/**
 * Memory health said in one line, for doctor and the memory status: `{ ok, fail, label, fix }`. Not ok when Claude
 * Code is in use and not heard, conversations have waited two days unread, filing is paused, the last ten
 * conversations read filed nothing, or a project's scan is a month old; `fix` says what to do about each. `fail` is
 * what fails a run of doctor, the status and the check: sumo commands run from Claude Code while no turn arrives from
 * it, or finished conversations nobody reads. How long ago anything was heard is in the label and is never a fault by itself.
 */
export function memoryHealthLine(health, now = new Date().toISOString()) {
  const { beat, filing, scans, unread = { count: 0, since: null } } = health;
  const empty = (health.emptyRun ?? 0) >= EMPTY_RUN_WARN ? health.emptyRun : 0;
  const both = beat.heard.claude && beat.heard.sumo;
  const parts = [
    beat.lastAt ? `last heard ${sinceSaid(beat.lastAt, now)}${both ? ` (Claude Code ${sinceSaid(beat.heard.claude, now)} · sumo chat ${sinceSaid(beat.heard.sumo, now)})` : ''}` : 'nothing heard yet',
    `${filing.lastOkAt ? `last filed ${sinceSaid(filing.lastOkAt, now)}` : 'nothing filed yet'}${filing.paused ? ', filing paused' : filing.failures > 0 ? `, ${many(filing.failures, 'pass', 'passes')} failed since` : ''}`,
  ];
  if (filing.junkRate !== null) parts.push(`${Math.round(filing.junkRate * 100)}% of what was filed was thrown out`);
  if (unread.count > 0) parts.push(`${many(unread.count, 'finished conversation')} unread for over 48 hours`);
  if (empty > 0) parts.push(`the last ${empty} conversations read filed nothing`);
  if (scans.length > 0) {
    const named = scans.slice(0, 3).map((p) => `${p.slug}, ${p.days}d`).join('; ');
    parts.push(`${many(scans.length, 'project scan')} over ${SCAN_STALE_DAYS} days old (${named}${scans.length > 3 ? '; …' : ''})`);
  }
  const old = scans.filter((p) => p.days > SCAN_WARN_DAYS);
  const fix = [
    beat.deaf ? beat.fix : null,
    unread.count > 0 ? `${many(unread.count, 'finished conversation')} ${unread.count === 1 ? 'has' : 'have'} waited over 48 hours to be read (the oldest since ${unread.since.slice(0, 10)}): sumo memory run reads them, and sumo memory status says whether filing is paused` : null,
    filing.paused ? `filing is paused: ${filing.reason}` : null,
    empty > 0 ? `nothing is the normal answer for one conversation, not for ${empty} in a row: sumo memory show prints what the model is sent, sumo memory eval measures what it files` : null,
    old.length > 0 ? `rescan: sumo project rescan ${old[0].slug}${old.length > 1 ? ` (and ${old.length - 1} more)` : ''}` : null,
  ].filter(Boolean).join('; ');
  return { ok: fix === '', fail: beat.deaf !== null || unread.count > 0, label: `memory: ${parts.join(' · ')}`, fix };
}

/** The full-text indexes, each over the table it is named for. */
const INDEXES = ['memories_fts', 'user_turns_fts', 'replies_fts'];
/** The newest turns the canary looks through for one with words of its own. */
const CANARY_LOOKS = 20;
/** The words of a turn the canary searches by, and the fewest that make a search of its own. */
const CANARY_WORDS = 6;
const CANARY_MIN = 3;
/** How far down the search's answer the turn may stand: others may hold the same words. */
const CANARY_SHOWN = 50;
/** A backup older than this is said: one is made weekly, at a session's start. */
const BACKUP_STALE_DAYS = 14;
/** A pass still `running` after this long was left by a process that died: a batch takes minutes. */
const RUN_DEAD_AFTER_MS = 30 * 60_000;
/** The finished conversations of a harness looked at for replies, and how many without one are no accident. */
const REPLY_LOOKS = 10;
const REPLY_MISSING = 3;
/** A conversation nobody has spoken in for this long is over (as in sessions.mjs). */
const FINISHED_AFTER_MS = 30 * 60_000;

/** What SQLite says is wrong with a full-text index — its own structure, and against the table it indexes — or null. */
function indexProblem(db, name) {
  try {
    db.exec(`INSERT INTO ${name}(${name}, rank) VALUES ('integrity-check', 1)`);
    return null;
  } catch (cause) {
    return String(cause.message);
  }
}

/** Builds each named index again from its table. */
function rebuildIndexes(db, names) {
  for (const name of names) db.exec(`INSERT INTO ${name}(${name}) VALUES ('rebuild')`);
}

/** The longest words of a text that are its own: no stopword, nothing under four letters, each once. */
function distinctive(text) {
  const found = text.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return [...new Set(found.filter((w) => w.length >= 4 && !STOPWORDS.has(w)))].sort((a, b) => b.length - a.length).slice(0, CANARY_WORDS);
}

/**
 * The canary: the newest turn of the journal with words of its own must be found by searching those words. It is the
 * whole read path in one look — a turn written, indexed, and found — and it fails when any link is gone.
 */
function canary(db) {
  for (const turn of db.prepare('SELECT id, text FROM user_turns ORDER BY id DESC LIMIT ?').all(CANARY_LOOKS)) {
    const picked = distinctive(turn.text);
    if (picked.length < CANARY_MIN) continue;
    // The one search everyone uses, over the conversations alone: it keeps no miss and counts no memory as used.
    const found = searchAll(db, picked.join(' '), { turns: true, everywhere: true, limit: CANARY_SHOWN }).conversations.some((hit) => hit.kind === 'turn' && hit.id === turn.id);
    return found
      ? { ok: true, label: `the newest turn (t${turn.id}) is found by its own words`, fix: '' }
      : { ok: false, label: `the newest turn (t${turn.id}) is not found by its own words (${picked.join(' ')})`, fix: 'the search index does not hold what was said — rebuild it: sumo memory check --fix' };
  }
  return { ok: true, label: 'no turn with words of its own to look for yet', fix: '' };
}

/** Whether the weekly backup is being made: one that failed, or is two weeks old with something to lose, is said. */
function backupCheck(db, now) {
  const failed = getMeta(db, 'backup.failed');
  if (failed) return { ok: false, label: `the weekly backup could not be written (${failed})`, fix: 'sumo backup tries again' };
  const last = getMeta(db, 'last_backup');
  const days = (at) => Math.floor((Date.parse(now) - Date.parse(at)) / DAY_MS);
  if (last) {
    const age = days(last);
    return { ok: age <= BACKUP_STALE_DAYS, label: `last backup ${age === 0 ? 'today' : `${age}d ago`}`, fix: 'one is made weekly when a session starts; now: sumo backup' };
  }
  // Never backed up: a failure only once there is something two weeks old to lose.
  const oldest = db.prepare('SELECT MIN(at) AS at FROM (SELECT MIN(created_at) AS at FROM memories UNION ALL SELECT MIN(ts) FROM user_turns)').get().at;
  const owed = oldest !== null && days(oldest) > BACKUP_STALE_DAYS;
  return { ok: !owed, label: owed ? `no backup yet, and memory goes back ${days(oldest)} days` : 'no backup yet (the first is made when a session starts)', fix: 'sumo backup' };
}

/**
 * Conversations with what the user said and nothing the assistant answered, among each harness's last finished ones —
 * only those from since replies are kept (a turn with a digest is one). One is an interrupted turn; most of them is a
 * harness whose `stop` event does not reach sumo.
 */
function repliesCheck(db, now) {
  const cutoff = new Date(Date.parse(now) - FINISHED_AFTER_MS).toISOString();
  const rows = db
    .prepare(
      `SELECT s.harness, EXISTS (SELECT 1 FROM replies r WHERE r.session_id = s.id) AS answered,
              ROW_NUMBER() OVER (PARTITION BY s.harness ORDER BY s.started_at DESC, s.id DESC) AS nth
       FROM sessions s
       WHERE EXISTS (SELECT 1 FROM user_turns t WHERE t.session_id = s.id AND t.sha IS NOT NULL)
         AND (s.ended_at IS NOT NULL OR COALESCE(s.last_turn_at, s.started_at) < ?)`,
    )
    .all(cutoff)
    .filter((r) => r.nth <= REPLY_LOOKS);
  const bad = [];
  for (const harness of new Set(rows.map((r) => r.harness))) {
    const mine = rows.filter((r) => r.harness === harness);
    const missing = mine.filter((r) => !r.answered).length;
    if (missing >= REPLY_MISSING && missing * 2 > mine.length) bad.push(`${missing} of the last ${mine.length} from ${harness === 'claude' ? 'Claude Code' : harness === 'sumo' ? 'sumo chat' : harness}`);
  }
  return bad.length > 0
    ? { ok: false, label: `conversations kept without the assistant's replies: ${bad.join(', ')}`, fix: 'the stop event is not reaching sumo — sumo help hooks shows the line for it; logs/hook.log says what failed' }
    : { ok: true, label: rows.length > 0 ? "conversations are kept with the assistant's replies" : 'no finished conversation to look at for replies yet', fix: '' };
}

/**
 * Every check of the memory layer, each `{ name, ok, label, fix }`: the three full-text indexes (SQLite's own
 * integrity-check, against the tables they index), the canary, the spool, the backup, passes left running, replies
 * missing from conversations, and how filing stands. `sumo memory check` prints them and exits 1 when one fails;
 * `sumo doctor` carries them. `fix: true` rebuilds an index that fails, and replays the spool's set-aside lines, before judging. `filing` is handed in by a
 * caller that already read it.
 */
export function memoryCheck(db, now = new Date().toISOString(), { fix = false, filing = filingState(db, now) } = {}) {
  const checks = [];
  const check = (name, { ok, label, fix: how = '' }) => checks.push({ name, ok, label, fix: ok ? '' : how });

  for (const name of INDEXES) {
    let problem = indexProblem(db, name);
    let rebuilt = false;
    if (problem && fix) {
      rebuildIndexes(db, [name]);
      rebuilt = true;
      problem = indexProblem(db, name);
    }
    check(`index:${name}`, { ok: problem === null, label: `search index ${name}${rebuilt && !problem ? ' (rebuilt)' : ''}${problem ? `: ${problem}` : ''}`, fix: rebuilt ? 'rebuilding it did not mend it — sumo backup restore puts the newest backup back' : 'rebuild it: sumo memory check --fix' });
  }

  check('canary', canary(db));

  // Mending tries what was set aside once more: a turn set aside while the database was busy goes in now.
  const retried = fix ? replaySetAside(db).replayed : 0;
  const again = retried > 0 ? ` (${retried} replayed)` : '';
  const spool = spoolStatus();
  const spooled = [spool.waiting > 0 ? `${many(spool.waiting, 'event')} not yet in the journal` : null, spool.bad > 0 ? `${many(spool.bad, 'line')} set aside as unreadable${again}` : null].filter(Boolean);
  check('spool', {
    ok: spooled.length === 0,
    label: spooled.length === 0 ? `nothing waits in the spool${retried > 0 ? ` (${many(retried, 'line')} set aside ${retried === 1 ? 'was' : 'were'} replayed)` : ''}` : `the spool (${paths().spool}): ${spooled.join(', ')}`,
    fix: [
      spool.waiting > 0 ? 'what waits is replayed by the next thing said in a session; if it still waits after that the database cannot be written, and logs/hook.log says why' : null,
      // What a retry could not replay was never an event: only reading it says what it was.
      spool.bad > 0 ? `events.bad.jsonl holds what could not be replayed, with the reason on each line: ${fix ? 'read it, then delete it' : 'sumo memory check --fix tries them again'}` : null,
    ].filter(Boolean).join('; '),
  });

  check('backup', backupCheck(db, now));

  const dead = db.prepare(`SELECT COUNT(*) AS n, MIN(started_at) AS since FROM extractions WHERE status = 'running' AND started_at < ?`).get(new Date(Date.parse(now) - RUN_DEAD_AFTER_MS).toISOString());
  check('passes', {
    ok: dead.n === 0,
    label: dead.n === 0 ? 'no memory pass was left unfinished' : `${many(dead.n, 'memory pass', 'memory passes')} left running by a process that died (since ${dead.since?.slice(0, 16)})`,
    fix: 'sumo memory run reads those conversations again',
  });

  check('replies', repliesCheck(db, now));

  const empty = emptyRun(db);
  const said = [
    filing.failures > 0 ? `${many(filing.failures, 'pass', 'passes')} failed in a row` : null,
    filing.quarantined > 0 ? `${many(filing.quarantined, 'turn')} set aside after failing three times` : null,
    filing.junkRate !== null ? `${Math.round(filing.junkRate * 100)}% of what was filed was thrown out` : null,
    filing.fallbackUsed ? 'the last pass ran on the fallback model' : null,
    empty >= EMPTY_RUN_WARN ? `the last ${empty} conversations read filed nothing` : null,
  ].filter(Boolean);
  check('filing', { ok: !filing.paused, label: `filing ${filing.paused ? 'is paused' : 'is on'}${said.length > 0 ? ` — ${said.join(', ')}` : ''}`, fix: filing.reason ?? '' });

  return checks;
}

/** When the line below was last said: it is said once a day, not on every command. */
const NOT_HEARD_SAID = 'heard.claude_told_at';
const NOT_HEARD_AFTER_MS = DAY_MS;

/**
 * The line a memory command prints when it is run inside Claude Code and Claude Code is not being heard: `CLAUDECODE=1`
 * is in the environment (Claude Code sets it in its shell) and no turn has come from harness 'claude' in a day — with
 * the hooks in place, the prompt that led to this command would have been one. Says what is wrong and where the lines
 * to add are; '' when all is well, when this is sumo's own shell, or when it was said in the last day (remembered in
 * `meta`, so it does not nag on every command).
 */
export function notHeardLine(db, { env = process.env, now = new Date().toISOString() } = {}) {
  if (env.CLAUDECODE !== '1' || env.SUMO_TOOL || env.SUMO_JOB) return '';
  const heard = lastHeard(db, 'claude');
  if (heard && Date.parse(now) - Date.parse(heard) < NOT_HEARD_AFTER_MS) return '';
  const told = getMeta(db, NOT_HEARD_SAID);
  if (told && Date.parse(now) - Date.parse(told) < NOT_HEARD_AFTER_MS) return '';
  setMeta(db, NOT_HEARD_SAID, now);
  const since = heard ? `nothing has come from it for ${sinceSaid(heard, now).replace(' ago', '')}` : 'nothing has ever come from it';
  return `sumo: this Claude Code session is not being heard by sumo's memory (${since}) — what the user says here is not kept. Tell the user: the hook lines are missing from Claude Code's settings; sumo help hooks prints them and says where they go.`;
}

/**
 * `sumo help hooks`: the lines that make Claude Code heard, to be added by the user — sumo never edits another tool's
 * settings, and never reads them. The launcher is named by its full path: a hook runs without the user's PATH.
 */
export function hooksHelp() {
  const sumo = paths().launcher;
  const line = (event, name) => `    ${`"${event}":`.padEnd(20)}[{ "hooks": [{ "type": "command", "command": "${sumo} hook ${name}" }] }]`;
  return [
    "sumo's memory hears Claude Code through Claude Code's hooks. Add these to the \"hooks\" object of",
    "~/.claude/settings.json (every project), or of one project's .claude/settings.json — sumo never",
    "edits another tool's settings, so they are yours to add, and to take out again:",
    '',
    '  "hooks": {',
    `${line('SessionStart', 'session-start')},`,
    `${line('UserPromptSubmit', 'prompt')},`,
    `${line('Stop', 'stop')},`,
    `${line('SessionEnd', 'session-end')}`,
    '  }',
    '',
    'session-start puts the memory block in front of the session, prompt keeps what you say (and brings',
    "a project's card in), stop keeps the assistant's reply, session-end closes the conversation so it is",
    "read for memory. Each takes the event's JSON on stdin and never fails the session: what goes wrong",
    'is in logs/hook.log, and what could not be written waits in the spool.',
    '',
    'To see it work: say something in Claude Code, then sumo memory status — "last heard" is just now.',
  ];
}

/** The pass's own requests in the ledger of model runs, named as the status says them. */
const HALVES = { scribe: 'filing', dream: 'tidying' };
/** A status line: its label in a column of its own, so the values stand in one. */
const LABEL_WIDTH = 11;
const row = (label, value) => `${label.padEnd(LABEL_WIDTH)}${value}`;

/**
 * `sumo memory status`: one screen that says how memory stands now — whether the user is heard, and from where; the
 * model and which rung of the ladder is in use (the local model, the fallback, or none); what waits; whether filing
 * is on, and why not; the last tidy; what the pass has spent. The lines carry `exitCode: 1` when Claude Code is in use
 * and not heard.
 */
export async function memoryStatus(db, now = new Date().toISOString()) {
  const filing = filingState(db, now);
  const health = memoryHealthLine(memoryHealth(db, now, { filing }), now);
  const model = getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model'];
  const server = model === 'local' ? await localServerStatus(db, { file: modelFileOf(db) }) : null;
  const rung = model === 'off' ? 'none: the pass is off, what is said is still kept and found by search' : filing.fallbackUsed ? 'the fallback: the local model could not answer the last pass' : model === 'local' ? 'the local model' : `${model}, as set`;
  const version = extractorVersion(db);
  const finished = sessionsAwaitingExtraction(db, { now, limit: 1000 }).length;
  const spool = spoolStatus();
  const heard = (at) => (at ? sinceSaid(at, now) : 'never');
  const tidied = db.prepare(`SELECT MAX(ts) AS at FROM model_runs WHERE kind = 'dream' AND ok = 1`).get()?.at ?? null;
  const sweep = getMeta(db, 'dream.last_tidy');
  const failedAt = getMeta(db, 'memory.tidy_failed_at');
  const day = (at) => (at ? at.slice(0, 10) : 'never');
  // The ledger holds every request; the pass's own are its filing and its tidying, named so.
  const spent = modelStats(db)
    .filter((l) => /^(scribe|dream): /.test(l))
    .map((l) => l.replace(/^(scribe|dream)/, (kind) => HALVES[kind]));
  const lines = [
    `${health.ok ? 'ok  ' : health.fail ? 'FAIL' : 'warn'}  ${health.label}${health.fix ? ` — ${health.fix}` : ''}`,
    row('heard', `Claude Code ${heard(lastHeard(db, 'claude'))} · sumo chat ${heard(lastHeard(db, 'sumo'))}`),
    row('model', `${model}${server ? ` · ${server}` : ''} · in use: ${rung} · extractor ${version}`),
    row('waiting', `${many(finished, 'finished conversation')} to read · ${many(spool.waiting, 'spooled event')}${spool.bad > 0 ? ` (${spool.bad} unreadable)` : ''} · ${many(filing.quarantined, 'quarantined turn')}`),
    row('filing', filing.paused ? `paused — ${filing.reason}` : filing.failures > 0 ? `on — failed ${many(filing.failures, 'time')} in a row, pauses at three` : 'on'),
    row('last tidy', `${day(tidied)} · weekly sweep: ${day(sweep)}${tidyDue(db, now) ? ' — due: the next pass tidies' : ''}`),
    ...(failedAt ? [row('failing', `the last tidy, at ${failedAt.slice(0, 16)}; tried again by itself six hours on, or now: sumo memory run --tidy`)] : []),
    ...(spent.length > 0 ? [row('spent', spent[0]), ...spent.slice(1).map((l) => row('', l))] : []),
  ];
  // A harness in use and not heard fails the status, as it fails doctor and the check: a script can act on it.
  return health.fail ? Object.assign(lines, { exitCode: 1 }) : lines;
}
