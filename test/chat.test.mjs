// The chat session: the memory block first, the policy raised in process, a job run inside the process, the session log.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { test } from 'node:test';
import { chat, createChat, injection } from '../src/chat.mjs';
import { MODEL_IDS } from '../src/model.mjs';
import { openDb } from '../src/db.mjs';
import { closeJobTab, reportAgent } from '../src/herdr.mjs';
import { takeInbox } from '../src/jobs.mjs';
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

test('images go to the model before the words, each under the label the box showed it by; the log keeps the words, not the pictures', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'a cat and a dog' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      const cat = { label: '[Image #1]', mediaType: 'image/png', data: 'Y2F0' };
      const dog = { label: '[Image #2]', mediaType: 'image/jpeg', data: 'ZG9n' };
      await session.say('what are [Image #1] and [Image #2]?', 'what are [Image #1] and [Image #2]?', [cat, dog]);
      assert.deepEqual(seen[0].messages[1].content.map(({ cache_control, ...block }) => block), [
        { type: 'text', text: '[Image #1]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'Y2F0' } },
        { type: 'text', text: '[Image #2]' },
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'ZG9n' } },
        { type: 'text', text: 'what are [Image #1] and [Image #2]?' },
      ]);
      const log = readFileSync(join(paths().logs, 'sessions', `${session.sessionId}.jsonl`), 'utf8');
      assert.match(log, /what are \[Image #1\] and \[Image #2\]\?/);
      assert.doesNotMatch(log, /Y2F0|ZG9n/, 'the pictures are not written to disk');
    } finally {
      db.close();
    }
  });
});

test('pictures the API refuses leave the turn with its words alone, so the turns after it are not refused for them too', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const seen = [];
      const send = async (params) => {
        seen.push(structuredClone(params.messages));
        if (params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))) throw new Error('400 image exceeds 10 MB maximum');
        return reply('end_turn', [{ type: 'text', text: 'hi' }]);
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      const refused = await session.say('what is [Image #1]?', 'what is [Image #1]?', [{ label: '[Image #1]', mediaType: 'image/png', data: 'Ymln' }]);
      assert.equal(refused.stop, 'error');
      assert.match(refused.error, /10 MB/);
      assert.equal((await session.say('never mind, just say hi')).stop, 'end_turn');
      const users = seen.at(-1).filter((m) => m.role === 'user').map((m) => m.content.map((b) => b.text ?? b.type));
      assert.deepEqual(users.slice(-2), [['what is [Image #1]?'], ['never mind, just say hi']]);
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
        reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id}` })]), // the chat
        reply('end_turn', [{ type: 'text', text: 'scout report: nothing to see' }]), // the job, inside the same process
        reply('end_turn', [{ type: 'text', text: 'Which tracker board are your tickets on?' }]), // the chat, ending on a question
        reply('end_turn', [{ type: 'text', text: 'Atlas it is.' }]), // the chat, continued with the memory
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, out: () => {}, now: () => NOW });
      session.start('startup');
      const outcome = await session.say('check simba');

      assert.equal(seen[1].model, 'claude-haiku-4-5-20251001', 'the job ran on its own route, not the chat model');
      assert.match(seen[2].messages.at(-1).content[0].content, /STATUS: never closed — j\d+[\s\S]*scout report/, 'the chat sees the run the way sumo job run prints it');
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
        { reply: reply('tool_use', [call('t1', 'bash', { command: 'sumo job run 999' })]) },
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
        { reply: reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id}` })]) },
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

