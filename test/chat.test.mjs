// The chat session: the memory block first, the policy raised in process, delegated jobs run inside the process, the session log.
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { describe, it, test } from 'node:test';
import { chat, createChat, injection } from '../src/chat.mjs';
import { MODEL_IDS, setModel } from '../src/catalog.mjs';
import { openDb } from '../src/db.mjs';
import { openWatchTab, reportAgent, startWatcher } from '../src/herdr.mjs';
import { finish, takeInbox } from '../src/jobs.mjs';
import { add, UsageError } from '../src/memory.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { closeMcp, readConfig, writeConfig } from '../src/mcp.mjs';
import { addProject } from '../src/projects.mjs';
import { lockFile, pruneStates, stateFile } from '../src/sessions.mjs';
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
        if (params.messages.some((m) => Array.isArray(m.content) && m.content.some((b) => b.type === 'image'))) throw Object.assign(new Error('400 image exceeds 10 MB maximum'), { status: 400 });
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

test('pictures sent while the API is overloaded stay with the turn: nothing was said against them', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const send = async () => {
        throw Object.assign(new Error('529 overloaded'), { status: 529 });
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      const failed = await session.say('what is [Image #1]?', 'what is [Image #1]?', [{ label: '[Image #1]', mediaType: 'image/png', data: 'Ymln' }]);
      assert.equal(failed.stop, 'error');
      const turn = session.params.messages.findLast((m) => m.role === 'user');
      assert.ok(turn.content.some((b) => b.type === 'image'), 'the picture is still in the turn');
    } finally {
      db.close();
    }
  });
});

test('a job the model delegates runs in this process, and a question memory can answer is answered before it reaches the user', async () => {
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
        reply('tool_use', [call('t1', 'delegate', { job: id })]), // the chat
        reply('end_turn', [{ type: 'text', text: 'scout report: nothing to see' }]), // the job, inside the same process
        reply('end_turn', []), // the job, told once that it never closed itself
        reply('end_turn', [{ type: 'text', text: 'Which tracker board are your tickets on?' }]), // the chat, ending on a question
        reply('end_turn', [{ type: 'text', text: 'Atlas it is.' }]), // the chat, continued with the memory
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, out: () => {}, now: () => NOW });
      session.start('startup');
      const outcome = await session.say('check simba');

      assert.equal(seen[1].model, 'claude-haiku-4-5-20251001', 'the job ran on its own route, not the chat model');
      assert.match(seen[2].messages.at(-1).content[0].text, /^You ended without closing the job/);
      assert.match(seen[3].messages.at(-1).content[0].content, /STATUS: never closed — j\d+[\s\S]*scout report/, 'the chat sees how the run ended, and what the job said last');
      assert.equal(outcome.text, 'Atlas it is.');
      const held = seen[4].messages.at(-1);
      assert.equal(held.role, 'user', 'after the assistant turn the memory goes as text; the API refuses a system message there');
      assert.match(held.content[0].text, /memory already holds[\s\S]*tracker board Atlas/);
      assert.equal(seen.length, 5);
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
        { reply: reply('tool_use', [call('t1', 'delegate', { job: 999 })]) },
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

