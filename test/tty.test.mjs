import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRenderer, flow, header, logoLines, messageAt, pickMessage, prompt, renderBlock, renderLine, spinnerMessages, styles, sunset, toolView, wrap } from '../src/tty.mjs';

const on = styles(true);
const off = styles(false);

describe('the chat terminal rendering', () => {
  it('turns markdown marks into weight and indent, and leaves plain text alone when colour is off', () => {
    assert.equal(renderLine('## Title', on), '\x1b[1mTitle\x1b[22m');
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

    // A word cut to fit its column is cut between characters, never through one: an emoji is two code units.
    const emoji = [];
    const e = createRenderer((t) => emoji.push(t), off, { width: 20 });
    e.write(`| Key | What |\n|---|---|\n| a | x${'😀'.repeat(12)} |\n\n`);
    assert.ok(emoji.join('').isWellFormed(), `no character is split in half:\n${emoji.join('')}`);
    assert.equal(emoji.join('').match(/😀/g).length, 12, 'every emoji is still there');
    // One joined from several (a family: three people and two joiners) is one character too.
    const joined = [];
    const j = createRenderer((t) => joined.push(t), off, { width: 20 });
    j.write(`| Key | What |\n|---|---|\n| a | x${'👨‍👩‍👧'.repeat(3)} |\n\n`);
    assert.equal(joined.join('').match(/👨‍👩‍👧/gu).length, 3, `no joined emoji is cut apart:\n${joined.join('')}`);
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

describe('tabs', () => {
  it('reach the screen as spaces in a reply, so a wrapped line or a box around it is not pushed out of place', () => {
    const out = [];
    const reply = createRenderer((t) => out.push(t), styles(false), { width: 80 });
    reply.write('```\nall:\n\tgo build\n```\n');
    reply.flush();
    assert.ok(!out.join('').includes('\t'), JSON.stringify(out.join('')));
    assert.match(out.join(''), / {4}go build/);
  });
});

describe('wide characters', () => {
  // Two columns for CJK and for an emoji drawn as a picture; one for everything else here.
  const columns = (line) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(line)].reduce((n, { segment }) => n + (/[一-鿿]|\p{Emoji_Presentation}/u.test(segment) ? 2 : 1), 0);

  it('line a table up by the columns they take, whether a cell fits or is folded', () => {
    const out = [];
    const r = createRenderer((t) => out.push(t), styles(false), { width: 80 });
    r.write('| 名前 | 状態 |\n|---|---|\n| 日本語 | ✅ done |\n| ascii | ok |\n\n');
    r.flush();
    const rows = out.join('').split('\n').filter((l) => /^[┌│├└]/.test(l));
    assert.equal(new Set(rows.map(columns)).size, 1, rows.join('\n'));

    const narrow = [];
    const folded = createRenderer((t) => narrow.push(t), styles(false), { width: 24 });
    folded.write(`| x | 説明 |\n|---|---|\n| a | ${'漢字'.repeat(12)} |\n\n`);
    folded.flush();
    const foldedRows = narrow.join('').split('\n').filter((l) => /^[┌│├└]/.test(l));
    assert.equal(new Set(foldedRows.map(columns)).size, 1, foldedRows.join('\n'));
    assert.ok(columns(foldedRows[0]) <= 24, foldedRows.join('\n'));
  });
});

describe('the markdown a model writes', () => {
  const rendered = (text, s = off, width = 80) => {
    const out = [];
    const r = createRenderer((t) => out.push(t), s, { width });
    r.write(text);
    r.flush();
    return out.join('');
  };

  it('never leaves a broken escape behind: a link after bold text keeps every code whole', () => {
    const line = rendered('with **bold**, `code`, and a [link](https://example.com) after.', on);
    assert.doesNotMatch(line, /\x1b(?!\[)/, JSON.stringify(line));
    assert.equal(line.replace(/\x1b\[[0-9;]*m/g, ''), 'with bold, code, and a link (https://example.com) after.');
  });

  it('shows emphasis, strike-through and escapes as the reader means them, and leaves snake_case and arithmetic alone', () => {
    assert.equal(rendered('*it* and _it_ and __bold__ and ***both*** and ~~gone~~'), 'it and it and bold and both and gone');
    assert.match(rendered('*it*', on), /\x1b\[3mit\x1b\[23m/);
    assert.match(rendered('~~gone~~', on), /\x1b\[9mgone\x1b\[29m/);
    assert.equal(rendered('snake_case_name and 2*3*4 and a * b * c'), 'snake_case_name and 2*3*4 and a * b * c');
    assert.equal(rendered('\\*not italic\\* and \\`tick\\`'), '*not italic* and `tick`');
    assert.equal(rendered('`**kept** as _typed_`'), '**kept** as _typed_', 'nothing inside code is read as a mark');
    assert.equal(rendered('[https://x.dev](https://x.dev) and <https://y.dev>'), 'https://x.dev and https://y.dev', 'a link that is its own text is said once');
    assert.equal(rendered('odd \uE0007\uE001 text'), 'odd \uE0007\uE001 text', 'text that looks like a stand-in is left as it is');
  });

  it('draws every kind of bullet, and a task list as boxes ticked or not', () => {
    assert.equal(rendered('+ plus\n- [ ] open\n- [x] done\n* [X] also done'), '  • plus\n  ☐ open\n  ☑ done\n  ☑ also done');
  });

  it('keeps a line that continues a list item under its text, not under the marker', () => {
    assert.equal(rendered('1. first\n   more of the first\n- bullet\n  more of the bullet\nback out'), '  1. first\n     more of the first\n  • bullet\n    more of the bullet\nback out');
    assert.equal(rendered('10. tenth\n    more of it'), '  10. tenth\n      more of it');
  });

  it('marks a quote and still reads the marks inside it, and names the language a code block is in', () => {
    assert.equal(rendered('> a **bold** claim'), '  │ a bold claim');
    assert.equal(rendered('```js\nconst x = 1;\n```'), '    ┌─ js\n    const x = 1;\n    └─');
  });

  it('sets a heading apart by its level: the top one underlined as well as bold', () => {
    assert.equal(renderLine('# Title', on), '\x1b[1m\x1b[4mTitle\x1b[24m\x1b[22m');
    assert.equal(renderLine('## Part', on), '\x1b[1mPart\x1b[22m');
    assert.equal(renderLine('### Small', off), 'Small');
  });

  it('shows a delegated job ended by how it went, what it cost and the top of its report, not the raw status lines', () => {
    const call = { name: 'delegate', input: { agent: 'scout', title: 'Map it' } };
    const job = { id: 41, status: 'done', turns: 3, toolCalls: 9, costUsd: 0.0213, model: 'sonnet', effort: 'low', report: 'It lives in tty.mjs.\n- tables\n- lines\n- tools\n- more' };
    const content = 'STATUS: DONE — j41\n3 turns, 9 tool calls, 48211 tokens in, 1203 out, $0.0213 on sonnet/low\n\nIt lives in tty.mjs.';
    assert.deepEqual(toolView(call, { content, job }).lines, [
      { text: '✓ j41 done · 3 turns · 9 tool calls · $0.02 · sonnet/low', tone: 'add' },
      { text: 'It lives in tty.mjs.', tone: 'plain' },
      { text: '- tables', tone: 'plain' },
      { text: '- lines', tone: 'plain' },
      { text: '… +2 lines', tone: 'dim' },
    ]);
    const failed = toolView(call, { content, job: { ...job, status: 'failed', report: '' } }).lines;
    assert.deepEqual(failed[0], { text: '✗ j41 failed · 3 turns · 9 tool calls · $0.02 · sonnet/low', tone: 'error' });
    assert.deepEqual(toolView(call, { content, job }, { full: true }).lines.map((l) => l.text), content.split('\n'), 'the full view is everything the model was told');
  });
});

describe('paths', () => {
  it('are shown from the home directory as ~, so a tool line says where without the long way round', () => {
    const view = { name: 'str_replace_based_edit_tool', input: { command: 'view', path: join(homedir(), 'proj', 'a.mjs'), view_range: [1, 9] } };
    assert.equal(toolView(view).detail, '~/proj/a.mjs:1-9');
    assert.equal(toolView({ ...view, input: { ...view.input, path: '/etc/hosts', view_range: undefined } }).detail, '/etc/hosts');
    assert.equal(toolView({ ...view, input: { ...view.input, path: `${homedir()}-other/a.mjs`, view_range: undefined } }).detail, `${homedir()}-other/a.mjs`, 'only the home itself, not a name that starts the same');
  });
});
