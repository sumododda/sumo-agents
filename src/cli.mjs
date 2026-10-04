import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { openDb } from './db.mjs';
import { dreamStatus, runDream } from './dream.mjs';
import { backup, exportJson, exportMarkdown } from './export.mjs';
import { resolveAnthropicCredential } from './auth.mjs';
import { chat, jobPrinter } from './chat.mjs';
import { closeJobTab, reportAgent, runHerdr } from './herdr.mjs';
import { runHook } from './hooks.mjs';
import { runJob as runJobLoop, runLines } from './loop.mjs';
import * as jobs from './jobs.mjs';
import * as memory from './memory.mjs';
import { UsageError } from './memory.mjs';
import { openInBrowser, servePage } from './page.mjs';
import { prime } from './prime.mjs';
import * as projects from './projects.mjs';
import { detail, historyLine, line, scopeLabel } from './render.mjs';
import { buildBundle, modelStats, outcomeLines, runScribe, scribeStatus } from './scribe.mjs';
import { searchTurns, taskEndedNudge } from './sessions.mjs';
import { config, doctor, positiveInteger, setup } from './setup.mjs';
import { colourEnabled, styles } from './tty.mjs';
import { ftsQuery } from './text.mjs';
import { verdictLines } from './verify.mjs';

const HELP = `sumo — local memory for the sumo-agents process

  sumo search <query> [--project S] [--type T] [--everywhere] [--all] [--turns] [-n N]
  sumo add <type> "<text>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
        types: preference · fact · decision · gotcha
  sumo learn "<title>" --cue "<action>" [--project S]      workflow steps on stdin
  sumo show <id>        sumo history <id>        sumo gate <workflow-id> '<regex>'|off
  sumo supersede <old-id> <new-id>
  sumo forget <id> [--purge]
  sumo confirm <id>     sumo reject <id>
  sumo memory           the memory as a page in the browser: say yes or no, edit, forget
  sumo project add <path> [--slug S] [--alias A]...   show S · list · rescan S · alias S A · archive S
  sumo job new --project S --title T [--agent scout|worker|reviewer]
        brief ID · note ID · ask ID · answer ID · baseline ID · verify ID · changes ID
        finish ID --status DONE|FAILED · show ID · list [--all] · abandon ID · retry ID · stats
  sumo prime            the block a session starts with
  sumo scribe run|show|status|stats  sumo dream run|status       the cheap-model passes
  sumo export [--json]  sumo backup
  sumo setup            sumo doctor          sumo config [key [value]]

Scope is global plus --project; other projects stay hidden without --everywhere.
`;

const LEARN_USAGE = `sumo learn "<short title>" --cue "<the action, in plain words: create a PR>" [--gate '<regex>'] [--project S] <<'EOF'
1. first step
2. second step
EOF
(the steps come on stdin, or from --from-file <path>.
 --cue   brings the steps in with the user's message when they ask for the thing.
 --gate  a regular expression over the shell command; a match waits until the steps have been shown,
         e.g. --gate 'gh(-axi)? pr create|glab mr create'. Without it, the cue's words are matched.)`;

/**
 * Shown by `sumo <command> --help` and whenever a command is called wrongly. An agent's first
 * guess at a command is often wrong; the reply has to be enough to get the second one right.
 */
