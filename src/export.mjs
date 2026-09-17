import { chmodSync, mkdirSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { getMeta, setMeta } from './db.mjs';
import { paths } from './paths.mjs';

const KEEP_BACKUPS = 5;
const SECTIONS = [
  ['preference', 'Preferences'],
  ['decision', 'Decisions'],
  ['fact', 'Facts'],
  ['gotcha', 'Gotchas'],
  ['procedure', 'Workflows'],
];

/**
 * The view for a person: grouped, titled, dated. Never loaded by an agent —
 * agents get the one-line form in render.mjs.
 */
export function exportMarkdown(db, now = new Date().toISOString()) {
  const projects = new Map(db.prepare('SELECT slug, name, path FROM projects').all().map((p) => [`project:${p.slug}`, p]));
  const rows = db.prepare(`SELECT * FROM memories WHERE state IN ('active', 'unconfirmed') ORDER BY id`).all();
  const machine = getMeta(db, 'machine');
  const out = [`# Memory${machine ? ` — ${machine}` : ''} — ${now.slice(0, 10)}`, ''];

  const scopes = ['global', ...[...new Set(rows.map((r) => r.scope))].filter((s) => s !== 'global').sort()];
  for (const scope of scopes) {
    const active = rows.filter((r) => r.scope === scope && r.state === 'active');
    if (active.length === 0) continue;
    const project = projects.get(scope);
    out.push(scope === 'global' ? '## Global' : `## Project: ${project?.name ?? scope} (${project?.path ?? 'path unknown'})`, '');
    for (const [type, heading] of SECTIONS) {
      const group = active.filter((r) => r.type === type);
      if (group.length === 0) continue;
      out.push(`### ${heading}`, '');
      for (const m of group) out.push(...entry(m));
      out.push('');
    }
  }

  const unconfirmed = rows.filter((r) => r.state === 'unconfirmed');
  if (unconfirmed.length > 0) {
    out.push('## Waiting for your yes/no', '');
    for (const m of unconfirmed) out.push(...entry(m));
    out.push('');
  }
  if (rows.length === 0) out.push('Nothing remembered yet.', '');
  return out.join('\n');
}

function entry(m) {
  const meta = `m${m.id} · ${m.provenance} · ${m.valid_from.slice(0, 10)}${m.pinned ? ' · pinned' : ''}`;
  if (m.type !== 'procedure') return [`- ${m.body} _(${meta})_`];
  const body = m.body.split('\n').map((l) => `  ${l}`);
  return [`- **${m.title}**${m.cue ? ` — when: "${m.cue}"` : ''}${m.gate ? ` — gates: \`${m.gate}\`` : ''} _(${meta})_`, ...body];
}

/** Every row of every table the user's knowledge lives in, for moving or inspecting the store. */
export function exportJson(db) {
  const all = (table) => db.prepare(`SELECT * FROM ${table}`).all();
  return {
    exported_at: new Date().toISOString(),
    machine: getMeta(db, 'machine'),
    projects: all('projects'),
    project_aliases: all('project_aliases'),
    memories: all('memories'),
  };
}

/**
 * A consistent snapshot while other sessions keep writing. The data has no git
 * history by design, so this is the only undo there is.
 */
export function backup(db, now = new Date()) {
  const dir = paths().backups;
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = now.toISOString().replace(/[:.]/g, '-');
  const file = join(dir, `memory-${stamp}.db`);
  db.prepare('VACUUM INTO ?').run(file);
  chmodSync(file, 0o600);
  setMeta(db, 'last_backup', now.toISOString());

  const old = readdirSync(dir)
    .filter((f) => /^memory-.*\.db$/.test(f))
    .sort()
    .slice(0, -KEEP_BACKUPS);
  for (const f of old) rmSync(join(dir, f));
  return { file, pruned: old.length };
}
