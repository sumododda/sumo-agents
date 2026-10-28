// What sumo says about itself: its version, a command it does not know, colour when the user asked for none, what a
// crash leaves behind, the report doctor bundles, and the home kept private — logs that never grow without end.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, statSync, writeFileSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { appendLog, LOG_ROTATE_BYTES, rotate, trimLog } from '../src/logs.mjs';
import { ENTRY } from '../src/paths.mjs';
import { colourEnabled, VERSION } from '../src/tty.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { NO_KEY, sandbox } from './helpers.mjs';

const mode = (file) => statSync(file).mode & 0o777;
/** A secret of each shape a crash might carry: in the command's words, and in the error's own message. */
const PLANTED_KEY = `sk-ant-api03-${'Ab1'.repeat(14)}`;
const PLANTED_SLACK = `xoxp-1234567890-${'abc123'.repeat(3)}`;
/** Code run before sumo's entry, as `node --import` runs it: here, a timer that goes off once the command has answered. */
const before = (code) => `data:text/javascript,${encodeURIComponent(code)}`;

/** The environment without the colour settings the test runner's own shell may carry: an empty FORCE_COLOR forces colour in chalk. */
function plainEnv(home, env) {
  const { NO_COLOR: _no, FORCE_COLOR: _force, ...rest } = process.env;
  return { ...rest, SUMO_AGENTS_HOME: home, ...env };
}

/** `sumo` started with something run before it, in a home of its own. */
function sumoAfter(home, code, args, env = {}) {
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--import', before(code), ENTRY, ...args], { env: plainEnv(home, env), encoding: 'utf8' });
  return { code: run.status, out: run.stdout, err: run.stderr };
}

test('sumo --version and -v say which sumo this is', () => {
  const s = sandbox();
  for (const flag of ['--version', '-v']) {
    const run = s.sumo([flag]);
    assert.equal(run.code, 0, run.err);
    assert.equal(run.out, `sumo ${VERSION}\n`);
  }
});

test('help opens on what sumo is now, and a mistyped command is answered with the one it was probably meant to be', () => {
  const s = sandbox();
  const help = s.sumo(['help']);
  assert.match(help.out, /^sumo — one chat across your projects, memory that lasts/);
  assert.match(help.out, /sumo --version/);
  assert.match(help.out, /sumo doctor \[--fix\] \[--report\]/);
  const typo = s.sumo(['serch', 'tabs']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /^sumo: unknown command "serch" — did you mean "search"\? See: sumo help$/m);
  assert.match(s.sumo(['doctr']).err, /did you mean "doctor"\?/);
  const far = s.sumo(['zzzzzzz']);
  assert.match(far.err, /^sumo: unknown command "zzzzzzz" — see: sumo help$/m);
});

test('NO_COLOR turns colour off on the chat screen too: chalk, which ink draws with, is told before it loads', () => {
  const s = sandbox();
  const chalk = import.meta.resolve('chalk');
  const probe = `setTimeout(async () => { const c = (await import(${JSON.stringify(chalk)})).default; process.stderr.write('FORCE_COLOR=' + process.env.FORCE_COLOR + ' level=' + c.level + '\\n'); }, 0);`;
  assert.match(sumoAfter(s.home, probe, ['--version'], { NO_COLOR: '1' }).err, /FORCE_COLOR=0 level=0/);
  // Empty is not set (no-color.org), and a FORCE_COLOR the user gave wins.
  assert.match(sumoAfter(s.home, probe, ['--version'], { NO_COLOR: '' }).err, /FORCE_COLOR=undefined /);
  assert.match(sumoAfter(s.home, probe, ['--version'], { NO_COLOR: '1', FORCE_COLOR: '2' }).err, /FORCE_COLOR=2 level=[23]/);
});

