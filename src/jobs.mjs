import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { tx } from './db.mjs';
import { UsageError } from './memory.mjs';
import { paths, REPO_ROOT } from './paths.mjs';
import { getProject } from './projects.mjs';
import { runScribe } from './scribe.mjs';
import { addCheckpoint, pendingTurns } from './sessions.mjs';
import { clip } from './text.mjs';
import { changesSince, hasCommit, snapshot, takeBaseline, verdictLines, verify, writeChanges } from './verify.mjs';

const AGENTS = ['scout', 'worker', 'reviewer'];
/** Work with a written way of doing it: guides/<name>.md, carried into the brief on request. */
const GUIDES = ['fix', 'feature', 'review'];
const BRIEF_CARD_BUDGET = 400;
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

function setStatus(db, id, status, now) {
  db.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?').run(status, now, id);
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
    ## Findings            worst first: <file:line> — how it fails, concretely — the smallest fix or test. No praise, no rewrites.
    ## Minor               listed, never a reason to reopen the work
    ## Could not verify    what the change alone cannot show — it lives in code that did not change
    ${LEARNED}`,
};

/** How a worker's result gets judged. Said up front, because a rule met only at the end reads as a trap. */
function workerRules(job, { testsMayChange }) {
  return `- Before you edit anything: \`mem job baseline ${job.id}\` (allow it ten minutes). It runs the project's checks and records what already fails, so none of that is blamed on you — and nothing you break can hide behind it.
- Tests that are already here judge your change; they are not part of it. ${
    testsMayChange
      ? 'This task may change them — say in the report which, and why.'
      : `Do not edit, skip or delete one. A test that is genuinely wrong, or that contradicts the task: stop and say why with \`mem job ask ${job.id}\`.`
  } Never loosen a lint or type setting, add an ignore, or special-case a test's input to get green.
- A question you can settle yourself: decide, carry on, and list it under Decisions. Stop and ask only for something destructive or irreversible, security-sensitive, outside this project, or a task so unclear that every path is a guess.
- You do not start sub-agents. Review comes after you, from someone who did not write the code.
`;
}

function renderBrief({ job, project, known, task, guide, change, options = {} }) {
  const closing =
    job.agent === 'worker'
      ? `\`mem job finish ${job.id} --status DONE\` (or \`FAILED\`). DONE is not taken on your word: the project's checks are run and compared with the baseline, and it is refused while something new fails. See the verdict first with \`mem job verify ${job.id}\` (allow it ten minutes). Report on stdin:`
      : `\`mem job finish ${job.id} --status DONE\` (or \`FAILED\`), with this report on stdin:`;
  return `# Job j${job.id} — ${job.title}

${ROLE[job.agent]}
Work only inside: ${project.path}   (always use absolute paths — your shell does not start there)

## What is already known about this project
${known}

## The task
${task.trim()}
${change ? `\n## The change to judge\n${change}\n` : ''}${guide ? `\n## How this kind of work is done here\n${guide}\n` : ''}
## How to work
${job.agent === 'worker' ? workerRules(job, options) : ''}- Worth keeping if you are interrupted — what you found, what you tried, what is left: \`mem job note ${job.id}\` (text on stdin).
- Blocked on something only the user can decide: \`mem job ask ${job.id}\` (one question on stdin), then stop. You will be resumed with the answer.
- You may read memory: \`mem search "<words>" --project ${project.slug}\`. You never write it.
- If some other command is refused, carry on with Read, Grep and Glob. \`mem\` commands are always allowed, so a refusal never stops you from noting, asking or finishing.
- When finished you must close the job, or nobody knows it ended: ${closing}
${REPORT[job.agent]}
- Your final message: the STATUS line, then one line per ${job.agent === 'reviewer' ? 'finding' : 'file changed'}. Nothing else — the report is already on disk.
`;
}

