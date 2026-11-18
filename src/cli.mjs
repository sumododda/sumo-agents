import { closeSync, existsSync, fstatSync, openSync, readFileSync, readSync } from 'node:fs';
import { StringDecoder } from 'node:string_decoder';
import { createInterface } from 'node:readline';
import { applyOps } from './apply.mjs';
import { card } from './card.mjs';
import { knownModel, MODEL_IDS, modelLines } from './catalog.mjs';
import { openDb } from './db.mjs';
import { backup, damaged, exportJson, exportMarkdown, liveDatabase, purgeFromBackups, purgeRowFromBackups, restoreCandidate, restoreHint, restoreLines, restoreQuestion } from './export.mjs';
import { resolveAnthropicCredential } from './auth.mjs';
import { costLines } from './cost.mjs';
import { runHook } from './hooks.mjs';
import * as jobs from './jobs.mjs';
import * as memory from './memory.mjs';
import { NeedsCredential, Refusal, UsageError } from './memory.mjs';
import { noteUsedFrom, prime } from './prime.mjs';
import * as projects from './projects.mjs';
import { detail, foundLine, historyLine, line, saidDetail, saidLine, scopeLabel } from './render.mjs';
import { passLines as memoryPassLines, runMemoryPass } from './keeper.mjs';
import { buildBundle, outcomeLines } from './scribe.mjs';
import { searchAll } from './search.mjs';
import { findSaved, journalEntry, taskEndedNudge } from './sessions.mjs';
import { clip, closest, saysAs } from './text.mjs';
import { heldBy } from './lock.mjs';
import { VERSION } from './paths.mjs';
import { CHAT_EFFORTS, config, doctor, makePrivate, positiveInteger, reportOf, setup, uninstall, uninstallPlan, uninstallQuestion } from './setup.mjs';
import { colourEnabled, safeForTerminal, styles } from './tty.mjs';
import { verdictLines } from './verify.mjs';

const DOCS = 'https://github.com/sumododda/sumo-agents/wiki';
const ISSUES = 'https://github.com/sumododda/sumo-agents/issues';

