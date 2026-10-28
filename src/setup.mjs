import { execFileSync, spawnSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, delimiter, dirname, isAbsolute, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { anthropicClient, authenticatedRequest, FALLBACK_BETA, resolveAnthropicCredential } from './auth.mjs';
import { assertOn, describeApiError, discoverModels, discoverySummary, knownModel, MODELS, modelsChecked, modelStates } from './catalog.mjs';
import { getMeta, openDb, SCHEMA_VERSION, schemaVersion, setMeta } from './db.mjs';
import { damaged, restoreHint } from './export.mjs';
import { stopLocalServer } from './local-server.mjs';
import { latestCrash, crashFiles, logFiles, tailOf } from './logs.mjs';
import { memoryHealth, memoryHealthLine, Refusal, UsageError } from './memory.mjs';
import { COMPILED, ENTRY, homeProblem, paths, REPO_ROOT, VERSION } from './paths.mjs';
import { redact } from './redact.mjs';
import { unsandboxable } from './sandbox.mjs';
import { DatabaseSync } from './sqlite.mjs';
import { closest } from './text.mjs';
import { tilde } from './tty.mjs';

const NODE_REQUIREMENT = '22.19+ or 24.6+';
// route.mjs's EFFORTS, spelled out: importing it would close a cycle (route → model → setup). A test keeps them equal.
export const CHAT_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** The settings `sumo config` accepts, with the value used when none is stored. */
export const CONFIG_DEFAULTS = {
  'chat.budget': '5',
  'chat.effort': 'medium',
  'chat.model': 'opus',
  'chat.notify': 'on',
  'chat.screen': 'full',
  'jobs.advisor': 'off',
  'jobs.budget': '10',
  'jobs.floor': 'haiku',
  'jobs.minutes': '60',
  'jobs.review': 'risky',
  'memory.model': 'local',
  'model.url': 'https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf',
  'projects.home': '~',
  'shell.network': 'on',
  'shell.sandbox': 'on',
};

/** What a setting that is gone became, said when its old name is used, instead of "unknown setting". */
const RETIRED = {
  'chat.motion': 'chat.motion is now chat.screen: sumo config chat.screen still',
  'chat.plain': 'chat.plain is now chat.screen: sumo config chat.screen plain',
  'model.source': 'model.source is now part of model.url, the model file\'s whole address: sumo config model.url https://<host>/…/<file>.gguf',
  'model.repo': 'model.repo is now part of model.url, the model file\'s whole address: sumo config model.url https://<host>/…/<file>.gguf',
  'model.file': 'model.file is now part of model.url, the model file\'s whole address: sumo config model.url https://<host>/…/<file>.gguf',
  'prime.budget': 'prime.budget is no longer a setting: the memory block every session starts with holds 800 tokens; the rest is found by search',
  'scratch.days': 'scratch.days is no longer a setting: a scratch folder nothing is written in for 14 days is deleted',
  'jobs.escalate': 'jobs.escalate is no longer a setting: a worker\'s first attempt that fails is always retried once, one step up',
  'guides.auto': 'guides.auto is no longer a setting: a guide always rides in with a message that asks for its kind of work (--guide none on a job for none)',
};

/**
 * The launcher exists because hooks and sub-agents run where a version
 * manager's `node` is not on PATH and the repo's location is unknown. It pins
 * both as absolute paths, so `sumo` means the same thing everywhere.
 */
function launcherScript() {
  // Single quotes keep a `$`, backtick or `"` in either path literal; a `'` is closed, escaped and reopened.
  const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  const self = COMPILED ? quote(ENTRY) : `${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(ENTRY)}`;
  return `#!/bin/sh\nexport NODE_USE_SYSTEM_CA=1\nexec ${self} "$@"\n`;
}

/** A directory already on PATH, inside the home folder, that a command can be linked into without sudo. */
function pickBinDir() {
  const home = homedir();
  const onPath = (process.env.PATH ?? '').split(delimiter).filter(Boolean);
  const usable = (dir) => {
    try {
      accessSync(dir, constants.W_OK);
      return statSync(dir).isDirectory();
    } catch {
      return false;
    }
  };
  // Version-manager and toolchain directories are on PATH too, but they are
  // replaced on upgrade — a link placed there silently disappears.
  const volatile = /\/(\.nvm|\.volta|\.asdf|\.cargo|\.bun|node_modules|\.rbenv|\.pyenv)\//;
  const preferred = [join(home, '.local', 'bin'), join(home, 'bin')].filter((d) => onPath.includes(d));
  const others = onPath.filter((d) => d.startsWith(`${home}/`) && !volatile.test(`${d}/`));
  return [...preferred, ...others].find(usable) ?? null;
}

function linkInto(binDir, launcher) {
  const link = join(binDir, 'sumo');
  let existing = null;
  try {
    existing = lstatSync(link);
  } catch {
    // Nothing there yet.
  }
  if (existing) {
    const target = existing.isSymbolicLink() ? readlinkSync(link) : null;
    if (target === launcher) return { link, status: 'already linked' };
    if (target === null || !target.endsWith('/.sumo-agents/bin/sumo')) return { link, status: 'skipped — a different `sumo` is already there' };
    // Another home's sumo, still there, is someone's main command — a second home set up beside it never takes it over.
    // Only a link to a home that is gone is replaced.
    if (existsSync(link)) return { link, status: `skipped — it runs the sumo in ${dirname(dirname(target))}; to point it here: ln -sf ${launcher} ${link}` };
    unlinkSync(link);
  }
  symlinkSync(launcher, link);
  return { link, status: 'linked' };
}

/** "2621440000" -> "2.4 GB". Decimal (1000-based), the way Hugging Face itself labels file sizes. */
function formatBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let value = n;
  let i = 0;
  while (value >= 1000 && i < units.length - 1) {
    value /= 1000;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

/** Where the router model is downloaded from: the file's whole address. */
const modelUrlOf = (db) => getMeta(db, 'config.model.url') ?? CONFIG_DEFAULTS['model.url'];

/**
 * The file the model is kept in under models/: the last part of its address. Not decoded, so an encoded separator
 * (`%2F`) stays part of the name and the file is never anywhere but models/.
 */
export const modelFileOfUrl = (url = CONFIG_DEFAULTS['model.url']) => new URL(url).pathname.split('/').pop();
export const modelFileOf = (db) => modelFileOfUrl(modelUrlOf(db));

/**
 * The address with another source in front: `--model-source` and setup's question name a host, or a JFrog
 * Artifactory Hugging Face remote's huggingfaceml URL, and the file keeps its path there (`<org>/<repo>/resolve/main/<file>`
 * in Hugging Face's layout, else the file alone). A source that is itself a .gguf address is the whole answer.
 */
function withSource(url, source) {
  if (/\.gguf$/i.test(new URL(source).pathname)) return source;
  const parts = url.split('/');
  const tail = parts.slice(parts.at(-3) === 'resolve' ? -5 : -1).join('/');
  return `${source.replace(/\/+$/, '')}/${tail}`;
}

/** The source part of an address, what setup's question offers to keep. */
function sourceOf(url) {
  const parts = url.split('/');
  return parts.slice(0, parts.at(-3) === 'resolve' ? -5 : -1).join('/');
}

/**
 * Downloads the router model unless it is already there at the size the server reports (HEAD first).
 * Streams to `<file>.part` then renames, so a run that dies never leaves a file that looks finished.
 * Never throws: a model that could not be fetched is not a reason for `sumo setup` to fail.
 */
async function ensureModel(db) {
  const url = modelUrlOf(db);
  const dest = join(paths().models, modelFileOfUrl(url));
  const shown = redactUrl(url);
  // Unique per run: two setups at once must not interleave into one file, and a dead run must not leave a
  // part file that a later run mistakes for progress.
  const partPath = `${dest}.${process.pid}.part`;
  try {
    // fetch refuses a URL with credentials in it, so a token pasted into the source travels as a header instead.
    const { href, headers } = withoutCredentials(url);
    const head = await fetch(href, { method: 'HEAD', headers });
    if (!head.ok) throw new Error(`HEAD ${shown} → HTTP ${head.status}`);
    const lengthHeader = head.headers.get('content-length');
    const remoteSize = lengthHeader === null ? null : Number(lengthHeader);
    const localSize = existsSync(dest) ? statSync(dest).size : null;
    // No Content-Length (a JFrog remote that has not cached the artifact yet) → keep what is there rather than
    // fetch gigabytes on every setup; a size mismatch is the only reason to download again.
    if (localSize !== null && (remoteSize === null || localSize === remoteSize)) {
      return `model     ${dest} (${formatBytes(localSize)}, present)`;
    }
    const res = await fetch(href, { headers });
    if (!res.ok) throw new Error(`GET ${shown} → HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), cappedAt(MAX_MODEL_BYTES), createWriteStream(partPath));
    renameSync(partPath, dest);
    return `model     ${dest} (${formatBytes(statSync(dest).size)}, downloaded)`;
  } catch (cause) {
    rmSync(partPath, { force: true });
    const why = redactUrl(cause.message);
    // Offline, with the model already here: that is a model that could not be checked, not one that is missing.
    if (existsSync(dest)) return `model     ${dest} (${formatBytes(statSync(dest).size)}, present; not checked against ${shown}: ${why})`;
    return `could not download the router model from ${shown}: ${why}`;
  }
}

/** The URL without its `user:token@`, and that pair as a Basic authorization header. */
function withoutCredentials(raw) {
  const url = new URL(raw);
  if (!url.username && !url.password) return { href: url.href, headers: {} };
  const pair = `${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`;
  url.username = '';
  url.password = '';
  return { href: url.href, headers: { authorization: `Basic ${Buffer.from(pair).toString('base64')}` } };
}

/** A source pasted with a token in it (`https://user:token@host/…`) must never reach stdout or a transcript. */
function redactUrl(text) {
  return String(text).replace(/(https?:\/\/)[^/\s@]+@/g, '$1');
}

// Larger than any model setup would fetch; a server that streams past its advertised size stops here, not at a full disk.
const MAX_MODEL_BYTES = 8 * 1000 * 1000 * 1000;

/** Passes bytes through until the cap, then fails the pipeline instead of filling the disk. */
function cappedAt(limit) {
  let seen = 0;
  return new Transform({
    transform(chunk, _encoding, done) {
      seen += chunk.length;
      if (seen > limit) done(new Error(`download exceeded ${formatBytes(limit)}`));
      else done(null, chunk);
    },
  });
}

/** A model source is a web address; anything else is refused before it is stored, since every later setup would fail on it. */
function sourceOrRefuse(value) {
  if (!/^https?:\/\/[^\s/]/i.test(value)) throw new UsageError(`"${redactUrl(value)}" is not a web address — a model source looks like https://<host>[/<path>]`);
  // The router model is run on every job: fetched in clear text it is anyone's on the way to replace. Loopback, a mirror on this machine, is the exception.
  if (/^http:/i.test(value) && !/^http:\/\/(?:[^@/]*@)?(?:127\.0\.0\.1|localhost|\[::1\])(?::\d+)?(?:\/|$)/i.test(value)) {
    throw new UsageError(`"${redactUrl(value)}" is plain http: the model would cross the network in clear text. Use https:// (http:// is taken only for 127.0.0.1 and localhost)`);
  }
  return value;
}

/** A model's address is a web address of a .gguf file: anything else would fail every later setup. */
function modelUrlOrRefuse(value) {
  sourceOrRefuse(value);
  let path;
  try {
    path = new URL(value).pathname;
  } catch {
    throw new UsageError(`"${redactUrl(value)}" is not a web address — model.url looks like ${CONFIG_DEFAULTS['model.url']}`);
  }
  if (!/\/[^/]+\.gguf$/i.test(path)) throw new UsageError(`model.url is the model file's own address, ending in .gguf — like ${CONFIG_DEFAULTS['model.url']}`);
  return value;
}

/** The one question `sumo setup` ever asks, and only when nothing is stored yet and a person is there to answer it. */
async function askModelSource(defaultSource) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    // A slip at the prompt is asked again, not the end of setup.
    for (;;) {
      // Ctrl-C at the prompt stops setup; Ctrl-D is no answer, so the default. Neither is a stack trace.
      const answer = (
        await rl.question(`Download the router model from [${defaultSource}]: `).catch((cause) => {
          if (cause?.name === 'AbortError') throw new UsageError('setup stopped — nothing was downloaded');
          return '';
        })
      ).trim();
      if (!answer) return defaultSource;
      try {
        return sourceOrRefuse(answer);
      } catch (cause) {
        process.stdout.write(`${cause.message}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

export async function setup({ binDir, link = true, modelSource, noModel = false } = {}) {
  const p = paths();
  for (const dir of [p.home, p.bin, p.logs, p.backups, p.jobs, p.models, p.scratch]) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  chmodSync(p.home, 0o700);

  const db = openDb();
  chmodSync(p.db, 0o600);
  if (!getMeta(db, 'machine')) setMeta(db, 'machine', hostname().replace(/\.local$/, ''));
  // The model or the binary may be about to change; the next local call starts a server for what is current.
  stopLocalServer(db);
  // Pinned for the same reason the launcher pins node: the router runs where PATH cannot be trusted.
  const llama = commandOnPath('llama-server');
  if (llama) setMeta(db, 'llama.path', llama);

  let source = modelSource === undefined ? undefined : sourceOrRefuse(modelSource);
  if (source === undefined && !noModel && !getMeta(db, 'config.model.url') && process.stdin.isTTY) {
    source = await askModelSource(sourceOf(CONFIG_DEFAULTS['model.url']));
  }
  if (source !== undefined) setMeta(db, 'config.model.url', modelUrlOrRefuse(withSource(modelUrlOf(db), source)));

  // SUMO_AGENTS_MODEL_CMD marks a hermetic test/dev harness, the same way it tells callModel and
  // callLocalModel never to run a real model — an explicit --model-source still means "go fetch it".
  const harnessSkip = Boolean(process.env.SUMO_AGENTS_MODEL_CMD) && modelSource === undefined;
  let modelLine = null;
  if (!noModel) {
    modelLine = harnessSkip
      ? 'model     not downloaded — SUMO_AGENTS_MODEL_CMD is set (unset it, or pass --model-source, to fetch it)'
      : await ensureModel(db);
  }
  const modelsLine = await checkModels(db);
  db.close();

  // Written aside and renamed in, so a hook running the launcher mid-setup never reads half a script.
  const staged = `${p.launcher}.${process.pid}.tmp`;
  writeFileSync(staged, launcherScript(), { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, p.launcher);

  const lines = [`home      ${p.home}`, `database  ${p.db}`, `launcher  ${p.launcher}`];
  // What was skipped is said too: the next step depends on it.
  lines.push(modelLine ?? `model     not fetched (--no-model) — the router needs it: sumo setup`);
  lines.push(modelsLine);
  if (!llama) lines.push('llama-server not found — brew install llama.cpp');
  if (link) {
    const dir = binDir ?? pickBinDir();
    if (dir) {
      const { link: at, status } = linkInto(dir, p.launcher);
      lines.push(`command   ${at} (${status})`);
    } else {
      lines.push(`command   not linked — add this to your shell profile: export PATH="${p.bin}:$PATH"`);
    }
  } else {
    lines.push(`command   not linked (--no-link) — run ${p.launcher}, or put ${p.bin} on PATH`);
  }
  lines.push('next      sumo doctor');
  return lines;
}

/**
 * Which of Sumo's models this credential can use, asked of the API the first time only: a later setup
 * leaves the switches as they are, since the user may have set some by hand — `sumo models discover` asks again.
 * Never throws: a check that could not be made is not a reason for `sumo setup` to fail.
 */
async function checkModels(db) {
  const checked = modelsChecked(db);
  if (checked) return `models    checked ${checked.slice(0, 10)} — sumo models discover to check again`;
  const result = await discoverModels(db);
  return result.ok ? `models    ${discoverySummary(result)}` : `models    not checked — ${result.error}`;
}

function commandOnPath(name) {
  for (const dir of (process.env.PATH ?? '').split(delimiter).filter(Boolean)) {
    const candidate = join(dir, name);
    try {
      // A directory passes the X_OK check too (it means "searchable"), so it is ruled out the way `which` rules it out.
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Not in this directory.
    }
  }
  return null;
}

/** Each check is [ok, label, how to fix]. `warn` checks never fail the run. */
export async function doctor() {
  const p = paths();
  const checks = [];
  const check = (ok, label, fix, warn = false) => checks.push({ ok, label, fix, warn });

  // First, so it is still visible when a terminal folds the rest away: "did the update land?" is the
  // question asked most often, and the answer is which commit this copy is running.
  const code = codeVersion();
  check(code !== null, `code ${code ?? 'unknown'}`, 'neither a git checkout nor an installed package — reinstall: npm i -g sumo-agents', true);

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = (major === 22 && minor >= 19) || (major === 24 && minor >= 6) || major > 24;
  // The binary Bun builds carries its own runtime, whatever Node version that says it is.
  if (process.versions.bun) check(true, `bun ${process.versions.bun} (a built binary: no Node needed)`, '');
  else check(nodeOk, `node ${process.versions.node}`, `needs Node ${NODE_REQUIREMENT}`);

  // A file where the home should be is the one thing to say: every check after this one reads from the home.
  const notAFolder = homeProblem();
  if (notAFolder) {
    check(false, 'home is a folder', notAFolder);
    return checks;
  }

  let db = null;
  // Read here, inside the one guarded open: a database that will not open is a failed check, not the end of the report.
  let stored = { modelFile: null, llama: null, models: null, checked: null, configured: [], sandbox: CONFIG_DEFAULTS['shell.sandbox'] };
  try {
    db = openDb();
    const options = db.prepare('PRAGMA compile_options').all().map((r) => Object.values(r)[0]);
    check(options.includes('ENABLE_FTS5'), 'SQLite full-text search (FTS5)', 'this Node build lacks FTS5 — use the official nodejs.org build');
    check(schemaVersion(db) === SCHEMA_VERSION, `schema version ${schemaVersion(db)}`, 'database is from a newer sumo-agents — update this repo');
    const setting = (key) => getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key];
    stored = {
      modelFile: modelFileOf(db),
      llama: getMeta(db, 'llama.path'),
      models: modelStates(db),
      checked: modelsChecked(db),
      configured: ['chat.model', 'memory.model'].map((key) => [key, setting(key)]),
      sandbox: setting('shell.sandbox'),
      memory: memoryHealth(db),
    };
  } catch (cause) {
    check(false, 'database opens', damaged(cause) ? `${cause.message} — ${restoreHint()}` : cause.message);
  } finally {
    db?.close();
  }

  // The models the chat, the router and the passes may use: none on means nothing can run, and a setting naming one that is off runs nothing either.
  if (stored.models) {
    const on = MODELS.filter((name) => stored.models[name].on);
    const off = MODELS.filter((name) => !stored.models[name].on);
    check(on.length > 0, `models on: ${on.join(', ') || 'none'}${off.length > 0 ? `; off: ${off.join(', ')}` : ''}`, 'sumo models enable <name>');
    check(stored.checked !== null, `models checked against the API${stored.checked ? ` (${stored.checked.slice(0, 10)})` : ''}`, 'run: sumo models discover', true);
    for (const [key, value] of stored.configured) {
      if (MODELS.includes(value)) check(stored.models[value].on, `${key} is on (${value})`, `sumo models enable ${value}, or sumo config ${key} <name>`);
    }
  }

  const mode = (file) => (existsSync(file) ? statSync(file).mode & 0o777 : null);
  // doctor --fix sets both as they should be; only a home not made yet needs setup.
  const modeFix = (file) => (mode(file) === null ? 'run: sumo setup' : 'run: sumo doctor --fix');
  check(mode(p.home) === 0o700, 'home directory is private (0700)', modeFix(p.home));
  check(mode(p.db) === 0o600, 'database is private (0600)', modeFix(p.db));
  // Everything else the home keeps of the user's — what they typed, the sessions, the logs, the jobs' briefs — is theirs
  // alone too; a file made before a mode was set keeps the mode it was born with until something changes it.
  const loose = loosePlaces();
  const shown = loose.slice(0, LOOSE_SHOWN).map((place) => place.slice(p.home.length + 1)).join(', ');
  check(
    loose.length === 0,
    loose.length === 0 ? "the home's files are private (0600, folders 0700)" : `${loose.length} place${loose.length === 1 ? '' : 's'} in the home others can read: ${shown}${loose.length > LOOSE_SHOWN ? ` and ${loose.length - LOOSE_SHOWN} more` : ''}`,
    'run: sumo doctor --fix',
    true,
  );

  // A crash in the last week is said, with where it was written: what it says is the start of a bug report.
  const crash = latestCrash(new Date(Date.now() - CRASH_SHOWN_MS));
  if (crash) check(false, `crash on ${crash.at.toISOString().slice(0, 19).replace('T', ' ')}: ${crash.said}`, `${crash.file}; sumo doctor --report bundles it for a bug report`, true);

  // Memory, in one line: whether the user is being heard and filed, what waits for them, and scans gone stale.
  if (stored.memory) {
    const said = memoryHealthLine(stored.memory);
    check(said.ok, said.label, said.fix, true);
  }

  // The shell's sandbox is on by default: where it cannot be, every command writes wherever the user can, and that is said.
  if (stored.sandbox !== 'off') {
    const why = unsandboxable();
    check(why === null, 'shell sandbox (/usr/bin/sandbox-exec)', `${why} — the model's shell can write wherever you can; sumo config shell.sandbox off says you know`, true);
  }
  check(commandOnPath('git') !== null, 'git on PATH', "install git — a job's worktree, its changes and the checks that judge it need it", true);
  // A file that does not read takes every MCP server with it, in the chat and in every job.
  if (existsSync(join(p.home, 'mcp.json'))) {
    const { readConfig } = await import('./mcp.mjs');
    let unread = null;
    try {
      readConfig();
    } catch (cause) {
      unread = cause.message;
    }
    check(unread === null, 'MCP servers file reads (mcp.json)', unread ?? '');
  }

  const launcherOk = existsSync(p.launcher) && readFileSync(p.launcher, 'utf8') === launcherScript();
  check(launcherOk, 'launcher points at this repo and this node', 'run: sumo setup');
  check(launcherOk && launcherRuns(), 'launcher runs the way a hook would call it', 'run: sumo setup');

  const herdr = commandOnPath('herdr');
  // Optional: without it a job still runs in the chat; only the tab that shows it as it works is not opened.
  // Said within 100 columns: most machines have no herdr, and this is the line they all see.
  check(herdr !== null, 'herdr on PATH (optional: a tab to watch each job)', 'brew install herdr, or sumo job watch <id>', true);
  // Ours is the launcher, or the shim `npm install -g` makes, which points straight at this copy's entry.
  const found = commandOnPath('sumo');
  const real = found === null ? null : realpathSync(found);
  const ours = real !== null && ((existsSync(p.launcher) && real === realpathSync(p.launcher)) || real === realpathSync(ENTRY));
  // This one's folder as the user would type it on their PATH: by the variable that names the home, or under ~.
  const bin = process.env.SUMO_AGENTS_HOME ? '$SUMO_AGENTS_HOME/bin' : tilde(p.bin);
  check(ours, '`sumo` on PATH is this one', found ? `run: sumo setup, or put ${bin} first on PATH` : 'run: sumo setup');

  // The chat and every job go to the API; the memory passes run locally and only fall back to it.
  const standInKey = Boolean(process.env.SUMO_AGENTS_MODEL_CMD);
  check(
    standInKey || Boolean(resolveAnthropicCredential()),
    'an Anthropic credential (chat, jobs)',
    'export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN',
  );
  // What every request of each role pays for before its first word: the first number of the ledger, and never a failed check.
  const chatModel = stored.configured.find(([key]) => key === 'chat.model')?.[1];
  checks.push(await promptCheck(MODELS.includes(chatModel) ? chatModel : CONFIG_DEFAULTS['chat.model']));

  // Not a warning: every job is routed by it, and without an answer no job can be created.
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) {
    check(true, `local model stand-in (SUMO_AGENTS_MODEL_CMD=${standIn})`, '');
  } else {
    // One local model routes every job and runs the memory pass: said as that, not by one of its jobs.
    const model = join(p.models, stored.modelFile ?? modelFileOfUrl());
    check(existsSync(model), `local model (${basename(model)})`, 'run: sumo setup');

    const llama = stored.llama ?? commandOnPath('llama-server');
    check(llama !== null && existsSync(llama), 'llama-server found (runs the local model)', 'brew install llama.cpp, then: sumo setup');
  }

  return checks;
}

/** How long doctor waits for a count: it is one request, and a doctor that hangs tells nobody anything. */
const COUNT_TIMEOUT_MS = 15_000;

/**
 * The fixed prompt of each role — its tools and its system prompt, with a one-word turn after them, as the endpoint takes
 * no empty conversation — counted by the API's free count_tokens, every role on the chat's model so the numbers compare.
 * The MCP servers' tools are left out: connecting them is not doctor's to do, and they go deferred, outside the prefix.
 * Without a credential, or on any error, it is a warning that says why nothing was counted.
 */
async function promptCheck(model) {
  const skipped = (why) => ({ ok: false, warn: true, label: 'prompt: not counted', fix: why });
  const credential = resolveAnthropicCredential();
  if (!credential) return skipped('no Anthropic credential to count with');
  try {
    // Loaded here: the loop and the chat import this module, and only doctor needs them from it.
    const { jobParams, paramsFor } = await import('./loop.mjs');
    const { CHAT_TOOLS, chatSystem } = await import('./chat.mjs');
    const requests = [
      ['chat', paramsFor({ model, tools: CHAT_TOOLS, system: chatSystem(), text: 'hi' })],
      ...['worker', 'scout', 'reviewer'].map((agent) => [agent, jobParams({ job: { agent, model }, text: 'hi' })]),
    ];
    const client = anthropicClient({ timeout: COUNT_TIMEOUT_MS, maxRetries: 0 }, credential);
    // Sent as each role sends it, less what only bounds a reply.
    // A fallback is the Messages endpoint's, not the counter's: left out with its beta.
    const counted = ({ max_tokens: _bound, fallbacks: _fallbacks, ...params }) => ({ ...params, ...(params.betas ? { betas: params.betas.filter((b) => b !== FALLBACK_BETA) } : {}) });
    const counts = await Promise.all(requests.map(([, params]) => client.beta.messages.countTokens(authenticatedRequest(counted(params), credential))));
    const said = requests.map(([role], i) => `${role} ${counts[i].input_tokens.toLocaleString('en-US')}`).join(' · ');
    return { ok: true, warn: false, label: `prompt: ${said} tokens on ${model}, without MCP tools`, fix: '' };
  } catch (cause) {
    return skipped(describeApiError(cause));
  }
}

/** A checkout says its commit; an installed package says its version. */
/** The most of `code <hash> · <date> · <subject>` doctor shows: with its six-column mark and the word, inside 100. */
const CODE_SHOWN = 88;

function codeVersion() {
  try {
    if (existsSync(join(REPO_ROOT, '.git'))) {
      // The subject cut short: a release's can run to a paragraph, and doctor's lines fit a window.
      const said = execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%h · %cs · %s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
      return said ? (said.length > CODE_SHOWN ? `${said.slice(0, CODE_SHOWN - 1).trimEnd()}…` : said) : null;
    }
    return JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? null;
  } catch {
    return null;
  }
}

/** How many of the places others can read doctor names before it says how many more. */
const LOOSE_SHOWN = 5;
/** How far back doctor looks for a crash to say. */
const CRASH_SHOWN_MS = 7 * 24 * 60 * 60 * 1000;
/** The folders of the home whose every file and folder holds the user's words or settings. */
const PRIVATE_TREES = ['logs', 'backups', 'scribe'];

/**
 * What in the home others can read, by full path: the home and its own files; everything in the logs, the backups and
 * the scribe's folder; the jobs folder, each job's folder and the files directly in it — never deeper, where a job's
 * worktree holds a copy of a project whose files keep their own modes. The models, the launcher's folder and scratch (a
 * project) are not the user's words. Only group and other bits count: what the owner may do is the owner's.
 */
function loosePlaces(home = paths().home) {
  const found = [];
  // A home that is not a folder, or not there, has nothing in it to make private — and a file there is not sumo's to change.
  try {
    if (!statSync(home).isDirectory()) return found;
  } catch {
    return found;
  }
  const look = (path, deep) => {
    let st;
    try {
      st = lstatSync(path);
    } catch {
      return;
    }
    if (st.isSymbolicLink()) return;
    if (st.mode & 0o077) found.push(path);
    if (!st.isDirectory() || deep === 0) return;
    for (const name of readdirSync(path)) look(join(path, name), deep - 1);
  };
  look(home, 0);
  for (const name of existsSync(home) ? readdirSync(home) : []) {
    const path = join(home, name);
    if (PRIVATE_TREES.includes(name)) look(path, Infinity);
    else if (name === 'jobs') {
      look(path, 0);
      for (const id of existsSync(path) ? readdirSync(path) : []) {
        const job = join(path, id);
        look(job, 0);
        // Its own files only: a folder in it is a worktree, a copy of a project.
        for (const file of lstatSync(job).isDirectory() ? readdirSync(job) : []) if (lstatSync(join(job, file)).isFile()) look(join(job, file), 0);
      }
    } else if (!['models', 'bin', 'scratch'].includes(name)) look(path, 0);
  }
  return found.sort();
}

/** `sumo doctor --fix`: each place others can read made the owner's alone — group and other bits taken off, the owner's kept. Returns what it changed. */
export function makePrivate(home = paths().home) {
  const fixed = [];
  // The home and the database are the owner's to read and write, as well as no one else's: a home that lost its write
  // bit is one no command can open.
  for (const [place, wanted, folder] of [[home, 0o700, true], [join(home, 'memory.db'), 0o600, false]]) {
    try {
      const st = lstatSync(place);
      if ((folder ? st.isDirectory() : st.isFile()) && (st.mode & 0o777) !== wanted) {
        chmodSync(place, wanted);
        fixed.push(place);
      }
    } catch {
      // Not there, or not ours: doctor says it again.
    }
  }
  for (const place of loosePlaces(home)) {
    try {
      chmodSync(place, statSync(place).mode & 0o700);
      fixed.push(place);
    } catch {
      // Gone, or not ours: doctor says it again.
    }
  }
  return fixed;
}

/**
 * `sumo doctor --report`: what is needed to read a problem, in one text to paste into a bug report — the version and
 * runtime, doctor's lines, the settings, the MCP servers by name only, the last crash and the tail of each log. Every
 * part is redacted, and nothing is sent anywhere: it is printed, for the user to read before they share it.
 */
/**
 * The logs that hold the user's own words — what the memory pass saved or dropped, what a hook was handed — and their
 * older generations. A report counts them; it never quotes them.
 */
const WORDS_LOGS = /^(?:scribe|hook)\.log(?:\.\d+)?$/;
/** The longest a failure line is said: its time, its pass and model, and the start of the error. */
const FAILURE_SHOWN = 160;

/**
 * A words log, counted: for the memory pass's, its passes and failures and the last failure's own line — the line a pass
 * writes about itself, never the "saved" and "dropped" lines under it, which quote what was said; for the hooks', its
 * entries and the first line of the last.
 */
function countedLog(file, name) {
  let text = '';
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '(could not be read)';
  }
  const lines = text.split('\n');
  const cut = (line) => (line.length > FAILURE_SHOWN ? `${line.slice(0, FAILURE_SHOWN - 1)}…` : line);
  if (name.startsWith('scribe')) {
    const passes = lines.filter((l) => /^\S+ (?:scribe|dream)\S* \S+ (?:ok|FAILED) /.test(l));
    const failed = passes.filter((l) => / FAILED /.test(l));
    return `${count(passes.length, 'pass', 'passes')}, ${failed.length} failed${failed.length > 0 ? `; the last failure: ${cut(failed.at(-1))}` : ''}`;
  }
  const entries = lines.filter((l) => /^\d{4}-\d{2}-\d{2}T\S+ /.test(l));
  return entries.length === 0 ? 'no entries' : `${count(entries.length, 'entry', 'entries')}; the last: ${cut(entries.at(-1))}`;
}
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;

export async function reportOf(doctorLines, { now = new Date() } = {}) {
  const parts = [
    `# sumo ${VERSION || 'unknown'} report`,
    `node: ${process.versions.bun ? `bun ${process.versions.bun}` : process.version} · ${process.platform} ${process.arch}`,
    `written: ${now.toISOString()} — redacted, and sent nowhere: read it before you share it`,
    "memory text is left out: the memory pass's and the hooks' logs are counted here, not quoted",
    '',
    '## doctor',
    ...doctorLines,
    '',
    '## config',
  ];
  try {
    parts.push(...config());
  } catch (cause) {
    parts.push(`(could not be read: ${cause.message})`);
  }
  parts.push('', '## mcp servers');
  try {
    const { readConfig } = await import('./mcp.mjs');
    const names = Object.keys(readConfig().mcpServers);
    parts.push(...(names.length > 0 ? names : ['(none)']));
  } catch (cause) {
    parts.push(`(could not be read: ${cause.message})`);
  }
  const [crash] = crashFiles();
  parts.push('', crash ? `## last crash: ${basename(crash)}` : '## last crash', crash ? tailOf(crash, 200) : '(none)');
  for (const file of logFiles()) {
    const name = basename(file);
    if (WORDS_LOGS.test(name)) parts.push('', `## logs/${name} — ${countedLog(file, name)}`);
    else parts.push('', `## logs/${name} (last 50 lines)`, tailOf(file, 50) || '(empty)');
  }
  return redact(parts.join('\n')).text;
}

/** A whole number above zero, as `-n` and `--budget` take it; anything else is refused with `message`. */
export function positiveInteger(raw, message) {
  const n = Number(raw);
  if (!(Number.isInteger(n) && n > 0)) throw new UsageError(message);
  return n;
}

export function config(key, value) {
  const db = openDb();
  // A model's address can carry a token (`https://user:token@host/…`); it is stored whole, for the download, and shown without it.
  const shown = (k) => `${k} = ${redactUrl(getMeta(db, `config.${k}`) ?? CONFIG_DEFAULTS[k])}`;
  try {
    // By name, so each section's settings stand together: chat.*, jobs.*, memory.*, shell.* …
    if (key === undefined) {
      return Object.keys(CONFIG_DEFAULTS).sort().map(shown);
    }
    if (Object.hasOwn(RETIRED, key)) throw new UsageError(RETIRED[key]);
    if (!Object.hasOwn(CONFIG_DEFAULTS, key)) {
      const near = closest(key, Object.keys(CONFIG_DEFAULTS));
      throw new UsageError(`unknown setting "${key}" — ${near ? `did you mean ${near}? ` : ''}sumo config lists them all`);
    }
    if (value !== undefined) {
      // A cap that is not a number of dollars would be read as the default without a word; 0 is a choice, no cap at all.
      if (key === 'jobs.budget' && !/^\d+(\.\d+)?$/.test(value)) throw new UsageError('jobs.budget needs a number of dollars, 0 or more: what one job may spend before it is stopped, 0 for no cap');
      // The same for a limit in time: whole minutes, and 0 for none.
      if (key === 'jobs.minutes' && !/^\d+$/.test(value)) throw new UsageError('jobs.minutes needs a whole number of minutes, 0 or more: how long one job may run before it is stopped, 0 for no limit');

      // Where a new project is made: a place that is not there, or that moves with the shell's directory, is no answer to "where".
      if (key === 'projects.home') {
        const dir = value.replace(/^~(?=$|\/)/, homedir());
        if (!isAbsolute(dir) || !existsSync(dir) || !statSync(dir).isDirectory()) throw new UsageError(`${value} is not a directory — projects.home is where new projects are made, absolute or under ~`);
      }
      // Sent with every chat turn: a word the API does not take would fail each one, not this command.
      if (key === 'chat.effort' && !CHAT_EFFORTS.includes(value)) throw new UsageError(`no such effort "${value}" — one of: ${CHAT_EFFORTS.join(', ')}`);
      if (key === 'chat.notify' && value !== 'on' && value !== 'off') throw new UsageError('chat.notify is on or off: the bell and the notification when a long turn ends behind another window');
      if (key === 'chat.screen' && !['full', 'still', 'plain'].includes(value)) {
        throw new UsageError('chat.screen is full, still or plain: colours flowing through the working line, the same standing still, or drawn for a screen reader — plain marks, no frames, nothing moving');
      }
      // A word would be no budget at all, and the line it holds back would never be said.
      if (key === 'chat.budget' && !/^\d+(\.\d+)?$/.test(value)) throw new UsageError('chat.budget is a sum in US dollars, like 5 or 2.50 (0 for never): what a chat session costs before the screen says so, once');

      if (key === 'jobs.advisor' && value !== 'on' && value !== 'off') throw new UsageError('jobs.advisor is on or off: a job asking the next model up for advice, from inside its own request');

      if (key === 'jobs.floor' && !['haiku', 'sonnet', 'opus', 'fable'].includes(value)) throw new UsageError('jobs.floor is haiku, sonnet, opus or fable: the smallest model a job may run on — haiku holds nothing back');
      if (key === 'jobs.review' && !['risky', 'all', 'off'].includes(value)) {
        throw new UsageError('jobs.review is risky, all or off: which workers that finish DONE, verified, are reviewed without being asked — the ones the router called risky, every one, or none');
      }
      if (key === 'shell.sandbox' && value !== 'on' && value !== 'off') throw new UsageError('shell.sandbox is on or off: the model\'s shell writing only in the project, the temporary folders and the tool caches, on macOS');
      if (key === 'shell.network' && value !== 'on' && value !== 'off') throw new UsageError('shell.network is on or off: the sandboxed shell reaching past this machine — off, it reaches only loopback and local sockets');
      // Stored for every later setup: one that is not the address of a .gguf file would fail each of them.
      if (key === 'model.url') modelUrlOrRefuse(value);
      // A model is one Sumo knows and one that is on; the memory pass also takes `local` and `off`, the chat `auto`.
      if (key === 'chat.model' && value !== 'auto') {
        knownModel(value, ['auto']);
        assertOn(db, value);
      }
      if (key === 'memory.model' && value !== 'local' && value !== 'off') {
        knownModel(value, ['local', 'off']);
        assertOn(db, value);
      }
      setMeta(db, `config.${key}`, value);
      // Read once a process, so a shell that edits the database cannot switch them off under itself: a chat already open keeps
      // what it read, for the jobs it starts too.
      if (key === 'shell.sandbox' || key === 'shell.network') {
        const warning = key === 'shell.sandbox' && value === 'off' ? ["warning: the model's shell is no longer held to the project — its commands can write anywhere you can"] : [];
        return [shown(key), ...warning, 'takes effect in chats and `sumo job run`s started from now on — a chat already open keeps its setting, for the jobs it starts too, until it is started again'];
      }
    }
    return [shown(key)];
  } finally {
    db.close();
  }
}

/** Runs the launcher the way a hook would — bare environment, no PATH help — to prove it works end to end. */
function launcherRuns() {
  try {
    return execFileSync(paths().launcher, ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } }).startsWith('sumo');
  } catch {
    return false;
  }
}

/** What sumo makes in its home, by name: an uninstall removes these and leaves anything else where it is. */
const MADE_HERE = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'backups', 'bin', 'logs', 'jobs', 'models', 'scratch', 'history', 'mcp.json', 'scribe', 'sumo.db']);
const madeHere = (name) => MADE_HERE.has(name) || /^memory\.db\.(?:pre-v\d+\.bak|damaged-|replaced-)/.test(name);

/** The local model's servers for this home: every llama-server whose command line names its models folder. */
function serversFor(home) {
  const models = join(home, 'models');
  const listed = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' }).stdout ?? '';
  return listed
    .split('\n')
    .map((line) => /^\s*(\d+)\s+(.*)$/.exec(line))
    .filter((m) => m && Number(m[1]) !== process.pid && m[2].includes('llama-server') && m[2].includes(models))
    .map((m) => Number(m[1]));
}

/**
 * What `sumo uninstall` would remove, looked at and nothing touched: this home's own files, the `sumo` links on the
 * PATH that run it, and the local model's servers. A home that is the user's home folder, or above it, is refused —
 * SUMO_AGENTS_HOME can name any folder, and an uninstall removes only one of sumo's own.
 */
export function uninstallPlan() {
  const { home, launcher } = paths();
  const own = homedir();
  if (home === '/' || home === own || own.startsWith(`${home}/`)) throw new Refusal(`${home} is your home folder, or above it — sumo uninstall removes only a folder of its own`);
  if (!existsSync(home)) throw new Refusal(`nothing to remove: ${home} is not there`);
  const entries = readdirSync(home);
  if (!entries.some(madeHere)) throw new Refusal(`nothing of sumo's is in ${home} — sumo uninstall removes only a folder of its own`);
  const links = [...new Set((process.env.PATH ?? '').split(delimiter).filter(Boolean))]
    .map((dir) => join(dir, 'sumo'))
    .filter((link) => {
      try {
        return lstatSync(link).isSymbolicLink() && readlinkSync(link) === launcher;
      } catch {
        return false;
      }
    });
  return { home, links, servers: serversFor(home), removed: entries.filter(madeHere), kept: entries.filter((name) => !madeHere(name)) };
}

/** The plan as it is put to the user before anything is removed. */
export function uninstallQuestion(plan, { keepMemory }) {
  return [
    'sumo uninstall removes:',
    `  from ${plan.home}: ${plan.removed.join(', ')}${plan.removed.includes('scratch') ? ' — scratch holds work that belonged to no project' : ''}`,
    ...plan.links.map((link) => `  the sumo link at ${link}`),
    ...(plan.servers.length > 0 ? ["  the local model's server"] : []),
    ...(plan.kept.length > 0 ? [`and leaves, as not sumo's: ${plan.kept.join(', ')}`] : []),
    keepMemory ? `Your memory is copied first, beside it, to ${dirname(plan.home)}.` : 'Your memory is not kept (--discard-memory).',
    'Type uninstall to go on: ',
  ].join('\n');
}

/**
 * Carries the plan out, a line said for each step: the memory copied out first unless it is not to be kept — a copy that
 * cannot be made stops everything here — then the servers, the links and what sumo made in the home.
 */
export function uninstall(plan, { keepMemory = true, now = new Date() } = {}) {
  const lines = [];
  const db = join(plan.home, 'memory.db');
  if (keepMemory && existsSync(db)) {
    const copy = join(dirname(plan.home), `sumo-memory-${now.toISOString().slice(0, 19).replace(/[:T]/g, '-')}.db`);
    try {
      const live = new DatabaseSync(db, { readOnly: true });
      try {
        live.prepare('VACUUM INTO ?').run(copy);
      } finally {
        live.close();
      }
      chmodSync(copy, 0o600);
    } catch (cause) {
      throw new Error(`the memory could not be copied out (${cause.message}) — nothing was removed. sumo uninstall --discard-memory removes it all the same`);
    }
    lines.push(`kept your memory: ${copy} — after a reinstall, sumo backup restore ${copy} --yes puts it back`);
  }
  for (const pid of plan.servers) {
    try {
      process.kill(pid, 'SIGTERM');
    } catch {
      // Gone between the look and the signal.
    }
  }
  if (plan.servers.length > 0) lines.push("stopped the local model's server");
  for (const link of plan.links) {
    rmSync(link, { force: true });
    lines.push(`removed the sumo link at ${link}`);
  }
  // Looked at again: copying the memory out opened it, and its -wal and -shm are back.
  for (const name of readdirSync(plan.home).filter(madeHere)) rmSync(join(plan.home, name), { recursive: true, force: true });
  if (plan.kept.length === 0) rmSync(plan.home, { recursive: true, force: true });
  lines.push(`removed what sumo made in ${plan.home}${plan.kept.length > 0 ? ` — left in place, not sumo's: ${plan.kept.join(', ')}` : ''}`);
  lines.push("last: npm uninstall -g sumo-agents (or delete the clone you built it from), and take out any `sumo hook` lines you added to a harness's hooks");
  return lines;
}
