import { readFileSync } from 'node:fs';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { allowDirectory } from './claude.mjs';
import { openDb } from './db.mjs';
import { dreamStatus, runDream } from './dream.mjs';
import { backup, exportJson, exportMarkdown } from './export.mjs';
import { runHook } from './hooks.mjs';
import * as jobs from './jobs.mjs';
import * as memory from './memory.mjs';
import { UsageError } from './memory.mjs';
import { prime } from './prime.mjs';
import * as projects from './projects.mjs';
import { detail, historyLine, line, scopeLabel } from './render.mjs';
import { buildBundle, modelStats, runScribe, scribeStatus } from './scribe.mjs';
import { searchTurns } from './sessions.mjs';
import { config, doctor, setup } from './setup.mjs';
import { ftsQuery } from './text.mjs';

const HELP = `mem — local memory for the sumo-agents process

  mem search <query> [--project S] [--type T] [--everywhere] [--all] [--turns] [-n N]
  mem add <type> "<text>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
        types: preference · fact · decision · gotcha
  mem learn "<title>" --cue "<action>" [--project S]      workflow steps on stdin
  mem show <id>        mem history <id>        mem gate <workflow-id> '<regex>'|off
  mem supersede <old-id> <new-id>
  mem forget <id> [--purge]
  mem confirm <id>     mem reject <id>
  mem project add <path> [--slug S] [--alias A]...   show S · list · rescan S · alias S A · archive S
  mem job new --project S --title T [--agent scout|worker]   brief ID · note ID · ask ID · answer ID
        finish ID --status DONE|FAILED · show ID · list [--all] · abandon ID      (text on stdin)
  mem prime            the block a session starts with
  mem scribe run|show|status|stats  mem dream run|status       the cheap-model passes
  mem export [--json]  mem backup
  mem setup            mem doctor          mem config [key [value]]

Scope is global plus --project; other projects stay hidden without --everywhere.
`;

const LEARN_USAGE = `mem learn "<short title>" --cue "<the action, in plain words: create a PR>" [--gate '<regex>'] [--project S] <<'EOF'
1. first step
2. second step
EOF
(the steps come on stdin, or from --from-file <path>.
 --cue   brings the steps in with the user's message when they ask for the thing.
 --gate  a regular expression over the shell command; a match waits until the steps have been shown,
         e.g. --gate 'gh(-axi)? pr create|glab mr create'. Without it, the cue's words are matched.)`;

/**
 * Shown by `mem <command> --help` and whenever a command is called wrongly. An agent's first
 * guess at a command is often wrong; the reply has to be enough to get the second one right.
 */
const USAGE = {
  search: 'mem search <query> [--project S] [--type T] [--everywhere] [--all] [--turns] [-n N]',
  add: `mem add preference|fact|decision|gotcha "<one sentence>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
a workflow (steps to repeat) is saved with mem learn instead:
${LEARN_USAGE}`,
  learn: LEARN_USAGE,
  show: 'mem show <id>',
  history: 'mem history <id>',
  supersede: 'mem supersede <old-id> <new-id>',
  gate: "mem gate <workflow-id> '<regex over the shell command>'    |    mem gate <workflow-id> off",
  forget: 'mem forget <id> [--purge]',
  confirm: 'mem confirm <id>',
  reject: 'mem reject <id>',
  project: `mem project add <path> [--slug S] [--alias A]...
mem project show <name> | list [--all] | rescan <name> | alias <name> <alias> | archive <name>`,
  job: `mem job new --project S --title T [--agent scout|worker]        (task on stdin)
mem job brief|show|abandon <id>
mem job note|ask|answer <id>                                    (text on stdin)
mem job finish <id> --status DONE|FAILED                        (report on stdin)
mem job list [--all]`,
  prime: 'mem prime [--budget N]',
  scribe: 'mem scribe run|show|status|stats',
  dream: 'mem dream run|status',
  apply: 'mem apply <ops.json> [--source scribe|dream]',
  export: 'mem export [--json]',
  backup: 'mem backup',
  setup: 'mem setup [--bin-dir DIR] [--no-link]',
  doctor: 'mem doctor',
  config: 'mem config [key [value]]',
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
  project: { value: ['slug'], multi: ['alias'], bool: ['all'], run: runProject },
  job: { value: ['project', 'title', 'agent', 'status', 'from-file'], bool: ['all'], run: runJob },
  prime: { value: ['budget'], bool: [], run: (db, { flags }) => [prime(db, { budget: flags.budget === undefined ? undefined : Number(flags.budget) })] },
  scribe: { value: [], bool: [], run: runScribeCommand },
  dream: { value: [], bool: [], run: runDreamCommand },
  apply: { value: ['source'], bool: [], run: runApply },
  export: { value: [], bool: ['json', 'md'], run: runExport },
  backup: { value: [], bool: [], run: runBackup },
};

