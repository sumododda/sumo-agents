// A terminal that is not there: what the screen would show, and keys typed into it.
import { EventEmitter } from 'node:events';

const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
/** A write that is only sequences which draw nothing: an operating-system command (title, notification, clipboard), a mode, a bell, the window scrolled clear. */
const CONTROL = /^(?:\x1b\][^\x07]*\x07|\x1b\[\?[0-9;]*[hl]|\x1b\[[0-9;]*t|\x07|\x1b\[\d+;1H\n+\x1b\[H)+$/;

export function fakeTty({ columns = 80, rows = 40 } = {}) {
  const stdout = new EventEmitter();
  let last = '';
  let tallest = 0;
  const controls = [];
  Object.assign(stdout, {
    columns,
    rows,
    isTTY: true,
    write(frame, ...rest) {
      // A write is done when it is written, as a terminal's stream says by calling back: Ink waits on that to say it has exited.
      const done = rest.find((arg) => typeof arg === 'function');
      if (done) setImmediate(done);
      // What draws nothing — a bell, the title, a mode — is not a frame: it is kept apart, and the screen stays what it was.
      if (CONTROL.test(String(frame))) return controls.push(String(frame)) > 0;
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
    /** Every write that drew nothing, in order: the bell, the title, the modes turned on and off. */
    controls: () => controls,
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