/** A project with one running scout job and its brief — the least a job run inside the chat needs. */
function scoutJob(db, prefix) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
  addProject(db, root, { slug: 'simba', now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('simba', 'look', 'scout', 'running', null, ?, ?, 'haiku', 'none', 'test')`)
    .run(NOW, NOW);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), '# Job\n\n## The task\nlook around\n');
  return id;
}

test('a job run inside the chat is watched as it works, and what the user tells it reaches it with its next request', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-watch-');
      const open = {};
      const held = (name) => new Promise((r) => (open[name] = r));
      const watched = [];
      const { send, seen } = gated([
        { reply: reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id}` })]) }, // the chat
        { reply: reply('tool_use', [{ type: 'text', text: 'looking' }, call('j1', 'bash', { command: 'echo hi' })]), gate: held('first') }, // the job
        { reply: reply('end_turn', [{ type: 'text', text: 'report one' }]), gate: held('second') }, // the job, about to end
        { reply: reply('end_turn', [{ type: 'text', text: 'because you asked' }]) }, // the job, answering what it was told
        { reply: reply('end_turn', [{ type: 'text', text: 'done' }]) }, // the chat
      ]);
      const lines = [];
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, watch: (e) => watched.push(e), activity: (l) => lines.push(l), now: () => NOW });
      session.start('startup');
      assert.equal(session.tell('nobody is listening'), false, 'with no job running there is nobody to tell');

      const turn = session.say('check simba');
      await until(() => seen.length === 2, 'the job to be talking to its model');
      assert.equal(session.tell('stay in src'), true);
      open.first();
      await until(() => seen.length === 3, "the job's second request");
      const heard = seen[2].messages.at(-1).content;
      assert.deepEqual(heard.map((b) => b.type), ['tool_result', 'text'], 'what the user said rides behind the tool results');
      assert.match(heard[1].text, /stay in src/);

      // Told while the job is ending: it gets one more request, so the message is read and answered.
      assert.equal(session.tell('and say why'), true);
      open.second();
      await until(() => seen.length >= 4, 'the request that carries the second message');
      assert.equal(seen[3].model, 'claude-haiku-4-5-20251001');
      assert.equal(seen[3].messages.at(-1).role, 'user');
      assert.match(seen[3].messages.at(-1).content[0].text, /and say why/);

      assert.equal((await turn).text, 'done');
      assert.equal(session.tell('too late'), false, 'the job is over');
      assert.match(seen[4].messages.at(-1).content[0].content, /STATUS: never closed — j\d+[\s\S]*because you asked/);

      const told = watched.filter((e) => e.type !== 'usage').map((e) => [e.type, e.job?.id ?? e.job ?? null, e.call?.id ?? e.text ?? null]);
      assert.deepEqual(told, [
        ['tool', null, 't1'],
        ['job', id, null],
        ['said', id, 'looking'],
        ['tool', id, 'j1'],
        ['result', id, 'j1'],
        ['said', id, 'report one'],
        ['said', id, 'because you asked'],
        ['job-end', id, null],
        ['result', null, 't1'],
      ]);
      assert.deepEqual(lines, [`$ sumo job run ${id}`, `running j${id}…`, `j${id} $ echo hi`], 'without a screen, the same work is a line per call');
      const started = watched.find((e) => e.type === 'job').job;
      assert.deepEqual([started.agent, started.title, started.model], ['scout', 'look', 'haiku']);
      assert.deepEqual(watched.find((e) => e.type === 'result' && e.job === id).result, { content: 'hi', isError: false });
    } finally {
      db.close();
    }
  });
});

test('a job run that is not alone in its command is refused, because the shell holds no credential to run it with', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([
        reply('tool_use', [
          call('t1', 'bash', { command: 'sumo job run 7 2>&1 | tail -3' }),
          call('t2', 'bash', { command: 'cd /tmp && nohup sumo job run 7 > /tmp/j7.log 2>&1 &' }),
          call('t3', 'bash', { command: 'echo "see: sumo job run 7"' }),
          call('t4', 'bash', { command: 'sumo job show 7' }),
        ]),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      await session.say('run job 7');
      const [piped, nohupped, quoted, other] = seen[1].messages.at(-1).content;
      for (const refused of [piped, nohupped, quoted]) {
        assert.equal(refused.is_error, true, refused.content);
        assert.match(refused.content, /alone in its command/);
      }
      assert.match(other.content, /no job j7/, 'other job commands still run in the shell');
    } finally {
      db.close();
    }
  });
});

