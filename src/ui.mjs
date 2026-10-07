import { Box, render, renderToString, Static, Text, useAnimation, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement as h, useEffect, useReducer, useRef } from 'react';
import { routeLine, routeOf } from './chat.mjs';
import { stopReason } from './loop.mjs';
import { compactInput } from './mcp.mjs';
import { paths } from './paths.mjs';
import { editor, keysOf, menuOf, paste, press, under } from './editor.mjs';
import { clipboardImage, droppedImages } from './images.mjs';
import { colourEnabled, createRenderer, flow, logoLines, messageAt, pickMessage, renderBlock, spinnerMessages, styles, sunset, tilde, toolView, untab } from './tty.mjs';

/**
 * The chat on a real terminal. What is finished scrolls away above — what
 * was typed, each line of a reply, each tool call with the top of its result;
 * of the memory block, which is the model's, only a warning — and what is live
 * stays at the bottom: the line being
 * written, the command running, the working line, the box to type in. Typing
 * never waits for the model: a message sent mid-turn is queued, Esc stops the
 * turn. A job run in the chat is shown the same way, set in under a line that
 * says who it is — each call on one line, its output behind Ctrl-O — and a
 * line starting with @ is said to it. An image pasted with Ctrl-V, or a file
 * dropped on the box, stands in it as `[Image #n]` and goes with the message
 * that names it. The chat opens on its name in blocks, in a sunset; while the
 * conversation is short the box stands at the foot of the window, the logo faint
 * behind the room above it. All of it is drawing; the session in chat.mjs does the work.
 */

const ACCENT = '#d77757';
/** The name at the top of the chat, two rows of blocks. */
const WORDMARK = ['█▀▀ █ █ █▀▄▀█ █▀█', '▄▄█ █▄█ █ ▀ █ █▄█'];
const FLOW_STEP_MS = 100;
const TONES = { plain: {}, dim: { dimColor: true }, error: { color: 'red' }, add: { color: 'green' }, del: { color: 'red' }, ask: { color: 'yellow' } };
const LEAVE_WINDOW_MS = 2000;
const NOTICE_MS = 3000;
const RESIZE_SETTLE_MS = 120;
/** Wipes the window and what has scrolled off it, before everything is drawn again. */
const CLEAR = '\x1b[2J\x1b[3J\x1b[H';

/** What Up recalls across sessions: the last lines typed, one a line, in the home. */
const HISTORY_KEPT = 50;
const historyFile = () => join(paths().home, 'history');
function readHistory() {
  try {
    return readFileSync(historyFile(), 'utf8').split('\n').filter(Boolean).slice(-HISTORY_KEPT);
  } catch {
    return [];
  }
}
/**
 * A line typed joins the file; a line that repeats the last is not written twice; the file never holds more than the kept count.
 * It is what the user typed, so it is for its owner only — and it is a convenience: a file that cannot be written costs the recall, never the turn.
 */
function keepHistory(line) {
  const one = line.replace(/\n/g, ' ');
  const lines = readHistory();
  if (lines.at(-1) === one) return;
  lines.push(one);
  try {
    mkdirSync(paths().home, { recursive: true, mode: 0o700 });
    writeFileSync(historyFile(), `${lines.slice(-HISTORY_KEPT).join('\n')}\n`, { mode: 0o600 });
  } catch {
    // Nowhere to keep it: the line is still sent.
  }
}

const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/** A tool call: what ran, and under it what came back — or, while it runs, the jobs it started, or that it is running. */
function Tool({ view, failed = false, running = false, jobs = [] }) {
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, null, h(Text, { color: running ? undefined : failed ? 'red' : 'green', dimColor: running }, '⏺ '), h(Text, { bold: true }, view.title), `(${view.detail})`),
    running && jobs.length === 0 ? h(Text, { dimColor: true }, '  ⎿  Running…') : null,
    ...jobs.map(([id, job]) => h(JobAtWork, { key: id, id, job })),
    ...view.lines.map((line, i) => h(Text, { key: i, ...TONES[line.tone] }, `${i === 0 ? '  ⎿  ' : '     '}${untab(line.text)}`)),
  );
}

