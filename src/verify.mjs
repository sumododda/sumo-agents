import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isSecretPath } from './guard.mjs';
import { UsageError } from './memory.mjs';
import { secretShape } from './redact.mjs';
import { verifyCommands } from './scan.mjs';
import { killGroup } from './tools.mjs';

/**
 * A job's work, judged by running things rather than by reading the report.
 *
 * One discipline, kept in one place: whoever did the work does not grade it.
 * The project's own checks are run before the work and after it, so a failure
 * that was already there is never blamed on the job and a new one is never
 * waved through; and the tests that judge a change are not part of the change.
 *
 * Everything degrades rather than blocks when it cannot know: a project that is
 * not in git has no "what changed", a project with no commands has nothing to
 * run, and both are said in the verdict instead of being guessed at.
 */

const DEFAULT_TIMEOUT_MS = 540_000; // under the ten minutes a harness gives one shell command
const OUTPUT_TAIL_LINES = 200;
/** How much of a log's end is read to find those lines: a check can print far more than is ever kept. */
const OUTPUT_TAIL_BYTES = 1024 * 1024;
const MAX_SCANNED_FILE_BYTES = 200_000;

/** Paths whose job is to judge other code. Fixtures beside tests count: editing one can weaken the test that reads it. */
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|[._](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;

/**
 * The settings of a checker — the type checker, the linter, the test runner. Changing one can loosen what judges the
 * change (`"strict": false`, a test path ignored) as surely as editing a test can. Flagged for a person, not blocking:
 * a new path alias or a new lint rule are honest reasons to touch one.
 */
const CHECKER_CONFIG =
  /(^|\/)(tsconfig[^/]*\.json|jsconfig\.json|\.eslintrc[^/]*|eslint\.config\.[cm]?[jt]s|(jest|vitest|karma|playwright)\.config\.[cm]?[jt]s|pytest\.ini|tox\.ini|setup\.cfg|conftest\.py|\.flake8|mypy\.ini|ruff\.toml|\.golangci\.ya?ml|phpunit\.xml(\.dist)?|\.rubocop\.yml)$/;

/** Ways of telling a checker to look away. Reported, never blocking: each has honest uses, and a person should see them. */
const LOOKS_AWAY =
  /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*noqa|#\s*type:\s*ignore|pylint:\s*disable|\/\/\s*nolint|#\[ignore\]|\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|@Disabled\b|@Ignore\b/;

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/** A diff as git itself writes it, whatever the user has configured: no external tool, no colour, the usual prefixes — it is parsed, hashed and handed to a reviewer. */
const DIFF = ['diff', '--no-ext-diff', '--no-color', '--no-textconv', '--src-prefix=a/', '--dst-prefix=b/'];

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

/** A repository with at least one commit — the least there must be for "what changed" to mean anything. */
export const hasCommit = (root) => Boolean(git(root, ['rev-parse', 'HEAD'])?.trim());

/**
 * Whether the recorded start can still be compared against. Nothing points at
 * a snapshot commit, so git may collect it from a job left open for weeks —
 * and a diff against a missing commit looks exactly like "nothing changed".
 */
/** The content hash of each file that is there, asked of git in one call; a file that is gone has none. */
function hashesOf(root, files) {
  // An untracked repository inside the project is listed as `dir/`: it has no content hash, and asking for one fails the call for every file.
  const there = files.filter((f) => !f.endsWith('/') && existsSync(join(root, f)));
  if (there.length === 0) return new Map();
  try {
    const out = execFileSync('git', ['-C', root, 'hash-object', '--stdin-paths'], { input: `${there.join('\n')}\n`, encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
    return new Map(out.split('\n').slice(0, there.length).map((hash, i) => [there[i], hash]));
  } catch {
    // One path git will not hash (a directory, an odd name) must not hide the others: they are asked one at a time.
    return new Map(there.map((f) => [f, git(root, ['hash-object', '--', f])?.trim()]).filter(([, hash]) => hash));
  }
}

export const stillThere = (root, snap) => git(root, ['cat-file', '-e', `${snap.base}^{commit}`]) !== null;

/**
 * Where the work starts from. `git stash create` writes the tree as it is —
 * uncommitted edits included — into a commit nobody points at, touching neither
 * the index nor the files, so "what this job changed" never includes what the
 * user had already changed.
 */
export function snapshot(root) {
  const head = git(root, ['rev-parse', 'HEAD'])?.trim();
  if (!head) return null; // not a repository, or one with no commit to compare against
  const stashed = git(root, ['stash', 'create'])?.trim();
  const dirty = lines(git(root, ['status', '--porcelain', '--', '.'])).some((l) => !l.startsWith('??'));
  const untracked = lines(git(root, ['ls-files', '--others', '--exclude-standard', '--', '.']));
  const snap = {
    base: stashed || head,
    // A dirty tree that could not be captured (no git identity, say) leaves earlier edits mixed into the job's.
    mixed: dirty && !stashed,
    untracked,
    // git says nothing about a file it does not track, so what each one held is written down here.
    hashes: Object.fromEntries(hashesOf(root, untracked)),
  };
  // The tree before any work, so "has anything changed yet?" is a comparison and not a guess.
  return { ...snap, fingerprint: changesSince(root, snap).fingerprint };
}

/** What differs from the snapshot now, and a fingerprint of it, so a verdict can be tied to the exact tree it judged. */
export function changesSince(root, snap) {
  // A diff git could not give — the start is gone, or the diff is too large to read — is not "nothing changed".
  const diff = git(root, [...DIFF, snap.base, '--', '.']);
  if (diff === null) throw new UsageError(`what changed in ${root} since ${snap.base.slice(0, 12)} could not be read from git — the recorded start is gone, or the diff is too large`);
  const tracked = lines(git(root, [...DIFF, '--name-status', snap.base, '--', '.'])).map((l) => {
    const [status, ...paths] = l.split('\t');
    return { status: status[0], path: paths[0], to: paths[1] ?? null };
  });
  const before = new Set(snap.untracked);
  const created = lines(git(root, ['ls-files', '--others', '--exclude-standard', '--', '.'])).filter((f) => !before.has(f));
  // A file that was there before the work but never added to git: its content is compared with what was written down, since git will not.
  const was = Object.entries(snap.hashes ?? {});
  const now = hashesOf(root, [...created, ...was.map(([file]) => file)]);
  const outside = was.filter(([file, hash]) => now.get(file) !== hash).map(([file]) => ({ status: now.has(file) ? 'M' : 'D', path: file, to: null, untracked: true }));
  const hash = createHash('sha256').update(diff);
  for (const file of [...created, ...outside.map((c) => c.path)]) hash.update(`\0${file}:${now.get(file) ?? ''}`);
  return { tracked: [...tracked, ...outside], created, fingerprint: hash.digest('hex') };
}

function timeoutMs() {
  const asked = Number(process.env.SUMO_AGENTS_CHECK_TIMEOUT_MS);
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TIMEOUT_MS;
}

/** The last lines of a check's log, read from its end rather than whole. */
function tailOf(file) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - OUTPUT_TAIL_BYTES);
    const bytes = Buffer.alloc(size - start);
    const lines = bytes.subarray(0, readSync(fd, bytes, 0, bytes.length, start)).toString('utf8').trimEnd().split('\n');
    // Read from inside a line, the first piece is half of one.
    if (start > 0 && lines.length > 1) lines.shift();
    return lines.slice(-OUTPUT_TAIL_LINES).join('\n');
  } finally {
    closeSync(fd);
  }
}

