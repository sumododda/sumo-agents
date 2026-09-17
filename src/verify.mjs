import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { UsageError } from './memory.mjs';
import { verifyCommands } from './scan.mjs';

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
const MAX_SCANNED_FILE_BYTES = 200_000;

/** Paths whose job is to judge other code. Fixtures beside tests count: editing one can weaken the test that reads it. */
const TEST_PATH = /(^|\/)(tests?|__tests__|specs?)\/|[._](test|spec)\.[a-z]+$|(^|\/)test_[^/]+\.py$/i;

/** Ways of telling a checker to look away. Reported, never blocking: each has honest uses, and a person should see them. */
const LOOKS_AWAY =
  /eslint-disable|@ts-ignore|@ts-nocheck|@ts-expect-error|#\s*noqa|#\s*type:\s*ignore|pylint:\s*disable|\/\/\s*nolint|#\[ignore\]|\b(?:it|test|describe)\.(?:skip|only)\b|\bx(?:it|describe)\(|@pytest\.mark\.skip|@unittest\.skip|\bt\.Skip\(|@Disabled\b|@Ignore\b/;

function git(root, args) {
  try {
    return execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 });
  } catch {
    return null;
  }
}

const lines = (text) => (text ?? '').split('\n').filter(Boolean);

/** A repository with at least one commit — the least there must be for "what changed" to mean anything. */
export const hasCommit = (root) => Boolean(git(root, ['rev-parse', 'HEAD'])?.trim());

/**
 * Whether the recorded start can still be compared against. Nothing points at
 * a snapshot commit, so git may collect it from a job left open for weeks —
 * and a diff against a missing commit looks exactly like "nothing changed".
 */
const stillThere = (root, snap) => git(root, ['cat-file', '-e', `${snap.base}^{commit}`]) !== null;

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
  const snap = {
    base: stashed || head,
    // A dirty tree that could not be captured (no git identity, say) leaves earlier edits mixed into the job's.
    mixed: dirty && !stashed,
    untracked: lines(git(root, ['ls-files', '--others', '--exclude-standard', '--', '.'])),
  };
  // The tree before any work, so "has anything changed yet?" is a comparison and not a guess.
  return { ...snap, fingerprint: changesSince(root, snap).fingerprint };
}

/** What differs from the snapshot now, and a fingerprint of it, so a verdict can be tied to the exact tree it judged. */
export function changesSince(root, snap) {
  const tracked = lines(git(root, ['diff', '--name-status', snap.base, '--', '.'])).map((l) => {
    const [status, ...paths] = l.split('\t');
    return { status: status[0], path: paths[0], to: paths[1] ?? null };
  });
  const before = new Set(snap.untracked);
  const created = lines(git(root, ['ls-files', '--others', '--exclude-standard', '--', '.'])).filter((f) => !before.has(f));
  const hash = createHash('sha256').update(git(root, ['diff', snap.base, '--', '.']) ?? '');
  for (const file of created) hash.update(`\0${file}:${git(root, ['hash-object', '--', file])?.trim() ?? ''}`);
  return { tracked, created, fingerprint: hash.digest('hex') };
}

function timeoutMs() {
  const asked = Number(process.env.SUMO_AGENTS_CHECK_TIMEOUT_MS);
  return Number.isFinite(asked) && asked > 0 ? asked : DEFAULT_TIMEOUT_MS;
}

