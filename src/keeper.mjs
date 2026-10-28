import { getMeta, setMeta } from './db.mjs';
import { runDream, SESSIONS_TO_TIDY, tidyDue } from './dream.mjs';
import { localServerStatus } from './local-server.mjs';
import { memoryHealth, memoryHealthLine } from './memory.mjs';
import { modelStats, outcomeLines, runScribe } from './scribe.mjs';
import { pendingTurns, sessionsAwaitingDream } from './sessions.mjs';
import { CONFIG_DEFAULTS, modelFileOf } from './setup.mjs';

/** When the last tidy failed; until TIDY_RETRY_MS has gone by, a pass that finds a tidy due files only. */
const TIDY_FAILED = 'memory.tidy_failed_at';
const TIDY_RETRY_MS = 6 * 3_600_000;

/**
 * The memory pass: the one thing that looks after memory, so the user has one name, one status and one setting
 * (`memory.model`) instead of a writer and a tidier to keep track of. Each pass files what was said since the last one;
 * when tidying is due — conversations have finished, or a week has gone by — the same pass then tidies: reads them
 * side by side, raises pairs that say one thing or disagree, fills in search terms. It runs by itself after turns and
 * at session start and end; `sumo memory run` runs it now, `--tidy` tidies now whatever is due. A tidy that failed is
 * not tried again by itself for six hours: a local model that is down must not turn every turn's filing into a failed
 * tidy. Returns what each half did: `{ filed, tidied }`, `tidied` null when it did not tidy.
 */
export async function runMemoryPass(db, { now = new Date().toISOString(), tidy = false } = {}) {
  const filed = await runScribe(db, { now });
  const failedAt = getMeta(db, TIDY_FAILED);
  const resting = failedAt && Date.parse(now) - Date.parse(failedAt) < TIDY_RETRY_MS;
  if (!tidy && (resting || !tidyDue(db, now))) return { filed, tidied: null };
  const tidied = await runDream(db, { now, force: tidy, file: false });
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
  const lines = [...(tidied && filed.skipped ? [] : outcomeLines(filed)), ...tidying];
  const failed = (filed.ok === false && !filed.skipped) || (asked && tidied?.ok === false && !tidied.skipped);
  return failed ? Object.assign(lines, { exitCode: 1 }) : lines;
}

/** `sumo memory status`: the pass as a whole — the model it runs on, what waits, how it last went — then the numbers. */
/** The ledger's names for the pass's two halves, as the status says them. */
const HALVES = { scribe: 'filing', dream: 'tidying' };
/** A status line: its label in a column of its own, so the values stand in one. */
const row = (label, value) => `${label.padEnd(LABEL_WIDTH)}${value}`;
const LABEL_WIDTH = 11;

export async function memoryStatus(db, now = new Date().toISOString()) {
  const health = memoryHealthLine(memoryHealth(db, now), now);
  const model = getMeta(db, 'config.memory.model') ?? CONFIG_DEFAULTS['memory.model'];
  const server = model === 'local' ? await localServerStatus(db, { file: modelFileOf(db) }) : null;
  const turns = pendingTurns(db, 1000).length;
  const finished = sessionsAwaitingDream(db, now, 1000).length;
  const tidied = db.prepare(`SELECT MAX(ts) AS at FROM model_runs WHERE kind = 'dream' AND ok = 1`).get()?.at ?? null;
  const sweep = getMeta(db, 'dream.last_tidy');
  // Due with fewer than three conversations waiting: the weekly sweep is what is owed.
  const owed = finished < SESSIONS_TO_TIDY && tidyDue(db, now);
  const failures = Number(getMeta(db, 'scribe.failures') ?? 0);
  const failedAt = getMeta(db, TIDY_FAILED);
  const day = (at) => (at ? at.slice(0, 10) : 'never');
  // The ledger holds every request; the pass's own are its filing and its tidying, named so.
  const spent = modelStats(db)
    .filter((l) => /^(scribe|dream): /.test(l))
    .map((l) => l.replace(/^(scribe|dream)/, (kind) => HALVES[kind]));
  return [
    `${health.ok ? 'ok  ' : 'warn'}  ${health.label}${health.fix ? ` — ${health.fix}` : ''}`,
    row('model', `${model}${server ? ` · ${server}` : ''}`),
    row('waiting', `${turns} turn${turns === 1 ? '' : 's'} to file · ${finished} finished conversation${finished === 1 ? '' : 's'} to read (tidied by itself at ${SESSIONS_TO_TIDY}, and weekly)`),
    row('last tidy', `${day(tidied)} · weekly sweep: ${day(sweep)}${owed ? ' — owed: the next pass sweeps' : ''}`),
    ...(failures > 0 ? [row('failing', `filing failed ${failures} time${failures === 1 ? '' : 's'} in a row — ${getMeta(db, 'scribe.last_error')}`)] : []),
    ...(failedAt ? [row('failing', `the last tidy, at ${failedAt.slice(0, 16)}; tried again by itself ${Date.parse(now) - Date.parse(failedAt) < TIDY_RETRY_MS ? 'six hours on' : 'with the next pass'}, or now: sumo memory run --tidy`)] : []),
    ...(spent.length > 0 ? [row('spent', spent[0]), ...spent.slice(1).map((l) => row('', l))] : []),
  ];
}
