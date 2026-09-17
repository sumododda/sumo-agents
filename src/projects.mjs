import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, resolve } from 'node:path';
import { tx } from './db.mjs';
import * as memory from './memory.mjs';
import { UsageError } from './memory.mjs';
import { gitRemote, scan } from './scan.mjs';

/**
 * Names too ordinary to mean "this project" when they turn up in a sentence.
 * They still work with --project; they just never trigger a project card.
 */
const ORDINARY = new Set(
  `api app apps web site docs doc test tests main server client core lib src demo tmp temp blog backend frontend
   service services tools utils common shared data config scripts infra mobile desktop admin dashboard`.split(/\s+/),
);
const MIN_DETECT_LENGTH = 3;

const slugify = (name) => name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');

function expand(path) {
  const full = resolve(path.replace(/^~(?=$|\/)/, homedir()));
  if (!existsSync(full) || !statSync(full).isDirectory()) throw new UsageError(`${full} is not a directory`);
  return realpathSync(full);
}

export function getProject(db, nameOrAlias) {
  const slug = memory.resolveProject(db, nameOrAlias);
  return db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
}

export function aliasesOf(db, slug) {
  return db.prepare('SELECT alias FROM project_aliases WHERE slug = ? ORDER BY alias').all(slug).map((r) => r.alias);
}

export function addAlias(db, slug, rawAlias) {
  const alias = slugify(rawAlias);
  if (!alias) throw new UsageError(`"${rawAlias}" is not a usable alias`);
  const takenBySlug = db.prepare('SELECT slug FROM projects WHERE slug = ?').get(alias);
  const takenByAlias = db.prepare('SELECT slug FROM project_aliases WHERE alias = ?').get(alias);
  const owner = takenBySlug?.slug ?? takenByAlias?.slug;
  if (owner && owner !== slug) throw new UsageError(`"${alias}" already means the project ${owner}`);
  if (!owner) db.prepare('INSERT INTO project_aliases (alias, slug) VALUES (?, ?)').run(alias, slug);
  return alias;
}

/**
 * Registers a directory as a project and scans it. Adding a path that is
 * already registered is not an error: it re-scans and returns the same project.
 */
export function addProject(db, rawPath, { slug: wantedSlug, aliases = [], now = new Date().toISOString() } = {}) {
  const path = expand(rawPath);
  return tx(db, () => {
    let project = db.prepare('SELECT * FROM projects WHERE path = ?').get(path);
    const created = !project;
    if (created) {
      const slug = slugify(wantedSlug ?? basename(path));
      if (!slug) throw new UsageError('could not derive a name from that path — pass --slug');
      if (db.prepare('SELECT 1 FROM projects WHERE slug = ?').get(slug) || db.prepare('SELECT 1 FROM project_aliases WHERE alias = ?').get(slug)) {
        throw new UsageError(`the name "${slug}" is taken by another project — pass --slug <name>`);
      }
      db.prepare('INSERT INTO projects (slug, name, path, remote, created_at, last_touched_at) VALUES (?, ?, ?, ?, ?, ?)').run(
        slug,
        basename(path),
        path,
        gitRemote(path),
        now,
        now,
      );
      project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    }
    for (const alias of aliases) addAlias(db, project.slug, alias);
    const changes = rescan(db, project.slug, now);
    return { project: db.prepare('SELECT * FROM projects WHERE slug = ?').get(project.slug), created, changes };
  });
}

/**
 * Brings the scanned facts in line with the directory as it is now. Only facts
 * the scanner wrote are touched — nothing the user stated can be replaced by
 * something read off disk.
 */
export function rescan(db, nameOrAlias, now = new Date().toISOString()) {
  const project = getProject(db, nameOrAlias);
  if (!existsSync(project.path)) throw new UsageError(`${project.path} no longer exists — archive the project or re-add it at its new path`);
  const scope = `project:${project.slug}`;

  return tx(db, () => {
    const current = new Map(
      db
        .prepare(`SELECT * FROM memories WHERE scope = ? AND scan_key IS NOT NULL AND state = 'active'`)
        .all(scope)
        .map((row) => [row.scan_key, row]),
    );
    const changes = { added: 0, updated: 0, removed: 0 };

    for (const { key, body } of scan(project.path)) {
      const before = current.get(key);
      current.delete(key);
      if (before?.body === body) continue;
      // The old fact has to stop being active first: only one active fact per key is allowed.
      if (before) db.prepare(`UPDATE memories SET state = 'superseded', invalid_at = ? WHERE id = ?`).run(now, before.id);
      const { memory: saved } = memory.add(db, {
        type: 'fact', body, project: project.slug, provenance: 'scanned', scanKey: key, writtenBy: 'scanner', now,
      });
      if (before) db.prepare('UPDATE memories SET superseded_by = ? WHERE id = ?').run(saved.id, before.id);
      changes[before ? 'updated' : 'added']++;
    }

    // Whatever is left was true at the last scan and is not any more.
    for (const gone of current.values()) {
      db.prepare(`UPDATE memories SET state = 'invalid', invalid_at = ? WHERE id = ?`).run(now, gone.id);
      changes.removed++;
    }

    db.prepare('UPDATE projects SET scanned_at = ?, remote = ? WHERE slug = ?').run(now, gitRemote(project.path), project.slug);
    return changes;
  });
}

export function listProjects(db, { includeArchived = false } = {}) {
  return db
    .prepare(`SELECT * FROM projects ${includeArchived ? '' : `WHERE status = 'active'`} ORDER BY COALESCE(last_touched_at, created_at) DESC`)
    .all();
}

export function archive(db, nameOrAlias) {
  const project = getProject(db, nameOrAlias);
  db.prepare(`UPDATE projects SET status = 'archived' WHERE slug = ?`).run(project.slug);
  return project.slug;
}

export function touch(db, slug, now = new Date().toISOString()) {
  db.prepare('UPDATE projects SET last_touched_at = ? WHERE slug = ?').run(now, slug);
}

/**
 * Which registered projects a sentence is talking about. Whole-word matches on
 * a project's name or aliases only — deterministic, so the prompt hook can call
 * it on every message for free.
 */
export function detect(db, text) {
  const names = [
    ...db.prepare(`SELECT slug AS name, slug FROM projects WHERE status = 'active'`).all(),
    ...db.prepare(`SELECT a.alias AS name, a.slug FROM project_aliases a JOIN projects p ON p.slug = a.slug WHERE p.status = 'active'`).all(),
  ];
  const lower = text.toLowerCase();
  const found = new Set();
  for (const { name, slug } of names) {
    if (name.length < MIN_DETECT_LENGTH || ORDINARY.has(name)) continue;
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (new RegExp(`(?<![\\w-])${escaped}(?![\\w-])`).test(lower)) found.add(slug);
  }
  return [...found];
}