/** How long something has run: `42s`, `3m 05s`. */
const elapsed = (ms) => {
  const seconds = Math.floor(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, '0')}s`;
};

/** A job at work, in one line under the call that started it: how long, how many calls, and the one running now — or that it is thinking. */
function JobAtWork({ id, job }) {
  useAnimation({ interval: 1000 });
  const now = job.call ? toolView(job.call) : null;
  const calls = `${job.calls} tool call${job.calls === 1 ? '' : 's'}`;
  return h(Text, { wrap: 'truncate' }, h(Text, { dimColor: true }, `  ⎿  j${id} · ${elapsed(Date.now() - job.since)} · ${calls} · `), now ? `${now.title}(${now.detail})` : h(Text, { dimColor: true }, 'thinking…'));
}

/** A call waiting on the user's word: who asks, what would run with what, and the keys that answer. */
function Ask({ ask }) {
  const who = ask.job ? `j${ask.job}: ` : '';
  return h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, { color: 'yellow' }, `⚠ ${who}allow ${ask.server} · ${ask.tool}(${compactInput(ask.input)})?`), h(Text, { dimColor: true }, '  y once · a always · n no · esc stop'));
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
        { gap: 3, marginTop: 1 },
        // The sunset runs across the name, gold at the S to crimson at the O.
        h(Box, { flexDirection: 'column', flexShrink: 0 }, ...WORDMARK.map((row, r) => h(Text, { key: r }, ...[...row].map((ch, i) => h(Text, { key: i, color: sunset(i / (row.length - 1)) }, ch))))),
        h(Box, { flexDirection: 'column' }, h(Text, null, item.route), h(Text, { dimColor: true }, item.cwd)),
      ),
      item.block ? h(Box, { marginTop: 1 }, h(Text, null, item.block)) : null,
    );
  }
  if (item.kind === 'user') return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, '> '), h(Text, { dimColor: true }, untab(item.text)));
  if (item.kind === 'text') return h(Reply, item);
  if (item.kind === 'tool') return h(Tool, item);
  // The mark stands apart from the words, so a line that wraps in a narrow window goes on under them, not under it.
  if (item.kind === 'job') return h(Box, { marginTop: 1 }, h(Text, { color: ACCENT }, '⏺ '), h(Text, null, h(Text, { bold: true }, `j${item.id}`), ` ${item.agent} · ${item.route} — ${item.title}`, h(Text, { dimColor: true }, ` · ${item.where}`)));
  if (item.kind === 'error') return h(Box, { marginTop: 1 }, h(Text, { color: 'red' }, item.text));
  return h(Text, { dimColor: true }, `  ⎿  ${item.text.split('\n').join('\n     ')}`);
}

/** The line that says it is working: your words, the next of them every few seconds, a sunset flowing through them; how long, how much, and how to stop it. */
function Working({ messages, first, tokens }) {
  const { frame, time } = useAnimation({ interval: FLOW_STEP_MS });
  const words = `${messageAt(messages, first, time)}…`;
  const spent = tokens > 0 ? ` · ↓ ${thousands(tokens)} tokens` : '';
  return h(
    Box,
    { marginTop: 1 },
    h(Text, null, ...[...words].map((ch, i) => h(Text, { key: i, color: flow(i, frame) }, ch)), ' '),
    h(Text, { dimColor: true }, `(${Math.floor(time / 1000)}s${spent} · esc to interrupt)`),
  );
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
    h(Box, { flexGrow: 1, flexShrink: 1 }, h(Text, null, untab(text.slice(0, cursor)), h(Text, { inverse: true }, untab(shown)), untab(after))),
  );
}

function Menu({ menu, pick }) {
  const wide = Math.max(...menu.map((c) => c.label.length)) + 2;
  return h(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    ...menu.map((c, i) => h(Text, { key: c.name, color: i === pick ? ACCENT : undefined, dimColor: i !== pick }, c.label.padEnd(wide), c.hint)),
  );
}

function Status({ session, leaving, notice, full, jobs }) {
  const size = session.contextTokens >= 1000 ? ` · ${Math.round(session.contextTokens / 1000)}k context` : '';
  const hint = leaving ? 'Ctrl-C again to leave' : notice ? notice : jobs.length > 0 ? `${jobs.length === 1 ? `@ message talks to j${jobs[0]}` : '@j<id> message talks to that job'} · ctrl-o ${full ? 'to fold' : 'full output'}` : full ? 'full output · ctrl-o to fold' : '/ commands · ! shell · \\⏎ new line · ctrl-v image · ctrl-o full output';
  // In a narrow window the hints give way; the model and the size of the context never fold.
  return h(
    Box,
    { paddingX: 2, justifyContent: 'space-between', gap: 2 },
    h(Box, { flexShrink: 0 }, h(Text, { dimColor: true }, `${routeLine(session)}${size}`)),
    h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, hint)),
  );
}

/**
 * The room between the conversation and the box, with the logo behind it: faint, in the middle of the window, where it stays while
 * the conversation grows over it — what reaches it covers it. `from` is the row of the window the live part of the screen starts on.
 */
function Room({ logo, rows, from }) {
  const ref = useRef(null);
  const { width, height, top, hasMeasured } = useBoxMetrics(ref);
  const wide = Math.max(0, ...logo.map((row) => row.length));
  const at = Math.floor((rows - logo.length) / 2) - from - top;
  const seen = logo.length > 0 && hasMeasured && width >= wide && at < height && at + logo.length > 0;
  return h(
    Box,
    { ref, flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
    seen ? h(Box, { position: 'absolute', top: at, left: Math.floor((width - wide) / 2), flexDirection: 'column' }, ...logo.map((row, i) => h(Text, { key: i, color: 'gray', dimColor: true }, row || ' '))) : null,
  );
}

function App({ session, events, messages, cwd, block, opening, logo, clipboard }) {
  const { exit } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const [, redraw] = useReducer((n) => n + 1, 0);
  const s = styles(colourEnabled(stdout));
  const header = (text) => ({ kind: 'header', route: routeLine(session), cwd: tilde(cwd), block: text });
  // What the screen holds between draws. Keys and the session's events both write here, in the order they happen, and then ask for a draw.
  // `log` is what happened, as it was said; `items` is the log drawn for this window, and is drawn again when the window or the view changes.
  const st = useRef(null);
  st.current ??= { log: [], items: [], unmeasured: [], used: 0, next: 0, epoch: 0, full: false, raw: '', ed: editor(readHistory()), images: [], notice: null, queue: [], working: null, tokens: 0, running: new Map(), jobs: new Map(), asks: [], reply: null, fresh: true, leaving: null, gone: false };
  const state = st.current;
  state.columns = columns;
  state.rows = rows;

  const place = (items) => {
    const placed = items.map((item) => ({ id: state.next++, ...item }));
    state.items = [...state.items, ...placed];
    state.unmeasured.push(...placed);
  };
  /**
   * The rows what is finished takes on the screen since it was last cleared, counted until it fills the window: the room under it is
   * the box's to stand at the foot of. Measured before the next draw, never during one — a frame too tall would scroll the top away.
   */
  const measure = () => {
    for (const item of state.unmeasured.splice(0)) {
      if (state.used < state.rows) state.used += renderToString(h(Item, { item }), { columns: state.columns }).split('\n').length;
    }
  };
  const show = (items) => {
    place(items);
    measure();
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
    if (entry.kind === 'header') {
      // The memory block is the model's; what is wrong in it is the user's to see.
      const warnings = entry.block.split('\n').filter((line) => line.startsWith('Warning')).join('\n');
      return [{ ...entry, block: warnings && renderBlock(warnings, s, { width: state.columns - 1 }) }];
    }
    if (entry.kind === 'tool') {
      return [{ kind: 'tool', view: toolView(entry.call, entry.result, { full: state.full }), failed: entry.result.isError }];
    }
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
    // A chat opened on a saved session says which, under the header, where a fresh one shows the block's warnings.
    if (opening) state.log.push({ kind: 'note', text: opening });
    for (const entry of state.log) place(drawn(entry));
  }

  /** The reply so far is whole: its last line is drawn, it joins the log, and the next text starts a new block. */
  const closeReply = () => {
    state.reply?.flush();
    if (state.raw) state.log.push({ kind: 'reply', raw: state.raw });
    state.raw = '';
    state.fresh = true;
  };

  /** Everything again, from the log: after the window changed size, or the view changed between short and full. */
  const refresh = () => {
    state.items = [];
    state.unmeasured = [];
    state.used = 0;
    for (const entry of state.log) place(drawn(entry));
    measure();
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

  /** The user's answer to a call waiting on it; one answered already — by Esc, say — is left alone. */
  const settle = (ask, answer) => {
    if (!state.asks.includes(ask)) return;
    state.asks = state.asks.filter((a) => a !== ask);
    ask.resolve(answer);
    redraw();
  };

  /** Said under the box for a moment, in place of the hints: why a key did nothing. */
  const notify = (text) => {
    clearTimeout(state.notice?.timer);
    state.notice = {
      text,
      timer: setTimeout(() => {
        state.notice = null;
        redraw();
      }, NOTICE_MS),
    };
    redraw();
  };

  /** A picture for the message being written: kept by its number, a marker for it where the cursor is. */
  const attach = (image) => {
    state.images.push(image);
    state.ed = paste(state.ed, `[Image #${state.images.length}] `);
  };

  /** The pictures a line names, each once, in the order it names them; a marker deleted from the box took its picture with it. */
  const picturesIn = (line) =>
    [...new Set([...line.matchAll(/\[Image #(\d+)\]/g)].map((m) => Number(m[1])))]
      .filter((n) => state.images[n - 1])
      .map((n) => ({ label: `[Image #${n}]`, ...state.images[n - 1] }));

  /** One thing the user sent, start to finish; whatever goes wrong inside is shown, never thrown at the terminal. */
  async function turn(line, images) {
    try {
      if (line.startsWith('!')) {
        record({ kind: 'user', text: line });
        state.working = pickMessage(messages);
        redraw();
        return record({ kind: 'note', text: (await session.shell(line.slice(1).trim())) || '(no output)' });
      }
      const { text, said, control, args, error } = session.expand(line);
      if (error) return record({ kind: 'error', text: error });
      if (control === 'quit') return leave();
      if (control === 'new') {
        session.end();
        state.log = [];
        // The old session's pictures go with it; their numbers stay taken, so a marker recalled from before names nothing.
        state.images = state.images.map(() => null);
        const block = session.start('new');
        refresh();
        return record(header(block));
      }
      if (control === 'resume') {
        record({ kind: 'user', text: line });
        if (!args) {
          const saved = session.saved();
          return record({ kind: 'note', text: saved.length > 0 ? saved.join('\n') : 'no saved sessions' });
        }
        // Refused — no such session, or one open elsewhere — nothing changes, and the refusal is shown below like any other error.
        const said = session.resume(args);
        state.log = [];
        state.images = state.images.map(() => null);
        refresh();
        record(header(''));
        return record({ kind: 'note', text: said });
      }
      if (control === 'model' || control === 'memory' || control === 'mcp') {
        record({ kind: 'user', text: line });
        const text = control === 'model' ? session.route(args) : control === 'mcp' ? (await session.mcp()).join('\n') : await session.memoryPage();
        return record({ kind: 'note', text });
      }
      record({ kind: 'user', text: line });
      state.working = pickMessage(messages);
      state.tokens = 0;
      state.fresh = true;
      state.reply = replyTo((item) => show([item]));
      redraw();
      const outcome = await session.say(text, said, images);
      closeReply();
      if (outcome.stop === 'interrupted') record({ kind: 'note', text: 'Interrupted' });
      if (outcome.stop === 'error') record({ kind: 'error', text: `error: ${outcome.error}` });
      if (stopReason(outcome.stop)) record({ kind: 'note', text: stopReason(outcome.stop) });
    } catch (cause) {
      closeReply();
      record({ kind: 'error', text: `error: ${cause.message}` });
    } finally {
      // A question the turn left standing has no call behind it any more.
      for (const ask of state.asks.splice(0)) ask.resolve('no');
      state.running.clear();
      state.jobs.clear();
      state.working = null;
      redraw();
      if (state.gone) exit();
    }
  }

  /** What was typed: now if nothing is running, after the turn in hand if something is. */
  async function submit(line) {
    keepHistory(line);
    // For a job, not for the chat: `@j31 …` reaches that job wherever it runs, a bare `@…` the one running here.
    // A job that cannot be told anything — closed by now, or never there — is said back, whichever way it was named.
    const named = /^@j?(\d+)\s+(\S[\s\S]*)$/.exec(line);
    const said = named ? named[2].trim() : state.jobs.size > 0 && line.startsWith('@') ? line.slice(1).trim() : '';
    if (said) {
      // A job is told words only; a picture would be dropped without a word.
      if (picturesIn(said).length > 0) return record({ kind: 'error', text: 'a job is told words only — send the picture to the chat, without the @' });
      try {
        const told = named ? session.tell(said, Number(named[1])) : session.tell(said);
        if (told) return record({ kind: 'user', text: `@j${told} ${said}` });
      } catch (cause) {
        return record({ kind: 'error', text: cause.message });
      }
    }
    const images = picturesIn(line);
    if (state.working) {
      state.queue.push({ line, images });
      return redraw();
    }
    await turn(line, images);
    while (state.queue.length > 0 && !state.working && !state.gone) {
      const next = state.queue.shift();
      redraw();
      await turn(next.line, next.images);
    }
  }

  useEffect(() => {
    const onText = (chunk) => {
      state.raw += chunk;
      state.reply?.write(chunk);
      redraw();
    };
    const onTool = ({ call, job }) => {
      const at = state.jobs.get(job);
      if (at) Object.assign(at, { call, calls: at.calls + 1 });
      else if (!job) {
        closeReply();
        state.running.set(call.id, call);
      }
      redraw();
    };
    // A job's work is not the chat's: it shows one line while it works, its report when it ends, and the rest where it is watched.
    const onResult = ({ call, result, job }) => {
      if (job) {
        if (state.jobs.has(job)) state.jobs.get(job).call = null;
        return redraw();
      }
      // Delegated jobs run side by side: one ending leaves the others' calls on the screen.
      state.running.delete(call.id);
      record({ kind: 'tool', call, result });
    };
    const onJob = ({ job, call = null, tab = null }) => {
      state.jobs.set(job.id, { parent: call, call: null, calls: 0, since: Date.now() });
      const where = tab?.pane ? 'working in its Herdr tab' : tab?.error ? `no Herdr tab (${tab.error}) — sumo job watch ${job.id}` : `follow it: sumo job watch ${job.id}`;
      record({ kind: 'job', id: job.id, agent: job.agent, title: job.title, route: routeOf(job), where });
    };
    // The tab said to show the job stayed empty: why, and how to follow it all the same.
    const onTabFailed = ({ job, reason }) => record({ kind: 'error', text: `j${job}: ${reason} — follow it here: sumo job watch ${job}` });
    const onJobEnd = ({ job }) => {
      state.jobs.delete(job);
      redraw();
    };
    const onUsage = ({ totals }) => {
      state.tokens = totals.outputTokens;
      redraw();
    };
    // A call waiting on the user's word: shown under the work until a key answers it; Esc stops the turn, which declines it.
    const onApprove = (ask) => {
      state.asks.push(ask);
      ask.signal?.addEventListener('abort', () => settle(ask, 'no'), { once: true });
      redraw();
    };
    // An MCP server that is not there is the user's to see; the model is simply not offered its tools.
    const onMcp = ({ servers, error }) => {
      if (error) record({ kind: 'error', text: `mcp: ${error}` });
      for (const server of servers.filter((s) => !s.ok)) record({ kind: 'error', text: `mcp ${server.name}: ${server.error} — sumo mcp shows every server` });
    };
    events.on('text', onText).on('tool', onTool).on('result', onResult).on('usage', onUsage).on('job', onJob).on('tab-failed', onTabFailed).on('job-end', onJobEnd).on('approve', onApprove).on('mcp', onMcp);
    return () => {
      events.off('text', onText).off('tool', onTool).off('result', onResult).off('usage', onUsage).off('job', onJob).off('tab-failed', onTabFailed).off('job-end', onJobEnd).off('approve', onApprove).off('mcp', onMcp);
      clearTimeout(state.leaving);
      clearTimeout(state.notice?.timer);
    };
  }, []);

  // The opening header was placed while the first frame was drawn; it is measured once that frame is down — and outside React, which an effect is not.
  useEffect(() => {
    const later = setTimeout(() => {
      measure();
      redraw();
    });
    return () => clearTimeout(later);
  }, []);

  // A window dragged to a new size: once it has stopped moving, everything is drawn again to fit it.
  const sized = useRef(`${columns}x${rows}`);
  useEffect(() => {
    if (sized.current === `${columns}x${rows}`) return undefined;
    const settle = setTimeout(() => {
      sized.current = `${columns}x${rows}`;
      refresh();
    }, RESIZE_SETTLE_MS);
    return () => clearTimeout(settle);
  }, [columns, rows]);

  useInput((input, key) => {
    // The terminal's answer to Ink's keyboard-protocol query, when it comes after Ink stopped waiting for it.
    if (/^\[\?\d+u$/.test(input)) return;
    for (const [one, oneKey] of keysOf(input, key)) {
      // A question standing takes the key: an answer, or Esc and Ctrl-C, which go on to stop the turn; nothing lands in the box.
      if (state.asks.length > 0 && !oneKey.escape && !(oneKey.ctrl && (one === 'c' || one === 'd'))) {
        const answer = { y: 'once', a: 'always', n: 'no' }[one];
        if (answer) settle(state.asks[0], answer);
        else notify('y allows it once · a always · n refuses it · esc stops the turn');
        continue;
      }
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
      // Cmd-V pastes only text from a terminal; an image on the clipboard is fetched here.
      if (oneKey.ctrl && one === 'v') {
        clipboard()
          .then((image) => {
            if (!image) return notify('no image on the clipboard');
            attach(image);
            redraw();
          })
          .catch((cause) => notify(cause.message));
        continue;
      }
      const pressed = press(state.ed, one, oneKey, session.commands);
      state.ed = pressed.state;
      if (pressed.submit !== undefined) submit(pressed.submit);
    }
    redraw();
  });
  // A file dropped on the terminal arrives pasted as its path: an image's path becomes the image.
  usePaste((text) => {
    let images;
    try {
      images = droppedImages(text);
    } catch (cause) {
      return notify(cause.message);
    }
    if (images) for (const image of images) attach(image);
    else state.ed = paste(state.ed, text);
    redraw();
  });

  const menu = menuOf(state.ed, session.commands);
  const tail = state.reply?.tail ?? '';
  // Ink adds a line under the frame; a frame that reached the last row would be drawn as a full screen.
  const room = state.unmeasured.length > 0 ? 0 : Math.max(0, rows - state.used - 1);
  return h(
    Box,
    { flexDirection: 'column', minHeight: room },
    h(Static, { key: state.epoch, items: state.items }, (item) => h(Item, { key: item.id, item })),
    tail ? h(Reply, { text: tail, first: state.fresh }) : null,
    // What runs now, and under a delegate call the jobs it started. In one box of their own, so the lines coming and going
    // never move what follows — the working line keeps its clock.
    h(
      Box,
      { flexDirection: 'column' },
      ...[...state.running.values()].map((call) => h(Tool, { key: call.id, view: toolView(call), running: true, jobs: [...state.jobs].filter(([, job]) => job.parent === call.id) })),
      // A job no call here started — none should be — still shows that it works.
      ...[...state.jobs].filter(([, job]) => !state.running.has(job.parent)).map(([id, job]) => h(JobAtWork, { key: `j${id}`, id, job })),
    ),
    state.working ? h(Working, { messages, first: state.working, tokens: state.tokens }) : null,
    state.asks.length > 0 ? h(Ask, { ask: state.asks[0] }) : null,
    h(Room, { logo, rows, from: state.used }),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      ...state.queue.map(({ line }, i) => h(Text, { key: i, dimColor: true }, `  queued: ${line}`)),
      h(Input, { state: state.ed, width: columns }),
      menu.length > 0 ? h(Menu, { menu, pick: state.ed.pick }) : h(Status, { session, leaving: Boolean(state.leaving), notice: state.notice?.text, full: state.full, jobs: [...state.jobs.keys()] }),
    ),
  );
}

/** Starts the session and draws it. The returned instance's `waitUntilExit()` settles when the user leaves. */
export function runUi({ session, events, resume = null, stdin = process.stdin, stdout = process.stdout, messages = spinnerMessages(), cwd = process.cwd(), logo = logoLines(), clipboard = clipboardImage, debug = false }) {
  // Opened on a saved session (`sumo chat --resume`), the chat picks it up before the screen is drawn; a fresh one starts and is shown its block.
  const opening = resume === null ? null : session.resume(resume);
  const block = opening ? '' : session.start('startup');
  // Ink asks the terminal whether it speaks the kitty keyboard protocol before the screen turns raw mode on. In cooked
  // mode the terminal's answer is echoed and held back until a newline — and lands in the box as `[?0u`. Raw mode first.
  if (stdin.isTTY) stdin.setRawMode(true);
  // The chat starts at the top of a wiped window, not under the shell line that started it: the room and the box are placed from its top.
  if (stdout.isTTY) stdout.write(CLEAR);
  return render(h(App, { session, events, messages, cwd, block, opening, logo, clipboard }), { stdin, stdout, debug, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } });
}