test('a job run with & gets a Herdr tab of its own in the chat\'s workspace, or is not started when Herdr is not there; @j<id> reaches a job in a tab through its inbox', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log'), HERDR_WORKSPACE_ID: 'w2' }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-pane-');
      const project = db.prepare('SELECT path FROM projects').get().path;
      const calls = [];
      const answers = [
        { status: 0, stdout: JSON.stringify({ id: 'cli:tab:create', result: { root_pane: { pane_id: 'w2:pJ', tab_id: 'w2:tF' }, tab: { tab_id: 'w2:tF', label: 'j1 scout · look' }, type: 'tab_created' } }) },
        { status: 0, stdout: '' },
        { status: 1, stdout: JSON.stringify({ id: 'cli:tab:create', error: { code: 'server_not_running', message: 'no herdr server is running' } }) },
        { error: Object.assign(new Error('spawnSync herdr ENOENT'), { code: 'ENOENT' }) },
      ];
      const herdr = (args) => {
        calls.push(args);
        return answers.shift();
      };
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id} &` })]),
        reply('tool_use', [call('t2', 'bash', { command: `sumo job run ${id} &` })]),
        reply('tool_use', [call('t3', 'bash', { command: `sumo job run ${id} &` })]),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, herdr, now: () => NOW });
      session.start('startup');
      await session.say('run it in the background');

      const started = seen[1].messages.at(-1).content[0];
      assert.equal(started.is_error, false);
      assert.match(started.content, new RegExp(`started j${id} in a Herdr tab of its own \\(on the left, "j${id} scout"\\)`));
      assert.deepEqual(calls[0], ['tab', 'create', '--workspace', 'w2', '--cwd', project, '--label', `j${id} scout · look`, '--no-focus'], "a tab in the chat's workspace, in the project, named after the job");
      assert.deepEqual(calls[1], ['pane', 'run', 'w2:pJ', `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${paths().home} ${paths().launcher} job run ${id}`], 'the run is marked as the tab\'s own, so the tab may close itself after, and it opens the home the chat has open');

      const stopped = seen[2].messages.at(-1).content[0];
      assert.equal(stopped.is_error, true);
      assert.match(stopped.content, /not started — background jobs run in Herdr tabs, and no herdr server is running\. Start Herdr, or run it in the chat without &/);
      const missing = seen[3].messages.at(-1).content[0];
      assert.equal(missing.is_error, true);
      assert.match(missing.content, /`herdr` is not on PATH/);
      assert.equal(calls.length, 4, 'no run is attempted when the split failed');

      // Talking to the job in its pane: the message waits on disk for the job's next request.
      assert.equal(session.tell('only go and ui', id), true);
      assert.deepEqual(takeInbox(id), ['only go and ui']);
      assert.throws(() => session.tell('hello?', 999), /no job j999/);
    } finally {
      db.close();
    }
  });
});

test('inside Herdr a job run without & still gets a tab; the chat waits for how it ended, a bare message goes to it, and Esc ends the wait but not the job', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-wait-');
      writeFileSync(join(paths().jobs, String(id), 'outcome.txt'), 'STALE\n', { mode: 0o600 });
      const calls = [];
      const herdr = (args) => {
        calls.push(args);
        return args[1] === 'create' ? { status: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w2:pH' } } }) } : { status: 0, stdout: '' };
      };
      const watched = [];
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id}` })]),
        reply('end_turn', [{ type: 'text', text: 'read it' }]),
        reply('tool_use', [call('t2', 'bash', { command: `sumo job run ${id}` })]),
        reply('end_turn', [{ type: 'text', text: 'fine' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, herdr, env: { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w2' }, poll: 10, watch: (e) => watched.push(e), now: () => NOW });
      session.start('startup');

      const turn = session.say('have a scout look');
      await until(() => calls.length === 2, 'the pane to be opened');
      assert.deepEqual(calls[0].slice(0, 4), ['tab', 'create', '--workspace', 'w2']);
      assert.equal(session.tell('only go'), true, 'a bare message goes to the job in the pane');
      assert.deepEqual(takeInbox(id), ['only go']);
      assert.equal(seen.length, 1, 'the chat is waiting, not talking');
      await new Promise((r) => setTimeout(r, 40));
      assert.equal(seen.length, 1, 'a stale outcome from an earlier run does not end the wait');
      writeFileSync(join(paths().jobs, String(id), 'outcome.txt'), `STATUS: DONE — j${id}\n3 turns, 2 tool calls\n`, { mode: 0o600 });
      assert.equal((await turn).text, 'read it');
      assert.equal(seen[1].messages.at(-1).content[0].content, `STATUS: DONE — j${id}\n3 turns, 2 tool calls`, 'the chat reads how the run ended, as the run printed it');
      assert.deepEqual(watched.filter((e) => e.type !== 'usage').map((e) => e.type), ['tool', 'job', 'job-end', 'result']);
      assert.equal(session.tell('late'), false);

      // Esc while waiting: the wait ends, the pane keeps the job.
      const second = session.say('again');
      await until(() => calls.length === 4, 'the second pane');
      session.interrupt();
      assert.equal((await second).stop, 'interrupted');
      assert.match(session.params.messages.at(-1).content[0].content, new RegExp(`stopped waiting for j${id} — it is still running in its Herdr tab`));
    } finally {
      db.close();
    }
  });
});

