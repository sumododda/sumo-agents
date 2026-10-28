import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY, REPO_ROOT } from '../src/paths.mjs';
// For its one effect: the test runner's FORCE_COLOR taken away, so `sumo` runs here as it would for the user.
import './fixtures/env-sandbox.mjs';

/** An empty credential environment: no ambient token decides whether a test pays for a fallback call. */
export const NO_KEY = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' };

/** A pseudo-terminal from Python's standard library — Node has none: it types PTY_ANSWER once the output ends with PTY_UNTIL. */
const PTY = `import os, pty, re, select, sys, time
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
out, sent, deadline = b'', False, time.time() + 20
while time.time() < deadline:
    ready, _, _ = select.select([fd], [], [], 0.05)
    chunk = b''
    if ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b''
        out += chunk
        if not sent and re.sub(rb'\\x1b\\[[0-9;?]*[A-Za-z]', b'', out).rstrip().endswith(os.environ['PTY_UNTIL'].encode()):
            os.write(fd, os.environ['PTY_ANSWER'].encode() + b'\\r')
            sent = True
    if not chunk:
        done, status = os.waitpid(pid, os.WNOHANG)
        if done:
            break
else:
    os.kill(pid, 9)
    status = os.waitpid(pid, 0)[1]
sys.stdout.buffer.write(out)
sys.exit(os.waitstatus_to_exitcode(status))
`;
/** A pseudo-terminal relay: what the program writes comes out as it is written; what is written in goes to its terminal (\\x03 is a Ctrl-C). */
const PTY_RELAY = `import os, pty, select, sys
pid, fd = pty.fork()
if pid == 0:
    os.execv(sys.argv[1], sys.argv[1:])
inputs = [fd, sys.stdin.fileno()]
while True:
    ready, _, _ = select.select(inputs, [], [], 0.05)
    if fd in ready:
        try:
            chunk = os.read(fd, 4096)
        except OSError:
            chunk = b''
        if chunk:
            sys.stdout.buffer.write(chunk)
            sys.stdout.flush()
    if sys.stdin.fileno() in ready:
        typed = os.read(sys.stdin.fileno(), 4096)
        if typed:
            os.write(fd, typed)
        else:
            inputs.remove(sys.stdin.fileno())
    done, status = os.waitpid(pid, os.WNOHANG)
    if done:
        break
sys.exit(os.waitstatus_to_exitcode(status))
`;
/** `sumo` started at a terminal and left running: read its stdout as it comes, write to its stdin to type (a Ctrl-C is '\\x03'). */
export const atTerminal = (args, env) => spawn('python3', ['-I', '-c', PTY_RELAY, process.execPath, '--disable-warning=ExperimentalWarning', ENTRY, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });

/** Whether a test can run sumo at a terminal here: python3 with its pty module. */
export const HAS_PTY = spawnSync('python3', ['-c', 'import pty, os; os.waitstatus_to_exitcode'], { stdio: 'ignore' }).status === 0;

/** A throwaway home, so no test ever touches the real ~/.sumo-agents. */
export function sandbox() {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-test-'));
  const home = join(root, 'home');
  const spawnLog = join(root, 'spawned.log');
  const modelAnswer = join(root, 'model-answer.json');
  const modelSaw = join(root, 'model-saw.json');
  const routerAnswer = join(root, 'router-answer.json');
  const modelsAnswer = join(root, 'models-answer.json');
  const env = {
    ...process.env,
    ...NO_KEY,
    SUMO_AGENTS_HOME: home,
    SUMO_AGENTS_SPAWN_LOG: spawnLog,
    SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'),
    STUB_ANSWER: modelAnswer,
    STUB_CAPTURE: modelSaw,
    STUB_ROUTER_ANSWER: routerAnswer,
    STUB_MODELS: modelsAnswer,
  };

  /** Runs `sumo` exactly as a user would. Never throws: exit code and streams come back for asserting on. */
  const sumo = (args, { input, extraEnv } = {}) => {
    const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], {
      env: { ...env, ...extraEnv },
      input,
      encoding: 'utf8',
    });
    return { code: run.status, out: run.stdout, err: run.stderr };
  };

  /** Runs `sumo` at a terminal and answers its question with `answer` once the prompt ends with `until`; the text the terminal showed comes back. */
  const typed = (args, answer, until) => {
    const run = spawnSync('python3', ['-I', '-c', PTY, process.execPath, '--disable-warning=ExperimentalWarning', ENTRY, ...args], {
      env: { ...env, PTY_ANSWER: answer, PTY_UNTIL: until },
      encoding: 'utf8',
    });
    // What a person reads: the terminal's cursor moves and clears are not text.
    return { code: run.status, out: run.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').replace(/\r\n/g, '\n') };
  };

  /** Direct access, for arranging state no command can create yet and for checking what was really stored. */
  const sql = (fn) => {
    const db = new DatabaseSync(join(home, 'memory.db'));
    try {
      return fn(db);
    } finally {
      db.close();
    }
  };

  const addProject = (slug, alias) => {
    sumo(['config']); // first touch creates the database
    sql((db) => {
      db.prepare('INSERT INTO projects (slug, name, path, created_at) VALUES (?, ?, ?, ?)').run(
        slug,
        slug,
        `/tmp/projects/${slug}`,
        new Date().toISOString(),
      );
      if (alias) db.prepare('INSERT INTO project_aliases (alias, slug) VALUES (?, ?)').run(alias, slug);
    });
  };

  /** Raises one session event from outside the process: JSON on stdin. */
  const hook = (event, payload, extraEnv) => sumo(['hook', event], { input: JSON.stringify(payload), extraEnv });

  /** What the cheap model will answer next, in Claude Code's own envelope. */
  const modelWillSay = (ops, { isError = false } = {}) =>
    writeFileSync(
      modelAnswer,
      JSON.stringify({ is_error: isError, result: isError ? 'rate limited' : '', structured_output: isError ? null : { ops }, usage: { input_tokens: 3400, output_tokens: 120 }, total_cost_usd: 0.004 }),
    );

  /** What the local router will answer for every `sumo job new` and `sumo job retry` from here on; null makes it fail. */
  const routerWillSay = (model, effort, reason = 'stand-in route') =>
    model === null ? rmSync(routerAnswer, { force: true }) : writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model, effort, reason }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));

  /** Which of Sumo's models the API will say it has, by short name, for every discovery from here on; `errors` names ones whose check fails. */
  const modelsFound = (found, { errors = {} } = {}) => writeFileSync(modelsAnswer, JSON.stringify({ found, errors }));

  const modelWasShown = () => JSON.parse(readFileSync(modelSaw, 'utf8'));
  const spawned = () => (existsSync(spawnLog) ? readFileSync(spawnLog, 'utf8').trim().split('\n').filter(Boolean) : []);

  return { root, home, sumo, typed, sql, addProject, hook, modelWillSay, routerWillSay, modelsFound, modelWasShown, spawned };
}
