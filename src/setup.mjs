import { execFileSync } from 'node:child_process';
import {
  accessSync, chmodSync, constants, createWriteStream, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, realpathSync, renameSync, rmSync, statSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { homedir, hostname } from 'node:os';
import { basename, delimiter, join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { pipeline } from 'node:stream/promises';
import { Readable, Transform } from 'node:stream';
import { resolveAnthropicCredential } from './auth.mjs';
import { assertOn, discoverModels, discoverySummary, knownModel, MODELS, modelsChecked, modelStates } from './catalog.mjs';
import { getMeta, openDb, SCHEMA_VERSION, schemaVersion, setMeta } from './db.mjs';
import { stopLocalServer } from './local-server.mjs';
import { UsageError } from './memory.mjs';
import { ENTRY, paths, REPO_ROOT } from './paths.mjs';

const NODE_REQUIREMENT = '22.19+ or 24.6+';

/** The settings `sumo config` accepts, with the value used when none is stored. */
export const CONFIG_DEFAULTS = {
  'prime.budget': '800',
  'scribe.model': 'local',
  'dream.model': 'local',
  'chat.model': 'opus',
  'chat.effort': 'high',
  'model.source': 'https://huggingface.co',
  'model.repo': 'Qwen/Qwen3-4B-GGUF',
  'model.file': 'Qwen3-4B-Q4_K_M.gguf',
};

/**
 * The launcher exists because hooks and sub-agents run where a version
 * manager's `node` is not on PATH and the repo's location is unknown. It pins
 * both as absolute paths, so `sumo` means the same thing everywhere.
 */
function launcherScript() {
  // Single quotes keep a `$`, backtick or `"` in either path literal; a `'` is closed, escaped and reopened.
  const quote = (s) => `'${s.replaceAll("'", `'\\''`)}'`;
  return `#!/bin/sh\nexport NODE_USE_SYSTEM_CA=1\nexec ${quote(process.execPath)} --disable-warning=ExperimentalWarning ${quote(ENTRY)} "$@"\n`;
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
    const ours = existing.isSymbolicLink() && readlinkSync(link) === launcher;
    if (ours) return { link, status: 'already linked' };
    if (!existing.isSymbolicLink() || !readlinkSync(link).endsWith('/.sumo-agents/bin/sumo')) {
      return { link, status: 'skipped — a different `sumo` is already there' };
    }
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

/** This layout also works behind a JFrog Artifactory Hugging Face remote, whose base is its huggingfaceml URL. */
function modelUrl({ source, repo, file }) {
  return `${source}/${repo}/resolve/main/${file}`;
}

/**
 * Downloads the router model unless it is already there at the size the server reports (HEAD first).
 * Streams to `<file>.part` then renames, so a run that dies never leaves a file that looks finished.
 * Never throws: a model that could not be fetched is not a reason for `sumo setup` to fail.
 */
async function ensureModel(db, { modelSource } = {}) {
  const file = getMeta(db, 'config.model.file') ?? CONFIG_DEFAULTS['model.file'];
  const repo = getMeta(db, 'config.model.repo') ?? CONFIG_DEFAULTS['model.repo'];
  const source = modelSource ?? getMeta(db, 'config.model.source') ?? CONFIG_DEFAULTS['model.source'];
  // The file name decides where the bytes land; a separator in it would let `sumo config` point outside models/.
  if (file !== basename(file) || file === '..' || file === '.') {
    return `model.file "${file}" is refused — a file name, with no path separator: sumo config model.file <name>`;
  }
  const dest = join(paths().models, file);
  const url = modelUrl({ source, repo, file });
  const shown = redactUrl(url);
  // Unique per run: two setups at once must not interleave into one file, and a dead run must not leave a
  // part file that a later run mistakes for progress.
  const partPath = `${dest}.${process.pid}.part`;
  try {
    const head = await fetch(url, { method: 'HEAD' });
    if (!head.ok) throw new Error(`HEAD ${shown} → HTTP ${head.status}`);
    const lengthHeader = head.headers.get('content-length');
    const remoteSize = lengthHeader === null ? null : Number(lengthHeader);
    const localSize = existsSync(dest) ? statSync(dest).size : null;
    // No Content-Length (a JFrog remote that has not cached the artifact yet) → keep what is there rather than
    // fetch gigabytes on every setup; a size mismatch is the only reason to download again.
    if (localSize !== null && (remoteSize === null || localSize === remoteSize)) {
      return `model     ${dest} (${formatBytes(localSize)}, present)`;
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`GET ${shown} → HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), cappedAt(MAX_MODEL_BYTES), createWriteStream(partPath));
    renameSync(partPath, dest);
    return `model     ${dest} (${formatBytes(statSync(dest).size)}, downloaded)`;
  } catch (cause) {
    rmSync(partPath, { force: true });
    return `could not download the router model: ${redactUrl(cause.message)}`;
  }
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

/** The one question `sumo setup` ever asks, and only when nothing is stored yet and a person is there to answer it. */
async function askModelSource(defaultSource) {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Download the router model from [${defaultSource}]: `);
    return answer.trim() || defaultSource;
  } finally {
    rl.close();
  }
}

export async function setup({ binDir, link = true, modelSource, noModel = false } = {}) {
  const p = paths();
  for (const dir of [p.home, p.bin, p.logs, p.backups, p.jobs, p.models]) {
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

  let source = modelSource;
  if (source === undefined && !noModel && !getMeta(db, 'config.model.source') && process.stdin.isTTY) {
    source = await askModelSource(CONFIG_DEFAULTS['model.source']);
  }
  if (source !== undefined) setMeta(db, 'config.model.source', source);

  // SUMO_AGENTS_MODEL_CMD marks a hermetic test/dev harness, the same way it tells callModel and
  // callLocalModel never to run a real model — an explicit --model-source still means "go fetch it".
  const harnessSkip = Boolean(process.env.SUMO_AGENTS_MODEL_CMD) && modelSource === undefined;
  let modelLine = null;
  if (!noModel) {
    modelLine = harnessSkip
      ? 'model     not downloaded — SUMO_AGENTS_MODEL_CMD is set (unset it, or pass --model-source, to fetch it)'
      : await ensureModel(db, { modelSource: source });
  }
  const modelsLine = await checkModels(db);
  db.close();

  // Written aside and renamed in, so a hook running the launcher mid-setup never reads half a script.
  const staged = `${p.launcher}.${process.pid}.tmp`;
  writeFileSync(staged, launcherScript(), { mode: 0o755 });
  chmodSync(staged, 0o755);
  renameSync(staged, p.launcher);

  const lines = [`home      ${p.home}`, `database  ${p.db}`, `launcher  ${p.launcher}`];
  if (modelLine) lines.push(modelLine);
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
  }
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
export function doctor() {
  const p = paths();
  const checks = [];
  const check = (ok, label, fix, warn = false) => checks.push({ ok, label, fix, warn });

  // First, so it is still visible when a terminal folds the rest away: "did the update land?" is the
  // question asked most often, and the answer is which commit this copy is running.
  const code = codeVersion();
  check(code !== null, `code ${code ?? 'unknown'}`, 'this copy is not a git checkout, so `git pull` cannot update it — clone the repo instead', true);

  const [major, minor] = process.versions.node.split('.').map(Number);
  const nodeOk = (major === 22 && minor >= 19) || (major === 24 && minor >= 6) || major > 24;
  check(nodeOk, `node ${process.versions.node}`, `needs Node ${NODE_REQUIREMENT}`);

  let db = null;
  // Read here, inside the one guarded open: a database that will not open is a failed check, not the end of the report.
  let stored = { modelFile: null, llama: null, models: null, checked: null, configured: [] };
  try {
    db = openDb();
    const options = db.prepare('PRAGMA compile_options').all().map((r) => Object.values(r)[0]);
    check(options.includes('ENABLE_FTS5'), 'SQLite full-text search (FTS5)', 'this Node build lacks FTS5 — use the official nodejs.org build');
    check(schemaVersion(db) === SCHEMA_VERSION, `schema version ${schemaVersion(db)}`, 'database is from a newer sumo-agents — update this repo');
    const setting = (key) => getMeta(db, `config.${key}`) ?? CONFIG_DEFAULTS[key];
    stored = {
      modelFile: getMeta(db, 'config.model.file'),
      llama: getMeta(db, 'llama.path'),
      models: modelStates(db),
      checked: modelsChecked(db),
      configured: ['chat.model', 'scribe.model', 'dream.model'].map((key) => [key, setting(key)]),
    };
  } catch (cause) {
    check(false, 'database opens', cause.message);
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
  check(mode(p.home) === 0o700, 'home directory is private (0700)', 'run: sumo setup');
  check(mode(p.db) === 0o600, 'database is private (0600)', 'run: sumo setup');

  const launcherOk = existsSync(p.launcher) && readFileSync(p.launcher, 'utf8') === launcherScript();
  check(launcherOk, 'launcher points at this repo and this node', 'run: sumo setup');
  check(launcherOk && launcherRuns(), 'launcher runs the way a hook would call it', 'run: sumo setup');

  const herdr = commandOnPath('herdr');
  check(herdr !== null, 'herdr on PATH (background jobs run in its panes)', 'brew install herdr — or run every job in the chat, without &');
  const found = commandOnPath('sumo');
  const ours = found !== null && existsSync(p.launcher) && realpathSync(found) === realpathSync(p.launcher);
  check(ours, '`sumo` on PATH is this one', found ? `PATH finds ${found} instead` : 'run: sumo setup');

  // The chat and every job go to the API; the memory passes run locally and only fall back to it.
  const standInKey = Boolean(process.env.SUMO_AGENTS_MODEL_CMD);
  check(
    standInKey || Boolean(resolveAnthropicCredential()),
    'ANTHROPIC_API_KEY is set or CLAUDE_CODE_OAUTH_TOKEN is set (chat, jobs, and the passes\' fallback)',
    'export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in the shell that starts sessions and hooks',
  );

  // Not a warning: every job is routed by it, and without an answer no job can be created.
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  if (standIn) {
    check(true, `router stand-in (SUMO_AGENTS_MODEL_CMD=${standIn})`, '');
  } else {
    const model = join(p.models, stored.modelFile ?? CONFIG_DEFAULTS['model.file']);
    check(existsSync(model), `router model (${basename(model)})`, 'run: sumo setup');

    const llama = stored.llama ?? commandOnPath('llama-server');
    check(llama !== null && existsSync(llama), 'llama-server found (runs the router model)', 'brew install llama.cpp, then: sumo setup');
  }

  return checks;
}

function codeVersion() {
  try {
    return execFileSync('git', ['-C', REPO_ROOT, 'log', '-1', '--format=%h · %cs · %s'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

/** A whole number above zero, as `-n` and `--budget` take it; anything else is refused with `message`. */
export function positiveInteger(raw, message) {
  const n = Number(raw);
  if (!(Number.isInteger(n) && n > 0)) throw new UsageError(message);
  return n;
}

export function config(key, value) {
  const db = openDb();
  // A model source can carry a token (`https://user:token@host/…`); it is stored whole, for the download, and shown without it.
  const shown = (k) => `${k} = ${redactUrl(getMeta(db, `config.${k}`) ?? CONFIG_DEFAULTS[k])}`;
  try {
    if (key === undefined) {
      return Object.keys(CONFIG_DEFAULTS).map(shown);
    }
    if (!Object.hasOwn(CONFIG_DEFAULTS, key)) {
      throw new UsageError(`unknown setting "${key}" — one of: ${Object.keys(CONFIG_DEFAULTS).join(', ')}`);
    }
    if (value !== undefined) {
      // A budget that is not a number would be no budget at all: every session's block would carry every preference.
      if (key === 'prime.budget') positiveInteger(value, 'prime.budget needs a positive number');
      // A model is one Sumo knows and one that is on; the passes also take `local` and `off`, the chat `auto`.
      if (key === 'chat.model' && value !== 'auto') {
        knownModel(value, ['auto']);
        assertOn(db, value);
      }
      if ((key === 'scribe.model' || key === 'dream.model') && value !== 'local' && value !== 'off') {
        knownModel(value, ['local', 'off']);
        assertOn(db, value);
      }
      setMeta(db, `config.${key}`, value);
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
