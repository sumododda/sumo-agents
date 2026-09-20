import { execFileSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  realpathSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { delimiter, join } from 'node:path';
import { getMeta, openDb, SCHEMA_VERSION, schemaVersion, setMeta } from './db.mjs';
import { UsageError } from './memory.mjs';
import { ENTRY, paths, REPO_ROOT } from './paths.mjs';

const MIN_NODE = [22, 13];

/** The settings `mem config` accepts, with the value used when none is stored. */
export const CONFIG_DEFAULTS = {
  'prime.budget': '800',
  'scribe.model': 'haiku',
  'dream.model': 'haiku',
};

/**
 * The launcher exists because hooks and sub-agents run where a version
 * manager's `node` is not on PATH and the repo's location is unknown. It pins
 * both as absolute paths, so `mem` means the same thing everywhere.
 */
function launcherScript() {
  return `#!/bin/sh\nexec "${process.execPath}" --disable-warning=ExperimentalWarning "${ENTRY}" "$@"\n`;
}

/** A directory already on PATH, inside the home folder, that a command can be linked into without sudo. */
function pickBinDir() {
  const home = homedir();
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const usable = (dir) => {
    try {
      accessSync(dir, constants.W_OK);
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  // Version-manager and toolchain directories are on PATH too, but they are
  // replaced on upgrade — a link placed there silently disappears.
  const volatile = /\/(\.nvm|\.volta|\.asdf|\.cargo|\.bun|node_modules|\.rbenv|\.pyenv)\//;
  const preferred = [join(home, '.local', 'bin'), join(home, 'bin')].filter((d) => onPath.includes(d));
  const others = onPath.filter((d) => d.startsWith(`${home}/`) && !volatile.test(`${d}/`));
  return [...preferred, ...others].find(usable) ?? null;
}

function linkInto(binDir, launcher) {
  const link = join(binDir, 'mem');
  let existing = null;
  try {
    existing = lstatSync(link);
  } catch {
    // Nothing there yet.
  }
  if (existing) {
    const ours = existing.isSymbolicLink() && readlinkSync(link) === launcher;
    if (ours) return { link, status: 'already linked' };
    if (!existing.isSymbolicLink() || !readlinkSync(link).endsWith('/.sumo-agents/bin/mem')) {
      return { link, status: 'skipped — a different `mem` is already there' };
    }
    unlinkSync(link);
  }
  symlinkSync(launcher, link);
  return { link, status: 'linked' };
}

export function setup({ binDir, link = true } = {}) {
  const p = paths();
  for (const dir of [p.home, p.bin, p.logs, p.backups, p.jobs]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(p.home, 0o700);

  const db = openDb();
  chmodSync(p.db, 0o600);
  if (!getMeta(db, 'machine')) setMeta(db, 'machine', hostname().replace(/\.local$/, ''));
  // Pinned for the same reason the launcher pins node: the background passes run where PATH cannot be trusted.
  // The PATH entry itself, not what it resolves to: Claude Code's updater repoints that symlink and deletes
  // the old version folder, so a resolved path stops existing at the next update.
  const claude = commandOnPath('claude');
  if (claude) setMeta(db, 'claude.path', claude);
  db.close();

  writeFileSync(p.launcher, launcherScript(), { mode: 0o755 });
  chmodSync(p.launcher, 0o755);

  const lines = [`home      ${p.home}`, `database  ${p.db}`, `launcher  ${p.launcher}`];
  if (link) {
    const dir = binDir ?? pickBinDir();
    if (dir) {
      const { link: at, status } = linkInto(dir, p.launcher);
      lines.push(`command   ${at} (${status})`);
    } else {
      lines.push(`command   not linked — add this to your shell profile: export PATH="${p.bin}:$PATH"`);
    }
  }
  return lines;
}

function commandOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** Each check is [ok, label, how to fix]. `warn` checks never fail the run. */
export function doctor() {
  const p = paths();
  const checks = [];
  const check = (ok, label, fix, warn = false) => checks.push({ ok, label, fix, warn });

  // First, so it is still visible when a terminal folds the rest away: "did the update land?" is the
  // question asked most often, and the answer is which commit this copy is running.
  const code = codeVersion();
  check(code !== null, `code ${code ?? 'unknown'}`, 'this copy is not a git checkout, so `git pull` cannot update it — clone the repo instead', true);

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = major > MIN_NODE[0] || (major === MIN_NODE[0] && minor >= MIN_NODE[1]);
  check(nodeOk, `node ${process.versions.node}`, `needs Node ${MIN_NODE.join('.')} or newer`);

  let db = null;
  try {
    db = openDb();
    const options = db.prepare('PRAGMA compile_options').all().map((r) => Object.values(r)[0]);
    check(options.includes('ENABLE_FTS5'), 'SQLite full-text search (FTS5)', 'this Node build lacks FTS5 — use the official nodejs.org build');
    check(schemaVersion(db) === SCHEMA_VERSION, `schema version ${schemaVersion(db)}`, 'database is from a newer sumo-agents — update this repo');
  } catch (cause) {
    check(false, 'database opens', cause.message);
  } finally {
    db?.close();
  }

  const mode = (file) => (existsSync(file) ? statSync(file).mode & 0o777 : null);
  check(mode(p.home) === 0o700, 'home directory is private (0700)', 'run: mem setup');
  check(mode(p.db) === 0o600, 'database is private (0600)', 'run: mem setup');

  const launcherOk = existsSync(p.launcher) && readFileSync(p.launcher, 'utf8') === launcherScript();
  check(launcherOk, 'launcher points at this repo and this node', 'run: mem setup');
  check(launcherOk && launcherRuns(), 'launcher runs the way a hook would call it', 'run: mem setup');

  const found = commandOnPath('mem');
  const ours = found !== null && existsSync(p.launcher) && realpathSync(found) === realpathSync(p.launcher);
  check(ours, '`mem` on PATH is this one', found ? `PATH finds ${found} instead` : 'run: mem setup');

  const claude = pinnedClaude();
  check(claude !== null && existsSync(claude), 'claude CLI found (runs the cheap-model passes)', 'install Claude Code, then: mem setup', true);

  return checks;
}

function codeVersion() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%h · %cs · %s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function pinnedClaude() {
  const db = openDb();
  try {
    return getMeta(db, 'claude.path') ?? commandOnPath('claude');
  } finally {
    db.close();
  }
}

export function config(key, value) {
  const db = openDb();
  try {
    if (key === undefined) {
      return Object.keys(CONFIG_DEFAULTS).map((k) => `${k} = ${getMeta(db, `config.${k}`) ?? CONFIG_DEFAULTS[k]}`);
    }
    if (!(key in CONFIG_DEFAULTS)) {
      throw new UsageError(`unknown setting "${key}" — one of: ${Object.keys(CONFIG_DEFAULTS).join(', ')}`);
    }
    if (value !== undefined) setMeta(db, `config.${key}`, value);
    return [`${key} = ${getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key]}`];
  } finally {
    db.close();
  }
}

/** Runs the launcher the way a hook would — bare environment, no PATH help — to prove it works end to end. */
function launcherRuns() {
  try {
    return execFileSync(paths().launcher, ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).startsWith('mem');
  } catch {
    return false;
  }
}
