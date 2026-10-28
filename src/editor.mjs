/**
 * The input box of the chat, as plain state: the text, where the cursor is,
 * what was sent before, and which command the menu has picked. Every key is a
 * function from one state to the next, so the screen only has to draw it.
 */

/**
 * An empty box. `history` is what Up recalls, oldest first; `at` is the entry shown, one past the end for the text being written.
 * `undo` is what the text was before each change, newest last; `kill` is the last thing cut, for Ctrl-Y; `search`, while Ctrl-R
 * looks back through history, what has been typed to find and where it was found.
 */
export const editor = (history = [], kill = '') => ({ text: '', cursor: 0, history, at: history.length, draft: '', pick: 0, undo: [], kill, search: null });

/** How many changes Ctrl-_ can take back. */
const UNDO_KEPT = 100;

/**
 * The menu for what is being typed: the commands a half-typed slash could mean, or, once a command's
 * arguments have started, what its `choices(given)` offers for the one being typed — nothing for a
 * command that offers none. Each entry says what to show (`label`), its hint, and the whole text
 * picking it leaves in the box (`complete`).
 */
/** How well a few typed letters name a command: from its start best, then anywhere in it, then in order with gaps between; -1 when they do not. */
function nameRank(name, typed) {
  if (name.startsWith(typed)) return 0;
  if (name.includes(typed)) return 1;
  let at = 0;
  for (const ch of typed) {
    at = name.indexOf(ch, at) + 1;
    if (at === 0) return -1;
  }
  return 2;
}

export function menuFor(text, commands) {
  if (/^\/\w*$/.test(text)) {
    // A command is found by any of its letters, in order: /rsm is /resume. The ones it starts with come first, in the menu's own order.
    const typed = text.slice(1);
    return commands
      .map((c, i) => [nameRank(c.name, typed), i, c])
      .filter(([rank]) => rank !== -1)
      .sort((a, b) => a[0] - b[0] || a[1] - b[1])
      .map(([, , c]) => ({ name: c.name, label: `/${c.name}`, hint: c.hint, complete: `/${c.name} ` }));
  }
  const m = /^\/(\w+)\s+([^\n]*)$/.exec(text);
  const command = m && commands.find((c) => c.name === m[1] && c.choices);
  if (!command) return [];
  const given = m[2].split(/\s+/).filter(Boolean);
  const typing = /\s$/.test(m[2]) || m[2] === '' ? '' : given.pop();
  const head = `/${command.name} ${given.map((w) => `${w} `).join('')}`;
  // A choice is a word, or a word with a hint beside it (`{ name, hint }`).
  return command
    .choices(given)
    .map((choice) => (typeof choice === 'string' ? { name: choice, hint: '' } : choice))
    .filter((choice) => choice.name.startsWith(typing))
    .map((choice) => ({ name: choice.name, label: choice.name, hint: choice.hint, complete: `${head}${choice.name} ` }));
}

/**
 * The `@word` the cursor stands at the end of — a file being named: where it starts, and what has been typed of it.
 * Null when there is none: the `@` must begin the text or follow a space, so an address or a decorator is not one.
 */
export function mentionAt({ text, cursor }) {
  const m = /(^|\s)@([\w./~-]*)$/.exec(text.slice(0, cursor));
  return m ? { from: m.index + m[1].length, query: m[2] } : null;
}

/** The files a few typed characters could mean, best first: a name that starts with them, a path that does, then either holding them; the shorter path first. */
export function matchFiles(list, query, max = 8) {
  const q = query.toLowerCase();
  const found = [];
  for (const path of list) {
    const p = path.toLowerCase();
    const name = p.slice(p.lastIndexOf('/') + 1);
    const rank = name.startsWith(q) ? 0 : p.startsWith(q) ? 1 : name.includes(q) ? 2 : p.includes(q) ? 3 : -1;
    if (rank !== -1) found.push([rank, path]);
  }
  return found.sort((a, b) => a[0] - b[0] || a[1].length - b[1].length || (a[1] < b[1] ? -1 : 1)).slice(0, max).map(([, path]) => path);
}