test('a job done in a tab of its own closes the tab; one that failed or stopped on a question keeps it, and a tab the user opened is never closed', () => {
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    return { status: 0, stdout: '' };
  };
  const own = { HERDR_PANE_ID: 'w2:pJ', HERDR_TAB_ID: 'w2:tJ', SUMO_JOB_TAB: '1' };
  const job = { id: 33, agent: 'scout', title: 'Describe what simba does', status: 'done' };
  closeJobTab(herdr, own, job);
  assert.deepEqual(calls, [['tab', 'close', 'w2:tJ']]);
  calls.length = 0;
  closeJobTab(herdr, own, { ...job, status: 'failed' });
  closeJobTab(herdr, own, { ...job, status: 'needs_input' });
  closeJobTab(herdr, { HERDR_PANE_ID: 'w2:pJ', HERDR_TAB_ID: 'w2:tJ' }, job);
  closeJobTab(herdr, {}, job);
  assert.deepEqual(calls, [], 'nothing to read in a tab that is gone: a failed or blocked job keeps its tab, and a tab that is not the job\'s own is left alone');
});

test('a job in its own tab tells Herdr it is working, then blocked or idle, under the name the tab shows; outside a pane it says nothing', () => {
  const calls = [];
  const herdr = (args) => {
    calls.push(args);
    return { status: 0, stdout: '' };
  };
  const job = { id: 33, agent: 'scout', title: 'Describe what simba does', status: 'running' };
  reportAgent(herdr, { HERDR_PANE_ID: 'w2:pJ' }, { job, state: 'working', message: job.title });
  reportAgent(herdr, { HERDR_PANE_ID: 'w2:pJ' }, { job: { ...job, status: 'needs_input' }, state: 'blocked', message: 'STATUS: NEEDS_INPUT — j33' });
  reportAgent(herdr, {}, { job, state: 'idle' });
  assert.deepEqual(calls, [
    ['pane', 'report-agent', 'w2:pJ', '--source', 'sumo', '--agent', 'j33 scout', '--state', 'working', '--message', 'Describe what simba does'],
    ['pane', 'report-agent', 'w2:pJ', '--source', 'sumo', '--agent', 'j33 scout', '--state', 'blocked', '--message', 'STATUS: NEEDS_INPUT — j33'],
  ]);
});

test('/exit leaves as /quit does, and /memory serves the memory page once and opens it each time it is asked for', async () => {
  const spawnLog = join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log');
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: spawnLog }, async () => {
    const db = openDb();
    try {
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: canned([]).send, now: () => NOW });
      session.start('startup');
      assert.deepEqual(session.expand('/exit'), { control: 'quit' });
      assert.deepEqual(session.expand('/quit'), { control: 'quit' });
      assert.deepEqual(session.expand('/memory'), { control: 'memory' });

      const first = await session.memoryPage();
      const url = /http:\/\/127\.0\.0\.1:\d+\/\w+\//.exec(first)?.[0];
      assert.ok(url, `the address is said: ${first}`);
      assert.equal(await session.memoryPage(), first, 'one page per chat, however often it is asked for');
      assert.equal(readFileSync(spawnLog, 'utf8'), `open ${url}\nopen ${url}\n`, 'a closed tab comes back on asking again');
    } finally {
      db.close();
    }
  });
});