const HELP = `sumo — one chat across your projects, memory that lasts, and jobs checked before they say done

  sumo chat [--model M] [--effort E] [--resume [id]]   talk, with this memory behind it
  sumo search <query> [--project S] [--type T] [-n N]  what is remembered, then what was said
  sumo add <type> "<text>" [--project S]               a preference · fact · decision · gotcha
  sumo learn "<title>" --cue "<action>"                a workflow, its steps on stdin · sumo gate
  sumo show|history|confirm|reject|forget <id>         sumo supersede <old> <new>
  sumo memory [run|status|check|eval|rebuild|show]     the page · the pass that files and tidies
  sumo project add <path> [--slug S] [--alias A]...    show · list · rescan · alias · archive
  sumo job new --project S --title T [--agent A]       a job, its task on stdin
        by id: run · watch · tell · note · ask · answer · show · brief · baseline · verify · changes
        finish <id> --status DONE|FAILED · abandon · retry · list [--all] · stats
  sumo prime · sumo --version                          the block a session starts with · which sumo
  sumo export [--json] · sumo backup [restore [file]] · sumo cost [--days N] [--project S]
  sumo config                                          every setting, on one page; /config in a chat
  sumo models · sumo mcp [tools <name>]                the API models · the MCP servers, as set
  sumo setup · sumo uninstall · sumo doctor [--fix] [--report]

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
one search: memories first (m12), then the conversations — what you said (t481) and what sumo answered (r3).
every word is looked for first; only when nothing holds them all, any word. sumo show <id> opens any line whole.
  --project S    that project's memories and conversations beside the global ones; other projects are only counted
  --everywhere   every project's memories and conversations
  --type T       preference, fact, decision, gotcha or workflow — memories only
  --all          forgotten and replaced memories too
  --since        said or changed since that day, or in the last N days (7d); --before: said before that day
  -n N           at most N memories, the best first (8 unless said); three lines of conversation follow memories
  --json         one object for a script: {memories, conversations, more, moreConversations, elsewhere, loose}
  --turns        only the conversations, no memories`,
  add: `sumo add preference|fact|decision|gotcha "<one sentence>" [--project S] [--topic T] [--pin] [--supersedes ID] [--observed]
a workflow (steps to repeat) is saved with sumo learn instead:
${LEARN_USAGE}`,
  learn: LEARN_USAGE,
  show: 'sumo show <id> [--json]    (m12 a memory; t481 something you said, r3 something sumo answered — whole, with what was said around it)',
  history: 'sumo history <id>',
  supersede: 'sumo supersede <old-id> <new-id>',
  gate: "sumo gate <workflow-id> '<regex over the shell command>'    |    sumo gate <workflow-id> off",
  forget: 'sumo forget <id> [--purge [--yes]]    (--purge erases it for good, from every backup, with the turns and replies that say it whole — listed first; it asks, or --yes. One turn or reply: sumo forget --purge t12)',
  confirm: 'sumo confirm <id>',
  reject: 'sumo reject <id>',
  memory: `sumo memory [run [--tidy] | status | check [--fix] | eval [--limit N] [--json] | rebuild [--dry-run] [--since D] [--limit N] [--yes] | show]    (no argument serves the page on this machine and opens it; Ctrl-C stops it)
        run: reads the conversations not yet read — also one still going on, and when filing is paused — and tidies when a week has gone by, or now with --tidy (--auto is how a session runs it: finished conversations only, nothing while paused)
        rebuild: reads your conversations again with the extractor as it is now and shows what it would add and which memories it derived that it would no longer file; --dry-run only shows. It never touches what you said to remember, confirmed or pinned; --since a day or 7d, --limit the newest N conversations (each is a model call), --yes for a change wider than a pass may make; one that replaced another memory is kept
        status: whether you are heard and from where, the model in use, what waits, whether filing is on
        check: the search indexes, the newest turn found by search, the spool, the backup, passes left unfinished — exit 1 when one fails; --fix rebuilds an index that fails and tries the spool's set-aside lines again
        eval: the searches that once found nothing run again, and the extractor replayed on your own history (--limit N memories of each kind, 20 unless said; each is a model call) — exit 1 when this extractor scores below the last other one`,
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
  models: 'sumo models    every model Sumo knows: on or off, its API id, and why — switched on and off, and discovered, on the settings page (sumo config)',
  mcp: `sumo mcp                        every server: where it is, its tools or why it failed, what may run unasked
sumo mcp tools <name>           the server's tools, one a line
        added, removed and allowed on the settings page: /config in the chat, or sumo config`,
  setup: 'sumo setup [--bin-dir DIR] [--no-link] [--no-model]    (the local model comes from Memory › Local model, on the settings page: sumo config)',
  uninstall: 'sumo uninstall [--yes] [--discard-memory]    (removes what setup made — the home\'s own files, its sumo links, the local model\'s server — after copying the memory out beside the home; asks first, or --yes)',
  doctor: 'sumo doctor [--fix] [--report]    (--fix: make the files of the home private · --report: version, checks, settings, MCP server names, the last crash and the logs\' tails — redacted, printed here, sent nowhere)',
  config: 'sumo config [key] [--json]    every setting on one page, at a terminal — the arrows change one, it is saved as it changes, Esc closes it; with a key, --json or no terminal, the settings printed',
  hook: 'sumo hook session-start|prompt|pre-tool|stop|session-end    (for a harness\'s hook configuration: the event\'s JSON on stdin, what to add to the session on stdout; never fails the session — sumo help hooks prints the lines for Claude Code)',
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
/** The memory commands a model runs in another harness's shell: each says, there, when that harness is not being heard. */
const HEARD_CHECKED = ['search', 'add', 'prime'];

/**
 * Who runs this command: the model's shell carries SUMO_TOOL, a job's SUMO_JOB too. Under either, what only the user does is
 * refused — the allow list, the switches and the configuration — and a job writes no memory at all. The chat may still remember
 * for the user, held to what the user typed: a statement none of their recent words say is kept unconfirmed, for them to say yes to.
 */
