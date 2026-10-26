import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, cpSync, lstatSync, mkdirSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { DIFF } from './verify.mjs';

/**
 * A worker's own git worktree, for when another worker already has the project's tree to itself. It is made from the
 * project as it stands — uncommitted edits and untracked files included — without touching the user's files, index or
 * branches, and what the work changed is brought back to the project at the end. Nothing here knows about jobs.
 */

/** Sumo's own git calls: no hook of the user's runs, nothing is signed, and a commit has an author where git has no identity. */
const OWN = ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=sumo', '-c', 'user.email=sumo@localhost'];

const git = (root, args) => execFileSync('git', ['-C', root, ...OWN, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 256 * 1024 * 1024 }).trim();
/** How a git command that reads a patch on stdin went: whether it succeeded, and the first lines of what it said, on one line. */
const fed = (root, args, patch, env = {}) => {
  const run = spawnSync('git', ['-C', root, ...OWN, ...args], { input: patch, env: { ...process.env, ...env }, stdio: ['pipe', 'ignore', 'pipe'], encoding: 'utf8' });
  return { ok: run.status === 0, said: (run.stderr ?? '').split('\n').map((l) => l.trim()).filter(Boolean).slice(0, 3).join('; ') };
};
/** The paths a NUL-separated git listing names. */
const listed = (out) => out.split('\0').filter(Boolean);

/** The folders at a project's top level its installed dependencies live in — git ignores them, so a tree is made without them. */
const DEPENDENCIES = ['node_modules', '.venv', 'venv'];

const isDir = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};
/** Whether anything is at a path, a link to nothing included. */
const taken = (path) => {
  try {
    return Boolean(lstatSync(path));
  } catch {
    return false;
  }
};

/**
 * Makes the tree at `top`: `git stash create` captures the tracked edits in a commit nobody points at (none: the head),
 * the tree is checked out from it detached, and what git does not track is copied in and committed there, on the tree's
 * own head — so the change brought back is the work's, and nothing the user already had. A project in a subdirectory of
 * its repository works in the same subdirectory of the tree: that is `path`. The project's installed dependencies that
 * exist are linked in, not copied, so its checks run there: `linked` names them.
 */
export function makeTree(root, top) {
  const prefix = git(root, ['rev-parse', '--show-prefix']).replace(/\/$/, '');
  const start = git(root, ['stash', 'create']) || git(root, ['rev-parse', 'HEAD']);
  git(root, ['worktree', 'add', '--detach', top, start]);
  const path = join(top, prefix);
  // An untracked repository inside the project is listed as `dir/`: it is not part of this one, and is left out.
  const untracked = git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0').filter((f) => f && !f.endsWith('/'));
  for (const file of untracked) {
    mkdirSync(dirname(join(path, file)), { recursive: true });
    cpSync(join(root, file), join(path, file), { verbatimSymlinks: true });
  }
  // A link to the project's own folder: the sandbox follows it out of the job's roots, so the job reads the user's packages and cannot change them.
  const linked = DEPENDENCIES.filter((name) => isDir(join(root, name)) && !taken(join(path, name)));
  for (const name of linked) symlinkSync(join(root, name), join(path, name));
  if (untracked.length > 0 || linked.length > 0) {
    git(top, ['add', '-A']);
    // `node_modules/` in a .gitignore does not match a link of that name, and info/exclude is the user's own, shared by every
    // worktree: the links are committed on the tree's head instead, and marked in its own index as never changing — so whatever
    // the job does to one, an install that puts a folder in its place included, no `git add -A` stages it and no diff shows it.
    const links = linked.map((name) => join(prefix, name));
    if (links.length > 0) git(top, ['add', '-f', '--', ...links]);
    git(top, ['commit', '-q', '--no-verify', '-m', 'what the project held outside git, as it was']);
    if (links.length > 0) git(top, ['update-index', '--skip-worktree', '--', ...links]);
  }
  return { top, path, prefix, base: git(top, ['rev-parse', 'HEAD']), linked };
}

/** Everything changed in the tree since it was made, new files included, as git itself writes a diff: with `binary`, whole enough to apply. */
export function treeDiff({ top, prefix, base }, { binary = false } = {}) {
  git(top, ['add', '-A']);
  return execFileSync('git', ['-C', top, ...DIFF, '--cached', ...(binary ? ['--binary'] : []), base, '--', prefix || '.'], {
    encoding: binary ? 'buffer' : 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    maxBuffer: 256 * 1024 * 1024,
  });
}

/**
 * Brings the tree's change back to the project. Straight onto the files first: it applies whole or not at all, touches no
 * index, and the user's uncommitted edits are the very start the work was made from. Where the project has moved since, a
 * three-way merge — tried first on a copy of the index, since one that conflicts leaves its markers in the user's files —
 * unless a file it touches has edits not staged in the project: git refuses a three-way merge over those, whatever the trial
 * said. `scratch` is a folder of sumo's own for that copy. Not applied, `why` is what git said.
 */
export function bringBack(root, tree, scratch) {
  const patch = treeDiff(tree, { binary: true });
  if (patch.length === 0) return { applied: false, empty: true };
  const at = git(root, ['rev-parse', '--show-toplevel']);
  const plain = fed(at, ['apply', '--whitespace=nowarn'], patch);
  if (plain.ok) return { applied: true, merged: false };
  const unstaged = new Set(listed(git(at, ['diff', '--name-only', '-z'])));
  const edited = listed(git(tree.top, ['diff', '--cached', '--name-only', '--no-renames', '-z', tree.base, '--', tree.prefix || '.'])).filter((f) => unstaged.has(f));
  if (edited.length > 0) {
    const named = `${edited.slice(0, 5).join(', ')}${edited.length > 5 ? ` and ${edited.length - 5} more` : ''}`;
    return { applied: false, why: `${plain.said} — and ${named} ${edited.length === 1 ? 'has' : 'have'} edits in ${at} not staged, so a three-way merge could not be tried` };
  }
  const index = join(scratch, 'index.try');
  try {
    copyFileSync(git(at, ['rev-parse', '--path-format=absolute', '--git-path', 'index']), index);
    const trial = fed(at, ['apply', '--whitespace=nowarn', '--3way', '--cached'], patch, { GIT_INDEX_FILE: index });
    if (!trial.ok) return { applied: false, why: trial.said };
    const merged = fed(at, ['apply', '--whitespace=nowarn', '--3way'], patch);
    return merged.ok ? { applied: true, merged: true } : { applied: false, why: merged.said };
  } finally {
    rmSync(index, { force: true });
  }
}

/**
 * Removes the tree, and git's record of it; a tree git will not let go of is deleted all the same. Neither way follows a
 * link: the project's dependencies linked in (`makeTree`) stay as they are.
 */
export function dropTree(root, top) {
  try {
    git(root, ['worktree', 'remove', '--force', top]);
  } catch {
    rmSync(top, { recursive: true, force: true });
  }
}
