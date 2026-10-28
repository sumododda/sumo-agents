// The chat screen read without colour: a failure by its mark, reads grouped, an edit as pairs, a retry counting down, the
// plan the model keeps, a command mistyped, and the plain mode a screen reader is given.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { createChat } from '../src/chat.mjs';
import { openDb } from '../src/db.mjs';
import { scratchDir } from '../src/projects.mjs';
import { colourEnabled, createRenderer, explained, styles, tilde, toolView, transcript } from '../src/tty.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';

const ENTER = '\r';
const CTRL_O = '\x0f';
const EDITOR = 'str_replace_based_edit_tool';

/** A gate the test opens when it has looked at the screen. */
function gate() {
  let open;
  const promise = new Promise((r) => (open = r));
  return { promise, open };
}

/**
 * A chat on a fake terminal, its model held behind a gate: `turn()` starts one and leaves it working until `finish()`.
 * Events are emitted straight at the screen, as the session's watcher would.
 */
async function onScreen({ columns = 80, rows = 40, plain = false, logo = [], messages = ['Working'], send: given = null } = {}, body) {
  await withHome(freshHome(), { SUMO_AGENTS_SPAWN_LOG: join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log') }, async () => {
    const db = openDb();
    const held = gate();
    const send =
      given ??
      (async (_params, { onText } = {}) => {
        await held.promise;
        onText?.('ok');
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 10, output_tokens: 2 }, model: 'claude-opus-5-5' };
      });
    const events = new EventEmitter();
    const cwd = mkdtempSync(join(tmpdir(), 'sumo-agents-screen-'));
    const session = createChat(db, { model: 'opus', effort: 'high', cwd, send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e) });
    const tty = fakeTty({ columns, rows });
    const paged = [];
    const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages, cwd, logo, debug: true, plain, run: async (_program, file) => paged.push(readFileSync(file, 'utf8')) });
    const shows = async (pattern, what) => {
      for (let i = 0; i < 300; i++) {
        if (pattern.test(tty.screen())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
    };
    const clears = async (pattern, what) => {
      for (let i = 0; i < 300; i++) {
        if (!pattern.test(tty.screen())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`the screen never let go of ${what}:\n${tty.screen()}`);
    };
    const tool = (id, name, input, result) => {
      const call = { id, name, input };
      events.emit('tool', { call });
      if (result) events.emit('result', { call, result });
      return call;
    };
    const view = (id, file, lines = 3) => tool(id, EDITOR, { command: 'view', path: file }, { content: Array.from({ length: lines }, (_, i) => `${i + 1}\tline`).join('\n') });
    try {
      await shows(/opus · high/, 'the footer');
      await body({ tty, events, shows, clears, tool, view, cwd, paged, db, session, turn: async () => tty.type('go', ENTER), finish: () => held.open() });
    } finally {
      held.open();
      await tty.type('\x04');
      ui.unmount();
      db.close();
    }
  });
}

test('a failed call is marked ✗, not told by its colour alone — on the screen and in the pager; an empty NO_COLOR is not set', async () => {
  assert.equal(colourEnabled({ isTTY: true }, { NO_COLOR: '' }), true, 'NO_COLOR is set when it holds something');
  assert.equal(colourEnabled({ isTTY: true }, { NO_COLOR: '1' }), false);
  await onScreen({}, async ({ tty, tool, shows, cwd }) => {
    tool('t1', EDITOR, { command: 'str_replace', path: 'cart.js', old_str: 'a', new_str: 'b' }, { content: 'old_str was not found in cart.js', isError: true });
    tool('t2', 'bash', { command: 'echo fine' }, { content: 'fine' });
    await shows(/✗ Update\(cart\.js\)\n\s+⎿\s+old_str was not found/, 'the failed edit marked ✗');
    assert.match(tty.screen(), /⏺ Bash\(echo fine\)/, 'one that went through keeps its mark');
  });
  const log = [{ kind: 'tool', call: { id: 'x', name: 'bash', input: { command: 'false' } }, result: { content: '(exit 1)', isError: true } }];
  assert.match(transcript(log, styles(false)), /^✗ Bash\(false\)/);
});

