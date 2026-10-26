import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { usableModels } from './catalog.mjs';
import { getMeta, setMeta, tx } from './db.mjs';
import { autoGuides, guideBody, matchGuide, WORKER_GUIDES } from './guides.mjs';
import { heldBy } from './lock.mjs';
import { UsageError } from './memory.mjs';
import { callModel, failure, logRun } from './model.mjs';
import { paths } from './paths.mjs';
import { preferences } from './prime.mjs';
import { getProject, isScratch } from './projects.mjs';
import { chooseRoute, RETRY_IMPORTANT_THRESHOLD, statsLines } from './route.mjs';
import { verifyCommands } from './scan.mjs';
import { runScribe } from './scribe.mjs';
import { addCheckpoint, pendingTurns } from './sessions.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { clip, estimateTokens, head, STOPWORDS } from './text.mjs';
import { changesSince, diffStat, hasCommit, snapshot, stillThere, takeBaseline, verdictLines, verify, writeChanges } from './verify.mjs';
import { bringBack, dropTree, makeTree, treeDiff } from './worktree.mjs';

const AGENTS = ['scout', 'worker', 'reviewer'];
/** Work with a written way of doing it: guides/<name>.md, carried into the brief on request. */
const GUIDES = ['fix', 'feature', 'review'];
const BRIEF_CARD_BUDGET = 400;
/** The user's own rules — global preferences and decisions — ride with every brief, the way the memory block opens every chat. */
const BRIEF_RULES_BUDGET = 400;
/** Where the project stands as a job begins — branch, what is uncommitted, the top level, the toolchain — heading included. */
const BRIEF_SITUATION_BUDGET = 150;
const MAX_LEARNED = 5;

export function parseJobId(raw) {
  const match = /^j?(\d+)$/.exec(String(raw ?? '').trim());
  if (!match) throw new UsageError(`"${raw}" is not a job id — ids look like j17`);
  return Number(match[1]);
}

export function getJob(db, id) {
  const job = db.prepare('SELECT * FROM jobs WHERE id = ?').get(id);
  if (!job) throw new UsageError(`no job j${id}`);
  return job;
}

const dirOf = (id) => join(paths().jobs, String(id));
const fileOf = (id, name) => join(dirOf(id), name);
const readOr = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

/** The lock a job's run holds while it runs (src/loop.mjs): it names the process. */
export const runLockFile = (id) => fileOf(id, 'run.lock');
/** Whether a job is being run right now: its run lock held by a live process. One a stop left open — budget, time, Esc — is not. */
const atWork = (id) => heldBy(runLockFile(id)) !== null;
/** How long a worker made and not yet run still counts as at work: the time between `sumo job new` and its run. */
const FRESH_MS = 10 * 60_000;
/** The open workers in a project, but one, the newest first. */
const openWorkers = (db, slug, id) => db.prepare(`SELECT * FROM jobs WHERE project = ? AND agent = 'worker' AND status IN ('running', 'needs_input') AND id <> ? ORDER BY id DESC`).all(slug, id);
/** A meta key taken off, so what it marked can happen again. */
const unmark = (db, key) => db.prepare('DELETE FROM meta WHERE key = ?').run(key);
function setStatus(db, id, status, now) {
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
}

/**
 * A change of state that holds only while the job is still open. A note or a question is written to disk between the
 * check and the change: a job abandoned or closed meanwhile stays as it was left, never reopened by a status read earlier.
 */
function setOpenStatus(db, id, status, now) {
  db.prepare(`UPDATE jobs SET status = COALESCE(?, status), updated_at = ? WHERE id = ? AND status IN ('running', 'needs_input')`).run(status, now, id);
}

function requireOpen(job, verb) {
  if (job.status !== 'running' && job.status !== 'needs_input') throw new UsageError(`j${job.id} is ${job.status} — it cannot be ${verb}`);
}

const ROLE = {
  worker: 'You are a worker: you build, fix and change things in the project below.',
  scout:
    'You are a scout: you investigate the project below and report what you found. You have no edit tools and none can be granted — ' +
    'that is by design, so do not look for one. If something should change, say exactly what and in which file.',
  reviewer:
    'You are a reviewer: you judge a change somebody else made in the project below. You did not write it and you owe it nothing. ' +
    'You have no edit tools and none can be granted — that is by design. If something should change, say exactly what and in which file.',
};

const LEARNED = `## Learned             usually "none". Only a trap that cost you time and would cost the next person time —
                           a required env var, a misleading error, a command that silently does the wrong thing.
                           What you found out belongs in Summary, not here.`;

/** What each kind of sub-agent sends back. The headings are read by code and by the main agent, so they are fixed. */
const REPORT = {
  scout: `    ## Summary
    ## Files changed        one line each: <path> — <what changed>
    ## Check               the command you ran and what it printed; or why there is none
    ${LEARNED}`,
  worker: `    ## Summary
    ## Files changed        one line each: <path> — <what changed>
    ## Check               the command you ran and what it printed; or why there is none
    ## Concerns            "none", or what you finished but are not sure of. Never hand over doubt silently.
    ## Decisions           "none", or each call you made for the user: what — why — what it costs if wrong
    ${LEARNED}`,
  reviewer: `    ## Summary             one line: does it do what was asked, and can it be trusted as it stands
    ## Asked vs built      missing · extra · misunderstood — or "matches"
    ## Findings            numbered, worst first: \`1. <file:line> — how it fails, concretely — the smallest fix or test\`. No praise, no rewrites.
    ## Minor               listed, never a reason to reopen the work
    ## Could not verify    what the change alone cannot show — it lives in code that did not change
    ${LEARNED}`,
};

/** How a worker's result gets judged. Said up front, because a rule met only at the end reads as a trap. */
function workerRules(job, { testsMayChange }) {
  return `- Before you edit anything: \`baseline\` (allow it ten minutes). It runs the project's checks and records what already fails, so none of that is blamed on you — and nothing you break can hide behind it.
- Tests that are already here judge your change; they are not part of it. ${
    testsMayChange
      ? 'This task may change them — say in the report which, and why.'
      : `Do not edit, skip or delete one. A test that is genuinely wrong, or that contradicts the task: stop and say why with \`ask\`.`
  } Never loosen a lint or type setting, add an ignore, or special-case a test's input to get green.
- A question you can settle yourself: decide, carry on, and list it under Decisions. Stop and ask only for something destructive or irreversible, security-sensitive, outside this project, or a task so unclear that every path is a guess.
- You do not start other jobs. Review comes after you, from someone who did not write the code.
- At each major milestone (a phase of the task done) \`note\` one line — \`<what now works>; next: <step>\`. Nothing else in between.
- A task of several steps: \`note\` the plan first, as a checklist — one \`- [ ] <step>\` a line — and at each milestone note the list again, whole, with what is done ticked \`- [x]\`; the latest list is put back in front of you as you work.
`;
}

/** The toolchains a project's own files call for, and the command that says each one's version. */
const TOOLCHAINS = [
  { name: 'node', files: ['package.json'], command: 'node', args: ['-v'] },
  { name: 'go', files: ['go.mod'], command: 'go', args: ['version'] },
  { name: 'python', files: ['pyproject.toml', 'requirements.txt'], command: 'python3', args: ['--version'] },
  { name: 'cargo', files: ['Cargo.toml'], command: 'cargo', args: ['--version'] },
];
const LOOK_TIMEOUT_MS = 3000;
const STATUS_LINES = 15;
const TOP_LEVEL_NAMES = 30;

/** As many of `items` as fit in `room` tokens, `max` at most, as `say(shown, left)` puts them: whole items are left out to fit, and counted. */
function fitted(items, max, room, say) {
  let shown = items.slice(0, max);
  while (shown.length > 0 && estimateTokens(say(shown, items.length - shown.length)) > room) shown = shown.slice(0, -1);
  return say(shown, items.length - shown.length);
}

/**
 * Where the project stands as a job begins — its branch, what is uncommitted, what is at its top level, the toolchain
 * its files call for — so the job's first turns are not spent finding out. Each command is given three seconds and
 * left out if it fails; outside git there are no git lines. What is uncommitted matters most, so the top level takes
 * at most half the room. Empty when there is nothing to say.
 */
