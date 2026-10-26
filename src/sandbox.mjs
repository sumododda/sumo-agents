import { execFileSync } from 'node:child_process';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { paths } from './paths.mjs';

/**
 * The OS sandbox around the model's shell: macOS Seatbelt, the way Codex and Claude Code wrap their commands. Reads and
 * the network stay open — git over ssh reads ~/.ssh, a smoke test calls out, and the user chose to give the shell their
 * environment — while writes are held to the project, its git directory, the temporary folders, Sumo's own home and
 * the tool caches, and never reach git's hooks or config, which run later outside it. The user can close the network
 * past this machine (`shell.network off`). The guard refuses the commands it knows; this stops the ones it does not,
 * whatever they are spelled as.
 * `sandbox-exec` execs into the shell in place, so the shell keeps its pid and its process group, and a stop still reaches it.
 */

/** Only the one in /usr/bin: one found on the PATH could be anything. */
const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

/** The caches under the home a build or an install writes into: each is writable when it exists. */
const TOOL_CACHES = ['.npm', 'Library/Caches', '.cache', 'go/pkg', '.cargo/registry', '.cargo/git', 'Library/pnpm', '.bun/install/cache', '.gradle/caches', '.m2/repository'];

/** What is printed for a write the sandbox refused — Codex looks for the same two — in any case: Node says `EPERM: operation not permitted`. */
const BLOCKED = /operation not permitted|read-only file system/i;

/** Why the model's shell cannot be sandboxed here, or null when it can. */
export function unsandboxable({ platform = process.platform, exec = SANDBOX_EXEC } = {}) {
  if (platform !== 'darwin') return 'there is a sandbox for it only on macOS so far';
  if (!existsSync(exec)) return `${exec} is missing`;
  return null;
}

const real = (path) => {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
};

/** Each root's git common directory, asked of git once: a root does not turn into a worktree of another repository halfway through. */
const commonDirs = new Map();

