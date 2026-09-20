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

/** A file whose contents are a secret: reading it is refused, and a change that adds one is never DONE. */
const SECRET_FILE =
  /(^|[\s/'"=])(\.env(\.(?!example\b|sample\b|template\b)[\w-]+)?|\.netrc|\.aws\/credentials|\.ssh\/(?!known_hosts\b|config\b|authorized_keys\b)[\w.-]+(?<!\.pub)|id_(rsa|dsa|ecdsa|ed25519)(?!\.pub)|[\w.-]+\.(pem|key|p12|pfx))(?=$|[\s'"|;&)])/;

/** Anything that would put a file's contents in front of the model. `source .env` is not on it: that sets variables without showing them. */
const PRINTS = /(^|[\s;&|($`])(cat|head|tail|less|more|bat|grep|rg|egrep|fgrep|sed|awk|cut|strings|xxd|hexdump|od|base64|nl|tac|view|vim?|nano|code|open|pbcopy|jq|yq)\s/;

/** `rm`, its flags, and its targets. Only a recursive spelling of the flags is looked at further. */
const RM = /(^|[\s;&|(`"'])(?:sudo\s+)?rm((?:\s+-{1,2}[\w-]+)+)\s+([^;&|)`]+)/g;
const RECURSIVE = /(^|\s)(?:-[a-zA-Z]*[rR]|--recursive)/;

/** A target that is the whole machine, the home, the working directory, or one level below any of them. */
const ROOT_OR_HOME_OR_HERE = /^(?:\/|~\/?|\$HOME\/?|\$\{HOME\}\/?|\.{1,2}\/?|\*|\.{1,2}\/\*|(?:\/|~\/|\$HOME\/|\$\{HOME\}\/)(?:[^/\s*]+\/?|\*))$/;

const unquote = (word) => word.replace(/^["']|["']$/g, '');

const RULES = [
  {
    test: (c) => {
      for (const m of c.matchAll(RM)) {
        if (!RECURSIVE.test(m[2])) continue;
        const targets = m[3].trim().split(/\s+/).map(unquote);
        if (targets.some((t) => ROOT_OR_HOME_OR_HERE.test(t))) return true;
      }
      return false;
    },
    why: (c) => `\`${c}\` would delete a whole tree — the machine, the home directory, the working directory, or something one level below one of them`,
  },
  { test: (c) => /\bgit\s+reset\s+(?:\S+\s+)*--hard\b/.test(c), why: () => '`git reset --hard` throws away every uncommitted change' },
  { test: (c) => /\bgit\s+clean\s+(?:\S+\s+)*(?:-[a-zA-Z]*f|--force)/.test(c), why: () => '`git clean -f` deletes every untracked file' },
  { test: (c) => /\bgit\s+(?:checkout\s+--|restore(?:\s+--worktree)?)\s+\.(?:\s|$)/.test(c), why: () => 'restoring `.` discards every uncommitted change at once' },
  { test: (c) => /\bgit\s+branch\s+(?:\S+\s+)*-D\b/.test(c), why: () => '`git branch -D` deletes a branch whether or not it was merged' },
  { test: (c) => /\bgit\s+stash\s+(?:drop|clear)\b/.test(c), why: () => 'dropping a stash loses work that is nowhere else' },
  {
    test: (c) => /\b(?:psql|mysql|mariadb|sqlite3|sqlcmd|mongosh?)\b[\s\S]*\b(?:DROP\s+(?:TABLE|DATABASE|SCHEMA)|TRUNCATE)\b/i.test(c),
    why: () => 'that statement empties or drops a table or database',
  },
  { test: (c) => PRINTS.test(c) && SECRET_FILE.test(c), why: () => 'it would print a secret file (.env, a private key, credentials). Use `source`/`set -a` to load it without showing it' },
];

/** Why a shell command is refused, or null when it may run. */
export function guardCommand(command) {
  for (const rule of RULES) {
    if (rule.test(command)) return `Refused: ${rule.why(command)}. If it is what the user wants, they run it themselves: \`! ${command}\``;
  }
  return null;
}

export const isSecretPath = (path) => SECRET_FILE.test(path);

/** Why reading a file is refused, or null when it may be read. */
export function guardPath(path) {
  return isSecretPath(path) ? `Refused: ${path} is a secret file. Its values are for the environment, not the context — load it with \`source\` where it is needed, and ask the user what it holds.` : null;
}