test('/model says the route, sets it for the next turn, and refuses a model or effort it does not know', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'one' }]), reply('end_turn', [{ type: 'text', text: 'two' }]), reply('end_turn', [{ type: 'text', text: 'three' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      assert.deepEqual(session.expand('/model'), { control: 'model', args: '' });
      assert.deepEqual(session.expand('/model sonnet medium'), { control: 'model', args: 'sonnet medium' });
      assert.equal(session.route(''), 'opus/high');

      assert.equal(session.route('sonnet medium'), 'sonnet/medium');
      assert.equal(session.model, 'sonnet');
      assert.equal(session.effort, 'medium');
      await session.say('go');
      assert.equal(seen[0].model, MODEL_IDS.sonnet);
      assert.deepEqual(seen[0].output_config, { effort: 'medium' });

      // The model alone keeps the effort; haiku takes none.
      assert.equal(session.route('fable'), 'fable/medium');
      assert.equal(session.route('haiku'), 'haiku');
      await session.say('again');
      assert.equal(seen[1].model, MODEL_IDS.haiku);
      assert.equal('output_config' in seen[1], false);

      assert.throws(() => session.route('gpt'), /no such model "gpt" — one of: auto, haiku, sonnet, opus, fable/);
      assert.throws(() => session.route('opus extreme'), /no such effort "extreme" — one of: low, medium, high, xhigh, max/);
      assert.throws(() => session.route('haiku high'), /haiku takes no effort/);
      assert.equal(session.route(''), 'haiku', 'a refused change changes nothing');

      // A session started afresh keeps the route the user chose.
      session.route('opus low');
      session.end();
      session.start('new');
      await session.say('once more');
      assert.equal(seen[2].model, MODEL_IDS.opus);
      assert.deepEqual(seen[2].output_config, { effort: 'low' });
    } finally {
      db.close();
    }
  });
});

test('on auto, each turn is routed by the local router before it is sent; a router that cannot answer refuses the turn', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const asked = [];
      const answers = [{ model: 'sonnet', effort: 'medium', reason: 'routine, a few files' }, null, { model: 'haiku', effort: 'none', reason: 'mechanical' }];
      const route = async (_db, ask) => {
        asked.push(ask);
        const next = answers.shift();
        if (!next) throw new Error('the router failed: no router answer recorded');
        return next;
      };
      const watched = [];
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'one' }]), reply('end_turn', [{ type: 'text', text: 'two' }])]);
      const session = createChat(db, { model: 'auto', cwd: tmpdir(), send, route, watch: (e) => watched.push(e), now: () => NOW });
      session.start('startup');
      assert.equal(session.model, 'auto');
      assert.equal(session.route(''), 'auto');

      const first = await session.say('rename the helper in two files');
      assert.equal(first.text, 'one');
      assert.equal(asked[0].text, 'rename the helper in two files');
      assert.equal(seen[0].model, MODEL_IDS.sonnet);
      assert.deepEqual(seen[0].output_config, { effort: 'medium' });
      assert.deepEqual(watched[0], { type: 'route', model: 'sonnet', effort: 'medium', reason: 'routine, a few files' });
      assert.deepEqual(session.routed, { model: 'sonnet', effort: 'medium', reason: 'routine, a few files' });
      assert.equal(session.route(''), 'auto → sonnet/medium');

      // The router down: nothing is sent, nothing is left in the conversation, and the turn says why.
      const refused = await session.say('and now this');
      assert.equal(refused.stop, 'error');
      assert.match(refused.error, /the router failed: no router answer recorded/);
      assert.equal(seen.length, 1);
      assert.equal(session.params.messages.at(-1).role, 'assistant', 'the refused message is not in the conversation');

      const third = await session.say('fix the typo');
      assert.equal(third.text, 'two');
      assert.equal(seen[1].model, MODEL_IDS.haiku);
      assert.equal('output_config' in seen[1], false);

      // Off auto, the router is not asked again.
      assert.equal(session.route('opus high'), 'opus/high');
      assert.equal(session.routed, null);
      session.end();
    } finally {
      db.close();
    }
  });
});

test('a session started afresh starts small and nowhere: the size and the project of the one before do not follow it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const started = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-cwd-')));
      const { send, seen } = canned([
        reply('end_turn', [{ type: 'text', text: 'done' }], { input_tokens: 160_000, output_tokens: 10 }),
        reply('tool_use', [call('t1', 'bash', { command: 'pwd' })]),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: started, send, now: () => NOW });
      session.start('startup');
      await session.say('fix the briefing bug in simba');
      assert.equal(session.contextTokens, 160_010);

      session.end();
      session.start('new');
      assert.equal(session.contextTokens, 0, 'a fresh session has read nothing yet');
      await session.say('something else entirely');
      const operator = seen[1].messages.filter((m) => m.role === 'system').map((m) => m.content);
      assert.deepEqual(operator, [], 'nothing tells a session that has just begun to start again');
      assert.equal(seen[2].messages.at(-1).content[0].content.trim(), started, 'no card has come in, so the shell runs where the chat was started');
    } finally {
      db.close();
    }
  });
});