const USAGE = {
  search: 'sumo search <query> [--project S] [--type T] [--everywhere] [--all] [--turns] [-n N]',
  add: `sumo add preference|fact|decision|gotcha "<one sentence>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
a workflow (steps to repeat) is saved with sumo learn instead:
${LEARN_USAGE}`,
  learn: LEARN_USAGE,
  show: 'sumo show <id>',
  history: 'sumo history <id>',
  supersede: 'sumo supersede <old-id> <new-id>',
  gate: "sumo gate <workflow-id> '<regex over the shell command>'    |    sumo gate <workflow-id> off",
  forget: 'sumo forget <id> [--purge]',
  confirm: 'sumo confirm <id>',
  reject: 'sumo reject <id>',
  memory: 'sumo memory    (serves the page on this machine and opens it; Ctrl-C stops it)',
  project: `sumo project add <path> [--slug S] [--alias A]...
sumo project show <name> | list [--all] | rescan <name> | alias <name> <alias> | archive <name>`,
  job: `sumo job new --project S --title T [--agent scout|worker|reviewer]   (task on stdin)
        [--guide fix|feature|review]     carry guides/<name>.md into the brief
        [--reviews <id>]                 reviewer: judge that job's change (default: what is uncommitted)
        [--tests-may-change]             worker: this task is allowed to edit tests that already exist
sumo job brief|show|abandon <id>
sumo job run <id>             runs the job here, in Sumo's own loop, on its route; it closes itself as its brief says
sumo job note|ask|answer|tell <id>                               (text on stdin; tell: a message a running job reads next)
sumo job baseline <id>        the project's checks, before the work
sumo job verify <id>          the same checks now, judged against the baseline
sumo job changes <id>         everything the job changed, as one file
sumo job finish <id> --status DONE|FAILED [--accept "<why>"]     (report on stdin)
sumo job retry <id>           a failed job, or a done one reviewed with important >= 3, routed afresh
sumo job stats [--project S]  jobs, done, failed, reviewed, avg important — per model/effort
sumo job list [--all]`,
  prime: 'sumo prime [--budget N]',
  scribe: 'sumo scribe run|show|status|stats',
  dream: 'sumo dream run|status',
  apply: 'sumo apply <ops.json> [--source scribe|dream]',
  export: 'sumo export [--json]',
  backup: 'sumo backup',
  setup: 'sumo setup [--bin-dir DIR] [--no-link] [--model-source URL] [--no-model]',
  doctor: 'sumo doctor',
  config: 'sumo config [key [value]]',
};

const ADDABLE = ['preference', 'fact', 'decision', 'gotcha'];
/** The docs say "workflow", the store says "procedure"; whoever types either means the same thing. */
const WORKFLOW_NAMES = ['workflow', 'procedure'];

/** value: flags that take an argument; bool: flags that don't. Anything else is a typo and says so. */
const COMMANDS = {
  search: { value: ['project', 'type', 'n'], bool: ['everywhere', 'all', 'turns'], run: runSearch },
  add: { value: ['project', 'topic', 'supersedes'], bool: ['pin', 'observed'], run: runAdd },
  learn: { value: ['project', 'cue', 'gate', 'from-file'], bool: [], run: runLearn },
  gate: { value: [], bool: [], run: runGate },
  show: { value: [], bool: [], run: (db, { args }) => [detail(memory.get(db, memory.parseId(args[0])))] },
  history: { value: [], bool: [], run: (db, { args }) => memory.history(db, memory.parseId(args[0])).map(historyLine) },
  supersede: { value: [], bool: [], run: runSupersede },
  forget: { value: [], bool: ['purge'], run: runForget },
  confirm: { value: [], bool: [], run: (db, { args }) => [`confirmed ${line(memory.confirm(db, memory.parseId(args[0])))}`] },
  reject: { value: [], bool: [], run: (db, { args }) => [`rejected ${line(memory.reject(db, memory.parseId(args[0])))}`] },
  memory: { value: [], bool: [], run: runMemoryPage },
  project: { value: ['slug'], multi: ['alias'], bool: ['all'], run: runProject },
  job: { value: ['project', 'title', 'agent', 'status', 'from-file', 'guide', 'reviews', 'accept'], bool: ['all', 'tests-may-change'], run: runJob },
  prime: { value: ['budget'], bool: [], run: (db, { flags }) => [prime(db, { budget: flags.budget === undefined ? undefined : positiveInteger(flags.budget, '--budget needs a positive number') })] },
  scribe: { value: [], bool: [], run: runScribeCommand },
  dream: { value: [], bool: [], run: runDreamCommand },
  apply: { value: ['source'], bool: [], run: runApply },
  export: { value: [], bool: ['json', 'md'], run: runExport },
  backup: { value: [], bool: [], run: runBackup },
};

function parse(argv, spec) {
  const args = [];
  const flags = {};
  const nameOf = (token) => (token.startsWith('--') ? token.slice(2) : token === '-n' ? 'n' : null);
  // One of this command's own flags where a value belongs means the value was left out — `--topic --pin` is not a topic.
  const isFlag = (token) => [...spec.bool, ...spec.value, ...(spec.multi ?? [])].includes(nameOf(token));
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    const name = nameOf(token);
    if (name === null) {
      args.push(token);
    } else if (spec.bool.includes(name)) {
      flags[name] = true;
    } else if (spec.value.includes(name) || spec.multi?.includes(name)) {
      if (i + 1 >= argv.length || isFlag(argv[i + 1])) throw new UsageError(`${token} needs a value`);
      const value = argv[++i];
      if (spec.multi?.includes(name)) (flags[name] ??= []).push(value);
      else flags[name] = value;
    } else {
      throw new UsageError(`unknown option ${token}`);
    }
  }
  return { args, flags };
}