/** Runs each command where the project lives and keeps the end of what it printed, which is where runners put the failures. */
function runChecks(root, commands, dir, prefix) {
  const named = new Map();
  return commands.map(({ name, command }) => {
    const started = Date.now();
    // In a group of its own, the time limit reaches everything the check started. That takes it out of this process's group,
    // which is what a stop kills — so a watcher in the check's group ends it once this process is gone.
    const watcher = `(while kill -0 ${process.pid} 2>/dev/null; do sleep 1; done; kill -9 0) </dev/null >/dev/null 2>&1 &\n`;
    // Two checks of one name each keep their own output.
    const nth = (named.get(name) ?? 0) + 1;
    named.set(name, nth);
    const file = join(dir, `${prefix}-${name}${nth > 1 ? `-${nth}` : ''}.txt`);
    // Printed into the file, not a pipe: a pipe stays open while anything the check left running holds it, and would be waited on to the time limit.
    const into = openSync(file, 'w', 0o600);
    let run;
    try {
      run = spawnSync(`${watcher}${command}`, { cwd: root, shell: true, detached: true, stdio: ['ignore', into, into], timeout: timeoutMs(), killSignal: 'SIGKILL' });
    } finally {
      closeSync(into);
    }
    const timedOut = run.error?.code === 'ETIMEDOUT';
    // Whatever it left running goes with it, so nothing writes to the file once it is read.
    killGroup(run.pid);
    const output = tailOf(file);
    writeFileSync(file, `$ ${command}\n${output}\n${timedOut ? '\n(stopped: it ran past the time limit)\n' : ''}`, { mode: 0o600 });
    return { name, command, ok: run.status === 0, timedOut, ms: Date.now() - started, file };
  });
}

