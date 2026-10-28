import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { discoverModels, knownModel, MODEL_IDS, modelLines, setModel } from './catalog.mjs';
import { openDb } from './db.mjs';
import { backup, damaged, exportJson, exportMarkdown, liveDatabase, purgeFromBackups, restoreCandidate, restoreHint, restoreLines, restoreQuestion } from './export.mjs';
import { resolveAnthropicCredential } from './auth.mjs';
import { costLines } from './cost.mjs';
import { runHook } from './hooks.mjs';
import * as jobs from './jobs.mjs';
import * as memory from './memory.mjs';
import { NeedsCredential, Refusal, UsageError } from './memory.mjs';
import { prime } from './prime.mjs';
import * as projects from './projects.mjs';
import { detail, historyLine, line, scopeLabel } from './render.mjs';
import { memoryStatus, passLines as memoryPassLines, runMemoryPass } from './keeper.mjs';
import { buildBundle, outcomeLines } from './scribe.mjs';
import { findSaved, searchTurns, taskEndedNudge } from './sessions.mjs';
import { closest, saysAs } from './text.mjs';
import { heldBy } from './lock.mjs';
import { redact } from './redact.mjs';
import { VERSION } from './paths.mjs';
import { CHAT_EFFORTS, config, doctor, makePrivate, positiveInteger, reportOf, setup, uninstall, uninstallPlan, uninstallQuestion } from './setup.mjs';
import { colourEnabled, safeForTerminal, styles } from './tty.mjs';
import { ftsQuery } from './text.mjs';
import { verdictLines } from './verify.mjs';

const DOCS = 'https://github.com/sumododda/sumo-agents/wiki';
const ISSUES = 'https://github.com/sumododda/sumo-agents/issues';

const HELP = `sumo — one chat across your projects, memory that lasts, and jobs checked before they say done

  sumo chat [--model M] [--effort E] [--resume [id]]   talk, with this memory behind it
  sumo search <query> [--project S] [--type T] [-n N]  what is remembered; --turns: what was said
  sumo add <type> "<text>" [--project S]               a preference · fact · decision · gotcha
  sumo learn "<title>" --cue "<action>"                a workflow, its steps on stdin · sumo gate
  sumo show|history|confirm|reject|forget <id>         sumo supersede <old> <new>
  sumo memory [run [--tidy] | status | show]           the page · the pass that files and tidies
  sumo project add <path> [--slug S] [--alias A]...    show · list · rescan · alias · archive
  sumo job new --project S --title T [--agent A]       a job, its task on stdin
        by id: run · watch · tell · note · ask · answer · show · brief · baseline · verify · changes
        finish <id> --status DONE|FAILED · abandon · retry · list [--all] · stats
  sumo prime · sumo --version                          the block a session starts with · which sumo
  sumo export [--json] · sumo backup [restore [file]] · sumo cost [--days N] [--project S]
  sumo models [discover | enable <name> | disable <name>]   the API models: which are here and on
  sumo mcp [add | remove | tools | allow | revoke] <name>   MCP servers, for the chat and every job
  sumo setup · sumo uninstall · sumo config [key [value]] · sumo doctor [--fix] [--report]

Scope is global plus --project; other projects stay hidden without --everywhere.
Exit: 0 done · 1 not done or failed · 2 the command line was wrong · 4 needs an Anthropic credential
Every option: sumo help <command> · the docs: ${DOCS}
A bug: sumo doctor --report, redacted, to ${ISSUES}
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
  chat: 'sumo chat [--model auto|<model>] [--effort <effort>] [--resume [id]]    (piped: plain lines, the memory block first; --resume picks a saved session up, the newest without an id)',
  search: `sumo search <query> [--project S] [--type T] [--since <YYYY-MM-DD|Nd>] [--before <YYYY-MM-DD>]
  --project S    that project's memories beside the global ones; other projects stay hidden
  --everywhere   every project's memories
  --type T       preference, fact, decision, gotcha or workflow
  --all          forgotten and replaced memories too
  --since        said or changed since that day, or in the last N days (7d); --before: said before that day
  -n N           at most N, the best first (8 unless said)
  --json         one object for a script: {memories, more, elsewhere} (with --turns: {turns})
  --turns        what the user typed, not what is remembered`,
  add: `sumo add preference|fact|decision|gotcha "<one sentence>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
a workflow (steps to repeat) is saved with sumo learn instead:
${LEARN_USAGE}`,
  learn: LEARN_USAGE,
  show: 'sumo show <id> [--json]',
  history: 'sumo history <id>',
  supersede: 'sumo supersede <old-id> <new-id>',
  gate: "sumo gate <workflow-id> '<regex over the shell command>'    |    sumo gate <workflow-id> off",
  forget: 'sumo forget <id> [--purge [--yes]]    (--purge erases it for good, from every backup; it asks first, or --yes)',
  confirm: 'sumo confirm <id>',
  reject: 'sumo reject <id>',
  memory: 'sumo memory [run [--tidy] | status | show]    (no argument serves the page on this machine and opens it; Ctrl-C stops it)',
  project: `sumo project add <path> [--slug S] [--alias A]...
sumo project show <name> | list [--all] [--json] | rescan <name> | alias <name> <alias> | archive <name>   (add it again to bring it back)`,
  job: `sumo job new --project S --title T [--agent scout|worker|reviewer]   (task on stdin)
        [--guide fix|feature|review|none]   carry guides/<name>.md into the brief (unsaid: what the title and goal ask for)
        [--reviews <id>]                 reviewer: judge that job's change (default: what is uncommitted)
        [--tests-may-change]             worker: this task is allowed to edit tests that already exist
        [--attempts 2|3]                 worker: that many attempts, each in a worktree of its own; the best verified one is kept
sumo job brief|show|abandon <id>
sumo job run <id>             runs the job here, in Sumo's own loop, on its route; it closes itself as its brief says
                              then, unasked: a first attempt that failed is retried one step up, risky work done is reviewed (jobs.review)
sumo job watch <id>           what a job running in the chat is doing, as it does it (a Herdr tab shows this)
sumo job note|ask|answer|tell <id>                               (text on stdin; tell: a message a running job reads next)
sumo job baseline <id>        the project's checks, before the work
sumo job verify <id>          the same checks now, judged against the baseline
sumo job changes <id>         everything the job changed, as one file
sumo job finish <id> --status DONE|FAILED [--accept "<why>"]     (report on stdin)
sumo job retry <id>           a failed job, or a done one reviewed with important >= 3, routed afresh
sumo job stats [--project S]  jobs, done, failed, reviewed, avg important, and what a job took — per role and model/effort
sumo job list [--all] [--json]`,
  prime: 'sumo prime [--budget N]',
  cost: 'sumo cost [--days N] [--project S]    what the requests cost, by kind and model: fresh input, cache reads, cache writes and output; then the cache rewrites — context written again while the cache should still have held it',
  apply: 'sumo apply <ops.json> [--source scribe|dream]',
  export: 'sumo export [--json]',
  backup: 'sumo backup [restore [file] [--yes]]    (restore: the newest copy, or the one named, put back, the one there kept aside; over a database that is fine it asks first, or --yes)',
  models: `sumo models                    every model Sumo knows: on or off, its API id, and why