/** The git directory a root's history is written to, when it lies outside the root — a worktree's is in the main checkout. */
function gitCommonDir(root) {
  if (!commonDirs.has(root)) {
    let dir = null;
    try {
      const said = execFileSync('git', ['rev-parse', '--git-common-dir'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      dir = said ? real(resolve(root, said)) : null;
    } catch {
      // Not in a repository, or no git: there is nothing outside the root to write history to.
    }
    commonDirs.set(root, dir && dir !== root && !dir.startsWith(`${root}/`) ? dir : null);
  }
  return commonDirs.get(root);
}

/** Each root's hooks directory when git's config moves it, asked of git once, like the common directory. */
const hooksPaths = new Map();

/**
 * Where git runs a root's hooks from when its config sets `core.hooksPath` — husky's `.husky/_` — by its real path where it
 * is there, else as git would find it: a relative one from the top of the working tree, where git runs its hooks. Null when unset.
 */
function hooksPathOf(root) {
  if (!hooksPaths.has(root)) {
    let dir = null;
    try {
      const ask = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim();
      const said = ask('config', '--type=path', '--get', 'core.hooksPath');
      if (said) {
        const path = resolve(ask('rev-parse', '--show-toplevel') || root, said);
        dir = real(path) ?? path;
      }
    } catch {
      // Not set, not in a repository, or no git: the hooks are in the git directory, kept already.
    }
    hooksPaths.set(root, dir);
  }
  return hooksPaths.get(root);
}

/** The per-user cache folder macOS gives every program — clang's module cache and swift's are in it — asked of getconf once a process; null where there is none. */
let userCacheDir;
function darwinUserCache() {
  if (userCacheDir === undefined) {
    try {
      userCacheDir = execFileSync('/usr/bin/getconf', ['DARWIN_USER_CACHE_DIR'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5_000 }).trim() || null;
    } catch {
      userCacheDir = null;
    }
  }
  return userCacheDir;
}

/**
 * The places a sandboxed command may write, by their real paths — the sandbox sees through a link — each once: every
 * root and the git directory it commits to, the temporary folders, Sumo's home (the shell runs `sumo job note` and
 * `sumo job finish`, which write there), the per-user cache macOS gives compilers, and the tool caches that exist. A
 * place that does not exist is left out.
 */
export function writablePlaces(roots, { home = homedir(), tmp = tmpdir(), sumo = paths().home, userCache = darwinUserCache() } = {}) {
  const places = [];
  for (const root of roots.map(real).filter(Boolean)) places.push(root, gitCommonDir(root));
  places.push(real(tmp), real('/private/tmp'), real(sumo), userCache && real(userCache), ...TOOL_CACHES.map((cache) => real(join(home, cache))));
  return [...new Set(places.filter(Boolean))];
}

const isDirectory = (path) => {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
};

/**
 * What stays read-only inside the places a command may write, by real paths: git's hooks and its config, which run or
 * are read later outside the sandbox — a hook on the user's next commit — in each root's git directory and in the
 * common one a worktree commits into, outside it; a root's `.git` that is a file, which says where its git
 * directory is; and the hooks directory git's config names instead, where it does — husky's `.husky/_` is in the project.
 * Only for a repository that is there when the command starts: `git init` makes its own.
 */
export function readOnlyPlaces(roots) {
  const places = [];
  for (const root of roots.map(real).filter(Boolean)) {
    const dotGit = join(root, '.git');
    const gitDir = real(dotGit);
    if (gitDir && isDirectory(gitDir)) places.push(join(gitDir, 'hooks'), join(gitDir, 'config'));
    else if (gitDir) places.push(gitDir);
    const common = gitCommonDir(root);
    if (common) places.push(join(common, 'hooks'), join(common, 'config'));
    const hooks = hooksPathOf(root);
    if (hooks) places.push(hooks);
  }
  return [...new Set(places)];
}

/** Every directory above a path, up to and without the root of the disk. */
function ancestors(path) {
  const above = [];
  for (let up = dirname(path); up !== dirname(up); up = dirname(up)) above.push(up);
  return above;
}

/**
 * What a command runs under: sandbox-exec with a profile that allows everything but writing, then writing to each
 * place — given as a parameter, so no path is ever spelled inside the profile — but never to what is kept read-only in
 * them, carved out with require-not as Codex does; and to the devices every shell writes to. No directory above a path
 * kept read-only can be moved or removed: renamed aside, what is under it would be out of the carve-out, and could be
 * written and moved back. With the network off, nothing past this machine is reached; loopback — a dev server, a
 * test's own — and local sockets stay open. The shell and its command follow it.
 */
export function sandboxWrap(writable, { readOnly = [], network = true } = {}) {
  const places = writable.map((_, i) => `(subpath (param "W${i}"))`).join(' ');
  const kept = readOnly.map((_, i) => `(require-not (literal (param "R${i}"))) (require-not (subpath (param "R${i}")))`).join(' ');
  const above = [...new Set(readOnly.flatMap(ancestors))];
  const rules = [
    '(version 1)',
    '(allow default)',
    '(deny file-write*)',
    `(allow file-write* ${readOnly.length === 0 ? places : `(require-all (require-any ${places}) ${kept})`} (literal "/dev/null") (regex #"^/dev/(tty|fd/|zero|dtracehelper)"))`,
  ];
  if (!network) rules.push('(deny network-outbound (remote ip))', '(allow network-outbound (remote ip "localhost:*"))');
  // Last, so no allowance after it opens the unlink a rename is made of.
  if (above.length > 0) rules.push(`(deny file-write-unlink (require-all (vnode-type DIRECTORY) (require-any ${above.map((_, i) => `(literal (param "A${i}"))`).join(' ')})))`);
  const params = [...writable.map((place, i) => `-DW${i}=${place}`), ...readOnly.map((place, i) => `-DR${i}=${place}`), ...above.map((place, i) => `-DA${i}=${place}`)];
  return [SANDBOX_EXEC, '-p', rules.join('\n'), ...params, '--'];
}

/** Whether what a failed command printed says a write was refused. */
export const blockedWrite = (output) => BLOCKED.test(output);