test('a FORCE_COLOR the user set wins for sumo\'s own lines too: colour in a pipe for a CI log, even over NO_COLOR; 0 is none', () => {
  const s = sandbox();
  const doctor = (env) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'doctor'], { env: plainEnv(s.home, { ...NO_KEY, ...env }), encoding: 'utf8' }).stdout;
  assert.doesNotMatch(doctor({}), /\x1b\[/, 'piped, the same words without colour');
  assert.match(doctor({ FORCE_COLOR: '1' }), /\x1b\[32mok/);
  assert.match(doctor({ NO_COLOR: '1', FORCE_COLOR: '1' }), /\x1b\[32mok/, 'as it does for the chat screen');
  assert.doesNotMatch(doctor({ NO_COLOR: '1' }), /\x1b\[/);
  assert.equal(colourEnabled({ isTTY: true }, { FORCE_COLOR: '0' }), false);
  assert.equal(colourEnabled({ isTTY: true }, { FORCE_COLOR: 'false' }), false);
  assert.equal(colourEnabled({ isTTY: true }, { TERM: 'dumb', FORCE_COLOR: '1' }), true);
  assert.equal(colourEnabled({ isTTY: false }, { FORCE_COLOR: '' }), false, 'empty is not set');
  assert.equal(colourEnabled({ isTTY: true }, { FORCE_COLOR: '' }), true);
});

test('in a real terminal, NO_COLOR takes chalk from full colour to none', { skip: process.platform !== 'darwin' && 'script(1) is spelled differently here' }, () => {
  const s = sandbox();
  const chalk = import.meta.resolve('chalk');
  const probe = `setTimeout(async () => { const c = (await import(${JSON.stringify(chalk)})).default; console.log('level=' + c.level); }, 0);`;
  const inTerminal = (noColor) =>
    // script(1) needs a terminal or nothing on its stdin, not a pipe.
    spawnSync('script', ['-q', '/dev/null', process.execPath, '--disable-warning=ExperimentalWarning', '--import', before(probe), ENTRY, '--version'], {
      env: plainEnv(s.home, { TERM: 'xterm-256color', NO_COLOR: noColor }),
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).stdout;
  assert.match(inTerminal(''), /level=[123]/);
  assert.match(inTerminal('1'), /level=0/);
});

test('a crash leaves a private file with the version and the stack, and no secret from the command or the error', () => {
  const s = sandbox();
  const run = sumoAfter(s.home, `setTimeout(() => { throw new Error('boom with ' + ${JSON.stringify(PLANTED_KEY)}); }, 30);`, ['help', PLANTED_SLACK]);
  assert.equal(run.code, 1, 'it still ends as an uncaught error ends');
  assert.match(run.err, /Error: boom with/, 'the stack still goes to stderr');
  assert.match(run.err, /sumo: crashed — written to .*crash-.*\.log \(sumo doctor --report bundles it\)/);
  const logs = join(s.home, 'logs');
  const [name] = readdirSync(logs).filter((n) => n.startsWith('crash-'));
  const file = join(logs, name);
  assert.equal(mode(file), 0o600);
  const body = readFileSync(file, 'utf8');
  assert.match(body, new RegExp(`^sumo ${VERSION.replaceAll('.', '\\.')} crashed \\(uncaughtException\\)`));
  assert.match(body, /^error: Error: boom with/m);
  assert.match(body, /^command: help \(\d+ more arguments?, not kept\)$/m, 'the command, never the words after it');
  assert.doesNotMatch(body, new RegExp(PLANTED_KEY));
  assert.doesNotMatch(body, new RegExp(PLANTED_SLACK));
  // A rejection nobody handled is one too.
  sumoAfter(s.home, `setTimeout(() => { Promise.reject(new Error('rejected')); }, 30);`, ['help']);
  const files = readdirSync(logs).filter((n) => n.startsWith('crash-'));
  assert.equal(files.length, 2);
  assert.ok(files.some((n) => /crashed \(unhandledRejection\)/.test(readFileSync(join(logs, n), 'utf8'))));
});

test('only the newest ten crash files are kept', () => {
  const s = sandbox();
  const logs = join(s.home, 'logs');
  mkdirSync(logs, { recursive: true });
  for (let i = 0; i < 12; i++) writeFileSync(join(logs, `crash-2026-01-${String(i + 1).padStart(2, '0')}T00-00-00-000Z.log`), 'old\n');
  sumoAfter(s.home, `setTimeout(() => { throw new Error('one more'); }, 30);`, ['help']);
  const kept = readdirSync(logs).filter((n) => n.startsWith('crash-')).sort();
  assert.equal(kept.length, 10);
  assert.equal(kept[0], 'crash-2026-01-04T00-00-00-000Z.log', 'the oldest went first');
  assert.match(readFileSync(join(logs, kept.at(-1)), 'utf8'), /one more/);
});

test('doctor says a recent crash, and --report bundles what is needed to read a problem — redacted, sent nowhere', () => {
  const s = sandbox();
  s.sumo(['config']);
  sumoAfter(s.home, `setTimeout(() => { throw new Error('report me'); }, 30);`, ['help']);
  // A log that is still quoted, its last 50 lines: the memory pass's and the hooks' are counted instead (they hold what was said).
  writeFileSync(join(s.home, 'logs', 'llama-server.log'), `${Array.from({ length: 60 }, (_, i) => `line ${i}`).join('\n')}\ntoken=${PLANTED_KEY}\n`, { mode: 0o600 });
  writeFileSync(join(s.home, 'mcp.json'), JSON.stringify({ mcpServers: { slack: { url: 'https://mcp.slack.com/mcp', headers: { Authorization: `Bearer ${PLANTED_SLACK}` } } } }), { mode: 0o600 });

  const doctor = s.sumo(['doctor']);
  assert.match(doctor.out, /^warn {2}crash on \d{4}-\d{2}-\d{2} [\d:]+: Error: report me — .*crash-.*\.log; sumo doctor --report bundles it for a bug report/m);

  const report = s.sumo(['doctor', '--report']);
  assert.match(report.out, new RegExp(`^# sumo ${VERSION.replaceAll('.', '\\.')} report`));
  assert.match(report.out, /^node: /m);
  assert.match(report.out, /^## doctor\n(?:.+\n)*?(?:ok|warn|FAIL) {2}/m);
  assert.match(report.out, /^## config\n/m);
  assert.match(report.out, /^## mcp servers\nslack\n/m);
  assert.match(report.out, /^## last crash: crash-.*\.log\nsumo .* crashed/m);
  assert.match(report.out, /^## logs\/llama-server\.log \(last 50 lines\)\nline 11\n/m);
  assert.doesNotMatch(report.out, /line 9\n/);
  assert.doesNotMatch(report.out, new RegExp(PLANTED_KEY));
  assert.doesNotMatch(report.out, new RegExp(PLANTED_SLACK));
  assert.doesNotMatch(report.out, /mcp\.slack\.com/, 'a server is named, not where it is or what it is given');
});

test('doctor finds files of the home that others can read, and --fix makes them private, never touching a job\'s project files', () => {
  const s = sandbox();
  s.sumo(['config']);
  writeFileSync(join(s.home, 'history'), 'typed\n', { mode: 0o644 });
  chmodSync(join(s.home, 'history'), 0o644);
  mkdirSync(join(s.home, 'logs', 'sessions'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.home, 'logs', 'sessions', 'a.jsonl'), '{}\n');
  chmodSync(join(s.home, 'logs', 'sessions', 'a.jsonl'), 0o644);
  chmodSync(join(s.home, 'logs'), 0o755);
  // A job's worktree is a copy of a project: it and its scripts keep their modes.
  mkdirSync(join(s.home, 'jobs', '7', 'tree'), { recursive: true, mode: 0o700 });
  chmodSync(join(s.home, 'jobs', '7', 'tree'), 0o755);
  writeFileSync(join(s.home, 'jobs', '7', 'tree', 'run.sh'), '#!/bin/sh\n');
  chmodSync(join(s.home, 'jobs', '7', 'tree', 'run.sh'), 0o755);
  writeFileSync(join(s.home, 'jobs', '7', 'brief.md'), 'task\n');
  chmodSync(join(s.home, 'jobs', '7', 'brief.md'), 0o644);

  const found = s.sumo(['doctor']);
  assert.match(found.out, /^warn {2}4 places in the home others can read: history, jobs\/7\/brief\.md, logs, logs\/sessions\/a\.jsonl — run: sumo doctor --fix$/m);
  const fixed = s.sumo(['doctor', '--fix']);
  assert.match(fixed.out, /^fixed: made 4 places private$/m);
  assert.match(fixed.out, /^ok {4}the home's files are private \(0600, folders 0700\)$/m);
  assert.equal(mode(join(s.home, 'history')), 0o600);
  assert.equal(mode(join(s.home, 'logs', 'sessions', 'a.jsonl')), 0o600);
  assert.equal(mode(join(s.home, 'logs')), 0o700);
  assert.equal(mode(join(s.home, 'jobs', '7', 'brief.md')), 0o600);
  assert.equal(mode(join(s.home, 'jobs', '7', 'tree', 'run.sh')), 0o755, 'a project file in a worktree is the project\'s');
  assert.equal(mode(join(s.home, 'jobs', '7', 'tree')), 0o755);
});

test('doctor checks the shell sandbox, git, and that the MCP file reads', () => {
  const s = sandbox();
  s.sumo(['config']);
  const ok = s.sumo(['doctor']);
  if (process.platform === 'darwin') assert.match(ok.out, /^ok {4}shell sandbox \(\/usr\/bin\/sandbox-exec\)$/m);
  assert.match(ok.out, /^ok {4}git on PATH$/m);
  writeFileSync(join(s.home, 'mcp.json'), '{ not json', { mode: 0o600 });
  assert.match(s.sumo(['doctor']).out, /^FAIL {2}MCP servers file reads \(mcp\.json\) — .*mcp\.json/m);
  const noGit = s.sumo(['doctor'], { extraEnv: { PATH: '/nonexistent' } });
  assert.match(noGit.out, /^warn {2}git on PATH — /m);
});

test('a log past its limit is moved aside before the next line, so the newest lines are always in the file of its name', async () => {
  await withHome(freshHome(), {}, async () => {
    const logs = join(process.env.SUMO_AGENTS_HOME, 'logs');
    appendLog('scribe.log', 'first\n');
    assert.equal(mode(join(logs, 'scribe.log')), 0o600);
    assert.equal(mode(logs), 0o700);
    writeFileSync(join(logs, 'scribe.log'), 'x'.repeat(LOG_ROTATE_BYTES + 1));
    appendLog('scribe.log', 'after\n');
    assert.equal(readFileSync(join(logs, 'scribe.log'), 'utf8'), 'after\n');
    assert.equal(statSync(join(logs, 'scribe.log.1')).size, LOG_ROTATE_BYTES + 1);
    rotate(join(logs, 'not-there.log'));
    assert.equal(existsSync(join(logs, 'not-there.log.1')), false);
  });
});

test('a log a long-lived process holds open is trimmed in place: its writer carries on in the file of that name, not in the copy', async () => {
  await withHome(freshHome(), {}, async () => {
    const logs = join(process.env.SUMO_AGENTS_HOME, 'logs');
    mkdirSync(logs, { recursive: true });
    const file = join(logs, 'llama-server.log');
    writeFileSync(file, 'x'.repeat(LOG_ROTATE_BYTES + 1));
    // Held open for appending, as the server's stdout is.
    const held = openSync(file, 'a');
    try {
      trimLog('llama-server.log');
      writeSync(held, 'still here\n');
      assert.equal(readFileSync(file, 'utf8'), 'still here\n', 'the writer goes on at the start of the emptied file');
      assert.equal(statSync(`${file}.1`).size, LOG_ROTATE_BYTES + 1, 'what it held is kept aside');
      trimLog('llama-server.log');
      assert.equal(readFileSync(file, 'utf8'), 'still here\n', 'a log under the limit is left alone');
    } finally {
      closeSync(held);
    }
  });
});

test('a log made readable by others before logs were private is made private on its next line', async () => {
  await withHome(freshHome(), {}, async () => {
    const logs = join(process.env.SUMO_AGENTS_HOME, 'logs');
    mkdirSync(logs, { recursive: true });
    const file = join(logs, 'old-scribe.log');
    writeFileSync(file, 'from before\n');
    chmodSync(file, 0o644);
    appendLog('old-scribe.log', 'now\n');
    assert.equal(mode(file), 0o600);
    assert.equal(readFileSync(file, 'utf8'), 'from before\nnow\n');
  });
});

test('doctor says in one line how memory is doing: when the user was last heard, the last pass, what waits to be asked, and old scans — a failed pass or a month-old scan is a warning', () => {
  const s = sandbox();
  s.sumo(['config']);
  assert.match(s.sumo(['doctor']).out, /^ok {4}memory: nothing heard yet · no memory pass yet · no guesses waiting$/m);

  const ago = (days) => new Date(Date.now() - days * 86_400_000).toISOString();
  s.sql((db) => {
    db.prepare(`INSERT INTO sessions (id, harness, started_at) VALUES ('s1', 'sumo', ?)`).run(ago(3));
    db.prepare(`INSERT INTO user_turns (session_id, ts, text, redacted) VALUES ('s1', ?, 'we ship on fridays', 0)`).run(ago(3));
    db.prepare(`INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, note) VALUES (?, 'scribe', 'local', 1, 1, 0, 1, 'applied=1 dropped=0')`).run(ago(2));
    db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at) VALUES ('preference', 'global', 'likes tabs', 'inferred', 'unconfirmed', 1, 'scribe', ?, ?)`).run(ago(16), ago(16));
    db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at) VALUES ('preference', 'global', 'likes yaml', 'inferred', 'rejected', 1, 'scribe', ?, ?)`).run(ago(20), ago(20));
    db.prepare(`INSERT INTO memories (type, scope, body, provenance, state, importance, written_by, valid_from, created_at) VALUES ('preference', 'global', 'likes pnpm', 'stated', 'active', 1, 'scribe', ?, ?)`).run(ago(20), ago(20));
  });
  const healthy = s.sumo(['doctor']).out;
  assert.match(healthy, /^ok {4}memory: last heard 3d ago · last pass 2d ago · 1 guess waiting, the oldest 16d · 50% of guesses confirmed$/m);

  s.sql((db) => {
    db.prepare(`INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, note) VALUES (?, 'dream', 'local', 1, 1, 0, 0, 'llama-server did not become healthy')`).run(ago(1));
    db.prepare(`INSERT INTO projects (slug, name, path, created_at, scanned_at) VALUES ('old', 'old', '/nowhere/old', ?, ?)`).run(ago(40), ago(40));
  });
  const failing = s.sumo(['doctor']).out;
  assert.match(failing, /^warn {2}memory: last heard 3d ago · last pass 1d ago, failed · 1 guess waiting, the oldest 16d · 50% of guesses confirmed · 1 project scan over 7 days old \(old, 40d\) — the last pass failed: llama-server did not become healthy; rescan: sumo project rescan old$/m);
});
