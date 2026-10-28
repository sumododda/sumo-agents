import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';
import { isAdvisorTool } from './advisor.mjs';
import { compactInput, isMcpTool, splitMcpName, unlabeled } from './mcp.mjs';
import { REPO_ROOT } from './paths.mjs';
import { elapsed } from './text.mjs';
import { ASK_TOOL, BASH_TOOL, DELEGATE_TOOL, EDITOR_TOOL } from './tools.mjs';
import { isWebTool, WEB_SEARCH_TOOL } from './web.mjs';

/**
 * What the chat terminal looks like: the reply's markdown turned into bold,
 * dim and colour as it streams, wrapped to a readable width; the memory block
 * in spaced sections with its labels standing out; tool lines and errors told
 * apart from the model's own words. Colour is off when stdout is not a
 * terminal or NO_COLOR is set, so a pipe gets plain text — unless FORCE_COLOR asks for it.
 */

const CODES = { bold: ['1', '22'], dim: ['2', '22'], italic: ['3', '23'], underline: ['4', '24'], inverse: ['7', '27'], strike: ['9', '29'], cyan: ['36', '39'], yellow: ['33', '39'], red: ['31', '39'], green: ['32', '39'], magenta: ['35', '39'], blue: ['34', '39'] };

/**
 * The marks the screen draws with. Plain, for a screen reader or a terminal that draws only ASCII, each is a character a
 * reader says as itself: no box drawing, no symbol spelled out by its Unicode name.
 */
const GLYPHS = {
  tool: '⏺', fail: '✗', pick: '❯', under: '⎿', bar: '┃', quote: '│', rule: '─', fenceOpen: '┌─', fenceClose: '└─', todo: '☐', done: '☑', bullet: '•', warn: '⚠', thought: '✻',
  box: { h: '─', v: '│', tl: '┌', tm: '┬', tr: '┐', ml: '├', mm: '┼', mr: '┤', bl: '└', bm: '┴', br: '┘' },
};
const PLAIN_GLYPHS = {
  tool: '*', fail: 'x', pick: '>', under: '|', bar: '>', quote: '|', rule: '-', fenceOpen: '+-', fenceClose: '+-', todo: '[ ]', done: '[x]', bullet: '-', warn: '!', thought: '*',
  box: { h: '-', v: '|', tl: '+', tm: '+', tr: '+', ml: '+', mm: '+', mr: '+', bl: '+', bm: '+', br: '+' },
};
const MAX_WIDTH = 100;
const MIN_WIDTH = 40;

/** A link's ends (OSC 8): the terminal makes the text between them open the address, however the lines it is drawn on are broken. */
const LINK_OPEN = (url) => `\x1b]8;;${url}\x07`;
const LINK_CLOSE = '\x1b]8;;\x07';

/**
 * The style functions, each a no-op when colour is off. `links` makes `link` an address the terminal opens on a click; a
 * terminal that does not know them draws the text alone, but a pager does not, so the screen asks for them and nothing else.
 * `plain` draws with ASCII marks (`g`): see GLYPHS.
 */
export function styles(enabled, { links = false, plain = false } = {}) {
  const s = {};
  for (const [name, [on, off]] of Object.entries(CODES)) s[name] = enabled ? (t) => `\x1b[${on}m${t}\x1b[${off}m` : (t) => t;
  s.link = enabled && links ? (url, text = url) => `${LINK_OPEN(url)}${text}${LINK_CLOSE}` : (_url, text = _url) => text;
  s.plain = plain;
  s.g = plain ? PLAIN_GLYPHS : GLYPHS;
  return s;
}

/** The marks for a screen, plain or not. */
export const glyphs = (plain = false) => (plain ? PLAIN_GLYPHS : GLYPHS);

/**
 * Colour on a terminal unless NO_COLOR holds something (an empty one is not set: no-color.org) or the terminal is dumb.
 * A FORCE_COLOR the user set wins, as it does for chalk on the chat screen: 0 or false is none, anything else is colour,
 * piped too — a CI log can ask for it. Empty is not set, as for NO_COLOR.
 */
export const colourEnabled = (stream = process.stdout, env = process.env) =>
  env.FORCE_COLOR ? env.FORCE_COLOR !== '0' && env.FORCE_COLOR !== 'false' : Boolean(stream.isTTY) && !env.NO_COLOR && env.TERM !== 'dumb';

/** Lines no wider than this read comfortably whatever the window is. */
export const widthOf = (stream = process.stdout, env = process.env) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stream.columns || Number(env.COLUMNS) || 80) - 1));

/** East Asian wide and fullwidth characters, and emoji drawn as pictures: two columns each on a terminal. */
const WIDE = /[\u1100-\u115F\u2E80-\u303E\u3041-\u33FF\u3400-\u4DBF\u4E00-\u9FFF\uA000-\uA4CF\uAC00-\uD7A3\uF900-\uFAFF\uFE30-\uFE4F\uFF00-\uFF60\uFFE0-\uFFE6\u{20000}-\u{3FFFD}]|\p{Emoji_Presentation}|\uFE0F/u;
/** The columns one character takes, an emoji joined from several included. */
const columnsOf = (ch) => (WIDE.test(ch) ? 2 : 1);

/** The columns text takes on a terminal, colour codes not counted: a wide character is two, so a table around it lines up. */
const visible = (t) => {
  const plain = t.replace(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07/g, '');
  if (!/[^\x00-\x7e]/.test(plain)) return plain.length;
  let width = 0;
  for (const { segment } of GRAPHEMES.segment(plain)) width += columnsOf(segment);
  return width;
};

/**
 * Word-wraps styled text to `width`, measuring only what is visible; continuation lines carry `indent`. A word wider than
 * a line — an address, a path — is cut at the edge and goes on under the indent: no line is left for the terminal to break.
 */
export function wrap(text, width, indent = '') {
  if (visible(text) <= width) return text;
  const lead = /^\s*/.exec(text)[0];
  // An indent that leaves no room is dropped: a word goes on at the edge rather than not at all.
  const hang = visible(indent) < width - 1 ? indent : '';
  const lines = [];
  let line = lead;
  for (const word of text.slice(lead.length).split(' ')) {
    const next = line === lead ? `${lead}${word}` : `${line} ${word}`;
    if (line !== lead && visible(next) > width) {
      lines.push(line);
      line = `${hang}${word}`;
    } else line = next;
    while (visible(line) > width) {
      const [head, ...rest] = cut(line, width);
      lines.push(head);
      line = `${hang}${rest.join('')}`;
    }
  }
  lines.push(line);
  return lines.join('\n');
}

