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

/**
 * A line-buffered renderer for streamed text: each complete line is written
 * rendered as soon as it arrives; the tail is kept until it ends or `flush`.
 */
export function createRenderer(write, s, { width = MAX_WIDTH } = {}) {
  let tail = '';
  let fence = false;
  const line = (raw) => {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      return s.dim(fence ? '    ┌─' : '    └─');
    }
    return renderLine(raw, s, { fence, width });
  };
  return {
    write(chunk) {
      tail += chunk;
      let at;
      while ((at = tail.indexOf('\n')) !== -1) {
        write(`${line(tail.slice(0, at))}\n`);
        tail = tail.slice(at + 1);
      }
    },
    flush() {
      if (tail) write(line(tail));
      tail = '';
      fence = false;
    },
  };
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
export function header({ model, effort, cwd }, s) {
  return `${s.bold(s.green('sumo'))}  ${s.dim('model')} ${model}  ${s.dim('effort')} ${effort}  ${s.dim(cwd)}`;
}

/** The prompt: the model and effort kept in view, the size of the context once it matters. */
export function prompt({ model, effort, contextTokens }, s) {
  const k = contextTokens >= 1000 ? ` ${Math.round(contextTokens / 1000)}k` : '';
  return `${s.bold(s.green('sumo'))}${s.dim(` ${model}·${effort}${k}`)}${s.bold('>')} `;
}
