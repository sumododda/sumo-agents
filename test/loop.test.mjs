// The job loop: the request it builds, the policy every tool call passes through, and the ledger it leaves.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { jobParams, markTail, runJob, runLines } from '../src/loop.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { cap, childEnv, jailed, runBash, runEditor } from '../src/tools.mjs';
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
  assert.deepEqual(worker.tools.map((t) => t.name), ['bash', 'str_replace_based_edit_tool']);
  assert.deepEqual(worker.output_config, { effort: 'medium' });
  assert.equal(worker.context_management.edits[0].type, 'clear_tool_uses_20250919');

  const scout = jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' });
  assert.deepEqual(scout.tools.map((t) => t.name), ['bash'], 'a scout cannot edit');
  assert.equal('output_config' in scout, false, 'haiku takes no effort');
  const reviewer = jobParams({ job: { agent: 'reviewer', model: 'opus', effort: 'high' }, text: 'judge', system: 'rules' });
  assert.deepEqual(reviewer.tools.map((t) => t.name), ['bash'], 'a reviewer cannot edit');
});

test('a run: tool calls go through the guard, the jail and the cap; every response leaves a ledger row with the job on it', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { root, id } = seed(db);
      const { send, seen } = canned([
        reply('tool_use', [{ type: 'text', text: 'looking' }, call('t1', 'bash', { command: 'printf hi; env | grep -c ANTHROPIC_API_KEY' })]),
        reply('tool_use', [call('t2', 'bash', { command: 'rm -rf ~' }), call('t3', 'str_replace_based_edit_tool', { command: 'view', path: join(root, '.env') })]),
        reply('tool_use', [call('t4', 'str_replace_based_edit_tool', { command: 'view', path: '/etc/hosts' }), call('t5', 'str_replace_based_edit_tool', { command: 'str_replace', path: 'a.txt', old_str: 'two', new_str: '2' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }], { input_tokens: 500, cache_read_input_tokens: 2000, output_tokens: 20 }),
      ]);
      const outcome = await runJob(db, id, { send, now: () => NOW });

      assert.equal(outcome.turns, 4);
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

      // Each turn re-sends the whole history with one breakpoint on its tail, and the system prompt keeps its own.
      assert.equal(seen[3].messages.length, 7);
      assert.deepEqual(seen[3].messages.at(-1).content.at(-1).cache_control, { type: 'ephemeral' });
      assert.equal(seen[3].messages.slice(0, -1).flatMap((m) => m.content).filter((b) => b.cache_control).length, 0);
      assert.deepEqual(seen[3].system[0].cache_control, { type: 'ephemeral' });

      const rows = db.prepare('SELECT kind, model, input_tokens, cache_read_tokens, job_id, session_id, note FROM model_runs ORDER BY id').all();
      assert.equal(rows.length, 4);
      assert.deepEqual(rows.map((r) => r.job_id), [id, id, id, id]);
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
  const ctx = { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH, ANTHROPIC_API_KEY: 'k', GITHUB_TOKEN: 't', HOME: '/h' }) };
  assert.deepEqual(Object.keys(ctx.env).sort(), ['HOME', 'PATH']);
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

  // The shell has already gone and only its background child holds the output open.
  const again = new AbortController();
  let began = Date.now();
  const orphaned = runBash({ command: 'sleep 30 & echo started' }, ctx, { signal: again.signal });
  setTimeout(() => again.abort(), 300);
  const out = await orphaned;
  assert.ok(Date.now() - began < 5000, 'the stop was heard');
  assert.match(out.content, /^started\n\(stopped: interrupted by the user\)$/);

  // The same, with nobody to say stop: the time limit ends it.
  began = Date.now();
  const late = await runBash({ command: 'sleep 4 & echo started' }, ctx, { timeoutMs: 300 });
  assert.ok(Date.now() - began < 3000, 'the limit was kept');
  assert.equal(late.isError, true);
  assert.match(late.content, /^started\n\(stopped: it ran past /);
});

test('the cache breakpoint lands on the last message that can carry one, so a turn ending on an operator message still reads its history from the cache', () => {
  const text = (t) => ({ type: 'text', text: t });
  const messages = [{ role: 'user', content: [text('the memory block')] }, { role: 'assistant', content: [text('hello')] }, { role: 'user', content: [text('fix simba')] }, { role: 'system', content: '<project simba> card' }];
  markTail(messages);
  assert.deepEqual(messages[2].content[0].cache_control, { type: 'ephemeral' }, 'the turn before the operator message carries it');
  assert.equal(messages[3].content, '<project simba> card', 'the operator message is sent as it was');

  messages.push({ role: 'assistant', content: [text('on it')] }, { role: 'user', content: [text('thanks')] });
  markTail(messages);
  assert.deepEqual(messages.at(-1).content[0].cache_control, { type: 'ephemeral' });
  assert.equal(messages.flatMap((m) => (Array.isArray(m.content) ? m.content : [])).filter((b) => b.cache_control).length, 1, 'and there is only ever the one');
});
