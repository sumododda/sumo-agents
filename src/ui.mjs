import { Box, render, renderToString, Static, Text, useAnimation, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { execFile, spawn } from 'node:child_process';
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createElement as h, useEffect, useReducer, useRef } from 'react';
import { compactLine, contextReport, retryLine, routeLine, routeOf } from './chat.mjs';
import { contextBand } from './sessions.mjs';
import { liveFile } from './jobs.mjs';
import { stopReason } from './loop.mjs';
import { compactInput, INPUT_SHOWN } from './mcp.mjs';
import { paths } from './paths.mjs';
import { redact } from './redact.mjs';
import { elapsed } from './text.mjs';
import { cleanPaste, editor, keysOf, matchFiles, menuOf, paste, press, under } from './editor.mjs';
import { clipboardImage, copyText, droppedImages } from './images.mjs';
import { BASH_TOOL, DELEGATE_TOOL, EDITOR_TOOL } from './tools.mjs';
import { colourEnabled, createRenderer, explained, flow, fold, linked, logoLines, markdownOf, messageAt, pathFrom, pickMessage, renderBlock, safeForTerminal, spinnerMessages, styles, sunset, tilde, toolView, transcript, untab, VERSION, withoutColourCodes, wrap } from './tty.mjs';

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
 * conversation is short the box stands at the foot of the window, and until the
 * first message is sent the logo stands faint in the room above it. A command
 * shows what it prints while it runs; a message sent while the model works is
 * read with its next request; a turn ends on a line that says how long it took,
 * what it changed and what it cost, and — when the window is not the one in
 * front — on a bell. A job delegated in the background does not hold the turn:
 * it stands under the box while it works, the chat goes on, and when it reports
 * the screen starts the turn that reads the report. Down steps onto a job there
 * and Enter opens it: the end of its record above the box, until Esc. All of it
 * is drawing; the session in chat.mjs does the work.
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
/**
 * The window scrolled clear: what it showed goes up into the terminal's scrollback, where it can still be read, and
 * the drawing starts at the top. For a chat that opens, or starts over — nothing that was on the terminal is lost to it.
 */
const scrolledClear = (rows) => `\x1b[${rows};1H${'\n'.repeat(rows)}\x1b[H`;
/** The terminal says when its window comes to the front and goes behind (`[I`, `[O`); and keeps its title, to be given back. */
const FOCUS_ON = '\x1b[?1004h';
const FOCUS_OFF = '\x1b[?1004l';
const TITLE_KEEP = '\x1b[22;0t';
const TITLE_BACK = '\x1b[23;0t';
/**
 * The terminal's second screen, for a program handed the terminal: whatever it prints is gone with it, and the chat is as
 * it was. The cursor is not moved here: a terminal with no second screen would take that for a move on this one.
 */
const SCREEN_ASIDE = '\x1b[?1049h';
const SCREEN_BACK = '\x1b[?1049l';
/**
 * The tab's own progress mark (OSC 9;4): busy while the chat works, gone when it is done. Only where the terminal is known to
 * draw it — elsewhere the same sequence is a notification, or text.
 */
const PROGRESS_BUSY = '\x1b]9;4;3;0\x07';
const PROGRESS_DONE = '\x1b]9;4;0;0\x07';
export function showsProgress(env = process.env) {
  if (env.TMUX || env.STY) return false;
  if (env.WT_SESSION || env.ConEmuANSI === 'ON' || env.TERM_PROGRAM === 'ghostty') return true;
  if (env.TERM_PROGRAM === 'iTerm.app') {
    const [major, minor] = String(env.TERM_PROGRAM_VERSION ?? '').split('.').map(Number);
    return major > 3 || (major === 3 && minor >= 6);
  }
  return false;
}

/** How long Ctrl-Z waits to be stopped before it takes it that nothing will stop it. */
const SUSPEND_CHECK_MS = 300;

/** Longer than Ink waits for the terminal to say how its keyboard speaks (200 ms): see `runUi`. */
const KITTY_WAIT_MS = 300;
/** A turn at least this long ends on a bell when the window is not in front, and on its footer whatever it did. */
const NOTIFY_AFTER_MS = 10_000;
/** No word from the model for this long, with nothing running, is said on the working line. */
const QUIET_AFTER_MS = 20_000;
/** Of what a running command prints, the last lines are shown; this much of it is kept to find them in. */
const LIVE_LINES = 3;
const LIVE_KEPT_CHARS = 4000;
const LIVE_DRAW_MS = 100;
/** The most rows of the box, and of a message once sent, that are drawn: a long paste must not push the screen past the window. */
const INPUT_ROWS = 10;
const ECHO_LINES = 10;
/** A paste longer than this stands in the box as a marker — `[Pasted text #1 +120 lines]` — and goes whole with the message. */
const PASTE_LINES = 12;
const PASTE_CHARS = 2000;
/** How long the list of a project's files is good for, while a file is being named with `@`. */
const FILES_FRESH_MS = 15_000;
/** How many of a resumed session's turns are drawn again: enough to see where it stopped. */
const REPLAY_TURNS = 5;

/**
 * A program given the terminal — an editor, a pager — until it exits. The program is the user's own setting, so a shell
 * reads it: `code -w`, `less -R`. It is given the terminal opened afresh, not this process's own three descriptors: a
 * child that inherits those has them set to block, for this process too, and the first read after it has gone would
 * hold everything here until a key was pressed.
 */
const inTerminal = (program, file) =>
  new Promise((resolve, reject) => {
    let own = null;
    try {
      own = openSync('/dev/tty', 'r+');
    } catch {
      // No terminal to open by name: the program has this process's, as it would from a shell.
    }
    const done = (settle) => (value) => {
      if (own !== null) closeSync(own);
      own = null;
      settle(value);
    };
    const child = spawn('sh', ['-c', `${program} "$0"`, file], { stdio: own === null ? 'inherit' : [own, own, own] });
    child.on('error', done(reject));
    child.on('close', done(resolve));
  });

/** The files of the project at `cwd` as git knows them, the untracked ones it does not ignore included; none where there is no repository. */
const gitFiles = (cwd) =>
  new Promise((resolve) => {
    execFile('git', ['ls-files', '-co', '--exclude-standard'], { cwd, maxBuffer: 32 * 1024 * 1024 }, (error, out) => resolve(error ? [] : out.split('\n').filter(Boolean)));
  });

/**
 * A saved conversation as the entries the screen draws, for a session picked up again: the last `turns` things the user
 * said, each with what was answered and done after it. The memory block, the operator's words and a job's report are the
 * model's to read, not the user's to see again; a message read mid-turn is shown as what was said.
 */
export function replayOf(messages, turns = REPLAY_TURNS) {
  const entries = [];
  const starts = [];
  const calls = new Map();
  for (const message of messages) {
    if (message.role === 'system') continue;
    const blocks = typeof message.content === 'string' ? [{ type: 'text', text: message.content }] : message.content;
    if (message.role === 'assistant') {
      const raw = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('\n').trim();
      if (raw) entries.push({ kind: 'reply', raw });
      for (const b of blocks) if (b.type === 'tool_use') calls.set(b.id, b);
      continue;
    }
    for (const b of blocks) {
      if (b.type === 'tool_result' && calls.has(b.tool_use_id)) {
        const content = typeof b.content === 'string' ? b.content : (b.content ?? []).map((c) => c.text ?? '').join('\n');
        entries.push({ kind: 'tool', call: calls.get(b.tool_use_id), result: { content, isError: Boolean(b.is_error) } });
      } else if (b.type === 'text') {
        const said = /^The user says, while you work: ([\s\S]*)$/.exec(b.text)?.[1].replace(/\n<sumo>[\s\S]*$/, '') ?? b.text;
        if (/^<sumo[->]|^An automated event|^\[Image #\d+\]$/.test(said)) continue;
        starts.push(entries.length);
        entries.push({ kind: 'user', text: said });
      }
    }
  }
  if (starts.length <= turns) return entries;
  const hidden = starts.length - turns;
  return [{ kind: 'note', text: `${hidden} earlier turn${hidden === 1 ? '' : 's'} not drawn again — the model has all of them` }, ...entries.slice(starts.at(-turns))];
}

/**
 * Where `/export` writes: the path given — from the project, or from home with `~` — and into a folder given, a file of its
 * own; with none, the home's exports folder, named by the day and the session.
 */
export function exportPath(given, cwd, sessionId = null) {
  const named = `${new Date().toISOString().slice(0, 10)}-${String(sessionId ?? 'session').slice(0, 8)}.md`;
  if (!given) return join(paths().home, 'exports', named);
  const path = given.replace(/^~(?=$|\/)/, homedir());
  const full = isAbsolute(path) ? path : resolve(cwd, path);
  return existsSync(full) && statSync(full).isDirectory() ? join(full, named) : full;
}

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

/**
 * The lines under a call: what came back, the first of them with the mark. Folded to `columns` here, by the same count the
 * replies are folded by, so a line too long for the window goes on under itself — not under the mark, and not past the edge.
 */
const linesUnder = (lines, columns, s = styles(false)) =>
  lines
    .flatMap((line) => {
      // An address in what came back opens on a click, whole, however the line is folded.
      const text = linked(untab(line.text), s);
      // A numbered line — a diff's, a file's — and an item of a list go on under their own text, not under the number or the bullet.
      const hang = /^\s*(?:\d+(?: [-+ ] | {2,})\s*|[•*-] |\d+[.)] )/.exec(text)?.[0].length ?? 0;
      return fold(text, Math.max(20, columns - 6), ' '.repeat(Math.min(hang, Math.floor((columns - 6) / 2)))).map((row) => ({ ...line, text: row }));
    })
    .map((line, i) => h(Text, { key: i, ...TONES[line.tone], wrap: 'truncate' }, `${i === 0 ? '  ⎿  ' : '     '}${line.text}`));

/**
 * The last lines a running command has printed, as the screen may show them: without secrets or control characters, a
 * progress bar as its latest state. What was kept may begin mid-line — or mid-secret — so its first line is not shown.
 */
function lastLines({ out, cut }) {
  const lines = withoutColourCodes(safeForTerminal(redact(out).text)).split(/\r?\n|\r/);
  return (cut ? lines.slice(1) : lines).map((l) => untab(l).trimEnd()).filter(Boolean).slice(-LIVE_LINES);
}

/** A command that is running: for how long, and the last of what it has printed so far. */
function Running({ live, label = 'Running…' }) {
  // Drawn again more often than the clock it shows turns over, so a second is not skipped by a tick that came just short of it.
  useAnimation({ interval: 250 });
  const ran = live ? Date.now() - live.since : 0;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, `  ⎿  ${label}${ran >= 1000 ? ` ${elapsed(ran)}` : ''}`),
    ...(live ? lastLines(live) : []).map((line, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate' }, `     ${line}`)),
  );
}

/** A tool call: what ran, and under it what came back — or, while it runs, the jobs it started, or what it prints. */
/**
 * What a call ran, as the rows it takes: the tool in bold, what it was given, how much an edit added and took away, how
 * long it ran — folded here, at the spaces, so a row that goes on starts at the margin, not with the space it broke at.
 */
function titleRows(view, took, s, width) {
  const stat = view.stat ? ` ${s.green(`+${view.stat.added}`)} ${s.red(`−${view.stat.removed}`)}` : '';
  const time = took >= TOOK_SHOWN_MS ? s.dim(` · ${elapsed(took)}`) : '';
  return untab(`${s.bold(view.title)}(${view.detail})${stat}${time}`)
    .split('\n')
    .flatMap((line) => wrap(line, width).split('\n'));
}

function Tool({ view, failed = false, running = false, waiting = false, jobs = [], live = null, took = 0, columns, s = styles(false) }) {
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    // The mark stands apart from the words, so a command that wraps, or has lines of its own, goes on under them, not under it.
    h(
      Box,
      null,
      h(Box, { flexShrink: 0 }, h(Text, { color: running ? undefined : failed ? 'red' : 'green', dimColor: running }, '⏺ ')),
      // How long it ran, once that is long enough to have been waited on.
      // A width of its own: a box in a row is never made narrower than its longest word, and a command can be one long word.
      h(Box, { flexShrink: 1, flexDirection: 'column', width: Math.max(10, columns - 2) }, ...titleRows(view, took, s, Math.max(10, columns - 2)).map((row, i) => h(Text, { key: i }, row))),
    ),
    // A question put to the user is not running anything: it waits on them, and says so.
    // A delegation has no job yet while the router picks the model and effort it runs on.
    // So is a call held for the user's word.
    running && (view.title === 'Question' || waiting) ? h(Text, { dimColor: true }, '  ⎿  waiting for your answer') : running && jobs.length === 0 ? h(Running, { live, label: view.title === 'Delegate' ? 'picking the model and effort…' : 'Running…' }) : null,
    ...jobs.map(([id, job]) => h(JobAtWork, { key: id, id, job })),
    ...linesUnder(view.lines, columns, s),
  );
}