function parse(argv, spec) {
  const args = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    const name = token.startsWith('--') ? token.slice(2) : token === '-n' ? 'n' : null;
    if (name === null) {
      args.push(token);
    } else if (spec.bool.includes(name)) {
      flags[name] = true;
    } else if (spec.value.includes(name) || spec.multi?.includes(name)) {
      if (i + 1 >= argv.length) throw new UsageError(`${token} needs a value`);
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
  const limit = flags.n === undefined ? undefined : Number(flags.n);
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) throw new UsageError('-n needs a positive number');

  if (flags.turns) {
    const turns = searchTurns(db, ftsQuery(args.join(' ')), limit);
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
    out.push(`similar — if m${saved.id} replaces one: mem supersede <old-id> m${saved.id}`);
    for (const m of similar) out.push(`  ${line(m)}`);
  }
  return out;
}

function runAdd(db, { args, flags }) {
  need(args, 2, 'add');
  const [type, ...text] = args;
  if (WORKFLOW_NAMES.includes(type)) throw new UsageError(`a workflow has a title and steps, so it is saved with mem learn, not mem add:\n${LEARN_USAGE}`);
  if (!ADDABLE.includes(type)) throw new UsageError(`unknown type "${type}" — one of: ${ADDABLE.join(', ')} (for a workflow: mem learn)`);
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
  return [flags.purge ? `purged m${gone.id} — erased, not recoverable` : `forgot ${line(gone)}`];
}