function whereThingsStand(root) {
  const run = (command, args) => {
    try {
      return execFileSync(command, args, { cwd: root, encoding: 'utf8', timeout: LOOK_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'ignore'] });
    } catch {
      return null;
    }
  };
  const git = (...args) => run('git', ['--no-optional-locks', '-c', 'core.quotePath=false', ...args]);
  const repo = git('rev-parse', '--is-inside-work-tree')?.trim() === 'true';
  const heading = '## Where things stand as this job begins — no need to look it up again';
  const lines = [];
  if (repo) {
    const branch = git('branch', '--show-current')?.trim();
    const head = branch ? null : git('rev-parse', '--short', 'HEAD')?.trim();
    if (branch || head) lines.push(`Branch: ${branch || `none — detached at ${head}`}`);
  }
  const versions = TOOLCHAINS.filter((t) => t.files.some((f) => existsSync(join(root, f)))).flatMap((t) => {
    const version = /\d+(?:\.\d+)+/.exec(run(t.command, t.args) ?? '')?.[0];
    return version ? [`${t.name} ${version}`] : [];
  });
  if (versions.length > 0) lines.push(`Toolchain: ${versions.join(' · ')}`);

  const cost = (text) => estimateTokens(text) + 1;
  let room = BRIEF_SITUATION_BUDGET - cost(heading) - lines.reduce((sum, line) => sum + cost(line), 0);
  const status = repo ? git('status', '--short', '--', '.') : null;
  let names = null;
  try {
    names = readdirSync(root).filter((name) => !name.startsWith('.')).sort((a, b) => a.localeCompare(b));
  } catch {
    // A folder that cannot be read has no top level to show.
  }
  if (names) {
    const isDir = (name) => {
      try {
        return statSync(join(root, name)).isDirectory();
      } catch {
        return false;
      }
    };
    const marked = names.map((name, i) => (i < TOP_LEVEL_NAMES && isDir(name) ? `${name}/` : name));
    const line = fitted(marked, TOP_LEVEL_NAMES, (status === null ? room : room / 2) - 1, (shown, left) => `Top level: ${[...shown, ...(left > 0 ? [`… ${left} more`] : [])].join(' ') || 'nothing'}`);
    lines.push(line);
    room -= cost(line);
  }
  if (status !== null) {
    const changed = status.split('\n').filter((l) => l.trim());
    lines.push(changed.length === 0 ? 'git status --short: clean' : fitted(changed, STATUS_LINES, room - 1, (shown, left) => ['git status --short:', ...shown, ...(left > 0 ? [`… ${left} more`] : [])].join('\n')));
  }
  return lines.length > 0 ? [heading, ...lines].join('\n') : '';
}

function renderBrief({ job, project, known, rules, situation, task, guide, change, options = {} }) {
  const closing =
    job.agent === 'worker'
      ? `\`finish\` with DONE (or FAILED). DONE is not taken on your word: the first is answered with the task beside your change, to look over once more; the next has the project's checks run and compared with the baseline, and is refused while something new fails. See the verdict first with \`verify\` (allow it ten minutes). The report:`
      : `\`finish\` with DONE (or FAILED), and this report:`;
  return `# Job j${job.id} — ${job.title}

${ROLE[job.agent]}
Work only inside: ${project.path}   (bash starts there; give files by absolute path)

## What is already known about this project
${known}
${rules ? `\n## The user's standing rules — they hold here too\n${rules}\n` : ''}${situation ? `\n${situation}\n` : ''}
## The task
${task.trim()}
${change ? `\n## The change to judge\n${change}\n` : ''}${guide ? `\n## How this kind of work is done here\n${guide}\n` : ''}
## How to work
${job.agent === 'worker' ? workerRules(job, options) : ''}- Worth keeping if you are interrupted — what you found, what you tried, what is left: \`note\`.
- When finished you must close the job, or nobody knows it ended: ${closing}
${REPORT[job.agent]}
`;
}

const digest = (text) => createHash('sha256').update(text).digest('hex');
const stateKey = (id) => `job.${id}.verify`;

/**
 * What code has recorded about a job's work: where it began, what already failed, and the last verdict.
 * The job's shell can reach its folder, so the file is checked against the digest sumo kept when it wrote it:
 * a record changed since — a baseline made to fail, a verdict made to pass — reads as none.
 */