/** A call that took at least this long says how long, beside what ran. */
const TOOK_SHOWN_MS = 1000;
/** Thought for less than this, the line that says so would say nothing. */
const THOUGHT_SHOWN_MS = 1000;

/** The rows the screen gives to what the model is thinking. */
const THOUGHT_ROWS = 3;

/**
 * The end of what the model has thought so far, folded to `width`: its last rows, because what it is thinking now is at
 * the end — a summary is one long paragraph, and cut at the window's edge only its first words would ever show.
 */
const thoughtRows = (text, width, rows = THOUGHT_ROWS) =>
  String(text ?? '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .flatMap((line) => wrap(line, width).split('\n'))
    .slice(-rows);

/** Each job in a colour of its own, by its id: its rows under the box, its line in the conversation and its open record agree. */
const JOB_COLOURS = ['cyan', 'magenta', 'blue', 'yellow', 'green'];
const jobColour = (id) => JOB_COLOURS[Number(id) % JOB_COLOURS.length];

/** The most of a job's title its row under the box shows. */
const TITLE_CHARS = 32;

/**
 * A job at work, in one line: how long, how many calls, and that it is working — what it runs and thinks is in its record,
 * a step and Enter away, not here. Under the call that waits for it; or — at work in the background, with no call standing
 * over it — in a row of its own under the box, with who it is, marked when it is the one stepped on (`picked`) or the one
 * whose record is open.
 */
function JobAtWork({ id, job, alone = false, picked = false, open = false }) {
  useAnimation({ interval: 1000 });
  const calls = `${job.calls} tool call${job.calls === 1 ? '' : 's'}`;
  const mark = alone ? (picked ? '  ❯ ' : '  ⏺ ') : '  ⎿  ';
  // Under the call that started it the title is the call's own: the row says who works on it, on what, and where to follow it.
  const who = alone ? ` ${job.agent} — ${job.title.length > TITLE_CHARS ? `${job.title.slice(0, TITLE_CHARS - 1)}…` : job.title}` : ` ${job.agent} · ${job.route}`;
  const lead = `j${id}${who} · ${elapsed(Date.now() - job.since)} · ${calls} · `;
  return h(
    Text,
    { wrap: 'truncate' },
    h(Text, picked || open ? { color: ACCENT } : { color: jobColour(id) }, mark),
    h(Text, { dimColor: !picked }, lead),
    h(Text, { dimColor: true }, 'working'),
    !alone && job.where ? h(Text, { dimColor: true }, ` · ${job.where.replace(/^follow it: /, '')}`) : null,
  );
}

/** The chat itself, as the first of the rows under the box: the place Enter comes back to from a job's record. */
const MAIN = 'main';

/** The chat's own row, over the jobs it delegated: marked when it is the one stepped on (`picked`), or the one on the screen (`shown`). */
function MainAtWork({ working, picked = false, shown = false }) {
  return h(Text, { wrap: 'truncate' }, h(Text, picked || shown ? { color: ACCENT } : { dimColor: true }, picked ? '  ❯ ' : '  ⏺ '), h(Text, { dimColor: !picked }, 'main · '), h(Text, { dimColor: true }, working ? 'working' : 'idle'));
}

/** What a job at work has written down so far, as the screen may show it: its lines, under the one that says who it is. None where there is no record yet. */
function recordLines(id) {
  try {
    return safeForTerminal(readFileSync(liveFile(id), 'utf8')).trimEnd().split('\n').slice(1);
  } catch {
    return [];
  }
}

/** The rows of the window an open job's record may take: the turn's own work, the box and the rows under it need the rest. */
const openRows = (rows) => Math.max(3, Math.min(rows - 24, Math.floor(rows / 2)));

/**
 * A job opened from under the box: who it is, and the end of what it has written down — each call with the top of what
 * came back, and what it said — read again as its clock ticks. It is the record `sumo job watch` follows; Ctrl-O has all of it.
 */
function JobOpen({ id, job, rows }) {
  useAnimation({ interval: 1000 });
  const all = recordLines(id);
  const seen = all.slice(-openRows(rows));
  const above = all.length - seen.length;
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { wrap: 'truncate' }, h(Text, { color: jobColour(id) }, '⏺ '), h(Text, { bold: true }, `j${id}`), ` ${job.agent} · ${job.route} — ${job.title}`),
    above > 0 ? h(Text, { dimColor: true }, `  … +${above} line${above === 1 ? '' : 's'}`) : null,
    all.length === 0 ? h(Text, { dimColor: true }, '  nothing done yet') : null,
    ...seen.map((line, i) => h(Text, { key: i, dimColor: /^\s*⎿/.test(line), wrap: 'truncate' }, untab(line) || ' ')),
  );
}

/** The most of a call's input the question shows in full; past it, the cut is said. A recipient or a body hidden past the cut is one the user never approved. */
const ASK_INPUT_MAX = 4_000;

/** A call waiting on the user's word: who asks, what would run with what — the whole input, not its first line — and the keys that answer. */
function Ask({ ask, aside = false, columns }) {
  const who = ask.job ? `j${ask.job}: ` : '';
  // A command the sandbox blocked is asked as itself: the command, to run once outside the sandbox — yes or no, never always.
  const command = ask.unsandboxed ? safeForTerminal(String(ask.input?.command ?? '')) : null;
  const whole = command ?? JSON.stringify(ask.input ?? {});
  // Short enough for a line, it is the one line; longer, it is laid out, every field whole, up to the cut.
  const short = whole.length <= INPUT_SHOWN && !whole.includes('\n');
  const laid = short ? [whole] : command !== null ? command.split('\n') : JSON.stringify(ask.input ?? {}, null, 2).split('\n');
  const kept = [];
  let size = 0;
  for (const line of laid) {
    if (size + line.length > ASK_INPUT_MAX) break;
    kept.push(line);
    size += line.length + 1;
  }
  const cut = laid.length - kept.length;
  const title = command !== null ? `${who}Run this once outside the sandbox?` : `${who}Allow ${ask.server} · ${ask.tool}?`;
  // Esc stops the turn the call is part of; for a job at work in the background there is no such turn, and Esc refuses the call.
  const keys = `${command !== null ? 'y yes · n no' : 'y once · a always · n no'} · esc ${aside ? 'no' : 'stop'}`;
  // A panel of its own, set apart from the work: what would run, whole, and the keys that answer.
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column', borderStyle: 'round', borderColor: 'yellow', paddingX: 1, width: Math.max(20, columns) },
    h(Text, { color: 'yellow', bold: true }, `⚠ ${title}`),
    h(
      Box,
      { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
      ...(whole === '{}' ? [h(Text, { key: 'none', dimColor: true }, '(no input)')] : kept.map((line, i) => h(Text, { key: i, wrap: 'truncate-end' }, untab(line) || ' '))),
      cut > 0 ? h(Text, { dimColor: true }, `… ${cut} more line${cut === 1 ? '' : 's'} of input not shown — n, and ask the model for less`) : null,
    ),
    h(Text, { dimColor: true }, keys),
  );
}

/** A mark, and words that go on under themselves, never under the mark: the rows of a question and its options. */
function Hung({ mark, width, color, children }) {
  return h(Box, null, h(Box, { flexShrink: 0 }, h(Text, { color }, mark)), h(Box, { width: Math.max(10, width - mark.length) }, h(Text, { color }, ...[children].flat())));
}

/** A question of the model's: its options, the one the arrows are on, and the keys that answer — a pick, or words typed in the box. */
function Question({ ask, columns }) {
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    h(Hung, { mark: '? ', width: columns, color: 'yellow' }, ask.question),
    ...ask.options.map((option, i) => h(Hung, { key: i, mark: `  ${i === ask.at ? '❯' : ' '} ${i + 1}. `, width: columns, color: i === ask.at ? ACCENT : undefined }, option.label, option.detail ? h(Text, { dimColor: true }, ` — ${option.detail}`) : null)),
    h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true }, `↑↓ choose · enter picks · 1–${ask.options.length} picks that one · or type your own answer · esc stop`)),
  );
}