function need(args, count, command) {
  if (args.length < count) throw new UsageError(`usage: ${USAGE[command]}`);
}

function runSearch(db, { args, flags }) {
  need(args, 1, 'search');
  const limit = flags.n === undefined ? undefined : positiveInteger(flags.n, '-n needs a positive number');

  if (flags.turns) {
    const match = ftsQuery(args.join(' '));
    if (!match) throw new UsageError('nothing to search for');
    const turns = searchTurns(db, match, limit);
    return turns.length > 0 ? turns.map((t) => `t${t.id} ${t.ts.slice(0, 10)} ${t.text.replace(/\s+/g, ' ').slice(0, 200)}`) : [`the user never said anything like: ${args.join(' ')}`];
  }

  const { results, elsewhere } = memory.search(db, args.join(' '), {
    project: flags.project,
    type: WORKFLOW_NAMES.includes(flags.type) ? 'procedure' : flags.type,
    everywhere: flags.everywhere,
    all: flags.all,
    limit,
  });

  // An explicit "nothing" is an answer: it is what lets an agent say
  // "not in memory" instead of guessing.
  const out = results.length > 0 ? results.map(line) : [`nothing in memory for: ${args.join(' ')}`];
  const others = Object.entries(elsewhere);
  if (others.length > 0) {
    const where = others.map(([scope, n]) => `${scopeLabel(scope)} (${n})`).join(', ');
    out.push(`matches in other projects, not shown: ${where} — add --project <name> or --everywhere`);
  }
  return out;
}

function savedLines({ memory: saved, similar, redacted }) {
  const out = [`saved ${line(saved)}`];
  if (redacted > 0) out.push(`redacted ${redacted} secret-looking value${redacted === 1 ? '' : 's'} before storing`);
  if (similar.length > 0) {
    out.push(`similar — if m${saved.id} replaces one: sumo supersede <old-id> m${saved.id}`);
    for (const m of similar) out.push(`  ${line(m)}`);
  }
  return out;
}

function runAdd(db, { args, flags }) {
  need(args, 2, 'add');
  const [type, ...text] = args;
  if (WORKFLOW_NAMES.includes(type)) throw new UsageError(`a workflow has a title and steps, so it is saved with sumo learn, not sumo add:\n${LEARN_USAGE}`);
  if (!ADDABLE.includes(type)) throw new UsageError(`unknown type "${type}" — one of: ${ADDABLE.join(', ')} (for a workflow: sumo learn)`);
  return savedLines(
    memory.add(db, {
      type,
      body: text.join(' '),
      project: flags.project,
      topic: flags.topic,
      pin: flags.pin,
      supersedes: flags.supersedes === undefined ? undefined : memory.parseId(flags.supersedes),
      provenance: flags.observed ? 'observed' : 'stated',
    }),
  );
}

function runLearn(db, { args, flags }) {
  need(args, 1, 'learn');
  const body = flags['from-file'] ? readFileSync(flags['from-file'], 'utf8') : process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  if (!body.trim()) throw new UsageError('no steps given — pipe them in, or use --from-file <path>');
  return savedLines(
    memory.add(db, { type: 'procedure', title: args.join(' '), cue: flags.cue, gate: flags.gate, body, project: flags.project }),
  ).concat(flags.gate ? [`gates shell commands matching: ${flags.gate}`] : []);
}

function runGate(db, { args }) {
  need(args, 2, 'gate');
  const saved = memory.setGate(db, memory.parseId(args[0]), args[1] === 'off' ? null : args.slice(1).join(' '));
  return [saved.gate ? `${line(saved)}\ngates shell commands matching: ${saved.gate}` : `${line(saved)}\nno gate — its cue words are matched instead`];
}

function runSupersede(db, { args }) {
  need(args, 2, 'supersede');
  const old = memory.supersede(db, memory.parseId(args[0]), memory.parseId(args[1]));
  return [`superseded ${line(old)}`];
}