test('a turn stopped before the model answered leaves no operator message stranded, and a delegated job stops with it', async () => {
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
        { reply: reply('tool_use', [call('t1', 'delegate', { job: id })]) },
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

/** Another open job in that project, its brief headed the way a real one is, so a test can tell whose request it is answering. */
function openJob(db, agent) {
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('simba', 'look', ?, 'running', null, ?, ?, 'haiku', 'none', 'test')`)
    .run(agent, NOW, NOW);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — look\n\n## The task\nlook around\n`);
  return id;
}

test('a delegated job is watched as it works, and what the user tells it reaches it with its next request', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-watch-');
      const open = {};
      const held = (name) => new Promise((r) => (open[name] = r));
      const watched = [];
      const { send, seen } = gated([
        { reply: reply('tool_use', [call('t1', 'delegate', { job: id })]) }, // the chat
        { reply: reply('tool_use', [{ type: 'text', text: 'looking' }, call('j1', 'bash', { command: 'echo hi' })]), gate: held('first') }, // the job
        { reply: reply('end_turn', [{ type: 'text', text: 'report one' }]), gate: held('second') }, // the job, about to end
        { reply: reply('end_turn', [{ type: 'text', text: 'because you asked' }]) }, // the job, answering what it was told
        { reply: reply('end_turn', []) }, // the job, told once that it never closed itself
        { reply: reply('end_turn', [{ type: 'text', text: 'done' }]) }, // the chat
      ]);
      const lines = [];
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, watch: (e) => watched.push(e), activity: (l) => lines.push(l), now: () => NOW });
      session.start('startup');
      assert.equal(session.tell('nobody is listening'), false, 'with no job running there is nobody to tell');

      const turn = session.say('check simba');
      await until(() => seen.length === 2, 'the job to be talking to its model');
      assert.equal(session.tell('stay in src'), id, 'a bare message reaches the one job running here');
      open.first();
      await until(() => seen.length === 3, "the job's second request");
      const heard = seen[2].messages.at(-1).content;
      assert.deepEqual(heard.map((b) => b.type), ['tool_result', 'text'], 'what the user said rides behind the tool results');
      assert.match(heard[1].text, /stay in src/);

      // Told while the job is ending: it gets one more request, so the message is read and answered.
      assert.equal(session.tell('and say why'), id);
      open.second();
      await until(() => seen.length >= 4, 'the request that carries the second message');
      assert.equal(seen[3].model, 'claude-haiku-4-5-20251001');
      assert.equal(seen[3].messages.at(-1).role, 'user');
      assert.match(seen[3].messages.at(-1).content[0].text, /and say why/);

      assert.equal((await turn).text, 'done');
      assert.equal(session.tell('too late'), false, 'the job is over');
      assert.match(seen[5].messages.at(-1).content[0].content, /STATUS: never closed — j\d+[\s\S]*because you asked/);

      const told = watched.filter((e) => e.type !== 'usage').map((e) => [e.type, e.job?.id ?? e.job ?? null, e.call?.id ?? e.text ?? null]);
      assert.deepEqual(told, [
        ['tool', null, 't1'],
        ['job', id, null],
        ['tool', id, 'j1'],
        ['result', id, 'j1'],
        ['job-end', id, null],
        ['result', null, 't1'],
      ]);
      assert.deepEqual(lines, [`delegate j${id}`, `j${id} $ echo hi`], 'without a screen, the same work is a line per call');
      const started = watched.find((e) => e.type === 'job').job;
      assert.deepEqual([started.agent, started.title, started.model], ['scout', 'look', 'haiku']);
      assert.deepEqual(watched.find((e) => e.type === 'result' && e.job === id).result, { content: 'hi', isError: false });
    } finally {
      db.close();
    }
  });
});

test('a job is not made or run from the shell: the model is pointed at delegate, and other job commands still run', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send, seen } = canned([
        reply('tool_use', [
          call('t1', 'bash', { command: 'sumo job run 7 2>&1 | tail -3' }),
          call('t2', 'bash', { command: 'cd /tmp && nohup sumo job run 7 > /tmp/j7.log 2>&1 &' }),
          call('t3', 'bash', { command: 'sumo job new --project simba --title look <<EOF\nlook\nEOF' }),
          call('t4', 'bash', { command: 'echo "see: sumo job run 7"' }),
          call('t5', 'bash', { command: 'sumo job show 7' }),
        ]),
        reply('end_turn', [{ type: 'text', text: 'ok' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, now: () => NOW });
      session.start('startup');
      await session.say('run job 7');
      const [piped, nohupped, made, quoted, other] = seen[1].messages.at(-1).content;
      for (const refused of [piped, nohupped, made]) {
        assert.equal(refused.is_error, true, refused.content);
        assert.match(refused.content, /from the shell: use the delegate tool/);
      }
      assert.equal(quoted.content, 'see: sumo job run 7', 'words about a job run are not one');
      assert.match(other.content, /no job j7/, 'other job commands still run in the shell');
      assert.ok(seen[0].tools.some((t) => t.name === 'delegate'), 'the chat model is given the tool');
      assert.ok(seen[0].system[0].text.includes(`read ${join(REPO_ROOT, 'guides')}/delegation.md first`), 'the guide is named where it is, not where the chat was started');
    } finally {
      db.close();
    }
  });
});

test('jobs delegated in one reply run side by side; a second worker in the same project is refused, and a bare message must name its job', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const first = scoutJob(db, 'sumo-agents-chat-side-');
      writeFileSync(join(paths().jobs, String(first), 'brief.md'), `# Job j${first} — look\n\n## The task\nlook around\n`);
      const second = openJob(db, 'scout');
      const worker = openJob(db, 'worker');
      const busy = openJob(db, 'worker');
      // A job's requests wait until the test lets that job go; once let go, it stays so (a job told something asks once more).
      const open = {};
      const gates = {};
      const held = (name) => (gates[name] ??= new Promise((r) => (open[name] = r)));
      // Each job's request is answered by which job is asking: its brief is its first message.
      const replies = {
        chat: [
          reply('tool_use', [call('t1', 'delegate', { job: first }), call('t2', 'delegate', { job: second }), call('t3', 'delegate', { job: worker }), call('t4', 'delegate', { job: busy })]),
          reply('end_turn', [{ type: 'text', text: 'all back' }]),
        ],
      };
      const seen = [];
      const send = async (params) => {
        seen.push(structuredClone(params));
        const brief = params.messages[0]?.content?.[0]?.text ?? '';
        const job = /^# Job j(\d+)/.exec(brief)?.[1];
        if (!job) return replies.chat.shift();
        await held(`j${job}`);
        const told = JSON.stringify(params.messages).includes('hurry');
        return reply('end_turn', [{ type: 'text', text: told ? `j${job} hurried` : `j${job} saw nothing` }]);
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      const turn = session.say('look at simba three ways');

      await until(() => open[`j${first}`] && open[`j${second}`] && open[`j${worker}`], 'all three jobs to be talking to their models at once');
      assert.throws(() => session.tell('hurry'), /are running — name the one: @j<id>/);
      assert.equal(session.tell('hurry', second), second);
      open[`j${second}`]();
      open[`j${worker}`]();
      open[`j${first}`]();

      assert.equal((await turn).text, 'all back');
      const results = seen.at(-1).messages.at(-1).content;
      assert.deepEqual(results.map((r) => r.tool_use_id), ['t1', 't2', 't3', 't4'], 'each call answered, in the order it was made');
      assert.match(results[0].content, new RegExp(`STATUS: never closed — j${first}[\\s\\S]*j${first} saw nothing`));
      assert.match(results[1].content, new RegExp(`j${second} hurried`), 'the named job read what it was told');
      assert.equal(results[3].is_error, true);
      assert.match(results[3].content, /a worker is already running in simba/);
      assert.equal(paired(seen.at(-1).messages), true);
    } finally {
      db.close();
    }
  });
});

