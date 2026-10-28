// What the chat writes to a real terminal, byte for byte: what a frame drawn for the screen's sake (debug) cannot show —
// lines written again only where they changed, an erase that never takes the last column with it, and a screen that
// holds still while a question is read. Measured first in a real pty (a driver kept beside the session's notes).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { eraseFirst, keyRows, nextLineScrolls, runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';

test('a line is erased before it is written, never after: a line as wide as the window keeps its last column', () => {
  const wide = '─'.repeat(80);
  assert.equal(eraseFirst(`\x1b[1G${wide}\x1b[K\n`), `\x1b[1G\x1b[K${wide}\n`);
  // Colours inside the line go with it; an empty line, and every other code, are as they were.
  assert.equal(eraseFirst('\x1b[1G\x1b[90m│ x │\x1b[39m\x1b[K\n\x1b[1G\x1b[K\n\x1b[2K\x1b[1A\x1b[E'), '\x1b[1G\x1b[K\x1b[90m│ x │\x1b[39m\n\x1b[1G\x1b[K\n\x1b[2K\x1b[1A\x1b[E');
  assert.equal(eraseFirst(eraseFirst(`\x1b[1G${wide}\x1b[K`)), `\x1b[1G\x1b[K${wide}`, 'and taken twice is taken once');
  assert.deepEqual(eraseFirst(Buffer.from('x')), Buffer.from('x'));
});

test("a question's keys break only between keys: none stands at the end of a row with what it does on the next", () => {
  const keys = 'y once · a this file, session · d /private/var/folders/z5/T, session · n no · r no, say why · esc stop';
  const rows = keyRows(keys, 50);
  assert.deepEqual(rows, ['y once · a this file, session', 'd /private/var/folders/z5/T, session · n no', 'r no, say why · esc stop']);
  assert.deepEqual(keyRows('y yes · n no · esc stop', 120), ['y yes · n no · esc stop']);
  assert.deepEqual(keyRows('a key longer than the row is a row of its own · n no', 10), ['a key longer than the row is a row of its own', 'n no']);
});

/** A chat on a fake terminal whose writes are all kept, and a turn that waits until `finish()` lets it end. */
async function chatOn({ columns = 80, rows = 30, debug, plain = false, env = {} }, body) {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log'), ...env }, async () => {
    const db = openDb();
    let open;
    const held = new Promise((r) => (open = r));
    const send = async (_params, { onText } = {}) => {
      await held;
      onText?.('Done.');
      return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Done.' }], usage: { input_tokens: 1200, output_tokens: 40 }, model: 'claude-opus-5-5' };
    };
    const events = new EventEmitter();
    const cwd = mkdtempSync(join(tmpdir(), 'sumo-agents-writes-'));
    const session = createChat(db, { model: 'opus', effort: 'high', cwd, send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e) });
    const tty = fakeTty({ columns, rows });
    const raw = [];
    const write = tty.stdout.write.bind(tty.stdout);
    tty.stdout.write = (chunk, ...rest) => {
      raw.push(String(chunk));
      return write(chunk, ...rest);
    };
    const logo = Array.from({ length: 12 }, (_, i) => `${'⣿'.repeat(30)} logo row ${i}`);
    const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd, logo, debug, plain });
    const settle = (ms) => new Promise((r) => setTimeout(r, ms));
    try {
      await settle(300);
      await body({ tty, raw, events, settle, finish: () => open() });
    } finally {
      open();
      await tty.type('\x04');
      ui.unmount();
      db.close();
    }
  });
}

