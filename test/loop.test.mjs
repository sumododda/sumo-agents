// The job loop: the request it builds, the policy every tool call passes through, and the ledger it leaves.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { setModel } from '../src/catalog.mjs';
import { openDb } from '../src/db.mjs';
import { add, UsageError } from '../src/memory.mjs';
import { jobPrinter } from '../src/chat.mjs';
import { getJob, takeInbox, tell } from '../src/jobs.mjs';
import Anthropic from '@anthropic-ai/sdk';
import { converse, jobParams, markTail, RETRY, retryable, retryDelay, runJob, runLines, stopReason } from '../src/loop.mjs';
import { closeMcp, readConfig, writeConfig } from '../src/mcp.mjs';
import { ENTRY, paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { cap, capRedacted, childEnv, jailed, runBash, runEditor } from '../src/tools.mjs';
import { styles } from '../src/tty.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-09-30T12:00:00.000Z';

/** A project on disk, registered, with one running job routed to a model — the least a run needs. */
function seed(db, { agent = 'worker', model = 'sonnet', effort = 'medium' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-loop-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true' } }));
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  writeFileSync(join(root, '.env'), 'SECRET=hidden\n');
  const { project: { slug } } = addProject(db, root, { slug: 'demo', now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, ?, ?, 'running', 's1', ?, ?, ?, ?, 'test')`)
    .run(slug, 'demo job', agent, NOW, NOW, model, effort);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — demo job\n\n## The task\nsay hello\n`);
  return { root, id };
}

const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const canned = (responses) => {
  const seen = [];
  const send = async (params) => {
    seen.push(structuredClone(params));
    return responses.shift();
  };
  return { send, seen };
};

test('the request: frozen system with a cache breakpoint, the brief as the one user turn, tools by role, effort by route', () => {
  const worker = jobParams({ job: { agent: 'worker', model: 'sonnet', effort: 'medium' }, text: 'the brief', system: 'rules' });
  assert.equal(worker.model, 'claude-sonnet-5-5');
  assert.deepEqual(worker.system, [{ type: 'text', text: 'rules', cache_control: { type: 'ephemeral' } }]);
  assert.deepEqual(worker.messages, [{ role: 'user', content: [{ type: 'text', text: 'the brief' }] }]);
  assert.deepEqual(worker.tools.map((t) => t.name), ['bash', 'str_replace_based_edit_tool', 'baseline', 'verify', 'note', 'ask', 'search_memory', 'finish']);
  assert.deepEqual(worker.output_config, { effort: 'medium' });
  assert.equal(worker.context_management.edits[0].type, 'clear_tool_uses_20250919');
  assert.equal(worker.max_tokens, 64_000, 'the thinking every current model does counts toward the limit, so it holds the thinking and the reply');

  const scout = jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' });
  assert.deepEqual(scout.tools.map((t) => t.name), ['bash', 'note', 'ask', 'search_memory', 'finish'], 'a scout cannot edit, and has no checks to run');
  assert.equal('output_config' in scout, false, 'haiku takes no effort');
  const reviewer = jobParams({ job: { agent: 'reviewer', model: 'opus', effort: 'high' }, text: 'judge', system: 'rules' });
  assert.deepEqual(reviewer.tools.map((t) => t.name), ['bash', 'note', 'ask', 'search_memory', 'finish'], 'a reviewer cannot edit');
});

test('a run: tool calls go through the guard, the jail and the cap; every response leaves a ledger row with the job on it', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { root, id } = seed(db);
      const { send, seen } = canned([
        reply('tool_use', [{ type: 'text', text: 'looking' }, call('t1', 'bash', { command: 'printf hi; printenv ANTHROPIC_API_KEY | grep -c .' })]),
        reply('tool_use', [call('t2', 'bash', { command: 'rm -rf ~' }), call('t3', 'str_replace_based_edit_tool', { command: 'view', path: join(root, '.env') })]),
        reply('tool_use', [call('t4', 'str_replace_based_edit_tool', { command: 'view', path: '/etc/hosts' }), call('t5', 'str_replace_based_edit_tool', { command: 'str_replace', path: 'a.txt', old_str: 'two', new_str: '2' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }], { input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 20 }),
        reply('end_turn', [{ type: 'text', text: 'still not closing it' }]),
      ]);
      const outcome = await runJob(db, id, { send, now: () => NOW });

      // It stopped with the job open: told once to close it, and not again.
      assert.match(seen[4].messages.at(-1).content[0].text, /^You ended without closing the job\. Call `finish` now/);
      assert.equal(seen.length, 5);
      assert.equal(outcome.turns, 5);
      assert.equal(outcome.stop, 'end_turn');
      assert.equal(outcome.totals.toolCalls, 5);
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\n2\nthree\n', 'the edit landed');

      const results = (turn) => seen[turn].messages.at(-1).content;
      assert.match(results(1)[0].content, /^hi0/, 'bash ran in the project without the API key in its environment');
      assert.equal(results(1)[0].is_error, true, 'grep -c found nothing, so the command exited 1');
      assert.match(results(2)[0].content, /Refused: .*delete a whole tree/);
      assert.equal(results(2)[0].is_error, true);
      assert.match(results(2)[1].content, /Refused: .*secret file/);
      assert.match(results(3)[0].content, /outside the project/);
      assert.match(results(3)[1].content, /^edited /);

      // Each turn re-sends the whole history with a breakpoint on its tail and the one the turn before left; the system prompt keeps its own.
      assert.equal(seen[3].messages.length, 7);
      assert.deepEqual(seen[3].messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
      assert.deepEqual(seen[3].messages.slice(0, -1).flatMap((m) => m.content).filter((b) => b.cache_control), [seen[2].messages.at(-1).content.at(-1)], 'the previous tail keeps its mark, nothing older does');
      assert.deepEqual(seen[3].system[0].cache_control, { type: 'ephemeral' });

      const rows = db.prepare('SELECT kind, model, input_tokens, cache_read_tokens, job_id, session_id, note FROM model_runs ORDER BY id').all();
      assert.equal(rows.length, 5);
      assert.deepEqual(rows.map((r) => r.job_id), [id, id, id, id, id]);
      assert.equal(rows[0].kind, 'worker');
      assert.equal(rows[0].model, 'claude-sonnet-5-5');
      assert.equal(rows[0].session_id, 's1');
      assert.deepEqual([rows[3].input_tokens, rows[3].cache_read_tokens], [2500, 2000]);

      const lines = runLines(outcome);
      assert.match(lines[0], /^STATUS: never closed — j\d+$/);
      assert.ok(lines.some((l) => /close it yourself/.test(l)));
    } finally {
      db.close();
    }
  });
});

test('a transport error ends the run with the reason, logged, and the job left open', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      const send = async () => {
        throw new Error('the API answered 529: overloaded');
      };
      const outcome = await runJob(db, id, { send, now: () => NOW });
      assert.equal(outcome.stop, 'error');
      assert.match(outcome.error, /529/);
      assert.equal(outcome.job.status, 'running');
      const row = db.prepare('SELECT ok, note, kind FROM model_runs ORDER BY id DESC LIMIT 1').get();
      assert.deepEqual([row.ok, row.kind], [0, 'scout']);
      assert.match(row.note, /529/);
      assert.ok(runLines(outcome).some((l) => /stopped: .*529/.test(l)));
    } finally {
      db.close();
    }
  });
});

