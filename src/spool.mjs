import { appendFileSync, chmodSync, closeSync, fchmodSync, fstatSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { alive } from './lock.mjs';
import { paths } from './paths.mjs';

/**
 * Where an event waits when the journal could not take it: a hook that found the database busy, or broke part-way,
 * appends the event here as one line of JSON, and the next event that gets through replays it. Without this a failed
 * hook lost the turn for good and nobody was told.
 *
 * `events.jsonl` is what waits. A drain takes it by renaming it to a name of its own (`events.<pid>.<n>.draining`):
 * one process gets it, the other finds nothing there, and an event arriving meanwhile starts a new file. A line that
 * is not an event, or that failed to replay three times, goes to `events.bad.jsonl` — kept and counted, never tried
 * for ever and never dropped. A database that is only busy is no failure, and a failure counts once a minute at most:
 * every hook drains, a tool about to run included, and a write lock held for thirteen seconds once set a turn aside
 * for good. `sumo memory check --fix` tries what was set aside again (`retrySetAside`). Everything here is private (the folder 0700, each file 0600) and holds only words that
 * were redacted before they were written.
 */
const WAITING = 'events.jsonl';
const BAD = 'events.bad.jsonl';
const DRAINING = /^events\.(\d+)\.\d+\.draining$/;
/** How many times a line may fail to replay before it is set aside. */
const TRIES = 3;
/** Failures of one line closer together than this are one failure: the hooks of one busy minute are not three tries. */
const COUNTED_EVERY_MS = 60_000;
/** A drain's file this old was left by a process that died, whatever now runs under its number. */
const LEFT_AFTER_MS = 10 * 60_000;
/** Past this the spool takes no more: a database that never opens again must not fill the disk one prompt at a time. */
const SPOOL_MAX_BYTES = 64 * 1024 * 1024;

let claims = 0;

/** A line added to a file of the spool, the folder and the file made private — also when they were there before, and were not. */
function addLine(name, line) {
  const dir = paths().spool;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (statSync(dir).mode & 0o077) chmodSync(dir, 0o700);
  const file = join(dir, name);
  // A mode is given only to a file being made: one already there and readable by others is closed before more is added,
  // through the descriptor the line goes in by, so the file made private is the file written.
  const fd = openSync(file, 'a', 0o600);
  try {
    if (fstatSync(fd).mode & 0o077) fchmodSync(fd, 0o600);
    appendFileSync(fd, `${line}\n`);
  } finally {
    closeSync(fd);
  }
}

/**
 * Keeps one event for later, as one line. The caller hands over only what the journal needs, its words already
 * redacted (`turnText`, `replyText` in sessions.mjs): nothing is redacted here, and nothing else belongs in a spool.
 * Throws when the spool is full or cannot be written: whoever keeps the event says so.
 */
export function spoolEvent(entry) {
  let size = 0;
  try {
    size = statSync(join(paths().spool, WAITING)).size;
  } catch {
    // Nothing waiting yet.
  }
  if (size > SPOOL_MAX_BYTES) throw new Error(`the spool is full (${paths().spool}/${WAITING} is past ${SPOOL_MAX_BYTES / (1024 * 1024)} MB) — the event was not kept; sumo doctor says why the database cannot be written`);
  addLine(WAITING, JSON.stringify(entry));
}

const names = () => {
  try {
    return readdirSync(paths().spool);
  } catch (cause) {
    if (cause.code === 'ENOENT') return [];
    throw cause;
  }
};

/**
 * The files this process may drain now, each taken by a rename only one process can win: what is waiting, and what a
 * drain that died left in its hand (its process is gone) — replaying a line twice inserts nothing twice.
 */
function claim() {
  const dir = paths().spool;
  const mine = [];
  for (const name of names()) {
    const left = DRAINING.exec(name);
    if (name !== WAITING && !(left && (Number(left[1]) === process.pid || !alive(Number(left[1])) || olderThan(join(dir, name), LEFT_AFTER_MS)))) continue;
    const taken = join(dir, `events.${process.pid}.${Date.now()}${claims++}.draining`);
    try {
      renameSync(join(dir, name), taken);
      mine.push(taken);
    } catch (cause) {
      // Another process took it first.
      if (cause.code !== 'ENOENT') throw cause;
    }
  }
  return mine;
}

function olderThan(file, ms) {
  try {
    return Date.now() - statSync(file).mtimeMs > ms;
  } catch {
    return false;
  }
}

/** SQLite saying the database is busy or locked: another process is writing, and the line has not been tried at all. */
const locked = (cause) => cause?.errcode === 5 || cause?.errcode === 6 || /database (?:table )?is locked|SQLITE_(?:BUSY|LOCKED)/i.test(String(cause?.message ?? cause));

const setAside = (raw, why) => addLine(BAD, JSON.stringify({ at: new Date().toISOString(), why: String(why).slice(0, 300), line: raw }));

/**
 * Replays what waits, oldest first: `replay(entry)` writes one event into the journal and throws when it cannot — with
 * `bad` set on the error when the line is not an event at all, which no later try would mend. `within(fn)` runs a
 * file's replays as one piece of work (a transaction); when it throws, every line of that piece is counted as failed.
 * A failed line goes back to wait, its tries counted — once a minute at most (`tried_at`) — and is set aside at the
 * third; a line that found the database busy goes back uncounted, and nothing more is tried in this drain. Returns
 * `{ replayed, retried, bad }`, or null when nothing was waiting — the usual case, which costs one look at a folder.
 * `now` is the time of this drain, in milliseconds.
 */
export function drainSpool(replay, { within = (fn) => fn(), now = Date.now() } = {}) {
  const files = claim();
  if (files.length === 0) return null;
  const done = { replayed: 0, retried: 0, bad: 0 };
  // Once the database is found busy the rest waits untried: each further try would wait out the lock again.
  let busy = false;
  const wait = (entry) => {
    addLine(WAITING, JSON.stringify(entry));
    done.retried++;
  };
  const again = (entry, cause) => {
    if (!cause?.bad && locked(cause)) {
      busy = true;
      return wait(entry);
    }
    const last = Date.parse(entry.tried_at ?? '');
    const counts = Number.isNaN(last) || now - last >= COUNTED_EVERY_MS;
    const tries = (Number.isInteger(entry.tries) ? entry.tries : 0) + (counts ? 1 : 0);
    if (cause?.bad || tries >= TRIES) {
      setAside(JSON.stringify(entry), cause?.message ?? cause);
      done.bad++;
    } else wait(counts ? { ...entry, tries, tried_at: new Date(now).toISOString() } : entry);
  };
  for (const file of files) {
    // Read again after replaying until nothing new is there: a hook that had the file open when it was taken may
    // have added its line after the first read. The replay takes far longer than that write.
    for (let read = 0; ; ) {
      const bytes = readFileSync(file);
      const text = bytes.toString('utf8');
      // `read` is past the last line end once a torn piece has been taken.
      const end = Math.max(text.lastIndexOf('\n') + 1, read);
      // The piece after the last line end is a line still being written — or, when nothing more comes, a torn one.
      const torn = end === read && text.length > end ? text.slice(end) : '';
      if (end === read && !torn) {
        // Let go only if it is no longer than what this look read: a line added since that look is read, not removed with the file.
        if (statSync(file).size > bytes.length) continue;
        rmSync(file, { force: true });
        break;
      }
      const entries = [];
      for (const raw of torn ? [torn] : text.slice(read, end).split('\n').filter((l) => l.trim())) {
        let entry = null;
        try {
          entry = JSON.parse(raw);
        } catch {
          // Said below.
        }
        if (entry && typeof entry === 'object' && !Array.isArray(entry)) entries.push(entry);
        else {
          setAside(raw, 'not a line of JSON');
          done.bad++;
        }
      }
      const failed = [];
      let replayed = 0;
      if (busy) for (const entry of entries) wait(entry);
      else try {
        within(() => {
          for (const entry of entries) {
            try {
              replay(entry);
              replayed++;
            } catch (cause) {
              failed.push([entry, cause]);
            }
          }
        });
        done.replayed += replayed;
        for (const [entry, cause] of failed) again(entry, cause);
      } catch (cause) {
        // The piece of work itself failed — the database went busy — so nothing in it is known to have landed.
        for (const entry of entries) again(entry, cause);
      }
      read = torn ? text.length : end;
    }
  }
  return done;
}

/**
 * `sumo memory check --fix`: every line set aside tried once more, each as its own piece of work — a turn set aside
 * while the database was busy goes in now. What replays leaves `events.bad.jsonl`; what still cannot — a line that
 * was never an event — stays as it was. Returns `{ replayed, left }`.
 */
export function retrySetAside(replay, { within = (fn) => fn() } = {}) {
  const file = join(paths().spool, BAD);
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n').filter((l) => l.trim());
  } catch (cause) {
    if (cause.code === 'ENOENT') return { replayed: 0, left: 0 };
    throw cause;
  }
  const left = lines.filter((raw) => {
    try {
      const entry = JSON.parse(JSON.parse(raw).line);
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return true;
      within(() => replay(entry));
      return false;
    } catch {
      return true;
    }
  });
  if (left.length === 0) rmSync(file, { force: true });
  else if (left.length < lines.length) writeFileSync(file, `${left.join('\n')}\n`, { mode: 0o600 });
  return { replayed: lines.length - left.length, left: left.length };
}

