/**
 * The input box of the chat, as plain state: the text, where the cursor is,
 * what was sent before, and which command the menu has picked. Every key is a
 * function from one state to the next, so the screen only has to draw it.
 */

/** An empty box. `history` is what Up recalls, oldest first; `at` is the entry shown, one past the end for the text being written. */
export const editor = (history = []) => ({ text: '', cursor: 0, history, at: history.length, draft: '', pick: 0 });

/** The commands a half-typed slash could mean; none once its arguments have started. */
export function menuFor(text, commands) {
  if (!/^\/\w*$/.test(text)) return [];
  return commands.filter((c) => c.name.startsWith(text.slice(1)));
}

/** The menu for the text being written; a recalled entry has none, so the arrows keep walking history. */
export const menuOf = (state, commands) => (state.at === state.history.length ? menuFor(state.text, commands) : []);

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** The character before the cursor, whole: an emoji is several code units and one keystroke. */
function before({ text, cursor }) {
  let last = '';
  for (const { segment } of GRAPHEMES.segment(text.slice(lineStart({ text, cursor }), cursor))) last = segment;
  return last || text.slice(cursor - 1, cursor);
}
/** The character the cursor is on; empty at the end of the text. */
export const under = ({ text, cursor }) => GRAPHEMES.segment(text.slice(cursor))[Symbol.iterator]().next().value?.segment ?? '';
const wordLeft = ({ text, cursor }) => cursor - /\S*\s*$/.exec(text.slice(0, cursor))[0].length;
const wordRight = ({ text, cursor }) => cursor + /^\s*\S*/.exec(text.slice(cursor))[0].length;

const edit = (state, text, cursor) => ({ ...state, text, cursor, pick: 0 });
const lineStart = ({ text, cursor }) => (cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1);
const lineEnd = ({ text, cursor }) => (text.indexOf('\n', cursor) === -1 ? text.length : text.indexOf('\n', cursor));
const insert = (state, chunk) => edit(state, state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor), state.cursor + chunk.length);
const cut = (state, from, to) => edit(state, state.text.slice(0, from) + state.text.slice(to), from);

/** Pasted text goes in whole, its line ends made plain; a newline in it is never Enter. */
export const paste = (state, text) => insert(state, text.replace(/\r\n?/g, '\n'));

const BURST_KEYS = { '\r': ['\r', { return: true }], '\t': ['', { tab: true }], '\x7f': ['', { backspace: true }] };
/** A control character is Ctrl and a letter: 3 is Ctrl-C. */
const burstKey = (ch) => BURST_KEYS[ch] ?? (ch < ' ' ? [String.fromCharCode(ch.charCodeAt(0) + 96), { ctrl: true }] : [ch, {}]);

/**
 * Keys typed faster than the screen reads them arrive as one string. This
 * gives them back one at a time, so an Enter in the middle is still Enter.
 * Pasted text does not come this way: the terminal marks it, and it goes to `paste`.
 */
export function keysOf(input, key) {
  if (input.length < 2 || key.ctrl || key.meta) return [[input, key]];
  return [...input].map(burstKey);
}

function recall(state, at) {
  const draft = state.at === state.history.length ? state.text : state.draft;
  const text = at === state.history.length ? draft : state.history[at];
  return { ...state, at, draft, text, cursor: text.length, pick: 0 };
}

/** Up or down: through the menu when it is open, between the lines of the text, and past its first or last line into history. */
function vertical(state, step, menu) {
  if (menu.length > 0) return { ...state, pick: (state.pick + step + menu.length) % menu.length };
  const start = lineStart(state);
  const column = state.cursor - start;
  if (step < 0) {
    if (start === 0) return state.at > 0 ? recall(state, state.at - 1) : state;
    const above = lineStart({ text: state.text, cursor: start - 1 });
    return { ...state, cursor: Math.min(above + column, start - 1) };
  }
  const end = lineEnd(state);
  if (end === state.text.length) return state.at < state.history.length ? recall(state, state.at + 1) : state;
  const below = lineEnd({ text: state.text, cursor: end + 1 });
  return { ...state, cursor: Math.min(end + 1 + column, below) };
}

function send(state) {
  const text = state.text.trim();
  if (!text) return { state: edit(state, '', 0) };
  const history = state.history.at(-1) === text ? state.history : [...state.history, text];
  return { state: editor(history), submit: text };
}

/**
 * One key. `input` and `key` are what Ink's useInput hands over; `commands`
 * is the slash menu's list. Returns the next state, and `submit` when the key
 * sent the text.
 */
export function press(state, input, key, commands = []) {
  const menu = menuOf(state, commands);
  const { text, cursor } = state;
  const word = key.meta || key.ctrl;

  if (key.return) {
    if (text[cursor - 1] === '\\') return { state: insert(cut(state, cursor - 1, cursor), '\n') };
    if (key.shift || key.meta) return { state: insert(state, '\n') };
    const chosen = menu[state.pick];
    if (chosen && text !== `/${chosen.name}`) return { state: edit(state, `/${chosen.name} `, chosen.name.length + 2) };
    return send(state);
  }
  if (key.tab) {
    const chosen = menu[state.pick];
    return { state: chosen ? edit(state, `/${chosen.name} `, chosen.name.length + 2) : state };
  }
  if (key.upArrow) return { state: vertical(state, -1, menu) };
  if (key.downArrow) return { state: vertical(state, 1, menu) };
  if (key.leftArrow) return { state: { ...state, cursor: word ? wordLeft(state) : cursor - before(state).length } };
  if (key.rightArrow) return { state: { ...state, cursor: word ? wordRight(state) : cursor + under(state).length } };
  if (key.home) return { state: { ...state, cursor: lineStart(state) } };
  if (key.end) return { state: { ...state, cursor: lineEnd(state) } };
  if (key.backspace) return { state: cut(state, key.meta ? wordLeft(state) : cursor - before(state).length, cursor) };
  if (key.delete) return { state: cut(state, cursor, cursor + under(state).length) };

  if (key.ctrl) {
    if (input === 'j') return { state: insert(state, '\n') };
    if (input === 'a') return { state: { ...state, cursor: lineStart(state) } };
    if (input === 'e') return { state: { ...state, cursor: lineEnd(state) } };
    if (input === 'u') return { state: cut(state, lineStart(state), cursor) };
    if (input === 'k') return { state: cut(state, cursor, lineEnd(state)) };
    if (input === 'w') return { state: cut(state, wordLeft(state), cursor) };
    if (input === 'd') return { state: cut(state, cursor, cursor + under(state).length) };
    return { state };
  }
  if (key.meta) {
    if (input === 'b') return { state: { ...state, cursor: wordLeft(state) } };
    if (input === 'f') return { state: { ...state, cursor: wordRight(state) } };
    return { state };
  }
  if (!input) return { state };
  return { state: insert(state, input) };
}