const fromTool = () => Boolean(process.env.SUMO_TOOL || process.env.SUMO_JOB);
const fromJob = () => process.env.SUMO_JOB || null;
/** A count with its noun: `1 turn`, `3 replies`. */
const counted = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** Typed by the user at a terminal: no model's shell, and a terminal at both ends — another harness's tool runs without one. */
const byUser = () => (!fromTool() && process.stdin.isTTY && process.stdout.isTTY ? 'user' : undefined);
const OWNER_ONLY = "Refused: the model's shell does not change what the user controls — the MCP allow list, the models and the settings. The user changes them on the settings page: /config in the chat, or sumo config at a terminal";
/** Where a command that set something by name went: the settings page, the one way a setting changes now. */
const ON_THE_PAGE = (what) => `${what} is set on the settings page now — sumo config at a terminal, or /config in the chat`;
const jobWrites = () => `Refused: j${fromJob()} runs this command, and a job never writes memory. Put what you learned in your report; the user, or the chat, decides what is kept.`;
const RECENT_TURNS = 40;
/**
 * The turn the user typed lately that says what the memory says — nearly all of its words, the same way round — or
 * null: so a memory the model files as the user's is really theirs, and is kept with the turn it was said in. A few of the user's words inside much they never said, or
 * their rule turned round, is not.
 */
function saidByUser(db, text) {
  return db
    .prepare('SELECT id, session_id, text FROM user_turns ORDER BY id DESC LIMIT ?')
    .all(RECENT_TURNS)
    .find((turn) => saysAs(text, turn.text)) ?? null;
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
  show: { value: [], bool: ['json'], max: 1, run: runShow },
  history: { value: [], bool: [], max: 1, run: (db, { args }) => memory.history(db, memory.parseId(args[0])).map(historyLine) },
  supersede: { value: [], bool: [], max: 2, run: runSupersede },
  forget: { value: [], bool: ['purge', 'yes'], max: 1, run: runForget },
  confirm: { value: [], bool: [], max: 1, run: runConfirm },
  reject: { value: [], bool: [], max: 1, run: (db, { args }) => [`rejected ${line(memory.reject(db, memory.parseId(args[0]), undefined, { actor: fromTool() ? 'model-shell' : 'user' }))}`] },
  memory: { value: ['limit', 'since'], bool: ['tidy', 'auto', 'fix', 'json', 'dry-run', 'yes'], run: runMemoryCommand },
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
  // The flags the retired `mcp add` took are still read, so that it is told where adding went rather than that a flag is unknown.
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
  if (flags.turns && flags.type) throw new UsageError('--type picks a kind of memory, and --turns leaves memories out — use one of the two');
  const asked = args.join(' ');

  const { memories, conversations, more, moreSaid, elsewhere, loose } = searchAll(db, asked, {
    project: flags.project,
    type: WORKFLOW_NAMES.includes(flags.type) ? 'procedure' : flags.type,
    everywhere: flags.everywhere,
    all: flags.all,
    turns: flags.turns,
    since,
    before,
    limit,
  });

  const said = conversations.map(({ rank, ...hit }) => hit);
  if (flags.json) return asJson(flags.turns ? { conversations: said, moreConversations: moreSaid, elsewhere } : { memories: memories.map(plainMemory), conversations: said, more, moreConversations: moreSaid, elsewhere, loose });
  const out = memories.map(foundLine);
  // A list cut short says so, and how to see the rest.
  if (more > 0) out.push(`… ${more} more — -n ${memories.length + more} shows them all, or narrow the words`);
  if (said.length > 0) {
    // What is not a memory says so: nobody settled these words as true, they are what was said that day.
    if (!flags.turns) out.push(`${memories.length > 0 ? 'also said' : 'no memory of this — said'} in the conversations (sumo show <id> opens one whole):`);
    out.push(...said.map(saidLine));
    if (moreSaid > 0) out.push(flags.turns ? `… ${moreSaid} more — -n ${said.length + moreSaid} shows them all, or narrow the words` : `… ${moreSaid} more in the conversations — sumo search "${asked}" --turns`);
  }
  // An explicit "nothing" is an answer: it is what lets an agent say
  // "not in memory" instead of guessing.
  if (out.length === 0) out.push(flags.turns ? `nothing in the conversations for: ${asked}` : `nothing in memory for: ${asked}${flags.type ? '' : ' — nor in the conversations'}`);
  else if (loose) out.push('a loose match: no line holds two of these words — not an answer to rely on');
  const others = Object.entries(elsewhere);
  if (others.length > 0) {
    const where = others.map(([scope, n]) => `${scopeLabel(scope)} (${n})`).join(', ');
    out.push(`matches in other projects, not shown: ${where} — add --project <name> or --everywhere`);
  }
  return out;
}

