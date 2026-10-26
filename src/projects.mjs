import { existsSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { getMeta, setMeta, tx } from './db.mjs';
import * as memory from './memory.mjs';
import { UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { gitRemote, scan } from './scan.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';

/**
 * Names too ordinary to mean "this project" when they turn up in a sentence.
 * They still work with --project; they just never trigger a project card.
 */
const ORDINARY = new Set(
  `api app apps web site docs doc test tests main server client core lib src demo tmp temp blog backend frontend
   service services tools utils common shared data config scripts infra mobile desktop admin dashboard scratch`.split(/\s+/),
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
  // Read off disk before the write lock is taken, as rescan does.
  const read = { scanned: scan(path), remote: gitRemote(path) };
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
        read.remote,
        now,
        now,
      );
      project = db.prepare('SELECT * FROM projects WHERE slug = ?').get(slug);
    }
    // Adding an archived project again is how it comes back: there is no other way to undo `archive`.
    const restored = !created && project.status === 'archived';
    if (restored) db.prepare(`UPDATE projects SET status = 'active' WHERE slug = ?`).run(project.slug);
    for (const alias of aliases) addAlias(db, project.slug, alias);
    const changes = rescan(db, project.slug, now, read);
    return { project: db.prepare('SELECT * FROM projects WHERE slug = ?').get(project.slug), created, restored, changes };
  });
}

/**
 * Brings the scanned facts in line with the directory as it is now. Only facts
 * the scanner wrote are touched — nothing the user stated can be replaced by
 * something read off disk.
 */
export function rescan(db, nameOrAlias, now = new Date().toISOString(), read = null) {
  const project = getProject(db, nameOrAlias);
  if (!existsSync(project.path)) throw new UsageError(`${project.path} no longer exists — archive the project or re-add it at its new path`);
  const scope = `project:${project.slug}`;
  // Read off disk before the write lock is taken: a slow disk or a strange file must not hold every other writer.
  const { scanned, remote } = read ?? { scanned: scan(project.path), remote: gitRemote(project.path) };

  return tx(db, () => {
    const current = new Map(
      db
        .prepare(`SELECT * FROM memories WHERE scope = ? AND scan_key IS NOT NULL AND state = 'active'`)
        .all(scope)
        .map((row) => [row.scan_key, row]),
    );
    const changes = { added: 0, updated: 0, removed: 0 };

    for (const { key, body } of scanned) {
      const before = current.get(key);
      current.delete(key);
      // Compared as it would be stored: a scrubbed secret is not a change.
      const stored = memory.storedBody('fact', body).text;
      if (before?.body === stored) continue;
      // Forgotten or replaced since, and the disk still says the same: it stays let go.
      if (!before && memory.scanRetired(db, scope, key, stored)) continue;
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

    db.prepare('UPDATE projects SET scanned_at = ?, remote = ? WHERE slug = ?').run(now, remote, project.slug);
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

/**
 * The registered project a directory is in — the project itself or a folder inside it, the deepest when one holds another —
 * or null. A path reached through a link is read as where it leads, as a project's own path is.
 */
export function projectAt(db, dir) {
  let at;
  try {
    at = realpathSync(resolve(dir));
  } catch {
    at = resolve(dir);
  }
  const inside = db
    .prepare(`SELECT slug, path FROM projects WHERE status = 'active'`)
    .all()
    .filter(({ path }) => at === path || at.startsWith(path.endsWith('/') ? path : `${path}/`));
  return inside.sort((a, b) => b.path.length - a.path.length)[0]?.slug ?? null;
}

/** The project for work that belongs to none. It lives in Sumo's own home, and a chore in it is kept only while it is worked on. */
export const SCRATCH = 'scratch';
const DAY_MS = 24 * 3_600_000;

/** Scratch's directory, made if it is not there: tools start in it, so it has to be. */
export function scratchDir() {
  mkdirSync(paths().scratch, { recursive: true, mode: 0o700 });
  return realpathSync(paths().scratch);
}

/** Only the directory in the home is scratch: a project of the user's that has the name is theirs. */
export const isScratch = (project) => project.path === scratchDir();

/** How many days a chore nothing is written in is kept. */
export const scratchDays = (db) => Number(getMeta(db, 'config.scratch.days') ?? CONFIG_DEFAULTS['scratch.days']);

/** How scratch is used, as its card and a job's brief say it. */
export const scratchRules = (db) => [
  'for work that belongs to no project: one folder per chore, named <date>-<what it is>',
  `a folder nothing is written in for ${scratchDays(db)} days is deleted — to keep one, move it out of here, then: sumo project add <path>`,
  'nothing here is checked or remembered: say in the report what you ran to prove the work',
];

/**
 * Registers scratch, so a job is handed it like any project. Nothing is scanned: what is in it says nothing that lasts.
 * A project already called scratch keeps the name — the work with no project still has the directory to go to.
 */
export function ensureScratch(db, now = new Date().toISOString()) {
  const path = scratchDir();
  const taken = db.prepare('SELECT 1 FROM projects WHERE slug = ? OR path = ?').get(SCRATCH, path) ?? db.prepare('SELECT 1 FROM project_aliases WHERE alias = ?').get(SCRATCH);
  if (!taken) db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)').run(SCRATCH, SCRATCH, path, now);
  return path;
}

/** Whether anything at `path` or under it was written after `cutoff`. A link is not followed: what it points at is not scratch's. */
function writtenSince(path, cutoff) {
  const stat = lstatSync(path);
  if (stat.mtimeMs > cutoff) return true;
  return stat.isDirectory() && readdirSync(path).some((name) => writtenSince(join(path, name), cutoff));
}

/** Lets go of what nothing has been written in for `days`, a chore at a time. Returns how many went. */
export function pruneScratch(now, days) {
  const dir = scratchDir();
  const cutoff = Date.parse(now) - days * DAY_MS;
  let gone = 0;
  for (const name of readdirSync(dir)) {
    const chore = join(dir, name);
    if (writtenSince(chore, cutoff)) continue;
    rmSync(chore, { recursive: true, force: true });
    gone++;
  }
  return gone;
}

/** What a session start owes scratch: that it is there, and — once a day, since every folder is walked — that what is idle goes. */
export function keepScratch(db, now) {
  ensureScratch(db, now);
  const last = getMeta(db, 'scratch.pruned');
  if (last && Date.parse(now) - Date.parse(last) < DAY_MS) return;
  pruneScratch(now, scratchDays(db));
  setMeta(db, 'scratch.pruned', now);
}