/** Every string a line of the spool holds: its own, and those of a line kept inside it (`events.bad.jsonl` keeps the line it set aside). */
function saidIn(raw) {
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return [raw];
  }
  const strings = (v) => (typeof v === 'string' ? [v, ...(v.trimStart().startsWith('{') ? saidIn(v).filter((s) => s !== v) : [])] : v && typeof v === 'object' ? Object.values(v).flatMap(strings) : []);
  return strings(value);
}

/**
 * A purge reaches the spool too: every line — waiting, in a drain's hand, or set aside — whose words `says` holds is
 * taken out, the rest left as they were. Returns how many lines went.
 */
export function purgeSpool(says) {
  let gone = 0;
  for (const name of names()) {
    if (name !== WAITING && name !== BAD && !DRAINING.test(name)) continue;
    const file = join(paths().spool, name);
    const lines = readFileSync(file, 'utf8').split('\n');
    const kept = lines.filter((l) => !l.trim() || !saidIn(l).some(says));
    if (kept.length === lines.length) continue;
    gone += lines.length - kept.length;
    if (kept.some((l) => l.trim())) writeFileSync(file, kept.join('\n'), { mode: 0o600 });
    else rmSync(file, { force: true });
  }
  return gone;
}

/**
 * When the oldest event still waiting happened — its own `at`, or the time of the file it waits in for a line that
 * names none — in milliseconds, with how many wait: `{ waiting, since }`, `since` null when nothing does. For the
 * block a session starts with: what has waited an hour was not replayed by the next thing said.
 */