/** One line of a search, whole: a memory (m12), or a turn (t481) or a reply (r3) with what was said around it. */
function runShow(db, { args, flags }) {
  const said = journalEntry(db, args[0]);
  if (said) return flags.json ? asJson({ [said.entry.kind]: said.entry, around: said.around }) : [saidDetail(said)];
  const row = memory.get(db, memory.parseId(args[0]));
  return flags.json ? asJson({ memory: row }) : [detail(row)];
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
  // From the model's shell, the user's word is checked against the user's words: what they never typed is held for
  // them (`held_for = 'shell'`) and asked about in the block, never active and never dropped unseen.
  // Said in a turn, it is kept with that turn: forgotten later, the pass that reads the conversation does not file it again.
  const said = fromTool() ? saidByUser(db, body) : null;
  const held = fromTool() && !said;
  const saved = memory.add(db, {
    type,
    body,
    sourceSession: said?.session_id,
    sourceTurn: said?.id,
    project: flags.project,
    topic: flags.topic,
    pin: flags.pin,
    supersedes: flags.supersedes === undefined ? undefined : memory.parseId(flags.supersedes),
    provenance: flags.observed ? 'observed' : 'stated',
    heldFor: held ? 'shell' : undefined,
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
  const saved = memory.add(db, { type: 'procedure', title, cue: flags.cue, gate: flags.gate, body, project: flags.project, heldFor: held ? 'shell' : undefined, writtenBy: byUser() });
  return savedLines(saved).concat(flags.gate ? [`gates shell commands matching: ${flags.gate}`] : [], held ? [HELD(saved.memory.id)] : []);
}

function runGate(db, { args }) {
  need(args, 2, 'gate');
  const saved = memory.setGate(db, memory.parseId(args[0]), args[1] === 'off' ? null : args.slice(1).join(' '));
  return [saved.gate ? `${line(saved)}\ngates shell commands matching: ${saved.gate}` : `${line(saved)}\nno gate — its cue words are matched instead`];
}

function runSupersede(db, { args }) {
  need(args, 2, 'supersede');
  const old = memory.supersede(db, memory.parseId(args[0]), memory.parseId(args[1]), undefined, { actor: fromTool() ? 'model-shell' : 'user' });
  return [`superseded ${line(old)}`];
}

/** A reply that says yes to the question put. */
const AFFIRMS = /^\s*(?:yes|yep|yeah|yup|y|correct|right|that['’]?s right|confirm(?:ed)?|ok(?:ay)?|sure|true|exactly|agreed?|keep (?:it|that)|do it)\b/i;

/**
 * A memory held for the user made theirs. One the model's shell saved without the user's words (`held_for = 'shell'`,
 * a guess) is confirmed from that shell only once the user has spoken since it was made, and said yes, or said the
 * thing itself: a model may not add a guess and vouch for it in one go, nor a page tell it to. One held because its
 * conversation read the web or an MCP server only the user confirms (memory.confirm).
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

/** One turn or reply as a purge lists it: its id, its day, the start of its words. */
const SAID_SHOWN = 100;
const saidRow = (mark, row) => `  ${mark}${row.id} · ${row.ts.slice(0, 10)} · ${clip(row.text, SAID_SHOWN)}`;
const MENTIONS = 'other mentions may remain — find them: sumo search "<words>" --turns, erase one: sumo forget --purge t12';
const stillIn = (failed) => (failed.length > 0 ? [`still in ${failed.length} backup${failed.length === 1 ? '' : 's'} that could not be cleaned — delete ${failed.length === 1 ? 'it' : 'them'} by hand: ${failed.join(' ')}`] : []);
const fromCopies = (cleaned, spooled) => `${cleaned > 0 ? `, and from ${cleaned} backup${cleaned === 1 ? '' : 's'}` : ''}${spooled > 0 ? `, and ${counted(spooled, 'line')} of the spool` : ''}`;

/**
 * `sumo forget --purge t12`: one turn or reply erased for good, from the database, the backups and the spool — shown
 * first, its id typed back. How a mention that a memory's purge left behind is taken out.
 */
async function purgeSaid(db, entry, flags) {
  const mark = `${entry.kind === 'turn' ? 't' : 'r'}${entry.id}`;
  const shown = `${saidRow(entry.kind === 'turn' ? 't' : 'r', entry).trimStart()}\nErase ${mark} for good, from every backup too? Type ${mark} to confirm: `;
  if (!(await confirmed(flags, `erasing ${mark} for good cannot be undone`, shown, [mark]))) throw new Error(`nothing was erased — the answer was not ${mark}`);
  const cites = memory.purgeRow(db, entry);
  const { cleaned, failed } = purgeRowFromBackups(entry);
  // The same words still waiting to be written would bring the row back.
  const same = entry.text.replace(/\s+/g, ' ').trim();
  const spooled = (await import('./spool.mjs')).purgeSpool((text) => String(text).replace(/\s+/g, ' ').trim() === same);
  return [
    `purged ${mark} — erased, not recoverable${fromCopies(cleaned, spooled)}`,
    ...cites.map((id) => `m${id} was drawn from it and still holds its words: sumo forget m${id} --purge erases it too`),
    ...stillIn(failed),
  ];
}

async function runForget(db, { args, flags }) {
  need(args, 1, 'forget');
  // A turn or a reply by its id: never merely forgotten — the journal has no history to keep it in — only erased.
  const entry = /^[tr]\d+$/i.test(args[0]) ? args[0].toLowerCase() : null;
  if (entry && !flags.purge) throw new UsageError(`${entry} is a turn or a reply, which is erased or kept: sumo forget --purge ${entry} erases it for good. A memory is forgotten by its id, like m12`);
  // Erased for good, from the backups too: only the user decides that. A forget without --purge keeps the history.
  if (flags.purge && fromTool()) {
    throw new Refusal(entry ? `erasing a turn or a reply for good is the user's to do: they run sumo forget --purge ${entry} themselves` : `erasing a memory for good is the user's to do: they run sumo forget ${args[0]} --purge themselves. sumo forget ${args[0]} stops it being true and keeps its history`);
  }
  if (entry) return purgeSaid(db, journalEntry(db, entry).entry, flags);
  const id = memory.parseId(args[0]);
  if (flags.purge) {
    // Seen before it goes: the memory as it stands, each turn and reply that goes with it, and its id typed back — the strongest yes, for what no backup brings back.
    const reach = memory.purgeReach(db, memory.get(db, id));
    const with_ = [reach.turns.length > 0 ? counted(reach.turns.length, 'turn') : '', reach.replies.length > 0 ? counted(reach.replies.length, 'reply', 'replies') : ''].filter(Boolean);
    const going = with_.length > 0 ? [`with it go ${with_.join(' and ')} that say${reach.turns.length + reach.replies.length === 1 ? 's' : ''} it:`, ...reach.turns.map((r) => saidRow('t', r)), ...reach.replies.map((r) => saidRow('r', r))] : [];
    const shown = [line(memory.get(db, id)), ...going, `Erase m${id} for good, from every backup too? Type m${id} to confirm: `].join('\n');
    if (!(await confirmed(flags, `erasing m${id} for good cannot be undone`, shown, [`m${id}`, String(id)]))) throw new Error(`nothing was erased — the answer was not m${id}`);
  }
  const gone = memory.forget(db, id, { purge: flags.purge, actor: fromTool() ? 'model-shell' : 'user' });
  if (!flags.purge) return [`forgot ${line(gone)}`];
  const { cleaned, failed } = purgeFromBackups(gone);
  // What still waits to be written, or was set aside, may say it too.
  const spooled = (await import('./spool.mjs')).purgeSpool(memory.saying([gone.source_quote, gone.body]));
  const turns = gone.erased_turns.length;
  const echoes = gone.erased_replies.length;
  // Said as it was done: the sentence it cites, then whatever else of the journal said it whole.
  const cited = gone.erased_source !== null;
  const more = turns - (cited ? 1 : 0);
  const went = cited
    ? `, with the sentence it came from${more > 0 ? ` and ${more} more turn${more === 1 ? ' that says it' : 's that say it'}` : ''}${echoes > 0 ? ` and ${counted(echoes, 'reply', 'replies')} of sumo's that said it back` : ''}`
    : turns + echoes > 0 ? `, with ${[turns > 0 ? counted(turns, 'turn') : '', echoes > 0 ? counted(echoes, 'reply', 'replies') : ''].filter(Boolean).join(' and ')} that say${turns + echoes === 1 ? 's' : ''} it`
    : '';
  return [
    `purged m${gone.id} — erased, not recoverable${went}${fromCopies(cleaned, spooled)}${cited || turns + echoes > 0 ? '' : "; no sentence of the user's was tied to it — sumo search --turns finds one if it is there"}`,
    // Each row that went, as the question listed them: with --yes this is the only place they are said.
    ...gone.erased_turns.map((r) => saidRow('t', r)),
    ...gone.erased_replies.map((r) => saidRow('r', r)),
    ...stillIn(failed),
    // Only what says the memory whole went with it: a conversation that mentions part of it is the user's to find and judge.
    MENTIONS,
  ];
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
  herdr.closeJobTab(herdr.runHerdr, process.env);
}

/** How long a job's run lock may stand free with no end written before the process running it is taken for gone: a run lets its lock go a moment before its end is written. */
const GONE_MS = 5000;

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
  // The chat running the job holds its run lock: free for a while with no end written, that chat is gone — closed
  // or crashed — and nothing will write the end, so the watch ends here rather than waiting for ever.
  let free = 0;
  for (;;) {
    // Looked at before reading, so nothing written before the end is missed.
    const ended = existsSync(jobs.endFile(id));
    at = copyFrom(jobs.liveFile(id), at, decoder);
    if (ended) break;
    free = heldBy(jobs.runLockFile(id)) === null ? free + 250 : 0;
    if (free >= GONE_MS) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  const lines = existsSync(jobs.endFile(id))
    ? safeForTerminal(readFileSync(jobs.endFile(id), 'utf8')).trimEnd().split('\n')
    : [`j${id} stopped without an end: the process running it is gone — sumo job show j${id} says where it got to`];
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
  if (args[0] === 'run') return memoryPassLines(await runMemoryPass(db, { tidy: flags.tidy === true, auto: flags.auto === true }), { asked: flags.tidy === true });
  if (args[0] === 'rebuild') {
    // It lets memories go, past the bound with --yes: from the model's shell — this command runs outside the sandbox — only the difference is shown.
    if (fromTool() && flags['dry-run'] !== true) throw new Refusal("rebuilding memory is the user's to do: they run sumo memory rebuild themselves. sumo memory rebuild --dry-run shows what it would change");
    const { rebuild } = await import('./rebuild.mjs');
    const limit = flags.limit === undefined ? undefined : positiveInteger(flags.limit, '--limit needs a positive number');
    return rebuild(db, { dryRun: flags['dry-run'] === true, since: dayFlag(flags.since, '--since', { back: true }), limit, yes: flags.yes === true });
  }
  // The checks load with the commands that report them: a hook reaches this file on every prompt.
  if (args[0] === 'status') return (await import('./check.mjs')).memoryStatus(db);
  if (args[0] === 'check') {
    // Mending rewrites the indexes and replays what was set aside: the model's shell reads the checks, and no more.
    if (fromTool() && flags.fix === true) throw new Refusal("mending memory is the user's to do: they run sumo memory check --fix themselves. sumo memory check says what is wrong");
    const { memoryCheck, memoryHealth, memoryHealthLine } = await import('./check.mjs');
    const heard = memoryHealthLine(memoryHealth(db));
    const checks = [{ ...heard, warn: !heard.fail }, ...memoryCheck(db, undefined, { fix: flags.fix === true })];
    const lines = checks.map((c) => checkLine(c, styles(colourEnabled())));
    return checks.some((c) => !c.ok && !c.warn) ? Object.assign(lines, { exitCode: 1 }) : lines;
  }
  if (args[0] === 'eval') {
    // Dozens of model calls, and a score kept that the next eval is judged against: not something a model starts.
    if (fromTool()) throw new Refusal("measuring the extractor asks the model about every case, and is the user's to do: they run sumo memory eval themselves");
    const { evalLines, memoryEval } = await import('./memeval.mjs');
    const result = await memoryEval(db, { limit: flags.limit === undefined ? undefined : positiveInteger(flags.limit, '--limit needs a positive number') });
    return flags.json ? Object.assign(asJson(result), { exitCode: result.worse || result.replay.failed ? 1 : 0 }) : evalLines(result);
  }
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

/** The models Sumo can run on and their switches, as the settings page set them. */
function runModels(db, { args }) {
  if (args[0] === undefined) return modelLines(db);
  if (['enable', 'disable', 'discover'].includes(args[0])) throw new UsageError(ON_THE_PAGE(`which models are on (${args[0]})`));
  throw new UsageError(`usage: ${USAGE.models}`);
}

/** MCP servers, as the settings page set them: each one connected to say how it is, and a server's tools. */
async function runMcp(db, { args }) {
  const { allowedBy, closeMcp, connect, mcpLines, mcpReady, readConfig } = await import('./mcp.mjs');
  const [sub = 'list', name] = args;
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
    case 'add':
    case 'remove':
    case 'allow':
    case 'revoke':
      throw new UsageError(ON_THE_PAGE(`an MCP server (${sub})`));
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
      // Not a command: the lines that make another harness heard, with this home's launcher in them.
      if (topic === 'hooks') {
        process.stdout.write(`${(await import('./check.mjs')).hooksHelp().join('\n')}\n`);
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
      if (rest.some((token) => /^--model-source(=|$)/.test(token))) throw new UsageError(ON_THE_PAGE("the local model's address (Memory › Local model), downloaded as it is set,"));
      const { flags } = parse(rest, { value: ['bin-dir'], bool: ['no-link', 'no-model'] });
      const lines = await setup({ binDir: flags['bin-dir'], link: !flags['no-link'], noModel: !!flags['no-model'] });
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
      const { args, flags } = parse(rest, { value: [], bool: ['json'] });
      if (args[1] !== undefined) {
        if (fromTool()) throw new Refusal(OWNER_ONLY);
        // A name that is not a setting, or no longer one, is said as that first: what it became, or the one meant.
        config(args[0]);
        throw new UsageError(ON_THE_PAGE(args[0]));
      }
      // The page takes keys: it opens for a person at a terminal, never for the model's shell, which only reads.
      if (args.length === 0 && !flags.json && !fromTool() && process.stdin.isTTY && process.stdout.isTTY) {
        const { runSettings } = await import('./settings.mjs');
        process.stdout.write(`${(await runSettings({ plain: config('chat.screen')[0].endsWith('= plain') })).join('\n')}\n`);
        return 0;
      }
      const lines = config(args[0]);
      process.stdout.write(`${flags.json ? asJson({ settings: Object.fromEntries(lines.map((l) => l.split(' = '))) })[0] : lines.join('\n')}\n`);
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
      // Evidence that Claude Code is in use, for the heartbeat: a command run from it (this is never the hook's path).
      noteUsedFrom(db);
      const lines = await spec.run(db, parsed);
      process.stdout.write(`${lines.join('\n')}\n`);
      // Run inside Claude Code, which sumo does not hear: said to the model that ran this, once a day.
      if (process.env.CLAUDECODE === '1' && (HEARD_CHECKED.includes(command) || (command === 'memory' && parsed.args[0] === 'status'))) {
        const unheard = (await import('./check.mjs')).notHeardLine(db);
        if (unheard) process.stderr.write(`${unheard}\n`);
      }
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