function runForget(db, { args, flags }) {
  need(args, 1, 'forget');
  const gone = memory.forget(db, memory.parseId(args[0]), { purge: flags.purge });
  if (!flags.purge) return [`forgot ${line(gone)}`];
  return [gone.source_turn !== null ? `purged m${gone.id} — erased, not recoverable, with the sentence it came from` : `purged m${gone.id} — erased, not recoverable; no sentence of the user's was tied to it — sumo search --turns finds one if it is there`];
}

function runProject(db, { args, flags }) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': {
      need(rest, 1, 'project');
      const { project, created, changes } = projects.addProject(db, rest[0], { slug: flags.slug, aliases: flags.alias });
      const summary = created ? `registered ${project.slug}` : `${project.slug} was already registered — rescanned (${changes.added} new, ${changes.updated} changed, ${changes.removed} gone)`;
      return [summary, card(db, project.slug)];
    }
    case 'show':
      need(rest, 1, 'project');
      return [card(db, rest[0])];
    case 'list': {
      const all = projects.listProjects(db, { includeArchived: flags.all });
      if (all.length === 0) return ['no projects registered — sumo project add <path>'];
      return all.map((p) => {
        const aliases = projects.aliasesOf(db, p.slug);
        return `${p.slug}  ${p.path}${aliases.length ? `  (also: ${aliases.join(', ')})` : ''}${p.status === 'archived' ? '  [archived]' : ''}`;
      });
    }
    case 'rescan': {
      need(rest, 1, 'project');
      const changes = projects.rescan(db, rest[0]);
      return [`rescanned: ${changes.added} new, ${changes.updated} changed, ${changes.removed} gone`, card(db, rest[0])];
    }
    case 'alias': {
      need(rest, 2, 'project');
      const project = projects.getProject(db, rest[0]);
      return [`${projects.addAlias(db, project.slug, rest[1])} now means ${project.slug}`];
    }
    case 'archive':
      need(rest, 1, 'project');
      return [`archived ${projects.archive(db, rest[0])} — its memories are kept, it just stops coming up`];
    default:
      throw new UsageError(`usage: ${USAGE.project}`);
  }
}

/** Long text comes on stdin so one allow rule (`Bash(sumo *)`) covers every job command; --from-file is the fallback. */
function stdinText(flags) {
  if (flags['from-file']) return readFileSync(flags['from-file'], 'utf8');
  return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
}

/** The lines `new` and `retry` both print: the job, its route, and exactly what to start it with. */
function createdLines(job, warnings) {
  return [
    `created ${jobs.jobLine(job)}`,
    ...warnings,
    `route: ${job.model}/${job.effort} — ${job.route_reason}`,
    `run it: sumo job run ${job.id}   (append & to carry on without waiting for it)`,
  ];
}

/** A job's own tab in Herdr: it says it is working, and a line typed into the tab is a message to the job. */
function tabBegins(db, job, print) {
  print?.(job);
  reportAgent(runHerdr, process.env, { job, state: 'working', message: job.title });
  if (process.stdin.isTTY) {
    const typed = createInterface({ input: process.stdin });
    typed.on('line', (line) => {
      if (!line.trim()) return;
      try {
        jobs.tell(db, job.id, line);
      } catch (cause) {
        // A job that has closed itself can still be saying its last words; a line it cannot take is said back, not thrown at the run.
        process.stdout.write(`${cause.message}\n`);
      }
    });
    process.stdin.unref();
  }
}
function tabEnds(job, status) {
  process.stdin.pause();
  reportAgent(runHerdr, process.env, { job, state: job.status === 'needs_input' ? 'blocked' : 'idle', message: status });
  closeJobTab(runHerdr, process.env, job);
}

