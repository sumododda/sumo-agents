import { Box, render, Static, Text, useAnimation, useApp, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { homedir } from 'node:os';
import { createElement as h, useEffect, useReducer, useRef } from 'react';
import { COMMAND_LIST } from './chat.mjs';
import { editor, keysOf, menuOf, paste, press, under } from './editor.mjs';
import { colourEnabled, createRenderer, pickMessage, renderBlock, spinnerMessages, styles, toolView } from './tty.mjs';

/**
 * The chat on a real terminal. What is finished scrolls away above — the
 * memory block, what was typed, each line of a reply, each tool call with the
 * top of its result — and what is live stays at the bottom: the line being
 * written, the command running, the working line, the box to type in. Typing
 * never waits for the model: a message sent mid-turn is queued, Esc stops the
 * turn. All of it is drawing; the session in chat.mjs does the work.
 */

const ACCENT = '#d77757';
const GLYPHS = ['·', '✢', '✳', '✶', '✻', '✽', '✻', '✶', '✳', '✢'];
const TONES = { plain: {}, dim: { dimColor: true }, error: { color: 'red' }, add: { color: 'green' }, del: { color: 'red' } };
const LEAVE_WINDOW_MS = 2000;
const RESIZE_SETTLE_MS = 120;
/** Wipes the window and what has scrolled off it, before everything is drawn again. */
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** A tool call: what ran, and under it what came back. */
function Tool({ view, failed = false, running = false }) {
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, null, h(Text, { color: running ? undefined : failed ? 'red' : 'green', dimColor: running }, '⏺ '), h(Text, { bold: true }, view.title), `(${view.detail})`),
    running ? h(Text, { dimColor: true }, '  ⎿  Running…') : null,
    ...view.lines.map((line, i) => h(Text, { key: i, ...TONES[line.tone] }, `${i === 0 ? '  ⎿  ' : '     '}${line.text}`)),
  );
}

/** One line of a reply; the first of a block carries the mark. */
function Reply({ text, first }) {
  return h(Box, { marginTop: first ? 1 : 0 }, h(Text, null, first ? '⏺ ' : '  '), h(Text, null, text || ' '));
}

/** Something finished, drawn once and left to scroll. */
function Item({ item }) {
  if (item.kind === 'header') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        { borderStyle: 'round', borderColor: ACCENT, paddingX: 1, flexDirection: 'column', alignSelf: 'flex-start' },
        h(Text, null, h(Text, { color: ACCENT }, '✻ '), h(Text, { bold: true }, 'sumo')),
        h(Text, { dimColor: true }, `  ${item.model} · ${item.effort}`),
        h(Text, { dimColor: true }, `  ${item.cwd}`),
      ),
      h(Box, { marginTop: 1 }, h(Text, null, item.block)),
    );
  }
  if (item.kind === 'user') return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '> '), h(Text, { dimColor: true }, item.text));
  if (item.kind === 'text') return h(Reply, item);
  if (item.kind === 'tool') return h(Tool, item);
  if (item.kind === 'error') return h(Box, { marginTop: 1 }, h(Text, { color: 'red' }, item.text));
  return h(Text, { dimColor: true }, `  ⎿  ${item.text.split('\n').join('\n     ')}`);
}

/** The line that says it is working: your words, how long, how much, and how to stop it. */
function Working({ message, tokens }) {
  const { frame, time } = useAnimation({ interval: 120 });
  const spent = tokens > 0 ? ` · ↓ ${thousands(tokens)} tokens` : '';
  return h(Box, { marginTop: 1 }, h(Text, { color: ACCENT }, `${GLYPHS[frame % GLYPHS.length]} ${message}… `), h(Text, { dimColor: true }, `(${Math.floor(time / 1000)}s${spent} · esc to interrupt)`));
}

/** The box to type in, the cursor drawn where the next key lands. */
function Input({ state, width }) {
  const { text, cursor } = state;
  const on = under(state);
  // A cursor on a line end, or past the last character, is drawn as a space of its own.
  const shown = on === '' || on === '\n' ? ' ' : on;
  const after = on === '\n' ? text.slice(cursor) : text.slice(cursor + on.length);
  return h(
    Box,
    { borderStyle: 'round', borderColor: 'gray', paddingX: 1, width },
    h(Text, null, '> '),
    h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, null, text.slice(0, cursor), h(Text, { inverse: true }, shown), after)),
  );
}

