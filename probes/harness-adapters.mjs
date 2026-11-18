// External arms of the paired coding eval. Each works in its independently seeded checkout.
import { spawn, spawnSync } from 'node:child_process';
import { accessSync, constants, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { MODEL_IDS } from '../src/catalog.mjs';
import { EFFORTS } from '../src/route.mjs';
import { redact } from '../src/redact.mjs';
import { killGroup } from '../src/tools.mjs';

const CLAUDE = 'claude-code';
const SIBLING = 'sumo-harness';
const OUTPUT_LIMIT = 8 * 1024 * 1024;
const FLAGS = {
  [CLAUDE]: ['--print', '--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--model', '--effort', '--max-budget-usd', '--permission-mode', '--allowedTools', '--tools', '--output-format'],
  [SIBLING]: ['--print', '--provider', '--no-cache', '--mode', '--json', '--yes'],
};

function executable(name) {
  if (!name) throw new Error('sumo-harness requires --sibling-bin pointing to its own executable');
  const candidates = name.includes('/') ? [resolve(name)] : (process.env.PATH ?? '').split(delimiter).filter(Boolean).map((dir) => resolve(dir, name));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      if (statSync(candidate).isFile()) return candidate;
    } catch {
      // Try the next PATH entry.
    }
  }
  throw new Error(`benchmark executable unavailable: ${name}`);
}

/** Unpaid checks for every selected arm run before the first task. The sibling's independent cap must cover its selected credential. */
export function preflightExternal(harness, { route, budgetUsd, claudeBin = 'claude', siblingBin, externalCap = false }) {
  if (!Object.hasOwn(FLAGS, harness)) throw new Error(`unknown external harness: ${harness}`);
  if (!Object.hasOwn(MODEL_IDS, route?.model) || !EFFORTS.includes(route?.effort)) throw new Error('provide a supported model and effort');
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0) throw new Error('provide a positive per-run dollar limit');
  if (harness === SIBLING && externalCap !== true) throw new Error('sumo-harness lacks a spend-limit flag and needs an independently enforced dollar cap');
  const binary = executable(harness === CLAUDE ? claudeBin : siblingBin);
  const help = spawnSync(binary, ['--help'], { encoding: 'utf8', timeout: 10_000, env: { PATH: process.env.PATH, LANG: 'C' } });
  const unsupported = FLAGS[harness].filter((flag) => !help.stdout?.includes(flag));
  if (help.status !== 0 || unsupported.length) throw new Error(`${harness} cannot run the benchmark with this executable: ${help.error?.message ?? (unsupported.join(', ') || 'help failed')}`);
  const endpoint = harness === SIBLING && Boolean(process.env.SUMO_ENDPOINT_URL);
  const pinnedModel = harness === CLAUDE || endpoint;
  return {
    binary, model: pinnedModel ? MODEL_IDS[route.model] : null, effort: harness === CLAUDE ? route.effort : null,
    routeNote: harness === CLAUDE ? 'Model and effort pinned.' : endpoint ? 'Endpoint model pinned across tiers. The harness selects effort.' : 'The Claude provider selects model and effort by stage.',
  };
}

function childEnv(home, harness) {
  const env = { HOME: home, PATH: process.env.PATH, LANG: 'C', CI: '1', NO_COLOR: '1' };
  // Preserve explicit credentials for the selected provider. API keys for unrelated services and personal hook configuration stay outside the fixture.
  const names = harness === CLAUDE ? ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN', 'ANTHROPIC_BASE_URL']
    : process.env.SUMO_ENDPOINT_URL ? ['SUMO_ENDPOINT_URL', 'SUMO_ENDPOINT_KEY'] : ['ANTHROPIC_API_KEY'];
  for (const name of names) if (process.env[name]) env[name] = process.env[name];
  return env;
}

