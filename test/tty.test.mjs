import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRenderer, flow, header, logoLines, messageAt, pickMessage, prompt, renderBlock, renderLine, spinnerMessages, styles, sunset, toolView, wrap } from '../src/tty.mjs';

const on = styles(true);
const off = styles(false);

describe('the chat terminal rendering', () => {
  it('turns markdown marks into weight and indent, and leaves plain text alone when colour is off', () => {
    assert.equal(renderLine('# Title', on), '\x1b[1mTitle\x1b[22m');
    assert.equal(renderLine('- **Do this.** run `sumo x`', off), '  • Do this. run sumo x');
    assert.equal(renderLine('2. second', off), '  2. second');
    assert.equal(renderLine('nothing special', off), 'nothing special');
  });

  it('wraps long lines at the width, measuring only what is visible, with a hanging indent under bullets', () => {
    assert.equal(wrap('aaa bbb ccc ddd', 7), 'aaa bbb\nccc ddd');
    assert.equal(wrap(`${on.bold('aaa')} bbb ccc`, 7), `${on.bold('aaa')} bbb\nccc`, 'escape codes take no width');
    assert.equal(renderLine('- one two three four five', off, { width: 14 }), '  • one two\n    three four\n    five');
    assert.equal(renderLine('x'.repeat(50), off, { width: 10 }), 'x'.repeat(50), 'a word longer than the width is left whole');
  });

  it('renders streamed text line by line, keeping a partial line until it ends', () => {
    const out = [];
    const r = createRenderer((t) => out.push(t), off);
    r.write('- one\n- tw');
    assert.deepEqual(out, ['  • one\n'], 'a partial line is held back');
    r.write('o\n```\ncode **not bold**\n```\ntail');
    r.flush();
    assert.equal(out.join(''), '  • one\n  • two\n    ┌─\n    code **not bold**\n    └─\ntail');
  });

  it('shows the memory block without its tags, in spaced sections, with labels bold and questions yellow', () => {
    const block = '<sumo-memory machine="m">\nPreferences (2 of 9 shown · more on: git(1) — sumo search):\n- m15 Never add trailers\n- m5 Keep it cheap\nProjects: a (~/a)\nLeft off: a — here\nLeft off: b — there\nAsk the user: is this right?\nAsk the user: and this?\nWarning: the scribe failed\n</sumo-memory>';
    assert.equal(
      renderBlock(block, off),
      'Preferences (2 of 9 shown · more on: git(1) — sumo search):\n  m15 Never add trailers\n  m5 Keep it cheap\n\nProjects: a (~/a)\n\nLeft off: a — here\nLeft off: b — there\n\nAsk the user: is this right?\nAsk the user: and this?\n\nWarning: the scribe failed',
    );
    assert.match(renderBlock(block, on), /^\x1b\[1mPreferences\x1b\[22m/);
    assert.match(renderBlock(block, on), /\x1b\[33mAsk the user: is this right\?\x1b\[39m/);
    assert.match(renderBlock(block, on), /\x1b\[31mWarning: the scribe failed\x1b\[39m/);
  });

  it('keeps the route in the header and the prompt, and the context size once it matters', () => {
    assert.equal(header({ route: 'opus · high', cwd: '/w' }, off), 'sumo  route opus · high  /w');
    assert.equal(prompt({ route: 'opus · high', contextTokens: 0 }, off), 'sumo opus · high> ');
    assert.equal(prompt({ route: 'auto → sonnet · medium', contextTokens: 12_400 }, off), 'sumo auto → sonnet · medium 12k> ');
  });

  it('lets the screen see the line still being written', () => {
    const r = createRenderer(() => {}, off);
    r.write('done\nhalf a li');
    assert.equal(r.tail, 'half a li');
    r.flush();
    assert.equal(r.tail, '');
  });

  it('reads the working messages from a file the user edits: one a line, comments and blanks skipped', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-spinner-')), 'spinner.txt');
    writeFileSync(file, '# mine\nWrestling\n\n  Salting the ring  \n');
    assert.deepEqual(spinnerMessages(file), ['Wrestling', 'Salting the ring']);
    assert.deepEqual(spinnerMessages(join(tmpdir(), 'no-such-spinner.txt')), ['Working'], 'no file is not an error');
    writeFileSync(file, '# nothing yet\n');
    assert.deepEqual(spinnerMessages(file), ['Working']);
    assert.equal(pickMessage(['a', 'b', 'c'], () => 0.5), 'b');
    assert.equal(pickMessage(['a', 'b', 'c'], () => 0.999), 'c');
  });

  it('moves the working line on to the next message every five seconds, round the file and back to the start', () => {
    const messages = ['a', 'b', 'c'];
    assert.equal(messageAt(messages, 'b', 0), 'b');
    assert.equal(messageAt(messages, 'b', 4999), 'b');
    assert.equal(messageAt(messages, 'b', 5000), 'c');
    assert.equal(messageAt(messages, 'b', 10_000), 'a', 'round to the start');
    assert.equal(messageAt(['Working'], 'Working', 60_000), 'Working', 'one message stays');
  });

  it('colours in a sunset — gold into crimson — that flows through words one character a frame', () => {
    assert.equal(sunset(0), '#ffd166');
    assert.equal(sunset(1), '#d62828');
    assert.match(sunset(0.25), /^#[0-9a-f]{6}$/);
    assert.equal(sunset(-1), sunset(0), 'held to the ends');
    assert.equal(flow(0, 0), sunset(0));
    assert.equal(flow(3, 1), flow(2, 0), 'each colour moves one character on, each frame');
    assert.notEqual(flow(0, 1), flow(0, 0), 'a character changes colour as it flows');
    const loop = Array.from({ length: 48 }, (_, i) => flow(i, 0));
    assert.deepEqual(loop.slice(24), loop.slice(0, 24), 'there and back again, round and round');
    assert.ok(loop.includes(sunset(1)), 'crimson on the way');
  });

  it('reads the logo from a file the user edits: its rows kept as drawn, an empty row inside it kept, comments and the blank edges dropped', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'sumo-agents-logo-')), 'logo.txt');
    writeFileSync(file, '# mine\n\n  ⣴⣿\n\n⣿⣿⣿⣿\n   \n');
    assert.deepEqual(logoLines(file), ['  ⣴⣿', '', '⣿⣿⣿⣿'], 'the spaces that place a row are kept; nothing after its last dot is');
    assert.deepEqual(logoLines(join(tmpdir(), 'no-such-logo.txt')), [], 'no file is not an error: nothing is drawn');
    writeFileSync(file, '# nothing yet\n\n');
    assert.deepEqual(logoLines(file), []);
  });

  it('shows a tool call the way the work reads: what ran, and the top of what came back', () => {
    const bash = { name: 'bash', input: { command: 'npm test\necho more' } };
    assert.deepEqual(toolView(bash), { title: 'Bash', detail: 'npm test …', lines: [] }, 'before the result there is only the call');
    assert.deepEqual(toolView(bash, { content: 'a\nb\nc\nd\ne', isError: false }).lines, [
      { text: 'a', tone: 'plain' },
      { text: 'b', tone: 'plain' },
      { text: 'c', tone: 'plain' },
      { text: '… +2 lines', tone: 'dim' },
    ]);
    assert.deepEqual(toolView(bash, { content: '', isError: false }).lines, [{ text: '(no output)', tone: 'dim' }]);
    assert.deepEqual(toolView(bash, { content: 'boom\n(exit 1)', isError: true }).lines.map((l) => l.tone), ['error', 'error']);
  });

  it('shows an edit as the lines that went and the lines that came', () => {
    const edit = { name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: '/p/a.mjs', old_str: 'const a = 1;', new_str: 'const a = 2;\nconst b = 3;' } };
    assert.deepEqual(toolView(edit, { content: 'edited /p/a.mjs', isError: false }), {
      title: 'Update',
      detail: '/p/a.mjs',
      lines: [
        { text: '- const a = 1;', tone: 'del' },
        { text: '+ const a = 2;', tone: 'add' },
        { text: '+ const b = 3;', tone: 'add' },
      ],
    });
    assert.deepEqual(toolView(edit, { content: 'old_str was not found in /p/a.mjs', isError: true }).lines, [{ text: 'old_str was not found in /p/a.mjs', tone: 'error' }], 'a refused edit shows the refusal, not the diff');

    const view = { name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/p/a.mjs', view_range: [1, 40] } };
    assert.deepEqual(toolView(view, { content: '1\ta\n2\tb', isError: false }), { title: 'Read', detail: '/p/a.mjs:1-40', lines: [{ text: '2 lines', tone: 'dim' }] });
    const create = { name: 'str_replace_based_edit_tool', input: { command: 'create', path: '/p/new.mjs', file_text: 'x\ny\n' } };
    assert.deepEqual(toolView(create, { content: 'created /p/new.mjs', isError: false }), { title: 'Write', detail: '/p/new.mjs', lines: [{ text: '2 lines', tone: 'dim' }] });
  });

  it('holds a table until it is whole, then draws it with its columns lined up', () => {
    const out = [];
    const r = createRenderer((t) => out.push(t), off, { width: 60 });
    r.write('before\n| Name | Count |\n|:--|--:|\n| **alpha** | 1 |\n');
    assert.deepEqual(out, ['before\n'], 'rows wait for the rest of the table');
    assert.match(r.tail, /│ alpha │/, 'the screen can show the table as far as it has got');
    r.write('| b | 200 |\nafter\n');
    assert.equal(out.join(''), 'before\n┌───────┬───────┐\n│ Name  │ Count │\n├───────┼───────┤\n│ alpha │     1 │\n│ b     │   200 │\n└───────┴───────┘\nafter\n');

    const last = [];
    const end = createRenderer((t) => last.push(t), off, { width: 60 });
    end.write('| a | b |\n|---|---|\n| 1 | 2 |');
    end.flush();
    assert.equal(last.join(''), '┌───┬───┐\n│ a │ b │\n├───┼───┤\n│ 1 │ 2 │\n└───┴───┘', 'a table the text ends on is drawn when the text ends');
  });

  it('leaves pipes alone where they are not a table, and folds a wide table into the window', () => {
    const out = [];
    const r = createRenderer((t) => out.push(t), off, { width: 60 });
    r.write('| just | pipes |\nnext\n```\n| a | b |\n|---|---|\n```\n');
    assert.equal(out.join(''), '| just | pipes |\nnext\n    ┌─\n    | a | b |\n    |---|---|\n    └─\n');

    const narrow = [];
    const n = createRenderer((t) => narrow.push(t), off, { width: 30 });
    n.write('| Key | What it does |\n|---|---|\n| esc | stops the turn that is running now |\n\n');
    const lines = narrow.join('').trimEnd().split('\n');
    assert.ok(lines.every((l) => l.length <= 30), `no line is wider than the window:\n${lines.join('\n')}`);
    assert.equal(new Set(lines.filter((l) => /^[│┌├└]/.test(l)).map((l) => l.length)).size, 1, 'the box keeps its shape');
    for (const word of ['stops', 'the', 'turn', 'that', 'is', 'running', 'now']) assert.ok(lines.some((l) => l.includes(word)), word);
  });

  it('shows a tool call in full when asked: every line that came back, the file that was read or written', () => {
    const bash = { name: 'bash', input: { command: 'seq 5' } };
    assert.deepEqual(toolView(bash, { content: 'a\nb\nc\nd\ne', isError: false }, { full: true }).lines.map((l) => l.text), ['a', 'b', 'c', 'd', 'e']);
    const view = { name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/p/a.mjs' } };
    assert.deepEqual(toolView(view, { content: '1\ta\n2\tb', isError: false }, { full: true }).lines, [{ text: '1\ta', tone: 'plain' }, { text: '2\tb', tone: 'plain' }]);
    const create = { name: 'str_replace_based_edit_tool', input: { command: 'create', path: '/p/new.mjs', file_text: 'x\ny\n' } };
    assert.deepEqual(toolView(create, { content: 'created /p/new.mjs', isError: false }, { full: true }).lines, [{ text: '+ x', tone: 'add' }, { text: '+ y', tone: 'add' }]);
  });
});
