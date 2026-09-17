import { knownProjectsLine, askAndApply, runScribe, withLock } from './scribe.mjs';
import { line } from './render.mjs';
import { sessionsAwaitingDream } from './sessions.mjs';
import { clip } from './text.mjs';

const MAX_SESSIONS = 5;
const TURN_MAX = 600;
const MAX_MEMORIES = 60;

/**
 * The slow pass. The writer files each conversation as it happens; this one
 * reads several finished conversations side by side, which is the only way to
 * see what no single one shows: a correction the user keeps repeating, two
 * memories that cannot both be true, a routine worth naming.
 */
function buildBundle(db, sessions) {
  const ids = sessions.map((s) => s.id);
  const marks = ids.map(() => '?').join(', ');
  const turns = db.prepare(`SELECT * FROM user_turns WHERE session_id IN (${marks}) ORDER BY id`).all(...ids);
  const checkpoints = db.prepare(`SELECT * FROM checkpoints WHERE session_id IN (${marks}) ORDER BY id`).all(...ids);
  const projects = db.prepare(`SELECT DISTINCT slug FROM session_injections WHERE session_id IN (${marks})`).all(...ids).map((r) => r.slug);

  const scopes = ['global', ...projects.map((p) => `project:${p}`)];
  const memories = db
    .prepare(
      `SELECT * FROM memories WHERE state = 'active' AND scan_key IS NULL AND scope IN (${scopes.map(() => '?').join(', ')})
       ORDER BY id DESC LIMIT ?`,
    )
    .all(...scopes, MAX_MEMORIES);

  const sections = [];
  for (const session of sessions) {
    sections.push(`--- session started ${session.started_at.slice(0, 16)}`);
    for (const t of turns.filter((x) => x.session_id === session.id)) sections.push(`[t${t.id}] user: ${clip(t.text, TURN_MAX)}`);
    for (const c of checkpoints.filter((x) => x.session_id === session.id)) sections.push(`[done in ${c.project}]: ${c.done}${c.next_step ? ` → next: ${c.next_step}` : ''}`);
  }

  const prompt = [
    knownProjectsLine(db),
    memories.length > 0 ? `What is already remembered:\n${memories.map(line).join('\n')}` : 'Nothing is remembered yet.',
    ...sections,
  ].join('\n');
  return { prompt, turns: new Map(turns.map((t) => [t.id, t])) };
}

export function runDream(db, { now = new Date().toISOString(), force = false } = {}) {
  // Anything still unfiled belongs to the writer first; consolidation reads its results.
  runScribe(db, { now });

  return withLock('dream', () => {
    const sessions = sessionsAwaitingDream(db, now, MAX_SESSIONS, { includeOpen: force });
    if (sessions.length === 0) return { skipped: 'no finished sessions are waiting' };

    const outcome = askAndApply(db, {
      kind: 'dream', promptFile: 'dream.md', bundle: buildBundle(db, sessions),
      ops: ['add', 'supersede', 'gotcha', 'checkpoint', 'contradiction', 'procedure'], sessionId: null, now,
    });
    if (outcome.ok) {
      db.prepare(`UPDATE sessions SET dream_state = 'done' WHERE id IN (${sessions.map(() => '?').join(', ')})`).run(...sessions.map((s) => s.id));
    }
    return { ...outcome, sessions: sessions.length };
  });
}

export function dreamStatus(db, now = new Date().toISOString()) {
  return [`finished sessions waiting: ${sessionsAwaitingDream(db, now, 1000).length} (runs by itself at 3)`];
}
