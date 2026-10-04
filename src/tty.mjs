import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';
import { BASH_TOOL } from './tools.mjs';

/**
 * What the chat terminal looks like: the reply's markdown turned into bold,
 * dim and colour as it streams, wrapped to a readable width; the memory block
 * in spaced sections with its labels standing out; tool lines and errors told
 * apart from the model's own words. Colour is off when stdout is not a
 * terminal or NO_COLOR is set, so a pipe gets plain text.
 */

const CODES = { bold: ['1', '22'], dim: ['2', '22'], cyan: ['36', '39'], yellow: ['33', '39'], red: ['31', '39'], green: ['32', '39'] };
const MAX_WIDTH = 100;
const MIN_WIDTH = 40;

/** The style functions, each a no-op when colour is off. */
export function styles(enabled) {
  const s = {};
  for (const [name, [on, off]] of Object.entries(CODES)) s[name] = enabled ? (t) => `\x1b[${on}m${t}\x1b[${off}m` : (t) => t;
  return s;
}

export const colourEnabled = (stream = process.stdout, env = process.env) => Boolean(stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';

/** Lines no wider than this read comfortably whatever the window is. */
export const widthOf = (stream = process.stdout, env = process.env) => Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, (stream.columns || Number(env.COLUMNS) || 80) - 1));

const visible = (t) => t.replace(/\x1b\[[0-9;]*m/g, '').length;

/** Word-wraps styled text to `width`, measuring only what is visible; continuation lines carry `indent`. */
export function wrap(text, width, indent = '') {
  if (visible(text) <= width) return text;
  const lead = /^\s*/.exec(text)[0];
  const lines = [];
  let line = lead;
  for (const word of text.slice(lead.length).split(' ')) {
    const next = line === lead ? `${lead}${word}` : `${line} ${word}`;
    if (line !== lead && visible(next) > width) {
      lines.push(line);
      line = `${indent}${word}`;
    } else line = next;
  }
  lines.push(line);
  return lines.join('\n');
}

/** Inline markdown on one line: bold, inline code, links shown as their text. */
export function inline(line, s) {
  return line
    .replace(/`([^`]+)`/g, (_, code) => s.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => s.bold(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `${text} ${s.dim(url)}`);
}

/** One line of a reply: block-level marks replaced by weight and indent, then wrapped with a hanging indent. */
export function renderLine(line, s, { fence = false, width = MAX_WIDTH } = {}) {
  if (fence) return `    ${s.dim(line)}`;
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return wrap(s.bold(heading[2]), width);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) return wrap(`${bullet[1]}  ${s.dim('•')} ${inline(bullet[2], s)}`, width, `${bullet[1]}    `);
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) return wrap(`${numbered[1]}  ${s.dim(`${numbered[2]}.`)} ${inline(numbered[3], s)}`, width, `${numbered[1]}     `);
  if (/^\s*>\s?/.test(line)) return s.dim(wrap(`  │ ${line.replace(/^\s*>\s?/, '')}`, width, '  │ '));
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return s.dim('─'.repeat(40));
  return wrap(inline(line, s), width);
}

const TABLE_ROW = /^\s*\|.*\|\s*$/;
const TABLE_RULE = /^\s*\|(\s*:?-+:?\s*\|)+\s*$/;
const MIN_COLUMN = 3;
const NO_STYLE = styles(false);

const cellsOf = (row) => row.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));

const GRAPHEMES = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

/** A line cut into pieces no wider than `width`, between characters: an emoji, even one joined from several, stays whole. */
function cut(line, width) {
  const pieces = [''];
  for (const { segment: ch } of GRAPHEMES.segment(line)) {
    if (pieces.at(-1) && pieces.at(-1).length + ch.length > width) pieces.push('');
    pieces[pieces.length - 1] += ch;
  }
  return pieces;
}

/** A cell's text folded to its column; a word wider than the column is cut, so the box keeps its shape. */
function fold(text, width) {
  return wrap(text, width)
    .split('\n')
    .flatMap((line) => (line.length <= width ? [line] : cut(line, width)));
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
  const widths = Array.from({ length: columns }, (_, i) => Math.max(1, ...table.map((row) => visible(inline(row[i], s)))));
  const room = width - (3 * columns + 1);
  while (widths.reduce((a, b) => a + b, 0) > room && Math.max(...widths) > MIN_COLUMN) widths[widths.indexOf(Math.max(...widths))]--;

  const edge = (left, mid, right) => s.dim(`${left}${widths.map((w) => '─'.repeat(w + 2)).join(mid)}${right}`);
  const bar = s.dim('│');
  const draw = (row, style) => {
    const cells = row.map((cell, i) => (visible(inline(cell, s)) <= widths[i] ? [inline(cell, s)] : fold(inline(cell, NO_STYLE), widths[i])));
    const height = Math.max(...cells.map((c) => c.length));
    return Array.from({ length: height }, (_, n) => `${bar} ${cells.map((c, i) => style(pad(c[n] ?? '', widths[i], aligns[i]))).join(` ${bar} `)} ${bar}`);
  };
  return [edge('┌', '┬', '┐'), ...draw(table[0], s.bold), edge('├', '┼', '┤'), ...table.slice(1).flatMap((row) => draw(row, (t) => t)), edge('└', '┴', '┘')].join('\n');
}

/**
 * A line-buffered renderer for streamed text: each complete line is written
 * rendered as soon as it arrives; the tail is kept until it ends or `flush`.
 * The rows of a table are kept too, until the line after it shows it is whole.
 */
export function createRenderer(write, s, { width = MAX_WIDTH } = {}) {
  let tail = '';
  let fence = false;
  let rows = [];
  const line = (raw) => {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      return s.dim(fence ? '    ┌─' : '    └─');
    }
    return renderLine(raw, s, { fence, width });
  };
  /** The rows held so far: a table once its rule has come, the lines they were otherwise. */
  const held = () => (rows.length >= 2 && TABLE_RULE.test(rows[1]) ? renderTable(rows, s, width) : rows.map((r) => renderLine(r, s, { width })).join('\n'));
  return {
    write(chunk) {
      tail += chunk;
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
    },
    /** What has not been written yet, rendered as far as it has got: the rows of a table, and the line still arriving. */
    get tail() {
      return [rows.length > 0 ? held() : '', tail && !/^\s*```/.test(tail) ? renderLine(tail, s, { fence, width }) : ''].filter(Boolean).join('\n');
    },
  };
}