/** What code has recorded about a job's work: where it began, what already failed, and the last verdict. */
const readState = (id) => {
  try {
    return JSON.parse(readFileSync(fileOf(id, 'verify.json'), 'utf8'));
  } catch {
    return null;
  }
};
const writeState = (id, state) => writeFileSync(fileOf(id, 'verify.json'), `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });

/** The written way of doing one kind of work, without its title — the brief has its own heading for it. */
function guideFor(name) {
  if (!GUIDES.includes(name)) throw new UsageError(`--guide is one of: ${GUIDES.join(', ')}`);
  const text = readOr(join(REPO_ROOT, 'guides', `${name}.md`));
  if (!text.trim()) throw new UsageError(`guides/${name}.md is missing or empty`);
  return text.replace(/^#[^\n]*\n+/, '').trim();
}

/**
 * The change a reviewer is pointed at: another job's work, or whatever is
 * uncommitted right now. Settled before the job exists, so a review of nothing
 * is refused instead of created.
 */
function changeToJudge(db, { project, reviews }) {
  const lines = [];
  let snap;
  if (reviews !== undefined) {
    const target = getJob(db, reviews);
    if (target.project !== project.slug) throw new UsageError(`j${target.id} belongs to ${target.project}, not ${project.slug}`);
    snap = readState(target.id)?.snap;
    if (!snap) throw new UsageError(`j${target.id} recorded no starting point (not a worker job, or not a git repository) — there is no change to hand over`);
    lines.push(`What was asked: ${fileOf(target.id, 'brief.md')}   (read "## The task")`);
    if (existsSync(fileOf(target.id, 'report.md'))) {
      lines.push(`What its author says they did: ${fileOf(target.id, 'report.md')}   — claims, not facts. A stated reason never makes a finding smaller.`);
    }
  } else {
    if (!hasCommit(project.path)) throw new UsageError(`${project.path} is not a git repository with a commit — there is no change to hand over`);
    snap = { base: 'HEAD', mixed: false, untracked: [] };
  }
  const { tracked, created } = changesSince(project.path, snap);
  if (tracked.length + created.length === 0) throw new UsageError('nothing has changed — there is nothing to review');
  return { snap, lines };
}

/**
 * Creates a job and its brief. The brief carries what memory knows about the
 * project, so the sub-agent starts with its context instead of spending turns
 * finding it — and the main agent's conversation never has to hold it.
 */
export function newJob(db, { project: nameOrAlias, title, agent = 'worker', task, guide: guideName, reviews, testsMayChange = false, now = new Date().toISOString() }) {
  if (!AGENTS.includes(agent)) throw new UsageError(`--agent is one of: ${AGENTS.join(', ')}`);
  if (!title?.trim()) throw new UsageError('a job needs a --title');
  if (!task?.trim()) throw new UsageError('describe the task on stdin — see guides/delegation.md for the five headings');
  if (reviews !== undefined && agent !== 'reviewer') throw new UsageError('--reviews goes with --agent reviewer');
  const project = getProject(db, nameOrAlias);
  // Everything that can refuse the job is settled before the job exists.
  const guide = guideName || agent === 'reviewer' ? guideFor(guideName ?? 'review') : null;
  const judged = agent === 'reviewer' ? changeToJudge(db, { project, reviews }) : null;

  // A rule the user stated a minute ago may not be filed yet, and the brief is built from memory.
  if (pendingTurns(db, 1).length > 0) runScribe(db, { now });

  const session = db.prepare('SELECT id FROM sessions ORDER BY COALESCE(last_turn_at, started_at) DESC LIMIT 1').get();
  const job = tx(db, () => {
    const { lastInsertRowid } = db
      .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at) VALUES (?, ?, ?, 'running', ?, ?, ?)`)
      .run(project.slug, title.trim(), agent, session?.id ?? null, now, now);
    return getJob(db, Number(lastInsertRowid));
  });

  const known = card(db, project.slug, { budget: BRIEF_CARD_BUDGET, now }).split('\n').slice(1, -1).join('\n') || 'Nothing yet.';
  mkdirSync(dirOf(job.id), { recursive: true, mode: 0o700 });

  let change = null;
  if (judged) {
    const { file, files } = writeChanges(project.path, judged.snap, fileOf(job.id, 'changes.diff'));
    change = [...judged.lines, `The whole change, ${files} file${files === 1 ? '' : 's'}: ${file}   — read it once; do not re-derive it with git.`].join('\n');
  }
  // Where a worker starts from, so what it changed — and only that — can be told apart later.
  if (agent === 'worker') writeState(job.id, { snap: snapshot(project.path), testsMayChange, baseline: null, verdict: null });
  writeFileSync(fileOf(job.id, 'brief.md'), renderBrief({ job, project, known, task, guide, change, options: { testsMayChange } }), { mode: 0o600 });

  const warnings = [];
  if (agent !== 'reviewer' && !/^#{1,3}\s*(the\s+)?check\b|^check\s*:/im.test(task)) {
    warnings.push('note: the task names no check that proves the work — add a "## Check" with a command, or say why there is none');
  }
  if (agent === 'worker') {
    const other = db.prepare(`SELECT * FROM jobs WHERE project = ? AND agent = 'worker' AND status = 'running' AND id <> ? ORDER BY id DESC`).get(project.slug, job.id);
    if (other) warnings.push(`note: j${other.id} "${other.title}" is already a running worker in ${project.slug} — two workers in one working tree overwrite each other. Let it finish, or: mem job abandon ${other.id}`);
  }
  return { job, warnings };
}