/** One line of a reply; the first of a block carries the mark. */
function Reply({ text, first }) {
  // The mark keeps its two columns: a line with a word wider than the window must not squeeze it, or every row after it shifts left.
  return h(Box, { marginTop: first ? 1 : 0 }, h(Box, { flexShrink: 0 }, h(Text, null, first ? '⏺ ' : '  ')), h(Text, null, text || ' '));
}

/** Something finished, drawn once and left to scroll. */
/** `columns` is the window's width, handed down: every item asking the terminal for it would be a listener each, on a stream that takes ten. */
function Item({ item, columns, s }) {
  if (item.kind === 'header') {
    return h(
      Box,
      { flexDirection: 'column' },
      h(
        Box,
        { gap: 3, marginTop: 1 },
        // The sunset runs across the name, gold at the S to crimson at the O.
        h(Box, { flexDirection: 'column', flexShrink: 0 }, ...WORDMARK.map((row, r) => h(Text, { key: r }, ...[...row].map((ch, i) => h(Text, { key: i, color: sunset(i / (row.length - 1)) }, ch))))),
        // Beside the name, as wide as the window leaves: a long path loses its middle, never runs past the edge.
        h(Box, { flexDirection: 'column', width: Math.max(10, columns - WORDMARK[0].length - 3) }, h(Text, { wrap: 'truncate-end' }, item.route, VERSION ? h(Text, { dimColor: true }, `  sumo ${VERSION}`) : null), h(Text, { dimColor: true, wrap: 'truncate-middle' }, item.cwd)),
      ),
      item.block ? h(Box, { marginTop: 1 }, h(Text, null, item.block)) : null,
    );
  }
  // What the user said is what a scroll back looks for: full weight, a bar of the chat's colour down its side.
  if (item.kind === 'user') {
    return h(
      Box,
      { marginTop: 1, flexDirection: 'column', borderStyle: 'bold', borderColor: ACCENT, borderTop: false, borderRight: false, borderBottom: false, paddingLeft: 1 },
      h(Text, null, untab(item.text)),
      item.more ? h(Text, { dimColor: true }, `… +${item.more} line${item.more === 1 ? '' : 's'}`) : null,
    );
  }
  if (item.kind === 'text') return h(Reply, item);
  if (item.kind === 'tool') return h(Tool, { ...item, columns, s });
  if (item.kind === 'output') return h(Box, { flexDirection: 'column' }, ...linesUnder(item.lines, columns, s));
  if (item.kind === 'footer') return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, `  ${item.text}`));
  // The mark stands apart from the words, so a line that wraps in a narrow window goes on under them, not under it.
  if (item.kind === 'job') return h(Box, { marginTop: 1 }, h(Box, { flexShrink: 0 }, h(Text, { color: jobColour(item.id) }, '⏺ ')), h(Box, { width: Math.max(10, columns - 2) }, h(Text, null, h(Text, { bold: true }, `j${item.id}`), ` ${item.agent} · ${item.route} — ${item.title}`, h(Text, { dimColor: true }, ` · ${item.where}`))));
  if (item.kind === 'error') return h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, { color: 'red' }, item.text), item.detail ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true }, item.detail)) : null);
  // What the model thought before it answered: how long, here; the thought itself is in the pager.
  if (item.kind === 'thought') return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, `✻ Thought for ${elapsed(item.ms)}`));
  return h(Box, { flexDirection: 'column' }, ...linesUnder(item.text.split('\n').map((text) => ({ text, tone: 'dim' })), columns, s));
}

/**
 * The line that says it is working: your words, the next of them every few seconds, a sunset flowing through them; how
 * long, how much, and how to stop it. Under it, while the model thinks, the last rows of what it has thought so far.
 */
function Working({ messages, first, tokens, thought = '', heard = 0, quietAfterMs = QUIET_AFTER_MS, motion = true }) {
  // With motion off the words stand in one colour and the line is drawn once a second, for its clock.
  const { frame, time } = useAnimation({ interval: motion ? FLOW_STEP_MS : 1000 });
  const { columns } = useWindowSize();
  const words = `${messageAt(messages, first, time)}…`;
  const spent = tokens > 0 ? ` · ↓ ${thousands(tokens)} tokens` : '';
  const thinking = thoughtRows(thought, Math.max(20, columns - 6));
  // `heard` is when the model last said or did anything, while nothing of its own is running: a long silence is said, so a stream that died is told from one that thinks.
  const silent = heard > 0 ? Date.now() - heard : 0;
  const quiet = silent >= quietAfterMs ? ` · quiet ${elapsed(silent)}` : '';
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    // One row: the words whole, and what follows them cut at the edge rather than set in a column of its own beside them.
    h(
      Box,
      null,
      h(Box, { flexShrink: 0 }, motion ? h(Text, null, ...[...words].map((ch, i) => h(Text, { key: i, color: flow(i, frame) }, ch)), ' ') : h(Text, { color: ACCENT }, `${words} `)),
      h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, `(${elapsed(time)}${spent}${quiet} · esc to interrupt)`)),
    ),
    ...thinking.map((row, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate' }, `${i === 0 ? '  ⎿  ' : '     '}${row}`)),
  );
}

/**
 * The part of the text the box draws when it is too long to draw whole: `max` rows of it around the cursor, a row being
 * a line of the text or as much of a long one as fits the box, with how many rows lie above and below. The text itself
 * is not touched: this is only what is shown of it.
 */
export function inView({ text, cursor }, width, max) {
  const rows = [];
  let at = 0;
  for (const line of text.split('\n')) {
    for (let i = 0; i === 0 || i < line.length; i += width) rows.push([at + i, at + Math.min(line.length, i + width)]);
    at += line.length + 1;
  }
  if (rows.length <= max) return { text, cursor, above: 0, below: 0 };
  const on = Math.max(0, rows.findLastIndex(([from]) => from <= cursor));
  const first = Math.min(Math.max(0, on - (max - 2)), rows.length - max);
  const last = first + max - 1;
  return { text: text.slice(rows[first][0], rows[last][1]), cursor: cursor - rows[first][0], above: first, below: rows.length - 1 - last };
}

/** The box to type in, the cursor drawn where the next key lands; of a text too long for it, the rows around the cursor. */
function Input({ state, width, rows, placeholder = '' }) {
  const seen = inView(state, Math.max(10, width - 6), Math.max(3, Math.min(INPUT_ROWS, rows - 12)));
  const { text, cursor } = seen;
  const on = under(seen);
  // A cursor on a line end, or past the last character, is drawn as a space of its own.
  const shown = on === '' || on === '\n' ? ' ' : on;
  const after = on === '\n' ? text.slice(cursor) : text.slice(cursor + on.length);
  const hidden = (n) => (n > 0 ? h(Text, { dimColor: true }, `… +${n} line${n === 1 ? '' : 's'}`) : null);
  return h(
    Box,
    { borderStyle: 'round', borderColor: 'gray', paddingX: 1, width },
    h(Box, { flexShrink: 0 }, h(Text, null, '> ')),
    // An empty box says what it is for, faint behind the cursor, until something has been said.
    h(Box, { flexGrow: 1, flexShrink: 1, flexDirection: 'column' }, hidden(seen.above), h(Text, { wrap: !text && placeholder ? 'truncate-end' : 'wrap' }, untab(text.slice(0, cursor)), h(Text, { inverse: true }, untab(shown)), untab(after), !text && placeholder ? h(Text, { dimColor: true }, placeholder) : null), hidden(seen.below)),
  );
}

/** The most rows of a menu drawn at once: a long one scrolls with the pick, so opening it never pushes the conversation far up. */
const MENU_ROWS = 8;

/** The commands, or the files, a half-typed word could mean: one row each, the one picked marked; past the rows there is room for, a window that follows the pick. */
function Menu({ menu, pick }) {
  const wide = Math.max(...menu.map((c) => c.label.length)) + 2;
  const first = Math.min(Math.max(0, pick - MENU_ROWS + 1), Math.max(0, menu.length - MENU_ROWS));
  const shown = menu.slice(first, first + MENU_ROWS);
  const below = menu.length - first - shown.length;
  return h(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    first > 0 ? h(Text, { dimColor: true }, `  ↑ ${first} more`) : null,
    // A hint is one row: wrapped, its second line would stand under the names, where a name is looked for.
    ...shown.map((c, i) => h(Text, { key: c.name, color: first + i === pick ? ACCENT : undefined, dimColor: first + i !== pick, wrap: 'truncate-end' }, `${first + i === pick ? '❯ ' : '  '}${c.label.padEnd(wide)}`, c.hint)),
    below > 0 ? h(Text, { dimColor: true }, `  ↓ ${below} more`) : null,
  );
}

/** A sum of money for a margin: nothing until it is a cent. */
const dollars = (cost) => (cost >= 0.005 ? `$${cost.toFixed(2)}` : '');

/** The keys most reached for, as `?` shows them: the key, then what it does. /help has all of them. */
const KEYS = [
  ['enter', 'send'],
  ['\\ enter', 'a new line'],
  ['esc', 'stop the turn'],
  ['↑ ↓', 'what you sent before'],
  ['ctrl-r', 'search what you sent'],
  ['ctrl-c', 'clear · twice to leave'],
  ['ctrl-o', 'the whole transcript'],
  ['ctrl-g', 'write in your editor'],
  ['ctrl-v', 'paste an image'],
  ['ctrl-y', 'put back what was cut'],
  ['ctrl-_', 'undo in the box'],
  ['ctrl-l', 'draw the screen again'],
  ['/', 'commands'],
  ['@', 'name a file'],
  ['!', 'run a command yourself'],
];

const KEY_WIDTH = Math.max(...KEYS.map(([key]) => key.length)) + 2;

/** `?` on an empty box: the keys, in as many columns as the window holds, until the next key. */
function Keys({ columns }) {
  const per = columns >= 96 ? 3 : columns >= 64 ? 2 : 1;
  const width = Math.floor((columns - 4) / per);
  const rows = [];
  for (let i = 0; i < KEYS.length; i += per) rows.push(KEYS.slice(i, i + per));
  return h(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    ...rows.map((row, r) => h(Box, { key: r }, ...row.map(([key, does], i) => h(Box, { key: i, width }, h(Text, { wrap: 'truncate-end' }, h(Text, { color: ACCENT }, key.padEnd(KEY_WIDTH)), h(Text, { dimColor: true }, does)))))),
    h(Text, { dimColor: true }, '/help has every command and key · any key closes this'),
  );
}