test('the tools on their own: cap keeps both ends, the jail follows symlinks, secrets stay out of the environment and the output', async () => {
  const capped = cap('a'.repeat(50) + 'MIDDLE' + 'b'.repeat(50), 40);
  assert.ok(capped.startsWith('a'.repeat(20)) && capped.endsWith('b'.repeat(20)) && /cut 66 characters/.test(capped), capped);

  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-jail-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 'b', CLAUDE_CODE_OAUTH_TOKEN: 'o', GITHUB_TOKEN: 't', HOME: '/h' }) };
  assert.deepEqual(Object.keys(ctx.env).sort(), ['GITHUB_TOKEN', 'HOME', 'PATH'], "the user's own tokens reach a command; Sumo's credentials never do");
  assert.equal(jailed('new/dir/file.txt', ctx), join(root, 'new/dir/file.txt'), 'a file that does not exist yet is judged by its nearest real ancestor');
  assert.throws(() => jailed('../elsewhere', ctx), /outside the project/);
  assert.throws(() => jailed('/etc/passwd', ctx), /outside the project/);

  const created = runEditor({ command: 'create', path: 'src/x.mjs', file_text: 'export const a = 1;\n' }, ctx);
  assert.equal(created.isError, false, created.content);
  assert.match(runEditor({ command: 'view', path: 'src/x.mjs' }, ctx).content, /^1\texport const a = 1;/);
  assert.match(runEditor({ command: 'create', path: 'id_rsa', file_text: 'x' }, ctx).content, /Refused/);
  assert.match(runEditor({ command: 'str_replace', path: 'src/x.mjs', old_str: 'nope', new_str: 'x' }, ctx).content, /not found/);

  const leaked = await runBash({ command: 'echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789' }, ctx);
  assert.doesNotMatch(leaked.content, /ghp_abcdefghij/, 'a credential printed by a command is redacted before the model sees it');
  assert.match((await runBash({ command: 'git reset --hard' }, ctx)).content, /Refused/);
  assert.match((await runBash({ command: 'exit 3' }, ctx)).content, /\(exit 3\)/);
  assert.deepEqual(await runBash({ command: 'echo out; echo err >&2' }, ctx), { content: 'out\nerr', isError: false }, 'both streams come back, output first');
});

test('a command leaves the process free while it runs, and stops when the user says stop', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-stop-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };
  const stop = new AbortController();
  let ticks = 0;
  const ticking = setInterval(() => ticks++, 10);
  const started = Date.now();
  const running = runBash({ command: 'echo begun; sleep 20' }, ctx, { signal: stop.signal });
  setTimeout(() => stop.abort(), 500);
  const out = await running;
  clearInterval(ticking);
  assert.ok(ticks >= 5, `timers ran while the command did (${ticks})`);
  assert.ok(Date.now() - started < 5000, 'it did not wait for the sleep');
  assert.equal(out.isError, true);
  assert.match(out.content, /^begun\n\(stopped: interrupted by the user\)$/);
});

test('an edit whose old_str is off by trailing spaces, line endings or indentation still lands — once, and said how — and a no-op edit is refused', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-edit-'));
  const ctx = { cwd: root, roots: [root] };

  // Trailing spaces the model did not copy.
  writeFileSync(join(root, 'a.js'), 'function f() {  \n  return 1;   \n}\n');
  const trimmed = runEditor({ command: 'str_replace', path: 'a.js', old_str: 'function f() {\n  return 1;\n}', new_str: 'function f() {\n  return 2;\n}' }, ctx);
  assert.equal(trimmed.isError, false, trimmed.content);
  assert.equal(trimmed.content, `edited ${join(root, 'a.js')} (old_str matched without trailing spaces)`);
  assert.equal(readFileSync(join(root, 'a.js'), 'utf8'), 'function f() {\n  return 2;\n}\n');

  // A file with Windows line endings keeps them.
  writeFileSync(join(root, 'b.txt'), 'one\r\ntwo\r\nthree\r\n');
  const crlf = runEditor({ command: 'str_replace', path: 'b.txt', old_str: 'one\ntwo', new_str: 'uno\ndos' }, ctx);
  assert.equal(crlf.isError, false, crlf.content);
  assert.match(crlf.content, /matched with the file's line endings/);
  assert.equal(readFileSync(join(root, 'b.txt'), 'utf8'), 'uno\r\ndos\r\nthree\r\n');

  // The wrong depth: the replacement is set in at the file's.
  writeFileSync(join(root, 'c.py'), 'class A:\n    def f(self):\n        return 1\n');
  const indented = runEditor({ command: 'str_replace', path: 'c.py', old_str: 'def f(self):\n    return 1', new_str: 'def f(self):\n    return 2' }, ctx);
  assert.equal(indented.isError, false, indented.content);
  assert.match(indented.content, /matched without its indentation/);
  assert.equal(readFileSync(join(root, 'c.py'), 'utf8'), 'class A:\n    def f(self):\n        return 2\n');

  // Looser is not laxer: two places that match without their spaces are still two places.
  writeFileSync(join(root, 'd.txt'), 'x = 1 \ny = 2\nx = 1\n');
  const twice = runEditor({ command: 'str_replace', path: 'd.txt', old_str: 'x = 1', new_str: 'x = 3' }, ctx);
  assert.equal(twice.isError, true);
  assert.match(twice.content, /appears 2 times/);
  assert.equal(readFileSync(join(root, 'd.txt'), 'utf8'), 'x = 1 \ny = 2\nx = 1\n', 'nothing was written');
  // An exact match is taken as before, and said plainly.
  assert.equal(runEditor({ command: 'str_replace', path: 'd.txt', old_str: 'y = 2', new_str: 'y = 3' }, ctx).content, `edited ${join(root, 'd.txt')}`);

  const same = runEditor({ command: 'str_replace', path: 'd.txt', old_str: 'y = 3', new_str: 'y = 3' }, ctx);
  assert.equal(same.isError, true);
  assert.match(same.content, /nothing would change/);
});

test('create preserves an existing file', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-editor-alias-'));
  const ctx = { cwd: root, roots: [root] };
  writeFileSync(join(root, 'existing.txt'), 'keep this\n');
  const created = runEditor({ command: 'create', path: 'existing.txt', file_text: 'replacement\n' }, ctx);
  assert.equal(created.isError, true, 'create must not overwrite a file');
  assert.equal(readFileSync(join(root, 'existing.txt'), 'utf8'), 'keep this\n');
});

test('secret-file aliases are refused by every editor command', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-editor-alias-'));
  const ctx = { cwd: root, roots: [root] };
  writeFileSync(join(root, '.env'), 'X=short\n');
  symlinkSync('.env', join(root, 'alias.txt'));
  for (const input of [
    { command: 'view' },
    { command: 'create', file_text: 'replacement\n' },
    { command: 'str_replace', old_str: 'short', new_str: 'changed' },
    { command: 'insert', insert_line: 0, insert_text: 'added\n' },
  ]) {
    const out = runEditor({ ...input, path: 'alias.txt' }, ctx);
    assert.equal(out.isError, true, input.command);
    assert.match(out.content, /Refused: .*secret file/, input.command);
    assert.doesNotMatch(out.content, /X=short/);
    assert.equal(readFileSync(join(root, '.env'), 'utf8'), 'X=short\n');
  }
});

/** Whether a process is still there. */
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const settled = async (test) => {
  for (let i = 0; i < 100 && !test(); i++) await new Promise((r) => setTimeout(r, 20));
  return test();
};

