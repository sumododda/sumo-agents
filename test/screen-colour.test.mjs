// The chat screen as a colour terminal draws it. Weight and colour are part of what a row says, and the terminal the
// other screen tests use draws neither: colour is asked for here before Ink, and the chalk under it, are loaded.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';

process.env.FORCE_COLOR = '1';
const { createChat } = await import('../src/chat.mjs');
const { openDb } = await import('../src/db.mjs');
const { runUi } = await import('../src/ui.mjs');

const COLOURS = /\x1b\[[0-9;]*m/g;

test('the keys under a question are at full weight, not the faintest text in its panel; a key that answers nothing turns them yellow; a note is never red', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    const events = new EventEmitter();
    const session = createChat(db, { model: 'opus', effort: 'high', cwd: mkdtempSync(join(tmpdir(), 'sumo-agents-colour-')), send: async () => assert.fail('nothing is sent'), out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e) });
    const tty = fakeTty({ columns: 120 });
    const frames = [];
    const write = tty.stdout.write.bind(tty.stdout);
    tty.stdout.write = (chunk, ...rest) => {
      frames.push(String(chunk));
      return write(chunk, ...rest);
    };
    const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], logo: [], debug: true });
    /** The row of the last frame whose words match, colour codes and all. */
    const row = (pattern) => frames.at(-1).split('\n').find((line) => pattern.test(line.replace(COLOURS, ''))) ?? '';
    const shows = async (pattern, what) => {
      for (let i = 0; i < 300; i++) {
        if (pattern.test(tty.screen())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
    };
    try {
      const answered = new Promise((resolve) => events.emit('approve', { name: 'str_replace_based_edit_tool', server: 'editor', tool: 'outside the project', input: { command: 'str_replace', path: '/srv/app/cfg.toml', old_str: 'a = 1', new_str: 'a = 2' }, path: '/srv/app/cfg.toml', outside: true, guarded: null, directory: '/srv/app', resolve }));
      await shows(/y once · a this file/, 'the question');
      const keys = row(/y once · a this file/);
      assert.match(keys, /\x1b\[/, `a terminal that draws colour: ${JSON.stringify(keys)}`);
      assert.doesNotMatch(keys, /\x1b\[2m/, `the keys at full weight: ${JSON.stringify(keys)}`);
      await tty.type('x');
      await shows(/y changes it once/, 'every key explained');
      assert.match(row(/y changes it once/), /\x1b\[33m[^\x1b]*y changes it once/, 'in the panel\'s yellow');
      await tty.type('n');
      assert.equal(await answered, 'no');
      await tty.type('/copy', '\r');
      await shows(/no reply to copy yet/, 'that there is nothing to copy');
      assert.doesNotMatch(row(/no reply to copy yet/), /\x1b\[31m/, 'nothing went wrong: not red');
    } finally {
      await tty.type('\x04');
      ui.unmount();
      db.close();
    }
  });
});