/**
 * The menu for the text being written: the slash menu, or — given `files(query, from)`, which answers with the paths a
 * mention could mean — the files for the `@word` at the cursor; picking one leaves its path where the mention was. A
 * recalled entry, as it was sent, has none, so the arrows keep walking history — changed, it is being written again, and
 * has; nor has a text whose menu Esc shut (`shut`), until it changes.
 */
export function menuOf(state, commands, files = null) {
  if ((state.at !== state.history.length && state.text === state.history[state.at]) || state.shut === state.text) return [];
  const menu = menuFor(state.text, commands);
  const at = menu.length === 0 && files ? mentionAt(state) : null;
  if (!at) return menu;
  return files(at.query, at.from).map((path) => ({ name: path, label: path, hint: '', file: true, complete: `${state.text.slice(0, at.from)}${path} ${state.text.slice(state.cursor)}`, cursor: at.from + path.length + 1 }));
}

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
/** The character before the cursor, whole: an emoji is several code units and one keystroke. */
function before({ text, cursor }) {
  let last = '';
  for (const { segment } of GRAPHEMES.segment(text.slice(lineStart({ text, cursor }), cursor))) last = segment;
  return last || text.slice(cursor - 1, cursor);
}
/** The character the cursor is on; empty at the end of the text. */
export const under = ({ text, cursor }) => GRAPHEMES.segment(text.slice(cursor))[Symbol.iterator]().next().value?.segment ?? '';
/** Where the word before the cursor starts, the spaces between them passed over. Walked back from the cursor: a pattern for it is tried from every place in the text, and a long paste is one long word. */
function wordLeft({ text, cursor }) {
  let at = cursor;
  while (at > 0 && /\s/.test(text[at - 1])) at--;
  while (at > 0 && /\S/.test(text[at - 1])) at--;
  return at;
}
const wordRight = ({ text, cursor }) => cursor + /^\s*\S*/.exec(text.slice(cursor))[0].length;

const edit = (state, text, cursor) => ({ ...state, text, cursor, pick: 0 });
const lineStart = ({ text, cursor }) => (cursor === 0 ? 0 : text.lastIndexOf('\n', cursor - 1) + 1);
const lineEnd = ({ text, cursor }) => (text.indexOf('\n', cursor) === -1 ? text.length : text.indexOf('\n', cursor));
const insert = (state, chunk) => edit(state, state.text.slice(0, state.cursor) + chunk + state.text.slice(state.cursor), state.cursor + chunk.length);
const cut = (state, from, to) => edit(state, state.text.slice(0, from) + state.text.slice(to), from);

/** Pasted text goes in whole, its line ends made plain; a newline in it is never Enter. */
export const paste = (state, text) => remember(state, insert(state, text.replace(/\r\n?/g, '\n')));

/**
 * Characters nobody sees that change what text says: direction overrides, zero-width spaces, the invisible tag letters that
 * can carry a hidden instruction. The joiner and the selectors an emoji is built from are not among them.
 */