test('stopping a command stops what it started, and a child left in the background cannot hold the run open', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-tree-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };

  // The shell is still there, waiting on a child: both go.
  const stop = new AbortController();
  const waiting = runBash({ command: 'sleep 30 & echo $! > child.pid; wait' }, ctx, { signal: stop.signal });
  assert.equal(await settled(() => existsSync(join(root, 'child.pid')) && readFileSync(join(root, 'child.pid'), 'utf8').trim() !== ''), true);
  const child = Number(readFileSync(join(root, 'child.pid'), 'utf8'));
  stop.abort();
  assert.match((await waiting).content, /interrupted by the user/);
  assert.equal(await settled(() => !alive(child)), true, 'the sleep the shell started is gone too');

  // The shell has already gone and only its background child holds the output open: the shell's end is the command's end.
  let began = Date.now();
  const orphaned = await runBash({ command: 'sleep 30 & echo $! > left.pid; echo started' }, ctx, { signal: new AbortController().signal });
  assert.ok(Date.now() - began < 3000, 'the call did not wait for the background child');
  assert.deepEqual(orphaned, { content: 'started', isError: false });
  process.kill(Number(readFileSync(join(root, 'left.pid'), 'utf8')), 'SIGKILL'); // left running, as a server started with & would be

  // The same with nobody to say stop: still a success, not a command that ran past its time.
  began = Date.now();
  const late = await runBash({ command: 'sleep 4 & echo started' }, ctx, { timeoutMs: 2000 });
  assert.ok(Date.now() - began < 1500, 'it ended with the shell');
  assert.deepEqual(late, { content: 'started', isError: false });
});

test('the cache breakpoint lands on the last message that can carry one, so a turn ending on an operator message still reads its history from the cache', () => {
  const text = (t) => ({ type: 'text', text: t });
  const messages = [{ role: 'user', content: [text('the memory block')] }, { role: 'assistant', content: [text('hello')] }, { role: 'user', content: [text('fix simba')] }, { role: 'system', content: '<project simba> card' }];
  markTail(messages);
  assert.deepEqual(messages[2].content[0].cache_control, { type: 'ephemeral' }, 'the turn before the operator message carries it');
  assert.equal(messages[3].content, '<project simba> card', 'the operator message is sent as it was');

  messages.push({ role: 'assistant', content: [text('on it')] }, { role: 'user', content: [text('thanks')] });
  markTail(messages);
  const marked = () => messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control);
  assert.deepEqual(messages.at(-1).content[0].cache_control, { type: 'ephemeral' });
  assert.deepEqual(marked(), [messages[2].content[0], messages[5].content[0]], 'the tail and the tail before it: what the last turn wrote is read for certain');

  messages.push({ role: 'assistant', content: [text('welcome')] }, { role: 'user', content: [text('more')] });
  markTail(messages);
  assert.deepEqual(marked(), [messages[5].content[0], messages[7].content[0]], 'never more than two: the API takes four, and the system prompt has one');
  markTail(messages);
  assert.deepEqual(marked(), [messages[5].content[0], messages[7].content[0]], 'marking the same tail again changes nothing');
});

test('a job told something from outside its process reads it with its next request, once; a closed job cannot be told; the terminal printer says what the chat shows', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      tell(db, id, 'only the go code', NOW);
      tell(db, id, 'and say why', NOW);
      assert.deepEqual(takeInbox(id), ['only the go code', 'and say why']);
      assert.deepEqual(takeInbox(id), [], 'read once');

      tell(db, id, 'skip the tests', NOW);
      const { send, seen } = canned([
        reply('tool_use', [{ type: 'text', text: 'looking' }, call('t1', 'bash', { command: 'echo hi' })]),
        reply('end_turn', [{ type: 'text', text: 'done **looking**:\n- one\n\n| a | b |\n|---|---|\n| 1 | 2 |' }]),
        reply('end_turn', []),
      ]);
      const printed = [];
      const outcome = await runJob(db, id, { send, now: () => NOW, ...jobPrinter((t) => printed.push(t), styles(false)) });
      assert.equal(outcome.stop, 'end_turn');
      const heard = seen[1].messages.at(-1).content;
      assert.deepEqual(heard.map((b) => b.type), ['tool_result', 'text']);
      assert.match(heard[1].text, /skip the tests/);
      assert.deepEqual(readdirSync(join(paths().jobs, String(id), 'inbox')), [], 'taken off the disk');
      // What it said is drawn as the chat draws a reply, set in under its line; each call has the top of what came back under it.
      assert.deepEqual(printed, [`⏺ j${id} scout · haiku — demo job\n`, '  looking\n', '  ⏺ $ echo hi\n', '    ⎿  hi\n', '  done looking:\n    • one\n\n  ┌───┬───┐\n  │ a │ b │\n  ├───┼───┤\n  │ 1 │ 2 │\n  └───┴───┘\n']);

      db.prepare(`UPDATE jobs SET status = 'done' WHERE id = ?`).run(id);
      assert.throws(() => tell(db, id, 'too late', NOW), /is done — it cannot be told anything/);
    } finally {
      db.close();
    }
  });
});

test('a refused reply is not kept, nor any call it made before the refusal: the conversation goes on from before it', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-refused-'));
      const params = jobParams({ job: { agent: 'worker', model: 'opus', effort: 'high' }, text: 'the brief', system: 'rules' });
      const { send } = canned([reply('refusal', [{ type: 'text', text: 'Sure, first' }, call('t1', 'bash', { command: 'touch ran.txt' })])]);
      const outcome = await converse(db, params, { send, ctx: { cwd: root, roots: [root], env: childEnv() }, ledger: { kind: 'worker' }, now: () => NOW });
      assert.equal(outcome.stop, 'refusal');
      assert.equal(outcome.text, '', 'what streamed before the refusal is not an answer');
      assert.deepEqual(params.messages.map((m) => m.role), ['user'], 'neither the partial reply nor an answer to its call');
      assert.equal(existsSync(join(root, 'ran.txt')), false);
    } finally {
      db.close();
    }
  });
});

test('a command may use a secret from the shell or a .env, never sees Sumo\'s own credential, and is refused the whole environment', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-secrets-'));
  writeFileSync(join(root, '.env'), 'SMOKE_SECRET=from-the-file\n');
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH, SMOKE_TOKEN: 'from-the-shell', ANTHROPIC_API_KEY: 'sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }) };
  assert.equal((await runBash({ command: 'echo "${SMOKE_TOKEN:-unset}"' }, ctx)).content, 'from-the-shell', 'a token the user exported is there for a probe');
  assert.equal((await runBash({ command: 'set -a; source .env; set +a; echo "${SMOKE_SECRET:-unset}"' }, ctx)).content, 'from-the-file', 'a .env is loaded, not printed');
  assert.equal((await runBash({ command: 'echo "${ANTHROPIC_API_KEY:-unset}"' }, ctx)).content, 'unset');
  assert.match((await runBash({ command: 'env | sort' }, ctx)).content, /^Refused: .*whole environment/);
  assert.match((await runBash({ command: 'cat .env' }, ctx)).content, /^Refused: .*secret file/);
});

test('a password inside a URL a command prints does not reach the model, though the variable holding it is not named like a secret', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-url-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH, DATABASE_URL: 'postgres://app:Hunter2pass@db/app' }) };
  assert.equal((await runBash({ command: 'echo "$DATABASE_URL"' }, ctx)).content, 'postgres://app:[redacted]@db/app');
});

test('a conversation that never stops calling tools ends at the turn limit, and the run says so', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      let calls = 0;
      const seen = [];
      // Each command is new, so this is a run that goes on and on, not one going round in a circle.
      const send = async (params) => {
        seen.push(structuredClone(params.messages.at(-1)));
        return reply('tool_use', [call(`t${++calls}`, 'bash', { command: `echo ${calls}` })]);
      };
      const outcome = await runJob(db, id, { send, now: () => NOW });
      assert.equal(outcome.turns, 150);
      assert.equal(outcome.stop, 'max_turns');
      assert.ok(runLines(outcome).includes('stopped: 150 turns without closing the job'));
      // The request before the last carried the warning, and no other did.
      assert.match(seen[149].content.at(-1).text, /^This is the last request of this run/);
      assert.equal(seen.filter((m) => m.content.some((b) => b.type === 'text' && /last request of this run/.test(b.text))).length, 1);
    } finally {
      db.close();
    }
  });
});