export const readState = (db, id) => {
  try {
    const text = readFileSync(fileOf(id, 'verify.json'), 'utf8');
    const kept = getMeta(db, stateKey(id));
    if (kept !== null && kept !== digest(text)) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
};
/** Written whole and then put in place: a run that dies half-way must not leave a record that reads as none. */
const writeState = (db, id, state) => {
  const text = `${JSON.stringify(state, null, 2)}\n`;
  const whole = fileOf(id, 'verify.json.part');
  writeFileSync(whole, text, { mode: 0o600 });
  setMeta(db, stateKey(id), digest(text));
  renameSync(whole, fileOf(id, 'verify.json'));
};

/** The written way of doing one kind of work, without its title — the brief has its own heading for it. */
export function guideFor(name) {
  if (!GUIDES.includes(name)) throw new UsageError(`--guide is one of: ${[...GUIDES, 'none'].join(', ')}`);
  const text = guideBody(name);
  if (!text) throw new UsageError(`guides/${name}.md is missing or empty`);
  return text;
}

/**
 * The guide a job carries when none is named: a reviewer always review; a worker the one its title and goal ask
 * for, the way the chat is handed one by the user's words — unless the switch is off. A scout changes nothing.
 */
function defaultGuide(db, { agent, title, task }) {
  if (agent === 'reviewer') return 'review';
  if (agent !== 'worker' || !autoGuides(db)) return null;
  return matchGuide(`${title}\n${task.split(/\n(?=## )/)[0]}`, WORKER_GUIDES);
}

/**
 * The change a reviewer is pointed at: another job's work, or whatever is
 * uncommitted right now. Settled before the job exists, so a review of nothing
 * is refused instead of created.
 */
function changeToJudge(db, { project, reviews }) {
  const lines = [];
  let snap;
  let root = project.path;
  let kept = null;
  if (reviews !== undefined) {
    const target = getJob(db, reviews);
    if (target.project !== project.slug) throw new UsageError(`j${target.id} belongs to ${target.project}, not ${project.slug}`);
    const state = readState(db, target.id);
    snap = state?.snap;
    // A change still in the worktree it was made in is judged there.
    if (state?.tree && existsSync(state.tree.path)) root = state.tree.path;
    if (!snap) throw new UsageError(`j${target.id} recorded no starting point (not a worker job, or not a git repository) — there is no change to hand over`);
    // One whose worktree is gone is judged by what it kept as it went (`changes`), not by the project against the tree's start:
    // the project holds that change and more — what git ignores, what was never added — none of it the job's.
    if (state.tree && !existsSync(state.tree.path)) kept = changes(db, target.id);
    lines.push(`What was asked: ${fileOf(target.id, 'brief.md')}   (read "## The task")`);
    if (existsSync(fileOf(target.id, 'report.md'))) {
      lines.push(`What its author says they did: ${fileOf(target.id, 'report.md')}   — claims, not facts. A stated reason never makes a finding smaller.`);
    }
  } else {
    if (!hasCommit(project.path)) throw new UsageError(`${project.path} is not a git repository with a commit — there is no change to hand over`);
    snap = { base: 'HEAD', mixed: false, untracked: [] };
  }
  if (kept) {
    if (kept.files === 0) throw new UsageError('nothing has changed — there is nothing to review');
    return { snap, lines, root, kept };
  }
  const { tracked, created } = changesSince(root, snap);
  if (tracked.length + created.length === 0) throw new UsageError('nothing has changed — there is nothing to review');
  return { snap, lines, root };
}

const reviewsFile = (id) => fileOf(id, 'reviews.json');
/** The job a reviewer job was created to judge — set once, at creation, from `--reviews`. */
function recordReviewTarget(id, targetId) {
  writeFileSync(reviewsFile(id), `${JSON.stringify({ reviews: targetId })}\n`, { mode: 0o600 });
}
function reviewTargetOf(id) {
  try {
    return JSON.parse(readFileSync(reviewsFile(id), 'utf8')).reviews;
  } catch {
    return null;
  }
}

/** How lately a scout's answer still counts for the next scout, how much of its title the new one must share, and how many are offered. */
const ASKED_DAYS = 14;
const ASKED_ALIKE = 0.6;
const ASKED_SHOWN = 2;

/** The words of a title that say what it is about: lowercased, without stop words or words under three letters. */
const titleWords = (title) => new Set((title.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? []).filter((w) => w.length >= 3 && !STOPWORDS.has(w)));

/**
 * Earlier scouts on the project, closed DONE in the last two weeks with a report, whose title has most of its words in
 * this one's: a line for each of the two closest — the newer first of two as close — saying where to read the answer.
 */
function askedBefore(db, slug, title, now) {
  const mine = titleWords(title);
  const since = new Date(Date.parse(now) - ASKED_DAYS * 86_400_000).toISOString();
  const rows = db.prepare(`SELECT id, title, updated_at FROM jobs WHERE project = ? AND agent = 'scout' AND status = 'done' AND updated_at >= ?`).all(slug, since);
  return rows
    .filter((row) => existsSync(fileOf(row.id, 'report.md')))
    .map((row) => {
      const theirs = titleWords(row.title);
      return { row, share: theirs.size === 0 ? 0 : [...theirs].filter((w) => mine.has(w)).length / theirs.size };
    })
    .filter(({ share }) => share >= ASKED_ALIKE)
    .sort((a, b) => b.share - a.share || b.row.updated_at.localeCompare(a.row.updated_at))
    .slice(0, ASKED_SHOWN)
    .map(({ row }) => `A scout answered a similar question on ${row.updated_at.slice(0, 10)} — j${row.id} "${row.title}": read it with \`sumo job show ${row.id}\` and reuse what still holds.`);
}

/**
 * Creates a job and its brief. The brief carries what memory knows about the
 * project, so the sub-agent starts with its context instead of spending turns
 * finding it — and the main agent's conversation never has to hold it. Its
 * model and effort are the local router's answer under the route policy
 * (`chooseRoute`, src/route.mjs), asked before the row is written: no answer, no job.
 * A worker that finds another one open in its git project is given a worktree of its
 * own (src/worktree.mjs), as is each of several `attempts` (`ownTree`, the route they
 * share given once). A scout is pointed at what earlier scouts answered to much the
 * same question (`askedBefore`).
 */
export async function newJob(db, { project: nameOrAlias, title, agent = 'worker', task, guide: guideName, reviews, testsMayChange = false, retryOf, start, attempts = 1, ownTree = false, route: routed, now = new Date().toISOString() }) {
  if (attempts !== 1) return newAttempts(db, { project: nameOrAlias, title, agent, task, guide: guideName, testsMayChange, attempts, now });
  if (!AGENTS.includes(agent)) throw new UsageError(`--agent is one of: ${AGENTS.join(', ')}`);
  if (!title?.trim()) throw new UsageError('a job needs a --title');
  if (!task?.trim()) throw new UsageError('describe the task on stdin — see guides/delegation.md for the five headings');
  if (reviews !== undefined && agent !== 'reviewer') throw new UsageError('--reviews goes with --agent reviewer');
  const project = getProject(db, nameOrAlias);
  // Everything that can refuse the job is settled before the job exists.
  const chosen = guideName === 'none' ? null : (guideName ?? defaultGuide(db, { agent, title, task }));
  const guide = chosen ? guideFor(chosen) : null;
  const judged = agent === 'reviewer' ? changeToJudge(db, { project, reviews }) : null;

  // A rule the user stated a minute ago may not be filed yet, and the brief is built from memory.
  if (pendingTurns(db, 1).length > 0) await runScribe(db, { now });

  const route = routed ?? (await chooseRoute(db, { agent, project, task, title: title.trim(), retryOf, reviews }));

  // A job's own stand-in session (`job:j3`, see loop.mjs) is no one's conversation: it is never the session a new job belongs to.
  const session = db.prepare(`SELECT id FROM sessions WHERE id NOT LIKE 'job:%' ORDER BY COALESCE(last_turn_at, started_at) DESC LIMIT 1`).get();
  const { job, other } = tx(db, () => {
    // A database put back from a backup has an older counter than the job folders on disk: the next id must not be one
    // whose folder is still there, or the new job reads another job's notes and report as its own.
    const onDisk = existsSync(paths().jobs) ? Math.max(0, ...readdirSync(paths().jobs).filter((name) => /^\d+$/.test(name)).map(Number)) : 0;
    const counter = db.prepare(`SELECT seq FROM sqlite_sequence WHERE name = 'jobs'`).get()?.seq ?? 0;
    if (onDisk > counter) {
      if (db.prepare(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'jobs'`).run(onDisk).changes === 0) {
        db.prepare(`INSERT INTO sqlite_sequence (name, seq) VALUES ('jobs', ?)`).run(onDisk);
      }
    }
    const { lastInsertRowid } = db
      .prepare(
        `INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason, retry_of, risky)
         VALUES (?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(project.slug, title.trim(), agent, session?.id ?? null, now, now, route.model, route.effort, route.reason, retryOf ?? null, route.risky ? 1 : 0);
    const id = Number(lastInsertRowid);
    // Asked where the job is written: of two workers made at once, the second always sees the first. Only a worker at work counts —
    // its run lock held — or one made in the last ten minutes, maybe not run yet: a job a stop left open is worked by nobody.
    const since = new Date(Date.parse(now) - FRESH_MS).toISOString();
    return { job: getJob(db, id), other: agent === 'worker' ? openWorkers(db, project.slug, id).find((o) => o.created_at >= since || atWork(o.id)) : undefined };
  });
  // Two workers in one working tree overwrite each other: in a git project the second is given a worktree of its own.
  const own = agent === 'worker' && (ownTree || other !== undefined) && hasCommit(project.path);
  let tree = null;

  // The job's files. If any of them cannot be written the job is taken back: an open job with no brief is worse than no job.
  try {
    const known = card(db, project.slug, { budget: BRIEF_CARD_BUDGET, now }).split('\n').slice(1, -1).join('\n') || 'Nothing yet.';
    const rules = preferences(db, BRIEF_RULES_BUDGET).slice(1).join('\n');
    mkdirSync(dirOf(job.id), { recursive: true, mode: 0o700 });
    if (agent === 'reviewer' && reviews !== undefined) recordReviewTarget(job.id, reviews);
    if (own) tree = makeTree(project.path, join(dirOf(job.id), 'tree'));
    const where = tree?.path ?? project.path;

    let change = null;
    if (judged) {
      const own = fileOf(job.id, 'changes.diff');
      if (judged.kept) copyFileSync(judged.kept.file, own);
      const { file, files } = judged.kept ? { file: own, files: judged.kept.files } : writeChanges(judged.root, judged.snap, own);
      change = [...judged.lines, `The whole change, ${files} file${files === 1 ? '' : 's'}: ${file}   — read it once; do not re-derive it with git.`].join('\n');
    }
    // Where a worker starts from, and the checks that judge it there, so what it changed — and only that — can be told apart later.
    // A retry is handed the first attempt's start instead — one in the project, never in a worktree made just now.
    const begin = start && !tree ? start : { snap: snapshot(where), declared: verifyCommands(where), baseline: null };
    if (agent === 'worker') writeState(db, job.id, { ...begin, testsMayChange, verdict: null, ...(tree ? { tree } : {}) });
    writeFileSync(fileOf(job.id, 'brief.md'), renderBrief({ job, project: { ...project, path: where }, known, rules, situation: whereThingsStand(where), task, guide, change, options: { testsMayChange } }), { mode: 0o600 });
    if (tree) {
      const why = ownTree
        ? 'Several attempts are made at this task, each in a git worktree of its own; the one to keep is picked once all have closed.'
        : `j${other.id} "${other.title}" is another worker open in ${project.path}, so this job has a git worktree of its own; when it is done, its change is brought back to the project.`;
      // The project's installed dependencies are linked in (makeTree): outside the job's roots, the sandbox lets it read them, never change them.
      const deps =
        tree.linked?.length > 0
          ? ` The project's installed dependencies — ${tree.linked.join(', ')} — are its own, linked in: the checks run with them, and they are read-only here; if one must be added or changed, say so in the report. A workspace package or an editable install reached through them is the project's copy, not this tree's: a check that loads one tests the project's code, not your change to it.`
          : ' If the checks need installed dependencies, install them there.';
      appendFileSync(fileOf(job.id, 'brief.md'), `\n## Where you work\n${why} Files git ignores — build output and the like — were not copied into it.${deps}\n`, { mode: 0o600 });
    }
    // A question a scout answered lately is not asked from nothing again: the brief points at those answers, and the job goes ahead.
    const asked = agent === 'scout' ? askedBefore(db, project.slug, title.trim(), now) : [];
    if (asked.length > 0) appendFileSync(fileOf(job.id, 'brief.md'), `\n## Asked before\n${asked.join('\n')}\n`, { mode: 0o600 });
  } catch (cause) {
    db.prepare('DELETE FROM jobs WHERE id = ?').run(job.id);
    try {
      if (own) dropTree(project.path, join(dirOf(job.id), 'tree'));
      rmSync(dirOf(job.id), { recursive: true, force: true });
    } catch {
      // Nothing was written there.
    }
    throw cause;
  }

  const warnings = [];
  if (agent !== 'reviewer' && !/^#{1,3}\s*(the\s+)?check\b|^check\s*:/im.test(task)) {
    warnings.push('note: the task names no check that proves the work — add a "## Check" with a command, or say why there is none');
  }
  if (other && tree) warnings.push(`note: j${other.id} "${other.title}" is already a worker in ${project.slug} — this one works in a worktree of its own, ${tree.top}, and its change is brought back when it is done`);
  else if (other) warnings.push(`note: j${other.id} "${other.title}" is already a running worker in ${project.slug} — two workers in one working tree overwrite each other. Let it finish, or: sumo job abandon ${other.id}`);
  return { job, warnings };
}

/**
 * Several attempts at one hard task, when asked for: the same brief made into sibling worker jobs, routed once, each in a
 * worktree of its own. Each is run and verified like any job; once all have closed, one verified attempt is brought back
 * (`settle`). It costs as many runs as there are attempts, so it is never the default.
 */
async function newAttempts(db, { attempts, title, ...options }) {
  if (![2, 3].includes(attempts)) throw new UsageError('--attempts is 2 or 3');
  if (options.agent !== 'worker') throw new UsageError('--attempts goes with a worker');
  if (!title?.trim()) throw new UsageError('a job needs a --title');
  const project = getProject(db, options.project);
  if (!hasCommit(project.path)) throw new UsageError(`${project.path} is not a git repository with a commit — each attempt needs a worktree of its own`);
  const made = [];
  try {
    for (let n = 1; n <= attempts; n++) {
      const first = made[0]?.job;
      const route = first && { model: first.model, effort: first.effort, reason: first.route_reason, risky: first.risky === 1 };
      made.push(await newJob(db, { ...options, title: `${title.trim()} (attempt ${n} of ${attempts})`, ownTree: true, route }));
    }
  } catch (cause) {
    // All of them, or none.
    for (const { job } of made) {
      abandon(db, job.id);
      await settle(db, job.id);
    }
    throw cause;
  }
  const ids = made.map(({ job }) => job.id);
  for (const id of ids) setMeta(db, attemptsKey(id), JSON.stringify(ids));
  return { job: made[0].job, jobs: made.map(({ job }) => job), warnings: made[0].warnings };
}

/**
 * Retries a job: same project, same title (marked as a retry), same task, with
 * what the previous attempt found carried into the new brief — and, when a review
 * judged it, that review's findings as the reviewer wrote them. The router is
 * asked again for its route, like any new job, and the route goes at least one
 * step above the attempt being retried. Only a failed job, or a done
 * one a review found enough wrong with, is eligible. A done one that worked in a worktree of its own had its change
 * brought back when it closed: its retry starts from the project as it is now, with that change already in it.
 */
export async function retry(db, id, { now = new Date().toISOString() } = {}) {
  const old = getJob(db, id);
  const eligible = old.status === 'failed' || (old.status === 'done' && (old.important ?? 0) >= RETRY_IMPORTANT_THRESHOLD);
  if (!eligible) {
    throw new UsageError(
      `j${id} is ${old.status}${old.status === 'done' ? ` (important: ${old.important ?? 0})` : ''} — only a failed job, or a done one reviewed with important >= ${RETRY_IMPORTANT_THRESHOLD}, can be retried`,
    );
  }
  const task = taskFromBrief(readOr(fileOf(id, 'brief.md')));
  if (!task) throw new UsageError(`j${id}'s brief has no "## The task" section to retry from`);

  // What the original was allowed and pointed at travels with the task: a retry of a review judges the same job,
  // and a retry of a worker keeps the permission the first attempt was given.
  const reviews = reviewTargetOf(id) ?? undefined;
  const state = readState(db, id);
  const testsMayChange = Boolean(state?.testsMayChange);
  // A worker's retry is judged from where the first attempt began, so what that attempt left in the tree is still answered for.
  // Its baseline comes too: taken again now, it would call the first attempt's breakage "already there".
  // A first attempt made in a worktree of its own left nothing in the project to answer for.
  const start = !state?.tree && state?.snap && stillThere(getProject(db, old.project).path, state.snap) ? { snap: state.snap, declared: state.declared, baseline: state.baseline } : undefined;
  const { job, warnings } = await newJob(db, { project: old.project, title: `${old.title} (retry of j${id})`, agent: old.agent, task, reviews, testsMayChange, retryOf: id, start, now });

  const oldNotes = readOr(fileOf(id, 'notes.md')).trim();
  const oldReport = readOr(fileOf(id, 'report.md')).trim();
  // What a reviewer found is what the retry is for: given in the reviewer's own words, the head of it when it is long.
  const review = reviewOf(db, old);
  const findings = review === null ? '' : findingsSection(reportOf(review)).trim();
  const judged = findings && `### What its review, j${review}, found\n${findings.length > REVIEW_FINDINGS_CHARS ? `${head(findings, REVIEW_FINDINGS_CHARS)}\n[… the rest of the review: sumo job show ${review}]` : findings}`;
  const found = [oldNotes && `### Notes\n${oldNotes}`, oldReport && `### Report\n${oldReport}`, judged].filter(Boolean).join('\n\n');
  if (found) appendFileSync(fileOf(job.id, 'brief.md'), `\n## What the previous attempt found\n${found}\n`, { mode: 0o600 });

  return { job, warnings };
}

/** How much of a review's findings a retry's brief carries: enough for every finding of a usual review, not a flood. */
const REVIEW_FINDINGS_CHARS = 1500;

/** The newest reviewer job that judged this one with `--reviews` and closed DONE: its id, or null when none did. */
function reviewOf(db, job) {
  const reviewers = db.prepare(`SELECT id FROM jobs WHERE agent = 'reviewer' AND status = 'done' AND project = ? AND id > ? ORDER BY id DESC`).all(job.project, job.id);
  return reviewers.find((r) => reviewTargetOf(r.id) === job.id)?.id ?? null;
}

/** The task text a brief was built from — everything between "## The task" and the next section renderBrief adds. */
function taskFromBrief(brief) {
  const marker = '## The task\n';
  const start = brief.indexOf(marker);
  if (start === -1) return null;
  const from = start + marker.length;
  const stops = ['\n## The change to judge\n', '\n## How this kind of work is done here\n', '\n## How to work\n']
    .map((section) => brief.indexOf(section, from))
    .filter((i) => i !== -1);
  return brief.slice(from, stops.length > 0 ? Math.min(...stops) : brief.length).trim();
}

const setting = (db, key) => getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key];
const routeOf = (job) => `${job.model}/${job.effort}`;

const closingKey = (id) => `job.${id}.told-to-close`;
/** The limits sumo itself tells a run to close near (src/loop.mjs), as a report names them. */
const CLOSED_NEAR = { budget: 'budget', time: 'time limit', turns: 'turn limit' };
/** What sumo told a job's last run to close near — `budget`, `time` or `turns` — kept for what follows it; null when it told it nothing. */
export function toldToClose(db, id, near) {
  if (near) setMeta(db, closingKey(id), near);
  else unmark(db, closingKey(id));
}

/** The brief of a review nobody asked for: the change to judge comes with it, as with any `--reviews`. */
const reviewTask = (job, risky) => `## Goal
Judge the change j${job.id} made for "${job.title}" against what it was asked: does it do all of it, correctly, and can it be trusted as it stands? ${
  risky ? 'The router called this work risky — it touches security, credentials, money, migrations or concurrency.' : 'Every worker that finishes is reviewed here (jobs.review is all).'
} It passed the project's checks; this review is for what the checks cannot see.
## Non-goals
Rewriting the change, or judging code it did not touch.
## Check
none: a review changes nothing — read the change, what was asked, and the code around it.
`;

/**
 * What follows a worker's run without being asked, once the worker has closed. A first attempt that FAILED is retried
 * once, on a route one step up (`retry`; `jobs.escalate`) — a retry is never retried again this way, nor one sumo told to
 * close near its budget, time or turns, and one of several `attempts` is settled with its siblings instead. One that closed
 * DONE, verified by the checks — in git, so there is a change to hand over — is reviewed when the
 * router called its work risky, or always (`jobs.review`), by a reviewer at least as strong as it (`--reviews`). The job
 * made, with a line that says why and on what route; only the line when it could not be made; null when nothing follows.
 */
async function followUp(db, id, { now = new Date().toISOString() } = {}) {
  const job = getJob(db, id);
  if (job.agent !== 'worker' || attemptsOf(db, id) !== null) return null;
  if (job.status === 'failed') {
    if (job.retry_of !== null || setting(db, 'jobs.escalate') !== 'on') return null;
    // Told by sumo to close near one of its limits, it closed where it stood: a run one step up with that limit fresh would only buy
    // the limit off at a dearer price, and that is the user's call.
    const near = CLOSED_NEAR[getMeta(db, closingKey(id))];
    if (near) {
      const why = `j${id} failed on ${routeOf(job)} after it was told to close near its ${near}: it is not retried one step up, which would start again on a dearer route with a fresh ${near}. To retry it anyway: sumo job retry ${id}`;
      return { line: said(id, 'Not retried', [why])[0] };
    }
    try {
      const made = await retry(db, id, { now });
      return { ...made, kind: 'retry', line: `j${id} failed on ${routeOf(job)} and was retried on ${routeOf(made.job)}, as j${made.job.id} — j${id}'s own report: sumo job show ${id}` };
    } catch (cause) {
      return { line: `j${id} failed on ${routeOf(job)}; a retry one step up could not be made: ${cause.message}` };
    }
  }
  const review = setting(db, 'jobs.review');
  const risky = job.risky === 1;
  if (job.status !== 'done' || !(review === 'all' || (review === 'risky' && risky))) return null;
  // Work taken with --accept was never verified: a review is added to the checks, it does not stand in for them.
  const state = readState(db, id);
  if (state?.verdict?.ok !== true || /^## Accepted without verification$/m.test(reportOf(id))) return null;
  // Outside git nothing recorded where the work began, so there is no change to hand a reviewer: none is asked for.
  if (!state.snap) return null;
  const why = risky ? `The router called j${id}'s work risky` : 'jobs.review is all';
  try {
    const made = await newJob(db, { project: job.project, title: `${job.title} (review of j${id})`, agent: 'reviewer', task: reviewTask(job, risky), reviews: id, now });
    return { ...made, kind: 'review', line: `${why}, so j${made.job.id} reviewed j${id} on ${routeOf(made.job)}:` };
  } catch (cause) {
    return { line: `${why}, but a review could not be made: ${cause.message}` };
  }
}

/**
 * Runs a job with `run`, then what follows it unasked (`followUp`), each with `run` too, until nothing does — at most a
 * retry of a first attempt that failed, and a review of the work once it is done. The chat and `sumo job run` both come
 * through here, each with its own way of running one job: `run(id)` for the first, `run(id, warnings)` for each made
 * here. `onFollow` hears each job made, before it runs; nothing more is made once `signal` is aborted. Each step comes
 * back in order as `{ id, kind, line, result }` — `error` in place of `result` when a follow-up's run threw, and only a
 * `line` when one could not be made. A throw from the first run is the caller's.
 */
export async function runFollowed(db, id, run, { signal = null, onFollow = null, now = () => new Date().toISOString() } = {}) {
  const ran = [{ id, kind: null, line: null, result: await run(id) }];
  for (let at = id; !signal?.aborted; ) {
    const next = await followUp(db, at, { now: now() });
    if (!next) break;
    if (!next.job) {
      ran.push({ id: null, kind: null, line: next.line, result: null });
      break;
    }
    onFollow?.(next.job.id);
    const step = { id: next.job.id, kind: next.kind, line: next.line, result: null };
    ran.push(step);
    try {
      step.result = await run(next.job.id, next.warnings);
    } catch (cause) {
      step.error = cause.message;
      break;
    }
    at = next.job.id;
  }
  return ran;
}

/** `jobs, done, failed, reviewed, avg important` — one line per model/effort this project has finished. */
export function stats(db, { project } = {}) {
  return statsLines(db, { project: project === undefined ? undefined : getProject(db, project).slug });
}

/** Everything a sub-agent needs to start — or to start again cold, in another session, after being interrupted. */
export function brief(db, id) {
  const job = getJob(db, id);
  const parts = [readOr(fileOf(id, 'brief.md')).trimEnd()];
  const qa = readOr(fileOf(id, 'qa.md')).trim();
  const notes = readOr(fileOf(id, 'notes.md')).trim();
  const red = (readState(db, id)?.baseline ?? []).filter((c) => !c.ok);
  if (red.length > 0) {
    parts.push(`## Already failing before this job began — not yours to fix, and not to be made worse\n${red.map((c) => `- \`${c.command}\` — ${c.flaky ? 'flaky: run twice, it did not fail the same way — ' : ''}${c.file}`).join('\n')}`);
  }
  if (qa) parts.push(`## Questions and answers so far\n${qa}`);
  if (notes) parts.push(`## Progress so far (from an earlier run of this job — continue from here, do not start over)\n${notes}`);
  if (job.status === 'done' || job.status === 'failed') parts.push(`## This job is already ${job.status}. Do nothing.`);
  return parts.join('\n\n');
}

/** Where a worker job works: the worktree it was given, or the project itself. */
const workdir = (state, project) => state?.tree?.path ?? project.path;
/** The worktree a worker job was given — `{ top, path, prefix, base }` — or null when it works in the project. */
export const treeOf = (db, id) => readState(db, id)?.tree ?? null;

/** A worker job's recorded state and where it works — or a plain reason why there is nothing to check. */
function checkable(db, id, verb) {
  const job = getJob(db, id);
  requireOpen(job, verb);
  const state = readState(db, id);
  if (job.agent !== 'worker' || !state) throw new UsageError(`j${id} is not a worker job with a recorded start — there is nothing to ${verb === 'verified' ? 'verify' : 'take a baseline of'}`);
  const root = workdir(state, getProject(db, job.project));
  if (!existsSync(root)) throw new UsageError(`${root} no longer exists`);
  return { job, state, root };
}

/** The project's checks as they stand before the work. Taken once; a second call reports what the first found. */
export function baseline(db, id) {
  const { state, root } = checkable(db, id, 'given a baseline');
  if (!state.baseline) {
    const taken = takeBaseline(root, state.snap, dirOf(id));
    if (taken.refused) return [`no baseline taken: ${taken.refused}.`, 'Every check that fails at the end will count as this job\'s.'];
    // A verdict given before there was a baseline judged against none: it no longer says what DONE would.
    writeState(db, id, { ...state, baseline: taken.checks, verdict: null });
    state.baseline = taken.checks;
  }
  if (state.baseline.length === 0) return ['this project declares no check, test, lint or typecheck command — there is nothing to take a baseline of'];
  const failing = (c) =>
    c.flaky
      ? `is FLAKY — it failed, and run again it did not fail the same way; recorded so a failure of it is not blamed on you (${c.file}, ${c.again})`
      : `ALREADY FAILS — not yours to fix, and recorded so it is not blamed on you (${c.file})`;
  return state.baseline.map((c) => `\`${c.command}\` ${c.ok ? 'passes' : failing(c)}`);
}

/** Runs the checks now and records the verdict against the exact tree it judged. */
export function verifyJob(db, id, now = new Date().toISOString()) {
  const { state, root } = checkable(db, id, 'verified');
  const verdict = verify(root, state, dirOf(id), now);
  writeState(db, id, { ...state, verdict });
  return verdict;
}

/** Everything a job changed, as one file a reviewer can read. */
export function changes(db, id) {
  const job = getJob(db, id);
  const state = readState(db, id);
  if (!state?.snap) throw new UsageError(`j${id} recorded no starting point (not a worker job, or not a git repository)`);
  const root = workdir(state, getProject(db, job.project));
  // A worktree that is gone wrote down its change as it went: that is kept, not overwritten from a project that has moved on.
  if (state.tree && !existsSync(root) && existsSync(fileOf(id, 'changes.diff'))) {
    return { file: fileOf(id, 'changes.diff'), files: (readOr(fileOf(id, 'changes.diff')).match(/^diff --git /gm) ?? []).length };
  }
  return writeChanges(root, state.snap, fileOf(id, 'changes.diff'));
}

/**
 * The verdict a DONE rests on: the recorded one when the tree has not moved
 * since it was given, otherwise a fresh one. Outside git there is no telling
 * whether the tree moved, so it is always run again.
 */
function verdictForDone(db, id, state, now) {
  const root = workdir(state, getProject(db, getJob(db, id).project));
  if (!existsSync(root)) return null;
  const last = state.verdict;
  if (last?.fingerprint && state.snap && unmoved(root, state.snap, last.fingerprint)) return last;
  return verifyJob(db, id, now);
}

/** Whether the tree is exactly the one a verdict judged; a tree that cannot be compared has moved, as far as anyone can tell. */
function unmoved(root, snap, fingerprint) {
  try {
    return changesSince(root, snap).fingerprint === fingerprint;
  } catch {
    return false;
  }
}

function append(id, name, heading, text, now) {
  appendFileSync(fileOf(id, name), `### ${heading} — ${now.slice(0, 16).replace('T', ' ')}\n${text.trim()}\n\n`, { mode: 0o600 });
}

/** A line of a checklist, ticked or not: `- [ ] a step`, `- [x] a step`. */
const STEP = /^\s*[-*]\s+\[[ xX]\]\s+\S/;
/** The most of a plan put back in front of a job: it is a reminder, not the notes again. */
const PLAN_STEPS = 20;

/**
 * A job's plan: the checklist in the latest of its notes that holds one. A worker notes its steps as `- [ ] …` and notes the
 * list again, ticked `- [x] …`, as it goes, so the last list is where it stands. Null while no note holds one.
 */
export function planOf(id) {
  for (const entry of readOr(fileOf(id, 'notes.md')).split(/^### /m).reverse()) {
    const steps = entry.split('\n').filter((l) => STEP.test(l)).map((l) => l.trim());
    if (steps.length > 0) return [...steps.slice(0, PLAN_STEPS), ...(steps.length > PLAN_STEPS ? [`… ${steps.length - PLAN_STEPS} more steps`] : [])].join('\n');
  }
  return null;
}

export function note(db, id, text, now = new Date().toISOString()) {
  const job = getJob(db, id);
  requireOpen(job, 'noted on');
  if (!text.trim()) throw new UsageError('the note is empty — put it on stdin');
  append(id, 'notes.md', 'note', text, now);
  setOpenStatus(db, id, null, now);
}

export function ask(db, id, question, now = new Date().toISOString()) {
  requireOpen(getJob(db, id), 'asked about');
  if (!question.trim()) throw new UsageError('the question is empty — put it on stdin');
  append(id, 'qa.md', 'Question', question, now);
  setOpenStatus(db, id, 'needs_input', now);
}

const inboxOf = (id) => fileOf(id, 'inbox');
let told = 0;

/**
 * Something the user says to a running job from outside its process — the chat's `@j31 …` for a job it is
 * not running, or `sumo job tell` from any shell. One file each, written whole and then given its name, and
 * named so they sort in the order they were said: the job taking its inbox never reads half a message, and
 * one that arrives while it is taking the others is simply there the next time.
 */
export function tell(db, id, text, now = new Date().toISOString()) {
  requireOpen(getJob(db, id), 'told anything');
  if (!text.trim()) throw new UsageError('the message is empty — put it on stdin');
  mkdirSync(inboxOf(id), { recursive: true, mode: 0o700 });
  const name = `${String(Date.now()).padStart(15, '0')}-${String(told++).padStart(6, '0')}-${process.pid}`;
  const unnamed = join(inboxOf(id), `.${name}`);
  writeFileSync(unnamed, JSON.stringify({ text: text.trim(), at: now }), { mode: 0o600 });
  renameSync(unnamed, join(inboxOf(id), `${name}.json`));
}

/** What a job run in the chat is doing, line by line, for whoever watches it; and how the run ended, once it has. */
export const liveFile = (id) => fileOf(id, 'live.log');
export const endFile = (id) => fileOf(id, 'live.end');
/** A run begins with an empty record: a watcher never mistakes how an earlier run ended for this one's end. */
export function startLive(id) {
  rmSync(endFile(id), { force: true });
  writeFileSync(liveFile(id), '', { mode: 0o600 });
}
export const appendLive = (id, text) => appendFileSync(liveFile(id), text, { mode: 0o600 });
export const endLive = (id, lines) => writeFileSync(endFile(id), `${lines.join('\n')}\n`, { mode: 0o600 });

/** What was told to the job since it last looked, taken off the disk so it is read once. A file that is not a message is passed over. */
export function takeInbox(id) {
  let names;
  try {
    names = readdirSync(inboxOf(id)).filter((name) => name.endsWith('.json')).sort();
  } catch {
    return [];
  }
  return names.flatMap((name) => {
    const file = join(inboxOf(id), name);
    const raw = readOr(file);
    rmSync(file, { force: true });
    try {
      const { text } = JSON.parse(raw);
      return typeof text === 'string' ? [text] : [];
    } catch {
      return [];
    }
  });
}

export function answer(db, id, text, now = new Date().toISOString()) {
  const job = getJob(db, id);
  if (job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — it is not waiting for an answer`);
  if (!text.trim()) throw new UsageError('the answer is empty — put it on stdin');
  append(id, 'qa.md', 'Answer', text, now);
  setOpenStatus(db, id, 'running', now);
}

/**
 * The traps under "## Learned" in a report, minus the ways of saying "nothing". A trap is a bullet with the lines it wraps
 * onto, or — where nothing is listed — the first paragraph; what stands after them is the report going on, not a trap.
 */
function learnedLines(report) {
  const section = /^##\s*Learned\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(report)?.[1] ?? '';
  const BULLET = /^\s*(?:[-*]|\d+[.)])\s+/;
  const listed = section.split('\n').some((l) => BULLET.test(l));
  const traps = [];
  let open = false;
  for (const raw of section.split('\n')) {
    const text = raw.replace(BULLET, '').trim();
    if (!text) {
      // A blank line ends a trap; with nothing listed, it ends the one paragraph there is.
      if (!listed && traps.length > 0) break;
      open = false;
    } else if (BULLET.test(raw) || (!listed && !open)) {
      traps.push(text);
      open = true;
    } else if (open) traps[traps.length - 1] += ` ${text}`;
  }
  return traps.filter((l) => l.length > 12 && !/^(none|nothing|n\/a)\b/i.test(l)).slice(0, MAX_LEARNED);
}

/**
 * The findings under "## Findings" in a review — the count that becomes the
 * reviewed job's `important`. One per line that opens the way the template
 * asks (`1. `) or the way reviewers here also write them (`<file:line> — `);
 * a wrapped line is indented, so it is never counted twice.
 */
function findingsCount(report) {
  return (findingsSection(report).match(/^(?:\d+\.\s|\S+\.\w+:\d+)/gm) ?? []).length;
}

/** What a review lists under "## Findings", as it was written; empty when it has no such section. */
function findingsSection(report) {
  return /^##\s*Findings\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(report)?.[1] ?? '';
}

const checkedFile = (id) => fileOf(id, 'checked');
/** How many changed files, and how many new ones, the check names before it counts the rest. */
const CHECK_LISTED = 30;

/**
 * What a worker's first DONE is answered with instead of being taken: the task as it was given, what has changed since
 * the job began, and what to look for — the first thing a reviewer does, done by the author while it can still fix
 * what it finds. Nothing is run here; the checks come with the next DONE.
 */
function checkAgainstTask(db, job, state) {
  // Where the job works: its worktree when it was given one, the project otherwise.
  const root = workdir(state, getProject(db, job.project));
  let change = ['not a git repository — what changed cannot be shown; look over it yourself'];
  if (state.snap) {
    try {
      const { created } = changesSince(root, state.snap);
      change = [
        diffStat(root, state.snap, CHECK_LISTED) || '(no tracked file changed)',
        ...created.slice(0, CHECK_LISTED).map((f) => ` new file: ${f}`),
        ...(created.length > CHECK_LISTED ? [` … ${created.length - CHECK_LISTED} more new files`] : []),
      ];
    } catch {
      change = ['what changed could not be read from git — look over it yourself'];
    }
  }
  return [
    `j${job.id} is not closed yet — before DONE counts, check the work against the task. Nothing was run.`,
    '',
    '## The task',
    taskFromBrief(readOr(fileOf(job.id, 'brief.md'))) || '(the brief has no "## The task" section)',
    '',
    '## What changed since the job began',
    ...change,
    '',
    '## Check each, and fix what is not so',
    '- Every requirement in the task is met.',
    '- Debug output and scratch files are removed.',
    '- Tests were changed only if the task allows it.',
    '- Every claim in the report is backed by a tool result from this run.',
    '',
    'Then call `finish` again with the same report, or a corrected one, to go on to verification. This is asked once.',
  ].join('\n');
}

/**
 * Closes a job. What the sub-agent learned is filed by code, not by trust: only
 * as gotchas, only in this project, marked as observed, through the same
 * validator as every other model-written memory.
 */
export function finish(db, id, { status, report, accept }, now = new Date().toISOString()) {
  const job = getJob(db, id);
  requireOpen(job, 'finished');
  if (status !== 'DONE' && status !== 'FAILED') throw new UsageError('--status is DONE or FAILED (blocked on the user? use: sumo job ask)');
  if (!report.trim()) throw new UsageError('the report is empty — put it on stdin');
  if (accept !== undefined && !accept.trim()) throw new UsageError('--accept needs the reason the work is being taken without verification');

  // The author of the work does not grade it. A worker's DONE rests on what the checks said, not on what the report says.
  // A DONE that cannot be checked is refused, not waved through; --accept is the way to take it anyway, and it is written down.
  const graded = job.agent === 'worker' && status === 'DONE';
  const state = graded ? readState(db, id) : null;
  const unchecked = (why) => new UsageError(`j${id} cannot be verified — ${why}. To take the work as it stands: sumo job finish ${id} --status DONE --accept "<why>"`);
  if (graded && accept === undefined && !state) throw unchecked(`the record of where it began (${fileOf(id, 'verify.json')}) cannot be read, or was changed since sumo wrote it`);
  // Before the checks are run, the author looks once at the task beside its change: the first DONE is answered with that, not taken.
  // Kept in the job's folder, so a run started again goes on to the checks instead of being asked again.
  if (graded && accept === undefined && !existsSync(checkedFile(id))) {
    const asked = checkAgainstTask(db, job, state);
    writeFileSync(checkedFile(id), `${now}\n`, { mode: 0o600 });
    throw new UsageError(asked);
  }
  const verdict = state && accept === undefined ? verdictForDone(db, id, state, now) : null;
  // The checks can take minutes: report a job closed in the meantime before interpreting their verdict.
  requireOpen(getJob(db, id), 'finished');
  if (graded && accept === undefined && !verdict) throw unchecked(`${getProject(db, job.project).path} no longer exists, so its checks cannot be run`);
  if (verdict && !verdict.ok) {
    throw new UsageError(
      [
        `j${id} is not done — the project's checks were run, and:`,
        ...verdictLines(verdict).map((l) => `  ${l}`),
        `Fix it and finish again. If it cannot be fixed: sumo job finish ${id} --status FAILED, or ask: sumo job ask ${id}`,
      ].join('\n'),
    );
  }
  const observed = verdict
    ? `\n## Verified by code — not by the author of this report\n${verdictLines(verdict).map((l) => `- ${l}`).join('\n')}\n`
    : graded && accept !== undefined
      ? `\n## Accepted without verification\n${accept.trim()}\n`
      : '';

  // The checks can take minutes: a job abandoned or closed while they ran is left as it now is.
  // Closed before the report is written, so one closed elsewhere meanwhile keeps the report it had; a report that cannot be written undoes the close.
  tx(db, () => {
    const closed = db.prepare(`UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND status IN ('running', 'needs_input')`).run(status === 'DONE' ? 'done' : 'failed', now, id);
    if (closed.changes === 0) requireOpen(getJob(db, id), 'finished');
    writeFileSync(fileOf(id, 'report.md'), `${report.trim()}\n${observed}`, { mode: 0o600 });
  });

  // A reviewer job created with --reviews <id> grades that job: the count of numbered Findings becomes its "important".
  if (job.agent === 'reviewer' && status === 'DONE') {
    const targetId = reviewTargetOf(id);
    if (targetId !== null) db.prepare('UPDATE jobs SET important = ? WHERE id = ?').run(findingsCount(report), targetId);
  }

  // Scratch keeps no memory: what a chore there taught is in its report, and where it stopped is nowhere to come back to.
  const kept = !isScratch(getProject(db, job.project));
  const ops = kept ? learnedLines(report).map((body) => ({ op: 'gotcha', scope: `project:${job.project}`, body: clip(body, 300) })) : [];
  const learned = applyOps(db, ops, { source: 'worker', turns: new Map(), now });

  const summary = /^##\s*Summary\s*\n+([^\n]+)/im.exec(report)?.[1]?.trim();
  if (kept) {
    addCheckpoint(db, {
      sessionId: job.session_id,
      project: job.project,
      done: clip(`${status === 'DONE' ? 'finished' : 'FAILED'} job j${id} "${job.title}"${summary ? `: ${summary}` : ''}`, 300),
      next: status === 'FAILED' ? `read the report: sumo job show ${id}` : null,
      now,
    });
  }
  return { job: getJob(db, id), learned, verdict, unverified: graded && accept !== undefined };
}

export function abandon(db, id, now = new Date().toISOString()) {
  requireOpen(getJob(db, id), 'abandoned');
  setStatus(db, id, 'abandoned', now);
}

const LISTED = 30;

/** The newest jobs, open ones only unless `all`; `more` is how many older ones the list leaves out. */
export function listJobs(db, { all = false } = {}) {
  const where = all ? '' : `WHERE status IN ('running', 'needs_input')`;
  const rows = db.prepare(`SELECT * FROM jobs ${where} ORDER BY id DESC LIMIT ${LISTED}`).all();
  const total = db.prepare(`SELECT COUNT(*) AS n FROM jobs ${where}`).get().n;
  return Object.assign(rows, { more: total - rows.length });
}

export function jobLine(job) {
  return `j${job.id} [${job.agent}·${job.project}·${job.status}] ${job.title}`;
}

/** The report a job closed with, as its sub-agent wrote it; empty while it has none. */
export const reportOf = (id) => readOr(fileOf(id, 'report.md')).trim();

/** What the main agent needs to decide its next move — not the whole report. */
export function show(db, id) {
  const job = getJob(db, id);
  const out = [jobLine(job), `files: ${dirOf(id)}`];
  if (job.model && job.effort) out.push(`route: ${job.model}/${job.effort} — ${job.route_reason}`);
  if (job.important !== null && job.important !== undefined) out.push(`important: ${job.important}`);
  const qa = readOr(fileOf(id, 'qa.md')).trim();
  if (job.status === 'needs_input' && qa) out.push('', 'waiting on this question:', qa.split(/^### /m).filter(Boolean).at(-1).replace(/^[^\n]*\n/, '').trim());
  const notes = readOr(fileOf(id, 'notes.md')).trim();
  if (notes) out.push('', 'latest note:', notes.split(/^### /m).filter(Boolean).at(-1).replace(/^[^\n]*\n/, '').trim());
  const report = readOr(fileOf(id, 'report.md')).trim();
  if (report) out.push('', report);
  return out.join('\n');
}

const settledKey = (id) => `job.${id}.settled`;
const attemptsKey = (id) => `job.${id}.attempts`;
const pickedKey = (first) => `job.${first}.picked`;
/** True for the one caller that gets there first, whoever else tries at the same moment. */
const firstTo = (db, key, now) => tx(db, () => getMeta(db, key) === null && (setMeta(db, key, now), true));

/** The jobs one `--attempts` made, in order; null for a job that is not one of them. */
export function attemptsOf(db, id) {
  const ids = getMeta(db, attemptsKey(id));
  return ids === null ? null : JSON.parse(ids);
}

/** What the last of a set of attempts to close settled for them all, in lines; null until then. */
export function attemptsSettled(db, first) {
  try {
    return JSON.parse(getMeta(db, pickedKey(first))).lines ?? null;
  } catch {
    return null;
  }
}

/** Added to a job's report under a heading of its own, and handed back to be said. */
function said(id, heading, lines) {
  appendFileSync(fileOf(id, 'report.md'), `\n## ${heading}\n${lines.join('\n')}\n`, { mode: 0o600 });
  return lines;
}

/** The tree goes; what it changed stays beside the job as changes.diff, for a retry, a review or a person. */
function release(id, project, state) {
  const kept = fileOf(id, 'changes.diff');
  try {
    writeChanges(state.tree.path, state.snap, kept);
  } catch {
    // A tree too broken to diff has nothing to keep.
  }
  dropTree(project.path, state.tree.top);
  return kept;
}

/** The newest other worker at work in the project itself — not in a worktree of its own — right now, or undefined. */
const inPlace = (db, project, id) => openWorkers(db, project.slug, id).find((o) => !readState(db, o.id)?.tree && atWork(o.id));

/**
 * The tree's change, brought back to the project: the tree goes once it is there, and stays, said, where it would not go.
 * Never under a worker at work in the project: its start, its baseline and its review would all count the change as its
 * own. Then the tree goes, and the change is kept whole as a patch, with the command that applies it once that one is done.
 */
function applyTree(db, id, project, state) {
  const busy = inPlace(db, project, id);
  if (busy) {
    const patch = treeDiff(state.tree, { binary: true });
    if (patch.length > 0) writeFileSync(fileOf(id, 'change.patch'), patch, { mode: 0o600 });
    const kept = release(id, project, state);
    if (patch.length === 0) return 'It changed nothing; its worktree is removed.';
    return `The change was NOT applied: j${busy.id} "${busy.title}" is still working in ${project.path}, and the change would land under it — its start, its checks and its review would count it as its own. Its worktree is removed; what it changed is kept in ${kept}, and whole as a patch: once j${busy.id} is done, git -C ${project.path} apply ${fileOf(id, 'change.patch')}`;
  }
  const back = bringBack(project.path, state.tree, dirOf(id));
  if (!back.applied && !back.empty) {
    return `The change was NOT applied: it does not apply to ${project.path} as that stands now. It is kept in ${state.tree.top} — bring it over by hand, then: git -C ${project.path} worktree remove --force ${state.tree.top}${back.why ? `   (git said: ${back.why})` : ''}`;
  }
  release(id, project, state);
  return back.empty ? 'It changed nothing; its worktree is removed.' : `The change was applied to ${project.path}${back.merged ? ' by a three-way merge, and staged' : ''}; its worktree is removed.`;
}

/** Done, judged by the checks, and its tree still the one they judged: an attempt worth keeping. */
function verifiedDone(db, id, state) {
  const tree = state?.tree?.path;
  return getJob(db, id).status === 'done' && state.verdict?.ok === true && existsSync(tree ?? '') && unmoved(tree, state.snap, state.verdict.fingerprint);
}

/**
 * What becomes of a closed worker's own worktree. Done, its change is brought back to the project and the tree removed —
 * or, where it does not apply, kept and said; failed or abandoned, the tree goes and what it changed stays as changes.diff.
 * One of several attempts keeps its tree only when verified done, and the last of them to close settles them all. Once per
 * job, by whoever gets there first; what happened is added to the report and handed back. Never throws: the job is closed either
 * way. One that fails part-way is not marked settled, so it can be tried again; where the tree is, and that its change was not
 * brought back, is said.
 */
export async function settle(db, id, now = new Date().toISOString()) {
  const job = getJob(db, id);
  const state = readState(db, id);
  if (!state?.tree || job.status === 'running' || job.status === 'needs_input' || !firstTo(db, settledKey(id), now)) return [];
  const project = getProject(db, job.project);
  const group = attemptsOf(db, id);
  let picking = false;
  try {
    if (!group) return said(id, 'Worktree', [job.status === 'done' ? applyTree(db, id, project, state) : `Its worktree is removed; what it changed is kept in ${release(id, project, state)}.`]);
    // Settled already, by another attempt that closed at the same moment.
    if (getMeta(db, pickedKey(group[0])) !== null) return [];
    const own = verifiedDone(db, id, state) ? [] : said(id, 'Worktree', [`Not verified done, so not a candidate: its worktree is removed; what it changed is kept in ${release(id, project, state)}.`]);
    const open = group.some((m) => ['running', 'needs_input'].includes(getJob(db, m).status));
    if (open || !firstTo(db, pickedKey(group[0]), now)) return own;
    picking = true;
    const lines = await settleAttempts(db, group, project, now);
    setMeta(db, pickedKey(group[0]), JSON.stringify({ lines }));
    return [...own, ...said(group[0], 'Attempts', lines)];
  } catch (cause) {
    unmark(db, settledKey(id));
    if (picking) unmark(db, pickedKey(group[0]));
    const where = existsSync(state.tree.top)
      ? `the tree is still at ${state.tree.top} — bring it over by hand, then: git -C ${project.path} worktree remove --force ${state.tree.top}`
      : `what it changed is kept in ${fileOf(id, 'changes.diff')}`;
    return said(id, 'Worktree', [`Its worktree could not be settled: ${cause.message.trim()}. Its change was NOT brought back; ${where}`]);
  }
}

/** A set of attempts, all closed: of the verified ones, one is picked and brought back, and every other tree goes. */
async function settleAttempts(db, group, project, now) {
  const states = new Map(group.map((m) => [m, readState(db, m)]));
  const candidates = group.filter((m) => states.get(m)?.tree && verifiedDone(db, m, states.get(m)));
  const pick = candidates.length === 0 ? null : candidates.length === 1 ? { id: candidates[0], reason: 'the only one verified done' } : await pickAttempt(db, group[0], candidates.map((m) => ({ id: m, tree: states.get(m).tree })), now);
  for (const m of group) if (m !== pick?.id && existsSync(states.get(m)?.tree?.top ?? '')) release(m, project, states.get(m));
  const lines = [`${group.map((m) => `j${m} ${getJob(db, m).status}`).join(', ')}; verified done: ${candidates.map((m) => `j${m}`).join(', ') || 'none'}.`];
  if (!pick) return [...lines, 'None was verified done, so nothing was brought back.'];
  return [...lines, `Picked j${pick.id}: ${pick.reason}`, applyTree(db, pick.id, project, states.get(pick.id))];
}

const PICK_DIFF_CHARS = 20_000;
const PICK_SCHEMA = { type: 'object', properties: { pick: { type: 'integer' }, reason: { type: 'string' } }, required: ['pick', 'reason'], additionalProperties: false };
const PICK_SYSTEM =
  "Several attempts were made at one coding task, and each passed the project's checks. Pick the one to keep: the one that does all the task asks, " +
  'correctly, with the least that was not asked for. Answer with its number and one sentence saying why.';

/** Which of several verified attempts to keep: one structured answer from sonnet, given the task and each change; the smallest change when none comes. */
async function pickAttempt(db, first, candidates, now) {
  const diffs = candidates.map(({ tree }) => treeDiff(tree));
  const shown = (d) => (d.length > PICK_DIFF_CHARS ? `${head(d, PICK_DIFF_CHARS)}\n[… ${d.length - PICK_DIFF_CHARS} more characters not shown]` : d);
  const prompt = [`## The task\n${taskFromBrief(readOr(fileOf(first, 'brief.md'))) ?? ''}`, ...diffs.map((d, i) => `## Attempt ${i + 1}\n${shown(d)}`)].join('\n\n');
  const result = usableModels(db).includes('sonnet') ? await callModel(db, { system: PICK_SYSTEM, prompt, schema: PICK_SCHEMA, model: 'sonnet', kind: 'pick' }) : failure('sonnet is switched off');
  const n = result.data?.pick;
  const ok = result.ok && Number.isInteger(n) && n >= 1 && n <= candidates.length;
  const why = ok ? `picked attempt ${n}` : (result.error ?? `there is no attempt ${n}`);
  logRun(db, { kind: 'pick', model: 'sonnet', result: { ...result, ok }, note: why, now, jobId: first });
  if (ok) return { id: candidates[n - 1].id, reason: String(result.data.reason ?? '').trim() || 'no reason was given' };
  const smallest = diffs.reduce((at, d, i) => (d.length < diffs[at].length ? i : at), 0);
  return { id: candidates[smallest].id, reason: `the smallest change — no pick came back (${why})` };
}