/** The words shown while the model works: yours, one a line, in spinner.txt at the top of the repo. */
export const SPINNER_FILE = join(REPO_ROOT, 'spinner.txt');
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
export const LOGO_FILE = join(REPO_ROOT, 'logo.txt');

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

const SHOWN_OUTPUT_LINES = 3;
const SHOWN_DIFF_LINES = 12;

/** The top of a list of lines, and how many more there were. */
function top(lines, max) {
  return lines.length > max ? [...lines.slice(0, max), { text: `… +${lines.length - max} lines`, tone: 'dim' }] : lines;
}

const toned = (text, tone) => String(text).split('\n').map((t) => ({ text: t, tone }));
const count = (text) => [{ text: `${text === '' ? 0 : text.replace(/\n$/, '').split('\n').length} lines`, tone: 'dim' }];

/**
 * A tool call for the screen: what ran, and under it the part of the result
 * worth a glance — the top of a command's output, an edit as the lines that
 * went and came, a read or a write as its size. Without a result it is the
 * call alone; `full` is every line, and the file itself for a read or a write.
 */
export function toolView(call, result = null, { full = false } = {}) {
  const input = call.input ?? {};
  if (call.name === BASH_TOOL.name) {
    const [first, ...rest] = String(input.command ?? '').split('\n');
    const detail = `${first.slice(0, 120)}${rest.length > 0 || first.length > 120 ? ' …' : ''}`;
    if (!result) return { title: 'Bash', detail, lines: [] };
    if (result.content === '') return { title: 'Bash', detail, lines: [{ text: '(no output)', tone: 'dim' }] };
    return { title: 'Bash', detail, lines: top(toned(result.content, result.isError ? 'error' : 'plain'), full ? Infinity : SHOWN_OUTPUT_LINES) };
  }
  const range = Array.isArray(input.view_range) ? `:${input.view_range.join('-')}` : '';
  const title = input.command === 'view' ? 'Read' : input.command === 'create' ? 'Write' : input.command === 'str_replace' || input.command === 'insert' ? 'Update' : call.name;
  const detail = `${input.path ?? ''}${range}`;
  if (!result) return { title, detail, lines: [] };
  if (result.isError) return { title, detail, lines: top(toned(result.content, 'error'), full ? Infinity : SHOWN_OUTPUT_LINES) };
  const added = (text) => toned(text, 'add').map((l) => ({ ...l, text: `+ ${l.text}` }));
  if (input.command === 'view') return { title, detail, lines: full ? toned(result.content, 'plain') : count(result.content) };
  if (input.command === 'create') return { title, detail, lines: full ? added(String(input.file_text ?? '').replace(/\n$/, '')) : count(String(input.file_text ?? '')) };
  const went = input.command === 'str_replace' ? toned(input.old_str ?? '', 'del').map((l) => ({ ...l, text: `- ${l.text}` })) : [];
  const came = input.command === 'insert' ? (input.insert_text ?? input.new_str ?? '').replace(/\n$/, '') : (input.new_str ?? '');
  return { title, detail, lines: top([...went, ...added(came)], full ? Infinity : SHOWN_DIFF_LINES) };
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
