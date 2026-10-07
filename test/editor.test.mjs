// The input box of the chat: what each key does to the text, the history, and the command menu.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { editor, keysOf, menuFor, paste, press } from '../src/editor.mjs';

const COMMANDS = [{ name: 'fix' }, { name: 'feature' }, { name: 'dream' }];
const type = (state, text) => [...text].reduce((s, ch) => press(s, ch, {}).state, state);
const key = (state, k, input = '') => press(state, input, k, COMMANDS).state;
const ENTER = { return: true };

describe('the chat input box', () => {
  it('inserts at the cursor, and deletes on either side of it', () => {
    let s = type(editor(), 'helo');
    s = key(s, { leftArrow: true });
    s = type(s, 'l');
    assert.deepEqual([s.text, s.cursor], ['hello', 4]);
    s = key(s, { backspace: true });
    assert.deepEqual([s.text, s.cursor], ['helo', 3]);
    s = key(s, { delete: true });
    assert.deepEqual([s.text, s.cursor], ['hel', 3]);
    s = key(s, { rightArrow: true });
    assert.equal(s.cursor, 3, 'the cursor stops at the end');
  });

  it('submits on Enter, trimmed, and starts clean; an empty box submits nothing', () => {
    const sent = press(type(editor(), '  do it '), '\r', ENTER);
    assert.equal(sent.submit, 'do it');
    assert.deepEqual([sent.state.text, sent.state.cursor], ['', 0]);
    assert.equal(press(type(editor(), '   '), '\r', ENTER).submit, undefined);
  });

  it('takes a new line from backslash-Enter, Shift-Enter, Option-Enter and Ctrl-J instead of submitting', () => {
    const slash = press(type(editor(), 'one\\'), '\r', ENTER);
    assert.deepEqual([slash.submit, slash.state.text], [undefined, 'one\n']);
    for (const k of [{ return: true, shift: true }, { return: true, meta: true }]) {
      const r = press(type(editor(), 'one'), '\r', k);
      assert.deepEqual([r.submit, r.state.text], [undefined, 'one\n']);
    }
    assert.equal(press(type(editor(), 'one'), 'j', { ctrl: true }).state.text, 'one\n');
  });

  it('recalls what was sent with Up and comes back to the draft with Down', () => {
    let s = press(type(editor(), 'first'), '\r', ENTER).state;
    s = press(type(s, 'second'), '\r', ENTER).state;
    s = type(s, 'draft');
    s = key(s, { upArrow: true });
    assert.equal(s.text, 'second');
    s = key(s, { upArrow: true });
    assert.equal(s.text, 'first');
    s = key(s, { upArrow: true });
    assert.equal(s.text, 'first', 'the oldest entry is the end of the road');
    s = key(key(s, { downArrow: true }), { downArrow: true });
    assert.deepEqual([s.text, s.cursor], ['draft', 5]);
  });

  it('moves between the lines of a multi-line text before it reaches for history', () => {
    let s = press(type(editor(), 'old'), '\r', ENTER).state;
    s = paste(s, 'abcdef\nxy\nlast line');
    s = key(s, { upArrow: true });
    assert.equal(s.cursor, 'abcdef\nxy'.length, 'a shorter line takes the cursor at its end');
    s = key(s, { upArrow: true });
    assert.deepEqual([s.text, s.cursor], ['abcdef\nxy\nlast line', 2], 'the column is kept where the line is long enough');
    s = key(s, { downArrow: true });
    assert.equal(s.cursor, 'abcdef\nxy'.length);
    s = key(key(s, { upArrow: true }), { upArrow: true });
    assert.equal(s.text, 'old', 'Up on the first line is history');
  });

  it('moves vertically by whole graphemes, so subsequent edits cannot split an emoji or accent', () => {
    for (const glyph of ['😀', 'e\u0301', '👨‍👩‍👧‍👦']) {
      const up = key(paste(editor(), `${glyph}\nx`), { upArrow: true });
      assert.equal(up.cursor, glyph.length, 'Up keeps a one-character column');
      assert.equal(key(up, { backspace: true }).text, '\nx');
      const base = paste(editor(), `x\n${glyph}`);
      const down = key({ ...base, cursor: 1 }, { downArrow: true });
      assert.equal(down.cursor, base.text.length, 'Down keeps a one-character column');
      const deleted = key(key(down, { leftArrow: true }), { delete: true });
      assert.equal(deleted.text, 'x\n');
      assert.equal(deleted.text.isWellFormed(), true);
    }
  });

  it('knows the line keys: Ctrl-A, Ctrl-E, Ctrl-U, Ctrl-K, Ctrl-W', () => {
    let s = paste(editor(), 'one\ntwo three');
    s = key(s, { ctrl: true }, 'a');
    assert.equal(s.cursor, 4, 'the start of the line the cursor is on');
    s = key(s, { ctrl: true }, 'e');
    assert.equal(s.cursor, 13);
    s = key(s, { ctrl: true }, 'w');
    assert.equal(s.text, 'one\ntwo ');
    s = key(s, { ctrl: true }, 'u');
    assert.deepEqual([s.text, s.cursor], ['one\n', 4]);
    s = key(type(s, 'abc'), { ctrl: true }, 'a');
    s = key(s, { ctrl: true }, 'k');
    assert.equal(s.text, 'one\n');
  });

  it('takes keys that arrive in one burst as the separate keys they were', () => {
    assert.deepEqual(keysOf('a', {}), [['a', {}]]);
    assert.deepEqual(keysOf('', { upArrow: true }), [['', { upArrow: true }]]);
    assert.deepEqual(keysOf('ok\x7f\t\r', {}), [['o', {}], ['k', {}], ['', { backspace: true }], ['', { tab: true }], ['\r', { return: true }]]);
    const burst = keysOf('go\rnext', {}).reduce((r, [input, k]) => ({ ...press(r.state, input, k), sent: [...r.sent, press(r.state, input, k).submit] }), { state: editor(), sent: [] });
    assert.deepEqual(burst.sent.filter(Boolean), ['go'], 'typed ahead of a busy screen, Enter still sends');
    assert.equal(burst.state.text, 'next');
  });

  it('pastes text whole, with its line ends made plain, and does not submit it', () => {
    const s = paste(type(editor(), 'a'), 'x\r\ny\rz');
    assert.deepEqual([s.text, s.cursor], ['ax\ny\nz', 6]);
  });

  it('offers the commands a slash could mean, and completes the chosen one', () => {
    assert.deepEqual(menuFor('/f', COMMANDS).map((c) => c.name), ['fix', 'feature']);
    assert.deepEqual(menuFor('/', COMMANDS).length, 3);
    assert.deepEqual(menuFor('/fix the bug', COMMANDS), [], 'once the arguments start the menu is gone');
    assert.deepEqual(menuFor('fix', COMMANDS), []);

    const tabbed = key(type(editor(), '/f'), { tab: true });
    assert.deepEqual([tabbed.text, tabbed.cursor], ['/fix ', 5]);
    const second = key(key(type(editor(), '/f'), { downArrow: true }), { tab: true });
    assert.equal(second.text, '/feature ');

    const partial = press(type(editor(), '/dr'), '\r', ENTER, COMMANDS);
    assert.deepEqual([partial.submit, partial.state.text], [undefined, '/dream '], 'Enter on half a command finishes the command');
    assert.equal(press(type(editor(), '/dream'), '\r', ENTER, COMMANDS).submit, '/dream');
  });

  it('offers a command\'s choices for the argument being typed, one argument at a time, and completes the chosen one', () => {
    const MODELS = ['haiku', 'sonnet', 'opus'];
    const EFFORTS = ['low', 'high'];
    const model = { name: 'model', hint: 'the route', choices: (given) => (given.length === 0 ? MODELS : given.length === 1 && given[0] !== 'haiku' ? EFFORTS : []) };
    const all = [...COMMANDS, model];
    const k = (state, k, input = '') => press(state, input, k, all).state;

    assert.deepEqual(menuFor('/model ', all).map((c) => c.label), ['haiku', 'sonnet', 'opus']);
    assert.deepEqual(menuFor('/model s', all).map((c) => c.label), ['sonnet']);
    assert.deepEqual(menuFor('/model sonnet ', all).map((c) => c.label), ['low', 'high']);
    assert.deepEqual(menuFor('/model haiku ', all), [], 'nothing to choose after haiku');
    assert.deepEqual(menuFor('/model sonnet high ', all), []);
    assert.deepEqual(menuFor('/fix ', all), [], 'a command without choices has no menu once its arguments start');
    assert.deepEqual(menuFor('/mo', all).map((c) => c.label), ['/model']);
    // A choice may bring a hint of its own, shown beside it as a command's is.
    const resume = { name: 'resume', hint: 'pick one up', choices: () => [{ name: 'a1b2c3d4', hint: '3h ago · simba' }, 'bare'] };
    assert.deepEqual(menuFor('/resume ', [resume]), [
      { name: 'a1b2c3d4', label: 'a1b2c3d4', hint: '3h ago · simba', complete: '/resume a1b2c3d4 ' },
      { name: 'bare', label: 'bare', hint: '', complete: '/resume bare ' },
    ]);
    assert.deepEqual(menuFor('/resume a1', [resume]).map((c) => c.label), ['a1b2c3d4']);

    const tabbed = k(type(editor(), '/model s'), { tab: true });
    assert.deepEqual([tabbed.text, tabbed.cursor], ['/model sonnet ', 14]);
    const second = k(k(tabbed, { downArrow: true }), { tab: true });
    assert.equal(second.text, '/model sonnet high ');
    const partial = press(type(editor(), '/model op'), '\r', ENTER, all);
    assert.deepEqual([partial.submit, partial.state.text], [undefined, '/model opus '], 'Enter on half a choice finishes the choice');
    assert.equal(press(type(editor(), '/model opus'), '\r', ENTER, all).submit, '/model opus');
    assert.equal(press(type(editor(), '/model opus '), '\r', ENTER, all).submit, undefined, 'a choice is still open');
    assert.equal(press(k(type(editor(), '/model opus '), { downArrow: true }), '\r', ENTER, all).state.text, '/model opus high ');
  });

  it('treats a character made of several code units as the one character it is', () => {
    let s = paste(editor(), 'a😀👨‍👩‍👧');
    s = key(s, { backspace: true });
    assert.equal(s.text, 'a😀', 'a family is one keystroke to delete');
    s = key(s, { leftArrow: true });
    assert.equal(s.cursor, 1, 'the cursor never stops inside a character');
    s = key(s, { delete: true });
    assert.equal(s.text, 'a');
    s = key(key(paste(s, '😀'), { leftArrow: true }), { rightArrow: true });
    assert.equal(s.cursor, 3);
  });

  it('moves and deletes by word with Option, and Ctrl-D deletes ahead', () => {
    let s = type(editor(), 'one two three');
    s = key(s, { meta: true, leftArrow: true });
    assert.equal(s.cursor, 8);
    s = key(s, { meta: true }, 'b');
    assert.equal(s.cursor, 4);
    s = key(s, { meta: true }, 'f');
    assert.equal(s.cursor, 7);
    s = key(s, { meta: true, rightArrow: true });
    assert.equal(s.cursor, 13);
    s = key(s, { meta: true, backspace: true });
    assert.equal(s.text, 'one two ');
    s = key(key(s, { ctrl: true }, 'a'), { ctrl: true }, 'd');
    assert.equal(s.text, 'ne two ');
  });

  it('walks past a recalled command to the entries before it, and back to the draft', () => {
    let s = press(type(editor(), 'older'), '\r', ENTER, COMMANDS).state;
    s = press(type(s, '/dream'), '\r', ENTER, COMMANDS).state;
    s = type(s, 'draft');
    s = key(s, { upArrow: true });
    assert.equal(s.text, '/dream');
    s = key(s, { upArrow: true });
    assert.equal(s.text, 'older', 'the menu of a recalled command does not catch the arrows');
    s = key(key(s, { downArrow: true }), { downArrow: true });
    assert.equal(s.text, 'draft');
  });

  it('keeps a control key in a burst a control key', () => {
    assert.deepEqual(keysOf('ab\x03', {}), [['a', {}], ['b', {}], ['c', { ctrl: true }]]);
  });
});