async function runJob(db, { args, flags }) {
  const [sub, rawId] = args;
  if (sub === 'new') {
    if (!flags.project) throw new UsageError(`usage: ${USAGE.job}`);
    const { job, warnings } = await jobs.newJob(db, {
      project: flags.project,
      title: flags.title,
      agent: flags.agent,
      task: stdinText(flags),
      guide: flags.guide,
      reviews: flags.reviews === undefined ? undefined : jobs.parseJobId(flags.reviews),
      testsMayChange: Boolean(flags['tests-may-change']),
    });
    return createdLines(job, warnings);
  }
  if (sub === 'list') {
    const all = jobs.listJobs(db, { all: flags.all });
    return all.length > 0 ? all.map(jobs.jobLine) : ['no open jobs'];
  }
  if (sub === 'stats') {
    return jobs.stats(db, { project: flags.project });
  }
  if (sub === 'retry') {
    const { job, warnings } = await jobs.retry(db, jobs.parseJobId(rawId));
    return createdLines(job, warnings);
  }
  if (!['brief', 'note', 'ask', 'answer', 'tell', 'finish', 'show', 'abandon', 'baseline', 'verify', 'changes', 'run'].includes(sub)) {
    throw new UsageError(`usage: ${USAGE.job}`);
  }
  const id = jobs.parseJobId(rawId);
  switch (sub) {
    case 'brief':
      return [jobs.brief(db, id)];
    case 'run': {
      // The job runs here, in Sumo's own loop, on the route the router chose; it closes itself the way its brief says.
      // On a terminal the work is shown as it happens — the lines a Herdr pane shows; piped, only how it ended.
      let outcome;
      try {
        if (!resolveAnthropicCredential()) {
          throw new UsageError(`j${id} not started — this shell has no Anthropic credential. Inside the chat, type \`sumo job run ${id}\` on its own; in a terminal, export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY first`);
        }
        const watch = process.stdout.isTTY ? jobPrinter((t) => process.stdout.write(t), styles(colourEnabled())) : {};
        // Ctrl-C stops the run the way Esc stops one in the chat: what it started is stopped, and how it ended is still written down.
        const stop = new AbortController();
        const interrupt = () => stop.abort();
        process.once('SIGINT', interrupt);
        try {
          outcome = await runJobLoop(db, id, { ...watch, signal: stop.signal, ...(process.stdout.isTTY ? { onStart: (job) => tabBegins(db, job, watch.onStart) } : {}) });
        } finally {
          process.off('SIGINT', interrupt);
        }
      } catch (cause) {
        // A chat waiting on this run's tab reads how it ended from disk; a run that never began has to say so there too.
        jobs.recordOutcome(id, [cause.message]);
        throw cause;
      }
      const lines = runLines(outcome);
      jobs.recordOutcome(id, lines);
      tabEnds(outcome.job, lines[0]);
      return lines;
    }
    case 'show':
      return [jobs.show(db, id)];
    case 'note':
      jobs.note(db, id, stdinText(flags));
      return [`noted on j${id}`];
    case 'ask':
      jobs.ask(db, id, stdinText(flags));
      return [`STATUS: NEEDS_INPUT — j${id}. Stop now; you will be resumed with the answer.`];
    case 'answer':
      jobs.answer(db, id, stdinText(flags));
      return [`answered j${id}. Continue it: sumo job run ${id}   (the brief now carries the answer)`];
    case 'tell':
      jobs.tell(db, id, stdinText(flags));
      return [`told j${id} — it reads it with its next request`];
    case 'abandon':
      jobs.abandon(db, id);
      // A task just ended: if the session is already big, this is the cheapest moment to start a fresh one.
      return [`abandoned j${id}`, ...[taskEndedNudge(db)].filter(Boolean)];
    case 'baseline':
      return jobs.baseline(db, id);
    case 'verify': {
      const verdict = jobs.verifyJob(db, id);
      return [verdict.ok ? `j${id} would be accepted as DONE:` : `j${id} would be REFUSED as DONE:`, ...verdictLines(verdict).map((l) => `  ${l}`)];
    }
    case 'changes': {
      const { file, files } = jobs.changes(db, id);
      return [`${files} file${files === 1 ? '' : 's'} changed — ${file}`];
    }
    default: {
      const { job, learned, verdict, unverified } = jobs.finish(db, id, { status: String(flags.status ?? '').toUpperCase(), report: stdinText(flags), accept: flags.accept });
      // A worker's plain DONE means the checks agreed; the verdict is in the report. Only the exceptions are said here.
      return [
        `STATUS: ${job.status === 'done' ? 'DONE' : 'FAILED'}${unverified ? ' (UNVERIFIED — taken without running the checks)' : ''} — j${id}`,
        ...(verdict?.flags ?? []).map((f) => `  look at: ${f}`),
        ...learned.applied.map((l) => `  ${l}`),
        ...[taskEndedNudge(db)].filter(Boolean),
      ];
    }
  }
}

