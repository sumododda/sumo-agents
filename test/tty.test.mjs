import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRenderer, renderBlock, renderLine, styles } from '../src/tty.mjs';

const on = styles(true);
const off = styles(false);

describe('the chat terminal rendering', () => {
  it('turns markdown marks into weight and indent, and leaves plain text alone when colour is off', () => {
    assert.equal(renderLine('# Title', on), '\x1b[1mTitle\x1b[22m');
    assert.equal(renderLine('- **Do this.** run `mem x`', off), '  • Do this. run mem x');
    assert.equal(renderLine('2. second', off), '  2. second');
    assert.equal(renderLine('nothing special', off), 'nothing special');
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

  it('shows the memory block without its tags, with labels bold and questions yellow', () => {
    const block = '<sumo-memory machine="m">\nPreferences (2 of 9 shown · more on: git(1) — mem search):\n- m15 Never add trailers\nProjects: a (~/a)\nAsk the user: is this right?\n</sumo-memory>';
    assert.equal(renderBlock(block, off), 'Preferences (2 of 9 shown · more on: git(1) — mem search):\n  m15 Never add trailers\nProjects: a (~/a)\nAsk the user: is this right?');
    assert.match(renderBlock(block, on), /^\x1b\[1mPreferences\x1b\[22m/);
    assert.match(renderBlock(block, on), /\x1b\[33mAsk the user: is this right\?\x1b\[39m/);
  });
});
