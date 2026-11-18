import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APPLY_RULES } from './apply.mjs';
import { getMeta, setMeta } from './db.mjs';
import { REPO_ROOT } from './paths.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';

/**
 * The extraction ledger, read without a model: which extractor is filing, and how its filing is going. Every model
 * call of the memory pass is a row of `extractions`, written `running` before the call and closed `ok`, `failed` or
 * `quarantined`; what the pass derived carries the extractor's version, so a changed prompt, model or rule is a new
 * extractor whose record starts clean.
 */

/** Failed passes in a row before filing stops by itself: a model that is down must not be asked on every session. */
const FAILURES_TO_PAUSE = 3;
/** The share of what an extractor filed that the user then threw out, past which it stops filing by itself. */
const JUNK_TO_PAUSE = 0.5;
/** Fewer derived memories than this say nothing about a rate. */
const JUNK_MIN_DERIVED = 10;
/** A memory thrown out this long after it was filed was wanted for a while: it went stale, it was not junk. */
const JUNK_WITHIN_MS = 30 * 86_400_000;

const FAILURES = 'scribe.failures';
const FAILURES_VERSION = 'scribe.failures_version';
const LAST_ERROR = 'scribe.last_error';
const FALLBACK_USED = 'scribe.fallback_used';

/** The model the memory pass is set to: `memory.model`, the one setting. */
const memoryModel = (db) => getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model'];

/**
 * The extractor's version: a short hash of what decides what gets filed — the prompt the model reads, the model
 * `memory.model` names, and the rules its answer is held to (`APPLY_RULES`). Each derived memory and each row of the
 * ledger carries it.
 */
export function extractorVersion(db) {
  const prompt = readFileSync(join(REPO_ROOT, 'prompts', 'scribe.md'), 'utf8');
  return createHash('sha256').update(`${prompt}\n${memoryModel(db)}\n${APPLY_RULES}`).digest('hex').slice(0, 8);
}

/**
 * Of the memories this extractor derived, the share the user then threw out within 30 days — forgot, rejected, or
 * replaced by hand — read from `memory_events`; null under ten derived. A memory a rebuild retired is not the user's
 * verdict, and one the pass itself replaced with a newer statement was right when it was filed.
 */
function junkRate(db, version) {
  const derived = db
    .prepare(
      `SELECT e.memory_id AS id, MIN(e.ts) AS at FROM memory_events e JOIN extractions x ON x.id = e.run_id
       WHERE e.op = 'added' AND x.extractor_version = ? GROUP BY e.memory_id`,
    )
    .all(version);
  if (derived.length < JUNK_MIN_DERIVED) return null;
  const thrownOut = db.prepare(
    `SELECT MIN(ts) AS at FROM memory_events
     WHERE memory_id = ? AND COALESCE(reason, '') != 'rebuilt'
       AND (op IN ('forgotten', 'rejected', 'purged') OR (op = 'superseded' AND actor IN ('user', 'model-shell')))`,
  );
  const junk = derived.filter((d) => {
    const at = thrownOut.get(d.id)?.at;
    return at && Date.parse(at) - Date.parse(d.at) <= JUNK_WITHIN_MS;
  });
  return junk.length / derived.length;
}

/** How many of the conversations last read are looked at for one that filed something. */
const EMPTY_LOOKS = 100;

/**
 * For whoever checks memory's health: how many conversations in a row, counting back from the one read last, had
 * nothing filed from them — no memory added by any pass that read them. Nothing is the normal answer for one conversation; a model that answers nothing to
 * everything looks exactly like it. What the writer from before versions read (`v0`) kept no such record and is not counted.
 */
export function emptyRun(db) {
  const read = db
    .prepare(
      `SELECT x.session_id, MAX(x.id) AS last,
              EXISTS (SELECT 1 FROM memory_events e JOIN extractions y ON y.id = e.run_id WHERE y.session_id = x.session_id AND e.op = 'added') AS filed
       FROM extractions x WHERE x.status = 'ok' AND x.extractor_version != 'v0' GROUP BY x.session_id ORDER BY last DESC LIMIT ?`,
    )
    .all(EMPTY_LOOKS);
  const first = read.findIndex((r) => r.filed);
  return first === -1 ? read.length : first;
}

/**
 * How filing stands, for the pass and for whoever reports on it:
 * - `failures`: passes of this extractor that failed in a row;
 * - `quarantined`: turns set aside after failing three times alone;
 * - `fallbackUsed`: a pass ran on the hosted fallback because the local model could not answer, and none has been read on the local model since;
 * - `junkRate`: see `junkRate`;
 * - `paused` with its `reason`: three failures in a row, or more than half of what it filed thrown out. A paused pass
 *   files nothing by itself until `sumo memory run` is asked by hand or the extractor changes;
 * - `lastOkAt`: when a conversation was last read through.
 */
export function filingState(db) {
  const version = extractorVersion(db);
  // A count kept under another extractor is that one's: a changed prompt or model starts from none.
  const failures = getMeta(db, FAILURES_VERSION) === version ? Number(getMeta(db, FAILURES) ?? 0) : 0;
  const quarantined = db.prepare(`SELECT COUNT(*) AS n FROM extractions WHERE status = 'quarantined' AND extractor_version = ?`).get(version).n;
  const junk = junkRate(db, version);
  const lastOkAt = db.prepare(`SELECT MAX(ended_at) AS at FROM extractions WHERE status = 'ok'`).get().at ?? null;
  const by = 'sumo memory run reads again by hand';
  const reason =
    failures >= FAILURES_TO_PAUSE ? `the last ${failures} passes failed (${getMeta(db, LAST_ERROR) ?? 'no reason kept'}) — ${by}`
    : junk !== null && junk > JUNK_TO_PAUSE ? `${Math.round(junk * 100)}% of what this extractor filed was forgotten or rejected within 30 days — ${by}, and a changed prompt or model starts afresh`
    : null;
  return { paused: reason !== null, reason, failures, quarantined, junkRate: junk, fallbackUsed: getMeta(db, FALLBACK_USED) === '1', lastOkAt };
}

/**
 * How a pass went, written where `filingState` reads it: a pass that read something clears the count, one that only
 * failed adds to it. That the hosted fallback was used stays said until a pass reads a conversation on the model as
 * set (`direct`): a pass that had nothing to read, or that failed, has not shown the local model is back.
 */
export function notePass(db, { ok, error = null, fallbackUsed = false, direct = false }) {
  const version = extractorVersion(db);
  const before = getMeta(db, FAILURES_VERSION) === version ? Number(getMeta(db, FAILURES) ?? 0) : 0;
  setMeta(db, FAILURES_VERSION, version);
  setMeta(db, FAILURES, ok ? 0 : before + 1);
  if (!ok) setMeta(db, LAST_ERROR, error ?? 'no reason given');
  if (fallbackUsed) setMeta(db, FALLBACK_USED, '1');
  else if (direct) setMeta(db, FALLBACK_USED, '');
}