test('a request the API or the connection let down is sent again, with a wait that grows, said to whoever watches, and written to the ledger; one the request itself got wrong is not', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-retry-'));
      const ctx = { cwd: root, roots: [root], env: childEnv() };
      const headers = (extra = {}) => new Headers({ 'request-id': 'req_1', ...extra });
      const overloaded = () => Anthropic.APIError.generate(529, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, headers());
      // What the API sends down a stream that is already open: no status, only the type of what went wrong.
      const midStream = () => new Anthropic.APIError(undefined, { type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }, undefined, undefined, 'overloaded_error');
      const dropped = () => new Anthropic.APIConnectionError({ message: 'Connection error.' });
      const refused = () => Anthropic.APIError.generate(400, { type: 'error', error: { type: 'invalid_request_error', message: 'messages: too long' } }, undefined, headers());

      for (const [cause, verdict] of [[overloaded(), true], [midStream(), true], [dropped(), true], [refused(), false], [new Anthropic.APIUserAbortError(), false], [new Error('the API answered 529: overloaded'), false]]) {
        assert.equal(retryable(cause), verdict, cause.message);
      }
      // The wait: what the API asked for when it said, else doubling from the base under the cap, with some jitter.
      assert.equal(retryDelay(Anthropic.APIError.generate(429, { type: 'error', error: { type: 'rate_limit_error', message: 'slow down' } }, undefined, headers({ 'retry-after-ms': '1500' })), 1, RETRY), 1500);
      assert.equal(retryDelay(Anthropic.APIError.generate(429, {}, undefined, headers({ 'retry-after': '2' })), 1, RETRY), 2000);
      assert.equal(retryDelay(overloaded(), 1, RETRY, () => 0.5), 1000);
      assert.equal(retryDelay(overloaded(), 3, RETRY, () => 0.5), 4000);
      assert.equal(retryDelay(overloaded(), 9, RETRY, () => 0.5), 30_000, 'under the cap');
      assert.equal(retryDelay(overloaded(), 2, RETRY, () => 0), 1500, 'a quarter under');
      assert.equal(retryDelay(overloaded(), 2, RETRY, () => 1), 2500, 'a quarter over');

      // Two failures, then an answer: one turn, three requests, the two tries written down and said.
      const failures = [overloaded(), midStream()];
      let sends = 0;
      const send = async () => {
        sends++;
        if (failures.length > 0) throw failures.shift();
        return reply('end_turn', [{ type: 'text', text: 'made it' }]);
      };
      const retries = [];
      const params = jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' });
      const outcome = await converse(db, params, { send, ctx, ledger: { kind: 'scout' }, now: () => NOW, retry: { limit: 6, baseMs: 1, capMs: 2 }, onRetry: (r) => retries.push(r) });
      assert.equal(outcome.stop, 'end_turn');
      assert.equal(outcome.text, 'made it');
      assert.equal(outcome.turns, 1);
      assert.equal(sends, 3);
      assert.deepEqual(retries.map((r) => [r.attempt, r.limit]), [[1, 6], [2, 6]]);
      assert.equal(retries[0].reason, '529 overloaded_error Overloaded', "the API's own words, not the JSON they came in");
      assert.equal(retries[1].reason, 'overloaded_error Overloaded');
      const notes = db.prepare('SELECT ok, note FROM model_runs ORDER BY id').all();
      assert.deepEqual(notes.map((r) => r.ok), [0, 0, 1]);
      assert.match(notes[0].note, /^turn 1: try 1 of 6 again in \d+ ms — 529 overloaded_error Overloaded$/);
      assert.match(notes[1].note, /^turn 1: try 2 of 6 again in \d+ ms — overloaded_error Overloaded$/);
      assert.equal(params.messages.length, 2, 'nothing of a failed try is kept');

      // Out of tries: the error, as before. A request the API refused is not tried again at all.
      const spent = await converse(db, jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' }), { send: async () => { throw overloaded(); }, ctx, ledger: { kind: 'scout' }, now: () => NOW, retry: { limit: 2, baseMs: 1, capMs: 1 } });
      assert.deepEqual([spent.stop, spent.status], ['error', 529]);
      let asked = 0;
      const bad = await converse(db, jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' }), { send: async () => { asked++; throw refused(); }, ctx, ledger: { kind: 'scout' }, now: () => NOW, retry: { limit: 6, baseMs: 1, capMs: 1 } });
      assert.deepEqual([bad.stop, bad.status, asked], ['error', 400, 1]);

      // Esc while waiting for the next try ends the turn then and there.
      const stop = new AbortController();
      let tries = 0;
      const waiting = converse(db, jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' }), { send: async () => { tries++; throw overloaded(); }, ctx, ledger: { kind: 'scout' }, now: () => NOW, signal: stop.signal, retry: { limit: 6, baseMs: 60_000, capMs: 60_000 } });
      setTimeout(() => stop.abort(), 50);
      assert.equal((await waiting).stop, 'interrupted');
      assert.equal(tries, 1);
    } finally {
      db.close();
    }
  });
});