test('reads one after another are one row — how many, which — with one line under it; the pager still has every one of them', async () => {
  await onScreen({}, async ({ tty, view, tool, shows, paged }) => {
    view('r1', 'a.js', 3);
    view('r2', 'b.js', 4);
    view('r3', 'c.js', 5);
    await shows(/⏺ Read 3 files \(a\.js, b\.js, \+1\)\n\s+⎿\s+12 lines\n/, 'the reads as one row');
    assert.equal(tty.screen().match(/⏺ Read/g).length, 1, 'one row, not three');
    // Anything else after them closes the group: it stays as it was, and the next read starts its own.
    tool('b1', 'bash', { command: 'echo after' }, { content: 'after' });
    view('r4', 'd.js', 2);
    await shows(/⏺ Bash\(echo after\)[\s\S]*⏺ Read\(d\.js\)\n\s+⎿\s+2 lines/, 'a single read drawn as it always was');
    assert.match(tty.screen(), /⏺ Read 3 files \(a\.js, b\.js, \+1\)/);
    // A read that failed is not one of them: it says why, on its own row.
    tool('r5', EDITOR, { command: 'view', path: 'gone.js' }, { content: 'gone.js does not exist', isError: true });
    await shows(/✗ Read\(gone\.js\)\n\s+⎿\s+gone\.js does not exist/, 'the failed read on its own');
    await tty.type(CTRL_O);
    for (let i = 0; i < 100 && paged.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    const pager = paged[0].replace(/\x1b\[[0-9;]*m/g, '');
    for (const name of ['a.js', 'b.js', 'c.js', 'd.js']) assert.match(pager, new RegExp(`⏺ Read\\(${name.replace('.', '\\.')}\\)`), `${name} in the pager`);
  });
});

test('an edit is drawn as pairs — what went over what came — the change within a line marked, and folded by the rows it takes on the screen', async () => {
  const edit = (old, now) => toolView({ name: EDITOR, input: { command: 'str_replace', path: 'cart.js', old_str: old, new_str: now } }, { content: 'edited', edit: { line: 10, old, new: now } });
  const { lines } = edit('a\nconst total = price * qty;\nlet x = 1;\nz', 'a\nconst total = price * count;\nlet x = 2;\nz');
  assert.deepEqual(
    lines.map((l) => l.text),
    ['10   a', '11 - const total = price * qty;', '11 + const total = price * count;', '12 - let x = 1;', '12 + let x = 2;', '13   z'],
    'each line that went over the line that came in its place',
  );
  assert.deepEqual(lines[1].span, [lines[1].text.indexOf('qty'), lines[1].text.indexOf(';')], 'what changed within the line, by where it is');
  assert.deepEqual(lines[2].span, [lines[2].text.indexOf('count'), lines[2].text.indexOf(';')]);
  // A word added inside a line marks only what came: nothing went from the old one.
  const grown = edit('let qty = 1;', 'let quantity = 1;').lines;
  assert.equal(grown[0].span, undefined);
  assert.deepEqual(grown[1].span, [grown[1].text.indexOf('uanti'), grown[1].text.indexOf('ty =')]);
  // In the pager, with colour, the changed part is in reverse video.
  const paged = transcript([{ kind: 'tool', call: { id: 'e', name: EDITOR, input: { command: 'str_replace', path: 'cart.js', old_str: 'x', new_str: 'y' } }, result: { content: 'edited', edit: { line: 10, old: 'let n = 1;', new: 'let n = 2;' } } }], styles(true));
  assert.match(paged, /let n = \x1b\[7m1\x1b\[27m;/);
  assert.match(paged, /let n = \x1b\[7m2\x1b\[27m;/);

  // Thirty long lines changed, in a window forty wide: the edit keeps to about fourteen rows, and says how many lines are folded away.
  await onScreen({ columns: 40, rows: 60 }, async ({ tty, tool, shows, cwd }) => {
    const old = Array.from({ length: 30 }, (_, i) => `const value${i} = compute(${i}, options.first, options.second);`).join('\n');
    const now = old.replaceAll('compute(', 'measure(');
    tool('e1', EDITOR, { command: 'str_replace', path: 'big.js', old_str: old, new_str: now }, { content: 'edited', edit: { line: 1, old, new: now } });
    tool('b1', 'bash', { command: 'echo next' }, { content: 'next' });
    await shows(/⏺ Bash\(echo next\)/, 'the call after the edit');
    const rows = tty.screen().split('\n');
    const from = rows.findIndex((r) => /Update\(big\.js/.test(r));
    const to = rows.findIndex((r) => /Bash\(echo next\)/.test(r));
    assert.ok(to - from <= 16, `the edit took ${to - from} rows:\n${rows.slice(from, to).join('\n')}`);
    assert.match(rows.slice(from, to).join('\n'), /… \+\d+ lines/, 'what is folded away is counted');
  });
});

test('a request sent again counts down on the working line, and the scroll says why in words, not the API\'s', async () => {
  await onScreen({}, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    events.emit('retry', { attempt: 1, limit: 6, delayMs: 3000, reason: '529 overloaded_error Overloaded' });
    await shows(/retrying in 3s · attempt 1\/6/, 'the countdown');
    await shows(/retrying in 2s · attempt 1\/6/, 'the countdown going down');
    assert.match(tty.screen(), /Anthropic's API is overloaded just now · retrying \(1 of 6\)/, 'the reason in words');
    assert.doesNotMatch(tty.screen(), /overloaded_error/, 'not as the API put it');
    finish();
    await shows(/⏺ ok/, 'the reply');
    assert.doesNotMatch(tty.screen(), /retrying in/);
  });
});

test('a checklist in the reply is the plan line under the working line — how far, and what is next — a later one replaces it, and it goes with the turn', async () => {
  await onScreen({}, async ({ tty, events, shows, clears, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    events.emit('text', 'The plan:\n\n- [x] read the cart\n- [ ] fix the total\n- [ ] run the tests\n\n');
    await shows(/Working… [^\n]*\n\s+plan 1\/3 · next: fix the total/, 'the plan line');
    events.emit('text', 'Now:\n\n- [x] read the cart\n- [x] fix the total\n- [ ] run the tests\n\n');
    await shows(/plan 2\/3 · next: run the tests/, 'the later checklist');
    assert.doesNotMatch(tty.screen(), /plan 1\/3/);
    finish();
    await clears(/Working…/, 'the working line');
    assert.doesNotMatch(tty.screen(), /plan \d\/\d/, 'gone with the turn');
  });
});

test('a mistyped command is answered with the one it was close to; one close to none lists them, every row under the note\'s words', async () => {
  await onScreen({}, async ({ tty, shows }) => {
    await tty.type('/modle', ENTER);
    await shows(/no command \/modle — did you mean \/model\?/, 'the guess');
    await tty.type('/frobnicate', ENTER);
    await shows(/no command \/frobnicate — one of: \/fix/, 'the list');
    const listed = tty.screen().slice(tty.screen().indexOf('no command /frobnicate'));
    assert.match(listed, /\n {5}\/\w/, 'the list goes on under the words');
    assert.doesNotMatch(listed, /\n {0,4}\/\w/, 'no row of the list starts at the edge, or short of the words');
  });
});

test('plain mode, for a screen reader: no box drawing anywhere — the box, a question, a reply\'s table and code — and plain marks', async () => {
  await onScreen({ plain: true }, async ({ tty, events, tool, shows, turn }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    tool('t1', 'bash', { command: 'echo fine' }, { content: 'fine' });
    tool('t2', 'bash', { command: 'false' }, { content: '(exit 1)', isError: true });
    events.emit('text', '| a | b |\n|---|---|\n| 1 | 2 |\n\n```js\nx\n```\n\n> quoted\n\n---\n');
    await shows(/quoted/, 'the reply');
    assert.match(tty.screen(), /^> /m, 'the box, as a prompt');
    assert.doesNotMatch(tty.screen(), /[\u2500-\u257F]/, `box drawing on the screen:\n${tty.screen()}`);
    events.emit('approve', { name: 'bash', server: 'bash', tool: 'outside the sandbox', input: { command: 'touch ~/x' }, unsandboxed: true, resolve: () => {} });
    await shows(/Run this once outside the sandbox\?/, 'the question');
    const screen = tty.screen();
    assert.doesNotMatch(screen, /[─-╿]/, `box drawing on the screen:\n${screen}`);
    assert.doesNotMatch(screen, /[⏺✗❯⎿⚠]/, 'no marks a reader spells out');
    assert.match(screen, /^\* Bash\(echo fine\)/m);
    assert.match(screen, /^x Bash\(false\)/m);
  });
});

test('a reply whose stream broke off is drawn once: what the failed try said leaves the screen and the pager, and the scroll says it is asked again', async () => {
  await onScreen({}, async ({ tty, events, shows, turn, finish, paged }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    events.emit('text', 'Starting the answer, then the stream breaks off here');
    await shows(/⏺ Starting the answer, then the stream breaks off here/, 'the reply as it streams');
    events.emit('retry', { attempt: 1, limit: 6, delayMs: 3000, reason: 'overloaded_error Overloaded' });
    await shows(/the reply broke off: Anthropic's API is overloaded just now · asking again\n/, 'why it starts again, on one row');
    assert.match(tty.screen(), /retrying in \ds · attempt 1\/6/, 'which try it is, on the working line');
    assert.doesNotMatch(tty.screen(), /breaks off here/, 'what the failed try said is not on the screen');
    // Broken off again the same way, it is not said again: the working line counts the tries.
    events.emit('text', 'Starting again, and broken off again');
    await shows(/Starting again/, 'the second try as it streams');
    events.emit('retry', { attempt: 2, limit: 6, delayMs: 3000, reason: 'overloaded_error Overloaded' });
    await shows(/attempt 2\/6/, 'the second try counted');
    assert.doesNotMatch(tty.screen(), /Starting again/);
    assert.equal(tty.screen().match(/the reply broke off/g).length, 1, tty.screen());
    events.emit('text', 'Starting the answer, then all of it. ');
    finish();
    await shows(/all of it\. ok/, 'the answer, whole');
    assert.equal(tty.screen().match(/Starting the answer/g).length, 1, `the answer drawn once:\n${tty.screen()}`);
    await tty.type(CTRL_O);
    for (let i = 0; i < 100 && paged.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.doesNotMatch(paged[0], /breaks off here/, 'nor is it in the pager');
    assert.match(paged[0], /Starting the answer, then all of it\./);
  });
});

test('a request sent again and again is said once in the scroll; each later try counts down on the working line alone, and a new reason is said', async () => {
  await onScreen({}, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    for (const attempt of [1, 2, 3]) events.emit('retry', { attempt, limit: 6, delayMs: 3000, reason: '529 overloaded_error Overloaded' });
    await shows(/attempt 3\/6/, 'the third try on the working line');
    assert.equal(tty.screen().match(/overloaded just now/g).length, 1, `one line for three tries:\n${tty.screen()}`);
    events.emit('retry', { attempt: 4, limit: 6, delayMs: 3000, reason: '429 rate_limit_error Number of request tokens has exceeded your per-minute rate limit' });
    await shows(/rate limited by the API · retrying \(4 of 6\)/, 'the new reason');
    finish();
    await shows(/⏺ ok/, 'the reply');
  });
});

test('plain mode opens on words, not pictures: no logo, no name in blocks — and nothing on it ticks while the model or a command works', async () => {
  const logo = Array.from({ length: 12 }, (_, i) => `${'⣿'.repeat(30)} logo row ${i}`);
  await onScreen({ plain: true, logo }, async ({ tty, events, tool, shows, turn, finish }) => {
    // Once the room is measured, which is when a logo would be drawn in it.
    await new Promise((r) => setTimeout(r, 300));
    const opening = tty.screen();
    assert.doesNotMatch(opening, /logo row|⣿/, 'no picture in the empty room');
    assert.doesNotMatch(opening, /[█▀▄]/, 'no name drawn in blocks');
    assert.match(opening, /^opus · high {2}sumo \S+\n\S/m, 'the route and the version, then where it works, as words');
    await turn();
    await shows(/Working… \(esc to interrupt\)/, 'the working line, without a clock');
    tool('c1', 'bash', { command: 'sleep 5' });
    await shows(/\| {2}Running…\n/, 'the command running, without a clock');
    events.emit('retry', { attempt: 1, limit: 6, delayMs: 5000, reason: '529 overloaded_error Overloaded' });
    await shows(/retrying · attempt 1\/6/, 'the try, without a countdown');
    const still = tty.screen();
    await new Promise((r) => setTimeout(r, 1300));
    assert.equal(tty.screen(), still, 'a second later the screen is as it was: nothing ticks for a reader to hear again');
    finish();
  });
});

test('at 80 columns the working line keeps how to stop the turn and which try it is: a long phrase gives way first, then the least needed of what follows it', async () => {
  const long = 'Reticulating the splines of a phrase that goes on well past the edge of any window';
  await onScreen({ columns: 80, messages: [long] }, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Reticulating/, 'the working line');
    events.emit('usage', { totals: { outputTokens: 1200 } });
    events.emit('retry', { attempt: 4, limit: 6, delayMs: 9000, reason: '529 overloaded_error Overloaded' });
    await shows(/attempt 4\/6/, 'the try on the working line');
    const row = tty.screen().split('\n').find((line) => line.startsWith('Reticulating'));
    assert.match(row, /^Reticulating the… \(\d+s · retrying in \ds · attempt 4\/6 · esc to interrupt\)$/, row);
    assert.ok(row.length <= 80, `${row.length} columns`);
    finish();
  });
  // Narrower still, what follows the words gives way too — the least needed first — and how to stop it stays.
  await onScreen({ columns: 50, messages: [long] }, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Reticulating/, 'the working line');
    events.emit('usage', { totals: { outputTokens: 1200 } });
    events.emit('retry', { attempt: 4, limit: 6, delayMs: 9000, reason: '529 overloaded_error Overloaded' });
    await shows(/\(esc to interrupt\)/, 'the working line, narrowed');
    const row = tty.screen().split('\n').find((line) => line.startsWith('Reticulating'));
    assert.match(row, /^Reticulating the splines of a… \(esc to interrupt\)$/, row);
    assert.ok(row.length <= 50, `${row.length} columns`);
    finish();
  });
});

test('a turn kept going because its edit was not checked says so in plain words — what was edited, what was not run, what the model is asked', async () => {
  await onScreen({}, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    events.emit('check', { edited: ['src/app.js'], checks: [] });
    await shows(/app\.js edited and not checked yet · the model is asked to check it/, 'the edit nothing checked');
    events.emit('check', { edited: ['src/app.js', 'src/cart.js'], checks: ['npm test'] });
    await shows(/2 files edited, npm test not run since · the model is asked to run it/, 'the check not run');
    assert.doesNotMatch(tty.screen(), /held/, 'no word of the code\'s own');
    finish();
  });
});

test('opened in a folder that is not a project, the header says where the tools work instead — scratch — and how to make the folder one', async () => {
  await onScreen({ columns: 100 }, async ({ tty, cwd }) => {
    const rows = tty.screen().split('\n');
    const where = rows.find((row) => row.startsWith('▄▄█'));
    assert.match(where, /\/scratch$/, `where the tools run, not where the chat was opened: ${where}`);
    const name = cwd.split('/').at(-1);
    assert.match(tty.screen().replace(/\s+/g, ' '), new RegExp(`${name} is not a project: the tools work in scratch — sumo project add \\. there makes it one`), tty.screen());
  });
});

test('a wrong key on a question explains every key inside its panel — no and Esc as well as yes — and the folder key names the folder short', async () => {
  await onScreen({ columns: 80 }, async ({ tty, events, shows }) => {
    const dir = '/private/var/folders/z5/3wb208393zq7cpkq6pj3dk2c0000gn/T/sumo-ux-outside';
    events.emit('approve', { name: EDITOR, server: 'editor', tool: 'outside the project', input: { command: 'str_replace', path: `${dir}/cfg.toml`, old_str: 'a = 1', new_str: 'a = 2' }, path: `${dir}/cfg.toml`, outside: true, guarded: null, directory: dir, resolve: () => {} });
    await shows(/Change this file outside the project\?/, 'the question');
    const asked = tty.screen().replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    assert.match(asked, /y once · a this file, session · d all of sumo-ux-outside\/, session · n no (?:· )?r no, say why · esc to interrupt/, `the keys, the folder by its name:\n${tty.screen()}`);
    await tty.type('x');
    await shows(/refuses it/, 'what the keys do');
    const panel = tty.screen().replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    assert.match(panel, /y changes it once · a this file, session (?:· )?d all of sumo-ux-outside\/, session (?:· )?n refuses it (?:· )?r with why (?:· )?esc interrupts the turn/, `every key, in the panel:\n${tty.screen()}`);
    const status = tty.screen().trimEnd().split('\n').at(-1);
    assert.match(status, /\/ commands/, `the status row keeps its own hints: ${status}`);
  });
});

test('a question of the model\'s is said once — no call row above repeats it — its keys break only between keys, and the answer is said as the user\'s', async () => {
  await onScreen({ columns: 80 }, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    const call = { id: 'q1', name: 'ask', input: { question: 'Which port should the server use when PORT is not set?' } };
    events.emit('tool', { call });
    let answer;
    events.emit('ask', { question: call.input.question, options: [{ label: '8080', detail: 'the usual for a dev server' }, { label: '3000', detail: 'keep what it was' }, { label: 'Fail fast', detail: 'refuse to start without PORT' }], resolve: (a) => (answer = a) });
    await shows(/\? Which port/, 'the question');
    assert.equal(tty.screen().match(/Which port should the server use/g).length, 1, `the question once:\n${tty.screen()}`);
    assert.match(tty.screen(), /\n {2}↑↓ choose · enter picks · 1–3 picks that one · or type your own answer\n {2}esc to interrupt\n/, 'the keys broken between keys, not inside one');
    await tty.type('2');
    events.emit('result', { call, result: { content: 'The user chose: 3000' } });
    await shows(/⏺ Question\(Which port should the server use when PORT is not set\?\)\n {2}⎿ {2}you chose 3000\n/, 'the answer, as the user\'s');
    assert.deepEqual(answer, { label: '3000' });
    const typed = { id: 'q2', name: 'ask', input: { question: 'Which host?' } };
    events.emit('tool', { call: typed });
    events.emit('result', { call: typed, result: { content: 'The user answered: localhost, and log it\n<sumo>\nmemory\n</sumo>' } });
    await shows(/⏺ Question\(Which host\?\)\n {2}⎿ {2}you answered: localhost, and log it\n/, 'what was typed, as the user\'s, without what rode with it for the model');
    assert.doesNotMatch(tty.screen(), /The user (chose|answered)|<sumo>/);
    finish();
  });
});

test('a change outside the project is headed in words — change, create, insert after a line — not by the editor\'s own command', async () => {
  await onScreen({ columns: 100 }, async ({ tty, events, shows }) => {
    const ask = (input, resolve) => events.emit('approve', { name: EDITOR, server: 'editor', tool: 'outside the project', input: { path: '/srv/app/cfg.toml', ...input }, path: '/srv/app/cfg.toml', outside: true, guarded: null, directory: '/srv/app', resolve });
    const answered = new Promise((resolve) => ask({ command: 'str_replace', old_str: 'a = 1', new_str: 'a = 2' }, resolve));
    await shows(/Change this file outside the project\?/, 'the question');
    assert.match(tty.screen(), /│ {3}change \/srv\/app\/cfg\.toml +│\n│ {3}- a = 1/, tty.screen());
    assert.doesNotMatch(tty.screen(), /str_replace/);
    await tty.type('n');
    await answered;
    const inserted = new Promise((resolve) => ask({ command: 'insert', insert_line: 3, insert_text: 'b = 1' }, resolve));
    await shows(/│ {3}insert into \/srv\/app\/cfg\.toml after line 3 +│\n│ {3}\+ b = 1/, 'an insert, in words');
    await tty.type('n');
    await inserted;
    const created = new Promise((resolve) => ask({ command: 'create', file_text: 'c = 1' }, resolve));
    await shows(/│ {3}create \/srv\/app\/cfg\.toml +│\n│ {3}\+ c = 1/, 'a new file, in words');
    await tty.type('n');
    await created;
  });
});

test('a turn quicker than a second says nothing of its time on the line it ends on, only what it did', async () => {
  await onScreen({}, async ({ tty, tool, shows, turn, finish }) => {
    await turn();
    tool('b1', 'bash', { command: 'echo hi' }, { content: 'hi' });
    finish();
    await shows(/\n {2}1 call · ↓ /, 'the line the turn ends on');
    assert.doesNotMatch(tty.screen(), /\n {2}0s · /, 'no 0s');
  });
});

test('in a narrow window a hint under the box is whole or not there: never cut in the middle of a word', async () => {
  await onScreen({ columns: 50 }, async ({ tty, shows, turn, finish }) => {
    await turn();
    await shows(/Working…/, 'the working line');
    await tty.type('and also check the tests', '\r');
    await shows(/next step: and also check the tests/, 'the message waiting');
    const status = tty.screen().trimEnd().split('\n').at(-1);
    assert.match(status, /scratch +↑ takes it back$/, status);
    assert.doesNotMatch(status, /\w…$/, status);
    // A word of the moment longer than the room is cut where a word ends.
    await tty.type('\x1a');
    await shows(/ctrl-z waits/, 'why ctrl-z did nothing');
    const said = tty.screen().trimEnd().split('\n').at(-1);
    assert.match(said, /opus · high +ctrl-z waits until [a-z ]*[a-z] …$/, said);
    finish();
  });
});

test('a call waiting on the user is said to wait once, by its panel: nothing under the call, no working line — and esc is named as the working line names it', async () => {
  await onScreen({ columns: 80 }, async ({ tty, events, shows, turn, finish }) => {
    await turn();
    await shows(/Working… \(/, 'the working line');
    const call = { id: 'e1', name: EDITOR, input: { command: 'str_replace', path: '/srv/app/cfg.toml', old_str: 'a = 1', new_str: 'a = 2' } };
    events.emit('tool', { call });
    const answered = new Promise((resolve) => events.emit('approve', { name: EDITOR, server: 'editor', tool: 'outside the project', input: call.input, path: '/srv/app/cfg.toml', outside: true, guarded: null, directory: '/srv/app', resolve }));
    await shows(/Change this file outside the project\?/, 'the question');
    const asked = tty.screen();
    assert.doesNotMatch(asked, /waiting for your answer/i, `said once, by the panel:\n${asked}`);
    assert.doesNotMatch(asked, /Working…|Running…|esc to interrupt\)/, `nothing else on the screen says it is at work:\n${asked}`);
    const panel = asked.replace(/[│╭╮╰╯─]/g, ' ').replace(/\s+/g, ' ');
    assert.match(panel, /n no (?:· )?r no, say why · esc to interrupt/, `esc in the working line's words:\n${asked}`);
    await tty.type('x');
    await shows(/esc interrupts the turn/, 'every key explained, esc in the same word');
    await tty.type('n');
    assert.equal(await answered, 'no');
    events.emit('result', { call, result: { content: 'declined', isError: true } });
    await shows(/Working… \(\d+s · esc to interrupt\)/, 'at work again once answered');
    // The model's own question names it the same way, and is the only thing that says it waits.
    events.emit('ask', { question: 'Which port?', options: [{ label: '8080' }, { label: '3000' }], resolve: () => {} });
    await shows(/\? Which port\?/, 'the question');
    assert.match(tty.screen(), /or type your own answer(?: · |\n {2})esc to interrupt\n/);
    assert.doesNotMatch(tty.screen(), /Waiting for your answer|Working…/);
    finish();
  });
});

test('an error is marked ✗ and goes on under its own words, what came back faint beneath it; an API refusal nobody named is said in words', async () => {
  const said = explained('400 invalid_request_error messages.1.content.0.image.source.base64: image exceeds 5 MB maximum: 7340032 bytes > 5242880 bytes');
  assert.match(said.text, /^error: the API refused the request — /, said.text);
  assert.match(said.detail, /^400 invalid_request_error messages\.1\.content\.0\.image/, 'what came back, kept to go under it');
  assert.match(explained('400 invalid_request_error Your credit balance is too low to access the Anthropic API.').text, /no credit left/, 'a known one is still said its own way');
  assert.match(explained('400 invalid_request_error prompt is too long: 210000 tokens > 200000 maximum').text, /no longer fits/, 'as the API sends it: no credential refused');
  assert.match(explained('400 invalid_request_error max_tokens: 128000 > 64000, which is the maximum allowed number of output tokens').text, /refused the request/);
  assert.match(explained('401 authentication_error invalid x-api-key').text, /refused the credential/);
  const send = async () => {
    throw new Error(said.detail);
  };
  await onScreen({ columns: 60, send }, async ({ tty, shows, turn }) => {
    await turn();
    await shows(/the API refused the request/, 'the failure in words');
    const rows = tty.screen().split('\n');
    const at = rows.findIndex((row) => row.startsWith('✗ error: the API refused'));
    assert.ok(at !== -1, `marked, at the margin:\n${tty.screen()}`);
    assert.match(rows[at + 1], /^ {2}\S/, `its second row under its words, not at the edge:\n${tty.screen()}`);
    assert.ok(rows.slice(at).some((row) => /^ {2}400 invalid_request_error/.test(row)), `what came back, under it:\n${tty.screen()}`);
    assert.doesNotMatch(tty.screen(), /^error: 400/m, 'never the API\'s words alone');
  });
});

test('what is only not there yet is a note, not a failure: /copy with nothing to copy, and a mistyped command echoed with the nearest one', async () => {
  await onScreen({}, async ({ tty, shows }) => {
    await tty.type('/copy', ENTER);
    await shows(/┃ \/copy\n {2}⎿ {2}no reply to copy yet\n/, 'a note under what was typed');
    await tty.type('/hlep', ENTER);
    await shows(/┃ \/hlep\n {2}⎿ {2}no command \/hlep — did you mean \/help\?\n/, 'what was typed, and the nearest command');
    assert.doesNotMatch(tty.screen(), /✗|^no (command|reply)/m, 'nothing drawn as a failure');
  });
});

test('a file in the project is named from it — in a call, a failed read and /export — and one outside has one spelling in its call and in its question', async () => {
  await onScreen({ columns: 120 }, async ({ tty, events, tool, shows }) => {
    mkdirSync(scratchDir(), { recursive: true });
    // The model may name the project by where it really is — under /private, on macOS, for one under /var.
    const real = realpathSync(scratchDir());
    tool('r1', EDITOR, { command: 'view', path: join(real, 'src', 'app.js') }, { content: '1\tconst port = 3000;' });
    await shows(/⏺ Read\(src\/app\.js\)/, 'a read in the project, named from it');
    tool('r2', EDITOR, { command: 'view', path: join(real, 'nope.js') }, { content: `${join(real, 'nope.js')} does not exist`, isError: true });
    await shows(/✗ Read\(nope\.js\)\n {2}⎿ {2}nope\.js does not exist\n/, 'a failed read, named from it too');
    const outside = mkdtempSync(join(tmpdir(), 'sumo-ux-outside-'));
    const given = join(outside, 'cfg.toml');
    const call = { id: 'e1', name: EDITOR, input: { command: 'str_replace', path: given, old_str: 'a = 1', new_str: 'a = 2' } };
    events.emit('tool', { call });
    // The question is asked about where the write lands: the folder resolved.
    const answered = new Promise((resolve) => events.emit('approve', { name: EDITOR, server: 'editor', tool: 'outside the project', input: call.input, path: join(realpathSync(outside), 'cfg.toml'), outside: true, guarded: null, directory: realpathSync(outside), resolve }));
    await shows(/Change this file outside the project\?/, 'the question');
    const shown = tilde(given);
    assert.ok(tty.screen().includes(`Update(${shown})`), `the call, by its whole path:\n${tty.screen()}`);
    assert.ok(tty.screen().includes(`change ${shown}`), `the question spells it the same way:\n${tty.screen()}`);
    await tty.type('n');
    await answered;
    events.emit('result', { call, result: { content: 'declined', isError: true } });
    await tty.type('/export notes/talk.md', ENTER);
    await shows(/the conversation is in notes\/talk\.md\n/, 'the file /export wrote, named from the project');
  });
});

test('/help is compact: a command or a key a row with a few words beside it — no table, no reply mark, under 35 rows at 80 columns', async () => {
  await onScreen({ columns: 80, rows: 24 }, async ({ tty, shows, session, paged }) => {
    await tty.type('/help', ENTER);
    await shows(/\/thinking on\|off/, 'the help');
    const screen = tty.screen();
    const help = screen.slice(screen.indexOf('┃ /help'), screen.lastIndexOf('╭')).trimEnd();
    const rows = help.split('\n');
    assert.ok(rows.length < 35, `${rows.length} rows:\n${help}`);
    assert.doesNotMatch(help, /[│┌└├┼]|⏺/, `no table, and not drawn as a reply:\n${help}`);
    for (const { name } of session.commands) assert.match(help, new RegExp(`^ {2}/${name}\\b[^\\n]* {2,}\\S`, 'm'), `/${name} on a row of its own, with what it does:\n${help}`);
    assert.match(help, /^ {2}esc +interrupt the turn/m, 'esc as the working line says it');
    assert.ok(rows.every((row) => row.length <= 80), help);
    // The pager has it as the screen does: a row each.
    await tty.type(CTRL_O);
    for (let i = 0; i < 100 && paged.length === 0; i++) await new Promise((r) => setTimeout(r, 10));
    assert.match(paged[0].replace(/\x1b\[[0-9;]*m/g, ''), /\n {2}\/model \[model\] \[effort\] +the model and effort[^\n]*\n[\s\S]*\n {2}esc +interrupt the turn/);
  });
});

test('the commands say what they do for you; /model answers as the status row does, and Tab after it describes each model and marks the one in use', async () => {
  await onScreen({ columns: 100 }, async ({ tty, shows, session }) => {
    for (const command of session.commands) assert.doesNotMatch(command.hint, /guides\/|\.md\b|\bthe route\b/, `/${command.name}: ${command.hint}`);
    await tty.type('/model', ENTER);
    await shows(/┃ \/model\n {2}⎿ {2}opus · high/, 'the route, as the status row says it');
    assert.doesNotMatch(tty.screen(), /opus\/high/);
    await tty.type('/model ');
    await shows(/❯ auto +the router picks/, 'the models, each with what it is for');
    assert.match(tty.screen(), /\n {4}opus +hard[^\n]*\(current\)/, `the one in use, marked:\n${tty.screen()}`);
    assert.match(tty.screen(), /\n {4}haiku +\S/, 'every one described');
    await tty.type('opus ');
    await shows(/❯ high +\S[^\n]*\(current\)/, 'the effort in use first, described and marked');
  });
});

test('/resume lists the saved sessions and says how to open one', async () => {
  await onScreen({}, async ({ tty, shows, db }) => {
    const earlier = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send: async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'noted' }], usage: { input_tokens: 10, output_tokens: 2 }, model: 'claude-opus-5-5' }) });
    earlier.start('startup');
    await earlier.say('plan the briefing redesign');
    earlier.end();
    await tty.type('/resume', ENTER);
    await shows(/⎿ {2}\w{8} · just now · no project · “plan the briefing redesign”[\s\S]*?\n {5}open one with \/resume <id>\n/, 'the list, and how to open one');
  });
});