/** Everything a sub-agent needs to start — or to start again cold, in another session, after being interrupted. */
export function brief(db, id) {
  const job = getJob(db, id);
  const parts = [readOr(fileOf(id, 'brief.md')).trimEnd()];
  const qa = readOr(fileOf(id, 'qa.md')).trim();
  const notes = readOr(fileOf(id, 'notes.md')).trim();
  const red = (readState(id)?.baseline ?? []).filter((c) => !c.ok);
  if (red.length > 0) {
    parts.push(`## Already failing before this job began — not yours to fix, and not to be made worse\n${red.map((c) => `- \`${c.command}\` — ${c.file}`).join('\n')}`);
  }
  if (qa) parts.push(`## Questions and answers so far\n${qa}`);
  if (notes) parts.push(`## Progress so far (from an earlier run of this job — continue from here, do not start over)\n${notes}`);
  if (job.status === 'done' || job.status === 'failed') parts.push(`## This job is already ${job.status}. Do nothing.`);
  return parts.join('\n\n');
}

/** A worker job's recorded state and where its project lives — or a plain reason why there is nothing to check. */
function checkable(db, id, verb) {
  const job = getJob(db, id);
  requireOpen(job, verb);
  const state = readState(id);
  if (job.agent !== 'worker' || !state) throw new UsageError(`j${id} is not a worker job with a recorded start — there is nothing to ${verb === 'verified' ? 'verify' : 'take a baseline of'}`);
  const project = getProject(db, job.project);
  if (!existsSync(project.path)) throw new UsageError(`${project.path} no longer exists`);
  return { job, state, project };
}

/** The project's checks as they stand before the work. Taken once; a second call reports what the first found. */
export function baseline(db, id) {
  const { state, project } = checkable(db, id, 'given a baseline');
  if (!state.baseline) {
    const taken = takeBaseline(project.path, state.snap, dirOf(id));
    if (taken.refused) return [`no baseline taken: ${taken.refused}.`, 'Every check that fails at the end will count as this job\'s.'];
    writeState(id, { ...state, baseline: taken.checks });
    state.baseline = taken.checks;
  }
  if (state.baseline.length === 0) return ['this project declares no check, test, lint or typecheck command — there is nothing to take a baseline of'];
  return state.baseline.map((c) => `\`${c.command}\` ${c.ok ? 'passes' : `ALREADY FAILS — not yours to fix, and recorded so it is not blamed on you (${c.file})`}`);
}

/** Runs the checks now and records the verdict against the exact tree it judged. */
export function verifyJob(db, id, now = new Date().toISOString()) {
  const { state, project } = checkable(db, id, 'verified');
  const verdict = verify(project.path, state, dirOf(id), now);
  writeState(id, { ...state, verdict });
  return verdict;
}

/** Everything a job changed, as one file a reviewer can read. */
export function changes(db, id) {
  const job = getJob(db, id);
  const snap = readState(id)?.snap;
  if (!snap) throw new UsageError(`j${id} recorded no starting point (not a worker job, or not a git repository)`);
  return writeChanges(getProject(db, job.project).path, snap, fileOf(id, 'changes.diff'));
}

/**
 * The verdict a DONE rests on: the recorded one when the tree has not moved
 * since it was given, otherwise a fresh one. Outside git there is no telling
 * whether the tree moved, so it is always run again.
 */
function verdictForDone(db, id, state, now) {
  const project = getProject(db, getJob(db, id).project);
  if (!existsSync(project.path)) return null;
  const last = state.verdict;
  if (last?.fingerprint && state.snap && changesSince(project.path, state.snap).fingerprint === last.fingerprint) return last;
  return verifyJob(db, id, now);
}

function append(id, name, heading, text, now) {
  appendFileSync(fileOf(id, name), `### ${heading} — ${now.slice(0, 16).replace('T', ' ')}\n${text.trim()}\n\n`, { mode: 0o600 });
}

export function note(db, id, text, now = new Date().toISOString()) {
  const job = getJob(db, id);
  requireOpen(job, 'noted on');
  if (!text.trim()) throw new UsageError('the note is empty — put it on stdin');
  append(id, 'notes.md', 'note', text, now);
  setStatus(db, id, job.status, now);
}

export function ask(db, id, question, now = new Date().toISOString()) {
  requireOpen(getJob(db, id), 'asked about');
  if (!question.trim()) throw new UsageError('the question is empty — put it on stdin');
  append(id, 'qa.md', 'Question', question, now);
  setStatus(db, id, 'needs_input', now);
}