test('the API pausing a turn of its own accord is not the end of it; the ledger names the model that answered; a call made over and over with the same answer is said and then stopped', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-pause-'));
      const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };
      const params = jobParams({ job: { agent: 'scout', model: 'opus', effort: 'high' }, text: 'look', system: 'rules' });
      assert.deepEqual(params.thinking, { type: 'adaptive', display: 'summarized' }, 'every model but haiku is asked to say what it thinks');
      assert.equal('thinking' in jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' }), false);

      const { send, seen } = canned([
        { ...reply('pause_turn', [{ type: 'text', text: 'half way' }]), model: 'claude-opus-4-8' },
        reply('end_turn', [{ type: 'text', text: 'there' }]),
      ]);
      const outcome = await converse(db, params, { send, ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(outcome.stop, 'end_turn');
      assert.equal(seen.length, 2);
      assert.deepEqual(seen[1].messages.map((m) => m.role), ['user', 'assistant'], 'the paused reply goes back as it came, and the turn goes on');
      assert.deepEqual(db.prepare('SELECT model FROM model_runs ORDER BY id').all().map((r) => r.model), ['claude-opus-4-8', 'claude-opus-5-5'], 'the model that answered, not only the one asked');

      let n = 0;
      const same = async () => reply('tool_use', [call(`t${++n}`, 'bash', { command: 'echo same' })]);
      const circling = jobParams({ job: { agent: 'scout', model: 'opus', effort: 'high' }, text: 'look', system: 'rules' });
      const looped = await converse(db, circling, { send: same, ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(looped.stop, 'loop');
      assert.equal(looped.turns, 5);
      const answers = circling.messages.filter((m) => m.role === 'user').slice(1).map((m) => m.content[0].content);
      assert.deepEqual(answers.slice(0, 2), ['same', 'same']);
      assert.match(answers[2], /^same\n\[sumo: this is the same call with the same answer, 3 times in a row/);
      assert.match(answers[3], /4 times in a row/);
      assert.equal(answers[4], 'same', 'the fifth is answered and the run stops');
      assert.equal(stopReason('loop'), 'stopped: the same call was made 5 times with the same answer');
    } finally {
      db.close();
    }
  });
});

test('a job that outgrows the context is summarized server-side at the end of a tool round and goes on from the summary; a summary that cannot be had costs the run nothing', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'opus', effort: 'high' });
      const big = { input_tokens: 160_000, output_tokens: 100 };
      const summary = { stop_reason: 'compaction', content: [{ type: 'compaction', content: 'what happened so far', encrypted_content: 'opaque', signature: 'sig' }], usage: { input_tokens: 160_000, output_tokens: 600 } };
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: 'echo one' })], big),
        summary,
        reply('tool_use', [call('t2', 'bash', { command: 'echo two' })], big),
        // Too big again at once: not summarized again this soon.
        reply('tool_use', [call('t3', 'bash', { command: 'echo three' })], big),
        reply('end_turn', [{ type: 'text', text: 'closed' }]),
        reply('end_turn', []),
      ]);
      const compacted = [];
      const outcome = await runJob(db, id, { send, now: () => NOW, onCompact: (c) => compacted.push(c) });
      assert.equal(outcome.stop, 'end_turn');

      // The compaction request: the same conversation, the context edits and the answer's own settings left off, the summary asked for.
      const asked = seen[1];
      assert.deepEqual(asked.compaction, { type: 'summarize', instructions: asked.compaction.instructions });
      assert.match(asked.compaction.instructions, /^Write a hand-off for a model/);
      assert.equal('context_management' in asked, false, 'the API takes context edits or a compaction, not both');
      assert.ok(asked.betas.includes('compact-2026-09-04'));
      assert.equal(asked.messages.length, 3, 'the brief, the call, its result: the whole round, then the summary');
      assert.deepEqual(asked.messages.at(-1).content.map((b) => b.type), ['tool_result']);

      // What follows: the summary first, as it came, then a line that says to carry on — and the brief is on disk for the rest.
      const next = seen[2];
      assert.deepEqual(next.messages.map((m) => m.role), ['assistant', 'user']);
      assert.deepEqual(next.messages[0].content.map(({ cache_control: _c, ...b }) => b), summary.content);
      assert.match(next.messages[1].content[0].text, new RegExp(`^The conversation before this point was summarized above[\\s\\S]*sumo job brief ${id}$`));
      assert.ok('context_management' in next, 'the context edits are back for the answers');
      assert.equal('compaction' in next, false);
      assert.deepEqual(compacted.map((c) => [c.turns, c.before, c.summary]), [[1, 160_100, 'what happened so far']]);
      assert.equal(seen.length, 6, 'and not summarized again within three turns of the last');
      assert.equal(seen[4].messages.length, 6, 'the turns since the summary ride on it');

      const rows = db.prepare('SELECT ok, note, output_tokens FROM model_runs ORDER BY id').all();
      assert.deepEqual([rows[1].ok, rows[1].note, rows[1].output_tokens], [1, 'turn 1 compaction', 600], 'the summary has a ledger row of its own');

      // A summary that does not come: the run goes on as it was, and the ledger says why.
      const other = Number(
        db.prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('demo', 'again', 'scout', 'running', 's1', ?, ?, 'opus', 'high', 'test')`).run(NOW, NOW).lastInsertRowid,
      );
      mkdirSync(join(paths().jobs, String(other)), { recursive: true });
      writeFileSync(join(paths().jobs, String(other), 'brief.md'), `# Job j${other} — again\n\n## The task\nlook again\n`);
      const failing = canned([
        reply('tool_use', [call('t1', 'bash', { command: 'echo one' })], big),
        null, // the compaction request throws
        reply('end_turn', [{ type: 'text', text: 'done' }]),
        reply('end_turn', []),
      ]);
      const sendOrThrow = async (params, options) => {
        const answer = await failing.send(params, options);
        if (answer === null) throw new Error('529 overloaded');
        return answer;
      };
      const went = await runJob(db, other, { send: sendOrThrow, now: () => NOW });
      assert.equal(went.stop, 'end_turn');
      assert.equal(failing.seen[2].messages.length, 3, 'the conversation as it was');
      assert.match(db.prepare('SELECT note FROM model_runs WHERE ok = 0 ORDER BY id DESC LIMIT 1').get().note, /^turn 1 compaction: 529 overloaded/);
    } finally {
      db.close();
    }
  });
});

test('output too long to show is kept whole where the model can read a range of it, without its secrets, and the cut names the file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-spill-'));
  const spillDir = join(root, 'out');
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }), spill: spillDir };
  const out = await runBash({ command: `printf 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789\\n'; for i in $(seq 1 2000); do echo "line $i of the output"; done` }, ctx);
  const named = /are in (\S+): read a range of it/.exec(out.content);
  assert.ok(named, out.content.slice(0, 400));
  const [, file] = named;
  assert.ok(file.startsWith(`${spillDir}/`));
  const saved = readFileSync(file, 'utf8');
  assert.match(saved, /^token \[redacted\]\nline 1 of the output\n/, 'the whole output, the secret taken out');
  assert.match(saved, /\nline 2000 of the output$/);
  assert.doesNotMatch(saved, /ghp_abc/);
  assert.equal(readdirSync(spillDir).length, 1);

  // Short output goes nowhere; a cut with nowhere to go says only how to narrow the command.
  await runBash({ command: 'echo short' }, ctx);
  assert.equal(readdirSync(spillDir).length, 1);
  const unkept = await runBash({ command: 'for i in $(seq 1 2000); do echo "line $i of the output"; done' }, { ...ctx, spill: undefined });
  assert.match(unkept.content, /\[cut \d+ characters from the middle — narrow the command/);
});

test('a view is capped like a command, and never has a hole in it: the window ends at a whole line, and only one enormous line is cut', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-view-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({}) };

  // A file as long as source files are: more than fits, so the window stops early, at the end of a line, and says where.
  const source = Array.from({ length: 500 }, (_, i) => `const value${i + 1} = compute(input${i + 1}, options);  // line ${i + 1}`);
  writeFileSync(join(root, 'source.mjs'), source.join('\n'));
  const first = runEditor({ command: 'view', path: 'source.mjs' }, ctx).content;
  assert.ok(first.length < 17_000, `${first.length} characters came back`);
  assert.doesNotMatch(first, /cut \d+ characters/, 'nothing is taken out of the middle');
  const shown = first.split('\n').filter((l) => /^\d+\t/.test(l));
  assert.deepEqual(shown, source.slice(0, shown.length).map((l, i) => `${i + 1}\t${l}`), 'whole lines, in order, from the first');
  assert.ok(shown.length > 100 && shown.length < 400);
  assert.ok(first.endsWith(`\n[${500 - shown.length} more lines up to 500 — view a smaller range]`));
  const next = runEditor({ command: 'view', path: 'source.mjs', view_range: [shown.length + 1, 500] }, ctx).content;
  assert.ok(next.startsWith(`${shown.length + 1}\t${source[shown.length]}\n`), 'the next view carries on where this one stopped');

  // One enormous line is the case a line count cannot bound: it is cut in its middle, and the rest is left for a range.
  writeFileSync(join(root, 'bundle.min.js'), `${'x'.repeat(200_000)}\nlast line\n`);
  const bundle = runEditor({ command: 'view', path: 'bundle.min.js' }, ctx).content;
  assert.ok(bundle.length < 17_000, `${bundle.length} characters came back`);
  assert.match(bundle, /^1\tx+\n\[cut \d+ characters from the middle/);
  assert.ok(bundle.endsWith('\n[2 more lines up to 3 — view a smaller range]'));

  // Short lines are bounded by the line count, as before.
  writeFileSync(join(root, 'long.txt'), Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join('\n'));
  assert.match(runEditor({ command: 'view', path: 'long.txt' }, ctx).content, /^1\tline 1\n[\s\S]*\n400\tline 400\n\[100 more lines up to 500 — view a smaller range\]$/);

  // A binary is not pages of nonsense: it is said to be one.
  writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0x0d, 0x49, 0x48, 0x44, 0x52]));
  const binary = runEditor({ command: 'view', path: 'blob.bin' }, ctx);
  assert.equal(binary.isError, true);
  assert.match(binary.content, /is a binary file \(12 bytes\) — not shown/);
});