/**
 * The checks as they stand before the work. Refused once the tree has moved:
 * a baseline taken after the first edit would call the job's own breakage
 * "already there", which is the one thing it exists to prevent.
 */
export function takeBaseline(root, snap, dir) {
  if (snap && !stillThere(root, snap)) return { refused: 'the recorded start of this job is no longer in the repository, so there is no telling what has changed since' };
  if (snap && changesSince(root, snap).fingerprint !== snap.fingerprint) {
    return { refused: 'files have already changed since this job began, so a baseline now would include your own edits' };
  }
  return { checks: runChecks(root, verifyCommands(root), dir, 'baseline') };
}

/**
 * Every line the job added, read once: a checker told to look away is flagged
 * for a person; a credential shape only a real key has blocks; an assignment
 * to password= or a long random string is flagged, since a fixture has those too.
 */
function scanAdded(root, snap, changes) {
  const found = { away: [], key: [], maybe: [] };
  const look = (where, l) => {
    if (LOOKS_AWAY.test(l)) found.away.push(where);
    const shape = secretShape(l);
    if (shape) found[shape].push(where);
  };
  let file = null;
  let at = 0;
  for (const l of (git(root, [...DIFF, '-U0', snap.base, '--', '.']) ?? '').split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(6);
    else if (l.startsWith('@@')) at = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1;
    else if (l.startsWith('+')) look(`${file}:${++at}`, l);
  }
  // A new file is read whole, and so is one that git never tracked: there is no diff to take its added lines from.
  for (const created of [...changes.created, ...changes.tracked.filter((c) => c.untracked && c.status === 'M').map((c) => c.path)]) {
    try {
      const full = join(root, created);
      if (statSync(full).size > MAX_SCANNED_FILE_BYTES) continue;
      readFileSync(full, 'utf8').split('\n').forEach((l, i) => look(`${created}:${i + 1}`, l));
    } catch {
      // unreadable or binary: nothing to say about it
    }
  }
  return found;
}

const some = (list) => `${list.slice(0, 8).join(', ')}${list.length > 8 ? ` and ${list.length - 8} more` : ''}`;

/**
 * The verdict. `blocking` is what stops a job being called done; `flags` are
 * for a person to look at; `notes` say what could not be known.
 */
