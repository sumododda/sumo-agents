import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { createRenderer, explained, flow, header, highlight, linked, logoLines, markdownOf, messageAt, pickMessage, prompt, renderBlock, renderLine, renderTable, spinnerMessages, styles, sunset, toolView, transcript, withoutColourCodes, wrap } from '../src/tty.mjs';

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
    // Left whole, the screen breaks it anyway — at the edge of its box, under nothing: cut here, it goes on under its indent.
    assert.equal(renderLine('x'.repeat(25), off, { width: 10 }), 'xxxxxxxxxx\nxxxxxxxxxx\nxxxxx', 'a word longer than the width is cut at the edge');
    assert.equal(renderLine(`- see ${'y'.repeat(20)} now`, off, { width: 14 }), '  • see\n    yyyyyyyyyy\n    yyyyyyyyyy\n    now', 'and goes on under the item it is in');
    assert.equal(wrap(`a ${on.bold('b'.repeat(12))}`, 8), `a\n${on.bold('bbbbbbbb\n\x1b[1mbbbb')}`, 'a colour code takes no room in a cut, and the style goes on in the next row');
    assert.equal(renderLine('  // a comment that is long', off, { width: 20, fence: true }), '      // a comment\n      that is long', 'a code line goes on at its own indent');
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

  it('shows a tool call the way the work reads: the command whole, and both ends of what came back', () => {
    const bash = { name: 'bash', input: { command: 'npm test\necho more' } };
    assert.deepEqual(toolView(bash), { title: 'Bash', detail: 'npm test\necho more', lines: [] }, 'before the result there is only the call');
    assert.deepEqual(toolView(bash, { content: 'a\nb\nc\nd\ne', isError: false }).lines.map((l) => l.text), ['a', 'b', 'c', 'd', 'e'], 'a few lines are shown whole');
    // The verdict of a test run is its last lines: the top two and the last three are shown, the middle counted.
    assert.deepEqual(toolView(bash, { content: 'banner\none\ntwo\nthree\nfour\nfive\nFAIL\n(exit 1)', isError: false }).lines, [
      { text: 'banner', tone: 'plain' },
      { text: 'one', tone: 'plain' },
      { text: '… +3 lines', tone: 'dim' },
      { text: 'five', tone: 'plain' },
      { text: 'FAIL', tone: 'plain' },
      { text: '(exit 1)', tone: 'plain' },
    ]);
    assert.deepEqual(toolView(bash, { content: '', isError: false }).lines, [{ text: '(no output)', tone: 'dim' }]);
    assert.deepEqual(toolView(bash, { content: 'boom\n(exit 1)', isError: true }).lines.map((l) => l.tone), ['error', 'error']);
  });

  it('shows a long command folded to its first lines, and whole when asked', () => {
    const long = `cd /work && ${'grep -rn "needle" src test docs | sort | uniq -c | '.repeat(8)}wc -l`;
    const folded = toolView({ name: 'bash', input: { command: long } }).detail;
    assert.ok(folded.length > 200 && folded.length < long.length && folded.endsWith(' …'), `more than a line of it, and not all of it: ${folded.length}`);
    assert.equal(toolView({ name: 'bash', input: { command: long } }, null, { full: true }).detail, long, 'asked for in full, the command is whole');
    const script = { name: 'bash', input: { command: 'set -e\nnpm ci\nnpm test\nnpm run lint\n' } };
    assert.equal(toolView(script).detail, 'set -e\nnpm ci\nnpm test …', 'the first three lines of a script, and that there is more');
    assert.equal(toolView(script, null, { full: true }).detail, 'set -e\nnpm ci\nnpm test\nnpm run lint');
  });

  it('shows an edit as a diff: the lines that changed, numbered as the file numbers them, with a line of what stayed around them', () => {
    const input = { command: 'str_replace', path: '/p/cart.js', old_str: '  for (const item of items) {\n    sum += item.price;\n  }', new_str: '  for (const item of items) {\n    sum += item.price * (item.quantity ?? 1);\n  }' };
    const edit = { name: 'str_replace_based_edit_tool', input };
    // What the editor says it did: where the old text began, and the text as the file had it and has it now.
    const done = { content: 'edited /p/cart.js', isError: false, edit: { line: 3, old: input.old_str, new: input.new_str } };
    assert.deepEqual(toolView(edit, done), {
      title: 'Update',
      detail: '/p/cart.js:4',
      stat: { added: 1, removed: 1 },
      lines: [
        { text: '3     for (const item of items) {', tone: 'dim' },
        { text: '4 -     sum += item.price;', tone: 'del' },
        { text: '4 +     sum += item.price * (item.quantity ?? 1);', tone: 'add' },
        { text: '5     }', tone: 'dim' },
      ],
    });
    // Lines only added: numbered as the new file numbers them.
    const grown = { name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: '/p/a.mjs', old_str: 'const a = 1;', new_str: 'const a = 1;\nconst b = 3;' } };
    assert.deepEqual(toolView(grown, { content: 'edited /p/a.mjs', isError: false, edit: { line: 9, old: 'const a = 1;', new: 'const a = 1;\nconst b = 3;' } }).lines, [
      { text: ' 9   const a = 1;', tone: 'dim' },
      { text: '10 + const b = 3;', tone: 'add' },
    ]);
    // A result that does not say where (one kept from before): the same diff, without the numbers.
    assert.deepEqual(toolView(edit, { content: 'edited /p/cart.js', isError: false }).lines.map((l) => l.text), ['    for (const item of items) {', '-     sum += item.price;', '+     sum += item.price * (item.quantity ?? 1);', '    }']);
    assert.deepEqual(toolView(edit, { content: 'old_str was not found in /p/cart.js', isError: true }).lines, [{ text: 'old_str was not found in /p/cart.js', tone: 'error' }], 'a refused edit shows the refusal, not the diff');

    // A big change folded: what went and what came each keep their top, so what was added is never folded away whole.
    const many = (n, word) => Array.from({ length: n }, (_, i) => `${word} ${i}`).join('\n');
    const big = toolView({ name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: '/p/a.mjs', old_str: many(20, 'old'), new_str: many(20, 'new') } }, { content: 'edited', isError: false, edit: { line: 1, old: many(20, 'old'), new: many(20, 'new') } });
    assert.deepEqual(big.stat, { added: 20, removed: 20 });
    assert.ok(big.lines.some((l) => l.tone === 'add' && /new 0$/.test(l.text)) && big.lines.some((l) => l.tone === 'del' && /old 0$/.test(l.text)), 'both sides show');
    assert.equal(big.lines.filter((l) => /^… \+\d+ lines$/.test(l.text)).length, 2, 'and each says how much more there is');
    assert.ok(big.lines.length <= 14);

    // An insert: the lines that came, numbered from the line they landed on.
    const insert = { name: 'str_replace_based_edit_tool', input: { command: 'insert', path: '/p/a.mjs', insert_line: 2, insert_text: 'x\ny\n' } };
    assert.deepEqual(toolView(insert, { content: 'inserted', isError: false, edit: { line: 3, old: '', new: 'x\ny' } }), { title: 'Update', detail: '/p/a.mjs:3', stat: { added: 2, removed: 0 }, lines: [{ text: '3 + x', tone: 'add' }, { text: '4 + y', tone: 'add' }] });

    const view = { name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/p/a.mjs', view_range: [1, 40] } };
    assert.deepEqual(toolView(view, { content: '1\ta\n2\tb', isError: false }), { title: 'Read', detail: '/p/a.mjs:1-40', lines: [{ text: '2 lines', tone: 'dim' }] });
    const create = { name: 'str_replace_based_edit_tool', input: { command: 'create', path: '/p/new.mjs', file_text: 'x\ny\n' } };
    // A new file is shown by its top, as what came; past four lines, how many more.
    assert.deepEqual(toolView(create, { content: 'created /p/new.mjs', isError: false }), { title: 'Write', detail: '/p/new.mjs', lines: [{ text: '+ x', tone: 'add' }, { text: '+ y', tone: 'add' }] });
    const longer = { ...create, input: { ...create.input, file_text: 'a\nb\nc\nd\ne\nf\n' } };
    assert.deepEqual(toolView(longer, { content: 'created', isError: false }).lines.map((l) => l.text), ['+ a', '+ b', '+ c', '+ d', '… +2 lines']);
    assert.deepEqual(toolView({ ...create, input: { ...create.input, file_text: '' } }, { content: 'created', isError: false }).lines, [{ text: '(empty)', tone: 'dim' }]);
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
    // Code is what is read most closely: its frame is faint, the code itself is not.
    const lit = [];
    const coloured = createRenderer((t) => lit.push(t), styles(true));
    coloured.write('```js\nconst x = 1;\n```\n');
    assert.equal(lit[1], '    \x1b[35mconst\x1b[39m x = \x1b[33m1\x1b[39m;\n', 'the code at full weight, in its language\'s colours');
    assert.match(lit[0], /\x1b\[2m/, 'the frame dim');
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
      { text: '• tables', tone: 'plain' },
      { text: '• lines', tone: 'plain' },
      { text: '… +2 lines', tone: 'dim' },
    ]);
    const failed = toolView(call, { content, job: { ...job, status: 'failed', report: '' } }).lines;
    assert.deepEqual(failed[0], { text: '✗ j41 failed · 3 turns · 9 tool calls · $0.02 · sonnet/low', tone: 'error' });
    // How long the job took, when the result says: it is what the wait was.
    assert.equal(toolView(call, { content, job: { ...job, seconds: 130 } }).lines[0].text, '✓ j41 done · 2m 10s · 3 turns · 9 tool calls · $0.02 · sonnet/low');
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

  it('are shown from the project when they are in it: the file, not the way to it', () => {
    const view = { name: 'str_replace_based_edit_tool', input: { command: 'view', path: '/work/shop/src/cart.js', view_range: [1, 9] } };
    assert.equal(toolView(view, null, { cwd: '/work/shop' }).detail, 'src/cart.js:1-9');
    assert.equal(toolView(view, null, { cwd: '/work/sh' }).detail, '/work/shop/src/cart.js:1-9', 'only the project itself, not a name that starts the same');
    assert.equal(toolView({ ...view, input: { command: 'view', path: '/work/shop' } }, null, { cwd: '/work/shop' }).detail, '.', 'the project itself');
  });
});