test('a delegated brief becomes a job on the route the router chose, and the report it closed with comes back whole', async () => {
  const routerAnswer = join(mkdtempSync(join(tmpdir(), 'sumo-agents-router-')), 'answer.json');
  writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { model: 'sonnet', effort: 'medium', reason: 'small' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  const env = { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log'), SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer };
  await withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-brief-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const task = '## Goal\nfind where briefings are sent\n## Check\nnone: describe only';
      const { send: replay, seen } = canned([
        reply('tool_use', [call('t1', 'delegate', { agent: 'reviewer', project: 'simba', title: 'judge', task: 'x' }), call('t2', 'delegate', { agent: 'scout', project: 'nowhere', title: 'look', task })]),
        reply('tool_use', [call('t3', 'delegate', { agent: 'scout', project: 'simba', title: 'find briefings', task })]),
        reply('end_turn', [{ type: 'text', text: 'STATUS: DONE — j1' }]),
        reply('end_turn', [{ type: 'text', text: 'found it' }]),
      ]);
      // The job closes itself as its brief says, before its last word: what `sumo job finish` does from its shell.
      const send = (params, options) => {
        if (/^# Job j1 /.test(params.messages[0]?.content?.[0]?.text ?? '')) finish(db, 1, { status: 'DONE', report: '## Summary\nbriefings go out from src/send.mjs\nthe key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789' }, NOW);
        return replay(params, options);
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      session.start('startup');
      assert.equal((await session.say('where do briefings go out?')).text, 'found it');

      const [review, nowhere] = seen[1].messages.at(-1).content;
      assert.equal(review.is_error, true, 'a review of nothing is refused before a job exists');
      assert.match(nowhere.content, /nowhere/);
      assert.match(seen[2].messages[0].content[0].text, /^# Job j1 — find briefings[\s\S]*You are a scout[\s\S]*find where briefings are sent/, "the brief is the job's first message");
      assert.equal(seen[2].model, 'claude-sonnet-5-5', 'the job runs on the route the router chose');
      assert.deepEqual(seen[2].output_config, { effort: 'medium' });
      const done = seen[3].messages.at(-1).content[0];
      assert.match(done.content, /^STATUS: DONE — j1/);
      assert.match(done.content, /## Summary\nbriefings go out from src\/send\.mjs/, 'the report itself, not a pointer to it');
      assert.match(done.content, /the key is \[redacted\]/, 'a report is model-written: redacted like any tool output');
      assert.deepEqual(db.prepare('SELECT id, agent, status FROM jobs').all().map((j) => ({ ...j })), [{ id: 1, agent: 'scout', status: 'done' }]);
    } finally {
      db.close();
    }
  });
});

test('inside Herdr a delegated job also gets a tab that watches it, while it runs here; a tab Herdr will not open costs the job nothing', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-tab-');
      const project = db.prepare('SELECT path FROM projects').get().path;
      const calls = [];
      // The first tab opens and its shell runs the watcher once it is typed; when the second is asked for, Herdr is not there.
      let tabs = 0;
      let typed = false;
      const herdr = (args) => {
        calls.push(args);
        if (args[0] === 'tab' && tabs++ > 0) return { error: Object.assign(new Error('spawnSync herdr ENOENT'), { code: 'ENOENT' }) };
        if (args[0] === 'tab') return { status: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w2:pJ' } } }) };
        if (args[1] === 'run') return (typed = true), { status: 0, stdout: '' };
        if (args[1] === 'read') return { status: 0, stdout: '~ >' };
        return { status: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 7, foreground_processes: typed ? [{ pid: 8, cmdline: `node sumo job watch ${id}` }] : [{ pid: 7, cmdline: '-zsh' }] } } }) };
      };
      const watched = [];
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'delegate', { job: id })]),
        reply('end_turn', [{ type: 'text', text: 'looked' }]),
        reply('end_turn', []),
        reply('tool_use', [call('t2', 'delegate', { job: id })]),
        reply('end_turn', [{ type: 'text', text: 'looked again; the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789, then sk-ant-api03-abcdefghijk\x01lmnopqrstuvwxyz0123456789, then sk-ant-api03-abcdefghijk\x1b[0mlmnopqrstuvwxyz0123456789' }]),
        reply('end_turn', []),
        reply('end_turn', [{ type: 'text', text: 'fine' }]),
      ]);
      const env = { HERDR_ENV: '1', HERDR_WORKSPACE_ID: 'w2' };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, herdr, env, watch: (e) => watched.push(e), now: () => NOW });
      session.start('startup');
      await session.say('have a scout look, twice');
      await until(() => typed, 'the watcher typed into its tab');

      assert.deepEqual(calls[0], ['tab', 'create', '--workspace', 'w2', '--cwd', project, '--label', `j${id} scout · look`, '--no-focus']);
      assert.deepEqual(calls.find((c) => c[1] === 'run'), ['pane', 'run', 'w2:pJ', `env SUMO_JOB_TAB=1 SUMO_AGENTS_HOME=${paths().home} ${paths().launcher} job watch ${id}`], 'the tab watches; the job is not run there');
      const [first, second] = watched.filter((e) => e.type === 'job').map((e) => e.tab);
      assert.deepEqual(first, { pane: 'w2:pJ' });
      assert.deepEqual(second, { error: '`herdr` is not on PATH' });
      assert.match(seen[3].messages.at(-1).content[0].content, new RegExp(`STATUS: never closed — j${id}[\\s\\S]*looked`), 'the job ran here, tab or not');
      assert.match(seen[6].messages.at(-1).content[0].content, /looked again/);
      const record = readFileSync(join(paths().jobs, String(id), 'live.log'), 'utf8');
      assert.match(record, /looked again; the key is \[redacted\], then \[redacted\], then \[redacted\]/, 'what a job writes reaches its record without its secrets — also a key broken up by an escape');
      assert.doesNotMatch(record, /\x1b|\x01/);
    } finally {
      db.close();
    }
  });
});