export function spoolWaitingSince() {
  let waiting = 0;
  let since = null;
  for (const name of names()) {
    if (name !== WAITING && !DRAINING.test(name)) continue;
    const file = join(paths().spool, name);
    let text;
    try {
      text = readFileSync(file, 'utf8');
    } catch {
      // Taken by a drain since the folder was listed: no longer waiting here.
      continue;
    }
    for (const raw of text.split('\n').filter((l) => l.trim())) {
      waiting++;
      let at = NaN;
      try {
        at = Date.parse(JSON.parse(raw).at);
      } catch {
        // Not a line of JSON: as old as its file.
      }
      if (Number.isNaN(at)) at = statSync(file).mtimeMs;
      since = since === null ? at : Math.min(since, at);
    }
  }
  return { waiting, since };
}

const linesIn = (name) => {
  try {
    return readFileSync(join(paths().spool, name), 'utf8').split('\n').filter((l) => l.trim()).length;
  } catch (cause) {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  }
};

/**
 * How the spool stands, for whoever checks memory's health: `waiting`, the events not yet in the journal (what waits,
 * and what a drain has in its hand or died holding), and `bad`, the lines set aside in `events.bad.jsonl` because
 * they were not events or failed to replay three times, a minute or more apart. Both are 0 when there has never been a spool.
 */
export function spoolStatus() {
  const all = names();
  return { waiting: all.filter((n) => n === WAITING || DRAINING.test(n)).reduce((n, name) => n + linesIn(name), 0), bad: all.includes(BAD) ? linesIn(BAD) : 0 };
}