test('a reply cut off inside a tool call is not run, and still leaves a conversation the next turn can use', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const cwd = mkdtempSync(join(tmpdir(), 'sumo-agents-cwd-'));
      const { send, seen } = canned([
        reply('max_tokens', [{ type: 'text', text: 'writing it' }, call('t1', 'str_replace_based_edit_tool', { command: 'create', path: 'big.txt' })], { input_tokens: 100, output_tokens: 16_000 }),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd, send, now: () => NOW });
      session.start('startup');
      assert.equal((await session.say('write a very large file')).stop, 'max_tokens');
      assert.equal(existsSync(join(cwd, 'big.txt')), false, 'half a call is not a call');

      await session.say('carry on');
      const sent = seen[1].messages;
      const cut = sent.findIndex((m) => m.role === 'assistant' && m.content.some((b) => b.type === 'tool_use'));
      // The API refuses a request in which a tool call has no result in the very next message.
      assert.equal(sent[cut + 1].role, 'user');
      assert.deepEqual(sent[cut + 1].content.map((b) => [b.type, b.tool_use_id, b.is_error]), [['tool_result', 't1', true]]);
      assert.match(sent[cut + 1].content[0].content, /cut off/);
    } finally {
      db.close();
    }
  });
});

test('a message that begins with a path is a message: it is sent as typed, and kept like any other turn', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'looking' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');

      const typed = '/usr/bin/env is missing on this box, why?';
      assert.deepEqual(session.expand(typed), { text: typed });
      assert.deepEqual(session.expand('/etc/hosts'), { text: '/etc/hosts' });
      // A command is still a slash and a word, alone or followed by a space.
      assert.match(session.expand('/fix the bug').text, /\n\nFollow that, in order, for this: the bug$/);
      assert.deepEqual(session.expand('/new'), { control: 'new' });
      assert.match(session.expand('/nope').error, /no such command \/nope/);

      await session.say(session.expand(typed).text);
      assert.equal(seen[0].messages.at(-1).content[0].text, typed);
      assert.deepEqual(db.prepare('SELECT text FROM user_turns').all().map((t) => t.text), [typed], 'what the user typed is kept for memory, path first or not');
    } finally {
      db.close();
    }
  });
});

test('a command the user runs themselves where the directory is gone says so, to them and to the model', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const gone = join(mkdtempSync(join(tmpdir(), 'sumo-agents-cwd-')), 'removed');
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: gone, send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      session.start('startup');
      const said = await session.shell('echo hi');
      assert.match(said, /^the command could not be started: .*removed does not exist$/);
      assert.match(session.params.messages.at(-1).content[0].text, /^I ran `echo hi` myself:\nthe command could not be started: /);
    } finally {
      db.close();
    }
  });
});

test('a home with a space in its path still starts a job in its tab: the launcher is quoted for the shell the tab runs', async () => {
  const home = join(mkdtempSync(join(tmpdir(), 'sumo agents it\'s here ')), 'home');
  await withHome(home, { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-pane-');
      const calls = [];
      const herdr = (args) => {
        calls.push(args);
        return args[1] === 'create' ? { status: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w2:pJ' } } }) } : { status: 0, stdout: '' };
      };
      const { send } = canned([reply('tool_use', [call('t1', 'bash', { command: `sumo job run ${id} &` })]), reply('end_turn', [{ type: 'text', text: 'started' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, herdr, env: { HERDR_ENV: '1' }, now: () => NOW });
      session.start('startup');
      await session.say('have a scout look');

      const typed = calls[1][3];
      // What the tab's shell makes of it: the words it would hand to env.
      const words = spawnSync('sh', ['-c', `printf '%s\\n' ${typed}`], { encoding: 'utf8' }).stdout.trimEnd().split('\n');
      assert.deepEqual(words, ['env', 'SUMO_JOB_TAB=1', `SUMO_AGENTS_HOME=${paths().home}`, paths().launcher, 'job', 'run', String(id)]);
    } finally {
      db.close();
    }
  });
});

test('a command the user runs after a turn that never got its answer leaves no operator message stranded behind it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const seen = [];
      let down = true;
      const send = async (params) => {
        seen.push(structuredClone(params));
        if (down) throw new Error('the API answered 529: overloaded');
        return reply('end_turn', [{ type: 'text', text: 'ok' }]);
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');

      // The project's card rides in as an operator message, and the request fails before the model answers it.
      assert.equal((await session.say('fix the briefing bug in simba')).stop, 'error');
      assert.equal(seen[0].messages.at(-1).role, 'system');
      await session.shell('echo hi');
      down = false;
      await session.say('try again');

      // The API takes an operator message only where the model answers next: as the last message of a request.
      const sent = seen[1].messages;
      assert.deepEqual(sent.slice(0, -1).filter((m) => m.role === 'system'), []);
      assert.ok(sent.some((m) => m.role === 'user' && /^<sumo>\n<project simba> /.test(m.content[0].text)), 'the card is still there, as text');
    } finally {
      db.close();
    }
  });
});