test('@j<id> reaches a job this chat is not running through its inbox on disk, and a job that is not there is said back', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const id = scoutJob(db, 'sumo-agents-chat-inbox-');
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send: canned([]).send, now: () => NOW });
      session.start('startup');
      assert.equal(session.tell('only go and ui', id), id);
      assert.deepEqual(takeInbox(id), ['only go and ui']);
      assert.throws(() => session.tell('hello?', 999), /no job j999/);
    } finally {
      db.close();
    }
  });
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

test('piped in but shown on a terminal, nothing the model or a command prints can drive that terminal', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send } = canned([reply('end_turn', [{ type: 'text', text: 'hi \x1b]0;MODEL-TITLE\x07there' }])]);
      const printed = [];
      const output = new Writable({
        write(chunk, _encoding, done) {
          printed.push(String(chunk));
          done();
        },
      });
      output.isTTY = true;
      output.columns = 80;
      const input = Readable.from(["!printf 'a\\033]52;c;cHduZWQ=\\007b'\n!printf '10%%\\r50%%\\r100%%'\nhello\n"]);
      input.isTTY = false;
      assert.equal(await chat(db, { model: 'opus', effort: 'high', send, input, output }), 0);
      const all = printed.join('');
      assert.doesNotMatch(all, /\x1b\]/, 'no OSC sequence: no clipboard write, no window title');
      assert.doesNotMatch(all, /\x07/);
      assert.match(all, /a\]52;c;cHduZWQ=b/);
      assert.match(all, /hi \]0;MODEL-TITLEthere/);
      assert.match(all, /10%\n50%\n100%/, 'a progress bar redrawn in place reads as lines, not one run-on word');
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
      assert.equal(told, 'I ran `echo token [redacted]` myself:\ntoken [redacted]');
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
      assert.equal(session.expand('/toString').error, 'no such command /toString — one of: /fix /feature /review /dream /model /memory /mcp /resume /new /exit');

      const dream = session.expand('/dream');
      await session.say(dream.text, dream.said);
      assert.match(seen[1].messages.at(-1).content[0].content, /^nothing to do — |^read \d+ sessions/, 'the pass ran in this process');
    } finally {
      db.close();
    }
  });
});