/** An address in text: up to the space after it, without the stop or bracket a sentence puts after it. */
const ADDRESS = /\bhttps?:\/\/[^\s<>()[\]`]*[^\s<>()[\]`.,;:!?'"]/g;

/** Text with each address in it made a link, for lines that are not markdown: what a tool gave back, a note. */
export const linked = (text, s) => String(text).replace(ADDRESS, (url) => s.link(url));

/** A character after a backslash is meant as itself, not as a mark. */
const ESCAPED = /\\([\\`*_~[\]()<>#|!])/g;
/** A piece already drawn stands in the line behind these until the end, so no later mark reads into it or into its colour codes. */
const KEPT = /\uE000(\d+)\uE001/g;

/**
 * Inline markdown on one line: code, links shown as their text and address, bold, italic, struck through, and
 * a backslash-escaped mark as itself. A mark only counts where markdown would read it: snake_case and 2*3*4 stay.
 */
export function inline(line, s) {
  const kept = [];
  const keep = (text) => `\uE000${kept.push(text) - 1}\uE001`;
  const out = line
    .replace(/(?<!\\)`([^`]+)`/g, (_, code) => keep(s.cyan(code)))
    .replace(ESCAPED, (_, ch) => keep(ch))
    .replace(/<(https?:\/\/[^>\s]+)>/g, (_, url) => keep(s.link(url)))
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, url) => (text === url ? keep(s.link(url)) : `${text} ${keep(s.dim(`(${s.link(url)})`))}`))
    // An address in the words is one link, kept from the marks: its underscores are not italics.
    .replace(ADDRESS, (url) => keep(s.link(url)))
    .replace(/\*\*\*(?!\s)([^*]+?)(?<!\s)\*\*\*/g, (_, t) => s.bold(s.italic(t)))
    .replace(/\*\*(?!\s)([^*]+?)(?<!\s)\*\*/g, (_, t) => s.bold(t))
    .replace(/(?<![\w_])__(?!\s)([^_]+?)(?<!\s)__(?![\w_])/g, (_, t) => s.bold(t))
    .replace(/(?<![\w*])\*(?![\s*])([^*]+?)(?<!\s)\*(?![\w*])/g, (_, t) => s.italic(t))
    .replace(/(?<![\w_])_(?![\s_])([^_]+?)(?<!\s)_(?![\w_])/g, (_, t) => s.italic(t))
    .replace(/~~(?!\s)([^~]+?)(?<!\s)~~/g, (_, t) => s.strike(t));
  // A reply that happens to hold the stand-in characters itself keeps them as they were.
  const restore = (text) => text.replace(KEPT, (whole, i) => (kept[Number(i)] === undefined ? whole : restore(kept[Number(i)])));
  return restore(out);
}

/** A list item's marker: a bullet, or a number with its stop. */
const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * The indent a line that goes on with a list item is drawn at: under the item's text, not its marker. Null for a
 * line that is no list item.
 */
function hangOf(line) {
  const item = LIST_ITEM.exec(line);
  if (!item) return null;
  return `${item[1]}${' '.repeat(/\d/.test(item[2]) ? item[2].length + 3 : 4)}`;
}

const words = (list) => new Set(list.split(' '));
const C_LIKE = 'break case continue default do else for goto if return switch while true false null';
/**
 * The languages a code block is coloured in: how a comment starts, which quotes make a string, and the words the language
 * keeps for itself. Anything else — output, a log, plain text — is left as it came: colour guessed onto it would mislead.
 */
const LANGUAGES = (() => {
  const js = { line: '//', block: true, quotes: '"\'`', words: words(`${C_LIKE} as async await catch class const debugger delete export extends finally from function import in instanceof let new of static super this throw try typeof undefined var void with yield interface type enum implements private public protected readonly declare namespace abstract keyof satisfies`) };
  const py = { line: '#', quotes: '"\'', words: words('and as assert async await break class continue def del elif else except False finally for from global if import in is lambda None nonlocal not or pass raise return self True try while with yield match case') };
  const sh = { line: '#', quotes: '"\'', words: words('if then else elif fi for while until do done case esac in function return local export readonly set unset echo exit source alias cd') };
  const go = { line: '//', block: true, quotes: '"\'`', words: words(`${C_LIKE} chan const defer fallthrough func go import interface map package range select struct type var nil iota`) };
  const rust = { line: '//', block: true, quotes: '"', words: words(`${C_LIKE} as async await const crate dyn enum extern fn impl in let loop match mod move mut pub ref self Self static struct super trait type unsafe use where Some None Ok Err`) };
  const c = { line: '//', block: true, quotes: '"\'', words: words(`${C_LIKE} auto char class const double enum extern float int long namespace new private protected public register short signed sizeof static struct template this throw try catch typedef union unsigned using virtual void volatile bool include define nullptr import package final abstract extends implements interface var val fun let func guard struct override`) };
  const ruby = { line: '#', quotes: '"\'', words: words('alias and begin break case class def defined do else elsif end ensure false for if in module next nil not or redo rescue retry return self super then true undef unless until when while yield require') };
  const sql = { line: '--', block: true, quotes: '\'"', words: words('select from where and or not insert into values update set delete create table index drop alter join left right inner outer on as group by order having limit offset distinct union all null is in like between case when then else end primary key references default exists'), caseless: true };
  const conf = { line: '#', quotes: '"\'', words: words('true false null yes no on off') };
  const named = { js, javascript: js, jsx: js, mjs: js, cjs: js, ts: js, typescript: js, tsx: js, json: { quotes: '"', words: words('true false null') }, py: py, python: py, sh, bash: sh, zsh: sh, shell: sh, go, golang: go, rs: rust, rust, c, h: c, cpp: c, 'c++': c, cc: c, java: c, kotlin: c, kt: c, swift: c, cs: c, csharp: c, rb: ruby, ruby, sql, yaml: conf, yml: conf, toml: conf, ini: conf };
  return named;
})();

/**
 * A line of code in its language's colours: comments faint, strings green, numbers yellow, the language's own words
 * magenta. `code` carries a block comment over from the line before; a diff is its changes, green and red.
 */
export function highlight(line, lang, s, code = null) {
  if (lang === 'diff' || lang === 'patch') return /^\+(?!\+\+ )/.test(line) ? s.green(line) : /^-(?!-- )/.test(line) ? s.red(line) : /^@@/.test(line) ? s.cyan(line) : line;
  const language = LANGUAGES[lang];
  if (!language || !line) return line;
  const state = code ?? { comment: false };
  let out = '';
  let at = 0;
  if (state.comment) {
    const end = line.indexOf('*/');
    if (end === -1) return s.dim(line);
    out = s.dim(line.slice(0, end + 2));
    at = end + 2;
    state.comment = false;
  }
  const quotes = [...language.quotes].map((q) => `${q === '`' ? '`' : `\\${q}`}(?:[^${q === '`' ? '`' : `\\${q}`}\\\\]|\\\\.)*${q === '`' ? '`' : `\\${q}`}`).join('|');
  const comment = language.line === '#' ? '(?:^|(?<=\\s))#.*' : language.line ? `${language.line.replace(/\//g, '\\/')}.*` : '(?!)';
  const pattern = new RegExp(`(${comment})|(${language.block ? '\\/\\*' : '(?!)'})|(${quotes || '(?!)'})|(\\b0x[0-9a-fA-F]+\\b|\\b\\d[\\d_]*(?:\\.\\d+)?(?:[eE][+-]?\\d+)?\\b)|(\\b[A-Za-z_][\\w]*\\b)`, 'g');
  pattern.lastIndex = at;
  for (let m; (m = pattern.exec(line)); ) {
    out += line.slice(at, m.index);
    at = m.index + m[0].length;
    if (m[1] !== undefined) out += s.dim(m[0]);
    else if (m[2] !== undefined) {
      const end = line.indexOf('*/', at);
      if (end === -1) {
        out += s.dim(line.slice(m.index));
        state.comment = true;
        return out;
      }
      out += s.dim(line.slice(m.index, end + 2));
      at = end + 2;
      pattern.lastIndex = at;
    } else if (m[3] !== undefined) out += s.green(m[0]);
    else if (m[4] !== undefined) out += s.yellow(m[0]);
    else out += language.words.has(language.caseless ? m[0].toLowerCase() : m[0]) ? s.magenta(m[0]) : m[0];
  }
  return out + line.slice(at);
}

/**
 * One line of a reply: block-level marks replaced by weight and indent, then wrapped with a hanging indent.
 * `hang` is the indent of the list item a line may go on with: an indented line that is not an item of its own is drawn there.
 */
export function renderLine(line, s, { fence = false, width = MAX_WIDTH, hang = null, lang = '', code = null } = {}) {
  // Code is what is read most closely: the frame around it is faint, the code is not.
  // A line too long for the window goes on under itself, at its own indent, so the code keeps its shape.
  if (fence) return wrap(`    ${highlight(line, lang, s, code)}`, width, `    ${/^\s*/.exec(line)[0]}`);
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return wrap(heading[1].length === 1 ? s.bold(s.underline(inline(heading[2], s))) : s.bold(inline(heading[2], s)), width);
  const item = LIST_ITEM.exec(line);
  if (item && !/\d/.test(item[2])) {
    const task = /^\[([ xX])\]\s+(.*)$/.exec(item[3]);
    const mark = task ? (task[1] === ' ' ? s.dim(s.g.todo) : s.green(s.g.done)) : s.dim(s.g.bullet);
    return wrap(`${item[1]}  ${mark} ${inline(task ? task[2] : item[3], s)}`, width, `${item[1]}    `);
  }
  if (item) return wrap(`${item[1]}  ${s.dim(`${item[2].slice(0, -1)}.`)} ${inline(item[3], s)}`, width, hangOf(line));
  if (/^\s*>\s?/.test(line)) return wrap(`  ${s.dim(s.g.quote)} ${s.italic(inline(line.replace(/^\s*>\s?/, ''), s))}`, width, `  ${s.dim(s.g.quote)} `);
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return s.dim(s.g.rule.repeat(Math.min(40, width)));
  if (hang !== null && /^\s+\S/.test(line)) return wrap(`${hang}${inline(line.trim(), s)}`, width, hang);
  return wrap(inline(line, s), width);
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const MIN_COLUMN = 3;
const NO_STYLE = styles(false);

const cellsOf = (row) => row.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** What each closing code ends: the opening codes it closes. */
const CLOSES = { 0: /.*/, 22: /^(1|2)$/, 23: /^3$/, 24: /^4$/, 27: /^7$/, 29: /^9$/, 39: /^(3[0-7]|9[0-7]|38;.*)$/, 49: /^(4[0-7]|10[0-7]|48;.*)$/ };
/** The styles open after `code`, given the ones open before it. */
function styledAfter(on, code) {
  const n = code.slice(2, -1) || '0';
  const closes = CLOSES[n];
  return closes ? on.filter((open) => !closes.test(open.slice(2, -1))) : [...on, code];
}

/**
 * A line cut into pieces no wider than `width`, between characters: an emoji, even one joined from several, stays whole,
 * and a colour code takes no room — it stays with the character after it.
 */
function cut(line, width) {
  const pieces = [''];
  let used = 0;
  // A link cut in two is closed at the end of one piece and opened again at the start of the next: both halves open it.
  // So is a style: the next piece starts in the colour the last one ended in, since each row is drawn on its own.
  let link = null;
  let on = [];
  for (const [token] of line.matchAll(/\x1b\[[0-9;]*m|\x1b\]8;[^\x07]*\x07|[^\x1b]+|\x1b/g)) {
    if (token.length > 1 && token[0] === '\x1b') {
      if (token[1] === ']') link = token === LINK_CLOSE ? null : token;
      else on = styledAfter(on, token);
      pieces[pieces.length - 1] += token;
      continue;
    }
    for (const { segment: ch } of GRAPHEMES.segment(token)) {
      if (used > 0 && used + columnsOf(ch) > width) {
        if (link) pieces[pieces.length - 1] += LINK_CLOSE;
        pieces.push(`${on.join('')}${link ?? ''}`);
        used = 0;
      }
      pieces[pieces.length - 1] += ch;
      used += columnsOf(ch);
    }
  }
  return pieces;
}

/** A text folded to `width`, as its rows, the ones after the first at `indent`; a word wider than that is cut, so nothing drawn from them runs past the edge. */
export function fold(text, width, indent = '') {
  return wrap(text, width, indent)
    .split('\n')
    .flatMap((line) => (visible(line) <= width ? [line] : cut(line, width)));
}

function pad(text, width, align) {
  const space = Math.max(0, width - visible(text));
  if (align === 'right') return ' '.repeat(space) + text;
  if (align === 'center') return ' '.repeat(Math.floor(space / 2)) + text + ' '.repeat(Math.ceil(space / 2));
  return text + ' '.repeat(space);
}

/**
 * A markdown table as a box with its columns lined up. When the window is too
 * narrow for it, the widest columns give way and their cells fold; a folded
 * cell is plain text, so no style runs across a border.
 */
export function renderTable(rows, s, width) {
  const [head, rule, ...body] = rows.map(cellsOf);
  const columns = head.length;
  const aligns = Array.from({ length: columns }, (_, i) => (/^:-+:$/.test(rule[i] ?? '') ? 'center' : /-:$/.test(rule[i] ?? '') ? 'right' : 'left'));
  const table = [head, ...body].map((row) => Array.from({ length: columns }, (_, i) => row[i] ?? ''));
  // Each row as a record — the column's name, then the cell — one under the other.
  const records = () => body.map((row) => head.map((name, i) => wrap(`${i === 0 ? s.dim(s.g.bullet) : ' '} ${s.bold(inline(name, s))}: ${inline(row[i] ?? '', s)}`, width, '    ')).join('\n')).join('\n\n');
  // Plain mode is drawn for a screen reader, which would spell a frame out character by character: always records.
  if (s.plain && body.length > 0) return records();
  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...table.map((row) => visible(inline(row[i], s)))));
  const room = width - (3 * columns + 1);
  const sum = (list) => list.reduce((a, b) => a + b, 0);
  if (sum(widths) > room) {
    // Too wide: each column keeps its longest word whole if it can, and the room left over goes to the columns with the most
    // to say, by how much more they have — so a column of short keys is not padded out to match a column of sentences.
    const least = widths.map((most, i) => Math.min(most, Math.max(MIN_COLUMN, ...table.map((row) => Math.max(0, ...inline(row[i], NO_STYLE).split(/\s+/).map(visible))))));
    const spare = room - sum(least);
    // Three columns or more that cannot keep their words whole would fold into a ladder of word ends: each row is shown as
    // a record instead — the column's name, then the cell — one under the other.
    if (spare < 0 && columns >= 3 && body.length > 0) return records();
    if (spare >= 0) {
      const wants = widths.map((most, i) => most - least[i]);
      const given = least.map((w, i) => w + Math.floor((spare * wants[i]) / Math.max(1, sum(wants))));
      // What rounding left goes to the columns that want the most, one each.
      for (let left = room - sum(given), i = 0; left > 0 && i < columns; i++, left--) given[wants.indexOf(Math.max(...wants.filter((_, k) => given[k] < widths[k])))]++;
      widths.splice(0, columns, ...given.map((w, i) => Math.min(w, widths[i])));
    } else widths.splice(0, columns, ...least);
    while (sum(widths) > room && Math.max(...widths) > MIN_COLUMN) widths[widths.indexOf(Math.max(...widths))]--;
  }

  const box = s.g.box;
  const edge = (left, mid, right) => s.dim(`${left}${widths.map((w) => box.h.repeat(w + 2)).join(mid)}${right}`);
  const bar = s.dim(box.v);
  const draw = (row, style) => {
    const cells = row.map((cell, i) => (visible(inline(cell, s)) <= widths[i] ? [inline(cell, s)] : fold(inline(cell, NO_STYLE), widths[i])));
    const height = Math.max(...cells.map((c) => c.length));
    return Array.from({ length: height }, (_, n) => `${bar} ${cells.map((c, i) => style(pad(c[n] ?? '', widths[i], aligns[i]))).join(` ${bar} `)} ${bar}`);
  };
  return [edge(box.tl, box.tm, box.tr), ...draw(table[0], s.bold), edge(box.ml, box.mm, box.mr), ...table.slice(1).flatMap((row) => draw(row, (t) => t)), edge(box.bl, box.bm, box.br)].join('\n');
}