/** Ctrl-R at work: what has been typed to find, and how to go on; the box shows what it found. */
function Search({ search }) {
  return h(
    Box,
    { paddingX: 2 },
    h(
      Text,
      { wrap: 'truncate-end' },
      h(Text, { color: search.failed ? 'red' : ACCENT }, `search: ${search.query}`),
      h(Text, { dimColor: true }, search.failed ? ' — nothing you sent holds that' : !search.query ? 'type what to find in what you sent · esc puts your draft back' : `${search.end ? ' — nothing further back' : ' · ctrl-r further back'} · enter keeps it · esc puts your draft back`),
    ),
  );
}

/** The size of the context, coloured by how far it has grown: faint while it is small, yellow once quality starts to drop, red when it is time for /new. */
export function contextTone(tokens) {
  const band = contextBand(tokens);
  return band === 'act' ? { color: 'red' } : band === 'watch' ? { color: 'yellow' } : { dimColor: true };
}

function Status({ session, leaving, notice, jobs, aside = [], pick = null, open = null, where, spent, overBudget = false, waiting, columns }) {
  const tokens = session.contextTokens;
  const size = tokens >= 1000 ? ` · ${Math.round(tokens / 1000)}k context${contextBand(tokens) === 'act' ? ' · /new' : ''}` : '';
  const cost = dollars(spent) && ` · ${dollars(spent)}`;
  // Where the tools run: the project and the branch it is on. The header that says it scrolls away; this does not.
  const place = where ? `${where.name}${where.branch ? ` (${where.branch})` : ''}` : '';
  const hint = leaving ? `Ctrl-C again to leave${aside.length > 0 ? ` — it stops ${aside.map((id) => `j${id}`).join(', ')}, to be picked up again later` : ''}` : notice ? notice : pick === MAIN ? 'enter shows main · ↑ back to the box' : pick !== null ? `enter opens j${pick} · ↑ back to the box` : open !== null ? `esc closes j${open} · ctrl-o all of its record · @ message talks to it` : jobs.length > 0 ? `${jobs.length === 1 ? `@ message talks to j${jobs[0]}` : '@j<id> message talks to that job'} · ${aside.length > 0 ? `↓ enter opens ${aside.length === 1 ? 'it' : 'one'} · /stop stops it` : 'ctrl-o full output'}` : waiting ? '↑ takes back what is waiting' : '/ commands · ? keys · ctrl-o full output';
  // In a narrow window the hints give way, then the place — unless the line has something to say just now, which the place
  // gives way to; the model, the size of the context and the cost never fold.
  const route = `${routeLine(session)}${size}${cost}`;
  // The route in its parts: the size coloured by how far it has grown, the cost yellow once the session has passed its budget.
  const routed = h(Text, null, h(Text, { dimColor: true }, routeLine(session)), size ? h(Text, contextTone(tokens), size) : null, cost ? h(Text, overBudget ? { color: 'yellow' } : { dimColor: true }, cost) : null);
  const room = columns - 4 - route.length - 2;
  const said = leaving || notice;
  const placed = place && place.length + 3 <= room - (said ? hint.length + 2 : 0) ? place : '';
  const hinted = room - (placed ? placed.length + 3 : 0) >= 12 ? hint : '';
  // With jobs at work the keys are what is needed, and they are long: they follow the jobs, from the left, and give way in a
  // narrow window; the route stands at the right with the place beside it, while the keys keep room for their first words.
  if (jobs.length > 0) {
    // The keys come first here: the place stands beside the route only when they still fit whole.
    const beside = place && columns - 4 - route.length - place.length - 3 - 2 >= hint.length;
    return h(
      Box,
      { paddingX: 2, justifyContent: 'space-between', gap: 2 },
      h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, hint)),
      h(Box, { flexShrink: 0, gap: 3 }, routed, beside ? h(Text, { dimColor: true }, place) : null),
    );
  }
  // The place stands with the route it belongs to, on the left; the keys at the right.
  return h(
    Box,
    { paddingX: 2, justifyContent: 'space-between', gap: 2 },
    h(Box, { flexShrink: 0, gap: 3 }, routed, placed ? h(Text, { dimColor: true }, placed) : null),
    hinted ? h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, hinted)) : null,
  );
}