test('a session is saved after every turn, without its pictures or secrets, and picked up where it stopped — by one terminal at a time', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const LATER = '2026-09-30T15:00:00.000Z';
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-chat-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const { send } = canned([
        reply('tool_use', [{ type: 'text', text: 'looking' }, call('t1', 'bash', { command: 'echo looked' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }], { input_tokens: 42_000, output_tokens: 10 }),
      ]);
      const first = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, now: () => NOW });
      first.start('startup');
      const id = first.sessionId;
      const short = id.slice(0, 8);
      assert.equal(existsSync(lockFile(id)), true, 'an open session holds its lock');
      assert.equal(existsSync(stateFile(id)), false, 'a session nobody has spoken to is not kept');

      await first.say('[Image #1] fix the briefing bug in simba with ghp_abcdefghijklmnopqrstuvwxyz0123456789', undefined, [{ label: '[Image #1]', mediaType: 'image/png', data: 'aGk=' }]);
      const state = JSON.parse(readFileSync(stateFile(id), 'utf8'));
      assert.equal(state.version, 1);
      assert.deepEqual([state.model, state.effort, state.contextTokens, state.cwd], ['opus', 'high', 42_010, '/']);
      assert.equal(state.messages.length, first.params.messages.length, 'the whole conversation: the block, the turn, the card, the calls and their results');
      assert.equal(JSON.stringify(state).includes('ghp_abc'), false, 'the token the user pasted is not in the file');
      assert.equal(JSON.stringify(state).includes('"image"'), false, 'the picture is not in the file');
      assert.match(state.messages[1].content[1].text, /^\[a picture was here/);
      assert.equal(state.messages[1].content[0].text, '[Image #1]', 'its label stays, so the words that name it still make sense');
      assert.equal(JSON.stringify(state).includes('cache_control'), false);
      first.end();
      assert.equal(existsSync(lockFile(id)), false, 'the lock goes with the session');

      // Picked up in a new chat, with no route of its own: the saved one comes back, the size too, and the model is told once.
      const { send: send2, seen } = canned([reply('end_turn', [{ type: 'text', text: 'carrying on' }])]);
      const second = createChat(db, { cwd: '/work', send: send2, now: () => LATER });
      const line = second.resume(short);
      assert.equal(line, `resumed ${short} · 3h ago · simba · “[Image #1] fix the briefing bug in simba with [redacted]” · 1 turn · 42k tokens — the first reply pays one uncached turn`);
      assert.equal(second.sessionId, id);
      assert.deepEqual([second.model, second.effort, second.contextTokens], ['opus', 'high', 42_010]);
      assert.deepEqual(second.params.messages, state.messages, 'the conversation as it was kept');
      assert.equal(db.prepare('SELECT ended_at FROM sessions WHERE id = ?').get(id).ended_at, null, 'the session is open again');
      await second.say('and the next bit');
      const sent = seen[0].messages;
      assert.equal(sent.length, state.messages.length + 2, 'the whole history, the new turn, and the note');
      assert.equal(sent.at(-2).content[0].text, 'and the next bit');
      assert.match(sent.at(-1).content, /^resumed: this session was saved 3h ago and picked up again now, in \/work\. Carry on where it stopped/);
      assert.equal(sent.filter((m) => m.role === 'system' && /^<project simba>/.test(m.content)).length, 1, 'the card shown before is not shown again');
      assert.equal(seen[0].messages.at(-1).content.includes('resumed:'), true);
      assert.equal(JSON.parse(readFileSync(stateFile(id), 'utf8')).messages.length, sent.length + 1, 'saved again after the turn, reply included');

      // Held here, it cannot be picked up elsewhere; the refusal changes nothing there. A route the chat was started with holds over the saved one.
      const third = createChat(db, { model: 'sonnet', effort: 'low', cwd: '/', send: () => assert.fail('nothing here talks to the model'), now: () => LATER });
      third.start('startup');
      const own = third.sessionId;
      assert.throws(() => third.resume(short), new RegExp(`^Error: session ${short} is open in another terminal \\(process ${process.pid}\\)$`));
      assert.equal(third.sessionId, own);
      assert.match(third.saved().join('\n'), new RegExp(`^${short} · .* · open in another terminal \\(process ${process.pid}\\)$`));
      assert.throws(() => third.resume('zzz'), new RegExp(`^Error: no saved session starts with "zzz" — one of: ${short}$`));
      second.end();
      third.resume(short);
      assert.deepEqual([third.sessionId, third.model, third.effort], [id, 'sonnet', 'low']);
      assert.equal(third.saved().length, 0, 'a session does not offer itself');
      third.end();

      // Kept for thirty days; the hook that opens a session lets older ones go, and leaves the log the dream pass reads.
      const old = new Date(Date.parse(NOW) - 31 * 24 * 3_600_000);
      utimesSync(stateFile(id), old, old);
      assert.equal(pruneStates(NOW), 1);
      assert.equal(existsSync(stateFile(id)), false);
      assert.equal(existsSync(join(paths().logs, 'sessions', `${id}.jsonl`)), true);
      assert.equal(pruneStates(NOW), 0);
    } finally {
      db.close();
    }
  });
});

