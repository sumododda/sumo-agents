import { activeScopes, applyOps, tooWide } from './apply.mjs';
import { tx } from './db.mjs';
import { extractorVersion } from './ledger.mjs';
import * as memory from './memory.mjs';
import { line } from './render.mjs';
import { extract, labelsFor, withLock } from './scribe.mjs';
import { markScribed } from './sessions.mjs';
import { clip } from './text.mjs';

/**
 * Derived memory is disposable: it can be made again from the journal. `dryExtract` asks what the extractor as it is
 * now would file from some turns; `rebuild` puts that beside what memory holds from the same turns, and — unless it
 * is only asked to show the difference — files what is missing and lets go what the extractor no longer finds there.
 * What the user said to remember is never part of it.
 */

/**
 * The current extractor run over journal turns, and the apply rules over its answer, writing nothing: what it would
 * file from them today. `turnIds` are `user_turns` ids, of one conversation or several.
 *
 * Returns `{ ok, error, wouldFile, dropped }`. `wouldFile` is every statement that passed the rules, as
 * `{ turnId, type, scope, body, quote, existing }` — `existing` the id of a memory already holding that statement
 * from that turn (in whatever state: active, forgotten, superseded), or null when it would be new. `dropped` is each
 * proposal the rules refused, with its reason. `ok` is false when the model could not be asked for some of the turns;
 * what the rest gave is still returned.
 */
export async function dryExtract(db, { turnIds, now = new Date().toISOString() }) {
  const read = await extract(db, { turnIds, now });
  return { ok: read.ok, error: read.error, wouldFile: read.wouldFile, dropped: read.dropped };
}

/**
 * The memories an extractor derived from these turns that nothing it would file today stands behind: active, drawn
 * from one of the turns read, and not among `supported`. Never a primary row (`derived_by IS NULL` — what the user
 * said to remember, confirmed or edited), never one they pinned or once confirmed, and only statements: a trap or a
 * workflow cites no turn to be read again. `gone` are those to let go; `kept` those that replaced another memory
 * (`replaces`, its id) and so stay: each carries a change the user stated, and letting it go would leave them with
 * neither what they said first — superseded, and staying so — nor what they said after.
 */
function unsupported(db, turnIds, supported) {
  const rows = [];
  const replaced = db.prepare('SELECT id FROM memories WHERE superseded_by = ? ORDER BY id LIMIT 1');
  const from = db.prepare(
    `SELECT m.* FROM memories m
     WHERE m.source_turn = ? AND m.state = 'active' AND m.derived_by IS NOT NULL AND m.pinned = 0
       AND m.type IN ('preference', 'fact', 'decision')
       AND NOT EXISTS (SELECT 1 FROM memory_events e WHERE e.memory_id = m.id AND e.op = 'confirmed')
     ORDER BY m.id`,
  );
  for (const id of turnIds) rows.push(...from.all(id).filter((m) => !supported.has(m.id)).map((m) => ({ ...m, replaces: replaced.get(m.id)?.id ?? null })));
  return { gone: rows.filter((m) => m.replaces === null), kept: rows.filter((m) => m.replaces !== null) };
}

const count = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/**
 * `sumo memory rebuild`: the journal read again with the extractor as it is now, and the difference from the memories
 * derived so far — what it would add, and which derived memories it would no longer file. With `dryRun` that is all.
 * Otherwise the additions are filed (derived by this extractor, their pass in the ledger, so the conversations count
 * as read) and the unsupported derived memories are let go the way `sumo forget` does, history kept — except one that
 * replaced another memory, which is shown as kept; each change is written to the memory's history with the reason `rebuilt`. A change wider than a pass may make (`tooWide`) is
 * refused whole unless `yes`. `since` (an ISO time) and `limit` (the newest N conversations) bound what is read: every
 * batch is a model call. Returns the lines to print; `exitCode` 1 when something could not be read or was refused.
 */