/** Runs each command where the project lives and keeps the end of what it printed, which is where runners put the failures. */
function runChecks(root, commands, dir, prefix) {
  return commands.map(({ name, command }) => {
    const started = Date.now();
    const run = spawnSync(command, { cwd: root, shell: true, encoding: 'utf8', timeout: timeoutMs(), killSignal: 'SIGKILL', maxBuffer: 64 * 1024 * 1024 });
    const timedOut = run.error?.code === 'ETIMEDOUT';
    const output = `${run.stdout ?? ''}${run.stderr ?? ''}`.trimEnd().split('\n').slice(-OUTPUT_TAIL_LINES).join('\n');
    const file = join(dir, `${prefix}-${name}.txt`);
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
  if (snap && changesSince(root, snap).fingerprint !== snap.fingerprint) {
    return { refused: 'files have already changed since this job began, so a baseline now would include your own edits' };
  }
  return { checks: runChecks(root, verifyCommands(root), dir, 'baseline') };
}

function lookingAway(root, snap, changes) {
  const found = [];
  let file = null;
  let at = 0;
  for (const l of (git(root, ['diff', '-U0', snap.base, '--', '.']) ?? '').split('\n')) {
    if (l.startsWith('+++ ')) file = l.slice(6);
    else if (l.startsWith('@@')) at = Number(/\+(\d+)/.exec(l)?.[1] ?? 0) - 1;
    else if (l.startsWith('+')) {
      at++;
      if (LOOKS_AWAY.test(l)) found.push(`${file}:${at}`);
    }
  }
  for (const created of changes.created) {
    try {
      const full = join(root, created);
      if (statSync(full).size > MAX_SCANNED_FILE_BYTES) continue;
      readFileSync(full, 'utf8').split('\n').forEach((l, i) => LOOKS_AWAY.test(l) && found.push(`${created}:${i + 1}`));
    } catch {
      // unreadable or binary: nothing to say about it
    }
  }
  return found;
}

/**
 * The verdict. `blocking` is what stops a job being called done; `flags` are
 * for a person to look at; `notes` say what could not be known.
 */
export function verify(root, { snap, baseline, testsMayChange }, dir, now = new Date().toISOString()) {
  const blocking = [];
  const flags = [];
  const notes = [];

  const before = new Map((baseline ?? []).map((c) => [c.name, c]));
  const checks = runChecks(root, verifyCommands(root), dir, 'verify').map((c) => {
    const was = before.get(c.name);
    const state = c.ok ? 'pass' : was && !was.ok ? 'already-failing' : 'fail';
    if (state === 'fail') {
      const why = c.timedOut ? 'ran past the time limit' : 'fails';
      blocking.push(
        was
          ? `\`${c.command}\` ${why}, and it passed when this job began — read ${c.file}`
          : `\`${c.command}\` ${why}, and no baseline was taken before the work, so the failure counts as this job's — read ${c.file}`,
      );
    }
    if (state === 'already-failing') notes.push(`\`${c.command}\` was already failing when this job began; compare ${was.file} with ${c.file} to see nothing new broke`);
    return { name: c.name, command: c.command, state, file: c.file };
  });
  if (checks.length === 0) notes.push('this project declares no check, test, lint or typecheck command — nothing was run');

  let fingerprint = null;
  if (snap && !stillThere(root, snap)) {
    notes.push('the recorded start of this job is no longer in the repository — what changed, and whether existing tests were touched, could not be checked');
  } else if (snap) {
    const changes = changesSince(root, snap);
    fingerprint = changes.fingerprint;
    if (snap.mixed) notes.push('the tree had uncommitted edits that could not be set aside when this job began; "what changed" may include them');
    const judges = changes.tracked.filter((c) => c.status !== 'A' && TEST_PATH.test(c.path)).map((c) => c.path);
    if (judges.length > 0 && !testsMayChange) {
      blocking.push(`tests that were already here were changed: ${judges.join(', ')} — they judge this change and are not part of it. If one is genuinely wrong, say why: mem job ask`);
    }
    const away = lookingAway(root, snap, changes);
    if (away.length > 0) flags.push(`added lines tell a checker to look away (skip, ignore, disable): ${away.slice(0, 8).join(', ')}${away.length > 8 ? ` and ${away.length - 8} more` : ''}`);
  } else {
    notes.push('not a git repository — what changed, and whether existing tests were touched, could not be checked');
  }

  return { at: now, ok: blocking.length === 0, fingerprint, checks, blocking, flags, notes };
}

/** The whole change as one file — what a reviewer reads instead of re-deriving it with git. */
export function writeChanges(root, snap, file) {
  if (!stillThere(root, snap)) throw new UsageError(`the recorded start of that work (${snap.base.slice(0, 12)}) is no longer in the repository — there is no change to hand over`);
  const changes = changesSince(root, snap);
  const parts = [
    `# Changes since ${snap.base.slice(0, 12)} in ${root}`,
    snap.mixed ? '\n(uncommitted edits that were already there when the work began may be mixed in)' : '',
    '\n## Files',
    git(root, ['diff', '--stat', snap.base, '--', '.'])?.trimEnd() || '(no tracked file changed)',
    ...changes.created.map((f) => ` new file: ${f}`),
    '\n## Diff',
    git(root, ['diff', '-U10', snap.base, '--', '.'])?.trimEnd() ?? '',
  ];
  for (const created of changes.created) {
    // `--no-index` exits 1 when the files differ, which is every time; the diff is on stdout either way.
    const run = spawnSync('git', ['-C', root, 'diff', '--no-index', '--', '/dev/null', created], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
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