describe('the conversation as text for a pager', () => {
  it('is every entry in full: what was said, each reply as it is drawn, the whole command and all it printed, an edit as its diff', () => {
    const many = Array.from({ length: 30 }, (_, i) => `line ${i + 1}`).join('\n');
    const log = [
      { kind: 'header', route: 'opus · high', cwd: '~/shop', block: '' },
      { kind: 'user', text: 'fix the total\nand say why' },
      { kind: 'reply', raw: 'Looking at **cart.js**.' },
      { kind: 'tool', call: { name: 'bash', input: { command: `npm test # ${'x'.repeat(300)}` } }, result: { content: many, isError: true } },
      { kind: 'tool', call: { name: 'str_replace_based_edit_tool', input: { command: 'str_replace', path: '/work/shop/cart.js', old_str: 'a', new_str: 'b' } }, result: { content: 'edited', isError: false, edit: { line: 4, old: 'a', new: 'b' } } },
      { kind: 'user', text: '! git status' },
      { kind: 'shell', result: { content: 'clean', isError: false } },
      { kind: 'job', id: 7, agent: 'scout', route: 'sonnet/low', title: 'look' },
      { kind: 'note', text: 'Interrupted' },
      { kind: 'error', text: 'error: 529' },
      { kind: 'footer', text: '48s · 2 calls · $0.07' },
    ];
    const text = transcript(log, styles(false), { width: 80, cwd: '/work/shop' });
    assert.ok(text.startsWith('┃ fix the total\n┃ and say why\n\n⏺ Looking at cart.js.\n\n⏺ Bash(npm test # xxx'), text.slice(0, 120));
    assert.ok(text.includes('x'.repeat(300)), 'the command whole');
    assert.match(text, /⎿ {2}line 1\n {5}line 2\n[\s\S]* {5}line 30\n/);
    assert.equal(text.match(/line \d+/g).length, 30, 'every line it printed');
    assert.match(text, /\n⏺ Update\(cart\.js:4\) \+1 −1\n {2}⎿ {2}4 - a\n {5}4 \+ b\n/);
    assert.match(text, /\n┃ ! git status\n {2}⎿ {2}clean\n/);
    assert.match(text, /\n⏺ j7 scout · sonnet\/low — look\n {2}⎿ {2}Interrupted\n\nerror: 529\n\n {2}48s · 2 calls · \$0\.07\n$/);
    assert.doesNotMatch(text, /opus · high/, 'the header is the screen\'s');
    // In colour where the terminal has it.
    assert.match(transcript(log, styles(true), { width: 80 }), /\x1b\[31m⏺\x1b\[39m \x1b\[1mBash/);
  });
});

describe('what the screen leaves out of a tool call, because it says nothing', () => {
  it('a command that begins by going to the project is shown without that, and whole when asked', () => {
    const go = { name: 'bash', input: { command: 'cd /work/shop && npm test' } };
    assert.equal(toolView(go, null, { cwd: '/work/shop' }).detail, 'npm test');
    assert.equal(toolView({ name: 'bash', input: { command: "cd '/work/shop/'; npm test" } }, null, { cwd: '/work/shop' }).detail, 'npm test');
    assert.equal(toolView(go, null, { cwd: '/work/shop', full: true }).detail, 'cd /work/shop && npm test', 'in full it is as it was run');
    assert.equal(toolView(go, null, { cwd: '/work' }).detail, 'cd /work/shop && npm test', 'going somewhere else is part of the command');
    assert.equal(toolView({ name: 'bash', input: { command: 'cd /work/shop/src && ls' } }, null, { cwd: '/work/shop' }).detail, 'cd /work/shop/src && ls');
    assert.equal(toolView({ name: 'bash', input: { command: 'cd /work/shop' } }, null, { cwd: '/work/shop' }).detail, 'cd /work/shop', 'a command that only goes there is still a command');
  });

  it('the empty lines of what came back are not shown folded, and are in full', () => {
    const bash = { name: 'bash', input: { command: 'npm test' } };
    const out = '\n> shop@1.0.0 test\n> node --test\n\n\nok 1\n\nok 2\n\n# pass 2\n# fail 0\n';
    // Six lines are all shown: folding one away would take the row it stood on.
    assert.deepEqual(toolView(bash, { content: out, isError: false }).lines.map((l) => l.text), ['> shop@1.0.0 test', '> node --test', 'ok 1', 'ok 2', '# pass 2', '# fail 0']);
    assert.deepEqual(toolView(bash, { content: `${out}ok 3\n`, isError: false }).lines.map((l) => l.text), ['> shop@1.0.0 test', '> node --test', '… +2 lines', '# pass 2', '# fail 0', 'ok 3'], 'two lines or more are folded');
    assert.equal(toolView(bash, { content: out, isError: false }, { full: true }).lines.length, out.split('\n').length);
    assert.deepEqual(toolView(bash, { content: ' \n\n', isError: false }).lines, [{ text: '(no output)', tone: 'dim' }]);
  });

  it('a job started in the background says so in a line, and its report is shown by its first words, not its heading', () => {
    const call = { name: 'delegate', input: { agent: 'scout', title: 'Find callers' } };
    const started = { content: 'j7 is running in the background (scout · sonnet/low — Find callers). Its report will reach you later, as an automated event…', isError: false };
    assert.deepEqual(toolView(call, started).lines, [{ text: 'running in the background — its report comes here when it is done', tone: 'dim' }]);
    assert.match(toolView(call, started, { full: true }).lines[0].text, /^j7 is running in the background \(scout/, 'in full, what the model was told');
    const job = { id: 7, status: 'done', seconds: 8, turns: 4, toolCalls: 3, costUsd: 0.02, model: 'sonnet', effort: 'low', report: '## Summary\n\nOnly `page` calls it.\n\n## Files\nsrc/paginate.js\nline 8\nline 2\n' };
    assert.deepEqual(toolView(call, { content: 'STATUS: DONE', job }).lines.map((l) => l.text), ['✓ j7 done · 8s · 4 turns · 3 tool calls · $0.02 · sonnet/low', 'Only page calls it.', 'Files: src/paginate.js', 'line 8', 'line 2'], 'a report one line past the top is shown whole, as it reads; a short line takes its heading in front');
    // Attempts reported together come as markdown without a job: shown as they read, headings kept as words.
    const together = toolView({ name: 'delegate', input: { job: 5, report: true, agent: 'worker', title: 'x' } }, { content: 'Attempts j5, j6:\n## Kept\nj5\n## Verified by code\n- `npm test` passed', isError: false });
    assert.deepEqual(together.lines.map((l) => l.text), ['Attempts j5, j6:', 'Kept: j5', 'Verified by code', '• npm test passed']);
    const verdict = { ...job, report: '## Verdict\nThe change does what was asked.\n## Problems\nNone.\n' };
    assert.deepEqual(toolView(call, { content: 'STATUS: DONE', job: verdict }).lines.map((l) => l.text).slice(1), ['The change does what was asked.', 'Problems: None.'], 'not a "None." on its own');
    // A job the user stopped is said to have been stopped, not left open.
    const open = { ...job, status: 'running' };
    assert.equal(toolView({ name: 'delegate', input: { job: 7, report: true, stopped: true } }, { content: '', job: open }).lines[0].text.slice(0, 22), '■ j7 stopped by you · ');
    assert.equal(toolView({ name: 'delegate', input: { job: 7, report: true } }, { content: '', job: open }).lines[0].text.slice(0, 20), '○ j7 never closed · ');
    // A table's rule is not shown, its rows are their cells, and a file in the project is named from there.
    const tabled = { ...job, report: '| fn | where |\n|---|---|\n| page | /work/src/page.js:3 |\n' };
    assert.deepEqual(toolView(call, { content: 'STATUS: DONE', job: tabled }, { cwd: '/work' }).lines.map((l) => l.text).slice(1), ['fn · where', 'page · src/page.js:3']);
    // A report that came in from the background is titled as one, by who sent it.
    assert.deepEqual([toolView({ name: 'delegate', input: { job: 7, report: true, agent: 'scout', title: 'Find callers' } }, { content: 'STATUS: DONE', job }).title, toolView({ name: 'delegate', input: { job: 7, report: true, agent: 'scout', title: 'Find callers' } }, { content: 'STATUS: DONE', job }).detail], ['Report', 'j7 scout · Find callers']);
    const longer = { ...job, report: `${job.report}line 1\n` };
    assert.deepEqual(toolView(call, { content: 'STATUS: DONE', job: longer }).lines.map((l) => l.text).slice(-2), ['line 8', '… +2 lines']);
  });
});

describe('code, links and tables, as a reader wants them', () => {
  const plain = (t) => t.replace(/\x1b\[[0-9;]*m/g, '');
  it('colours code in the language its block names: keywords, strings, numbers, comments — one over several lines too', () => {
    assert.equal(highlight('const s = "a // b"; // note', 'js', on), '\x1b[35mconst\x1b[39m s = \x1b[32m"a // b"\x1b[39m; \x1b[2m// note\x1b[22m', 'a comment mark inside a string is the string');
    assert.equal(highlight('x = 0x1F + 2.5', 'py', on), 'x = \x1b[33m0x1F\x1b[39m + \x1b[33m2.5\x1b[39m');
    assert.equal(highlight('echo $#  # count', 'sh', on), '\x1b[35mecho\x1b[39m $#  \x1b[2m# count\x1b[22m', 'a # inside a word is not a comment');
    const code = { comment: false };
    assert.equal(highlight('a /* open', 'go', on, code), 'a \x1b[2m/* open\x1b[22m');
    assert.equal(highlight('still */ return', 'go', on, code), '\x1b[2mstill */\x1b[22m \x1b[35mreturn\x1b[39m', 'the comment ran over to the next line');
    assert.equal(highlight('select * from t', 'sql', on), '\x1b[35mselect\x1b[39m * \x1b[35mfrom\x1b[39m t');
    assert.equal(highlight('+ added', 'diff', on), '\x1b[32m+ added\x1b[39m');
    assert.equal(highlight('- gone', 'diff', on), '\x1b[31m- gone\x1b[39m');
    assert.equal(highlight('if "quoted" 42', 'text', on), 'if "quoted" 42', 'output, a log, plain text: left as it came');
    assert.equal(highlight('if x', '', on), 'if x');
    const out = [];
    const r = createRenderer((t) => out.push(t), on);
    r.write('```ts\nlet a = 1;\n```\nlet a = 1;\n');
    assert.match(out.join(''), /\x1b\[35mlet\x1b\[39m a = \x1b\[33m1\x1b\[39m;\n\x1b\[2m {4}└─\x1b\[22m\nlet a = 1;\n$/, 'inside the block only');
  });

  it('makes an address a link the terminal opens, cut in two where it is wrapped and still one link each side; a pager gets none', () => {
    const withLinks = styles(true, { links: true });
    const url = 'https://example.com/a_long/path_with/underscores';
    const line = renderLine(`see ${url} now`, withLinks, { width: 30 });
    const opens = [...line.matchAll(/\x1b\]8;;([^\x07]*)\x07/g)].map((m) => m[1]);
    assert.ok(opens.filter(Boolean).every((u) => u === url) && opens.filter(Boolean).length >= 2, 'every piece opens the whole address');
    assert.equal(plain(line.replace(/\x1b\]8;;[^\x07]*\x07/g, '')), 'see\nhttps://example.com/a_long/pat\nh_with/underscores now', 'the words as they read, the underscores not taken for italics');
    assert.ok(line.split('\n').every((row) => row.replace(/\x1b\]8;;[^\x07]*\x07|\x1b\[[0-9;]*m/g, '').length <= 30), 'a link takes no room');
    assert.equal(renderLine(`see ${url}`, on, { width: 100 }), `see ${url}`, 'without links asked for, an address is the text alone');
    assert.equal(linked('at https://e.com/x.', withLinks), 'at \x1b]8;;https://e.com/x\x07https://e.com/x\x1b]8;;\x07.', 'in a line that is not markdown too, without the stop after it');
    assert.match(renderLine('[the docs](https://x.y/z)', withLinks), /^the docs \x1b\[2m\(\x1b\]8;;https:\/\/x\.y\/z\x07https:\/\/x\.y\/z\x1b\]8;;\x07\)\x1b\[22m$/);
  });

  it('gives a table\'s columns the room their words need, and turns rows of three columns or more into records when there is not enough', () => {
    const rows = ['| Key | What it does |', '|---|---|', '| Enter | send — while the model works, it reads the message with its next step |', '| Ctrl-O | the whole conversation in your pager, every command and all its output |'];
    const drawn = renderTable(rows, off, 60).split('\n');
    assert.match(drawn[1], /^│ Key {4}│ What it does {2,}│$/, 'the short column keeps to its longest word');
    assert.ok(drawn.every((l) => l.length <= 60));
    const wide = ['| File | Lines | What changed |', '|---|---|---|', '| test/app.test.js | 40 | a test for input with no trailing newline |'];
    assert.equal(renderTable(wide, off, 26), '• File: test/app.test.js\n  Lines: 40\n  What changed: a test for\n    input with no trailing\n    newline');
  });

  it('says the failures a request meets in words a person acts on, and keeps what came back faint', () => {
    assert.deepEqual(explained('529 {"type":"error","error":{"type":"overloaded_error"}}'), { text: "error: Anthropic's API is overloaded just now — nothing was lost; send it again in a minute", detail: '529 {"type":"error","error":{"type":"overloaded_error"}}' });
    assert.match(explained('429 rate_limit_error').text, /rate limited/);
    assert.match(explained('401 authentication_error: invalid x-api-key').text, /refused the credential/);
    assert.match(explained('prompt is too long: 210000 tokens > 200000 maximum').text, /no longer fits/);
    assert.match(explained('fetch failed').text, /no connection/);
    assert.deepEqual(explained('the tool broke'), { text: 'error: the tool broke' }, 'one it does not know is shown as it came');
  });

  it('shows what a command printed in colour without its escapes, and output that is a diff as one', () => {
    assert.equal(withoutColourCodes('⟨U+001B⟩[31mred⟨U+001B⟩[0m ⟨U+202E⟩'), 'red ⟨U+202E⟩', 'colour codes go; any other hidden character keeps its marker');
    const diff = toolView({ name: 'bash', input: { command: 'git diff' } }, { content: 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+new', isError: false }, { full: true }).lines;
    assert.deepEqual(diff.map((l) => l.tone), ['plain', 'plain', 'plain', 'plain', 'del', 'add']);
    assert.deepEqual(toolView({ name: 'bash', input: { command: 'cat x' } }, { content: '-a\n+b', isError: false }).lines.map((l) => l.tone), ['plain', 'plain'], 'lines that only start with a sign are not a diff');
  });

  it('shows a question put to the user as a Question, with the answer under it', () => {
    const view = toolView({ name: 'ask', input: { question: 'Which port?\nmore', options: [] } }, { content: 'The user chose: 8080', isError: false });
    assert.deepEqual(view, { title: 'Question', detail: 'Which port?', lines: [{ text: 'The user chose: 8080', tone: 'plain' }] });
  });

  it('writes the conversation as Markdown: what was said quoted, replies as written, calls and thinking folded under their names', () => {
    const md = markdownOf(
      [
        { kind: 'header', route: 'opus', cwd: '~', block: '' },
        { kind: 'user', text: 'fix it\nplease' },
        { kind: 'thought', ms: 4000, text: 'The loop stops short.' },
        { kind: 'reply', raw: 'On it — **now**.' },
        { kind: 'tool', call: { name: 'bash', input: { command: 'echo ```' } }, result: { content: '```\nok', isError: false } },
        { kind: 'error', text: 'error: the API failed', detail: '500' },
        { kind: 'footer', text: '4s · 1 call' },
      ],
      { title: 'Sumo — shop' },
    );
    assert.equal(
      md,
      '# Sumo — shop\n\n**You**\n\n> fix it\n> please\n\n<details><summary>Thought for 4s</summary>\n\n```\nThe loop stops short.\n```\n\n</details>\n\nOn it — **now**.\n\n<details><summary>Bash(echo ```)</summary>\n\n````\n```\nok\n````\n\n</details>\n\n**error: the API failed** — 500\n\n_4s · 1 call_\n',
      'a fence longer than any in what it holds',
    );
  });
});