test('nothing told to a job is lost for arriving while the job takes what came before; a file that is not a message is passed over', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      const said = 1500;
      // Another process tells the job things as fast as it can, the way `sumo job tell` does, while this one keeps taking them.
      const teller = `
        const { openDb } = await import(${JSON.stringify(new URL('../src/db.mjs', import.meta.url).href)});
        const { tell } = await import(${JSON.stringify(new URL('../src/jobs.mjs', import.meta.url).href)});
        const db = openDb();
        for (let i = 0; i < ${said}; i++) tell(db, ${id}, 'm' + i);
        db.close();`;
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', teller], { env: process.env, stdio: 'ignore' });
      const over = new Promise((resolve) => child.on('close', resolve));
      let told = false;
      over.then(() => (told = true));
      const heard = [];
      while (!told) {
        heard.push(...takeInbox(id));
        await new Promise((r) => setImmediate(r));
      }
      assert.equal(await over, 0);
      heard.push(...takeInbox(id));
      assert.deepEqual(heard.map((m) => Number(m.slice(1))).sort((a, b) => a - b), Array.from({ length: said }, (_, i) => i), 'every message, exactly once');

      // A file somebody left there by hand must not take the run down with it, and nothing stays behind once it is taken.
      const inbox = join(paths().jobs, String(id), 'inbox');
      tell(db, id, 'before');
      writeFileSync(join(inbox, 'by-hand.json'), 'not json');
      tell(db, id, 'after');
      assert.deepEqual(takeInbox(id), ['before', 'after'], 'in the order they were said');
      assert.deepEqual(readdirSync(inbox), []);
    } finally {
      db.close();
    }
  });
});

test('a command that cannot start says why, and an insert at a line that is not a number is refused instead of landing at the top', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-tools-'));
  const started = await runBash({ command: 'echo hi' }, { cwd: join(root, 'removed'), roots: [root], env: childEnv({ PATH: process.env.PATH }) });
  assert.equal(started.isError, true);
  assert.match(started.content, /^the command could not be started: .*removed does not exist$/);

  const ctx = { cwd: root, roots: [root], env: childEnv({}) };
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\n');
  const refused = runEditor({ command: 'insert', path: 'a.txt', insert_line: 'end', insert_text: 'X' }, ctx);
  assert.equal(refused.isError, true);
  assert.match(refused.content, /insert_line/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\ntwo\n', 'nothing was written');
  // The tool sends the text as insert_text, one line with its newline; without it there is nothing to insert.
  assert.equal(runEditor({ command: 'insert', path: 'a.txt', insert_line: 1, insert_text: 'X\n' }, ctx).isError, false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\nX\ntwo\n');
  const empty = runEditor({ command: 'insert', path: 'a.txt', insert_line: 1 }, ctx);
  assert.equal(empty.isError, true);
  assert.match(empty.content, /insert_text/);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\nX\ntwo\n', 'and no blank line is written in its place');
  // Past the last line is the end of the file: the newline it ended on is not a line of its own.
  assert.equal(runEditor({ command: 'insert', path: 'a.txt', insert_line: 99, insert_text: 'end\n' }, ctx).isError, false);
  assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\nX\ntwo\nend\n');
  const noOld = runEditor({ command: 'str_replace', path: 'a.txt', new_str: 'Y' }, ctx);
  assert.equal(noOld.isError, true);
  assert.match(noOld.content, /needs old_str/);
});

test('a job\'s commands meet the workflow gate as the chat\'s do: held once with the steps, and the job\'s own project counts', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'worker', model: 'sonnet', effort: 'medium' });
      add(db, { type: 'procedure', title: 'Creating a PR', cue: 'create a PR', gate: 'gh(-axi)? pr create', body: '1. run every check locally\n2. only then open the PR\n', project: 'demo', now: NOW });
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: 'gh pr create --fill' })]),
        reply('tool_use', [call('t2', 'bash', { command: 'echo gh pr create --fill' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }]),
        reply('end_turn', []),
      ]);
      await runJob(db, id, { send, now: () => NOW });
      const held = seen[1].messages.at(-1).content[0];
      assert.equal(held.is_error, true);
      assert.match(held.content, /^Not yet\. The user taught a workflow for exactly this[\s\S]*<workflow m\d+ "Creating a PR">/);
      assert.equal(seen[2].messages.at(-1).content[0].content, 'gh pr create --fill', 'once the steps have been shown, the command goes through');
    } finally {
      db.close();
    }
  });
});

test('the jail holds for a path that climbs out through a directory not made yet, and for a link that points outside to nothing', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-jail-'));
  const outside = mkdtempSync(join(tmpdir(), 'sumo-agents-outside-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({}) };

  // Written out by hand: join() would tidy the .. away before the jail ever saw it.
  const climbing = `${root}/not-yet/../../${outside.split('/').pop()}/escaped.txt`;
  const written = runEditor({ command: 'create', path: climbing, file_text: 'x' }, ctx);
  assert.equal(written.isError, true, written.content);
  assert.match(written.content, /outside the project/);
  assert.equal(existsSync(join(outside, 'escaped.txt')), false);
  assert.equal(existsSync(join(root, 'not-yet')), false, 'and nothing is made on the way');

  symlinkSync(join(outside, 'target.txt'), join(root, 'dangling'));
  const through = runEditor({ command: 'create', path: 'dangling', file_text: 'x' }, ctx);
  assert.equal(through.isError, true, through.content);
  assert.match(through.content, /outside the project/);
  assert.equal(existsSync(join(outside, 'target.txt')), false);
});

test('a secret is redacted before the output is cut, so a key the cut splits does not reach the model in halves', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cutkey-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };
  // Placed so the cut falls inside the key: its first line goes with the middle, the rest is kept with the tail.
  // Real key lines carry slashes, which keep each piece too short to look like a token on its own.
  const body = Array.from({ length: 48 }, () => 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASC/BKcwggSjAgEAAoIBAQC7+x/y9Zab3cd4ef5').join('\n');
  writeFileSync(join(root, 'key.txt'), `${'.'.repeat(8500)}\n-----BEGIN PRIVATE KEY-----\n${body}\n-----END PRIVATE KEY-----\n${'.'.repeat(5500)}\n`);
  const out = await runBash({ command: 'cat key.txt' }, ctx);
  assert.match(out.content, /\[redacted\]/);
  assert.doesNotMatch(out.content, /MIIEvQIBADANBgkqhkiG9w0|BKcwggSjAgEAAoIBAQC7/);
});

test('output full of hidden characters stays within the cap once each is shown as a marker', () => {
  const out = capRedacted('\x01'.repeat(16_000));
  assert.ok(out.length < 16_500, `${out.length} characters`);
  assert.match(out, /⟨U\+0001⟩/);
});

test('a command stopped for printing too much says so, and how to ask for less', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-flood-'));
  const out = await runBash({ command: "head -c 70000000 /dev/zero | tr '\\0' x" }, { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) });
  assert.equal(out.isError, true);
  assert.match(out.content, /\(stopped: it printed more than 64 MB — narrow the command: tail, grep, or a line range\)$/);
});

test('one job is run by one run at a time; a lock left by a run that died does not hold the next', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      const lock = join(paths().jobs, String(id), 'run.lock');
      writeFileSync(lock, String(process.pid));
      await assert.rejects(runJob(db, id, { send: async () => assert.fail('a second run must not start'), now: () => NOW }), new RegExp(`j${id} is already being run \\(process ${process.pid}\\)`));

      writeFileSync(lock, '999999');
      const outcome = await runJob(db, id, { send: async () => reply('end_turn', [{ type: 'text', text: 'looked' }]), now: () => NOW });
      assert.equal(outcome.stop, 'end_turn');
      assert.equal(existsSync(lock), false, 'and the run lets go of it when it ends');
    } finally {
      db.close();
    }
  });
});