function Menu({ menu, pick }) {
  const wide = Math.max(...menu.map((c) => c.name.length)) + 3;
  return h(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    ...menu.map((c, i) => h(Text, { key: c.name, color: i === pick ? ACCENT : undefined, dimColor: i !== pick }, `/${c.name}`.padEnd(wide), c.hint)),
  );
}

function Status({ session, leaving, full }) {
  const size = session.contextTokens >= 1000 ? ` · ${Math.round(session.contextTokens / 1000)}k context` : '';
  const hint = leaving ? 'Ctrl-C again to leave' : full ? 'full output · ctrl-o to fold' : '/ commands · ! shell · \\⏎ new line · ctrl-o full output';
  // In a narrow window the hints give way; the model and the size of the context never fold.
  return h(
    Box,
    { paddingX: 2, justifyContent: 'space-between', gap: 2 },
    h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, `${session.model} · ${session.effort}${size}`)),
    h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, hint)),
  );
}

function App({ session, events, messages, cwd, block }) {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns } = useWindowSize();
  const [, redraw] = useReducer((n) => n + 1, 0);
  const s = styles(colourEnabled(stdout));
  const header = (text) => ({ kind: 'header', model: session.model, effort: session.effort, cwd: cwd.replace(homedir(), '~'), block: text });
  // What the screen holds between draws. Keys and the session's events both write here, in the order they happen, and then ask for a draw.
  // `log` is what happened, as it was said; `items` is the log drawn for this window, and is drawn again when the window or the view changes.
  const st = useRef(null);
  st.current ??= { log: [], items: [], next: 0, epoch: 0, full: false, raw: '', ed: editor(), queue: [], working: null, tokens: 0, running: null, reply: null, fresh: true, leaving: null, gone: false };
  const state = st.current;
  state.columns = columns;

  const place = (items) => {
    state.items = [...state.items, ...items.map((item) => ({ id: state.next++, ...item }))];
  };
  const show = (items) => {
    place(items);
    redraw();
  };
  /** A renderer for a reply: each line it finishes goes on the screen, the first of a block with the mark. */
  const replyTo = (put) =>
    createRenderer(
      (rendered) => {
        put({ kind: 'text', text: rendered.replace(/\n$/, ''), first: state.fresh });
        state.fresh = false;
      },
      s,
      { width: state.columns - 3 },
    );
  /** One entry of the log as the lines this window shows for it. */
  function drawn(entry) {
    if (entry.kind === 'header') return [{ ...entry, block: renderBlock(entry.block, s, { width: state.columns - 1 }) }];
    if (entry.kind === 'tool') return [{ kind: 'tool', view: toolView(entry.call, entry.result, { full: state.full }), failed: entry.result.isError }];
    if (entry.kind !== 'reply') return [entry];
    const lines = [];
    state.fresh = true;
    const reply = replyTo((item) => lines.push(item));
    reply.write(entry.raw);
    reply.flush();
    return lines;
  }
  const record = (entry) => {
    state.log.push(entry);
    show(drawn(entry));
  };
  if (state.log.length === 0) {
    state.log.push(header(block));
    place(drawn(state.log[0]));
  }

  /** The reply so far is whole: its last line is drawn, it joins the log, and the next text starts a new block. */
  const closeReply = () => {
    state.reply?.flush();
    if (state.raw) state.log.push({ kind: 'reply', raw: state.raw });
    state.raw = '';
    state.fresh = true;
  };

  /** Everything again, from the log: after the window changed width, or the view changed between short and full. */
  const refresh = () => {
    state.items = [];
    for (const entry of state.log) place(drawn(entry));
    state.fresh = true;
    if (state.working) {
      state.reply = replyTo((item) => show([item]));
      state.reply.write(state.raw);
    }
    state.epoch++;
    write(CLEAR);
    redraw();
  };

  /** The way out. A turn in hand is stopped first and the screen closes when it has let go; nothing queued behind it is sent. */
  const leave = () => {
    state.gone = true;
    state.queue = [];
    if (state.working) session.interrupt();
    else exit();
  };

  /** One thing the user sent, start to finish; whatever goes wrong inside is shown, never thrown at the terminal. */
  async function turn(line) {
    try {
      if (line.startsWith('!')) {
        record({ kind: 'user', text: line });
        state.working = pickMessage(messages);
        redraw();
        return record({ kind: 'note', text: (await session.shell(line.slice(1).trim())) || '(no output)' });
      }
      const { text, control, error } = session.expand(line);
      if (error) return record({ kind: 'error', text: error });
      if (control === 'quit') return leave();
      if (control === 'new') {
        session.end();
        return record(header(session.start('new')));
      }
      record({ kind: 'user', text: line });
      state.working = pickMessage(messages);
      state.tokens = 0;
      state.fresh = true;
      state.reply = replyTo((item) => show([item]));
      redraw();
      const outcome = await session.say(text);
      closeReply();
      if (outcome.stop === 'interrupted') record({ kind: 'note', text: 'Interrupted' });
      if (outcome.stop === 'error') record({ kind: 'error', text: `error: ${outcome.error}` });
    } catch (cause) {
      closeReply();
      record({ kind: 'error', text: `error: ${cause.message}` });
    } finally {
      state.running = null;
      state.working = null;
      redraw();
      if (state.gone) exit();
    }
  }

  /** What was typed: now if nothing is running, after the turn in hand if something is. */
  async function submit(line) {
    if (state.working) {
      state.queue.push(line);
      return redraw();
    }
    await turn(line);
    while (state.queue.length > 0 && !state.working && !state.gone) {
      const next = state.queue.shift();
      redraw();
      await turn(next);
    }
  }

  useEffect(() => {
    const onText = (chunk) => {
      state.raw += chunk;
      state.reply?.write(chunk);
      redraw();
    };
    const onTool = ({ call }) => {
      closeReply();
      state.running = call;
      redraw();
    };
    const onResult = ({ call, result }) => {
      state.running = null;
      record({ kind: 'tool', call, result });
    };
    const onUsage = ({ totals }) => {
      state.tokens = totals.outputTokens;
      redraw();
    };
    events.on('text', onText).on('tool', onTool).on('result', onResult).on('usage', onUsage);
    return () => {
      events.off('text', onText).off('tool', onTool).off('result', onResult).off('usage', onUsage);
      clearTimeout(state.leaving);
    };
  }, []);

  // A window dragged to a new width: once it has stopped moving, everything is drawn again to fit it.
  const sized = useRef(columns);
  useEffect(() => {
    if (sized.current === columns) return undefined;
    const settle = setTimeout(() => {
      sized.current = columns;
      refresh();
    }, RESIZE_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [columns]);

  useInput((input, key) => {
    for (const [one, oneKey] of keysOf(input, key)) {
      if (oneKey.escape || (oneKey.ctrl && one === 'c')) {
        if (state.working) session.interrupt();
        else if (oneKey.escape) continue;
        else if (state.ed.text) state.ed = editor(state.ed.history);
        else if (state.leaving) leave();
        else {
          state.leaving = setTimeout(() => {
            state.leaving = null;
            redraw();
          }, LEAVE_WINDOW_MS);
        }
        continue;
      }
      if (oneKey.ctrl && one === 'd' && !state.ed.text) {
        leave();
        continue;
      }
      if (oneKey.ctrl && one === 'o') {
        state.full = !state.full;
        refresh();
        continue;
      }
      const pressed = press(state.ed, one, oneKey, COMMAND_LIST);
      state.ed = pressed.state;
      if (pressed.submit !== undefined) submit(pressed.submit);
    }
    redraw();
  });
  usePaste((text) => {
    state.ed = paste(state.ed, text);
    redraw();
  });

  const menu = menuOf(state.ed, COMMAND_LIST);
  const tail = state.reply?.tail ?? '';
  return h(
    Box,
    { flexDirection: 'column' },
    h(Static, { key: state.epoch, items: state.items }, (item) => h(Item, { key: item.id, item })),
    tail ? h(Reply, { text: tail, first: state.fresh }) : null,
    state.running ? h(Tool, { view: toolView(state.running), running: true }) : null,
    state.working ? h(Working, { message: state.working, tokens: state.tokens }) : null,
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      ...state.queue.map((line, i) => h(Text, { key: i, dimColor: true }, `  queued: ${line}`)),
      h(Input, { state: state.ed, width: columns }),
      menu.length > 0 ? h(Menu, { menu, pick: state.ed.pick }) : h(Status, { session, leaving: Boolean(state.leaving), full: state.full }),
    ),
  );
}

/** Starts the session and draws it. The returned instance's `waitUntilExit()` settles when the user leaves. */
export function runUi({ session, events, stdin = process.stdin, stdout = process.stdout, messages = spinnerMessages(), cwd = process.cwd(), debug = false }) {
  const block = session.start('startup');
  return render(h(App, { session, events, messages, cwd, block }), { stdin, stdout, debug, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } });
}
