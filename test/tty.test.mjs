import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRenderer, header, prompt, renderBlock, renderLine, styles, wrap } from '../src/tty.mjs';

const on = styles(true);
const off = styles(false);

describe('the chat terminal rendering', () => {
  it('turns markdown marks into weight and indent, and leaves plain text alone when colour is off', () => {
    assert.equal(renderLine('# Title', on), '\x1b[1mTitle\x1b[22m');
    assert.equal(renderLine('- **Do this.** run `mem x`', off), '  • Do this. run mem x');
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
    const block = '<sumo-memory machine="m">\nPreferences (2 of 9 shown · more on: git(1) — mem search):\n- m15 Never add trailers\n- m5 Keep it cheap\nProjects: a (~/a)\nLeft off: a — here\nLeft off: b — there\nAsk the user: is this right?\nAsk the user: and this?\nWarning: the scribe failed\n</sumo-memory>';
    assert.equal(
      renderBlock(block, off),
      'Preferences (2 of 9 shown · more on: git(1) — mem search):\n  m15 Never add trailers\n  m5 Keep it cheap\n\nProjects: a (~/a)\n\nLeft off: a — here\nLeft off: b — there\n\nAsk the user: is this right?\nAsk the user: and this?\n\nWarning: the scribe failed',
    );
    assert.match(renderBlock(block, on), /^\x1b\[1mPreferences\x1b\[22m/);
    assert.match(renderBlock(block, on), /\x1b\[33mAsk the user: is this right\?\x1b\[39m/);
    assert.match(renderBlock(block, on), /\x1b\[31mWarning: the scribe failed\x1b\[39m/);
  });

  it('keeps the model and effort in the header and the prompt, and the context size once it matters', () => {
    assert.equal(header({ model: 'opus', effort: 'high', cwd: '/w' }, off), 'sumo  model opus  effort high  /w');
    assert.equal(prompt({ model: 'opus', effort: 'high', contextTokens: 0 }, off), 'sumo opus·high> ');
    assert.equal(prompt({ model: 'opus', effort: 'high', contextTokens: 12_400 }, off), 'sumo opus·high 12k> ');
  });
});
