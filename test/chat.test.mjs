// The chat session: the memory block first, the policy raised in process, a job run inside the process, the session log.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat, injection } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { add } from '../src/memory.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage, model: 'claude-opus-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const canned = (responses) => {
  const seen = [];
  const send = async (params, { onText } = {}) => {
    seen.push(structuredClone(params));
    const next = responses.shift();
    for (const b of next.content) if (b.type === 'text' && onText) onText(b.text);
    return next;
  };
  return { send, seen };
};

test('operator text goes in as a system message where the model takes one, and as tagged text otherwise', () => {
  const afterUser = [{ role: 'user', content: 'hi' }];
  const afterAssistant = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: [{ type: 'text', text: 'done?' }] }];
  assert.deepEqual(injection('card', 'claude-opus-5-5', afterUser), { role: 'system', content: 'card' });
  // The API rejects a system message after an assistant turn, so a stop-hook continuation goes as text.
  assert.deepEqual(injection('card', 'claude-opus-5-5', afterAssistant), { role: 'user', content: [{ type: 'text', text: '<sumo>\ncard\n</sumo>' }] });
  assert.deepEqual(injection('card', 'claude-haiku-4-5-20251001'), { role: 'user', content: [{ type: 'text', text: '<sumo>\ncard\n</sumo>' }] });
});

test('a session: the memory block opens it, a project card rides in once, a gated command waits for its workflow, and the log is written', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      add(db, { type: 'preference', body: 'Always squash before merging', now: NOW });

      const printed = [];
      const activity = [];
      const { send, seen } = canned([
        reply('tool_use', [{ type: 'text', text: 'on it' }, call('t1', 'bash', { command: 'pwd' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }], { input_tokens: 90_000, output_tokens: 10 }),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, out: (t) => printed.push(t), activity: (l) => activity.push(l), now: () => NOW });

      const block = session.start('startup');
      assert.match(block, /^<sumo-memory/);
      assert.match(block, /Always squash before merging/);
      assert.equal(session.params.messages[0].content[0].text, block, 'the block is the first user turn');
      assert.equal(session.params.model, 'claude-opus-5-5');
      assert.deepEqual(session.params.output_config, { effort: 'high' });

      await session.say('fix the briefing bug in simba');
      assert.deepEqual(printed.join(''), 'on itdone', 'the reply streams out as it comes');
      assert.deepEqual(activity, ['$ pwd'], 'each tool call is shown as one line');
      const first = seen[0].messages;
      assert.equal(first[1].content[0].text, 'fix the briefing bug in simba');
      assert.equal(first[2].role, 'system', 'the project card arrives as an operator message, after the cached prefix');
      assert.match(first[2].content, /^<project simba> /);
      assert.equal(seen[1].messages.at(-1).content[0].content.trim(), realpathSync(root), 'the shell ran in the project the card named');

      await session.say('and the next bit');
      const third = seen[2].messages;
      assert.equal(third.filter((m) => m.role === 'system' && /^<project/.test(m.content)).length, 1, 'the card is not sent twice');
      assert.match(third.at(-1).content, /^context: 90k tokens — quality drops from here/, 'the exact size of the context, said once it matters');

      const rows = db.prepare(`SELECT kind, session_id FROM model_runs ORDER BY id`).all();
      assert.deepEqual(rows.map((r) => r.kind), ['chat', 'chat', 'chat']);
      assert.equal(rows[0].session_id, session.sessionId);

      const log = readFileSync(join(paths().logs, 'sessions', `${session.sessionId}.jsonl`), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.deepEqual(log.map((l) => l.type), ['user', 'assistant', 'assistant', 'user', 'assistant']);
      assert.equal(log[2].message.usage.input_tokens, 90_000);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n, 2, 'what the user typed is kept for the scribe');

      session.end();
      assert.notEqual(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(session.sessionId).ended_at, null);
    } finally {
      db.close();
    }
  });
});

test('a job run typed by the model runs in this process, and a question memory can answer is answered before it reaches the user', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-job-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      add(db, { type: 'fact', body: 'My tickets are on the tracker board Atlas', now: NOW });
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('simba', 'look', 'scout', 'running', null, ?, ?, 'haiku', 'none', 'test')`)
        .run(NOW, NOW);
      const id = Number(lastInsertRowid);
      mkdirSync(join(paths().jobs, String(id)), { recursive: true });
      writeFileSync(join(paths().jobs, String(id), 'brief.md'), '# Job\n\n## The task\nlook around\n');

      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: `mem job run ${id}` })]), // the chat
        reply('end_turn', [{ type: 'text', text: 'scout report: nothing to see' }]), // the job, inside the same process
        reply('end_turn', [{ type: 'text', text: 'Which tracker board are your tickets on?' }]), // the chat, ending on a question
        reply('end_turn', [{ type: 'text', text: 'Atlas it is.' }]), // the chat, continued with the memory
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, out: () => {}, now: () => NOW });
      session.start('startup');
      const outcome = await session.say('check simba');

      assert.equal(seen[1].model, 'claude-haiku-4-5-20251001', 'the job ran on its own route, not the chat model');
      assert.match(seen[2].messages.at(-1).content[0].content, /STATUS: never closed — j\d+[\s\S]*scout report/, 'the chat sees the run the way mem job run prints it');
      assert.equal(outcome.text, 'Atlas it is.');
      const held = seen[3].messages.at(-1);
      assert.equal(held.role, 'user', 'after the assistant turn the memory goes as text; the API refuses a system message there');
      assert.match(held.content[0].text, /memory already holds[\s\S]*tracker board Atlas/);
      assert.equal(seen.length, 4);
      assert.equal(existsSync(join(paths().jobs, String(id), 'run.log')), false);
    } finally {
      db.close();
    }
  });
});
