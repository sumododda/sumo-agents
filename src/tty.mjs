/**
 * What the chat terminal looks like: the reply's markdown turned into bold,
 * dim and colour as it streams; the memory block with its labels standing out;
 * tool lines and errors told apart from the model's own words. Colour is off
 * when stdout is not a terminal or NO_COLOR is set, so a pipe gets plain text.
 */

const CODES = { bold: ['1', '22'], dim: ['2', '22'], cyan: ['36', '39'], yellow: ['33', '39'], red: ['31', '39'], green: ['32', '39'] };

/** The style functions, each a no-op when colour is off. */
export function styles(enabled) {
  const s = {};
  for (const [name, [on, off]] of Object.entries(CODES)) s[name] = enabled ? (t) => `\x1b[${on}m${t}\x1b[${off}m` : (t) => t;
  return s;
}

export const colourEnabled = (stream = process.stdout, env = process.env) => Boolean(stream.isTTY) && !('NO_COLOR' in env) && env.TERM !== 'dumb';

/** Inline markdown on one line: bold, inline code, links shown as their text. */
export function inline(line, s) {
  return line
    .replace(/`([^`]+)`/g, (_, code) => s.cyan(code))
    .replace(/\*\*([^*]+)\*\*/g, (_, t) => s.bold(t))
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, text, url) => `${text} ${s.dim(url)}`);
}

/** One line of a reply, with the block-level marks replaced by weight and indent. */
export function renderLine(line, s, { fence = false } = {}) {
  if (fence) return `    ${s.dim(line)}`;
  const heading = /^(#{1,6})\s+(.*)$/.exec(line);
  if (heading) return s.bold(heading[2]);
  const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
  if (bullet) return `${bullet[1]}  ${s.dim('•')} ${inline(bullet[2], s)}`;
  const numbered = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
  if (numbered) return `${numbered[1]}  ${s.dim(`${numbered[2]}.`)} ${inline(numbered[3], s)}`;
  if (/^\s*>\s?/.test(line)) return s.dim(`  │ ${line.replace(/^\s*>\s?/, '')}`);
  if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) return s.dim('─'.repeat(40));
  return inline(line, s);
}

/**
 * A line-buffered renderer for streamed text: each complete line is written
 * rendered as soon as it arrives; the tail is kept until it ends or `flush`.
 */
export function createRenderer(write, s) {
  let tail = '';
  let fence = false;
  const line = (raw) => {
    if (/^\s*```/.test(raw)) {
      fence = !fence;
      return s.dim(fence ? '    ┌─' : '    └─');
    }
    return renderLine(raw, s, { fence });
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

/** The memory block for the user's eyes: tags dropped, labels bold, ids dim, questions yellow, warnings red. */
export function renderBlock(block, s) {
  const out = [];
  for (const raw of block.split('\n')) {
    if (/^<\/?sumo-memory/.test(raw)) continue;
    const label = /^([A-Z][a-z]+(?: [a-z]+)*)(\s*\(.*\))?:\s*(.*)$/.exec(raw);
    const item = /^- (m\d+)\s+(.*)$/.exec(raw);
    if (/^Ask the user/.test(raw)) out.push(s.yellow(raw));
    else if (/^Warning/.test(raw)) out.push(s.red(raw));
    else if (item) out.push(`  ${s.dim(item[1])} ${item[2]}`);
    else if (label) out.push(`${s.bold(label[1])}${s.dim(`${label[2] ?? ''}:`)}${label[3] ? ` ${label[3]}` : ''}`);
    else out.push(raw);
  }
  return out.join('\n');
}