test('a model that takes no effort and no operator messages is sent neither, whichever way the chat came to be on it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });

      // Started on haiku, with the effort the configuration holds for the other models.
      const started = canned([reply('end_turn', [{ type: 'text', text: 'hi' }])]);
      const onHaiku = createChat(db, { model: 'haiku', effort: 'high', cwd: '/', send: started.send, now: () => NOW });
      onHaiku.start('startup');
      await onHaiku.say('hello');
      assert.equal(started.seen[0].model, MODEL_IDS.haiku);
      assert.equal('output_config' in started.seen[0], false, 'haiku takes no effort setting');
      assert.equal(onHaiku.effort, 'none');

      // On auto: a turn on sonnet brings a card in as an operator message, and the next turn goes to haiku.
      const routes = [{ model: 'sonnet', effort: 'medium', reason: 'routine' }, { model: 'haiku', effort: 'none', reason: 'mechanical' }, { model: 'sonnet', effort: 'low', reason: 'routine' }];
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'one' }]), reply('end_turn', [{ type: 'text', text: 'two' }]), reply('end_turn', [{ type: 'text', text: 'three' }])]);
      const session = createChat(db, { model: 'auto', cwd: '/', send, route: async () => routes.shift(), now: () => NOW });
      session.start('startup');
      await session.say('fix the briefing bug in simba');
      assert.equal(seen[0].messages.at(-1).role, 'system');
      await session.say('rename that variable');
      assert.equal(seen[1].model, MODEL_IDS.haiku);
      assert.deepEqual(seen[1].messages.filter((m) => m.role === 'system'), [], 'haiku is sent the card as text');
      assert.ok(seen[1].messages.some((m) => m.role === 'user' && /^<sumo>\n<project simba> /.test(m.content[0].text)));
      await session.say('and now the hard part');
      assert.equal(seen[2].messages.filter((m) => m.role === 'system').length, 1, 'the conversation itself is unchanged, so the other model still reads it from its cache');
    } finally {
      db.close();
    }
  });
});

test('a reply with nothing in it is not kept: the next turn is still a conversation the API takes', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('refusal', []), reply('end_turn', [{ type: 'text', text: 'ok' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      assert.equal((await session.say('something the model declines')).stop, 'refusal');
      await session.say('something else');
      assert.deepEqual(seen[1].messages.filter((m) => Array.isArray(m.content) && m.content.length === 0), [], 'the API refuses a message with no content');
    } finally {
      db.close();
    }
  });
});

test('Esc while the router is still choosing stops the turn before anything is sent, and what the user typed is logged without its secrets', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      let answer;
      const route = () => new Promise((resolve) => (answer = resolve));
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'ok' }])]);
      const session = createChat(db, { model: 'auto', cwd: tmpdir(), send, route, now: () => NOW });
      session.start('startup');

      const turn = session.say('rewrite the whole scheduler');
      await new Promise((r) => setTimeout(r, 10));
      session.interrupt();
      answer({ model: 'opus', effort: 'high', reason: 'hard' });
      assert.equal((await turn).stop, 'interrupted');
      assert.equal(seen.length, 0, 'nothing was sent');
      assert.equal(session.params.messages.length, 1, 'and nothing of the turn is in the conversation');

      const next = session.say('my deploy token is ghp_abcdefghijklmnopqrstuvwxyz0123456789, use it');
      await new Promise((r) => setTimeout(r, 10));
      answer({ model: 'opus', effort: 'high', reason: 'hard' });
      await next;
      const log = readFileSync(join(paths().logs, 'sessions', `${session.sessionId}.jsonl`), 'utf8');
      assert.match(log, /my deploy token is \[redacted\], use it/);
      assert.doesNotMatch(log, /ghp_/);
    } finally {
      db.close();
    }
  });
});