test('a failing start observer releases the job lock so the job can be run again', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      await assert.rejects(runJob(db, id, {
        onStart: () => { throw new Error('screen failed'); },
        send: async () => assert.fail('no request should run'),
      }), /screen failed/);
      assert.equal(existsSync(join(paths().jobs, String(id), 'run.lock')), false);
      const outcome = await runJob(db, id, { send: async () => reply('end_turn', [{ type: 'text', text: 'done' }]) });
      assert.equal(outcome.stop, 'end_turn');
    } finally {
      db.close();
    }
  });
});

test('a command past its time limit takes everything it started with it, also when nobody holds a stop signal, and so does this process going', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-group-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };
  const late = await runBash({ command: 'sleep 30 & echo $! > child.pid; wait' }, ctx, { timeoutMs: 400 });
  assert.match(late.content, /\(stopped: it ran past /);
  assert.equal(await settled(() => !alive(Number(readFileSync(join(root, 'child.pid'), 'utf8')))), true, 'the sleep the shell started is gone');

  // A process running a command is told to go (a terminal closed, a kill): the command does not outlive it.
  const host = `
    const { runCommand } = await import(${JSON.stringify(new URL('../src/tools.mjs', import.meta.url).href)});
    runCommand('sleep 30 & echo $! > host.pid; wait', { cwd: ${JSON.stringify(root)}, env: process.env, signal: new AbortController().signal });
    setTimeout(() => {}, 30_000);`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', host], { stdio: 'ignore' });
  assert.equal(await settled(() => existsSync(join(root, 'host.pid')) && readFileSync(join(root, 'host.pid'), 'utf8').trim() !== ''), true);
  const sleeper = Number(readFileSync(join(root, 'host.pid'), 'utf8'));
  child.kill('SIGTERM');
  await new Promise((r) => child.on('close', r));
  assert.equal(await settled(() => !alive(sleeper)), true, 'the command went with the process that ran it');
});

test('bash is bash, and asking it to restart is answered: every call is a fresh shell, so there is nothing to carry over', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-bash-'));
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) };
  assert.deepEqual(await runBash({ command: '[[ 1 -lt 2 ]] && echo bash syntax works' }, ctx), { content: 'bash syntax works', isError: false });
  assert.deepEqual(await runBash({ restart: true }, ctx), { content: 'Bash session restarted: every command already runs in a fresh shell, in the project directory', isError: false });
});

test('the commands that run the project\'s checks are not cut off by the time limit of one command, since each check keeps its own', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-checks-'));
  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'sumo'), '#!/bin/sh\nsleep 1\necho "j1 would be accepted as DONE"\n', { mode: 0o755 });
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: `${bin}:${process.env.PATH}` }) };
  assert.deepEqual(await runBash({ command: 'sumo job verify 1' }, ctx, { timeoutMs: 300 }), { content: 'j1 would be accepted as DONE', isError: false });
  assert.match((await runBash({ command: 'sleep 1; echo done' }, ctx, { timeoutMs: 300 })).content, /\(stopped: it ran past /, 'anything else keeps the limit');
});

test('a job\'s shell never sees the credential, checked with one actually in the environment', async () => {
  await withHome(freshHome(), { ANTHROPIC_API_KEY: 'sk-ant-api03-not-a-real-key', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-not-a-real-token' }, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      const { send, seen } = canned([reply('tool_use', [call('t1', 'bash', { command: 'echo "PATH=$PATH"; echo "key=${ANTHROPIC_API_KEY:-unset} oauth=${CLAUDE_CODE_OAUTH_TOKEN:-unset}"' })]), reply('end_turn', [{ type: 'text', text: 'done' }]), reply('end_turn', [])]);
      await runJob(db, id, { send, now: () => NOW });
      const env = seen[1].messages.at(-1).content[0].content;
      assert.match(env, /^PATH=/m, 'the command ran with an environment');
      assert.match(env, /key=unset oauth=unset/, 'without the credential');
      assert.doesNotMatch(env, /not-a-real/);
    } finally {
      db.close();
    }
  });
});

test('a job closes, notes and reads memory with tools of its own: each runs the sumo command a person would, in a process of its own', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });
      add(db, { type: 'gotcha', body: 'The briefing cron runs in UTC, not local time', project: 'demo', now: NOW });
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'search_memory', { query: 'briefing cron' }), call('t2', 'note', { text: "found the cron; next: it's timezone" })]),
        reply('tool_use', [call('t3', 'finish', { status: 'DONE' }), call('t4', 'finish', { status: 'DONE', report: "## Summary\nthe cron's in UTC\n## Learned\nnone" })]),
        reply('end_turn', [{ type: 'text', text: 'closed' }]),
      ]);
      const outcome = await runJob(db, id, { send, now: () => NOW });

      const [found, noted] = seen[1].messages.at(-1).content;
      assert.match(found.content, /briefing cron runs in UTC/);
      assert.equal(noted.is_error, false, noted.content);
      assert.match(readFileSync(join(paths().jobs, String(id), 'notes.md'), 'utf8'), /found the cron; next: it's timezone/, 'the words reach the job as written, quotes and all');
      const [incomplete, closed] = seen[2].messages.at(-1).content;
      assert.equal(incomplete.is_error, true);
      assert.match(incomplete.content, /finish is missing what it needs: \["status","report"\]/);
      assert.equal(closed.is_error, false, closed.content);
      assert.equal(outcome.job.status, 'done');
      assert.equal(seen.length, 3, 'a job that closed itself is not told to close it');
      assert.match(readFileSync(join(paths().jobs, String(id), 'report.md'), 'utf8'), /the cron's in UTC/);
      assert.deepEqual(readdirSync(join(paths().jobs, String(id))).filter((f) => f.startsWith('.')), [], 'nothing the tools wrote is left behind');
    } finally {
      db.close();
    }
  });
});

test('a worker cannot take its own work unverified: the finish tool has no way to; the command is held as written, and finish refuses it under the job\'s marker however it was spelled', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      const params = jobParams({ job: { agent: 'worker', model: 'sonnet', effort: 'medium' }, text: 'x', system: 'rules' });
      assert.deepEqual(Object.keys(params.tools.find((t) => t.name === 'finish').input_schema.properties), ['status', 'report']);
      const { send, seen } = canned([
        reply('tool_use', [
          call('t0', 'bash', { command: `sumo job finish ${id} --status DONE --accept "trust me" <<'EOF'\n## Summary\nok\nEOF` }),
          call('t00', 'bash', { command: `env -i PATH="$PATH" -u SUMO_JOB sumo job finish ${id} --status DONE` }),
          call('t01', 'bash', { command: 'echo reading about SUMO_JOB is fine' }),
          // Spelled so the pattern over the command text does not see it: the shell joins the quotes and expands the variable.
          call('t1', 'bash', { command: `F=--acc""ept; '${process.execPath}' --disable-warning=ExperimentalWarning '${ENTRY}' job finish ${id} --status DONE $F "trust me" <<'EOF'\n## Summary\nok\nEOF` }),
          call('t2', 'finish', { status: 'DONE', report: '## Summary\nok', accept: 'trust me' }),
        ]),
        reply('end_turn', []),
        reply('end_turn', []),
      ]);
      await runJob(db, id, { send, now: () => NOW });
      const [plain, unmarked, reading, viaShell, viaTool] = seen[1].messages.at(-1).content;
      assert.equal(reading.content, 'reading about SUMO_JOB is fine', 'a command that only names the marker runs');
      for (const written of [plain, unmarked]) {
        assert.equal(written.is_error, true);
        assert.match(written.content, /^Refused: work is never taken unverified on its author's word/, 'the command as written is held first');
      }
      assert.equal(viaShell.is_error, true);
      assert.match(viaShell.content, new RegExp(`Refused: j${id} runs this command, and work is never taken unverified on its author's word`));
      // The accept the model slipped in is not passed on: DONE has to be verified, this job cannot be, so it stays open.
      assert.equal(viaTool.is_error, true);
      assert.match(viaTool.content, /cannot be verified/);
      assert.equal(getJob(db, id).status, 'running');
      assert.equal(existsSync(join(paths().jobs, String(id), 'report.md')), false);
    } finally {
      db.close();
    }
  });
});