test('a keystroke rewrites the line it changed, not the frame — and no line in what is written is erased after it is drawn', async () => {
  await chatOn({ columns: 80, rows: 40, debug: false }, async ({ tty, raw, settle }) => {
    const before = raw.join('').length;
    assert.ok(before > 2000, `the first frame, logo and all, is drawn whole (${before} bytes)`);
    const each = [];
    for (const key of 'hello') {
      const from = raw.join('').length;
      await tty.type(key);
      await settle(120);
      each.push(raw.join('').length - from);
    }
    assert.ok(each.every((n) => n > 0 && n < 600), `each key rewrote only what changed: ${each.join(', ')} bytes, against a frame of ${before}`);
    const all = raw.join('');
    // Ink writes a changed line from where it changes: the erase follows the move to that column, before the words.
    const late = [...all.matchAll(/\x1b\[K/g)].filter((m) => !/\x1b\[\d*G$/.test(all.slice(Math.max(0, m.index - 8), m.index)));
    assert.equal(late.length, 0, 'every erase to the end of a line comes before the line, never after it');
  });
});

test('while a question waits, the working line steps aside — the question says it waits — and the screen holds still; answered, the line is back, its clock not started over', async () => {
  await chatOn({ columns: 100, rows: 40, debug: true }, async ({ tty, raw, events, settle, finish }) => {
    await tty.type('change my config', '\r');
    await settle(400);
    assert.match(tty.screen(), /Working… {2}\d+s · /, 'at work first, the spinner turning');
    const answered = new Promise((resolve) => events.emit('approve', { name: 'str_replace_based_edit_tool', server: 'editor', tool: 'outside the project', input: { command: 'str_replace', path: '/tmp/x/cfg.toml', old_str: 'a = 1', new_str: 'a = 2' }, path: '/tmp/x/cfg.toml', outside: true, guarded: null, directory: '/tmp/x', resolve }));
    await settle(1300);
    assert.match(tty.screen(), /Change this file outside the project\?/);
    assert.doesNotMatch(tty.screen(), /Working…|Waiting for your answer/, 'the question alone says it waits');
    const from = raw.length;
    await settle(1100);
    const frames = raw.length - from;
    assert.ok(frames <= 1, `a still screen while the question is read: ${frames} frames in 1.1s`);
    await tty.type('n');
    assert.equal(await answered, 'no');
    await settle(300);
    assert.match(tty.screen(), /Working… {2}[1-9]\d*s/, 'answered, it works again — its clock not started over');
    finish();
  });
});

/**
 * A terminal as far as the chat drives one: text clipped at the edge, a line feed that scrolls at the foot, the cursor moves
 * and the erases Ink writes. Colours, modes and titles draw nothing here. What it shows is what a real terminal would.
 */
function terminal(columns, rows) {
  const blank = () => Array(columns).fill(' ');
  let grid = Array.from({ length: rows }, blank);
  let x = 0;
  let y = 0;
  const feed = () => {
    if (y < rows - 1) y++;
    else grid = [...grid.slice(1), blank()];
  };
  const write = (data) => {
    const text = String(data);
    for (let i = 0; i < text.length; ) {
      const ch = text[i];
      if (ch === '\x1b') {
        const osc = /^\x1b\][^\x07]*\x07/.exec(text.slice(i));
        if (osc) {
          i += osc[0].length;
          continue;
        }
        const csi = /^\x1b\[([?]?)([0-9;]*)([A-Za-z])/.exec(text.slice(i));
        if (!csi) {
          i++;
          continue;
        }
        i += csi[0].length;
        const [, mode, args, op] = csi;
        if (mode) continue;
        const [n = 1, m = 1] = args.split(';').map((a) => (a === '' ? 1 : Number(a)));
        if (op === 'A') y = Math.max(0, y - (args ? n : 1));
        else if (op === 'B') y = Math.min(rows - 1, y + (args ? n : 1));
        else if (op === 'E') [x, y] = [0, Math.min(rows - 1, y + (args ? n : 1))];
        else if (op === 'G') x = (args ? n : 1) - 1;
        else if (op === 'H') [y, x] = args ? [n - 1, m - 1] : [0, 0];
        else if (op === 'K') grid[y] = args === '2' ? blank() : [...grid[y].slice(0, x), ...Array(columns - x).fill(' ')];
        else if (op === 'J' && (args === '2' || args === '3')) grid = Array.from({ length: rows }, blank);
        continue;
      }
      if (ch === '\r') x = 0;
      else if (ch === '\n') {
        x = 0;
        feed();
      } else if (x < columns) grid[y][x++] = ch;
      i++;
    }
  };
  return { write, rows: () => grid.map((row) => row.join('').trimEnd()) };
}

test('a line stepped over is stepped over with a line feed, which scrolls at the foot of the window as "next line" does not', () => {
  assert.equal(nextLineScrolls('\x1b[5A\x1b[E\x1b[1G\x1b[Kx\n\x1b[E'), '\x1b[5A\r\n\x1b[1G\x1b[Kx\n\r\n');
  assert.equal(nextLineScrolls('\x1b[2E\x1b[K'), '\x1b[2E\x1b[K', 'a move of more than one line is not one Ink makes, and is left alone');
  assert.deepEqual(nextLineScrolls(Buffer.from('x')), Buffer.from('x'));
});

test('a live area that grows past the foot of the window is drawn where it is, with nothing of the frame before it left behind', async () => {
  // Plain, the box is one row: the first row the question adds is a blank one, where the frame before it ended.
  await chatOn({ columns: 80, rows: 24, debug: false, plain: true }, async ({ tty, raw, events, settle, finish }) => {
    await tty.type('go', '\r');
    await settle(200);
    // A conversation that fills the window: the live area stands at its foot from here on.
    events.emit('text', Array.from({ length: 30 }, (_, i) => `line ${i + 1} of the answer`).join('\n') + '\n');
    await settle(200);
    const call = { id: 'q1', name: 'ask', input: { question: 'Which port should the server use when PORT is not set?' } };
    events.emit('tool', { call });
    events.emit('ask', { question: 'Which port should the server use when PORT is not set?', options: [{ label: '8080', detail: 'the usual for a dev server' }, { label: '3000', detail: 'keep what it was' }, { label: 'Fail fast', detail: 'refuse to start without PORT' }], resolve: () => {} });
    await settle(1300);
    const screen = terminal(80, 24);
    for (const chunk of raw) screen.write(chunk);
    const shown = screen.rows();
    assert.ok(raw.every((chunk) => !chunk.includes('\x1b[E')), 'no line is stepped over with a move that cannot scroll');
    // The working line stood above the question's place until the question came, and steps aside for it: no copy of it is left.
    // Plain, the line has no clock: what follows its words is how to stop the turn.
    const working = shown.filter((row) => /(Waiting for your answer|Working…) {2}(?:\d+s · )?esc to interrupt/.test(row));
    assert.equal(working.length, 0, `no working line, and no stale copy of one:\n${shown.join('\n')}`);
    assert.match(shown.join('\n'), /\? Which port[^\n]*\n {9}> 1\. 8080[\s\S]*\n\n {3}you > *\n {9}opus · high/, `the question, then the box and the status row under it:\n${shown.join('\n')}`);
    finish();
  });
});

test('a command answered with a note leaves the box at the foot of the window: the screen is never drawn a row too tall while a row is counted', async () => {
  await chatOn({ columns: 80, rows: 24, debug: false }, async ({ tty, raw, settle }) => {
    for (const line of ['/model', '/hlep', '/model']) {
      await tty.type(line, '\r');
      await settle(250);
    }
    const screen = terminal(80, 24);
    for (const chunk of raw) screen.write(chunk);
    const shown = screen.rows();
    assert.match(shown[1], /^ {2}sumo {3}/, `the header where it was, nothing scrolled away:\n${shown.join('\n')}`);
    assert.match(shown[22], /^ {9}opus · high .*\/ commands/, `the status row on the last row but Ink's own:\n${shown.join('\n')}`);
  });
});

test('with NO_COLOR the cursor in the box is still there, in reverse video, and so is the part of an edit that changed: only colour is dropped', async () => {
  await chatOn({ columns: 80, rows: 30, debug: false, env: { NO_COLOR: '1' } }, async ({ tty, raw, events, settle }) => {
    await tty.type('hello world');
    await settle(150);
    await tty.type(...Array(5).fill('\x1b[D'));
    await settle(200);
    // Ink writes only the part of the row that changed: the cursor is its reverse video in what was written, the row is the screen's.
    assert.match(raw.join(''), /\x1b\[7mw\x1b\[27morld/, 'the cursor on the w, in reverse video');
    const typed = terminal(80, 30);
    for (const chunk of raw) typed.write(chunk);
    assert.ok(typed.rows().some((row) => /^ {3}you › hello world/.test(row)), `the row as it reads:\n${typed.rows().join('\n')}`);
    events.emit('tool', { call: { id: 'e1', name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: 'cart.js', old_str: 'let sum = 0;', new_str: 'let sum = 0n;' } } });
    events.emit('result', { call: { id: 'e1', name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: 'cart.js', old_str: 'let sum = 0;', new_str: 'let sum = 0n;' } }, result: { content: 'edited', edit: { line: 2, old: '  let sum = 0;', new: '  let sum = 0n;' } } });
    await settle(300);
    assert.match(raw.join(''), /let sum = 0\x1b\[7mn\x1b\[27m;/, 'what the edit put in, marked');
  });
});

test('/new starts over on a window scrolled clear: the new header at the top, the box at the foot — none of it scrolled away', async () => {
  await chatOn({ columns: 80, rows: 24, debug: false }, async ({ tty, raw, settle, finish }) => {
    await tty.type('go', '\r');
    finish();
    await settle(400);
    await tty.type('/new', '\r');
    await settle(800);
    const screen = terminal(80, 24);
    for (const chunk of raw) screen.write(chunk);
    const shown = screen.rows();
    assert.ok(shown.some((row) => /^ {2}sumo {3}\S/.test(row)), `the new header is on the screen:\n${shown.join('\n')}`);
    assert.match(shown.slice(-4).join('\n'), /^─{80}\n {3}you › [^\n]*\n {9}opus · high[^\n]*\n$/, `the box at the foot, under its rule, the status under it:\n${shown.join('\n')}`);
  });
});

test('a question to approve taller than the window is shown as far as the window goes: the screen and its scrollback are never wiped to draw it, and the keys stay on it', async () => {
  await chatOn({ columns: 40, rows: 24, debug: false }, async ({ tty, raw, events, settle }) => {
    await settle(200);
    const command = Array.from({ length: 40 }, (_, i) => `echo step ${i + 1} of the long build`).join(' && ');
    const call = { id: 'b1', name: 'bash', input: { command } };
    events.emit('tool', { call });
    const from = raw.length;
    const answered = new Promise((resolve) => events.emit('approve', { name: 'bash', server: 'bash', tool: 'outside the sandbox', input: { command }, unsandboxed: true, blocked: 'touch: /x: Operation not permitted', resolve }));
    await settle(600);
    assert.ok(!raw.slice(from).join('').includes('\x1b[3J'), 'the scrollback is never wiped for the question');
    const screen = terminal(40, 24);
    for (const chunk of raw) screen.write(chunk);
    const shown = screen.rows().join('\n');
    assert.match(shown, /Run this once outside[\s\S]*│ {3}echo step 1 of the long/, `the question, and what would run from its start:\n${shown}`);
    // The call over the panel is one row while it waits: the panel shows what would run.
    assert.match(shown, /^ {3}run \? echo step 1 of the long build …$/m, `the waiting call, in a row:\n${shown}`);
    assert.match(shown, /… [\d,]+ more characters not[\s\S]*shown — n, and ask the model[\s\S]*for less/, `what did not fit, counted:\n${shown}`);
    assert.match(shown, /│ y yes · n no · r no, say why/, `the keys, on the screen:\n${shown}`);
    // Taller still — every key explained, then a reason being typed — and still drawn where it is.
    const later = raw.length;
    await tty.type('x');
    await settle(300);
    await tty.type('r');
    await settle(200);
    await tty.type('use the cached build in the project instead of this');
    await settle(400);
    assert.ok(!raw.slice(later).join('').includes('\x1b[3J'), 'nor for every key explained, or a reason typed');
    const typing = terminal(40, 24);
    for (const chunk of raw) typing.write(chunk);
    assert.match(typing.rows().join('\n'), /why not\? use the cached[\s\S]*enter refuses with this/, `the reason and its keys, on the screen:\n${typing.rows().join('\n')}`);
    await tty.type('\x1b');
    await settle(200);
    await tty.type('n');
    assert.equal(await answered, 'no');
  });
});
