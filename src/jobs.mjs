import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { tx } from './db.mjs';
import { UsageError } from './memory.mjs';
import { paths } from './paths.mjs';
import { getProject } from './projects.mjs';
import { runScribe } from './scribe.mjs';
import { addCheckpoint, pendingTurns } from './sessions.mjs';
import { clip } from './text.mjs';

const AGENTS = ['scout', 'worker'];
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
};

function renderBrief({ job, project, known, task }) {
  return `# Job j${job.id} — ${job.title}

${ROLE[job.agent]}
Work only inside: ${project.path}   (always use absolute paths — your shell does not start there)

## What is already known about this project
${known}

## The task
${task.trim()}

## How to work
- Worth keeping if you are interrupted — what you found, what you tried, what is left: \`mem job note ${job.id}\` (text on stdin).
- Blocked on something only the user can decide: \`mem job ask ${job.id}\` (one question on stdin), then stop. You will be resumed with the answer.
- You may read memory: \`mem search "<words>" --project ${project.slug}\`. You never write it.
- If some other command is refused, carry on with Read, Grep and Glob. \`mem\` commands are always allowed, so a refusal never stops you from noting, asking or finishing.
- When finished you must close the job, or nobody knows it ended: \`mem job finish ${job.id} --status DONE\` (or \`FAILED\`), with this report on stdin:
    ## Summary
    ## Files changed        one line each: <path> — <what changed>
    ## Check               the command you ran and what it printed; or why there is none
    ## Learned             usually "none". Only a trap that cost you time and would cost the next person time —
                           a required env var, a misleading error, a command that silently does the wrong thing.
                           What you found out belongs in Summary, not here.
- Your final message: the STATUS line, then one line per file changed. Nothing else — the report is already on disk.
`;
}

/**
 * Creates a job and its brief. The brief carries what memory knows about the
 * project, so the sub-agent starts with its context instead of spending turns
 * finding it — and the main agent's conversation never has to hold it.
 */
export function newJob(db, { project: nameOrAlias, title, agent = 'worker', task, now = new Date().toISOString() }) {
  if (!AGENTS.includes(agent)) throw new UsageError(`--agent is one of: ${AGENTS.join(', ')}`);
  if (!title?.trim()) throw new UsageError('a job needs a --title');
  if (!task?.trim()) throw new UsageError('describe the task on stdin — see guides/delegation.md for the five headings');
  const project = getProject(db, nameOrAlias);

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
  writeFileSync(fileOf(job.id, 'brief.md'), renderBrief({ job, project, known, task }), { mode: 0o600 });

  const warnings = [];
  if (!/^#{1,3}\s*(the\s+)?check\b|^check\s*:/im.test(task)) {
    warnings.push('note: the task names no check that proves the work — add a "## Check" with a command, or say why there is none');
  }
  return { job, warnings };
}

/** Everything a sub-agent needs to start — or to start again cold, in another session, after being interrupted. */
export function brief(db, id) {
  const job = getJob(db, id);
  const parts = [readOr(fileOf(id, 'brief.md')).trimEnd()];
  const qa = readOr(fileOf(id, 'qa.md')).trim();
  const notes = readOr(fileOf(id, 'notes.md')).trim();
  if (qa) parts.push(`## Questions and answers so far\n${qa}`);
  if (notes) parts.push(`## Progress so far (from an earlier run of this job — continue from here, do not start over)\n${notes}`);
  if (job.status === 'done' || job.status === 'failed') parts.push(`## This job is already ${job.status}. Do nothing.`);
  return parts.join('\n\n');
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
export function finish(db, id, { status, report }, now = new Date().toISOString()) {
  const job = getJob(db, id);
  requireOpen(job, 'finished');
  if (status !== 'DONE' && status !== 'FAILED') throw new UsageError('--status is DONE or FAILED (blocked on the user? use: mem job ask)');
  if (!report.trim()) throw new UsageError('the report is empty — put it on stdin');

  writeFileSync(fileOf(id, 'report.md'), `${report.trim()}\n`, { mode: 0o600 });
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
  return { job: getJob(db, id), learned };
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