/**
 * A line-buffered renderer for streamed text: each complete line is written
 * rendered as soon as it arrives; the tail is kept until it ends or `flush`.
 * The rows of a table are kept too, until the line after it shows it is whole.
 */
/**
 * A tab as the spaces it takes. A screen that lays text out counts a tab as one column and the terminal draws up to
 * eight, so a box's border or a wrapped line would land wherever the tab pushed it.
 */
export const untab = (text) => text.replaceAll('\t', '    ');

/**
 * The line still arriving, a mark it has opened and not yet closed made whole for now — a code span shut, a link whose
 * address is still coming shown by its words, bold ended — so the live line never shows a mark the finished one will not.
 * A mark with nothing after it yet is held back. Only the live line is drawn from this; the finished one, from what came.
 */
function closedForNow(line) {
  const ticks = [...line.matchAll(/(?<!\\)`/g)];
  if (ticks.length % 2 === 1) {
    const at = ticks.at(-1).index;
    return line.slice(at + 1).trim() ? `${line}\`` : line.slice(0, at);
  }
  const shown = line.replace(/\[([^\]\n]+)\]\([^)\s]*$/, '$1');
  // Bold counted outside the code spans, where a `**` is only itself.
  const bold = [...shown.replace(/`[^`]*`/g, (span) => ' '.repeat(span.length)).matchAll(/\*\*/g)];
  if (bold.length % 2 === 0) return shown;
  const at = bold.at(-1).index;
  const words = shown.trimEnd();
  return shown.slice(at + 2).trim() ? `${words}**${shown.slice(words.length)}` : shown.slice(0, at);
}

export function createRenderer(write, s, { width = MAX_WIDTH } = {}) {
  let tail = '';
  let fence = false;
  let rows = [];
  /** The indent of the list item the lines are in, until a line comes out of it. */
  let hang = null;
  /** The language the code block in hand is in, and where its colouring has got to: a comment can run over lines. */
  let lang = '';
  let code = { comment: false };
  const line = (raw) => {
    const marks = /^\s*```\s*(\S*)/.exec(raw);
    if (marks) {
      fence = !fence;
      hang = null;
      lang = fence ? marks[1].toLowerCase() : '';
      code = { comment: false };
      // Plain mode names the block in words, for a reader: no frame corner to spell out.
      if (s.plain) return s.dim(fence ? `    code${marks[1] ? ` (${marks[1]})` : ''}:` : '    end of code');
      return s.dim(fence ? `    ${s.g.fenceOpen}${marks[1] ? ` ${marks[1]}` : ''}` : `    ${s.g.fenceClose}`);
    }
    if (!fence) hang = hangOf(raw) ?? (/^\s+\S/.test(raw) || raw.trim() === '' ? hang : null);
    return renderLine(raw, s, { fence, width, hang: hangOf(raw) === null ? hang : null, lang, code });
  };
  /** The rows held so far: a table once its rule has come, the lines they were otherwise. */
  const held = () => (rows.length >= 2 && TABLE_RULE.test(rows[1]) ? renderTable(rows, s, width) : rows.map((r) => renderLine(r, s, { width })).join('\n'));
  return {
    write(chunk) {
      tail += untab(chunk);
      let at;
      while ((at = tail.indexOf('\n')) !== -1) {
        const raw = tail.slice(0, at);
        tail = tail.slice(at + 1);
        if (!fence && TABLE_ROW.test(raw)) {
          rows.push(raw);
          continue;
        }
        if (rows.length > 0) write(`${held()}\n`);
        rows = [];
        write(`${line(raw)}\n`);
      }
    },
    flush() {
      if (!fence && TABLE_ROW.test(tail)) {
        rows.push(tail);
        tail = '';
      }
      if (rows.length > 0) write(`${held()}${tail ? '\n' : ''}`);
      if (tail) write(line(tail));
      tail = '';
      rows = [];
      fence = false;
      hang = null;
      lang = '';
      code = { comment: false };
    },
    /** What has not been written yet, rendered as far as it has got: the rows of a table, and the line still arriving. */
    get tail() {
      const going = /^\s+\S/.test(tail) && hangOf(tail) === null ? hang : null;
      return [rows.length > 0 ? held() : '', tail && !/^\s*```/.test(tail) ? renderLine(fence ? tail : closedForNow(tail), s, { fence, width, hang: going, lang, code: { ...code } }) : ''].filter(Boolean).join('\n');
    },
  };
}

/** This sumo's version, from its package.json; empty where there is none to read, as beside a standalone binary. */
export const VERSION = (() => {
  try {
    return String(JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')).version ?? '');
  } catch {
    return '';
  }
})();

/** The words shown while the model works: yours, one a line, in spinner.txt at the top of the repo. */
const SPINNER_FILE = join(REPO_ROOT, 'spinner.txt');
const SPINNER_FALLBACK = ['Working'];

/** The working messages: every line of the file that is not blank and not a `#` comment. */
export function spinnerMessages(file = SPINNER_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return SPINNER_FALLBACK;
  }
  const messages = text.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
  return messages.length > 0 ? messages : SPINNER_FALLBACK;
}

export const pickMessage = (messages, random = Math.random) => messages[Math.floor(random() * messages.length)];

const MESSAGE_MS = 5000;

/** The working message `elapsed` ms into work that opened on `first`: the next in the file every five seconds, round and round. */
export const messageAt = (messages, first, elapsed) => messages[(Math.max(0, messages.indexOf(first)) + Math.floor(elapsed / MESSAGE_MS)) % messages.length];

/** The chat's colours: gold, into orange, into crimson. */
const SUNSET = [[0xff, 0xd1, 0x66], [0xf7, 0x7f, 0x00], [0xd6, 0x28, 0x28]];

/** The colour `t` of the way through the sunset, 0 its gold and 1 its crimson. */
export function sunset(t) {
  const at = Math.min(Math.max(t, 0), 1) * (SUNSET.length - 1);
  const i = Math.min(Math.floor(at), SUNSET.length - 2);
  return `#${SUNSET[i].map((v, k) => Math.round(v + (SUNSET[i + 1][k] - v) * (at - i)).toString(16).padStart(2, '0')).join('')}`;
}

const FLOW_LENGTH = 24;

/** The colour of character `i` at `frame` of a sunset flowing through words: gold to crimson and back, a step a character, moving on a character a frame. */
export function flow(i, frame) {
  const step = (((i - frame) % FLOW_LENGTH) + FLOW_LENGTH) % FLOW_LENGTH;
  return sunset(1 - Math.abs(1 - (2 * step) / FLOW_LENGTH));
}

/** What the chat draws faint in the empty room above the box you type in: yours, in logo.txt at the top of the repo. */
const LOGO_FILE = join(REPO_ROOT, 'logo.txt');

/** The logo's rows, as drawn: `#` comments and the blank rows around it dropped, the blank rows inside it kept. No file draws nothing. */
export function logoLines(file = LOGO_FILE) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const rows = text.split('\n').filter((l) => !l.startsWith('#')).map((l) => l.trimEnd());
  while (rows.length > 0 && !rows[0]) rows.shift();
  while (rows.length > 0 && !rows.at(-1)) rows.pop();
  return rows;
}

const SHOWN_REPORT_LINES = 3;
const SHOWN_HEAD_LINES = 2;
const SHOWN_TAIL_LINES = 3;
/** The rows of the screen an edit's diff takes before the rest is folded away. */
const SHOWN_DIFF_ROWS = 12;
const SHOWN_COMMAND_LINES = 3;
const SHOWN_COMMAND_CHARS = 240;
const SHOWN_WRITE_LINES = 4;

const more = (n) => ({ text: `… +${n} line${n === 1 ? '' : 's'}`, tone: 'dim' });

/** The top of a list of lines, and how many more there were. One more line is shown, not folded: its fold would take its row. */
function top(lines, max) {
  return lines.length > max + 1 ? [...lines.slice(0, max), more(lines.length - max)] : lines;
}

/** Both ends of what a command printed, and how many lines lie between: a run says how it went in its last lines. */
function ends(lines, full) {
  if (full || lines.length <= SHOWN_HEAD_LINES + SHOWN_TAIL_LINES + 1) return lines;
  return [...lines.slice(0, SHOWN_HEAD_LINES), more(lines.length - SHOWN_HEAD_LINES - SHOWN_TAIL_LINES), ...lines.slice(-SHOWN_TAIL_LINES)];
}

/** A path as a person reads it: under the home directory, from `~`. */
export const tilde = (path, home = homedir()) => (path === home ? '~' : String(path).startsWith(`${home}${sep}`) ? `~${String(path).slice(home.length)}` : String(path));

/**
 * A path without the link macOS keeps its own /var, /tmp and /etc behind (`/private/var` is `/var`): one file, one
 * spelling on the screen, however the model or a resolved path named it. Elsewhere `/private` is a folder like any other.
 */
const unlinked = (path) => (process.platform === 'darwin' ? String(path).replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, '') : String(path));

/** A path as the work reads it: a file in the project from the project, anything else from the home directory. */
export const pathFrom = (path, cwd) => {
  const at = unlinked(path);
  const from = cwd ? unlinked(cwd) : null;
  return from && at === from ? '.' : from && at.startsWith(`${from}${sep}`) ? at.slice(from.length + 1) : tilde(at);
};

/** What the work said back, the files in the project in it named from there, as its title names them: the editor's own words. */
const fromProject = (text, cwd) => {
  if (!cwd) return text;
  const at = unlinked(cwd);
  const places = process.platform === 'darwin' && /^\/(?:var|tmp|etc)(?:\/|$)/.test(at) ? [`/private${at}`, at] : [at];
  return places.reduce((said, place) => said.replaceAll(`${place}${sep}`, ''), String(text));
};

/** How a delegated job ended, for the line that sums it up: its mark, the word for it, and its colour. */
const JOB_ENDS = { done: ['✓', 'done', 'add'], failed: ['✗', 'failed', 'error'], needs_input: ['?', 'needs your answer', 'ask'], open: ['○', 'never closed', 'dim'], stopped: ['■', 'stopped by you', 'dim'] };

/**
 * What a command printed in colour reaches the model with its escapes shown as markers (⟨U+001B⟩[31m); on the screen
 * they are noise in the words, and go. Any other hidden character keeps its marker.
 */
export const withoutColourCodes = (text) => String(text).replace(/⟨U\+001B⟩\[[0-?]*[ -/]*[@-~]|⟨U\+001B⟩\][^\n]*?(?:⟨U\+0007⟩|⟨U\+001B⟩\\)/g, '');

const toned = (text, tone) => withoutColourCodes(text).split('\n').map((t) => ({ text: t, tone }));
const count = (text) => [{ text: `${text === '' ? 0 : text.replace(/\n$/, '').split('\n').length} lines`, tone: 'dim' }];

/**
 * Where two lines differ: what lies between the start they share and the end they share, in each — null when they share
 * neither, since then the whole line is the change and marking it says nothing.
 */
function changedSpan(a, b) {
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let end = 0;
  while (end < a.length - start && end < b.length - start && a.at(-1 - end) === b.at(-1 - end)) end++;
  if (start + end === 0) return null;
  return [
    [start, a.length - end],
    [start, b.length - end],
  ];
}

/**
 * An edit as a diff: the lines old and new share at their ends are what stayed, and what lies between is what went and
 * what came — each numbered as the file numbers it when `line` says where the old text began, with one line of what
 * stayed on either side. A line that went stands over the line that came in its place, the part of each that changed
 * marked (`span`); what is left over on either side follows. Folding is the screen's: by the rows the lines take
 * there (`rows`), so a narrow window does not show a long edit whole.
 */
function diffView(old, now, line, full) {
  const was = old === '' ? [] : old.replace(/\r\n/g, '\n').split('\n');
  const is = now === '' ? [] : now.replace(/\r\n/g, '\n').split('\n');
  let head = 0;
  while (head < was.length && head < is.length && was[head] === is[head]) head++;
  let tail = 0;
  while (tail < was.length - head && tail < is.length - head && was.at(-1 - tail) === is.at(-1 - tail)) tail++;
  const went = was.slice(head, was.length - tail);
  const came = is.slice(head, is.length - tail);
  const wide = line === null ? 0 : String(line + Math.max(was.length, is.length)).length;
  const row = (n, sign, text, tone, span = null) => {
    const lead = line === null ? `${sign} ` : `${String(line + n).padStart(wide)} ${sign} `;
    return { text: `${lead}${text}`, tone, ...(span && span[1] > span[0] ? { span: [lead.length + span[0], lead.length + span[1]] } : {}) };
  };
  // Pairs go only as far as both sides do: past that, what is left of the longer side, in its own order.
  const lines = [];
  for (let i = 0; i < Math.max(went.length, came.length); i++) {
    const both = i < went.length && i < came.length ? changedSpan(went[i], came[i]) : null;
    if (i < went.length) lines.push(row(head + i, '-', went[i], 'del', both?.[0]));
    if (i < came.length) lines.push(row(head + i, '+', came[i], 'add', both?.[1]));
  }
  return {
    at: line === null ? null : line + head,
    stat: { added: came.length, removed: went.length },
    rows: full ? null : SHOWN_DIFF_ROWS,
    lines: [...(head > 0 ? [row(head - 1, ' ', was[head - 1], 'dim')] : []), ...lines, ...(tail > 0 ? [row(is.length - tail, ' ', is[is.length - tail], 'dim')] : [])],
  };
}

/** A line with the part of it that changed in reverse video, which shows with colour off too where reverse video does. */
export const withSpan = (line, s) => (line.span ? `${untab(line.text.slice(0, line.span[0]))}${s.inverse(untab(line.text.slice(...line.span)))}${untab(line.text.slice(line.span[1]))}` : untab(line.text));

/**
 * A report as it reads, a line each: no table rules, a table's row its cells, no marks, a file in the project named from
 * there. A heading is dropped — or, with `headings: 'keep'`, kept as its words; either way a line of three words or fewer
 * under one ("None.", "Matches.") says nothing without it, and takes it in front.
 */
function readable(text, cwd = null, { headings = 'drop' } = {}) {
  const lines = [];
  let heading = null;
  for (const raw of String(text ?? '').split('\n')) {
    if (!raw.trim() || TABLE_RULE.test(raw)) continue;
    const head = /^#{1,6}\s+(.*)$/.exec(raw);
    if (head) {
      heading = inline(head[1], NO_STYLE).replace(/:\s*$/, '');
      if (headings === 'keep') lines.push(heading);
      continue;
    }
    const line = inline(TABLE_ROW.test(raw) ? cellsOf(raw).filter(Boolean).join(' · ') : raw.replace(/^(\s*)[-*+]\s+/, '$1• '), NO_STYLE);
    const named = cwd ? line.replaceAll(`${cwd}${sep}`, '') : line;
    if (heading && named.trim().split(/\s+/).length <= 3) {
      if (headings === 'keep') lines.pop();
      lines.push(`${heading}: ${named.trim()}`);
    } else lines.push(named);
    heading = null;
  }
  return lines;
}

/**
 * A tool call for the screen: what ran, and under it the part of the result
 * worth a glance — both ends of a command's output, an edit as a diff, a read
 * or a write as its size. Without a result it is the call alone; `full` is
 * every line, the command whole, and the file itself for a read or a write.
 * `cwd` is the project the work is in: a file in it is named from there.
 */
/** The most of one line a folded result shows: about five rows of a window 80 wide. */
const LONG_LINE = 400;

export function toolView(call, result = null, { full = false, cwd = null } = {}) {
  // Folded, a result written for the screen as well as for the model says what it means in a line; in full, every word.
  if (!full && typeof result?.shown === 'string') result = { ...result, content: result.shown };
  const input = call.input ?? {};
  // Folded, the empty lines of what came back are not shown: three of five lines spent on nothing say nothing.
  const output = (content = result.content) => {
    const lines = toned(content, result.isError ? 'error' : 'plain');
    // What reads as a diff — `git diff`, a patch — is drawn as one: what went red, what came green.
    if (!result.isError && /^(?:diff --git |@@ -\d)/m.test(content)) for (const line of lines) line.tone = /^\+(?!\+\+ )/.test(line.text) ? 'add' : /^-(?!-- )/.test(line.text) ? 'del' : line.tone;
    if (full) return lines;
    // One very long line — a list of paths, a minified file — is cut to a few rows, not left to fill the window.
    for (const line of lines) if (line.text.length > LONG_LINE) line.text = `${line.text.slice(0, LONG_LINE - 2)} …`;
    const said = lines.filter((line) => line.text.trim() !== '');
    return said.length === 0 ? [{ text: '(no output)', tone: 'dim' }] : ends(said, false);
  };
  if (call.name === BASH_TOOL.name) {
    // Folded, the command is its first lines; asked for in full, it is all there: nothing else on the screen says what ran.
    // A command that begins by going to the project says nothing by it — the shell starts there — and is shown without that.
    const whole = String(input.command ?? '').trim();
    const there = cwd && !full ? new RegExp(`^cd\\s+(["']?)${cwd.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/?\\1\\s*(?:&&|;)\\s*`) : null;
    const command = (there && whole.replace(there, '')) || whole;
    const start = command.split('\n').slice(0, SHOWN_COMMAND_LINES).join('\n').slice(0, SHOWN_COMMAND_CHARS);
    const detail = full || start.length === command.length ? command : `${start} …`;
    if (!result) return { title: 'Bash', detail, lines: [] };
    if (result.content === '') return { title: 'Bash', detail, lines: [{ text: '(no output)', tone: 'dim' }] };
    return { title: 'Bash', detail, lines: output() };
  }
  if (call.name === DELEGATE_TOOL.name) {
    // A report a job in the background sent back is titled as one, by who sent it; a call is the delegation itself.
    const title = input.report ? 'Report' : 'Delegate';
    const detail = input.job !== undefined ? `j${input.job}${input.report && input.agent ? ` ${input.agent} · ${input.title ?? ''}` : ''}` : `${input.agent ?? 'worker'} · ${input.title ?? ''}`;
    if (!result) return { title, detail, lines: [] };
    // Started in the background: what the call answered is for the model — how to wait, what not to guess. The screen says the one thing it means.
    if (!full && !result.isError && /^j\d+ is running in the background/.test(result.content)) return { title, detail, lines: [{ text: 'running in the background — its report comes here when it is done', tone: 'dim' }] };
    if (full) return { title, detail, lines: output() };
    // Several attempts report together, in markdown: shown as it reads, like a single job's report.
    if (!result.job) return { title, detail, lines: output(result.isError ? result.content : readable(result.content, cwd, { headings: 'keep' }).join('\n')) };
    // A job that ran: how it went in one line, then the top of what it reported.
    const { job } = result;
    // Stopped by the user before it closed itself, it was stopped — not left open.
    const [mark, said, tone] = input.stopped && !['done', 'failed', 'needs_input'].includes(job.status) ? JOB_ENDS.stopped : (JOB_ENDS[job.status] ?? JOB_ENDS.open);
    const route = job.effort && job.effort !== 'none' ? `${job.model}/${job.effort}` : job.model;
    // How long it took comes first: it is what the wait was.
    const summary = `${mark} j${job.id} ${said}${job.seconds === undefined ? '' : ` · ${elapsed(job.seconds * 1000)}`} · ${job.turns} turn${job.turns === 1 ? '' : 's'} · ${job.toolCalls} tool call${job.toolCalls === 1 ? '' : 's'} · $${job.costUsd.toFixed(2)} · ${route}`;
    // The top of the report is its first words, as they read: not the heading over them, not a table's rule, not its marks;
    // a table's row is its cells, and a file in the project is named from there.
    const report = readable(job.report, cwd);
    return { title, detail, lines: [{ text: summary, tone }, ...top(report.map((text) => ({ text, tone: 'plain' })), SHOWN_REPORT_LINES)] };
  }
  if (isMcpTool(call.name)) {
    // A server's tool: the server as the title, the tool with its input as the detail, what came back under it.
    const { server, tool } = splitMcpName(call.name);
    const detail = `${tool}(${compactInput(input)})`;
    if (!result) return { title: server, detail, lines: [] };
    // The line that tells the model whose data this is: here the title says it.
    return { title: server, detail, lines: output(unlabeled(result.content)) };
  }
  if (isWebTool(call)) {
    // The web: what was searched for or which page was read, and under it the pages found or the page and its size.
    const detail = String(input.query ?? input.url ?? '').slice(0, SHOWN_COMMAND_CHARS);
    return { title: call.name === WEB_SEARCH_TOOL.name ? 'Search' : 'Fetch', detail, lines: result ? output() : [] };
  }
  if (isAdvisorTool(call)) {
    // The advisor: who was asked. The advice is the model's alone to read, so under it only that it came, or why it did not.
    return { title: 'Advisor', detail: String(input.asked ?? ''), lines: result ? output() : [] };
  }
  if (call.name === ASK_TOOL.name) {
    // A question put to the user: the question, and under it what they answered.
    const question = String(input.question ?? '').split('\n')[0];
    return { title: 'Question', detail: question, lines: result ? output() : [] };
  }
  if (call.name !== EDITOR_TOOL.name) {
    // A job's own tools: what it was given in a line, what came back under it.
    const given = String(input.status ?? input.query ?? input.question ?? input.text ?? '').split('\n')[0].slice(0, 80);
    if (!result) return { title: call.name, detail: given, lines: [] };
    return { title: call.name, detail: given, lines: output() };
  }
  const range = Array.isArray(input.view_range) ? `:${input.view_range.join('-')}` : '';
  const title = input.command === 'view' ? 'Read' : input.command === 'create' ? 'Write' : input.command === 'str_replace' || input.command === 'insert' ? 'Update' : call.name;
  const detail = `${pathFrom(input.path ?? '', cwd)}${range}`;
  if (!result) return { title, detail, lines: [] };
  // Folded, a failure names the file as the title does; in full, it is every word as the model read it.
  if (result.isError) return { title, detail, lines: output(full ? result.content : fromProject(result.content, cwd)) };
  const added = (text) => toned(text, 'add').map((l) => ({ ...l, text: `+ ${l.text}` }));
  if (input.command === 'view') return { title, detail, lines: full ? toned(result.content, 'plain') : count(result.content) };
  // A new file is shown by its top, as what came: what was written is what is checked first.
  if (input.command === 'create') {
    const text = String(input.file_text ?? '').replace(/\n$/, '');
    if (!text) return { title, detail, lines: [{ text: '(empty)', tone: 'dim' }] };
    return { title, detail, lines: full ? added(text) : top(added(text), SHOWN_WRITE_LINES) };
  }
  // The editor says where the old text began and what the file had there; a result that does not is drawn from what the model sent.
  const came = input.command === 'insert' ? (input.insert_text ?? input.new_str ?? '').replace(/\n$/, '') : (input.new_str ?? '');
  const edit = result.edit ?? { line: null, old: input.command === 'str_replace' ? (input.old_str ?? '') : '', new: came };
  const diff = diffView(edit.old, edit.new, edit.line ?? null, full);
  return { title, detail: diff.at === null ? detail : `${detail}:${diff.at}`, stat: diff.stat, lines: diff.lines, rows: diff.rows };
}

/** The failures a request meets most, in the words a person acts on: what happened, and what to do about it. */
const FAILURES = [
  [/overloaded|\b529\b/i, "Anthropic's API is overloaded just now — nothing was lost; send it again in a minute"],
  [/rate.?limit|\b429\b/i, 'rate limited by the API — wait a minute and send it again, or /model to another model'],
  [/credit balance|billing|payment/i, 'the API account has no credit left — top it up, then send it again'],
  [/prompt is too long|context.{0,20}(window|length|limit)|too many tokens/i, 'the conversation no longer fits the model — /handoff starts a fresh session with a hand-off; /new starts bare; the memory brings the thread back'],
  // Any other request the API turned down — an image too big, a model it does not know — says why in its own words, kept
  // under this. It and the context's go before the credential's: a 400 that says "invalid_request_error … tokens" is no
  // credential refused.
  [/^4(?!01|08|09|29)\d\d\b|\b(?:invalid_request|permission|not_found|request_too_large)_error\b/i, 'the API refused the request — its reason is below; change what it names, or /new to start clean'],
  [/\b401\b|authentication|x-api-key|invalid.*token|oauth/i, 'the API refused the credential — check ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN, then sumo doctor'],
  [/ENOTFOUND|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|network|connection error/i, 'no connection to the API — check the network, then send it again'],
  [/\b5\d\d\b|internal server error|api_error/i, 'the API failed on its side — send it again'],
];

/** A failure for the screen: in words when it is one of the known ones, with what came back kept faint under it; as it came otherwise. */
export function explained(message) {
  const said = String(message ?? '').replace(/\s+/g, ' ').trim();
  const known = FAILURES.find(([pattern]) => pattern.test(said));
  return known ? { text: `error: ${known[1]}`, detail: said.length > 200 ? `${said.slice(0, 199)}…` : said } : { text: `error: ${said}` };
}

/** /help's rows as text: the command or key, then what it does, in a column of its own; a blank row stays blank. */
const helpLines = (rows, s) => {
  const wide = Math.max(...rows.filter(Boolean).map((row) => row.key.length)) + 2;
  return rows.map((row) => (row ? `  ${row.key.padEnd(wide)}${s.dim(row.does)}` : ''));
};

/**
 * The conversation as text for a pager: every entry of the chat's log in full — the whole command, all a tool gave back,
 * a reply as it is drawn — in the terminal's colours. What the screen folds, this does not; a pager scrolls and searches it.
 */
export function transcript(log, s, { width = MAX_WIDTH, cwd = null } = {}) {
  const tones = { plain: (t) => t, dim: s.dim, error: s.red, add: s.green, del: s.red, ask: s.yellow };
  const { g } = s;
  const under = (lines) => lines.map((line, i) => `${i === 0 ? `  ${g.under}  ` : '     '}${(tones[line.tone] ?? tones.plain)(withSpan(line, s))}`);
  const out = [];
  for (const entry of log) {
    if (entry.kind === 'user') out.push('', ...untab(entry.text).split('\n').map((line) => `${s.yellow(g.bar)} ${line}`));
    else if (entry.kind === 'reply') {
      const drawn = [];
      const reply = createRenderer((text) => drawn.push(text), s, { width: Math.max(MIN_WIDTH, width - 3) });
      reply.write(entry.raw);
      reply.flush();
      out.push('', ...drawn.join('').replace(/\n$/, '').split('\n').map((line, i) => `${i === 0 ? `${g.tool} ` : '  '}${line}`));
    } else if (entry.kind === 'tool') {
      const view = toolView(entry.call, entry.result, { full: true, cwd });
      const stat = view.stat ? ` ${s.green(`+${view.stat.added}`)} ${s.red(`−${view.stat.removed}`)}` : '';
      // A failure has a mark of its own: colour alone does not tell it to someone who cannot see the colour.
      out.push('', `${entry.result.isError ? s.red(g.fail) : s.green(g.tool)} ${s.bold(view.title)}(${untab(view.detail).split('\n').join('\n  ')})${stat}`, ...under(view.lines));
    } else if (entry.kind === 'shell') out.push(...under(toolView({ name: BASH_TOOL.name }, entry.result, { full: true }).lines));
    else if (entry.kind === 'job') out.push('', `${g.tool} ${s.bold(`j${entry.id}`)} ${entry.agent} · ${entry.route} — ${entry.title}`);
    else if (entry.kind === 'error') out.push('', s.red(`${g.fail} ${entry.text}`), ...(entry.detail ? [s.dim(`  ${entry.detail}`)] : []));
    else if (entry.kind === 'thought') out.push('', s.dim(`${g.thought} Thought for ${elapsed(entry.ms)}`), ...String(entry.text ?? '').trim().split('\n').filter(Boolean).map((line) => s.dim(s.italic(`  ${line}`))));
    else if (entry.kind === 'footer') out.push('', s.dim(`  ${entry.text}`));
    else if (entry.kind === 'help') out.push('', ...helpLines(entry.rows, s));
    else if (entry.kind === 'note') out.push(s.dim(`  ${g.under}  ${entry.text.split('\n').join('\n     ')}`));
  }
  return `${out.join('\n').replace(/^\n/, '')}\n`;
}

/** A fence for text that may hold fences of its own: longer than any run of backticks in it. */
const fenceFor = (text) => '`'.repeat(Math.max(3, ...[...String(text).matchAll(/`+/g)].map((m) => m[0].length + 1)));

/**
 * The conversation as Markdown, for `/export`: what was said quoted, each reply as the model wrote it, each call folded
 * away under its name with all it gave back, the thinking under how long it took. Nothing is coloured; it is a file to keep.
 */
export function markdownOf(log, { cwd = null, title = 'Sumo' } = {}) {
  const out = [`# ${title}`];
  const folded = (summary, body) => {
    const fence = fenceFor(body);
    out.push('', `<details><summary>${summary.replace(/</g, '&lt;')}</summary>`, '', fence, body, fence, '', '</details>');
  };
  for (const entry of log) {
    if (entry.kind === 'user') out.push('', '**You**', '', ...entry.text.split('\n').map((line) => `> ${line}`));
    else if (entry.kind === 'reply') out.push('', entry.raw.trim());
    else if (entry.kind === 'tool') {
      const view = toolView(entry.call, entry.result, { full: true, cwd });
      folded(`${view.title}(${view.detail.split('\n')[0]})${entry.result.isError ? ' — failed' : ''}`, view.lines.map((line) => line.text).join('\n'));
    } else if (entry.kind === 'shell') folded('! command', String(entry.result.content));
    else if (entry.kind === 'thought') folded(`Thought for ${elapsed(entry.ms)}`, String(entry.text ?? '').trim());
    else if (entry.kind === 'job') out.push('', `**j${entry.id}** ${entry.agent} · ${entry.route} — ${entry.title}`);
    else if (entry.kind === 'error') out.push('', `**${entry.text}**${entry.detail ? ` — ${entry.detail}` : ''}`);
    else if (entry.kind === 'note' || entry.kind === 'footer') out.push('', ...entry.text.split('\n').map((line) => `_${line}_`));
  }
  return `${out.join('\n')}\n`;
}

const kindOf = (raw) => (/^Ask the user/.test(raw) ? 'ask' : /^Warning/.test(raw) ? 'warning' : /^Left off/.test(raw) ? 'left' : /^- m\d+ /.test(raw) ? 'item' : raw);

/**
 * The memory block for the user's eyes: tags dropped, labels bold, ids dim,
 * questions yellow, warnings red, a blank line between sections, long lines
 * wrapped under their label.
 */
export function renderBlock(block, s, { width = MAX_WIDTH } = {}) {
  const out = [];
  let previous = null;
  for (const raw of block.split('\n')) {
    if (/^<\/?sumo-memory/.test(raw) || raw.trim() === '') continue;
    const kind = kindOf(raw);
    // A section is a run of items under their heading; anything else starts one of its own.
    if (previous !== null && kind !== 'item' && !(kind === previous && kind !== raw)) out.push('');
    previous = kind;
    const label = /^([A-Z][a-z]+(?: [a-z]+)*)(\s*\(.*\))?:\s*(.*)$/.exec(raw);
    const item = /^- (m\d+)\s+(.*)$/.exec(raw);
    if (kind === 'ask') out.push(s.yellow(wrap(raw, width, '  ')));
    else if (kind === 'warning') out.push(s.red(wrap(raw, width, '  ')));
    else if (item) out.push(wrap(`  ${s.dim(item[1])} ${item[2]}`, width, '      '));
    else if (label) out.push(wrap(`${s.bold(label[1])}${s.dim(`${label[2] ?? ''}:`)}${label[3] ? ` ${label[3]}` : ''}`, width, '  '));
    else out.push(wrap(raw, width, '  '));
  }
  return out.join('\n');
}

/** The line above the memory block: which model is answering, how hard it thinks, where the work is. */
export function header({ route, cwd }, s) {
  return `${s.bold(s.green('sumo'))}  ${s.dim('route')} ${route}  ${s.dim(cwd)}`;
}

/** The prompt: the model and effort kept in view, the size of the context once it matters. */
export function prompt({ route, contextTokens }, s) {
  const k = contextTokens >= 1000 ? ` ${Math.round(contextTokens / 1000)}k` : '';
  return `${s.bold(s.green('sumo'))}${s.dim(` ${route}${k}`)}${s.bold('>')} `;
}

/**
 * Text from a job — what a model wrote, what a command printed — made safe to put on a terminal: colours are kept,
 * every other control character and escape is dropped, so nothing in it can write the clipboard, retitle the window
 * or clear the screen of whoever is watching.
 */
export const safeForTerminal = (text) => String(text).replace(/\x1b\[[0-9;]*m|[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, (m) => (m.length > 1 ? m : ''));
