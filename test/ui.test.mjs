// The chat on screen: the box you type in, the line that says it is working, the work as it happens, and the keys that stop it.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { add } from '../src/memory.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
const ENTER = '\r';
const ESC = '\x1b';
const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage, model: 'claude-opus-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });

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
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Salting the ring'], cwd: '/work/here', debug: true });
      try {
        const shows = async (pattern, what) => {
          for (let i = 0; i < 300; i++) {
            if (pattern.test(tty.screen())) return;
            await new Promise((r) => setTimeout(r, 10));
          }
          assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
        };

        // Opening: who is answering, the memory, and a bordered box to type in.
        await shows(/Always squash before merging/, 'the memory block');
        assert.match(tty.screen(), /sumo/);
        assert.match(tty.screen(), /╭─+╮\n│ > .*│\n╰─+╯/, 'the input box');
        assert.match(tty.screen(), /opus · high/, 'the model and effort under the box');

        // A turn: what was typed, then the working line while the reply is held.
        await tty.type('fix it', ENTER);
        await shows(/Salting the ring…/, 'the working line');
        assert.match(tty.screen(), /> fix it/);
        assert.match(tty.screen(), /esc to interrupt/);
        assert.equal(seen[0].messages.at(-1).content[0].text, 'fix it');

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
        await shows(/\/fix[\s\S]*\/feature[\s\S]*\/quit/, 'the command menu');
        await tty.type('q', '\t');
        await shows(/│ > \/quit/, 'the completed command');
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

test('the screen is as wide as the window; Ctrl-C clears what is typed, then asks once before it leaves; a shell line and a fresh session show', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const wide = 'Keep every line of the chat as wide as the window it is drawn in, however wide that window turns out to be';
      add(db, { type: 'preference', body: wide, now: NOW });
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
        await shows(/Keep every line/, 'the memory block');
        assert.ok(tty.screen().includes(wide), `a wide window is used to its edge, not wrapped at a fixed column:\n${tty.screen()}`);
        await tty.type(`! echo from the shell${ENTER}`);
        await shows(/> ! echo from the shell\n\s+⎿\s+from the shell/, 'the shell line and what it printed');
        const before = session.sessionId;
        await tty.type(`/new${ENTER}`);
        await shows(/sumo[\s\S]*sumo/, 'a second header');
        assert.notEqual(session.sessionId, before);

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
      const latest = () => tty.screen().slice(tty.screen().lastIndexOf('✻ sumo'));
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