test('a job routed to a model that is off is refused before anything is sent', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { model: 'fable', effort: 'high' });
      setModel(db, 'fable', false, NOW);
      await assert.rejects(
        runJob(db, id, { send: () => assert.fail('nothing is sent'), now: () => NOW }),
        (err) => err instanceof UsageError && err.message === `j${id} is routed to fable, which is off — sumo models enable fable, or abandon it and create it again`,
      );
    } finally {
      db.close();
    }
  });
});

test('reading code that names the job marker or the accept flag is reading; setting or using them is not', async () => {
  const { grantsItself } = await import('../src/loop.mjs');
  for (const command of [
    'grep -rn "SUMO_JOB=" src',
    'rg "job finish" -n src && grep -n -- --accept src/cli.mjs',
    'echo reading about SUMO_JOB is fine',
    'sed -n 70,80p src/loop.mjs | grep SUMO_JOB',
    'grep -c "SUMO_JOB=" src/loop.mjs',
    'sudo apt-get install -y jq',
    'if [ -z "$SUMO_JOB" ]; then echo outside; fi',
    'bash -c "npm test"',
  ]) assert.equal(grantsItself(command), false, command);
  for (const command of [
    'sumo job finish 3 --status DONE --accept "trust me"',
    'sumo job finish 3 --status DONE \\\n  --accept "trust me"',
    'SUMO_JOB= sumo job finish 3 --status DONE $F',
    'X=1 SUMO_JOB= sumo job finish 3 --status DONE $F',
    'cd /p && SUMO_JOB= sumo job finish 3',
    'export SUMO_JOB=',
    'env SUMO_JOB= sumo job finish 3',
    'unset SUMO_JOB; sumo job finish 3 $F',
    'env -i PATH="$PATH" -u SUMO_JOB sumo job finish 3 --status DONE',
    'env -u "SUMO_JOB" sumo job finish 3',
    'if SUMO_JOB= sumo job answer 3 hi; then :; fi',
    '{ SUMO_JOB= sumo job answer 3 hi; }',
    'true && { SUMO_JOB= sumo job tell 3; }',
    '! SUMO_JOB= sumo job tell 3',
    'time SUMO_JOB= sumo job tell 3',
    'for i in 1; do SUMO_JOB= sumo job tell 3; done',
    'sudo SUMO_JOB= sumo job tell 3',
    'A="x y" SUMO_JOB= sumo job tell 3',
    "A='x y' SUMO_JOB= sumo job tell 3",
    'eval "SUMO_JOB= sumo job tell 3"',
    'bash -c "SUMO_JOB= sumo job tell 3"',
    "sh -c 'SUMO_JOB= sumo job tell 3'",
    'unset -v SUMO_JOB; sumo job tell 3',
    'unset FOO SUMO_JOB; sumo job tell 3',
    'export -n SUMO_JOB; sumo job tell 3',
    'declare +x SUMO_JOB; sumo job tell 3',
    'env --unset=SUMO_JOB sumo job tell 3',
    'sudo -E SUMO_JOB= sumo job tell 3',
    'sudo -u root SUMO_JOB= sumo job tell 3',
    'sudo -u root -E SUMO_JOB=1 sumo job tell 3',
  ]) assert.equal(grantsItself(command), true, command);
});

test('a job created where no session had begun meets the workflow gate all the same', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'worker', model: 'sonnet', effort: 'medium' });
      db.prepare('UPDATE jobs SET session_id = NULL WHERE id = ?').run(id);
      add(db, { type: 'procedure', title: 'Creating a PR', cue: 'create a PR', gate: 'gh(-axi)? pr create', body: '1. run every check locally\n2. only then open the PR\n', project: 'demo', now: NOW });
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: 'echo gh pr create --fill' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }]),
        reply('end_turn', []),
      ]);
      await runJob(db, id, { send, now: () => NOW });
      const held = seen[1].messages.at(-1).content[0];
      assert.equal(held.is_error, true, held.content);
      assert.match(held.content, /^Not yet\. The user taught a workflow for exactly this/);
    } finally {
      db.close();
    }
  });
});

test('a job gets the MCP tools too, deferred behind tool search and named in its prompt; a call not on the allow list is refused when nobody can be asked, and asked about — with the job named — when somebody can', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      mkdirSync(paths().home, { recursive: true, mode: 0o700 });
      writeConfig({ mcpServers: { demo: { command: process.execPath, args: [join(REPO_ROOT, 'test', 'fixtures', 'fake-mcp-server.mjs')] } } });
      const { id } = seed(db, { agent: 'scout', model: 'haiku', effort: 'none' });

      // Run from a terminal: nobody is there to ask, and the refusal says how the user allows it.
      const alone = canned([
        reply('tool_use', [call('t1', 'mcp__demo__echo', { text: 'hi' })]),
        reply('end_turn', [{ type: 'text', text: 'could not' }]),
        reply('end_turn', []),
      ]);
      await runJob(db, id, { send: alone.send, now: () => NOW });
      const request = alone.seen[0];
      assert.deepEqual(request.tools.map((t) => t.name).slice(0, 6), ['bash', 'note', 'ask', 'search_memory', 'finish', 'tool_search_tool_regex'], 'the role\'s tools first, then the search tool');
      const deferred = request.tools.slice(6);
      assert.equal(deferred.length, 9);
      assert.ok(deferred.every((t) => t.defer_loading === true && t.name.startsWith('mcp__demo__')), 'every MCP tool is deferred');
      assert.match(request.system[0].text, /demo \(9 tools\)/, 'the job is told which servers there are');
      const refused = alone.seen[1].messages.at(-1).content[0];
      assert.equal(refused.is_error, true);
      assert.match(refused.content, /needs the user's approval[\s\S]*sumo mcp allow demo echo/);

      // Run inside the chat: the question reaches the screen with the job's id on it, and "always" is kept.
      const asked = [];
      const attended = canned([
        reply('tool_use', [call('t2', 'mcp__demo__echo', { text: 'hi' })]),
        reply('tool_use', [call('t3', 'mcp__demo__echo', { text: 'again' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }]),
        reply('end_turn', []),
      ]);
      await runJob(db, id, {
        send: attended.send,
        now: () => NOW,
        approve: async (ask) => {
          asked.push(ask);
          return 'always';
        },
      });
      assert.equal(attended.seen[1].messages.at(-1).content[0].content, 'you said: hi');
      assert.equal(attended.seen[2].messages.at(-1).content[0].content, 'you said: again');
      assert.equal(asked.length, 1, 'asked once; the second call was allowed by the first answer');
      assert.equal(asked[0].job, id);
      assert.equal(asked[0].tool, 'echo');
      assert.deepEqual(readConfig().mcpServers.demo.allow, ['echo']);
    } finally {
      await closeMcp();
      db.close();
    }
  });
});