test('piped, /resume alone lists the saved sessions and /resume <id> picks one up; a refused one is said and the chat goes on', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send: before } = canned([reply('end_turn', [{ type: 'text', text: 'noted' }])]);
      const earlier = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send: before, now: () => NOW });
      earlier.start('startup');
      await earlier.say('plan the briefing redesign');
      earlier.end();
      const short = earlier.sessionId.slice(0, 8);

      const { send, seen } = canned([reply('end_turn', [{ type: 'text', text: 'as we said' }])]);
      const printed = [];
      const output = new Writable({
        write(chunk, _encoding, done) {
          printed.push(String(chunk));
          done();
        },
      });
      assert.equal(await chat(db, { model: 'opus', effort: 'high', send, input: Readable.from(['/resume\n', '/resume nope\n', `/resume ${short}\n`, 'go on\n']), output }), 0);
      const all = printed.join('');
      // The piped chat keeps real time, so how long ago is whatever it is today.
      assert.match(all, new RegExp(`>   ${short} · (?:just now|\\d+[hd] ago) · no project · “plan the briefing redesign” · 1 turn · \\d+k tokens\n`), 'the list');
      assert.match(all, /no saved session starts with "nope" — one of: /);
      assert.match(all, new RegExp(`⎿  resumed ${short} · (?:just now|\\d+[hd] ago) · no project`));
      assert.equal(seen.length, 1);
      assert.equal(seen[0].messages[1].content[0].text, 'plan the briefing redesign', 'the model reads the earlier conversation');
      assert.equal(seen[0].messages.at(-2).content[0].text, 'go on');
      assert.match(all, /as we said/);
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

test('a model that is off cannot be chatted on: not by configuration, not by /model, and the menu does not offer it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      setModel(db, 'fable', false, NOW);
      assert.throws(
        () => createChat(db, { model: 'fable', effort: 'high', cwd: tmpdir(), send: () => assert.fail('never sent'), now: () => NOW }),
        (err) => err instanceof UsageError && err.message === 'fable is off — sumo models enable fable, or sumo config chat.model <name>',
      );

      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('never sent'), now: () => NOW });
      session.start('startup');
      assert.throws(() => session.route('fable'), /fable is off — sumo models enable fable/);
      assert.equal(session.route(''), 'opus/high', 'a refused change changes nothing');
      const model = session.commands.find((c) => c.name === 'model');
      assert.deepEqual(model.choices([]), ['auto', 'haiku', 'sonnet', 'opus']);
      setModel(db, 'fable', true, NOW);
      assert.deepEqual(model.choices([]), ['auto', 'haiku', 'sonnet', 'opus', 'fable'], 'the menu reads the switches as they are now');
      assert.equal(session.route('fable'), 'fable/high');
    } finally {
      db.close();
    }
  });
});

test('Enter on the /model menu after a model keeps the effort in hand, never drops it to the lowest', async () => {
  const { editor, press } = await import('../src/editor.mjs');
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const session = createChat(db, { model: 'opus', effort: 'xhigh', cwd: tmpdir(), send: () => assert.fail('never sent'), now: () => '2026-10-05T00:00:00.000Z' });
      session.start('startup');
      let state = editor();
      for (const ch of '/model sonnet ') state = press(state, ch, {}, session.commands).state;
      const picked = press(state, '\r', { return: true }, session.commands).state.text;
      assert.equal(picked, '/model sonnet xhigh ');
      assert.equal(session.route('sonnet xhigh'), 'sonnet/xhigh');
      const menu = session.commands.find((c) => c.name === 'model');
      assert.deepEqual([...menu.choices(['opus'])].sort(), ['high', 'low', 'max', 'medium', 'xhigh'], 'every effort is still offered');
    } finally {
      db.close();
    }
  });
});

test('Esc ends the turn while the router is still thinking, without waiting for it to answer', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      let fail;
      const route = () => new Promise((_resolve, reject) => (fail = reject));
      const session = createChat(db, { model: 'auto', cwd: tmpdir(), send: () => assert.fail('nothing is sent'), route, now: () => '2026-10-05T00:00:00.000Z' });
      session.start('startup');
      const turn = session.say('rewrite the whole scheduler');
      await new Promise((r) => setTimeout(r, 10));
      session.interrupt();
      const ended = await Promise.race([turn, new Promise((r) => setTimeout(() => r('still waiting on the router'), 500))]);
      assert.equal(ended.stop, 'interrupted');
      fail(new Error('the router answers late, and badly')); // let go unread: no unhandled rejection
      await new Promise((r) => setTimeout(r, 10));
    } finally {
      db.close();
    }
  });
});

test('on auto, the /model menu offers first the effort a model alone would keep: the configured one', async () => {
  const { setMeta } = await import('../src/db.mjs');
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      setMeta(db, 'config.chat.effort', 'medium');
      const session = createChat(db, { model: 'auto', cwd: tmpdir(), send: () => assert.fail('never sent'), now: () => '2026-10-05T00:00:00.000Z' });
      session.start('startup');
      assert.equal(session.commands.find((c) => c.name === 'model').choices(['opus'])[0], 'medium');
      assert.equal(session.route('opus'), 'opus/medium');
    } finally {
      db.close();
    }
  });
});

