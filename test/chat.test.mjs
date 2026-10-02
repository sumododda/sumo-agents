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

/** A transport whose replies can be held back: a held reply arrives when its gate opens, or fails when the turn is interrupted. */
const gated = (responses) => {
  const seen = [];
  const send = (params, { onText, signal } = {}) =>
    new Promise((resolve, reject) => {
      seen.push(structuredClone(params));
      const next = responses.shift();
      const deliver = () => {
        for (const b of next.reply.content) if (b.type === 'text' && onText) onText(b.text);
        resolve(next.reply);
      };
      if (!next.gate) return deliver();
      signal?.addEventListener('abort', () => reject(new Error('Request was aborted.')));
      next.gate.then(deliver);
    });
  return { send, seen };
};
const until = async (test, what) => {
  for (let i = 0; i < 400; i++) {
    if (test()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  assert.fail(`never happened: ${what}`);
};
/** Every tool call in the history has its result in the next message; the API refuses a history where one does not. */
const paired = (messages) =>
  messages.every((m, i) => m.role !== 'assistant' || m.content.filter((b) => b.type === 'tool_use').every((u) => messages[i + 1]?.content.some?.((r) => r.type === 'tool_result' && r.tool_use_id === u.id)));

test('a watcher is told what ran, what came back and what it cost; an interrupt ends the turn and the next one carries on', async () => {
  const spawned = join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log');
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: spawned }, async () => {
    const db = openDb();
    try {
      const watched = [];
      const { send, seen } = gated([
        { reply: reply('tool_use', [call('t1', 'bash', { command: 'echo one' })], { input_tokens: 100, output_tokens: 40 }) },
        { reply: reply('end_turn', [{ type: 'text', text: 'never said' }]), gate: new Promise(() => {}) },
        { reply: reply('tool_use', [call('t2', 'bash', { command: 'sleep 20' }), call('t3', 'bash', { command: 'echo never' })]) },
        { reply: reply('end_turn', [{ type: 'text', text: 'carried on' }]) },
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, watch: (e) => watched.push(e), now: () => NOW });
      session.start('startup');

      // Stopped while the model was answering.
      const first = session.say('go');
      await until(() => seen.length === 2, 'the second request');
      session.interrupt();
      const stopped = await first;
      assert.equal(stopped.stop, 'interrupted');
      assert.equal(readFileSync(spawned, 'utf8'), 'scribe run\n', 'a turn the user stopped is still a turn that ended: what they said is filed');
      assert.deepEqual(watched.map((e) => e.type), ['usage', 'tool', 'result'], 'the cost comes with the reply, before its tools run');
      assert.equal(watched[0].totals.outputTokens, 40);
      assert.equal(watched[1].call.input.command, 'echo one');
      assert.deepEqual(watched[2].result, { content: 'one', isError: false });

      // Stopped while a command was running: it is killed, the call after it never runs, and both are answered.
      const began = Date.now();
      const second = session.say('again');
      await until(() => watched.filter((e) => e.type === 'tool').length === 2, 'the sleep to start');
      session.interrupt();
      assert.equal((await second).stop, 'interrupted');
      assert.ok(Date.now() - began < 5000, 'the sleep was killed, not waited for');
      const results = session.params.messages.at(-1).content;
      assert.deepEqual(results.map((r) => [r.tool_use_id, r.is_error]), [['t2', true], ['t3', true]]);
      assert.match(results[0].content, /interrupted by the user/);
      assert.match(results[1].content, /interrupted by the user/);
      assert.equal(watched.filter((e) => e.type === 'tool').length, 2, 'the call that never ran is not shown as running');

      // And the conversation is still one the API takes.
      const third = await session.say('once more');
      assert.equal(third.text, 'carried on');
      assert.equal(paired(seen[3].messages), true);
      assert.equal(seen[3].messages.at(-1).content[0].text, 'once more');
      session.end();
    } finally {
      db.close();
    }
  });
});

test('a tool that fails is an answer the model can read, not a hole in the conversation', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = gated([
        { reply: reply('tool_use', [call('t1', 'bash', { command: 'mem job run 999' })]) },
        { reply: reply('end_turn', [{ type: 'text', text: 'there is no such job' }]) },
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      const outcome = await session.say('run job 999');
      assert.equal(outcome.text, 'there is no such job');
      const result = seen[1].messages.at(-1).content[0];
      assert.deepEqual([result.type, result.tool_use_id, result.is_error], ['tool_result', 't1', true]);
      assert.match(result.content, /no job j999/);
    } finally {
      db.close();
    }
  });
});

test('a turn stopped before the model answered leaves no operator message stranded, and a job run inside the chat stops with it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-stop-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('simba', 'look', 'scout', 'running', null, ?, ?, 'haiku', 'none', 'test')`)
        .run(NOW, NOW);
      const id = Number(lastInsertRowid);
      mkdirSync(join(paths().jobs, String(id)), { recursive: true });
      writeFileSync(join(paths().jobs, String(id), 'brief.md'), '# Job\n\n## The task\nlook around\n');

      const never = new Promise(() => {});
      const { send, seen } = gated([
        { reply: reply('end_turn', [{ type: 'text', text: 'never said' }]), gate: never },
        { reply: reply('tool_use', [call('t1', 'bash', { command: `mem job run ${id}` })]) },
        { reply: reply('end_turn', [{ type: 'text', text: 'the job never says this' }]), gate: never },
        { reply: reply('end_turn', [{ type: 'text', text: 'fine' }]) },
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');

      // The project's card rides in as an operator message; the turn is stopped before any answer.
      const first = session.say('fix the briefing bug in simba');
      await until(() => seen.length === 1, 'the first request');
      assert.equal(seen[0].messages.at(-1).role, 'system');
      session.interrupt();
      assert.equal((await first).stop, 'interrupted');

      // The job the model starts is stopped by the same key.
      const second = session.say('have a scout look');
      await until(() => seen.length === 3, 'the job to be talking to its model');
      assert.equal(seen[2].model, 'claude-haiku-4-5-20251001');
      session.interrupt();
      assert.equal((await second).stop, 'interrupted');
      assert.match(session.params.messages.at(-1).content[0].content, /interrupted by the user/);

      await session.say('carry on');
      const sent = seen[3].messages;
      assert.equal(paired(sent), true);
      // An operator message is taken only where the model answers next; one left before a user turn is refused.
      assert.equal(sent.some((m, i) => m.role === 'system' && sent[i + 1]?.role === 'user'), false, JSON.stringify(sent.map((m) => m.role)));
      assert.match(JSON.stringify(sent), /<project simba>/, 'what the operator message said is still there');
    } finally {
      db.close();
    }
  });
});