function runProject(db, { args, flags }) {
  const [sub, ...rest] = args;
  switch (sub) {
    case 'add': {
      need(rest, 1, 'project');
      const { project, created, changes } = projects.addProject(db, rest[0], { slug: flags.slug, aliases: flags.alias });
      const note = allowDirectory(project.path);
      const summary = created ? `registered ${project.slug}` : `${project.slug} was already registered — rescanned (${changes.added} new, ${changes.updated} changed, ${changes.removed} gone)`;
      return [summary, card(db, project.slug), ...(note ? [note] : [])];
    }
    case 'show':
      need(rest, 1, 'project');
      return [card(db, rest[0])];
    case 'list': {
      const all = projects.listProjects(db, { includeArchived: flags.all });
      if (all.length === 0) return ['no projects registered — mem project add <path>'];
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

/** Long text comes on stdin so one allow rule (`Bash(mem *)`) covers every job command; --from-file is the fallback. */
function stdinText(flags) {
  if (flags['from-file']) return readFileSync(flags['from-file'], 'utf8');
  return process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
}

function runJob(db, { args, flags }) {
  const [sub, rawId] = args;
  if (sub === 'new') {
    if (!flags.project) throw new UsageError(`usage: ${USAGE.job}`);
    const { job, warnings } = jobs.newJob(db, { project: flags.project, title: flags.title, agent: flags.agent, task: stdinText(flags) });
    return [
      `created ${jobs.jobLine(job)}`,
      ...warnings,
      `start it with the ${job.agent} sub-agent and exactly this prompt:`,
      `JOB: run \`mem job brief ${job.id}\` and follow it exactly.`,
    ];
  }
  if (sub === 'list') {
    const all = jobs.listJobs(db, { all: flags.all });
    return all.length > 0 ? all.map(jobs.jobLine) : ['no open jobs'];
  }
  if (!['brief', 'note', 'ask', 'answer', 'finish', 'show', 'abandon'].includes(sub)) {
    throw new UsageError(`usage: ${USAGE.job}`);
  }
  const id = jobs.parseJobId(rawId);
  switch (sub) {
    case 'brief':
      return [jobs.brief(db, id)];
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
      return [
        `answered j${id}. Resume the same sub-agent (SendMessage) with: "Your question is answered — run \`mem job brief ${id}\` and continue."`,
        `If that sub-agent is gone, start a new one with: JOB: run \`mem job brief ${id}\` and follow it exactly.`,
      ];
    case 'abandon':
      jobs.abandon(db, id);
      return [`abandoned j${id}`];
    default: {
      const { job, learned } = jobs.finish(db, id, { status: String(flags.status ?? '').toUpperCase(), report: stdinText(flags) });
      return [`STATUS: ${job.status === 'done' ? 'DONE' : 'FAILED'} — j${id}`, ...learned.applied.map((l) => `  ${l}`)];
    }
  }
}

function outcomeLines(outcome) {
  if (outcome.skipped) return [`nothing to do — ${outcome.skipped}`];
  if (!outcome.ok) return [`failed — ${outcome.error}`];
  const cost = `${outcome.usage.inputTokens} tokens in, ${outcome.usage.outputTokens} out, $${outcome.usage.costUsd.toFixed(4)}`;
  return [
    `read ${outcome.turns ?? outcome.sessions} ${outcome.turns === undefined ? 'sessions' : 'turns'} (${cost})`,
    ...outcome.applied.map((l) => `  ${l}`),
    ...outcome.dropped.map((l) => `  dropped — ${l}`),
    ...(outcome.applied.length + outcome.dropped.length === 0 ? ['  nothing worth remembering'] : []),
  ];
}

function runScribeCommand(db, { args }) {
  if (args[0] === 'run') return outcomeLines(runScribe(db));
  if (args[0] === 'status') return scribeStatus(db);
  if (args[0] === 'stats') return modelStats(db);
  // Exactly what the cheap model would be sent right now — nothing about the writer is hidden from the user.
  if (args[0] === 'show') return [buildBundle(db)?.prompt ?? 'nothing new was said'];
  throw new UsageError(`usage: ${USAGE.scribe}`);
}

function runDreamCommand(db, { args }) {
  if (args[0] === 'run') return outcomeLines(runDream(db, { force: true }));
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

export function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      process.stdout.write(HELP);
      return 0;
    }
    if (command in USAGE && (rest.includes('--help') || rest.includes('-h'))) {
      process.stdout.write(`${USAGE[command]}\n`);
      return 0;
    }
    if (command === 'setup') {
      const { flags } = parse(rest, { value: ['bin-dir'], bool: ['no-link'] });
      process.stdout.write(`${setup({ binDir: flags['bin-dir'], link: !flags['no-link'] }).join('\n')}\n`);
      return 0;
    }
    if (command === 'hook') {
      // No usage errors, no exit codes, no stderr: a hook that complains breaks the session it is attached to.
      const harness = rest[rest.indexOf('--harness') + 1] ?? 'claude';
      process.stdout.write(runHook(rest[0], harness, process.stdin.isTTY ? '' : readFileSync(0, 'utf8')));
      return 0;
    }
    if (command === 'doctor') return runDoctor();
    if (command === 'config') {
      const { args } = parse(rest, { value: [], bool: [] });
      process.stdout.write(`${config(args[0], args[1]).join('\n')}\n`);
      return 0;
    }

    const spec = COMMANDS[command];
    if (!spec) throw new UsageError(`unknown command "${command}" — see: mem help`);
    const parsed = parse(rest, spec);
    const db = openDb();
    try {
      process.stdout.write(`${spec.run(db, parsed).join('\n')}\n`);
    } finally {
      db.close();
    }
    return 0;
  } catch (cause) {
    process.stderr.write(`mem: ${cause.message}\n`);
    return cause instanceof UsageError ? 2 : 1;
  }
}