test('a model named by its full API id is switched off with it', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      setModel(db, 'fable', false, '2026-10-05T00:00:00.000Z');
      assert.throws(() => createChat(db, { model: MODEL_IDS.fable, effort: 'high', cwd: tmpdir(), send: () => assert.fail('never sent') }), /fable is off/);
    } finally {
      db.close();
    }
  });
});

describe('the watcher in a job\'s Herdr tab', () => {
  /** A pane whose shell starts slowly and throws away what is typed before its prompt: `swallow` runs are lost. */
  const pane = ({ swallow = 0, starts = true } = {}) => {
    const calls = [];
    let polls = 0;
    let running = false;
    const herdr = (args) => {
      calls.push(args.slice(0, 2).join(' '));
      if (args[1] === 'run') {
        if (swallow > 0) swallow--;
        else running = starts;
        return { status: 0, stdout: '' };
      }
      polls++;
      if (args[1] === 'read') return { status: 0, stdout: polls < 6 ? `loading ${polls}` : 'prodsec git:(main) x' };
      const foreground = running ? [{ pid: 9, cmdline: 'node /x/sumo job watch 32' }] : polls < 6 ? [{ pid: 7, cmdline: '-zsh' }, { pid: 8, cmdline: 'git status' }] : [{ pid: 7, cmdline: '-zsh' }];
      return { status: 0, stdout: JSON.stringify({ result: { process_info: { shell_pid: 7, foreground_processes: foreground } } }) };
    };
    return { herdr, calls };
  };
  const sleep = async () => {};

  it('waits for the shell to stand at its prompt before typing, and types once when the watcher starts', async () => {
    const { herdr, calls } = pane();
    assert.equal(await startWatcher(herdr, { pane: 'w2:p1', job: 32, command: 'sumo job watch 32', sleep }), true);
    assert.deepEqual(calls.filter((c) => c === 'pane run'), ['pane run']);
    // The screen shows the shell loading for the first polls, then its prompt twice in a row: only then is the watcher typed.
    assert.equal(calls.slice(0, calls.indexOf('pane run')).filter((c) => c === 'pane read').length, 4, `typed only once the screen had settled: ${calls.join(', ')}`);
  });

  it('types the watcher again when the shell threw the first away, and stops once it runs', async () => {
    const { herdr, calls } = pane({ swallow: 1 });
    assert.equal(await startWatcher(herdr, { pane: 'w2:p1', job: 32, command: 'sumo job watch 32', sleep }), true);
    assert.equal(calls.filter((c) => c === 'pane run').length, 2);
  });

  it('gives up after a few tries and says so, instead of claiming a tab that shows nothing', async () => {
    const { herdr, calls } = pane({ starts: false });
    assert.equal(await startWatcher(herdr, { pane: 'w2:p1', job: 32, command: 'sumo job watch 32', sleep }), false);
    assert.equal(calls.filter((c) => c === 'pane run').length, 3);
  });

  it('is not fooled by another job\'s watcher: j3 is not j32', async () => {
    const { herdr, calls } = pane({ starts: true });
    assert.equal(await startWatcher(herdr, { pane: 'w2:p1', job: 3, command: 'sumo job watch 3', sleep }), false);
    assert.equal(calls.filter((c) => c === 'pane run').length, 3);
  });

  it('opens the tab at once and tells the chat later when its watcher never started', async () => {
    const { herdr } = pane({ starts: false });
    const opening = (args) => (args[0] === 'tab' ? { status: 0, stdout: JSON.stringify({ result: { root_pane: { pane_id: 'w2:p1' } } }) } : herdr(args));
    const failed = [];
    const tab = openWatchTab(opening, { job: { id: 32, agent: 'reviewer', title: 'Review it' }, project: { path: '/p' }, env: {}, sleep, onFail: (why) => failed.push(why) });
    assert.equal(tab, 'w2:p1', 'the tab is there before its watcher is');
    await until(() => failed.length > 0, 'the chat told the watcher never started');
    assert.deepEqual(failed, ['its Herdr tab never started the watcher']);
  });
});

/** The fake MCP server, and a server that is not there, configured in the home in hand. */
function mcpServers() {
  mkdirSync(paths().home, { recursive: true, mode: 0o700 });
  writeConfig({ mcpServers: { demo: { command: process.execPath, args: [join(REPO_ROOT, 'test', 'fixtures', 'fake-mcp-server.mjs')] }, broken: { command: '/no/such/server' } } });
}