/** `/help`: every command with what it does, and the keys — written as a reply is, so it is drawn as one. */
function helpText(commands) {
  const keys = [
    ['Enter', 'send — while the model works, it reads the message with its next step'],
    ['\\\\ then Enter · Shift-Enter · Option-Enter · Ctrl-J', 'a new line'],
    ['Up · Down', 'between the lines of the text, then through what you sent before; on an empty box, Up takes back a message that is waiting'],
    ['Esc', 'stop the turn (first closes the command menu); what was waiting comes back to the box'],
    ['Ctrl-C', 'clear the box; on an empty one, stop the turn, or twice to leave — Ctrl-D leaves too'],
    ['Ctrl-O', 'the whole conversation in your pager ($PAGER, or less): every command and all its output, to scroll and search'],
    ['Ctrl-G', 'write the message in your editor ($VISUAL or $EDITOR); what you save comes back to the box'],
    ['@ and a few letters', 'name a file of the project: the menu offers the ones they could mean, and Enter or Tab puts the path in'],
    ['Ctrl-V', 'paste an image from the clipboard; an image file dropped on the box is the image'],
    ['Ctrl-R', 'search what you sent before: type to narrow, Ctrl-R again to go further back, Enter keeps it, Esc puts your draft back'],
    ['?', 'on an empty box: the keys most reached for'],
    ['Ctrl-A · Ctrl-E', 'the start and the end of the line'],
    ['Ctrl-B · Ctrl-F', 'a character back, or on'],
    ['Ctrl-U · Ctrl-K', 'cut to the start, or to the end, of the line'],
    ['Ctrl-W · Option-Backspace · Option-D', 'cut the word before the cursor, or after it'],
    ['Ctrl-Y', 'put back what was cut last — Ctrl-C\'s clearing included'],
    ['Ctrl-_', 'undo the last change to the box'],
    ['Option-Left · Option-Right', 'a word at a time'],
    ['1 – 9', 'on a question with an empty box: pick that option'],
    ['Ctrl-L', 'draw the screen again'],
    ['Ctrl-Z', 'suspend the chat to the shell, when nothing is at work; fg brings it back'],
    ['! command', 'run a command yourself, where the agent would be refused; the model sees what it printed'],
    ['@ message · @j<id> message', 'say it to the job that is running — the one open, when one is — or to a named one'],
    ['Down, then Enter', 'from the box onto the jobs at work under it, and open the one stepped on: the end of its record, as it grows; Esc closes it, Ctrl-O shows all of it'],
  ];
  return [
    '**Commands**',
    '',
    '| Command | What it does |',
    '|---|---|',
    ...commands.map((c) => `| \`/${c.name}\` | ${c.hint.replaceAll('|', '\\|')} |`),
    '',
    '**Keys**',
    '',
    '| Key | What it does |',
    '|---|---|',
    ...keys.map(([key, does]) => `| ${key} | ${does} |`),
    '',
  ].join('\n');
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

function App({ session, events, messages, cwd, block, opening, logo, clipboard, copy, notify: alerts, notifyAfterMs, quietAfterMs, run, listFiles, motion, progress }) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const [, redraw] = useReducer((n) => n + 1, 0);
  // Addresses in a reply open on a click; the pager gets none of that, since a pager may draw its codes as text.
  const s = styles(colourEnabled(stdout), { links: true });
  const paged = styles(colourEnabled(stdout));
  const header = (text) => ({ kind: 'header', route: routeLine(session), cwd: tilde(cwd), block: text });
  // What the screen holds between draws. Keys and the session's events both write here, in the order they happen, and then ask for a draw.
  // `log` is what happened, as it was said; `items` is the log drawn for this window, and is drawn again when the window or the view changes.
  const st = useRef(null);
  // `live` is what each running command has printed so far and since when; `heard`, when the model last said or did anything;
  // `turn`, what the turn in hand has done; `talking`, that the model — not a `!` command — is what the screen is working on;
  // `pick`, the job under the box that Down has stepped onto; `open`, the one whose record is shown.
  st.current ??= { log: [], items: [], unmeasured: [], used: 0, next: 0, epoch: 0, raw: '', ed: editor(readHistory()), images: [], pastes: [], keys: false, notice: null, queue: [], started: new Map(), known: new Map(), working: null, talking: false, tokens: 0, thought: '', thinking: null, showThinking: true, heard: 0, running: new Map(), live: new Map(), drawSoon: null, jobs: new Map(), pick: null, open: null, asks: [], reply: null, fresh: true, leaving: null, gone: false, focused: true, title: null, turn: null, where: session.where(), spent: session.spent(), files: { cwd: null, at: 0, list: [] }, away: false };
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
      if (state.used < state.rows) state.used += renderToString(h(Item, { item, columns: state.columns, s }), { columns: state.columns }).split('\n').length;
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
      const view = toolView(entry.call, entry.result, { cwd: state.where.cwd });
      // A job the call started in the background is told under it: who, on what, and where to follow it — not on a line of its own above the call.
      const started = entry.started ?? [];
      if (started.length === 1 && /^j\d+ is running in the background/.test(entry.result.content)) {
        const [job] = started;
        view.lines = [
          { text: `j${job.id} ${job.agent} · ${job.route} — running in the background`, tone: 'plain' },
          { text: `its report comes here when it is done · ${job.where}`, tone: 'dim' },
        ];
      } else if (started.length > 1 && /^j\d+ is running in the background/.test(entry.result.content)) {
        // Attempts side by side: a line each, and one for the report they make together.
        view.lines = [
          ...started.map((job) => ({ text: `j${job.id} ${job.agent} · ${job.route} — running in the background · ${job.where.replace(/^follow it: /, '')}`, tone: 'plain' })),
          { text: `their report comes here when all ${started.length} are done`, tone: 'dim' },
        ];
      }
      return [{ kind: 'tool', view, failed: entry.result.isError, took: entry.took ?? 0 }];
    }
    // What the user's own command printed: drawn as a tool's output is, under the line they typed.
    if (entry.kind === 'shell') return [{ kind: 'output', lines: toolView({ name: BASH_TOOL.name }, entry.result).lines }];
    // A long message — a paste — is drawn by its top; all of it went to the model, and Ctrl-O shows it.
    if (entry.kind === 'user') {
      const lines = entry.text.split('\n');
      if (lines.length > ECHO_LINES) return [{ ...entry, text: lines.slice(0, ECHO_LINES).join('\n'), more: lines.length - ECHO_LINES }];
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
    // A chat opened on a saved session shows where it stopped and says which, under the header, where a fresh one shows the block's warnings.
    if (opening) state.log.push(...replayOf(session.params.messages), { kind: 'note', text: opening });
    for (const entry of state.log) place(drawn(entry));
  }

  /** The jobs at work with no call standing over them, by id: the ones under the box. */
  const underBox = () => [...state.jobs].filter(([, job]) => !state.running.has(job.parent)).map(([id]) => id);
  /** The rows under the box: the chat itself, then those jobs. None when no job is there: the chat alone needs no row. */
  const rowsUnderBox = () => {
    const jobs = underBox();
    return jobs.length > 0 ? [MAIN, ...jobs] : [];
  };
  /** A job that has ended is no longer stepped on, nor open; nor is the chat's row once the last job is gone. */
  const dropEnded = () => {
    if (!rowsUnderBox().includes(state.pick)) state.pick = null;
    if (!state.jobs.has(state.open)) state.open = null;
  };

  /** The model has stopped thinking and acts: how long it thought stays on the screen, and what it thought goes in the log for the pager. */
  const thoughtDone = () => {
    if (state.thinking === null) return;
    const ms = Date.now() - state.thinking;
    state.thinking = null;
    if (ms >= THOUGHT_SHOWN_MS) record({ kind: 'thought', ms, text: state.thought });
  };

  /** The reply so far is whole: its last line is drawn, it joins the log, and the next text starts a new block. */
  const closeReply = () => {
    state.reply?.flush();
    if (state.raw) state.log.push({ kind: 'reply', raw: state.raw });
    state.raw = '';
    state.fresh = true;
  };

  /**
   * Everything again, from the log, after the window changed size — the window and its scrollback wiped, since what they
   * hold is drawn again. A session that starts over has nothing to draw again:
   * `clear` then only scrolls the old one away, where it can still be read.
   */
  const refresh = (clear = CLEAR) => {
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
    write(clear);
    redraw();
  };

  /** Straight to the terminal, for what draws nothing: the bell, the title. Ink's own writer would take it for a line of the screen. */
  const tell = (sequence) => {
    if (stdout.isTTY) stdout.write(sequence);
  };

  /** A bell and a notification, when the window is not the one in front: the turn is over, or it waits for an answer. */
  const alert = (text) => {
    if (alerts && !state.focused) tell(`\x1b]9;sumo — ${safeForTerminal(text).replace(/\s+/g, ' ')}\x07\x07`);
  };

  /** How a turn ended, in one line: how long, how many calls, the files it changed, what it cost. A quick answer with no calls gets none. */
  const closeTurn = (began, before, ended) => {
    const took = Date.now() - began;
    state.spent = session.spent();
    state.where = session.where();
    const { calls, edited } = state.turn;
    const files = [...edited];
    const parts = [elapsed(took), calls > 0 ? `${calls} call${calls === 1 ? '' : 's'}` : '', files.length > 0 ? `edited ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}` : '', state.tokens > 0 ? `↓ ${thousands(state.tokens)} tokens` : '', dollars(state.spent - before)];
    if (calls > 0 || took >= notifyAfterMs) record({ kind: 'footer', text: parts.filter(Boolean).join(' · ') });
    if (took >= notifyAfterMs) alert(`${state.where.name}: ${ended}`);
  };

  /** The way out. A turn in hand is stopped first and the screen closes when it has let go; nothing queued behind it is sent. */
  const leave = () => {
    state.gone = true;
    state.queue = [];
    if (state.working) session.interrupt();
    else close();
  };

  /** The screen let go: the box and the margin under it are cleared first, so what stays in the terminal is the conversation. */
  const close = () => {
    state.closed = true;
    redraw();
    // The cleared frame is drawn before the screen lets go, however slow the machine: exit waits for it.
    waitUntilRenderFlush().then(() => exit(), () => exit());
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
      // A session that starts over cannot take a job's report with it: the job is waited for, or stopped, first.
      const { control: wanted, args: given } = line.startsWith('!') ? {} : session.expand(line);
      if ((wanted === 'new' || (wanted === 'resume' && given)) && session.running().length > 0) {
        record({ kind: 'user', text: line });
        return record({ kind: 'error', text: `${session.running().map((id) => `j${id}`).join(', ')} still at work in the background — wait for the report, or /stop first` });
      }
      if (line.startsWith('!')) {
        record({ kind: 'user', text: line });
        state.working = pickMessage(messages);
        redraw();
        return record({ kind: 'shell', result: { content: await session.shell(line.slice(1).trim()), isError: false } });
      }
      const { text, said, guide, control, args, error } = session.expand(line);
      if (error) return record({ kind: 'error', text: error });
      if (control === 'quit') return leave();
      if (control === 'new') {
        session.end();
        state.log = [];
        // The old session's pictures go with it; their numbers stay taken, so a marker recalled from before names nothing.
        state.images = state.images.map(() => null);
        state.pastes = state.pastes.map(() => null);
        state.overBudget = false;
        const block = session.start('new');
        state.where = session.where();
        state.spent = session.spent();
        refresh(scrolledClear(state.rows));
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
        state.pastes = state.pastes.map(() => null);
        state.overBudget = false;
        state.where = session.where();
        state.spent = session.spent();
        refresh(scrolledClear(state.rows));
        record(header(''));
        // Where it stopped, drawn again: the last few turns, so what is picked up is in front of the user and not only the model.
        for (const entry of replayOf(session.params.messages)) record(entry);
        return record({ kind: 'note', text: said });
      }
      if (control === 'copy') {
        record({ kind: 'user', text: line });
        // A number goes further back: /copy 2 is the reply before the last, /copy code 2 the code block before the last.
        const asked = /^(code)?\s*(\d+)?$/.exec(args);
        if (!asked || asked[2] === '0') return record({ kind: 'error', text: `/copy takes nothing, "code", a number, or both — /copy 2 is the reply before the last — not "${args}"` });
        const [, code, n] = asked;
        const back = Number(n ?? 1);
        // The reply as the model wrote it, not as the screen drew it: no indent, no line broken to fit the window.
        const replies = state.log.filter((entry) => entry.kind === 'reply' && !entry.own);
        const blocks = replies.flatMap((entry) => [...entry.raw.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((m) => m[1]));
        const text = (code ? blocks.at(-back) : replies.at(-back)?.raw)?.replace(/\n+$/, '');
        const which = code ? (back === 1 ? 'the last code block' : `code block ${back} from the end`) : back === 1 ? 'the last reply' : `reply ${back} from the end`;
        if (!text) return record({ kind: 'error', text: back > 1 ? `no ${which} — there ${(code ? blocks : replies).length === 1 ? 'is' : 'are'} ${(code ? blocks : replies).length}` : code ? 'no code block in the conversation yet' : 'no reply to copy yet' });
        // Where no clipboard command takes it, the terminal is asked to (OSC 52).
        const taken = await copy(text);
        if (!taken) tell(`\x1b]52;c;${Buffer.from(text).toString('base64')}\x07`);
        const lines = text.split('\n').length;
        return record({ kind: 'note', text: `copied ${which} — ${lines} line${lines === 1 ? '' : 's'}${taken ? '' : ", through the terminal's clipboard"}` });
      }
      if (control === 'context') {
        record({ kind: 'user', text: line });
        const turns = state.log.filter((entry) => entry.kind === 'user' && !/^[/!]/.test(entry.text)).length;
        const calls = state.log.filter((entry) => entry.kind === 'tool').length;
        return record({ kind: 'reply', raw: contextReport({ contextTokens: session.contextTokens, rows: session.usage(), turns, calls }), own: true });
      }
      if (control === 'thinking') {
        record({ kind: 'user', text: line });
        if (args !== 'on' && args !== 'off') return record({ kind: 'note', text: `thinking is ${state.showThinking ? 'shown' : 'hidden'} under the working line — /thinking on or /thinking off` });
        state.showThinking = args === 'on';
        return record({ kind: 'note', text: state.showThinking ? 'the model\'s thinking is shown under the working line' : 'the model\'s thinking is hidden — the pager (ctrl-o) still has it' });
      }
      if (control === 'export') {
        record({ kind: 'user', text: line });
        const file = exportPath(args, state.where.cwd, session.sessionId);
        mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
        writeFileSync(file, markdownOf(state.log, { cwd: state.where.cwd, title: `Sumo — ${state.where.name}` }), { mode: 0o600 });
        return record({ kind: 'note', text: `the conversation is in ${tilde(file)}` });
      }
      if (control === 'help') {
        record({ kind: 'user', text: line });
        return record({ kind: 'reply', raw: helpText(session.commands), own: true });
      }
      if (control === 'model' || control === 'memory' || control === 'mcp' || control === 'undo') {
        record({ kind: 'user', text: line });
        const text = control === 'model' ? session.route(args) : control === 'undo' ? session.undo() : control === 'mcp' ? (await session.mcp()).join('\n') : await session.memoryPage();
        return record({ kind: 'note', text });
      }
      record({ kind: 'user', text: line });
      await modelTurn(() => session.say(text, said, images, { guide }));
    } catch (cause) {
      closeReply();
      record({ kind: 'error', ...explained(cause.message) });
    } finally {
      endTurn();
    }
  }

  /** The model at work, for a message or for a report: the working line, the reply as it comes, and the line the turn ends on. */
  async function modelTurn(run) {
    state.working = pickMessage(messages);
    state.talking = true;
    state.tokens = 0;
    state.fresh = true;
    state.heard = Date.now();
    state.turn = { calls: 0, edited: new Set() };
    state.reply = replyTo((item) => show([item]));
    redraw();
    const began = Date.now();
    const before = session.spent();
    let outcome;
    try {
      outcome = await run();
    } catch (cause) {
      closeReply();
      record({ kind: 'error', ...explained(cause.message) });
      return closeTurn(began, before, 'stopped on an error');
    }
    closeReply();
    // Nothing was waiting after all: no turn was run.
    if (!outcome) return undefined;
    if (outcome.stop === 'interrupted') record({ kind: 'note', text: 'Interrupted · say what it should do instead' });
    if (outcome.stop === 'error') record({ kind: 'error', ...explained(outcome.error) });
    if (stopReason(outcome.stop)) record({ kind: 'note', text: stopReason(outcome.stop) });
    return closeTurn(began, before, outcome.stop === 'error' ? 'stopped on an error' : outcome.stop === 'interrupted' ? 'interrupted' : 'done');
  }

  /** What every turn leaves behind it, however it ended. A job still at work in the background, and a question of its, are not the turn's to clear. */
  function endTurn() {
    const aside = session.running();
    // A question the turn left standing has no call behind it any more.
    for (const ask of state.asks.filter((a) => !aside.includes(a.job))) settle(ask, 'no');
    state.running.clear();
    state.live.clear();
    for (const id of [...state.jobs.keys()]) if (!aside.includes(id)) state.jobs.delete(id);
    dropEnded();
    thoughtDone();
    state.working = null;
    state.talking = false;
    state.thought = '';
    redraw();
    if (state.gone) close();
  }

  /** A turn nobody typed: what the background jobs reported, read by the model as soon as it is free to. */
  async function wakeTurn() {
    try {
      await modelTurn(() => session.wake());
    } catch (cause) {
      closeReply();
      record({ kind: 'error', ...explained(cause.message) });
    } finally {
      endTurn();
    }
  }

  /** Once nothing is at work: what was typed meanwhile goes first, then what the background jobs reported. */
  async function drain() {
    while (!state.working && !state.gone) {
      if (state.queue.length > 0) {
        const next = state.queue.shift();
        redraw();
        await turn(next.line, next.images);
      } else if (session.waiting() > 0) await wakeTurn();
      else break;
    }
  }

  /** `/stop`: a job at work in the background is stopped now, whatever else is going on — it is not a turn, and waits for none. */
  function stopJob(line, given) {
    record({ kind: 'user', text: line });
    const ids = session.running();
    if (ids.length === 0) return record({ kind: 'error', text: 'no job is at work in the background' });
    const id = given ? Number(/^j?(\d+)$/.exec(given)?.[1]) : ids.length === 1 ? ids[0] : NaN;
    if (!ids.includes(id)) return record({ kind: 'error', text: `which one — ${ids.map((j) => `/stop j${j}`).join(' or ')}` });
    session.stop(id);
    return record({ kind: 'note', text: `stopping j${id} — it can be picked up again: ask for it by its id` });
  }

  /** What was typed: now if nothing is running, after the turn in hand if something is. */
  async function submit(typed) {
    // A long paste stood in the box as a marker; what is sent is the paste itself.
    const line = typed.replace(/\[Pasted text #(\d+)[^\]\n]*\]/g, (marker, n) => state.pastes[n - 1] ?? marker);
    keepHistory(line);
    const asked = line.startsWith('/') ? session.expand(line) : {};
    if (asked.control === 'stop') return stopJob(line, asked.args);
    // For a job, not for the chat: `@j31 …` reaches that job wherever it runs, a bare `@…` the one running here.
    // A job that cannot be told anything — closed by now, or never there — is said back, whichever way it was named.
    // With a job's record open, that job is the one a bare `@…` means.
    const named = /^@j?(\d+)\s+(\S[\s\S]*)$/.exec(line);
    const said = named ? named[2].trim() : state.jobs.size > 0 && line.startsWith('@') ? line.slice(1).trim() : '';
    if (said) {
      // A job is told words only; a picture would be dropped without a word.
      if (picturesIn(said).length > 0) return record({ kind: 'error', text: 'a job is told words only — send the picture to the chat, without the @' });
      try {
        const told = named ? session.tell(said, Number(named[1])) : session.tell(said, state.open);
        if (told) return record({ kind: 'user', text: `@j${told} ${said}` });
      } catch (cause) {
        return record({ kind: 'error', text: cause.message });
      }
    }
    const images = picturesIn(line);
    if (state.working) {
      // Words for the model at work are read with its next request, in this turn; a command, a picture, or anything typed
      // while a `!` command runs waits for the turn to end. Either way it stands above the box until it is read or sent.
      const steer = state.talking && images.length === 0 && !/^[/!]/.test(line);
      if (steer) session.steer(line);
      state.queue.push({ line, images, steer });
      return redraw();
    }
    await turn(line, images);
    await drain();
  }

  /**
   * The files a mention could mean, from the project the tools run in. The list is git's, fetched when a file is first
   * named and again once it has gone stale; until it has come, nothing is offered. At the start of the line `@` is the
   * way to a job at work, so no file is offered there while one is.
   */
  const files = (query, from) => {
    if (from === 0 && state.jobs.size > 0) return [];
    const at = state.where.cwd;
    if (state.files.cwd !== at || Date.now() - state.files.at > FILES_FRESH_MS) {
      state.files = { cwd: at, at: Date.now(), list: state.files.cwd === at ? state.files.list : [] };
      listFiles(at).then((list) => {
        if (state.files.cwd !== at) return;
        state.files.list = list;
        redraw();
      });
    }
    return matchFiles(state.files.list, query);
  };

  /**
   * The terminal handed to a program of the user's — their editor, their pager — until it exits: the screen stops
   * drawing and stops reading keys, the work behind it goes on, and everything is drawn again when the program is done.
   */
  const handOver = async (program, file, what) => {
    if (state.away) return false;
    state.away = true;
    try {
      tell(FOCUS_OFF);
      await suspendTerminal(async () => {
        // On a screen of its own: an editor or a pager that has one uses it anyway, and one that has none leaves nothing behind in the conversation.
        tell(`${SCREEN_ASIDE}\x1b[2m${what} (${program.split(' ')[0].split('/').at(-1)}) has the terminal — the chat is back when it closes\x1b[22m\r\n`);
        try {
          await run(program, file);
        } finally {
          tell(SCREEN_BACK);
        }
      });
      return true;
    } catch (cause) {
      notify(`${what} could not be opened: ${cause.message}`);
      return false;
    } finally {
      tell(FOCUS_ON);
      state.away = false;
      redraw();
    }
  };

  /** Ctrl-G: the message in the box, written in the user's editor; what is saved there is what the box holds after. */
  const openEditor = async () => {
    const file = join(paths().home, `message-${process.pid}.md`);
    try {
      mkdirSync(paths().home, { recursive: true, mode: 0o700 });
      writeFileSync(file, state.ed.text, { mode: 0o600 });
      if (!(await handOver(process.env.VISUAL || process.env.EDITOR || 'vi', file, 'the editor'))) return;
      const text = readFileSync(file, 'utf8').replace(/\r\n?/g, '\n').replace(/\n+$/, '');
      state.ed = { ...editor(state.ed.history, state.ed.kill), text, cursor: text.length };
    } catch (cause) {
      notify(cause.message);
    } finally {
      rmSync(file, { force: true });
      redraw();
    }
  };

  /**
   * Ctrl-O: the whole conversation in the user's pager — every command, all its output, each file read or written —
   * to scroll and to search. With a job's record open, it is all of that record. Nothing on the screen is wiped or drawn
   * again for it: the pager has a screen of its own.
   */
  const openPager = async () => {
    const file = join(paths().logs, `conversation-${process.pid}.txt`);
    try {
      mkdirSync(paths().logs, { recursive: true, mode: 0o700 });
      const live = state.raw ? [{ kind: 'reply', raw: state.raw }] : [];
      // What a job wrote is shown, never obeyed: its record goes to the pager as it goes to the screen.
      const text = state.open === null ? transcript([...state.log, ...live], paged, { width: state.columns, cwd: state.where.cwd }) : safeForTerminal(readFileSync(liveFile(state.open), 'utf8'));
      writeFileSync(file, text, { mode: 0o600 });
      // Opened at its end: what was asked about is nearly always the last thing that happened.
      await handOver(process.env.PAGER || 'less -R +G', file, 'the pager');
    } catch (cause) {
      notify(cause.message);
    } finally {
      rmSync(file, { force: true });
    }
  };

  /**
   * Ctrl-Z: the chat stopped and the shell given back, as any program in a terminal is; `fg` brings it back drawn. Not while
   * anything is at work: a turn or a job stopped with the process would hold its command, or its API request, half done.
   */
  const suspend = async () => {
    if (state.away) return;
    if (process.platform === 'win32') return notify('Ctrl-Z does not suspend on Windows');
    if (state.working || session.running().length > 0) return notify('Ctrl-Z waits until nothing is at work — esc stops the turn');
    state.away = true;
    let stopped = true;
    try {
      tell(FOCUS_OFF);
      await suspendTerminal(
        () =>
          new Promise((resolve) => {
            // The timer keeps the process alive while it waits — the screen has let go of the keyboard, the one thing that did —
            // and tells a stop that never came, as under a parent with no job control, from one that did.
            const began = Date.now();
            let continued = false;
            const done = () => {
              clearTimeout(check);
              process.off('SIGCONT', woke);
              stopped = continued || Date.now() - began >= SUSPEND_CHECK_MS * 3;
              resolve();
            };
            const woke = () => {
              continued = true;
              done();
            };
            const check = setTimeout(done, SUSPEND_CHECK_MS);
            process.once('SIGCONT', woke);
            process.kill(process.pid, 'SIGTSTP');
          }),
      );
    } finally {
      tell(FOCUS_ON);
      state.away = false;
      refresh();
    }
    if (!stopped) notify('Ctrl-Z: there is no shell here to suspend the chat into');
  };

  /** What is waiting — to be read at the next step, or sent after the turn — back in the box, ahead of what is typed there; the model reads none of it. */
  const takeBack = (entries) => {
    for (const entry of entries) if (entry.steer) session.unsteer(entry.line);
    state.queue = state.queue.filter((entry) => !entries.includes(entry));
    const text = [...entries.map((entry) => entry.line), state.ed.text].filter(Boolean).join('\n');
    state.ed = { ...editor(state.ed.history, state.ed.kill), text, cursor: text.length };
  };

  useEffect(() => {
    const onText = (chunk) => {
      thoughtDone();
      state.heard = Date.now();
      // The reply has begun: what was thought before it is no longer the news.
      state.thought = '';
      state.raw += chunk;
      state.reply?.write(chunk);
      redraw();
    };
    // What the model is thinking, so far: shown under the working line until it acts. A job's thought is its own: it is not drawn here.
    const onThinking = ({ text, job }) => {
      if (job) return;
      state.thinking ??= Date.now();
      state.thought = text;
      state.heard = Date.now();
      redraw();
    };
    // A request being sent again, or a job's conversation summarized to make room: said where the work shows, with the job's id.
    const onRetry = (r) => record({ kind: 'note', text: `${r.job ? `j${r.job}: ` : ''}${retryLine(r)}` });
    const onCompact = (c) => record({ kind: 'note', text: `${c.job ? `j${c.job}: ` : ''}${compactLine(c)}` });
    // The session has passed what it may cost before it is said: said once, where the retries are.
    const onBudget = ({ text }) => {
      state.overBudget = true;
      record({ kind: 'note', text });
    };
    const onTool = ({ call, job }) => {
      const at = state.jobs.get(job);
      if (at) at.calls++;
      else if (!job) {
        thoughtDone();
        state.thought = '';
        closeReply();
        state.running.set(call.id, call);
        state.live.set(call.id, { since: Date.now(), out: '', cut: false });
        if (state.turn) state.turn.calls++;
        // A project named in this turn has moved the work: the paths drawn from here on are read from it.
        state.where = session.where();
      }
      redraw();
    };
    // What a running command prints, as it prints it: the end of it is kept, and drawn a few times a second at most.
    const onOutput = ({ call, chunk }) => {
      const live = state.live.get(call.id);
      if (!live) return;
      const out = live.out + chunk;
      live.cut ||= out.length > LIVE_KEPT_CHARS;
      live.out = out.slice(-LIVE_KEPT_CHARS);
      state.drawSoon ??= setTimeout(() => {
        state.drawSoon = null;
        redraw();
      }, LIVE_DRAW_MS);
    };
    // What was typed while the model worked, read by it now: it leaves the line above the box and joins the conversation.
    const onHeard = ({ said }) => {
      closeReply();
      for (const text of said) {
        const at = state.queue.findIndex((entry) => entry.steer && entry.line === text);
        if (at !== -1) state.queue.splice(at, 1);
        record({ kind: 'user', text });
      }
    };
    // What the model was handed without being asked: a way of working, or the check it stopped short of.
    const onGuide = ({ name }) => {
      closeReply();
      record({ kind: 'note', text: `guide: ${name}` });
    };
    // The pages a reply cites, under it. A title is a page's own words: nothing in it may drive the terminal.
    const onSources = ({ sources }) => {
      closeReply();
      record({ kind: 'note', text: `sources:\n${sources.map((page) => safeForTerminal(`${page.title} — ${page.url}`).replace(/\s+/g, ' ')).join('\n')}` });
    };
    const onCheck = ({ edited, checks }) => {
      closeReply();
      record({ kind: 'note', text: `held: ${edited.length} file${edited.length === 1 ? '' : 's'} edited, ${checks.length > 0 ? `${checks.join(' and ')} not run` : 'no check declared'}` });
    };
    // A job's work is not the chat's: it shows one line while it works, its report when it ends, and the rest where it is watched.
    const onResult = ({ call, result, job }) => {
      if (job) return;
      // Delegated jobs run side by side: one ending leaves the others' calls on the screen.
      const took = state.live.has(call.id) ? Date.now() - state.live.get(call.id).since : 0;
      state.running.delete(call.id);
      state.live.delete(call.id);
      state.heard = Date.now();
      if (state.turn && call.name === EDITOR_TOOL.name && call.input?.command !== 'view' && !result.isError) state.turn.edited.add(pathFrom(call.input?.path ?? '', state.where.cwd));
      const started = state.started.get(call.id) ?? [];
      state.started.delete(call.id);
      record({ kind: 'tool', call, result, took, started });
    };
    const onJob = ({ job, call = null, tab = null }) => {
      const where = tab?.pane ? 'working in its Herdr tab' : tab?.error ? `no Herdr tab (${tab.error}) — sumo job watch ${job.id}` : `follow it: sumo job watch ${job.id}`;
      const info = { id: job.id, agent: job.agent, title: job.title, route: routeOf(job), where };
      state.jobs.set(job.id, { parent: call, calls: 0, since: Date.now(), agent: job.agent, title: job.title, route: info.route, where });
      state.known.set(job.id, info);
      // Started by a call still on the screen: it is told under that call, at work and once the call is answered.
      if (call && state.running.has(call)) {
        state.started.set(call, [...(state.started.get(call) ?? []), info]);
        return redraw();
      }
      record({ kind: 'job', ...info });
    };
    // A job in the background has reported: how it went is drawn where the conversation has got to, and the model reads the
    // report with its next request — or, when nothing is at work, in a turn started here for it. One the user stopped starts none.
    const onJobReport = ({ job, result, quiet = false }) => {
      const known = state.known.get(job);
      // A job the user stopped is said to be stopped, not left open.
      record({ kind: 'tool', call: { id: `report-${job}`, name: DELEGATE_TOOL.name, input: { job, report: true, agent: known?.agent, title: known?.title, stopped: Boolean(quiet) } }, result });
      alert(`${state.where.name}: j${job} has reported`);
      if (!state.working) drain();
    };
    // The tab said to show the job stayed empty: why, and how to follow it all the same.
    const onTabFailed = ({ job, reason }) => record({ kind: 'error', text: `j${job}: ${reason} — follow it here: sumo job watch ${job}` });
    const onJobEnd = ({ job }) => {
      state.jobs.delete(job);
      dropEnded();
      redraw();
    };
    const onUsage = ({ totals }) => {
      state.tokens = totals.outputTokens;
      state.heard = Date.now();
      state.spent = session.spent();
      redraw();
    };
    // A call waiting on the user's word: shown under the work until a key answers it; Esc stops the turn, which declines it.
    const onApprove = (ask) => {
      state.asks.push(ask);
      ask.signal?.addEventListener('abort', () => settle(ask, 'no'), { once: true });
      alert(`${state.where.name}: ${ask.unsandboxed ? 'a command waits to run outside the sandbox' : `${ask.server} · ${ask.tool} waits for your answer`}`);
      redraw();
    };
    // A question of the model's: shown with its options, the first one picked, until a pick or a typed answer settles it.
    const onAsk = (ask) => {
      const standing = { ...ask, at: 0 };
      state.asks.push(standing);
      ask.signal?.addEventListener('abort', () => settle(standing, 'no'), { once: true });
      alert(`${state.where.name}: a question waits for your answer`);
      redraw();
    };
    // An MCP server that is not there is the user's to see; the model is simply not offered its tools.
    const onMcp = ({ servers, error }) => {
      if (error) record({ kind: 'error', text: `mcp: ${error}` });
      for (const server of servers.filter((s) => !s.ok)) record({ kind: 'error', text: `mcp ${server.name}: ${server.error} — sumo mcp shows every server` });
    };
    events.on('text', onText).on('thinking', onThinking).on('retry', onRetry).on('compact', onCompact).on('budget', onBudget).on('tool', onTool).on('output', onOutput).on('heard', onHeard).on('guide', onGuide).on('sources', onSources).on('check', onCheck).on('result', onResult).on('usage', onUsage).on('job', onJob).on('tab-failed', onTabFailed).on('job-end', onJobEnd).on('job-report', onJobReport).on('approve', onApprove).on('ask', onAsk).on('mcp', onMcp);
    return () => {
      events.off('text', onText).off('thinking', onThinking).off('retry', onRetry).off('compact', onCompact).off('budget', onBudget).off('tool', onTool).off('output', onOutput).off('heard', onHeard).off('guide', onGuide).off('sources', onSources).off('check', onCheck).off('result', onResult).off('usage', onUsage).off('job', onJob).off('tab-failed', onTabFailed).off('job-end', onJobEnd).off('job-report', onJobReport).off('approve', onApprove).off('ask', onAsk).off('mcp', onMcp);
      clearTimeout(state.leaving);
      clearTimeout(state.notice?.timer);
      clearTimeout(state.drawSoon);
      // The terminal as it was found: no more word of its focus, and its own title back.
      tell(`${FOCUS_OFF}${TITLE_BACK}`);
    };
  }, []);

  // The tab's progress mark follows the work: busy from the first word sent to the last, and cleared when the chat closes.
  const busy = Boolean(state.working) && state.asks.length === 0;
  const marked = useRef(false);
  useEffect(() => {
    if (!progress || marked.current === busy) return;
    marked.current = busy;
    tell(busy ? PROGRESS_BUSY : PROGRESS_DONE);
  }, [busy]);
  useEffect(
    () => () => {
      if (marked.current) tell(PROGRESS_DONE);
    },
    [],
  );

  // The window's title says whose chat it is and what it is doing, for a glance at the tab bar: at work, or waiting for an answer.
  useEffect(() => {
    const title = `${state.asks.length > 0 ? '? ' : state.working ? '✳ ' : ''}sumo · ${state.where.name}`;
    if (title === state.title) return;
    state.title = title;
    tell(`\x1b]2;${safeForTerminal(title)}\x07`);
  });

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
    // The terminal saying its window came to the front, or went behind: not something typed.
    if (input === '[I' || input === '[O') {
      state.focused = input === '[I';
      return;
    }
    for (const [one, oneKey] of keysOf(input, key)) {
      // Ctrl-R looking back through what was sent takes every key, Esc and Ctrl-C too: they put the draft back, and stop nothing.
      if (state.ed.search) {
        state.ed = press(state.ed, one, oneKey, session.commands, files).state;
        continue;
      }
      // The keys, shown for `?` on an empty box until the next key — which goes on to do what it does, but Esc, which only closes them.
      if (state.keys) {
        state.keys = false;
        if (oneKey.escape || one === '?') continue;
      } else if (one === '?' && !state.ed.text && !oneKey.ctrl && !oneKey.meta && state.asks.length === 0 && state.pick === null) {
        state.keys = true;
        continue;
      }
      // A question of the model's: on an empty box the arrows move the pick and Enter takes it, or a number picks that option.
      // Anything else is the box's, and Enter there sends what was typed as the answer; Esc and Ctrl-C go on to stop the turn.
      const asked = state.asks[0]?.options ? state.asks[0] : null;
      if (asked && !state.ed.text && /^[1-9]$/.test(one) && Number(one) <= asked.options.length && !oneKey.ctrl && !oneKey.meta) {
        settle(asked, { label: asked.options[Number(one) - 1].label });
        continue;
      }
      if (asked && !state.ed.text && (oneKey.upArrow || oneKey.downArrow || (oneKey.return && !oneKey.shift && !oneKey.meta))) {
        if (oneKey.return) settle(asked, { label: asked.options[asked.at].label });
        else asked.at = Math.max(0, Math.min(asked.options.length - 1, asked.at + (oneKey.downArrow ? 1 : -1)));
        continue;
      }
      // A call standing takes the key: an answer, or Esc and Ctrl-C, which go on to stop the turn; nothing lands in the box.
      if (!asked && state.asks.length > 0 && !oneKey.escape && !(oneKey.ctrl && (one === 'c' || one === 'd'))) {
        // A run outside the sandbox is this one run or none: there is no always for it.
        const unsandboxed = state.asks[0].unsandboxed;
        const answer = (unsandboxed ? { y: 'once', n: 'no' } : { y: 'once', a: 'always', n: 'no' })[one];
        if (answer) settle(state.asks[0], answer);
        else notify(unsandboxed ? 'y runs it once outside the sandbox · n refuses it · esc stops the turn' : 'y allows it once · a always · n refuses it · esc stops the turn');
        continue;
      }
      // A question from a job in the background: Esc refuses that one call, and stops nothing.
      if (oneKey.escape && state.asks.length > 0 && session.running().includes(state.asks[0].job)) {
        settle(state.asks[0], 'no');
        continue;
      }
      // The rows under the box — the chat itself, then its jobs: Down past the box's last line steps onto them, and Up back off
      // them; Enter opens the job stepped on, or on the chat's row comes back to the chat. Esc steps off, and then closes the
      // record that is open — both before it stops a turn. Any other key is the box's.
      const listed = rowsUnderBox();
      if (state.pick !== null) {
        const at = listed.indexOf(state.pick);
        const to = oneKey.downArrow ? listed[Math.min(at + 1, listed.length - 1)] : oneKey.upArrow && at > 0 ? listed[at - 1] : null;
        if (oneKey.return) state.open = state.pick === MAIN ? null : state.pick;
        state.pick = to ?? null;
        if (oneKey.downArrow || oneKey.upArrow || oneKey.return || oneKey.escape) continue;
      } else if (oneKey.escape && state.open !== null && menuOf(state.ed, session.commands, files).length === 0) {
        state.open = null;
        continue;
      }
      if (oneKey.escape || (oneKey.ctrl && one === 'c')) {
        // What is nearest goes first: Ctrl-C clears what is typed, Esc closes the menu, and only then is the turn stopped.
        // A menu of files is shut without a word of the message lost; a command half typed is all there is to lose.
        const open = oneKey.escape ? menuOf(state.ed, session.commands, files) : [];
        // What Ctrl-C clears is not lost: Up brings it back, and so does Ctrl-Y.
        if (oneKey.ctrl && state.ed.text) state.ed = editor([...state.ed.history, state.ed.text], state.ed.text);
        else if (open.length > 0) state.ed = open[0].file ? { ...state.ed, shut: state.ed.text } : editor(state.ed.history, state.ed.kill);
        else if (state.working) {
          // Stopping the turn stops what was waiting on it too: it comes back to the box, to be sent again or not.
          takeBack([...state.queue]);
          session.interrupt();
        } else if (oneKey.escape) continue;
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
        openPager();
        continue;
      }
      // Ctrl-L: everything drawn again, for a screen something else wrote over.
      if (oneKey.ctrl && one === 'l') {
        refresh();
        continue;
      }
      if (oneKey.ctrl && one === 'z') {
        suspend();
        continue;
      }
      if (oneKey.ctrl && one === 'g') {
        openEditor();
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
      // Up on an empty box takes back the last thing waiting, before the model reads it or the turn's end sends it.
      if (oneKey.upArrow && !state.ed.text && state.queue.length > 0) {
        takeBack([state.queue.at(-1)]);
        continue;
      }
      const pressed = press(state.ed, one, oneKey, session.commands, files);
      // Down that moved nothing — the last line of the text, nothing newer to recall — has left the box for the jobs under it.
      // The first step is onto the row that is not on the screen already: a job from the chat, the chat from a job's record.
      if (oneKey.downArrow && pressed.state === state.ed && listed.length > 0) state.pick = state.open === null ? listed[1] : MAIN;
      state.ed = pressed.state;
      if (pressed.submit !== undefined && asked) settle(asked, { text: pressed.submit });
      else if (pressed.submit !== undefined) submit(pressed.submit);
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
    else {
      // What nobody can see in a paste — a direction override, a hidden tag — never reaches the model unseen.
      const { text: clean, removed } = cleanPaste(text);
      if (removed > 0) notify(`${removed} hidden character${removed === 1 ? '' : 's'} taken out of the paste`);
      const lines = clean.replace(/\r\n?/g, '\n').split('\n').length;
      if (lines > PASTE_LINES || clean.length > PASTE_CHARS) {
        // A long paste stands as a marker the box can hold; it goes whole with the message, and Backspace takes it out whole.
        state.pastes.push(clean.replace(/\r\n?/g, '\n'));
        state.ed = paste(state.ed, `[Pasted text #${state.pastes.length} ${lines > 1 ? `+${lines} lines` : `${clean.length} chars`}] `);
      } else state.ed = paste(state.ed, clean);
    }
    redraw();
  });

  if (state.closed) return h(Box, { flexDirection: 'column' }, h(Static, { key: state.epoch, items: state.items }, (item) => h(Item, { key: item.id, item, columns, s })));
  const menu = menuOf(state.ed, session.commands, files);
  const tail = state.reply?.tail ?? '';
  // The jobs the turn waits on: the ones whose call is still out. A job in the background holds nothing up.
  const atWork = [...state.jobs].filter(([, job]) => state.running.has(job.parent)).map(([id]) => `j${id}`);
  const reading = atWork.length === 0 ? 'next step' : `when ${atWork.join(', ')} report${atWork.length === 1 ? 's' : ''}`;
  // Once something has been said, the room is the conversation's: no logo, and no word in the box of what it is for.
  const said = state.log.some((entry) => entry.kind === 'user');
  // Ink adds a line under the frame; a frame that reached the last row would be drawn as a full screen.
  const room = state.unmeasured.length > 0 ? 0 : Math.max(0, rows - state.used - 1);
  return h(
    Box,
    { flexDirection: 'column', minHeight: room },
    h(Static, { key: state.epoch, items: state.items }, (item) => h(Item, { key: item.id, item, columns, s })),
    tail ? h(Reply, { text: tail, first: state.fresh }) : null,
    // What runs now, and under a delegate call the jobs it started. In one box of their own, so the lines coming and going
    // never move what follows — the working line keeps its clock.
    h(
      Box,
      { flexDirection: 'column' },
      ...[...state.running.values()].map((call) => h(Tool, { key: call.id, columns, s, view: toolView(call, null, { cwd: state.where.cwd }), running: true, waiting: state.asks.some((a) => !a.options && !a.job && (!a.name || a.name === call.name)), live: state.live.get(call.id), jobs: [...state.jobs].filter(([, job]) => job.parent === call.id) })),
      // A job no call here started — none should be — still shows that it works.
    ),
    // The silence that is said is the model's: while a command, a job or a question is in hand, the wait is not on it.
    state.working ? h(Working, { messages, first: state.working, tokens: state.tokens, thought: state.showThinking ? state.thought : '', quietAfterMs, motion, heard: state.talking && state.running.size === 0 && state.jobs.size === 0 && state.asks.length === 0 ? state.heard : 0 }) : null,
    state.asks.length > 0 ? (state.asks[0].options ? h(Question, { ask: state.asks[0], columns }) : h(Ask, { ask: state.asks[0], aside: session.running().includes(state.asks[0].job), columns })) : null,
    // The record of the job that is open, under everything the turn is doing: its end, as it grows.
    state.open !== null ? h(JobOpen, { id: state.open, job: state.jobs.get(state.open), rows }) : null,
    // The logo is the empty room's: once something has been said, the room is the conversation's.
    h(Room, { logo: said ? [] : logo, rows, from: state.used }),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      // A message for the model is read with its next request — which, while it waits on a delegated job, is when that job reports.
      ...state.queue.map(({ line, steer }, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate' }, `  ${steer ? reading : 'queued'}: ${line.split('\n')[0]}${line.includes('\n') ? ' …' : ''}`)),
      // While a call waits on the user's word every key is the answer's: no box stands there to type into.
      state.asks.length > 0 && !state.asks[0].options ? null : h(Input, { state: state.ed, width: columns, rows, placeholder: said ? '' : 'Ask anything · / commands · @ files · ? keys' }),
      // The jobs at work in the background, under the box, and the chat over them: they go on whether or not there is a turn.
      ...rowsUnderBox().map((id) => (id === MAIN ? h(MainAtWork, { key: MAIN, working: Boolean(state.working), picked: state.pick === MAIN, shown: state.open === null }) : h(JobAtWork, { key: `j${id}`, id, job: state.jobs.get(id), alone: true, picked: id === state.pick, open: id === state.open }))),
      menu.length > 0 ? h(Menu, { menu, pick: state.ed.pick }) : state.ed.search ? h(Search, { search: state.ed.search }) : state.keys ? h(Keys, { columns }) : h(Status, { session, leaving: Boolean(state.leaving), notice: state.notice?.text, jobs: [...state.jobs.keys()], aside: session.running(), pick: state.pick, open: state.open, where: state.where, spent: state.spent, overBudget: state.overBudget, waiting: state.queue.length > 0, columns }),
    ),
  );
}

/** Starts the session and draws it. The returned instance's `waitUntilExit()` settles when the user leaves. */
export function runUi({ session, events, resume = null, stdin = process.stdin, stdout = process.stdout, messages = spinnerMessages(), cwd = process.cwd(), logo = logoLines(), clipboard = clipboardImage, copy = copyText, notify = true, notifyAfterMs = NOTIFY_AFTER_MS, quietAfterMs = QUIET_AFTER_MS, run = inTerminal, listFiles = gitFiles, motion = true, progress = showsProgress(), debug = false }) {
  // Opened on a saved session (`sumo chat --resume`), the chat picks it up before the screen is drawn; a fresh one starts and is shown its block.
  const opening = resume === null ? null : session.resume(resume);
  const block = opening ? '' : session.start('startup');
  // Ink asks the terminal whether it speaks the kitty keyboard protocol before the screen turns raw mode on. In cooked
  // mode the terminal's answer is echoed and held back until a newline — and lands in the box as `[?0u`. Raw mode first.
  if (stdin.isTTY) stdin.setRawMode(true);
  // The chat starts at the top of a clear window, not under the shell line that started it: the room and the box are placed from its top.
  // What the window showed is scrolled up, not wiped: the terminal's scrollback from before the chat is still there to read.
  if (stdout.isTTY) stdout.write(scrolledClear(stdout.rows || 24));
  if (stdout.isTTY) stdout.write(`${TITLE_KEEP}${FOCUS_ON}`);
  // While Ink waits for that answer — a fifth of a second, on a terminal that gives none — it keeps what is typed and, when
  // it stops waiting, puts it back on the stream "so it isn't lost". But those keys were read as they came, and put back
  // they are read again: a letter typed just as the chat opens landed twice. For as long as Ink waits, nothing is put back.
  if (stdin.isTTY && typeof stdin.unshift === 'function') {
    const putBack = stdin.unshift;
    stdin.unshift = () => {};
    setTimeout(() => {
      stdin.unshift = putBack;
    }, KITTY_WAIT_MS).unref();
  }
  return render(h(App, { session, events, messages, cwd, block, opening, logo, clipboard, copy, notify, notifyAfterMs, quietAfterMs, run, listFiles, motion, progress }), { stdin, stdout, debug, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' } });
}