export function verify(root, { snap, baseline, testsMayChange, declared }, dir, now = new Date().toISOString()) {
  const blocking = [];
  const flags = [];
  const notes = [];
  const beforeChecks = snap && stillThere(root, snap) ? changesSince(root, snap).fingerprint : null;

  // The checks that judged the start judge the end: one no longer run, or rewritten, is not part of the change.
  const commands = verifyCommands(root);
  const current = new Map(commands.map((c) => [c.command, c]));
  const started = declared ?? baseline ?? [];
  const dropped = started.filter((c) => !current.has(c.command)).map((c) => `\`${c.command}\``);
  if (dropped.length > 0) blocking.push(`checks that were run when this job began are no longer run: ${dropped.join(', ')} — they judge this change and are not part of it`);
  const rewritten = started.filter((c) => c.definition !== undefined && current.has(c.command) && current.get(c.command).definition !== c.definition).map((c) => `\`${c.command}\``);
  if (rewritten.length > 0 && !testsMayChange) {
    blocking.push(`checks that were already here were changed: ${rewritten.join(', ')} — they judge this change and are not part of it. If one is genuinely wrong, say why: sumo job ask`);
  }

  // By command, not name: `cargo test` and `pytest` are both "test", and each has a start of its own.
  const before = new Map((baseline ?? []).map((c) => [c.command, c]));
  const checks = runChecks(root, commands, dir, 'verify').map((c) => {
    const was = before.get(c.command);
    const state = c.ok ? 'pass' : was && !was.ok ? 'already-failing' : 'fail';
    if (state === 'fail') {
      const why = c.timedOut ? 'ran past the time limit' : 'fails';
      blocking.push(
        was
          ? `\`${c.command}\` ${why}, and it passed when this job began — read ${c.file}`
          : `\`${c.command}\` ${why}, and no baseline was taken before the work, so the failure counts as this job's — read ${c.file}`,
      );
    }
    // A check that already failed cannot tell a new failure from the old one, so a person looks.
    if (state === 'already-failing') flags.push(`\`${c.command}\` was already failing when this job began; compare ${was.file} with ${c.file} to see nothing new broke`);
    return { name: c.name, command: c.command, state, file: c.file };
  });
  if (checks.length === 0) notes.push('this project declares no check, test, lint or typecheck command — nothing was run');

  let fingerprint = null;
  if (snap && !stillThere(root, snap)) {
    notes.push('the recorded start of this job is no longer in the repository — what changed, and whether existing tests were touched, could not be checked');
  } else if (snap) {
    const changes = changesSince(root, snap);
    fingerprint = changes.fingerprint;
    if (beforeChecks !== null && beforeChecks !== fingerprint) {
      blocking.push('files changed while the checks ran — run verification again on the resulting tree');
    }
    if (snap.mixed) notes.push('the tree had uncommitted edits that could not be set aside when this job began; "what changed" may include them');
    const judges = changes.tracked.filter((c) => c.status !== 'A' && TEST_PATH.test(c.path)).map((c) => c.path);
    if (judges.length > 0 && !testsMayChange) {
      blocking.push(`tests that were already here were changed: ${judges.join(', ')} — they judge this change and are not part of it. If one is genuinely wrong, say why: sumo job ask`);
    }
    const secretFiles = [...changes.tracked.filter((c) => c.status !== 'D').map((c) => c.to ?? c.path), ...changes.created].filter(isSecretPath);
    if (secretFiles.length > 0) blocking.push(`a secret file was added or changed: ${some(secretFiles)} — it belongs in the environment, never in the change`);
    const added = scanAdded(root, snap, changes);
    if (added.key.length > 0) blocking.push(`a key, token or private key was added: ${some(added.key)} — remove it and read it from the environment`);
    if (added.away.length > 0) flags.push(`added lines tell a checker to look away (skip, ignore, disable): ${some(added.away)}`);
    const settings = changes.tracked.filter((c) => c.status !== 'A' && CHECKER_CONFIG.test(c.path)).map((c) => c.path);
    if (settings.length > 0) flags.push(`a checker's settings were changed: ${some(settings)} — see that nothing it checked was loosened`);
    if (added.maybe.length > 0) flags.push(`added lines look like credentials (password=, token=, or a long random string): ${some(added.maybe)}`);
  } else {
    notes.push('not a git repository — what changed, and whether existing tests were touched, could not be checked');
  }

  return { at: now, ok: blocking.length === 0, fingerprint, checks, blocking, flags, notes };
}

/** The whole change as one file — what a reviewer reads instead of re-deriving it with git. */
export function writeChanges(root, snap, file) {
  if (!stillThere(root, snap)) throw new UsageError(`the recorded start of that work (${snap.base.slice(0, 12)}) is no longer in the repository — there is no change to hand over`);
  const changes = changesSince(root, snap);
  const outside = changes.tracked.filter((c) => c.untracked);
  const parts = [
    `# Changes since ${snap.base.slice(0, 12)} in ${root}`,
    snap.mixed ? '\n(uncommitted edits that were already there when the work began may be mixed in)' : '',
    '\n## Files',
    git(root, [...DIFF, '--stat', snap.base, '--', '.'])?.trimEnd() || '(no tracked file changed)',
    ...changes.created.map((f) => ` new file: ${f}`),
    ...outside.map((c) => ` ${c.status === 'D' ? 'removed' : 'changed'} (it was never in git): ${c.path}`),
    '\n## Diff',
    git(root, [...DIFF, '-U10', snap.base, '--', '.'])?.trimEnd() ?? '',
  ];
  // What git never tracked has no earlier side to show: a new file, and one changed outside git, are given whole.
  for (const created of [...changes.created, ...outside.filter((c) => c.status === 'M').map((c) => c.path)]) {
    // `--no-index` exits 1 when the files differ, which is every time; the diff is on stdout either way.
    const run = spawnSync('git', ['-C', root, '-c', 'core.quotePath=false', ...DIFF, '--no-index', '--', '/dev/null', created], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    parts.push(run.stdout?.trimEnd() ?? '');
  }
  writeFileSync(file, `${parts.filter(Boolean).join('\n')}\n`, { mode: 0o600 });
  return { file, files: changes.tracked.length + changes.created.length };
}

/** One line per check, for a status line or a report. */
export function verdictLines(verdict) {
  const words = { pass: 'passed', fail: 'FAILED', 'already-failing': 'was already failing' };
  return [
    ...verdict.checks.map((c) => `\`${c.command}\` ${words[c.state]}`),
    ...verdict.blocking.map((b) => `blocking: ${b}`),
    ...verdict.flags.map((f) => `look at: ${f}`),
    ...verdict.notes.map((n) => `note: ${n}`),
  ];
}