test('a slash command sends its sentence to the model, and keeps only the user\'s own words as what the user said', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'on it' }]), reply('end_turn', [{ type: 'text', text: 'done' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');

      const review = session.expand('/review the diff on my branch');
      assert.equal(review.said, 'the diff on my branch');
      assert.match(review.text, /^Review this: the diff on my branch\nCode written in this session is never reviewed in this session/);
      await session.say(review.text, review.said);
      assert.match(seen[0].messages.at(-1).content[0].text, /^Review this: the diff on my branch/);

      // A command with nothing after it is nothing the user said.
      const dream = session.expand('/dream');
      assert.equal(dream.said, '');
      await session.say(dream.text, dream.said);
      assert.deepEqual(db.prepare('SELECT text FROM user_turns ORDER BY id').all().map((r) => r.text), ['the diff on my branch'], 'the canned sentence is the chat\'s, not the user\'s');
    } finally {
      db.close();
    }
  });
});

test('piped into the chat, every line is a turn: the ones that arrive while another is being answered wait for theirs', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'one' }]), reply('end_turn', [{ type: 'text', text: 'two' }]), reply('end_turn', [{ type: 'text', text: 'three' }])]);
      const printed = [];
      const output = new Writable({
        write(chunk, _encoding, done) {
          printed.push(String(chunk));
          done();
        },
      });
      assert.equal(await chat(db, { model: 'opus', effort: 'high', send, input: Readable.from(['first question\nsecond question\nthird question\n']), output }), 0);
      assert.deepEqual(seen.map((p) => p.messages.at(-1).content[0].text), ['first question', 'second question', 'third question']);
      assert.match(printed.join(''), /one[\s\S]*two[\s\S]*three/);
    } finally {
      db.close();
    }
  });
});

test('what the user runs themselves is theirs to see in full, and reaches the model without its secrets', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      session.start('startup');
      assert.equal(await session.shell('echo token ghp_abcdefghijklmnopqrstuvwxyz0123456789'), 'token ghp_abcdefghijklmnopqrstuvwxyz0123456789');
      const told = session.params.messages.at(-1).content[0].text;
      assert.match(told, /^I ran `echo token ghp_[^`]*` myself:\ntoken \[redacted\]$/);
    } finally {
      db.close();
    }
  });
});

test('the commands of the menu work from inside a project: the guide comes with the command, and /dream runs here, where the credential is', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log'), PATH: '/usr/bin:/bin' }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([reply('tool_use', [call('t1', 'bash', { command: 'sumo dream run' })]), reply('end_turn', [{ type: 'text', text: 'nothing changed' }])]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');

      const fix = session.expand('/fix the login bug');
      assert.match(fix.text, /Make it fail on demand/, 'the guide itself, not a path the tools cannot reach from the project');
      assert.match(fix.text, /for this: the login bug$/);
      assert.equal(session.expand('/toString').error, 'no such command /toString — one of: /fix /feature /review /dream /model /memory /new /exit');

      const dream = session.expand('/dream');
      await session.say(dream.text, dream.said);
      assert.match(seen[1].messages.at(-1).content[0].content, /^nothing to do — |^read \d+ sessions/, 'the pass ran in this process');
    } finally {
      db.close();
    }
  });
});

test('/model after auto keeps the effort the user configured, not the built-in one', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      db.prepare("INSERT INTO meta (key, value) VALUES ('config.chat.effort', 'low')").run();
      const session = createChat(db, { model: 'auto', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      session.start('startup');
      assert.equal(session.route('opus'), 'opus/low');
    } finally {
      db.close();
    }
  });
});

test('memory answers a question only when the model ended its turn on one: after an error the error is what the user sees', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      add(db, { type: 'preference', body: 'Use the Atlas tracker board for every story', now: NOW });
      const seen = [];
      const answers = [reply('tool_use', [{ type: 'text', text: 'Which tracker board should I use for the story?' }, call('t1', 'bash', { command: 'true' })])];
      const send = async (params) => {
        seen.push(structuredClone(params));
        if (answers.length === 0) throw new Error('the API answered 529: overloaded');
        return answers.shift();
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      const outcome = await session.say('make a story for the login bug');
      assert.equal(outcome.stop, 'error');
      assert.equal(seen.length, 2, 'no third request was made on the strength of the earlier question');
    } finally {
      db.close();
    }
  });
});
