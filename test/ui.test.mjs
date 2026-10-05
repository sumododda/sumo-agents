// The chat on screen: the box you type in, the line that says it is working, the work as it happens, and the keys that stop it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat } from '../src/chat.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { add } from '../src/memory.mjs';
import { takeInbox } from '../src/jobs.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
const ENTER = '\r';
const ESC = '\x1b';
const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage, model: 'claude-opus-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
/** The first row of the name at the top of the chat: where the latest drawing starts. */
const MARK = '█▀▀ █ █ █▀▄▀█ █▀█';

/** The screen closing; a screen that stays up is a failure, not a test that never ends. */
const leaves = (ui) => Promise.race([ui.waitUntilExit(), new Promise((_, no) => setTimeout(() => no(new Error('the screen never closed')), 4000).unref())]);

/** A gate the test opens when it has looked at the screen. */
function gate() {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
}

const transport = (responses) => {
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
      next.gate.promise.then(deliver);
    });
  return { send, seen };
};

test('the screen: a box to type in, a working line with the user\'s own words, the work shown as it happens, queued and interrupted turns', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      add(db, { type: 'preference', body: 'Always squash before merging', now: NOW });
      const first = gate();
      const second = gate();
      const { send, seen } = transport([
        { reply: reply('tool_use', [{ type: 'text', text: 'on it' }, call('t1', 'bash', { command: 'echo one; echo two; echo three; echo four' })], { input_tokens: 100, output_tokens: 1500 }), gate: first },
        { reply: reply('end_turn', [{ type: 'text', text: 'all **done**\n\n- tidy' }], { input_tokens: 12_000, output_tokens: 400 }) },
        { reply: reply('end_turn', [{ type: 'text', text: 'the queued one is answered' }]), gate: second },
        { reply: reply('end_turn', [{ type: 'text', text: 'never said' }]), gate: gate() },
      ]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty();
      const written = [];
      const write = tty.stdout.write;
      tty.stdout.write = (frame) => written.push(String(frame)) && write(frame);
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Salting the ring'], cwd: '/work/here', debug: true });
      try {
        const shows = async (pattern, what) => {
          for (let i = 0; i < 300; i++) {
            if (pattern.test(tty.screen())) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
        };

        // Opening: who is answering and a bordered box to type in. The memory goes to the model, not to the top of every chat.
        await shows(/opus · high/, 'the footer');
        assert.equal(written[0], '\x1b[2J\x1b[3J\x1b[H', 'the window wiped first: the chat starts at its top, not under the shell line that started it');
        assert.match(tty.screen(), /^\n█▀▀ █ █ █▀▄▀█ █▀█ +opus · high\n▄▄█ █▄█ █ ▀ █ █▄█ +\/work\/here$/m, 'a row of air, then the name in blocks, who is answering and where beside it');
        assert.doesNotMatch(tty.screen(), /Always squash before merging/, 'the memory block is not printed');
        assert.match(tty.screen(), /╭─+╮\n│ > .*│\n╰─+╯/, 'the input box');
        // A terminal answering the keyboard-protocol query late: the answer is not something the user typed.
        await tty.type('\x1b[?0u');
        assert.match(tty.screen(), /│ > \s+│/, 'the box is still empty');
        assert.match(tty.screen(), /opus · high/, 'the model and effort under the box');

        // A turn: what was typed, then the working line while the reply is held.
        await tty.type('fix it', ENTER);
        await shows(/Salting the ring…/, 'the working line');
        // The words stand at the start of the line, nothing in front of them, and stay where they are while the colours flow through them.
        for (let i = 0; i < 10; i++) {
          const line = tty.screen().split('\n').find((l) => l.includes('Salting the ring…'));
          assert.ok(line.startsWith('Salting the ring… ('), `the words where they were: ${line}`);
          await new Promise((r) => setTimeout(r, 50));
        }
        assert.match(tty.screen(), /> fix it/);
        assert.match(tty.screen(), /esc to interrupt/);
        assert.equal(seen[0].messages.at(-1).content[0].text, 'fix it');
        assert.match(JSON.stringify(seen[0]), /Always squash before merging/, 'the model still starts from the memory');

        // Typed while it works: held in a queue, shown, and sent when the turn ends.
        await tty.type(`and then this${ENTER}`);
        await shows(/queued: and then this/, 'the queued message');
        assert.equal(seen.length, 1, 'nothing is sent while a turn is running');

        first.open();
        await shows(/⏺ all done/, 'the end of the first turn');
        assert.match(tty.screen(), /⏺ on it/, 'the reply');
        assert.match(tty.screen(), /⏺ Bash\(echo one; echo two; echo three; echo four\)\n\s+⎿\s+one\n\s+two\n\s+three\n\s+… \+1 lines/, 'the tool call and the top of its output');
        assert.match(tty.screen(), /⏺ all done\n\s*\n\s+• tidy/, 'markdown is rendered, not shown raw');

        await shows(/\n> and then this/, 'the queued message being sent');
        await shows(/opus · high · 12k/, 'the size of the context under the box');
        assert.doesNotMatch(tty.screen(), /queued:/);
        assert.equal(seen[2].messages.at(-1).content[0].text, 'and then this');
        second.open();
        await shows(/⏺ the queued one is answered/, 'the answer to the queued message');
        await shows(/^(?![\s\S]*esc to interrupt)/, 'the working line gone once the work is done');

        // Esc stops a turn.
        await tty.type('long one', ENTER);
        await shows(/esc to interrupt/, 'the working line again');
        await tty.type(ESC);
        await shows(/Interrupted/, 'the interruption');
        assert.equal(seen.length, 4);

        // The command menu, and the way out.
        await tty.type('/');
        await shows(/\/fix[\s\S]*\/feature[\s\S]*\/memory[\s\S]*\/exit/, 'the command menu');
        await tty.type('e', '\t');
        await shows(/│ > \/exit/, 'the completed command');
        await tty.type(ENTER);
        await leaves(ui);
      } finally {
        // A failed look at the screen must not leave it drawing: the run would never end.
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('the screen is as wide as the window; Ctrl-C clears what is typed, then asks once before it leaves; a shell line shows, and a fresh session clears the screen', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const wide = 'Keep every line of the chat as wide as the window it is drawn in, however wide that window turns out to be';
      add(db, { type: 'preference', body: 'Always squash before merging', now: NOW });
      setMeta(db, 'scribe.failures', 3);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      const tty = fakeTty({ columns: 150 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      try {
        const shows = async (pattern, what) => {
          for (let i = 0; i < 300; i++) {
            if (pattern.test(tty.screen())) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
        };
        // Of the memory block only what is wrong is shown: a warning is for the user, the rest is the model's.
        await shows(/Warning: the background memory writer has failed 3 times in a row/, 'the warning');
        assert.doesNotMatch(tty.screen(), /Always squash before merging/);
        await tty.type(`! echo ${wide}${ENTER}`);
        await shows(/Keep every line/, 'the wide line');
        assert.ok(tty.screen().includes(wide), `a wide window is used to its edge, not wrapped at a fixed column:\n${tty.screen()}`);
        await tty.type(`! echo from the shell${ENTER}`);
        await shows(/> ! echo from the shell\n\s+⎿\s+from the shell/, 'the shell line and what it printed');
        const before = session.sessionId;
        await tty.type(`/new${ENTER}`);
        await shows(/^(?![\s\S]*from the shell)[\s\S]*█▀▀ █ █ █▀▄▀█ █▀█/, 'a cleared screen with the new header');
        assert.notEqual(session.sessionId, before);
        assert.equal(tty.screen().split(MARK).length, 2, 'one header: the old session is gone from the screen');

        await tty.type('half a thought');
        await shows(/│ > half a thought/, 'the text');
        await tty.type('\x03');
        await shows(/│ > \s+│/, 'an empty box');
        await tty.type('\x03');
        await shows(/Ctrl-C again to leave/, 'the warning');
        await tty.type('\x03');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('leaving in the middle of a turn stops the turn, and nothing typed after /quit is sent', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const signals = [];
      const { send, seen } = transport([
        { reply: reply('end_turn', [{ type: 'text', text: 'never said' }]), gate: gate() },
        { reply: reply('end_turn', [{ type: 'text', text: 'never asked' }]) },
      ]);
      const events = new EventEmitter();
      const session = createChat(db, {
        model: 'opus',
        effort: 'high',
        cwd: tmpdir(),
        send: (params, options) => {
          signals.push(options.signal);
          return send(params, options);
        },
        out: (t) => events.emit('text', t),
        watch: (e) => events.emit(e.type, e),
        now: () => NOW,
      });
      const tty = fakeTty();
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      try {
        await tty.type(`a long job${ENTER}`);
        for (let i = 0; i < 200 && seen.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
        await tty.type(`/quit${ENTER}`, `and one more${ENTER}`, '\x04');
        await leaves(ui);
        assert.equal(signals[0].aborted, true, 'the request in flight was dropped, not left running unseen');
        await new Promise((r) => setTimeout(r, 100));
        assert.equal(seen.length, 1, 'what was queued behind the way out is never sent');
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('an image dropped on the box or pasted with Ctrl-V stands in it as a marker and goes to the model with the message, queued or not', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const png = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
      const shot = join(mkdtempSync(join(tmpdir(), 'sumo-agents-shot-')), 'Screen Shot.png');
      writeFileSync(shot, png);
      const clipboard = [{ mediaType: 'image/jpeg', data: 'Y2xpcA==' }, null, { mediaType: 'image/png', data: 'cXVldWVk' }];
      const first = gate();
      const { send, seen } = transport([
        { reply: reply('end_turn', [{ type: 'text', text: 'a screenshot' }]), gate: first },
        { reply: reply('end_turn', [{ type: 'text', text: 'and another' }]) },
        { reply: reply('end_turn', [{ type: 'text', text: 'no picture here' }]) },
      ]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty();
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true, clipboard: async () => clipboard.shift() });
      try {
        const shows = async (pattern, what) => {
          for (let i = 0; i < 300; i++) {
            if (pattern.test(tty.screen())) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
        };
        await shows(/opus · high/, 'the footer');

        // A file dropped on the terminal arrives as its path, pasted: the box shows a marker, not the path.
        await tty.type(`\x1b[200~${shot.replace(/ /g, '\\ ')}\x1b[201~`);
        await shows(/│ > \[Image #1\] /, 'the dropped image');
        await tty.type('\x16');
        await shows(/│ > \[Image #1\] \[Image #2\] /, 'the image from the clipboard');
        await tty.type('\x16');
        await shows(/no image on the clipboard/, 'that there was nothing to paste');
        assert.match(tty.screen(), /│ > \[Image #1\] \[Image #2\] \s+│/, 'nothing was added to the box');

        await tty.type(`what are these${ENTER}`);
        await shows(/esc to interrupt/, 'the turn');
        assert.deepEqual(seen[0].messages.at(-1).content.map(({ cache_control, ...block }) => block), [
          { type: 'text', text: '[Image #1]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
          { type: 'text', text: '[Image #2]' },
          { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: 'Y2xpcA==' } },
          { type: 'text', text: '[Image #1] [Image #2] what are these' },
        ]);

        // One sent while the model works waits in the queue with its picture.
        await tty.type('\x16');
        await shows(/│ > \[Image #3\] /, 'the next image');
        await tty.type(`and this${ENTER}`);
        await shows(/queued: \[Image #3\] and this/, 'the queued message');
        first.open();
        await shows(/⏺ and another/, 'the queued message answered');
        const queued = seen[1].messages.findLast((m) => m.role === 'user' && m.content.some((b) => b.type === 'image')).content;
        assert.deepEqual(queued.map((b) => b.type), ['text', 'image', 'text']);
        assert.equal(queued[1].source.data, 'cXVldWVk');
        assert.equal(queued[2].text, '[Image #3] and this');

        // A job is told words only: a picture for one is refused out loud, not dropped.
        await tty.type(`@j7 look at [Image #1]${ENTER}`);
        await shows(/a job is told words only/, 'that a job takes no pictures');
        // A new session leaves the old one's pictures behind: a marker from before names nothing.
        await tty.type(`/new${ENTER}`);
        await tty.type(`[Image #1] again?${ENTER}`);
        await shows(/⏺ no picture here/, 'the answer in the new session');
        assert.deepEqual(seen[2].messages.at(-1).content.map((b) => b.type), ['text']);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('Ctrl-O shows every line a tool gave back and puts it away again; a resized window is redrawn at its new width', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const long = 'These words are one line of a reply that a narrow window has to fold and a wide window does not';
      const { send } = transport([
        { reply: reply('tool_use', [call('t1', 'bash', { command: 'echo one; echo two; echo three; echo four' })]) },
        { reply: reply('end_turn', [{ type: 'text', text: long }]) },
      ]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty({ columns: 60 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      // Everything is drawn again after a change of view; the last drawing is the one on the screen.
      const latest = () => tty.screen().slice(tty.screen().lastIndexOf(MARK));
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(latest())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${latest()}`);
      };
      try {
        await tty.type(`go${ENTER}`);
        await shows(/⏺ These words/, 'the reply');
        assert.match(latest(), /⎿\s+one\n\s+two\n\s+three\n\s+… \+1 lines/);
        assert.equal(latest().includes(long), false, 'sixty columns cannot hold the line');

        await tty.type('\x0f');
        await shows(/⎿\s+one\n\s+two\n\s+three\n\s+four\n/, 'the whole output');
        assert.doesNotMatch(latest(), /… \+1 lines/);
        assert.match(latest(), /> go\n/, 'the rest of the conversation is still there');
        await tty.type('\x0f');
        await shows(/… \+1 lines/, 'the short form again');

        tty.resize(150);
        await shows(new RegExp(long), 'the reply on one line');
        assert.match(latest(), /╭─{148}╮/, 'the box reaches the new edge');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('a job run in the chat is shown as it works — who it is, each thing it runs, what it says — and a line starting with @ talks to it', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-ui-job-'));
      writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'simba' }));
      addProject(db, root, { slug: 'simba', now: NOW });
      const { lastInsertRowid } = db
        .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES ('simba', 'look', 'scout', 'running', null, ?, ?, 'haiku', 'none', 'test')`)
        .run(NOW, NOW);
      const id = Number(lastInsertRowid);
      mkdirSync(join(paths().jobs, String(id)), { recursive: true });
      writeFileSync(join(paths().jobs, String(id), 'brief.md'), '# Job\n\n## The task\nlook around\n');

      const working = gate();
      const { send, seen } = transport([
        { reply: reply('tool_use', [call('t1', 'delegate', { job: id })]) }, // the chat
        { reply: reply('tool_use', [{ type: 'text', text: 'looking around' }, call('j1', 'bash', { command: 'echo hi' })]), gate: working }, // the job
        { reply: reply('end_turn', [{ type: 'text', text: 'report one' }]) }, // the job
        { reply: reply('end_turn', []) }, // the job, told once that it never closed itself
        { reply: reply('end_turn', [{ type: 'text', text: 'all finished' }]) }, // the chat
        { reply: reply('end_turn', [{ type: 'text', text: 'nobody here by that name' }]) }, // the chat, sent a line that starts with @
      ]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty();
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      const latest = () => tty.screen().slice(tty.screen().lastIndexOf(MARK));
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(latest())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${latest()}`);
      };
      try {
        await tty.type(`check simba${ENTER}`);
        await shows(new RegExp(`⏺ j${id} scout · haiku — look`), 'who the job is');
        assert.match(latest(), new RegExp(`@ message talks to j${id}`), 'how to talk to it, under the box');

        // Typed for the job while it works: sent to it, not queued for the chat.
        await tty.type(`@stay in src${ENTER}`);
        await shows(new RegExp(`> @j${id} stay in src`), 'what was said to the job');
        assert.doesNotMatch(latest(), /queued:/);
        working.open();

        await shows(/⏺ all finished/, 'the end of the turn');
        assert.match(seen[2].messages.at(-1).content.at(-1).text, /stay in src/, 'the job read it with its next request');
        assert.match(latest(), /\n {2}looking around\n {2}⏺ Bash\(echo hi\)\n {2}report one\n/, "the job's words and its call, one line each, set in under it");
        assert.match(latest(), new RegExp(`⏺ Delegate\\(j${id}\\)\\n\\s+⎿\\s+STATUS: never closed — j${id}`), 'how the run ended');
        assert.doesNotMatch(latest(), /@ message talks to/, 'nobody to talk to once it is over');

        // Ctrl-O opens what the job's command printed.
        await tty.type('\x0f');
        await shows(/ {2}⏺ Bash\(echo hi\)\n\s+⎿\s+hi\n/, "the job's output in full");

        // With no job running, a line starting with @ is an ordinary message.
        await tty.type('\x0f', `@nobody${ENTER}`);
        await shows(/⏺ nobody here by that name/, 'the answer to the ordinary message');
        assert.equal(seen.at(-1).messages.at(-1).content[0].text, '@nobody');

        // Named, it reaches a job wherever it runs — this one never closed, so it is still open — and a job that is not there is said back.
        await tty.type(`@j${id} and the ui too${ENTER}`);
        await shows(new RegExp(`> @j${id} and the ui too`), 'the message to the open job');
        assert.deepEqual(takeInbox(id), ['and the ui too']);
        await tty.type(`@j999 anyone?${ENTER}`);
        await shows(/no job j999/, 'the refusal');
        await tty.type('\x04');
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('Up recalls what was typed, across sessions, the last fifty; /model changes the route in the footer and says a bad one back', async () => {
  const home = freshHome();
  await withHome(home, { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    const UP = '\x1b[A';
    const open = (session) => {
      const events = new EventEmitter();
      const tty = fakeTty({ columns: 120 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(tty.screen())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
      };
      return { tty, ui, shows };
    };
    try {
      // Sixty lines typed before this one, so the oldest ten fall off.
      writeFileSync(join(home, 'history'), Array.from({ length: 60 }, (_, i) => `! echo line ${i + 1}`).join('\n') + '\n');
      const first = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      let { tty, ui, shows } = open(first);
      try {
        await shows(/opus · high/, 'the footer');
        await tty.type(`! echo fresh${ENTER}`);
        await shows(/⎿\s+fresh/, 'the shell line');
        await tty.type(UP);
        await shows(/│ > ! echo fresh/, 'the line just typed');
        await tty.type(UP);
        await shows(/│ > ! echo line 60/, 'the line before it, from the file');

        await tty.type('\x03');
        await tty.type(`/model sonnet medium${ENTER}`);
        await shows(/sonnet · medium/, 'the new route in the footer');
        assert.equal(first.model, 'sonnet');
        await tty.type(`/model gpt${ENTER}`);
        await shows(/no such model "gpt"/, 'the refusal');
        await shows(/sonnet · medium/, 'the route unchanged');
        await tty.type(`/model${ENTER}`);
        await shows(/⎿\s+sonnet\/medium/, 'the route said back');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
      const kept = readFileSync(join(home, 'history'), 'utf8').trimEnd().split('\n');
      assert.equal(kept.length, 50);
      assert.equal(kept[0], '! echo line 15');
      assert.deepEqual(kept.slice(-4), ['! echo fresh', '/model sonnet medium', '/model gpt', '/model']);

      // The next session starts where this one left off.
      const second = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
      ({ tty, ui, shows } = open(second));
      try {
        await shows(/opus · high/, 'the footer');
        await tty.type(UP);
        await shows(/│ > \/model/, 'the last line of the session before');
        await tty.type(UP);
        await shows(/│ > \/model gpt/, 'and the one before it');
        await tty.type('\x03');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('the logo is the background of the window: faint and centred in it, the box to type in at its foot; the conversation covers it as it grows, and a full screen is drawn as before', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const logo = ['  ⣴⣿⣦', '⢠⣿⣿⣿⣿⡄', ' ⠻⠿⠿⠟'];
      const held = gate();
      const { send } = transport([{ reply: reply('end_turn', [{ type: 'text', text: 'done' }]), gate: held }]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty({ columns: 80, rows: 40 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', logo, debug: true });
      // The last drawing, one line per row of the window, from the top of the header: the row of air above the name.
      const latest = () => tty.screen().slice(tty.screen().lastIndexOf(MARK) - 1);
      const lines = () => latest().split('\n');
      const until = async (ok, what) => {
        for (let i = 0; i < 300; i++) {
          if (ok()) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${latest()}`);
      };
      const left = ' '.repeat(Math.floor((80 - Math.max(...logo.map((row) => row.length))) / 2));
      /** The logo where the window's middle puts it: each row on its own row of the window, or under the conversation and not drawn. */
      const inPlace = (rows, upTo = -1) =>
        logo.every((row, k) => {
          const at = Math.floor((rows - logo.length) / 2) + k;
          return at > upTo ? lines()[at]?.trimEnd() === `${left}${row}` : !latest().includes(row);
        });
      const atFoot = (rows) => lines().length === rows - 1 && /^╰─+╯$/.test(lines().at(-2));
      try {
        await until(() => inPlace(40) && atFoot(40), 'the logo in the middle of a 40-row window, the box at its foot');
        assert.ok(tty.tallest() <= 39, `no frame on the way was taller than the window — one would scroll the top of the screen away (${tty.tallest()} lines)`);

        tty.resize(80, 30);
        await until(() => inPlace(30) && atFoot(30), 'the logo in the middle of the window again once it is shorter');

        // A turn in hand puts its working line above the room; the logo does not move for it.
        await tty.type(`go${ENTER}`);
        await until(() => /Working…/.test(latest()) && inPlace(30) && atFoot(30), 'the logo where it was while the turn works');
        held.open();
        await until(() => /⏺ done/.test(latest()) && !/Working…/.test(latest()) && inPlace(30), 'the logo where it was after the turn');

        // Output that reaches the logo's first row covers it; the rest stays where it was.
        const middle = Math.floor((30 - logo.length) / 2);
        const reach = middle - lines().slice(0, middle).findLastIndex((l) => l.trim()) - 2;
        await tty.type(`! seq 1 ${reach}${ENTER}`);
        await until(() => new RegExp(`\\n\\s+${reach}\\n`).test(latest()), 'the output');
        const covered = lines().findIndex((l) => new RegExp(`^\\s+${reach}$`).test(l));
        await until(() => inPlace(30, covered) && atFoot(30), 'the logo under the output covered, the rest in place');
        assert.ok(!latest().includes(logo[0]) && latest().includes(logo[1]), 'part covered, part showing');

        await tty.type(`! seq 1 60${ENTER}`);
        await until(() => /\b60\n\n╭─+╮\n│ > /.test(latest()), 'the box straight under the output that filled the window');
        assert.ok(!logo.some((row) => latest().includes(row)), 'no logo when there is no room for it');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('a history that cannot be written costs the recall, never the turn; one that can is kept private', async () => {
  const home = freshHome();
  await withHome(home, { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    const open = (session) => {
      const events = new EventEmitter();
      const tty = fakeTty({ columns: 120 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(tty.screen())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
      };
      return { tty, ui, shows };
    };
    const session = () => createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: () => assert.fail('nothing here talks to the model'), now: () => NOW });
    try {
      // Something else sits where the history goes: nothing can be written there.
      mkdirSync(join(home, 'history'));
      let { tty, ui, shows } = open(session());
      try {
        await tty.type(`! echo still here${ENTER}`);
        await shows(/⎿\s+still here/, 'the shell line, run all the same');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }

      rmSync(join(home, 'history'), { recursive: true });
      ({ tty, ui, shows } = open(session()));
      try {
        await tty.type(`! echo kept${ENTER}`);
        await shows(/⎿\s+kept/, 'the shell line');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
      assert.equal(readFileSync(join(home, 'history'), 'utf8'), '! echo kept\n');
      assert.equal(statSync(join(home, 'history')).mode & 0o777, 0o600, 'what was typed is for its owner only, like the rest of the home');
    } finally {
      db.close();
    }
  });
});

test('a turn that ends because the reply was cut off, or declined, says so on the screen', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const { send } = transport([{ reply: reply('max_tokens', [{ type: 'text', text: 'a very long answer that stops mid' }]) }, { reply: reply('refusal', []) }]);
      const events = new EventEmitter();
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
      const tty = fakeTty({ columns: 120 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
      const shows = async (pattern, what) => {
        for (let i = 0; i < 300; i++) {
          if (pattern.test(tty.screen())) return;
          await new Promise((r) => setTimeout(r, 10));
        }
        assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
      };
      try {
        await tty.type(`write it all out${ENTER}`);
        await shows(/stops mid[\s\S]*stopped: a reply hit the output limit/, 'why the reply ends where it does');
        await tty.type(`do the other thing${ENTER}`);
        await shows(/stopped: the model declined to continue/, 'that the model declined');
        await tty.type('\x04');
        await leaves(ui);
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});
