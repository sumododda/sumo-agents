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
const BLOCKED = /operation not permitted|read-only file system|unable to open database file|readonly database/i;

/** Why the model's shell cannot be sandboxed here, or null when it can. */
export function unsandboxable({ platform = process.platform, exec = SANDBOX_EXEC } = {}) {
  if (platform !== 'darwin') return 'there is a sandbox for it only on macOS so far';
  if (!existsSync(exec)) return `${exec} is missing`;
  return null;
}

const real = (path) => {
  try {
    return realpathSync.native(path);
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
export function writablePlaces(roots, { home = homedir(), tmp = tmpdir(), sumo = paths().home, userCache = darwinUserCache(), opened = [] } = {}) {
  const places = [];
  for (const root of roots.map(real).filter(Boolean)) places.push(root, gitCommonDir(root));
  places.push(real(tmp), real('/private/tmp'), real(sumo), userCache && real(userCache), ...TOOL_CACHES.map((cache) => real(join(home, cache))));
  // What the user opened for the session at the editor's question — a file, or a directory with everything under it — the shell may write too.
  places.push(...[...opened].map(real));
  return [...new Set(places.filter(Boolean))];
}

/**
 * Files that something else reads later, outside the sandbox — the shell at its next start, a tool before it runs, an
 * editor, a commit hook — by name: changed only when the user says so, in the project or anywhere else, and never
 * opened for the session. Claude Code and Codex keep the same names. `sumo`'s own MCP file holds what may run unasked.
 */
const GUARDED = {
  'your shell reads it when it starts': ['.zshrc', '.zshenv', '.zprofile', '.zlogin', '.bashrc', '.bash_profile', '.bash_login', '.profile', '.envrc'],
  // Husky's hooks are the directory git's config names (`.husky/_`), kept with git's own; the rest of `.husky` is the project's.
  'a tool reads it before it runs': ['.npmrc', '.yarnrc', '.yarnrc.yml', 'bunfig.toml', '.pre-commit-config.yaml', 'lefthook.yml', '.mcp.json', '.claude', '.codex', '.agents'],
  'your editor reads it': ['.vscode', '.idea', '.devcontainer'],
  // Keys and logins other programs trust: a line added to authorized_keys or a profile in .aws outlives every session.
  'it holds credentials other programs trust': ['.ssh', '.aws', '.gnupg', '.kube', '.docker', '.netrc', '.git-credentials', '.pgpass'],
};
/**
 * Names that matter only in the home: a program's own setup, which runs or is read whenever that program starts. In a
 * project a `bin` folder or a `.gitconfig` is the project's own.
 */
const HOME_GUARDED = {
  'git reads it, and runs what it names': ['.gitconfig', '.config/git'],
  'macOS runs it when you log in': ['Library/LaunchAgents'],
  'a program there runs as a command': ['.local/bin', 'bin'],
  'a program you use reads it when it starts': ['.config/fish', '.vimrc', '.config/nvim', '.tmux.conf'],
};
const whyOf = (lists) => [...Object.entries(lists)].flatMap(([why, names]) => names.map((name) => [name.toLowerCase(), why]));
const GUARDED_WHY = whyOf(GUARDED);
const HOME_WHY = [...GUARDED_WHY, ...whyOf(HOME_GUARDED)];

/** What sumo keeps for itself, which only sumo writes: its memory and settings, its MCP servers, its own program and model. */
const SUMO_PRIVATE = ['memory.db', 'memory.db-wal', 'memory.db-shm', 'mcp.json', 'bin', 'models', 'eval.env'];

/** The directories on the PATH, absolute: a program put in one runs whenever its name is typed. */
const pathDirs = (env = process.env) => [...new Set(String(env.PATH ?? '').split(':').filter((d) => d.startsWith('/')).map((d) => resolve(d)))];

/**
 * Why a path is changed only when the user says so, or null: it is, or is in, one of the guarded names directly under
 * the project or the home — whichever holds it most closely, so a project kept inside `~/.claude` is its own. A
 * `.vscode` deep in a package is the package's. Any repository's git directory, any folder on the PATH and sumo's own
 * files are guarded wherever they are.
 */
export function guardedWhy(path, { roots = [], home = homedir(), sumo = paths().home, env = process.env } = {}) {
  // By name in any case: on macOS's disk `.ENVRC` is `.envrc` to whatever opens it.
  const lower = path.toLowerCase();
  for (const place of [sumo, real(sumo)].filter(Boolean)) {
    const name = SUMO_PRIVATE.find((n) => lower === join(place, n).toLowerCase() || lower.startsWith(`${join(place, n).toLowerCase()}/`));
    if (name) return name === 'mcp.json' ? 'it is the MCP allow list, which says what may run unasked' : 'it is sumo\'s own: its memory, settings or program';
  }
  const homes = new Set([home, real(home)].filter(Boolean));
  const bases = [...new Set([...roots, home].flatMap((base) => [base, real(base)]).filter(Boolean))].sort((a, b) => b.length - a.length);
  const base = bases.find((b) => path.startsWith(`${b}/`));
  if (base) {
    const rel = path.slice(base.length + 1).toLowerCase();
    const named = (homes.has(base) ? HOME_WHY : GUARDED_WHY).find(([name]) => rel === name || rel.startsWith(`${name}/`));
    if (named) return named[1];
  }
  // Any repository's git directory, not only the project's: its hooks run outside the sandbox on the next commit there.
  if (lower.split('/').includes('.git')) return 'git runs what is in it, outside the sandbox';
  const dirs = pathDirs(env);
  return dirs.includes(dirname(path)) || dirs.some((d) => real(d) === dirname(path)) ? 'it is on your PATH: a program there runs as a command' : null;
}

/**
 * What the shell may not write inside the places it may: the guarded files that are there, in each root and the home;
 * sumo's own files by name, there or not (`mcp.json` made by the shell would be read as servers allowed to run); and
 * the PATH's folders outside the project. Kept read-only as git's hooks are.
 */
export function guardedPlaces(roots, { home = homedir(), sumo = paths().home, env = process.env } = {}) {
  const places = [];
  for (const dir of roots) places.push(...Object.values(GUARDED).flat().map((name) => real(join(dir, name))));
  places.push(...[...Object.values(GUARDED), ...Object.values(HOME_GUARDED)].flat().map((name) => real(join(home, name))));
  const own = real(sumo) ?? sumo;
  places.push(...SUMO_PRIVATE.map((name) => join(own, name)));
  // A PATH folder in a project is the project's; one above a project would make all of it read-only.
  const inRoot = (d) => roots.map(real).filter(Boolean).some((r) => d === r || d.startsWith(`${r}/`) || r.startsWith(`${d}/`));
  places.push(...pathDirs(env).map(real).filter((d) => d && !inRoot(d)));
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
