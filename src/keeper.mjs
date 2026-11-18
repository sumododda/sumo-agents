import { getMeta, setMeta } from './db.mjs';
import { runDream, tidyDue } from './dream.mjs';
import { outcomeLines, runScribe, withLock } from './scribe.mjs';

/** When the last tidy failed; until TIDY_RETRY_MS has gone by, a pass that finds a tidy due files only. */
const TIDY_FAILED = 'memory.tidy_failed_at';
const TIDY_RETRY_MS = 6 * 3_600_000;

/**
 * The memory pass: the one thing that looks after memory, so the user has one name, one status and one setting
 * (`memory.model`) instead of a writer and a tidier to keep track of. Each pass files what the user stated in the
 * conversations that have finished since the last one; when the week is up the same pass then tidies memory itself:
 * raises pairs that say one thing or disagree, fills in search terms. A session starting or ending runs it by itself
 * (`auto`): finished conversations only, and no filing while filing is paused. `sumo memory run` runs it now — also
 * over conversations still going on, and through a pause — and `--tidy` tidies now whatever is due. A tidy that failed
 * is not tried again by itself for six hours: a local model that is down must not turn every pass into a failed tidy.
 * Returns what each half did: `{ filed, tidied }`, `tidied` null when it did not tidy.
 */
export async function runMemoryPass(db, { now = new Date().toISOString(), tidy = false, auto = false } = {}) {
  const filed = await runScribe(db, { now, auto });
  const failedAt = getMeta(db, TIDY_FAILED);
  const resting = failedAt && Date.parse(now) - Date.parse(failedAt) < TIDY_RETRY_MS;
  if (!tidy && (resting || !tidyDue(db, now))) return { filed, tidied: null };
  const tidied = await withLock('dream', () => runDream(db, { now }));
  if (tidied.ok === false && !tidied.skipped) setMeta(db, TIDY_FAILED, now);
  else if (failedAt) setMeta(db, TIDY_FAILED, '');
  return { filed, tidied };
}

/**
 * A pass as a person reads it: what the filing did, then what the tidying did. A half with nothing to do is left out
 * when the other did something. Fails — exit 1 for a script — when the filing failed, or a tidy asked for failed.
 */
export function passLines({ filed, tidied }, { asked = false } = {}) {
  const tidying = tidied ? outcomeLines(tidied).map((l, i) => (i === 0 ? `tidy: ${l}` : l)) : [];
  // A filing that is paused is said even beside a tidy: it is not "nothing to do".
  const lines = [...(tidied && filed.skipped && !filed.paused ? [] : outcomeLines(filed)), ...tidying];
  const failed = (filed.ok === false && !filed.skipped) || (asked && tidied?.ok === false && !tidied.skipped);
  return failed ? Object.assign(lines, { exitCode: 1 }) : lines;
}