export async function rebuild(db, { dryRun = false, since, limit, yes = false, now = new Date().toISOString() } = {}) {
  const version = extractorVersion(db);
  const sessions = db
    .prepare(
      `SELECT s.id FROM sessions s
       WHERE EXISTS (SELECT 1 FROM user_turns t WHERE t.session_id = s.id AND (?1 IS NULL OR t.ts >= ?1))
       ORDER BY COALESCE(s.last_turn_at, s.started_at) DESC, s.id LIMIT ?2`,
    )
    .all(since ?? null, limit ?? -1)
    .map((s) => s.id);
  if (sessions.length === 0) return ['nothing to do — the journal holds no conversation to read'];
  const turns = db.prepare('SELECT id FROM user_turns WHERE session_id = ? AND (?2 IS NULL OR ts >= ?2) ORDER BY id');
  const turnIds = sessions.flatMap((id) => turns.all(id, since ?? null).map((t) => t.id));

  const go = async () => {
    const read = await extract(db, { turnIds, now });
    const readTurns = read.batches.flatMap((b) => b.turnIds);
    const adds = read.wouldFile.filter((f) => f.existing === null);
    // What an addition does to a memory it looks like, as far as can be said before the pair judge is asked — which a
    // dry run does not do. An older statement than that memory never replaces it.
    const replacing = (f) =>
      f.replaces ? ` — replaces m${f.replaces}`
      : f.mayReplace ? ` — replaces m${f.mayReplace} if the pair judge agrees`
      : f.mayBeOlder ? ` — said before m${f.mayBeOlder}: not filed if the pair judge calls the two one matter, else filed beside it`
      : '';
    const { gone, kept } = unsupported(db, readTurns, new Set(read.wouldFile.map((f) => f.existing).filter((id) => id !== null)));
    const cost = `${read.usage.inputTokens.toLocaleString('en-US')} tokens in, ${read.usage.outputTokens.toLocaleString('en-US')} out, $${read.usage.costUsd.toFixed(4)}`;
    const lines = [
      `read ${count(new Set(read.batches.map((b) => b.sessionId)).size, 'conversation')}, ${count(readTurns.length, 'turn')}, with extractor ${version} (${cost})`,
      `would add: ${adds.length}`,
      ...adds.map((f) => `  + [${f.type}·${f.scope}] ${f.body} — t${f.turnId} "${clip(f.quote, 80)}"${replacing(f)}`),
      `derived, no longer supported: ${gone.length}`,
      ...gone.map((m) => `  - ${line(m)} — derived by ${m.derived_by} from t${m.source_turn}`),
      ...kept.map((m) => `  kept: replaces m${m.replaces} — ${line(m)}`),
      ...(read.dropped.length > 0 ? [`refused by the rules: ${read.dropped.length}`, ...read.dropped.map((reason) => `  dropped — ${reason}`)] : []),
      ...(read.ok ? [] : [`some conversations could not be read and are left as they are — ${read.error}`]),
    ];
    const done = (more) => (read.ok ? [...lines, ...more] : Object.assign([...lines, ...more], { exitCode: 1 }));
    if (dryRun) return done(['nothing was changed (--dry-run)']);
    if (read.batches.length === 0) return done(['nothing was changed']);

    // Look-alikes are judged before anything is written (a model call each batch that has one), then every change
    // is made in one transaction, counted, and kept or undone whole.
    for (const batch of read.batches) {
      batch.ctx = { source: 'scribe', turns: batch.turns, sessionId: batch.sessionId, now, derivedBy: version };
      batch.labels = (await labelsFor(db, batch.ops, batch.ctx)).labels;
    }
    const changed = tx(db, () => {
      const before = activeScopes(db);
      db.exec('SAVEPOINT rebuild');
      const event = db.prepare(`INSERT INTO memory_events (ts, memory_id, op, actor, run_id, reason) VALUES (?, ?, 'rebuilt', 'sumo', ?, 'rebuilt')`);
      const runOf = new Map();
      const supported = new Set();
      const applied = [];
      const older = [];
      for (const batch of read.batches) {
        const runId = Number(
          db
            .prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, ops_json, started_at, ended_at) VALUES (?, ?, 'ok', 1, ?, ?, ?, ?, ?)`)
            .run(batch.sessionId, version, batch.turnIds[0], batch.turnIds.at(-1), JSON.stringify(batch.ops), now, now).lastInsertRowid,
        );
        for (const id of batch.turnIds) runOf.set(id, runId);
        const outcome = applyOps(db, batch.ops, { ...batch.ctx, runId, labels: batch.labels });
        for (const id of outcome.written) {
          event.run(now, id, runId);
          supported.add(id);
        }
        for (const f of outcome.filed) if (f.existing !== null) supported.add(f.existing);
        applied.push(...outcome.applied);
        // Said out loud: a statement not filed because what memory holds was said after it.
        older.push(...outcome.dropped.filter((reason) => / said before m\d+/.test(reason)));
        markScribed(db, batch.turnIds);
      }
      // Read again as memory now stands: a statement judged the same as one of these in other words stands behind it,
      // and one a new statement replaced is no longer active.
      const retired = unsupported(db, readTurns, supported).gone;
      for (const m of retired) memory.forget(db, m.id, { now, actor: 'sumo', runId: runOf.get(m.source_turn), reason: 'rebuilt' });
      const wide = tooWide(db, before);
      if (wide && !yes) db.exec('ROLLBACK TO rebuild');
      db.exec('RELEASE rebuild');
      return { applied, older, retired, refused: wide && !yes ? wide : null };
    });
    if (changed.refused) {
      return Object.assign([...lines, `refused — ${changed.refused.replace(/^this pass/, 'this rebuild')}`, 'nothing was changed: sumo memory rebuild --yes makes the change anyway'], { exitCode: 1 });
    }
    return done([
      ...changed.applied.map((l) => `  ${l}`),
      ...changed.older.map((l) => `  not filed — ${l.replace(/^\w+: /, '')}`),
      ...changed.retired.map((m) => `  let go m${m.id} (sumo history ${m.id} still shows it)`),
      `rebuilt: ${count(changed.applied.length, 'statement')} filed, ${count(changed.retired.length, 'memory', 'memories')} let go`,
    ]);
  };

  if (dryRun) return go();
  // The filing pass and a rebuild write the same ledger and the same memories: one at a time.
  const out = await withLock('scribe', go);
  return out.skipped ? Object.assign([`nothing was changed — ${out.skipped}`], { exitCode: 1 }) : out;
}