sumo models discover           ask the API which of them this credential can use, and set the switches from the answer (one turned off by hand stays off)
sumo models enable|disable <name>`,
  mcp: `sumo mcp                        every configured server: where it is, its tools or why it failed, what may run unasked
sumo mcp add <name> [--env K=V]... -- <command> [args...]     a server run as a process (stdio)
sumo mcp add <name> --url <url> [--header K=V]...             a server reached over HTTP
        \${NAME} in a value is filled from the shell when the server starts: the file never holds a token
sumo mcp add <name> --url <url> --from-claude                 a server Claude Code is logged in to (claude mcp login <name>): its token is borrowed
sumo mcp remove <name>
sumo mcp tools <name>           the server's tools, one a line
sumo mcp allow <name> <tool>|all      let it run without asking      sumo mcp revoke <name> <tool>|all`,
  setup: 'sumo setup [--bin-dir DIR] [--no-link] [--model-source URL] [--no-model]',
  uninstall: 'sumo uninstall [--yes] [--discard-memory]    (removes what setup made — the home\'s own files, its sumo links, the local model\'s server — after copying the memory out beside the home; asks first, or --yes)',
  doctor: 'sumo doctor [--fix] [--report]    (--fix: make the files of the home private · --report: version, checks, settings, MCP server names, the last crash and the logs\' tails — redacted, printed here, sent nowhere)',
  config: 'sumo config [key [value]]',
  hook: 'sumo hook session-start|prompt|pre-tool|stop|session-end    (for a harness\'s hook configuration: the event\'s JSON on stdin, what to add to the session on stdout; never fails the session)',
};

/** A usage text as `--help` prints it: a line too wide for the terminal (100 columns at most, or piped) goes on, indented, below. */
function wrapped(text, width = Math.min(process.stdout.columns || 100, 100)) {
  return text
    .split('\n')
    .flatMap((line) => {
      if (line.length <= width) return [line];
      const lead = line.match(/^ */)[0];
      const indent = `${lead}    `;
      const lines = [];
      let current = lead;
      for (const word of line.trimStart().split(/ +/)) {
        const joined = current.trim() === '' ? `${current}${word}` : `${current} ${word}`;
        if (joined.length > width && current.trim() !== '') {
          lines.push(current);
          current = `${indent}${word}`;
        } else current = joined;
      }
      return [...lines, current];
    })
    .join('\n');
}

const ADDABLE = ['preference', 'fact', 'decision', 'gotcha'];

/**
 * Who runs this command: the model's shell carries SUMO_TOOL, a job's SUMO_JOB too. Under either, what only the user does is
 * refused — the allow list, the switches and the configuration — and a job writes no memory at all. The chat may still remember
 * for the user, held to what the user typed: a statement none of their recent words say is kept unconfirmed, for them to say yes to.
 */
const fromTool = () => Boolean(process.env.SUMO_TOOL || process.env.SUMO_JOB);
const fromJob = () => process.env.SUMO_JOB || null;
/** Typed by the user at a terminal: no model's shell, and a terminal at both ends — another harness's tool runs without one. */
const byUser = () => (!fromTool() && process.stdin.isTTY && process.stdout.isTTY ? 'user' : undefined);
const OWNER_ONLY = "Refused: the model's shell does not change what the user controls — the MCP allow list, the models and the configuration. If the user wants it, they run it themselves: `! sumo …`";
const jobWrites = () => `Refused: j${fromJob()} runs this command, and a job never writes memory. Put what you learned in your report; the user, or the chat, decides what is kept.`;
const RECENT_TURNS = 40;
/**
 * Whether something the user typed lately says what the memory says — nearly all of its words, the same way round — so
 * a memory the model files as the user's is really theirs. A few of the user's words inside much they never said, or
 * their rule turned round, is not.
 */
function saidByUser(db, text) {
  return db
    .prepare('SELECT text FROM user_turns ORDER BY id DESC LIMIT ?')
    .all(RECENT_TURNS)
    .some((turn) => saysAs(text, turn.text));
}
const HELD = (id) => `held as unconfirmed: nothing the user typed lately says this, so it is theirs to confirm — sumo confirm m${id}, or sumo reject m${id}`;
/** The docs say "workflow", the store says "procedure"; whoever types either means the same thing. */
const WORKFLOW_NAMES = ['workflow', 'procedure'];

/** value: flags that take an argument; bool: flags that don't; max: the most words it takes. Anything else is a typo and says so. */
const COMMANDS = {
  search: { value: ['project', 'type', 'n', 'since', 'before'], bool: ['everywhere', 'all', 'turns', 'json'], run: runSearch },
  add: { value: ['project', 'topic', 'supersedes'], bool: ['pin', 'observed'], run: runAdd },
  learn: { value: ['project', 'cue', 'gate', 'from-file'], bool: [], run: runLearn },
  gate: { value: [], bool: [], run: runGate },
  show: { value: [], bool: ['json'], max: 1, run: (db, { args, flags }) => (flags.json ? asJson({ memory: memory.get(db, memory.parseId(args[0])) }) : [detail(memory.get(db, memory.parseId(args[0])))]) },
  history: { value: [], bool: [], max: 1, run: (db, { args }) => memory.history(db, memory.parseId(args[0])).map(historyLine) },
  supersede: { value: [], bool: [], max: 2, run: runSupersede },
  forget: { value: [], bool: ['purge', 'yes'], max: 1, run: runForget },
  confirm: { value: [], bool: [], max: 1, run: runConfirm },
  reject: { value: [], bool: [], max: 1, run: (db, { args }) => [`rejected ${line(memory.reject(db, memory.parseId(args[0])))}`] },
  memory: { value: [], bool: ['tidy'], run: runMemoryCommand },
  project: { value: ['slug'], multi: ['alias'], bool: ['all', 'json'], run: runProject },
  job: { value: ['project', 'title', 'agent', 'status', 'from-file', 'guide', 'reviews', 'accept', 'attempts'], bool: ['all', 'tests-may-change', 'json'], run: runJob },
  prime: { value: ['budget'], bool: [], max: 0, run: (db, { flags }) => [forPerson(prime(db, { budget: flags.budget === undefined ? undefined : positiveInteger(flags.budget, '--budget needs a positive number') }))] },
  scribe: { value: [], bool: [], run: renamed },
  cost: { value: ['days', 'project'], bool: [], max: 0, run: (db, { flags }) => costLines(db, { days: flags.days === undefined ? undefined : positiveInteger(flags.days, '--days needs a positive number'), project: flags.project }) },
  dream: { value: [], bool: [], run: renamed },
  apply: { value: ['source'], bool: [], max: 1, run: runApply },
  export: { value: [], bool: ['json', 'md'], max: 0, run: runExport },
  backup: { value: [], bool: ['yes'], run: runBackup },
  models: { value: [], bool: [], run: runModels },
  mcp: { value: ['url'], multi: ['env', 'header'], bool: ['from-claude'], run: runMcp },
};

/**
 * At a terminal, text written for a model reads as text for a person: the tags that mark it — <sumo-memory>, <project …>
 * — become words. Piped, to a hook, a harness or the model, it is exactly what the model reads.
 */
function forPerson(text) {
  if (!process.stdout.isTTY) return text;
  return text
    .replace(/^<sumo-memory>\n?/m, () => 'What a session starts with:\n')
    .replace(/^<project ([^>\s]+)( \(archived\))?> /m, (_, slug, archived = '') => `${slug}${archived} · `)
    .replace(/\n?<\/(?:sumo-memory|project)>\s*$/, () => '');
}

/** What `--json` prints: one object, its lists named, for a script to read; nothing else on stdout. */
const asJson = (value) => [JSON.stringify(value, null, 2)];
/** A memory as a script sees it: the stored row, without what ranking added to it. */
const plainMemory = ({ rank, score, ...row }) => row;

/** Memory a job's shell never writes: it reports, and the user or the chat decides. */
const JOB_NEVER = ['add', 'learn', 'gate', 'supersede', 'forget', 'confirm', 'reject', 'apply'];
/** What the model's shell never changes, by command and the subcommands that change something. */
const OWNER_COMMANDS = new Map([
  ['mcp', (args) => ['add', 'remove', 'allow', 'revoke'].includes(args[0])],
  ['models', (args) => ['enable', 'disable', 'discover'].includes(args[0])],
  ['backup', (args) => args[0] === 'restore'],
]);

function parse(argv, spec) {
  const args = [];
  const flags = {};
  const nameOf = (token) => (token.startsWith('--') ? token.slice(2) : token === '-n' ? 'n' : null);
  const names = [...spec.value, ...(spec.multi ?? []), ...spec.bool];
  const spelled = (o) => (o === 'n' ? '-n' : `--${o}`);
  // One of this command's own flags where a value belongs means the value was left out — `--topic --pin` is not a topic.
  const isFlag = (token) => names.includes(nameOf(token.split('=')[0]));
  for (let i = 0; i < argv.length; i++) {
    let token = argv[i];
    if (token === '--') {
      args.push(...argv.slice(i + 1));
      break;
    }
    // `--days=7` is `--days 7`, and `-n5` is `-n 5`, as everywhere else on the command line.
    let given;
    if (/^--[^=]+=/.test(token)) [token, given] = [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)];
    else if (/^-n\d+$/.test(token) && spec.value.includes('n')) [token, given] = ['-n', token.slice(2)];
    const name = nameOf(token);
    if (name === null && /^-[A-Za-z]+$/.test(token)) {
      // `-p` is not a word of the query: a short flag nobody here takes is a mistake to say, not text to search for.
      const meant = names.filter((o) => o !== 'n' && o.startsWith(token[1].toLowerCase()));
      const hint = meant.length === 1 ? `did you mean --${meant[0]}?` : 'options are spelled out (--project, --type, …)';
      throw new UsageError(`unknown option ${token} — ${hint} To mean it as text, quote the whole value or put it after --`);
    }
    if (name === null) {
      args.push(token);
    } else if (spec.bool.includes(name)) {
      if (given !== undefined) throw new UsageError(`${token} takes no value — leave out =${given}`);
      flags[name] = true;
    } else if (spec.value.includes(name) || spec.multi?.includes(name)) {
      if (given === undefined && (i + 1 >= argv.length || isFlag(argv[i + 1]))) throw new UsageError(`${token} needs a value`);
      const value = given ?? argv[++i];
      if (spec.multi?.includes(name)) (flags[name] ??= []).push(value);
      else flags[name] = value;
    } else {
      // Said with the one it most likely meant, or the ones it does take, so the next try is the right one.
      const near = closest(name, names);
      const takes = names.length > 0 ? `takes ${[...names].sort().map(spelled).join(', ')}` : 'takes none';
      throw new UsageError(`unknown option ${token} — ${near ? `did you mean ${spelled(near)}? It ${takes}` : `this command ${takes}`}`);
    }
  }
  return { args, flags };
}

function need(args, count, command) {
  if (args.length < count) throw new UsageError(`usage: ${USAGE[command]}`);
}

/**
 * Asked at a terminal before what cannot be taken back, or what loses work: true only when one of `answers` is typed.
 * `--yes` is the answer given up front; with no terminal and no --yes there is nobody to ask, and nothing is done.
 */
async function confirmed(flags, why, question, answers) {
  if (flags.yes) return true;
  if (!process.stdin.isTTY || !process.stdout.isTTY) throw new UsageError(`${why}, so it asks first — run it in a terminal, or add --yes`);
  const { createInterface: asker } = await import('node:readline/promises');
  const rl = asker({ input: process.stdin, output: process.stdout });
  try {
    // What it is about first, then the question on a line of its own: readline redraws only the last line.
    const said = question.split('\n');
    const asked = said.pop();
    if (said.length > 0) process.stdout.write(`${said.join('\n')}\n`);
    // Ctrl-C or Ctrl-D at the question is a no.
    const typed = await rl.question(asked).catch(() => '');
    return answers.includes(typed.trim().toLowerCase());
  } finally {
    rl.close();
  }
}

const DAY_MS = 86_400_000;

/**
 * A day as typed after --since or --before: 2026-10-01 is the start of that day in UTC, the day every date memory shows
 * is in. Where `back` allows it, 7d is that many days back from now.
 */
function dayFlag(raw, flag, { back = false } = {}) {
  if (raw === undefined) return undefined;
  const days = back ? /^(\d+)d$/.exec(raw) : null;
  const time = days && Number(days[1]) > 0 ? new Date(Date.now() - Number(days[1]) * DAY_MS) : null;
  if (time && !Number.isNaN(time.getTime())) return time.toISOString();
  // A day that does not exist, 2026-02-30, would roll over into the next month: it is a typo, and said as one.
  const day = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? new Date(`${raw}T00:00:00.000Z`) : null;
  if (day && !Number.isNaN(day.getTime()) && day.toISOString().startsWith(raw)) return day.toISOString();
  throw new UsageError(`${flag} takes a day (YYYY-MM-DD)${back ? ' or a number of days back (7d)' : ''}, not "${raw}"`);
}

function runSearch(db, { args, flags }) {
  need(args, 1, 'search');
  const limit = flags.n === undefined ? undefined : positiveInteger(flags.n, '-n needs a positive number');
  const since = dayFlag(flags.since, '--since', { back: true });
  const before = dayFlag(flags.before, '--before');

  if (flags.turns) {
    if (since || before) throw new UsageError('--since and --before hold memories to a time, not what the user typed — leave out --turns, or the dates');
    const match = ftsQuery(args.join(' '));
    if (!match) throw new UsageError('nothing to search for');
    const turns = searchTurns(db, match, limit);
    if (flags.json) return asJson({ turns });
    return turns.length > 0 ? turns.map((t) => `t${t.id} ${t.ts.slice(0, 10)} ${t.text.replace(/\s+/g, ' ').slice(0, 200)}`) : [`the user never said anything like: ${args.join(' ')}`];
  }

  const { results, elsewhere, more } = memory.search(db, args.join(' '), {
    project: flags.project,
    type: WORKFLOW_NAMES.includes(flags.type) ? 'procedure' : flags.type,
    everywhere: flags.everywhere,
    all: flags.all,
    since,
    before,
    limit,
  });

  if (flags.json) return asJson({ memories: results.map(plainMemory), more, elsewhere });
  // An explicit "nothing" is an answer: it is what lets an agent say
  // "not in memory" instead of guessing.
  const out = results.length > 0 ? results.map(line) : [`nothing in memory for: ${args.join(' ')}`];
  // A list cut short says so, and how to see the rest.
  if (more > 0) out.push(`… ${more} more — -n ${results.length + more} shows them all, or narrow the words`);
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
  if (fromJob()) throw new Refusal(jobWrites());
  const [type, ...text] = args;
  if (WORKFLOW_NAMES.includes(type)) throw new UsageError(`a workflow has a title and steps, so it is saved with sumo learn, not sumo add:\n${LEARN_USAGE}`);
  if (!ADDABLE.includes(type)) throw new UsageError(`unknown type "${type}" — one of: ${ADDABLE.join(', ')} (for a workflow: sumo learn)`);
  const body = text.join(' ');
  // From the model's shell, the user's word is checked against the user's words: an inferred memory waits unconfirmed.
  const held = fromTool() && !saidByUser(db, body);
  const saved = memory.add(db, {
    type,
    body,
    project: flags.project,
    topic: flags.topic,
    pin: flags.pin,
    supersedes: flags.supersedes === undefined ? undefined : memory.parseId(flags.supersedes),
    provenance: held ? 'inferred' : flags.observed ? 'observed' : 'stated',
    writtenBy: byUser(),
  });
  return savedLines(saved).concat(held ? [HELD(saved.memory.id)] : []);
}

function runLearn(db, { args, flags }) {
  need(args, 1, 'learn');
  if (fromJob()) throw new Refusal(jobWrites());
  const body = flags['from-file'] ? readFileSync(flags['from-file'], 'utf8') : process.stdin.isTTY ? '' : readFileSync(0, 'utf8');
  if (!body.trim()) throw new UsageError('no steps given — pipe them in, or use --from-file <path>');
  const title = args.join(' ');
  const held = fromTool() && !saidByUser(db, [title, flags.cue ?? '', body].join(' '));
  const saved = memory.add(db, { type: 'procedure', title, cue: flags.cue, gate: flags.gate, body, project: flags.project, provenance: held ? 'inferred' : 'stated', writtenBy: byUser() });
  return savedLines(saved).concat(flags.gate ? [`gates shell commands matching: ${flags.gate}`] : [], held ? [HELD(saved.memory.id)] : []);
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

/** A reply that says yes to the question put. */
const AFFIRMS = /^\s*(?:yes|yep|yeah|yup|y|correct|right|that['’]?s right|confirm(?:ed)?|ok(?:ay)?|sure|true|exactly|agreed?|keep (?:it|that)|do it)\b/i;

/**
 * A guess made a memory of the user's. From the model's shell only once the user has spoken since the guess was made,
 * and said yes, or said the thing itself: a model may not add a guess and vouch for it in one go, nor a page tell it
 * to. One held because its conversation read the web or an MCP server only the user confirms (memory.confirm).
 */
function runConfirm(db, { args }) {
  const id = memory.parseId(args[0]);
  if (fromTool()) {
    const row = memory.get(db, id);
    const since = db.prepare('SELECT text FROM user_turns WHERE ts > ? ORDER BY id DESC LIMIT 1').get(row.created_at);
    if (row.state === 'unconfirmed' && row.held_for !== 'outside' && !(since && (AFFIRMS.test(since.text) || saysAs(row.body, since.text)))) {
      throw new UsageError(`m${id} is a guess, and the user has not said yes to it since it was made: ask them first (the ask tool), then sumo confirm m${id} — or they confirm it on the memory page, /memory`);
    }
  }
  return [`confirmed ${line(memory.confirm(db, id, { byUser: !fromTool() }))}`];
}

async function runForget(db, { args, flags }) {
  need(args, 1, 'forget');
  // Erased for good, from the backups too: only the user decides that. A forget without --purge keeps the history.
  if (flags.purge && fromTool()) throw new Refusal(`erasing a memory for good is the user's to do: they run sumo forget ${args[0]} --purge themselves. sumo forget ${args[0]} stops it being true and keeps its history`);
  const id = memory.parseId(args[0]);
  if (flags.purge) {
    // Seen before it goes: the memory as it stands, and its id typed back — the strongest yes, for what no backup brings back.
    const shown = `${line(memory.get(db, id))}\nErase m${id} for good, from every backup too? Type m${id} to confirm: `;
    if (!(await confirmed(flags, `erasing m${id} for good cannot be undone`, shown, [`m${id}`, String(id)]))) throw new Error(`nothing was erased — the answer was not m${id}`);
  }
  const gone = memory.forget(db, id, { purge: flags.purge });
  if (!flags.purge) return [`forgot ${line(gone)}`];
  const { cleaned, failed } = purgeFromBackups(gone);
  const copies = cleaned > 0 ? `, and from ${cleaned} backup${cleaned === 1 ? '' : 's'}` : '';
  const lines = [gone.source_turn !== null ? `purged m${gone.id} — erased, not recoverable, with the sentence it came from${copies}` : `purged m${gone.id} — erased, not recoverable${copies}; no sentence of the user's was tied to it — sumo search --turns finds one if it is there`];
  if (failed.length > 0) lines.push(`still in ${failed.length} backup${failed.length === 1 ? '' : 's'} that could not be cleaned — delete ${failed.length === 1 ? 'it' : 'them'} by hand: ${failed.join(' ')}`);
  return lines;
}