test('the line still arriving shows no half-made mark: an open code span is code already, and a link shows its words until its address has come', () => {
  const reply = createRenderer(() => {}, styles(false), { width: 100 });
  reply.write('Set `POR');
  assert.equal(reply.tail, 'Set POR');
  reply.write('T` from [the docs](https://exa');
  assert.equal(reply.tail, 'Set PORT from the docs');
  reply.write('mple.com) and **keep it');
  assert.equal(reply.tail, 'Set PORT from the docs (https://example.com) and keep it');
  reply.write('** `');
  assert.equal(reply.tail, 'Set PORT from the docs (https://example.com) and keep it ', 'a mark with nothing after it yet is held back');
  // Inside a code block nothing is a mark: the live line is the code as it came.
  const code = createRenderer(() => {}, styles(false), { width: 100 });
  code.write('```js\nconst a = `x');
  assert.match(code.tail, /const a = `x$/);
});

test('the empty room never clips the logo — a window too short for it and the box leaves it out, a tall one shows it whole — and a line under the header says what to try', async () => {
  const logo = Array.from({ length: 17 }, (_, i) => `logo row ${i}`);
  await onScreen({ columns: 80, rows: 24, logo }, async ({ tty, shows }) => {
    await shows(/try "explain this project"/, 'what to try');
    await new Promise((r) => setTimeout(r, 200));
    assert.doesNotMatch(tty.screen(), /logo row/, `none of the logo, rather than a part of it:\n${tty.screen()}`);
  });
  await onScreen({ columns: 80, rows: 40, logo }, async ({ tty, shows }) => {
    await shows(/logo row 16/, 'the logo');
    for (let i = 0; i < 17; i++) assert.match(tty.screen(), new RegExp(`logo row ${i}\\b`), `row ${i}:\n${tty.screen()}`);
    assert.match(tty.screen(), /try "explain this project"/);
    // A menu under the box takes rows from the room: the logo moves up, or goes — it is never cut.
    await tty.type('/');
    await shows(/❯ \/fix/, 'the menu');
    await new Promise((r) => setTimeout(r, 100));
    const shown = (tty.screen().match(/logo row \d+/g) ?? []).length;
    assert.ok(shown === 0 || shown === 17, `all of the logo or none of it, not ${shown} rows:\n${tty.screen()}`);
  });
});