async function runScribeCommand(db, { args }) {
  if (args[0] === 'run') return outcomeLines(await runScribe(db));
  if (args[0] === 'status') return scribeStatus(db);
  if (args[0] === 'stats') return modelStats(db);
  // Exactly what the cheap model would be sent right now — nothing about the writer is hidden from the user.
  if (args[0] === 'show') return [buildBundle(db)?.prompt ?? 'nothing new was said'];
  throw new UsageError(`usage: ${USAGE.scribe}`);
}

async function runDreamCommand(db, { args }) {
  if (args[0] === 'run') return outcomeLines(await runDream(db, { force: true }));
  if (args[0] === 'status') return dreamStatus(db);
  throw new UsageError(`usage: ${USAGE.dream}`);
}

/** Runs a model's proposed operations through the same validator the automatic passes use. */
function runApply(db, { args, flags }) {
  need(args, 1, 'apply');
  const source = flags.source ?? 'scribe';
  if (source !== 'scribe' && source !== 'dream') throw new UsageError('--source is scribe or dream');
  const ops = JSON.parse(readFileSync(args[0], 'utf8')).ops;
  const ids = (Array.isArray(ops) ? ops : []).map((op) => Number(op?.turn)).filter(Number.isInteger);
  const rows = ids.length > 0 ? db.prepare(`SELECT * FROM user_turns WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) : [];
  const { applied, dropped } = applyOps(db, ops, { source, turns: new Map(rows.map((t) => [t.id, t])), now: new Date().toISOString() });
  return [...applied, ...dropped.map((l) => `dropped — ${l}`), ...(applied.length + dropped.length === 0 ? ['no operations'] : [])];
}

/** Runs until Ctrl-C: the page is only there while someone is looking at it. */
async function runMemoryPage(db) {
  const page = await servePage(db);
  process.stdout.write(`your memory: ${page.url}\nCtrl-C to stop\n`);
  openInBrowser(page.url);
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await page.close();
  return ['stopped'];
}

function runExport(db, { flags }) {
  return [flags.json ? JSON.stringify(exportJson(db), null, 2) : exportMarkdown(db)];
}

function runBackup(db) {
  const { file, pruned } = backup(db);
  return [`backed up to ${file}${pruned > 0 ? ` (removed ${pruned} old)` : ''}`];
}

function runDoctor() {
  const checks = doctor();
  for (const c of checks) {
    const mark = c.ok ? 'ok  ' : c.warn ? 'warn' : 'FAIL';
    process.stdout.write(`${mark}  ${c.label}${c.ok ? '' : ` — ${c.fix}`}\n`);
  }
  return checks.some((c) => !c.ok && !c.warn) ? 1 : 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (Object.hasOwn(USAGE, command) && (rest.includes('--help') || rest.includes('-h'))) {
      process.stdout.write(`${USAGE[command]}\n`);
      return 0;
    }
    if (command === 'setup') {
      const { flags } = parse(rest, { value: ['bin-dir', 'model-source'], bool: ['no-link', 'no-model'] });
      const lines = await setup({ binDir: flags['bin-dir'], link: !flags['no-link'], modelSource: flags['model-source'], noModel: !!flags['no-model'] });
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    if (command === 'hook') {
      // No usage errors, no exit codes, no stderr: an event that complains breaks the session it serves.
      process.stdout.write(runHook(rest[0], process.stdin.isTTY ? '' : readFileSync(0, 'utf8')));
      return 0;
    }
    if (command === 'chat') {
      const { flags } = parse(rest, { value: ['model', 'effort'], bool: [] });
      const db = openDb();
      try {
        return await chat(db, { model: flags.model, effort: flags.effort });
      } finally {
        db.close();
      }
    }
    if (command === 'doctor') return runDoctor();
    if (command === 'config') {
      const { args } = parse(rest, { value: [], bool: [] });
      process.stdout.write(`${config(args[0], args[1]).join('\n')}\n`);
      return 0;
    }

    // Own keys only: `sumo constructor` is not a command just because every object has one.
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!spec) throw new UsageError(`unknown command "${command}" — see: sumo help`);
    const parsed = parse(rest, spec);
    const db = openDb();
    try {
      const lines = await spec.run(db, parsed);
      process.stdout.write(`${lines.join('\n')}\n`);
    } finally {
      db.close();
    }
    return 0;
  } catch (cause) {
    process.stderr.write(`sumo: ${cause.message}\n`);
    return cause instanceof UsageError ? 2 : 1;
  }
}
