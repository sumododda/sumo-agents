// A terminal that is not there: what the screen would show, and keys typed into it.
import { EventEmitter } from 'node:events';

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;

export function fakeTty({ columns = 80, rows = 40 } = {}) {
  const stdout = new EventEmitter();
  let last = '';
  let tallest = 0;
  Object.assign(stdout, {
    columns,
    rows,
    isTTY: true,
    write(frame) {
      last = String(frame);
      tallest = Math.max(tallest, last.replace(ANSI, '').split('\n').length);
      return true;
    },
  });

  const stdin = new EventEmitter();
  let pending = null;
  Object.assign(stdin, {
    isTTY: true,
    setEncoding() {},
    setRawMode() {},
    ref() {},
    unref() {},
    resume() {},
    pause() {},
    read() {
      const chunk = pending;
      pending = null;
      return chunk;
    },
  });

  return {
    stdin,
    stdout,
    /** The last frame, without its colours. */
    screen: () => last.replace(ANSI, ''),
    /** The most lines any frame has had. */
    tallest: () => tallest,
    /** The window dragged to a new width, and to a new height when one is given. */
    resize(to, height = stdout.rows) {
      stdout.columns = to;
      stdout.rows = height;
      stdout.emit('resize');
    },
    /** Keys, as the terminal would send them; each chunk is given time to be read as its own keypress. */
    async type(...chunks) {
      for (const chunk of chunks) {
        pending = chunk;
        stdin.emit('readable');
        await new Promise((r) => setTimeout(r, 40));
      }
    },
  };
}