test('the chat offers the MCP tools behind tool search, names the servers to the model, tells the screen which failed, and holds every call to the allow list: asked each time until the user says always', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      mcpServers();
      const watched = [];
      const asked = [];
      const answers = ['no', 'always'];
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'mcp__demo__echo', { text: 'one' })]),
        reply('tool_use', [call('t2', 'mcp__demo__echo', { text: 'two' })]),
        reply('tool_use', [call('t3', 'mcp__demo__echo', { text: 'three' })]),
        reply('end_turn', [{ type: 'text', text: 'done' }]),
      ]);
      const approve = async (ask) => {
        asked.push(ask);
        return answers.shift();
      };
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send, watch: (e) => watched.push(e), approve, now: () => NOW });
      session.start('startup');
      await session.say('echo things');

      const first = seen[0];
      assert.deepEqual(first.tools.map((t) => t.name).slice(0, 4), ['bash', 'str_replace_based_edit_tool', 'delegate', 'tool_search_tool_regex']);
      assert.equal(first.tools.length, 4 + 9);
      assert.ok(first.tools.slice(4).every((t) => t.defer_loading === true && t.name.startsWith('mcp__demo__')), 'the MCP tools are deferred, so none of them sits in the context');
      assert.match(first.system[0].text, /demo \(9 tools\)/, 'the model is told which servers there are');
      assert.doesNotMatch(first.system[0].text, /broken/);
      const told = watched.find((e) => e.type === 'mcp');
      assert.deepEqual(told.servers.filter((s) => !s.ok).map((s) => s.name), ['broken'], 'the screen is told what failed');
      const result = (i) => seen[i].messages.at(-1).content[0];
      assert.equal(result(1).is_error, true);
      assert.match(result(1).content, /declined/);
      assert.equal(result(2).content, 'you said: two');
      assert.equal(result(3).content, 'you said: three');
      assert.deepEqual(asked.map((a) => a.tool), ['echo', 'echo'], 'asked about the first two calls; the third ran on the answer to the second');
      assert.equal(asked[0].job, null, 'the chat\'s own call, no job');
      assert.deepEqual(readConfig().mcpServers.demo.allow, ['echo']);

      // A fresh session keeps the tools and the line about them.
      session.end();
      session.start('new');
      assert.ok(session.params.tools.some((t) => t.name === 'tool_search_tool_regex'));
      assert.match(session.params.system[0].text, /demo \(9 tools\)/);

      // /mcp says what is connected and what may run unasked, as `sumo mcp` does.
      assert.deepEqual(session.expand('/mcp'), { control: 'mcp', args: '' });
      const shown = (await session.mcp()).join('\n');
      assert.match(shown, /demo\s+stdio: [\s\S]*9 tools · allowed: echo/);
      assert.match(shown, /broken\s+stdio: \/no\/such\/server\n\s+failed: /);

      // Nobody to ask — piped in, say — and a tool that is not allowed is refused with the way to allow it.
      const piped = canned([reply('tool_use', [call('t4', 'mcp__demo__shout', {})]), reply('end_turn', [{ type: 'text', text: 'could not' }])]);
      const quiet = createChat(db, { model: 'opus', effort: 'high', cwd: '/', send: piped.send, now: () => NOW });
      quiet.start('startup');
      await quiet.say('shout');
      const refused = piped.seen[1].messages.at(-1).content[0];
      assert.equal(refused.is_error, true);
      assert.match(refused.content, /needs the user's approval[\s\S]*sumo mcp allow demo shout/);

      // Piped, /mcp prints the same lines under the mark a command's result gets.
      const printed = [];
      const output = new Writable({
        write(chunk, _encoding, done) {
          printed.push(String(chunk));
          done();
        },
      });
      await chat(db, { model: 'opus', effort: 'high', send: () => assert.fail('nothing is asked of the model'), input: Readable.from(['/mcp\n']), output });
      assert.match(printed.join(''), /⎿  demo\s+stdio: [\s\S]*9 tools · allowed: echo/);
    } finally {
      await closeMcp();
      db.close();
    }
  });
});

test('a job delegated from the chat asks on the chat\'s screen when it wants an MCP tool, with its own id on the question', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      mcpServers();
      const id = scoutJob(db, 'sumo-agents-chat-mcp-');
      const asked = [];
      const { send, seen } = canned([
        reply('tool_use', [call('t1', 'delegate', { job: id })]),
        reply('tool_use', [call('t2', 'mcp__demo__echo', { text: 'from the job' })]),
        reply('end_turn', [{ type: 'text', text: 'looked' }]),
        reply('end_turn', []),
        reply('end_turn', [{ type: 'text', text: 'fine' }]),
      ]);
      const session = createChat(db, {
        model: 'opus',
        effort: 'high',
        cwd: '/',
        send,
        approve: async (ask) => {
          asked.push(ask);
          return 'once';
        },
        now: () => NOW,
      });
      session.start('startup');
      await session.say('have the scout echo');
      assert.equal(asked.length, 1);
      assert.equal(asked[0].job, id);
      assert.equal(asked[0].name, 'mcp__demo__echo');
      assert.equal(seen[2].messages.at(-1).content[0].content, 'you said: from the job', 'the job got its answer');
      assert.equal(readConfig().mcpServers.demo.allow, undefined, 'once is not kept');
    } finally {
      await closeMcp();
      db.close();
    }
  });
});
