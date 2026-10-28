import { homedir } from 'node:os';

/**
 * The guard: a shell command that would wipe a tree, throw away history or
 * empty a database, and any way of reading a secret file, are refused before
 * they run. No memory is consulted and no database is opened — the check is
 * a handful of patterns over the command or the path, and nothing else.
 *
 * It is a refusal, never an argument: the reason says what was matched and
 * that the user can run the command themselves. What it does not cover is as
 * deliberate as what it does — a force-push is an accepted way of cleaning up
 * history here, and `rm -rf node_modules` is Tuesday.
 */

/**
 * A file whose contents are a secret: reading it is refused, and a change that adds one is never DONE. A glob (`.env*`) names them too.
 * Any case: the disk a Mac ships with reads `.ENV` as `.env`. A redirect (`<.env`) is a reading too, and so is a file at a
 * revision (`HEAD:.env`).
 */
const SECRET_FILE =
  /(^|[\s/'"=<:])(\.env[*?]*(\.(?!example\b|sample\b|template\b)[\w*?-]+)?|\.netrc|\.git-credentials|\.aws\/credentials|\.ssh\/(?!known_hosts\b|config\b|authorized_keys\b)[\w.-]+(?<!\.pub)|id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)|[\w.-]+\.(pem|key|p12|pfx))(?=$|[\s'"|;&)])/i;

/** Anything that would put a file's contents in front of the model, `$(< file)` among them. `source .env` is not on it: that sets variables without showing them. */
const PRINTS = /(^|[\s;&|($`])(cat|head|tail|less|more|bat|grep|rg|egrep|fgrep|sed|awk|cut|strings|xxd|hexdump|od|base64|nl|tac|view|vim?|nano|code|open|pbcopy|jq|yq)\s|\$\(\s*</;

/** Where one simple command ends and the next begins: a separator, a pipe, a new line, a subshell or a substitution. */
const SEPARATORS = /[;&|\n()`]|\$\(/;

/**
 * Commands that name a secret file without putting what is in it in front of the model: loading it (`source`, `.`),
 * listing, testing, touching or removing it, changing its mode, and `echo`/`printf`, which print the name.
 */
const NAMES_ONLY = new Set(['source', '.', 'ls', 'test', '[', '[[', 'touch', 'chmod', 'chown', 'rm', 'stat', 'file', 'echo', 'printf', 'mkdir']);
/** Of git's commands, those that name a file without printing it. `git diff` and `git show` print it. */
const GIT_NAMES_ONLY = new Set(['add', 'rm', 'mv', 'status', 'check-ignore', 'ls-files', 'update-index', 'restore']);
/** Commands that copy a file: harmless only when the secret is where it goes, never where it comes from. */
const COPIES = new Set(['cp', 'mv', 'install', 'ln']);
/** Words in front of a command that leave it the same command. */
const PREFIXES = new Set(['sudo', 'command', 'builtin', 'nohup', 'time', 'exec', 'env']);
/** A here-document whose delimiter is quoted: its body is text, nothing in it runs or expands. */
const QUOTED_HEREDOC = /<<-?\s*(['"])(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2[ \t]*(?=\n|$)/g;
/** A shell started on a command string: what matters is the command inside the quotes. */
const SHELL_C = /\b(?:ba|z)?sh\s+-l?c\s+/g;
const isSecret = (word) => SECRET_FILE.test(` ${word} `);

/**
 * Whether one simple command reads a secret file it names. Read narrowly the other way round from a list of printing
 * commands, which a reader nobody listed (`sort`, `diff`, a one-line script) walks past: it reads it unless what it does
 * with it is one of the few things that never show what is in it — loading, listing, writing into it, copying onto it,
 * git's bookkeeping, or handing it to a container as its environment.
 */
function readsSecret(part) {
  // Written into, not read: a redirect's target is not an argument.
  const rest = part.replace(/\d*>>?\s*\S+/g, ' ');
  if (!SECRET_FILE.test(rest)) return false;
  // `$(< .env)` was split at its `$(`: what is left starts with the redirect.
  if (/^\s*</.test(rest)) return true;
  const words = rest.trim().replace(/^["']+/, '').split(/\s+/).filter(Boolean);
  let i = 0;
  while (i < words.length && (PREFIXES.has(words[i]) || /^\w+=/.test(words[i]))) i++;
  const [command, sub] = [words[i], words[i + 1]];
  if (NAMES_ONLY.has(command)) return false;
  if (command === 'git' && GIT_NAMES_ONLY.has(sub)) return false;
  if (COPIES.has(command)) return !isSecret(words.at(-1));
  if (command === 'docker' || command === 'podman') return SECRET_FILE.test(rest.replace(/--env-file[=\s]+\S+/g, ' '));
  return true;
}

/**
 * Whether a command puts a secret file's contents in front of the model: one of its simple commands reads the file —
 * judged command by command, not across the line, so `source .env && npm test | tail` is what it looks like — or a
 * printing command is given a variable the file was bound to earlier in the line.
 */
function printsSecret(command) {
  const parts = command.replace(/\\\n/g, ' ').replace(QUOTED_HEREDOC, '<<heredoc').replace(SHELL_C, ' ').split(SEPARATORS);
  let bound = false;
  for (const part of parts) {
    if (!SECRET_FILE.test(part)) continue;
    // Bound to a name, not read: `f=.env`, `export ENV_FILE=.env`, `for f in .env …`. What later prints `$f` is a reading.
    const first = part.trim().split(/\s+/)[0];
    if (/^\w+=/.test(first) && part.trim().split(/\s+/).every((w) => /^\w+=/.test(w))) {
      bound = true;
      continue;
    }
    if (first === 'export' || first === 'for') {
      bound = true;
      continue;
    }
    if (readsSecret(part)) return true;
  }
  return bound && parts.some((part) => PRINTS.test(part) && part.includes('$'));
}
/**
 * A command whose only job is to print the whole environment, secrets and all: `env`, `printenv`, `export`, `set`, `declare`
 * or `typeset` with nothing but flags and redirections after it. `env FOO=1 cmd`, `set -e`, `export FOO=1` and `printenv HOME` are not that.
 * A redirection is its first mark and whatever follows: `>>` read as one mark or as two is the same word, counted twice.
 */
const DUMPS_ENV = /^\s*(?:sudo\s+)?(?:(?:env|printenv|declare|typeset)(?:\s+(?:-\S+|\d*[<>&]\S*))*|export(?:\s+-p)?|set)\s*$/;

/**
 * `rm` — by any path (`/bin/rm`), escaped (`\rm`), behind sudo, env, nice, timeout or xargs — and everything up to the
 * end of its command, which a new line is too. Its flags may come before or after its targets; only a recursive spelling
 * of them is looked at further. Each word between is read one way — a word, whatever it starts with: a dash that
 * could be read apart from its word doubled the readings with every flag, and a build's worth of flags stood the check still.
 */
const RM = /(^|[\s;&|(`"'])(?:(?:sudo|env|nice|timeout|xargs|command)(?:\s+\S+)*?\s+)?\\?(?:\/\S*\/)?rm\s+([^;&|)`\n]+)/g;
const RECURSIVE = /(^|\s)(?:-[a-zA-Z]*[rR][a-zA-Z]*|--recursive)(?=\s|$)/;
const FLAG = /^-{1,2}[\w-]+$/;

/** A target that is the whole machine, the home, the working directory, or one level below any of them. */
const ROOT_OR_HOME_OR_HERE = /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\.{1,2}\/?|\*|\.{1,2}\/\*|(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)(?:[^/\s*]+\/?|\*))$/;

const unquote = (word) => word.replace(/^["']|["']$/g, '');

/** The home and the working directory spelled out in full are the same targets as `~` and `.`. */
function spelledShort(target, { cwd, home }) {
  const trimmed = target.length > 1 ? target.replace(/\/+$/, '') : target;
  if (cwd && (trimmed === cwd || trimmed === `${cwd}/*`)) return '.';
  if (home && (trimmed === home || trimmed.startsWith(`${home}/`))) return `~${trimmed.slice(home.length)}`;
  return target;
}

const RULES = [
  {
    test: (c, where) => {
      // A line ending in a backslash goes on: its targets are still rm's.
      for (const m of c.replace(/\\\n/g, ' ').matchAll(RM)) {
        const words = m[2].trim().split(/\s+/);
        // `--` ends the flags: what follows is a target, however it is spelled.
        const end = words.indexOf('--');
        const flags = (end === -1 ? words : words.slice(0, end)).filter((w) => FLAG.test(w));
        if (!RECURSIVE.test(flags.join(' '))) continue;
        const targets = (end === -1 ? words.filter((w) => !FLAG.test(w)) : words.slice(end + 1)).map(unquote).map((t) => spelledShort(t, where));
        if (targets.some((t) => ROOT_OR_HOME_OR_HERE.test(t))) return true;
      }
      return false;
    },
    why: (c) => `\`${c}\` would delete a whole tree — the machine, the home directory, the working directory, or something one level below one of them`,
  },
  { test: (c) => /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/.test(c), why: () => '`git reset --hard` throws away every uncommitted change' },
  { test: (c) => /\bgit\s+clean\s+(?:\S+\s+)*(?:-[a-zA-Z]*f|--force)/.test(c), why: () => '`git clean -f` deletes every untracked file' },
  // `git checkout .` too, and from a commit (`git checkout HEAD -- .`): every spelling that puts the whole tree back.
  { test: (c) => /\bgit\s+(?:checkout(?:\s+(?!-)\S+)?(?:\s+--)?|restore(?:\s+--worktree)?(?:\s+--)?)\s+\.(?:\s|$)/.test(c), why: () => 'restoring `.` discards every uncommitted change at once' },
  { test: (c) => /\bgit\s+branch\s+(?:\S+\s+)*-D\b/.test(c), why: () => '`git branch -D` deletes a branch whether or not it was merged' },
  { test: (c) => /\bgit\s+stash\s+(?:drop|clear)\b/.test(c), why: () => 'dropping a stash loses work that is nowhere else' },
  {
    test: (c) => /\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?)\b[\s\S]*\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i.test(c),
    why: () => 'that statement empties or drops a table or database',
  },
  { test: (c) => printsSecret(c), why: () => 'it would print a secret file (.env, a private key, credentials). Use `source`/`set -a` to load it without showing it' },
  { test: (c) => c.replace(/\\\n/g, ' ').split(SEPARATORS).some((part) => DUMPS_ENV.test(part)), why: () => 'it would print the whole environment, secrets included. A variable is for the command that needs it, never for printing' },
];

/** Why a shell command is refused, or null when it may run. `cwd` is where it would run, so its full spelling is known too. */
export function guardCommand(command, { cwd = null, home = homedir() } = {}) {
  for (const rule of RULES) {
    if (rule.test(command, { cwd, home })) return `Refused: ${rule.why(command)}. If it is what the user wants, they run it themselves: \`! ${command}\``;
  }
  return null;
}

export const isSecretPath = (path) => SECRET_FILE.test(path);

/** Why reading a file is refused, or null when it may be read. */
export function guardPath(path) {
  return isSecretPath(path) ? `Refused: ${path} is a secret file. Its values are for the environment, not the context — load it with \`source\` where it is needed, and ask the user what it holds.` : null;
}