function runProject(db, { args, flags }) {
  const [sub, ...rest] = args;
  if (flags.json && sub !== 'list') throw new UsageError('--json goes with sumo project list');
  switch (sub) {
    case 'add': {
      need(rest, 1, 'project');
      const { project, created, restored, changes } = projects.addProject(db, rest[0], { slug: flags.slug, aliases: flags.alias });
      const rescanned = `rescanned (${changes.added} new, ${changes.updated} changed, ${changes.removed} gone)`;
      const summary = created ? `registered ${project.slug}` : restored ? `${project.slug} is back from the archive — ${rescanned}` : `${project.slug} was already registered — ${rescanned}`;
      // A name asked for a project that has one already is said to be unused, not dropped without a word.
      const kept = !created && flags.slug !== undefined && flags.slug !== project.slug ? [`--slug is for a new project: this one keeps the name ${project.slug} (an alias adds a name: --alias ${flags.slug})`] : [];
      return [summary, ...kept, card(db, project.slug)];
    }
    case 'show':
      need(rest, 1, 'project');
      return [forPerson(card(db, rest[0]))];
    case 'list': {
      const all = projects.listProjects(db, { includeArchived: flags.all });
      if (flags.json) return asJson({ projects: all.map((p) => ({ ...p, aliases: projects.aliasesOf(db, p.slug) })) });
      if (all.length === 0) {
        // None in use is not none at all: archived ones are said, with how to see them.
        const archived = flags.all ? 0 : projects.listProjects(db, { includeArchived: true }).length;
        return [archived > 0 ? `no active projects — ${archived} archived: sumo project list --all` : 'no projects registered — sumo project add <path>'];
      }
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

/** The lines `new` and `retry` both print: the job, its route, and exactly what to start it with. Several attempts are one line each. */
function createdLines(job, warnings, attempts = null) {
  if (attempts) {
    return [
      ...attempts.map((a) => `created ${jobs.jobLine(a, 'not started')}`),
      ...warnings,
      `route: ${job.model}/${job.effort} — ${job.route_reason}`,
      `run each: ${attempts.map((a) => `sumo job run ${a.id}`).join(' · ')} — once all have closed, the best verified one is brought back`,
    ];
  }
  return [
    `created ${jobs.jobLine(job, 'not started')}`,
    ...warnings,
    `route: ${job.model}/${job.effort} — ${job.route_reason}`,
    `run it: sumo job run j${job.id}   (append & to carry on without waiting for it) — inside the chat: delegate with job j${job.id}`,
  ];
}

/** A job's own tab in Herdr: it says it is working, and a line typed into the tab is a message to the job. `herdr` is herdr.mjs, loaded by the run. */
function tabBegins(db, job, print, herdr) {
  print?.(job);
  herdr.reportAgent(herdr.runHerdr, process.env, { job, state: 'working', message: job.title });
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
function tabEnds(job, status, herdr) {
  process.stdin.pause();
  herdr.reportAgent(herdr.runHerdr, process.env, { job, state: job.status === 'needs_input' ? 'blocked' : 'idle', message: status });
  herdr.closeJobTab(herdr.runHerdr, process.env, job);
}

/**
 * `sumo job watch <id>`: what a job running in the chat is doing, as it does it — what its Herdr tab shows, and
 * what any terminal can show. A line typed here is said to the job. Ends with how the run ended.
 */
async function watchJob(db, id) {
  const job = jobs.getJob(db, id);
  if (!existsSync(jobs.liveFile(id)) && job.status !== 'running' && job.status !== 'needs_input') return [`j${id} is ${job.status} — nothing is running`];
  // A job made but never started has no record to follow: that is said, not waited on for ever. A run starting this
  // moment writes its record within a few seconds, or holds its lock while it gets there.
  for (let waited = 0; !existsSync(jobs.liveFile(id)); waited += 250) {
    if (waited >= 5000 && heldBy(jobs.runLockFile(id)) === null) throw new Error(`j${id} has not started — run it: sumo job run j${id}, or in the chat: delegate with job j${id}`);
    await new Promise((r) => setTimeout(r, 250));
  }
  // The record opens with the job's own line, so nothing is printed for it here.
  const herdr = await import('./herdr.mjs');
  tabBegins(db, job, undefined, herdr);
  let at = 0;
  // A character split across two reads is held until its other half arrives.
  const decoder = new StringDecoder('utf8');
  for (;;) {
    // Looked at before reading, so nothing written before the end is missed.
    const ended = existsSync(jobs.endFile(id));
    at = copyFrom(jobs.liveFile(id), at, decoder);
    if (ended) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const lines = safeForTerminal(readFileSync(jobs.endFile(id), 'utf8')).trimEnd().split('\n');
  tabEnds(jobs.getJob(db, id), lines[0], herdr);
  return lines;
}

/** Writes what a file gained since `at`, and says where it ends now. A file not there yet has gained nothing. */
function copyFrom(file, at, decoder) {
  let fd;
  try {
    fd = openSync(file, 'r');
  } catch {
    return at;
  }
  try {
    const size = fstatSync(fd).size;
    // A run that began again starts its record afresh: read it from the top.
    const from = size < at ? 0 : at;
    if (size > from) {
      const chunk = Buffer.alloc(size - from);
      readSync(fd, chunk, 0, chunk.length, from);
      // What a job wrote is shown, never obeyed: colours pass, every other escape is dropped.
      process.stdout.write(safeForTerminal(decoder.write(chunk)));
    }
    return size;
  } finally {
    closeSync(fd);
  }
}

/** A job closed from a shell has its worktree settled here — unless it is the job's own shell, whose run settles it once the run ends. */
const settleHere = (db, id) => (process.env.SUMO_JOB === String(id) ? [] : jobs.settle(db, id));

async function runJob(db, { args, flags }) {
  const [sub, rawId] = args;
  if (flags.json && sub !== 'list') throw new UsageError('--json goes with sumo job list');
  if (sub === 'new') {
    if (!flags.project) throw new UsageError(`usage: ${USAGE.job}`);
    const { job, jobs: attempts, warnings } = await jobs.newJob(db, {
      project: flags.project,
      title: flags.title,
      agent: flags.agent,
      task: stdinText(flags),
      guide: flags.guide,
      reviews: flags.reviews === undefined ? undefined : jobs.parseJobId(flags.reviews),
      testsMayChange: Boolean(flags['tests-may-change']),
      attempts: flags.attempts === undefined ? 1 : Number(flags.attempts),
    });
    return createdLines(job, warnings, attempts);
  }
  if (sub === 'list') {
    const all = jobs.listJobs(db, { all: flags.all });
    if (flags.json) return asJson({ jobs: [...all], more: all.more });
    if (all.length === 0) return [flags.all ? 'no jobs yet — sumo job new --project <name> --title <what> starts one' : 'no open jobs'];
    return [...all.map((job) => jobs.jobLine(job, job.shown)), ...(all.more > 0 ? [`… ${all.more} older — sumo job show <id> for one of them`] : [])];
  }
  if (sub === 'stats') {
    return jobs.stats(db, { project: flags.project });
  }
  if (sub === 'retry') {
    const { job, warnings } = await jobs.retry(db, jobs.parseJobId(rawId));
    return createdLines(job, warnings);
  }
  if (!['brief', 'note', 'ask', 'answer', 'tell', 'finish', 'show', 'abandon', 'baseline', 'verify', 'changes', 'run', 'watch'].includes(sub)) {
    throw new UsageError(`usage: ${USAGE.job}`);
  }
  if (rawId === undefined) throw new UsageError(`sumo job ${sub} needs a job id, like j17 — sumo job list shows them`);
  // An answer and a message reach a job as the user's own words: a job's shell, or text it read, never speaks for the user.
  if ((sub === 'tell' || sub === 'answer') && process.env.SUMO_JOB) {
    throw new Refusal(`Refused: j${process.env.SUMO_JOB} runs this command, and only the user answers or tells a job. Ask instead: the ask tool.`);
  }
  const id = jobs.parseJobId(rawId);
  switch (sub) {
    case 'brief':
      return [jobs.brief(db, id)];
    case 'run': {
      // The job runs here, in Sumo's own loop, on the route the router chose; it closes itself the way its brief says.
      // On a terminal the work is shown as it happens — the lines a Herdr pane shows; piped, only how it ended.
      if (!resolveAnthropicCredential()) {
        throw new NeedsCredential(`j${id} not started — this shell has no Anthropic credential. Inside the chat, the delegate tool runs it; in a terminal, export CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY first`);
      }
      // The run's own machinery, loaded only for a run: the loop brings the SDK, and no other command needs any of it.
      const [{ jobPrinter }, { runJob: runJobLoop, runLines }, herdr] = await Promise.all([import('./chat.mjs'), import('./loop.mjs'), import('./herdr.mjs')]);
      // What the model and its commands print reaches this terminal as text only: no escape of theirs titles the window or writes the clipboard.
      const watch = process.stdout.isTTY ? jobPrinter((t) => process.stdout.write(safeForTerminal(t)), styles(colourEnabled())) : {};
      // Ctrl-C stops the run the way Esc stops one in the chat: what it started is stopped, and how it ended is still said.
      const stop = new AbortController();
      const interrupt = () => stop.abort();
      process.once('SIGINT', interrupt);
      // What follows the job unasked — a retry one step up of a first attempt that failed, a review of risky work done — runs
      // here after it, the same way, and each is said in turn. The job's tab is the first one's: what is typed there goes to it.
      let ran;
      let last;
      try {
        ran = await jobs.runFollowed(
          db,
          id,
          async (each, warnings = []) => {
            last = await runJobLoop(db, each, { ...watch, signal: stop.signal, ...(process.stdout.isTTY && each === id ? { onStart: (job) => tabBegins(db, job, watch.onStart, herdr) } : {}) });
            return [...warnings, ...runLines(last), ...last.settled];
          },
          { signal: stop.signal },
        );
      } finally {
        process.off('SIGINT', interrupt);
      }
      const lines = ran.flatMap((step) => [...(step.line ? ['', step.line] : []), ...(step.result ?? []), ...(step.error ? [`j${step.id} stopped on an error: ${step.error}`] : [])]).map(safeForTerminal);
      tabEnds(last.job, runLines(last)[0], herdr);
      return lines;
    }
    case 'show':
      return [jobs.show(db, id)];
    case 'watch':
      return watchJob(db, id);
    case 'note':
      jobs.note(db, id, stdinText(flags));
      return [`noted on j${id}`];
    case 'ask':
      jobs.ask(db, id, stdinText(flags));
      return [`STATUS: NEEDS_INPUT — j${id}. Stop now; you will be resumed with the answer.`];
    case 'answer':
      jobs.answer(db, id, stdinText(flags));
      return [`answered j${id}. Continue it: delegate with job j${id}, or sumo job run j${id} in a terminal   (the brief now carries the answer)`];
    case 'tell':
      jobs.tell(db, id, stdinText(flags));
      return [`told j${id} — it reads it with its next request`];
    case 'abandon':
      jobs.abandon(db, id);
      // A task just ended: if the session is already big, this is the cheapest moment to start a fresh one.
      return [`abandoned j${id}`, ...(await settleHere(db, id)), ...[taskEndedNudge(db)].filter(Boolean)];
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
      // Taking work unverified is the user's call: never granted from inside a job's own shell, whatever the command looked like.
      if (flags.accept !== undefined && process.env.SUMO_JOB) {
        throw new Refusal(`Refused: j${process.env.SUMO_JOB} runs this command, and work is never taken unverified on its author's word. Finish FAILED with what blocks verification, or ask.`);
      }
      const { job, learned, verdict, unverified } = jobs.finish(db, id, { status: String(flags.status ?? '').toUpperCase(), report: stdinText(flags), accept: flags.accept });
      // A worker's plain DONE means the checks agreed; the verdict is in the report. Only the exceptions are said here.
      return [
        `STATUS: ${job.status === 'done' ? 'DONE' : 'FAILED'}${unverified ? ' (UNVERIFIED — taken without running the checks)' : ''} — j${id}`,
        ...(verdict?.flags ?? []).map((f) => `  look at: ${f}`),
        ...learned.applied.map((l) => `  ${l}`),
        ...(await settleHere(db, id)),
        ...[taskEndedNudge(db)].filter(Boolean),
      ];
    }
  }
}

/** A pass's lines, said where they always were; one that failed also exits 1, so a script or a shell can tell. */
function passLines(outcome) {
  const lines = outcomeLines(outcome);
  return outcome.ok === false && !outcome.skipped ? Object.assign(lines, { exitCode: 1 }) : lines;
}

/**
 * Memory: with no argument, the page to confirm, edit and forget on; `run` the memory pass now — it files what was said
 * and tidies when that is due, or now with `--tidy`; `status` how the pass is doing; `show` exactly what the next
 * pass would be sent, so nothing about it is hidden from the user.
 */
async function runMemoryCommand(db, { args, flags }) {
  // The page waits on the user until Ctrl-C: from the model's shell it would only hang there.
  if (args[0] === undefined && fromTool()) throw new Refusal('the memory page is the user\'s: they open it with /memory in the chat, or sumo memory');
  // Nor with no terminal: piped or in a script, nobody is there to look at it, or to press Ctrl-C.
  if (args[0] === undefined && (!process.stdin.isTTY || !process.stdout.isTTY)) throw new UsageError('the memory page runs until Ctrl-C, so it needs a terminal — run sumo memory in one; sumo memory status and sumo search work anywhere');
  if (args[0] === undefined) return runMemoryPage(db);
  if (args[0] === 'run') return memoryPassLines(await runMemoryPass(db, { tidy: flags.tidy === true }), { asked: flags.tidy === true });
  if (args[0] === 'status') return memoryStatus(db);
  if (args[0] === 'show') return [buildBundle(db)?.prompt ?? 'nothing waits to be filed: the next memory pass has nothing new to read'];
  throw new UsageError(`usage: ${USAGE.memory}`);
}

/** The writer and the tidier were two commands; they are one memory pass now, and the old names say so. */
function renamed() {
  throw new UsageError('the writer and the tidier are one memory pass now: sumo memory run [--tidy] · sumo memory status · sumo memory show');
}

/** Runs a model's proposed operations through the same validator the automatic passes use. */
function runApply(db, { args, flags }) {
  need(args, 1, 'apply');
  const source = flags.source ?? 'scribe';
  if (source !== 'scribe' && source !== 'dream') throw new UsageError('--source is scribe or dream');
  let ops;
  try {
    ops = JSON.parse(readFileSync(args[0], 'utf8')).ops;
  } catch (cause) {
    throw new UsageError(`${args[0]} is not a JSON file of operations ({"ops": [...]}): ${cause.message.split('\n')[0]}`);
  }
  const ids = (Array.isArray(ops) ? ops : []).map((op) => Number(op?.turn)).filter(Number.isInteger);
  const rows = ids.length > 0 ? db.prepare(`SELECT * FROM user_turns WHERE id IN (${ids.map(() => '?').join(', ')})`).all(...ids) : [];
  const { applied, dropped } = applyOps(db, ops, { source, turns: new Map(rows.map((t) => [t.id, t])), now: new Date().toISOString() });
  return [...applied, ...dropped.map((l) => `dropped — ${l}`), ...(applied.length + dropped.length === 0 ? ['no operations'] : [])];
}

/** Runs until Ctrl-C: the page is only there while someone is looking at it. */
async function runMemoryPage(db) {
  const { openInBrowser, servePage } = await import('./page.mjs');
  const page = await servePage(db);
  process.stdout.write(`your memory: ${page.url}\nCtrl-C to stop\n`);
  openInBrowser(page.url);
  await new Promise((resolve) => process.once('SIGINT', resolve));
  await page.close();
  return ['stopped'];
}

/** The models Sumo can run on, their switches, and the two ways the switches are set: by the API's answer, or by hand. */
async function runModels(db, { args }) {
  const [sub, name] = args;
  if (sub === undefined) return modelLines(db);
  if (sub === 'discover') {
    const result = await discoverModels(db);
    if (!result.ok) throw new (/no Anthropic credential/.test(result.error) ? NeedsCredential : Error)(`could not check the models — ${result.error}; nothing was changed`);
    return modelLines(db);
  }
  if ((sub === 'enable' || sub === 'disable') && name !== undefined) {
    setModel(db, name, sub === 'enable');
    return modelLines(db, [name]);
  }
  throw new UsageError(`usage: ${USAGE.models}`);
}

/** `NAME=value` pairs from the command line, as an object. The values are stored as typed: `${NAME}` is filled from the shell when the server starts. */
function pairs(list = [], flag) {
  return Object.fromEntries(
    list.map((pair) => {
      const at = pair.indexOf('=');
      if (at < 1) throw new UsageError(`${flag} takes NAME=value, not "${pair}"`);
      const [name, value] = [pair.slice(0, at), pair.slice(at + 1)];
      // The file never holds a token: one given in the clear is refused, with how to pass it instead — it stays in the shell.
      if (redact(value).text !== value) {
        throw new UsageError(`${flag} ${name} holds a token in the clear, and the file never does — export it in your shell and write \${NAME} in its place (${flag} "${name}=${value.startsWith('Bearer ') ? 'Bearer ' : ''}\${MY_TOKEN}"): it is filled in when the server starts`);
      }
      return [name, value];
    }),
  );
}

/** MCP servers: configured here, connected by every chat and job; what may run without asking is set here too. */
async function runMcp(db, { args, flags }) {
  const { addServer, allowedBy, CLAUDE_CODE_TOKEN, closeMcp, connect, mcpLines, mcpReady, readConfig, removeServer, setAllow } = await import('./mcp.mjs');
  const [sub = 'list', name, ...rest] = args;
  switch (sub) {
    case 'list': {
      // Connecting can take a while — each server is given up to a minute — so a terminal is told what it is waiting for.
      const configured = Object.keys(readConfig().mcpServers ?? {}).length;
      if (configured > 0 && process.stderr.isTTY) process.stderr.write(`connecting to ${configured} MCP server${configured === 1 ? '' : 's'}…\n`);
      const registry = await mcpReady();
      try {
        const lines = mcpLines(registry);
        // Every server failing is a failure, for a script as for a person.
        const servers = registry.error ? [] : registry.servers();
        if (servers.length > 0 && servers.every((one) => !one.ok)) lines.exitCode = 1;
        return lines;
      } finally {
        await closeMcp();
      }
    }
    case 'add': {
      if (!name) throw new UsageError(`usage: ${USAGE.mcp}`);
      let spec;
      if (flags.url) {
        if (rest.length > 0) throw new UsageError('a server is a command or a --url, not both');
        if (!/^https?:\/\/[^\s/]/i.test(flags.url)) throw new UsageError(`--url takes a web address, https://… — not "${flags.url}"`);
        if (flags['from-claude'] && flags.header) throw new UsageError('a token borrowed from Claude Code or --header, not both');
        spec = { url: flags.url, ...(flags.header ? { headers: pairs(flags.header, '--header') } : {}), ...(flags['from-claude'] ? { token: CLAUDE_CODE_TOKEN } : {}) };
      } else if (flags['from-claude']) {
        throw new UsageError('--from-claude goes with --url: the server Claude Code is logged in to');
      } else if (rest.length > 0) {
        spec = { command: rest[0], args: rest.slice(1), ...(flags.env ? { env: pairs(flags.env, '--env') } : {}) };
      } else {
        throw new UsageError('a server is a command (after --) or a --url:\nsumo mcp add <name> -- <command> [args...]   |   sumo mcp add <name> --url <url>');
      }
      addServer(name, spec);
      const borrowed = spec.token === CLAUDE_CODE_TOKEN ? `, with Claude Code's login — log in there first: claude mcp add --transport http --scope user ${name} ${spec.url}, then claude mcp login ${name}` : '';
      return [`added ${name} (${spec.url ? `http: ${spec.url}` : `stdio: ${[spec.command, ...spec.args].join(' ')}`}${borrowed})`, `next: sumo mcp — connects to it and lists its tools; sumo mcp allow ${name} <tool>|all — lets them run without asking`];
    }
    case 'remove':
      if (!name) throw new UsageError(`usage: ${USAGE.mcp}`);
      removeServer(name);
      return [`removed ${name}`];
    case 'tools': {
      if (!name) throw new UsageError(`usage: ${USAGE.mcp}`);
      const spec = readConfig().mcpServers[name];
      if (!spec) throw new UsageError(`no MCP server called ${name} — sumo mcp lists them`);
      const session = await connect(name, spec);
      try {
        if (session.tools.length === 0) return [`${name} offers no tools`];
        const wide = Math.max(...session.tools.map((t) => t.name.length)) + 2;
        return session.tools.map((t) => `  ${t.name.padEnd(wide)}${allowedBy(spec, t.name) ? '(allowed)  ' : ''}${String(t.description ?? '').split('\n')[0]}`);
      } finally {
        await session.close();
      }
    }
    case 'allow':
    case 'revoke': {
      const tool = rest[0];
      if (!name || !tool) throw new UsageError(`usage: ${USAGE.mcp}`);
      setAllow(name, tool, sub === 'allow');
      if (tool === 'all') return [sub === 'allow' ? `${name}: every tool may run without asking` : `${name}: every call asks first`];
      return [sub === 'allow' ? `${name}: ${tool} may run without asking` : `${name}: ${tool} asks first`];
    }
    default:
      throw new UsageError(`usage: ${USAGE.mcp}`);
  }
}

function runExport(db, { flags }) {
  return [flags.json ? JSON.stringify(exportJson(db), null, 2) : exportMarkdown(db)];
}

function runBackup(db) {
  const { file, pruned } = backup(db);
  return [`backed up to ${file}${pruned > 0 ? ` (removed ${pruned} old)` : ''}`];
}

/** The checks as doctor prints them, one a line: the mark, what was checked, and what to do when it is not ok. */
const checkLine = (c, s) => `${c.ok ? s.green('ok  ') : c.warn ? s.yellow('warn') : s.red('FAIL')}  ${c.label}${c.ok ? '' : ` — ${c.fix}`}`;

async function runDoctor({ fix = false, report = false } = {}) {
  if (fix) {
    const fixed = makePrivate();
    process.stdout.write(`fixed: ${fixed.length === 0 ? 'nothing to fix' : `made ${fixed.length} place${fixed.length === 1 ? '' : 's'} private`}\n`);
  }
  const checks = await doctor();
  if (report) {
    process.stdout.write(`${await reportOf(checks.map((c) => checkLine(c, styles(false))))}\n`);
    return 0;
  }
  // On a terminal the mark is coloured, so a failure stands out of a column of oks; piped, it is the same words.
  const s = styles(colourEnabled());
  for (const c of checks) process.stdout.write(`${checkLine(c, s)}\n`);
  return checks.some((c) => !c.ok && !c.warn) ? 1 : 0;
}

export async function main(argv) {
  const [command, ...rest] = argv;
  try {
    if (command === undefined || command === 'help' || command === '--help' || command === '-h') {
      const topic = command === 'help' ? rest[0] : undefined;
      if (topic === undefined) {
        process.stdout.write(HELP);
        return 0;
      }
      if (!Object.hasOwn(USAGE, topic)) {
        const near = closest(topic, Object.keys(USAGE));
        throw new UsageError(`no help for "${topic}" — ${near ? `did you mean "${near}"? ` : ''}the commands are in: sumo help`);
      }
      process.stdout.write(`${wrapped(USAGE[topic])}\n`);
      return 0;
    }
    if (command === '--version' || command === '-v' || command === 'version') {
      process.stdout.write(`sumo ${VERSION || 'unknown'}\n`);
      return 0;
    }
    // After `--` it is text: `sumo search -- --help` searches for it.
    const options = rest.includes('--') ? rest.slice(0, rest.indexOf('--')) : rest;
    if (Object.hasOwn(USAGE, command) && (options.includes('--help') || options.includes('-h'))) {
      process.stdout.write(`${wrapped(USAGE[command])}\n`);
      return 0;
    }
    if (command === 'setup') {
      const { flags } = parse(rest, { value: ['bin-dir', 'model-source'], bool: ['no-link', 'no-model'] });
      const lines = await setup({ binDir: flags['bin-dir'], link: !flags['no-link'], modelSource: flags['model-source'], noModel: !!flags['no-model'] });
      process.stdout.write(`${lines.join('\n')}\n`);
      return 0;
    }
    if (command === 'uninstall') {
      const { args, flags } = parse(rest, { value: [], bool: ['yes', 'discard-memory'] });
      if (args.length > 0) throw new UsageError(`uninstall takes no arguments, not "${args.join(' ')}" — usage: ${USAGE.uninstall}`);
      if (fromTool()) throw new Refusal("removing sumo is the user's to do: they run sumo uninstall themselves");
      // Looked at first — what would go, and a home that must never be removed — and only then asked.
      const plan = uninstallPlan();
      const keepMemory = !flags['discard-memory'];
      if (!(await confirmed(flags, 'removing sumo cannot be undone', uninstallQuestion(plan, { keepMemory }), ['uninstall']))) throw new Error('nothing was removed — the answer was not uninstall');
      process.stdout.write(`${uninstall(plan, { keepMemory }).join('\n')}\n`);
      return 0;
    }
    if (command === 'hook') {
      // No usage errors, no exit codes, no stderr: an event that complains breaks the session it serves.
      process.stdout.write(runHook(rest[0], process.stdin.isTTY ? '' : readFileSync(0, 'utf8')));
      return 0;
    }
    if (command === 'chat') {
      const { args: given, flags } = parse(rest, { value: ['model', 'effort'], bool: ['resume'] });
      // `--resume` alone is the newest saved session; with an id, or the start of one, that session.
      const resume = flags.resume ? (given[0] ?? 'last') : null;
      // Said once, before the screen: past here every turn would fail the same way.
      // A full API id is taken too (claude-opus-5-5), as the chat itself takes one.
      if (flags.model !== undefined && flags.model !== 'auto' && !Object.values(MODEL_IDS).includes(flags.model)) knownModel(flags.model, ['auto']);
      if (flags.effort !== undefined && !CHAT_EFFORTS.includes(flags.effort)) throw new UsageError(`no such effort "${flags.effort}" — one of: ${CHAT_EFFORTS.join(', ')}`);
      if (!resolveAnthropicCredential()) throw new NeedsCredential('the chat needs an Anthropic credential — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in this shell, then: sumo chat');
      const db = openDb();
      try {
        // A session that is not there to resume is said here too, before the screen.
        if (resume !== null) findSaved(db, resume, { now: new Date().toISOString() });
        const { chat } = await import('./chat.mjs');
        return await chat(db, { model: flags.model, effort: flags.effort, resume });
      } finally {
        db.close();
      }
    }
    if (command === 'doctor') {
      const { flags } = parse(rest, { value: [], bool: ['fix', 'report'] });
      return await runDoctor(flags);
    }
    if (command === 'config') {
      const { args } = parse(rest, { value: [], bool: [] });
      if (args[1] !== undefined && fromTool()) throw new Refusal(OWNER_ONLY);
      process.stdout.write(`${config(args[0], args[1]).join('\n')}\n`);
      return 0;
    }

    // Own keys only: `sumo constructor` is not a command just because every object has one.
    const spec = Object.hasOwn(COMMANDS, command) ? COMMANDS[command] : null;
    if (!spec) {
      const near = closest(command, [...Object.keys(COMMANDS), ...Object.keys(USAGE), 'help', 'hook']);
      throw new UsageError(`unknown command "${command}" — ${near ? `did you mean "${near}"? See: sumo help` : 'see: sumo help'}`);
    }
    const parsed = parse(rest, spec);
    // A word more than the command uses is refused, never dropped: `forget m1 m2` must not forget m1 alone and say nothing.
    if (spec.max !== undefined && parsed.args.length > spec.max) {
      const takes = spec.max === 0 ? 'no arguments' : spec.max === 1 ? 'one argument' : `${spec.max} arguments`;
      throw new UsageError(`${command} takes ${takes}, not ${parsed.args.length} ("${parsed.args.slice(spec.max).join(' ')}" is left over) — usage: ${USAGE[command]}`);
    }
    if (JOB_NEVER.includes(command) && fromJob()) throw new Refusal(jobWrites());
    if (OWNER_COMMANDS.has(command) && fromTool() && OWNER_COMMANDS.get(command)(parsed.args)) throw new Refusal(OWNER_ONLY);
    // Putting a copy back is done without opening the database: it may be the one that cannot be opened.
    if (command === 'backup' && parsed.args[0] === 'restore') {
      const copy = restoreCandidate(parsed.args[1] ?? null);
      // A damaged database has nothing to lose; one that is fine loses whatever came after the copy, so that is asked.
      const live = liveDatabase();
      const why = live && `the database in place opens and holds ${live.memories} memor${live.memories === 1 ? 'y' : 'ies'}, and putting a backup over it drops what came after`;
      if (live && !(await confirmed(parsed.flags, why, restoreQuestion(copy, live), ['y', 'yes']))) throw new Error('nothing was restored');
      process.stdout.write(`${restoreLines(copy, live).join('\n')}\n`);
      return 0;
    }
    if (command === 'backup' && parsed.args.length > 0) throw new UsageError(`usage: ${USAGE.backup}`);
    const db = openDb();
    try {
      const lines = await spec.run(db, parsed);
      process.stdout.write(`${lines.join('\n')}\n`);
      return lines.exitCode ?? 0;
    } finally {
      db.close();
    }
  } catch (cause) {
    // A database SQLite cannot read is said with the way back: the newest copy, and the command that restores it.
    process.stderr.write(`sumo: ${cause.message}${damaged(cause) ? ` — ${restoreHint()}` : ''}\n`);
    // 2: the command line was wrong · 1: understood and not done, or it failed · 4: an Anthropic credential is needed.
    return cause instanceof UsageError ? cause.exit : 1;
  }
}