export function answer(db, id, text, now = new Date().toISOString()) {
  const job = getJob(db, id);
  if (job.status !== 'needs_input') throw new UsageError(`j${id} is ${job.status} — it is not waiting for an answer`);
  if (!text.trim()) throw new UsageError('the answer is empty — put it on stdin');
  append(id, 'qa.md', 'Answer', text, now);
  setStatus(db, id, 'running', now);
}

/** The lines under "## Learned" in a report, without bullets, minus the ways of saying "nothing". */
function learnedLines(report) {
  const section = /^##\s*Learned\s*\n([\s\S]*?)(?=^##\s|(?![\s\S]))/im.exec(report)?.[1] ?? '';
  return section
    .split('\n')
    .map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim())
    .filter((l) => l.length > 12 && !/^(none|nothing|n\/a)\b/i.test(l))
    .slice(0, MAX_LEARNED);
}

/**
 * Closes a job. What the sub-agent learned is filed by code, not by trust: only
 * as gotchas, only in this project, marked as observed, through the same
 * validator as every other model-written memory.
 */
export function finish(db, id, { status, report, accept }, now = new Date().toISOString()) {
  const job = getJob(db, id);
  requireOpen(job, 'finished');
  if (status !== 'DONE' && status !== 'FAILED') throw new UsageError('--status is DONE or FAILED (blocked on the user? use: mem job ask)');
  if (!report.trim()) throw new UsageError('the report is empty — put it on stdin');
  if (accept !== undefined && !accept.trim()) throw new UsageError('--accept needs the reason the work is being taken without verification');

  // The author of the work does not grade it. A worker's DONE rests on what the checks said, not on what the report says.
  const state = job.agent === 'worker' && status === 'DONE' ? readState(id) : null;
  const verdict = state && accept === undefined ? verdictForDone(db, id, state, now) : null;
  if (verdict && !verdict.ok) {
    throw new UsageError(
      [
        `j${id} is not done — the project's checks were run, and:`,
        ...verdictLines(verdict).map((l) => `  ${l}`),
        `Fix it and finish again. If it cannot be fixed: mem job finish ${id} --status FAILED, or ask: mem job ask ${id}`,
      ].join('\n'),
    );
  }
  const observed = verdict
    ? `\n## Verified by code — not by the author of this report\n${verdictLines(verdict).map((l) => `- ${l}`).join('\n')}\n`
    : state && accept !== undefined
      ? `\n## Accepted without verification\n${accept.trim()}\n`
      : '';

  writeFileSync(fileOf(id, 'report.md'), `${report.trim()}\n${observed}`, { mode: 0o600 });
  setStatus(db, id, status === 'DONE' ? 'done' : 'failed', now);

  const ops = learnedLines(report).map((body) => ({ op: 'gotcha', scope: `project:${job.project}`, body: clip(body, 300) }));
  const learned = applyOps(db, ops, { source: 'worker', turns: new Map(), now });

  const summary = /^##\s*Summary\s*\n+([^\n]+)/im.exec(report)?.[1]?.trim();
  addCheckpoint(db, {
    sessionId: job.session_id,
    project: job.project,
    done: clip(`${status === 'DONE' ? 'finished' : 'FAILED'} job j${id} "${job.title}"${summary ? `: ${summary}` : ''}`, 300),
    next: status === 'FAILED' ? `read the report: mem job show ${id}` : null,
    now,
  });
  return { job: getJob(db, id), learned, verdict, unverified: Boolean(state) && accept !== undefined };
}

export function abandon(db, id, now = new Date().toISOString()) {
  requireOpen(getJob(db, id), 'abandoned');
  setStatus(db, id, 'abandoned', now);
}

export function listJobs(db, { all = false } = {}) {
  return db.prepare(`SELECT * FROM jobs ${all ? '' : `WHERE status IN ('running', 'needs_input')`} ORDER BY id DESC LIMIT 30`).all();
}

export function jobLine(job) {
  return `j${job.id} [${job.agent}·${job.project}·${job.status}] ${job.title}`;
}

/** What the main agent needs to decide its next move — not the whole report. */
export function show(db, id) {
  const job = getJob(db, id);
  const out = [jobLine(job), `files: ${dirOf(id)}`];
  const qa = readOr(fileOf(id, 'qa.md')).trim();
  if (job.status === 'needs_input' && qa) out.push('', 'waiting on this question:', qa.split(/^### /m).filter(Boolean).at(-1).replace(/^[^\n]*\n/, '').trim());
  const notes = readOr(fileOf(id, 'notes.md')).trim();
  if (notes) out.push('', 'latest note:', notes.split(/^### /m).filter(Boolean).at(-1).replace(/^[^\n]*\n/, '').trim());
  const report = readOr(fileOf(id, 'report.md')).trim();
  if (report) out.push('', report);
  return out.join('\n');
}