const INVISIBLE = /[\u200b\u200c\u200e\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

/** Text from the clipboard as the box takes it: without the characters nobody sees, and how many were taken out. */
export function cleanPaste(text) {
  const removed = String(text).match(INVISIBLE)?.length ?? 0;
  return { text: removed ? String(text).replace(INVISIBLE, '') : String(text), removed };
}

/** A marker standing for something put in the box — an image, a long paste — ending at the cursor: deleted whole, never a character of it. */
const MARKER_BEFORE = /\[(?:Image #\d+|Pasted text #\d+[^\]\n]*)\] ?$/;

/** The state after a change, carrying what the text was before it so Ctrl-_ can take it back. A run of letters typed is one change. */
function remember(before, after, typing = false) {
  if (after.text === before.text) return after;
  const run = typing && before.typing;
  const undo = run ? before.undo : [...before.undo, { text: before.text, cursor: before.cursor }].slice(-UNDO_KEPT);
  return { ...after, undo, typing };
}

/** What was cut is kept for Ctrl-Y as well as gone from the box. */
const killed = (state, from, to) => ({ ...cut(state, from, to), kill: state.text.slice(from, to) || state.kill });

/** Ctrl-R: the newest line sent before `below` that holds `query`, put in the box with the cursor where it was found. */
function find(state, query, below, further = false) {
  const { search } = state;
  for (let i = Math.min(below, state.history.length) - 1; i >= 0; i--) {
    const at = query ? state.history[i].toLowerCase().indexOf(query.toLowerCase()) : -1;
    if (at !== -1) return { ...state, text: state.history[i], cursor: at, search: { ...search, query, at: i, failed: false, end: false } };
  }
  // Nothing further back keeps what was found; nothing at all says so.
  if (further && search.at !== null) return { ...state, search: { ...search, end: true } };
  return { ...state, search: { ...search, query, at: null, failed: query !== '', end: false } };
}

/** A key while Ctrl-R looks back: typing narrows it, Ctrl-R goes further back, Enter keeps what was found, Esc puts the draft back. */
function searching(state, input, key) {
  const { search } = state;
  if (key.escape || (key.ctrl && (input === 'g' || input === 'c'))) return { ...state, text: search.draft.text, cursor: search.draft.cursor, search: null };
  if (key.ctrl && input === 'r') return find(state, search.query, search.at ?? state.history.length, true);
  if (key.backspace) return find(state, search.query.slice(0, -1), state.history.length);
  if (input && !key.ctrl && !key.meta && !key.return && !key.tab) return find(state, search.query + input, state.history.length);
  // Anything else keeps what was found in the box, to send or to edit.
  return { ...state, at: state.history.length, search: null };
}

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
  let column = 0;
  for (const _ of GRAPHEMES.segment(state.text.slice(start, state.cursor))) column++;
  if (step < 0) {
    if (start === 0) return state.at > 0 ? recall(state, state.at - 1) : state;
    const above = lineStart({ text: state.text, cursor: start - 1 });
    return { ...state, cursor: cursorOnLine(state.text, above, start - 1, column) };
  }
  const end = lineEnd(state);
  if (end === state.text.length) return state.at < state.history.length ? recall(state, state.at + 1) : state;
  const below = lineEnd({ text: state.text, cursor: end + 1 });
  return { ...state, cursor: cursorOnLine(state.text, end + 1, below, column) };
}

function cursorOnLine(text, start, end, column) {
  let cursor = start;
  for (const { segment } of GRAPHEMES.segment(text.slice(start, end))) {
    if (column-- === 0) break;
    cursor += segment.length;
  }
  return cursor;
}

function send(state) {
  const text = state.text.trim();
  if (!text) return { state: edit(state, '', 0) };
  const history = state.history.at(-1) === text ? state.history : [...state.history, text];
  return { state: editor(history, state.kill), submit: text };
}

/**
 * One key. `input` and `key` are what Ink's useInput hands over; `commands`
 * is the slash menu's list. Returns the next state, and `submit` when the key
 * sent the text.
 */
export function press(state, input, key, commands = [], files = null) {
  if (state.search) return { state: searching(state, input, key) };
  if (key.ctrl && input === 'r') return { state: find({ ...state, search: { query: '', at: null, failed: false, draft: { text: state.text, cursor: state.cursor } } }, '', state.history.length) };
  // Ctrl-_ (Ctrl-/ on most keyboards): the text as it was before the last change.
  if (input === '\x1f') {
    const last = state.undo.at(-1);
    return { state: last ? { ...state, text: last.text, cursor: last.cursor, undo: state.undo.slice(0, -1), typing: false, pick: 0 } : state };
  }
  const pressed = keyed(state, input, key, commands, files);
  const typing = !key.ctrl && !key.meta && input.length === 1 && /\S/.test(input) && !key.return && !key.tab;
  // Sent, the box starts afresh: there is nothing to take back into it. A key that changed nothing hands back the same state:
  // the screen reads that as Down having left the box.
  if (pressed.submit !== undefined || pressed.state === state) return pressed;
  return { ...pressed, state: { ...remember(state, pressed.state, typing), typing } };
}

function keyed(state, input, key, commands, files) {
  const menu = menuOf(state, commands, files);
  const { text, cursor } = state;
  const word = key.meta || key.ctrl;

  if (key.return) {
    if (text[cursor - 1] === '\\') return { state: insert(cut(state, cursor - 1, cursor), '\n') };
    if (key.shift || key.meta) return { state: insert(state, '\n') };
    const chosen = menu[state.pick];
    if (chosen && text !== chosen.complete.trimEnd()) return { state: edit(state, chosen.complete, chosen.cursor ?? chosen.complete.length) };
    return send(state);
  }
  if (key.tab) {
    const chosen = menu[state.pick];
    return { state: chosen ? edit(state, chosen.complete, chosen.cursor ?? chosen.complete.length) : state };
  }
  if (key.upArrow) return { state: vertical(state, -1, menu) };
  if (key.downArrow) return { state: vertical(state, 1, menu) };
  if (key.leftArrow) return { state: { ...state, cursor: word ? wordLeft(state) : cursor - before(state).length } };
  if (key.rightArrow) return { state: { ...state, cursor: word ? wordRight(state) : cursor + under(state).length } };
  if (key.home) return { state: { ...state, cursor: lineStart(state) } };
  if (key.end) return { state: { ...state, cursor: lineEnd(state) } };
  if (key.backspace && key.meta) return { state: killed(state, wordLeft(state), cursor) };
  if (key.backspace) {
    const marker = MARKER_BEFORE.exec(text.slice(0, cursor));
    return { state: cut(state, marker ? cursor - marker[0].length : cursor - before(state).length, cursor) };
  }
  if (key.delete) return { state: cut(state, cursor, cursor + under(state).length) };

  if (key.ctrl) {
    if (input === 'j') return { state: insert(state, '\n') };
    if (input === 'a') return { state: { ...state, cursor: lineStart(state) } };
    if (input === 'e') return { state: { ...state, cursor: lineEnd(state) } };
    if (input === 'u') {
      // At the start of a line nothing of it is before the cursor: the line above goes instead, so pressing it again clears a box of many lines.
      const start = lineStart(state);
      return { state: killed(state, start === cursor && cursor > 0 ? lineStart({ text: state.text, cursor: cursor - 1 }) : start, cursor) };
    }
    if (input === 'k') return { state: killed(state, cursor, lineEnd(state)) };
    if (input === 'w') return { state: killed(state, wordLeft(state), cursor) };
    if (input === 'd') return { state: cut(state, cursor, cursor + under(state).length) };
    // What Ctrl-U, Ctrl-K, Ctrl-W or Option-Backspace cut, put back where the cursor is.
    if (input === 'y') return { state: state.kill ? insert(state, state.kill) : state };
    if (input === 'b') return { state: { ...state, cursor: cursor - before(state).length } };
    if (input === 'f') return { state: { ...state, cursor: cursor + under(state).length } };
    return { state };
  }
  if (key.meta) {
    if (input === 'b') return { state: { ...state, cursor: wordLeft(state) } };
    if (input === 'f') return { state: { ...state, cursor: wordRight(state) } };
    if (input === 'd') return { state: killed(state, cursor, wordRight(state)) };
    return { state };
  }
  if (!input) return { state };
  return { state: insert(state, input) };
}