async function invoke(binary, args, cwd, env, timeoutMs) {
  const child = spawn(binary, args, { cwd, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let stopped = null;
  let bytes = 0;
  const stdout = [];
  const stderr = [];
  function stop(reason) {
    stopped ??= reason;
    killGroup(child.pid);
  }
  function collect(chunk, chunks) {
    bytes += chunk.length;
    if (bytes > OUTPUT_LIMIT) stop('CLI output exceeded the benchmark limit');
    else chunks.push(chunk);
  }
  // The detached group lets a timeout stop the CLI's children. Forward terminal signals it would otherwise miss.
  const signals = ['SIGINT', 'SIGHUP', 'SIGTERM'];
  const cleanup = () => killGroup(child.pid);
  const onSignal = (signal) => {
    cleanup();
    if (process.listenerCount(signal) === 0) process.kill(process.pid, signal);
  };
  for (const signal of signals) process.once(signal, onSignal);
  process.once('exit', cleanup);
  const timer = setTimeout(() => stop(`CLI timed out after ${timeoutMs} ms`), timeoutMs);
  try {
    child.stdout.on('data', (chunk) => collect(chunk, stdout));
    child.stderr.on('data', (chunk) => collect(chunk, stderr));
    child.once('error', (err) => { stopped = err.message; });
    const code = await new Promise((done) => child.once('close', done));
    return { code, stopped, stdout: Buffer.concat(stdout).toString(), stderr: Buffer.concat(stderr).toString() };
  } finally {
    clearTimeout(timer);
    for (const signal of signals) process.removeListener(signal, onSignal);
    process.removeListener('exit', cleanup);
    cleanup();
  }
}

const money = (value) => Number.isFinite(value) && value >= 0 ? value : null;
const models = (names) => [...new Set(names.filter((name) => typeof name === 'string' && name))].join(', ') || null;
const claim = (report) => [...report.matchAll(/^\s*STATUS:\s*(DONE|FAILED)\s*$/gim)].at(-1)?.[1].toLowerCase();

export async function runExternal(harness, options) {
  const { dir, task, budgetUsd, timeoutMs = 600_000 } = options;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2_147_483_647) throw new Error('invalid benchmark timeout');
  const route = preflightExternal(harness, options);
  const home = mkdtempSync(join(tmpdir(), 'sumo-eval-cli-'));
  const prompt = `${task.brief}\nReport your completion status on a separate line, STATUS: DONE or STATUS: FAILED. Preserve any answer line the brief requires.`;
  const env = childEnv(home, harness);
  const endpoint = Boolean(env.SUMO_ENDPOINT_URL);
  if (endpoint) env.SUMO_ENDPOINT_MODEL = route.model;
  const scout = task.agent === 'scout';
  const allowed = scout ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash(npm test),Bash(node --test*)';
  const args = harness === CLAUDE
    ? ['--safe-mode', '--strict-mcp-config', '--no-session-persistence', '--permission-mode', 'dontAsk', '--output-format', 'json',
      '--model', route.model, '--effort', route.effort, '--max-budget-usd', String(budgetUsd), '--tools', scout ? 'Read,Glob,Grep' : 'Read,Glob,Grep,Edit,Write,Bash',
      '--allowedTools', allowed, '--print', '--', prompt]
    : ['--provider', endpoint ? 'endpoint' : 'claude', '--no-cache', '--mode', scout ? 'read' : 'chat', '--yes', '--json', '--print', prompt];
  try {
    const run = await invoke(route.binary, args, dir, env, timeoutMs);
    const result = { status: 'failed', report: '', stopped: run.stopped, model: route.model, effort: route.effort, routeNote: route.routeNote, requests: null, costUsd: null };
    if (run.stopped) return result;
    try {
      if (harness === CLAUDE) {
        const row = JSON.parse(run.stdout);
        if (row.type !== 'result') throw new Error('missing Claude result');
        result.report = typeof row.result === 'string' ? row.result : '';
        result.costUsd = money(row.total_cost_usd);
        result.model = models(Object.keys(row.modelUsage ?? {})) ?? result.model;
        if (run.code === 0 && row.subtype === 'success' && !row.is_error) result.status = claim(result.report) ?? 'unknown';
        else result.stopped = `Claude Code ${row.subtype ?? 'failed'} (exit ${run.code})`;
      } else {
        const row = run.stdout.trim().split('\n').filter(Boolean).map((s) => JSON.parse(s)).findLast((r) => r.event === 'result');
        if (!row) throw new Error('missing sumo-harness result');
        result.report = typeof row.output === 'string' ? row.output : '';
        result.model = models((row.stages ?? []).map((s) => s.model)) ?? result.model;
        // The generic endpoint reports a zero price for every model, regardless of billing.
        if (!endpoint && row.cost?.length === 1 && row.cost[0].unit === 'usd') result.costUsd = money(row.cost[0].amount);
        if (run.code === 0 && row.status === 'done') result.status = claim(result.report) ?? 'done';
        else result.stopped = `sumo-harness ${row.status ?? 'failed'} (exit ${run.code})`;
      }
    } catch (error) {
      result.stopped = redact(`${error.message}: CLI exit ${run.code}. ${run.stderr.trim().slice(-300)}`).text;
    }
    return result;
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
}
