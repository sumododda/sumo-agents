import { Box, render, renderToString, Static, Text, useAnimation, useApp, useBoxMetrics, useInput, usePaste, useStdout, useWindowSize } from 'ink';
import { execFile, spawn } from 'node:child_process';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { createContext, createElement as h, useContext, useEffect, useReducer, useRef } from 'react';
import { compactLine, contextReport, routeLine, routeOf } from './chat.mjs';
import { contextBand } from './sessions.mjs';
import { liveFile } from './jobs.mjs';
import { stopReason } from './loop.mjs';
import { INPUT_SHOWN } from './mcp.mjs';
import { paths } from './paths.mjs';
import { scratchDir } from './projects.mjs';
import { redact } from './redact.mjs';
import { elapsed } from './text.mjs';
import { cleanPaste, editor, keysOf, matchFiles, menuOf, paste, press, under } from './editor.mjs';
import { clipboardImage, copyText, droppedImages } from './images.mjs';
import { ASK_TOOL, BASH_TOOL, DELEGATE_TOOL, EDITOR_TOOL } from './tools.mjs';
import { colourEnabled, createRenderer, explained, flow, fold, glyphs, inline, linked, logoLines, markdownOf, messageAt, pathFrom, pickMessage, renderBlock, safeForTerminal, spinnerMessages, styles, sunset, tilde, toolView, transcript, untab, VERSION, withoutColourCodes, withSpan, wrap } from './tty.mjs';

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
/** The marks the screen draws with: plain ones (`chat.screen plain`) for a screen reader. Every component reads them here. */
const Marks = createContext(glyphs(false));
const useMarks = () => useContext(Marks);
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
function showsProgress(env = process.env) {
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
function exportPath(given, cwd, sessionId = null) {
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
    // The mode is given only to a file being made: one made before it was set is made private here.
    chmodSync(historyFile(), 0o600);
  } catch {
    // Nowhere to keep it: the line is still sent.
  }
}

const thousands = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n));

/**
 * A request being sent again, for the scroll: why, in the words a known failure is said in — not what to do about it,
 * since it is being done — and which try this is. One it does not know is said as it came.
 */
const retryWhy = (reason) => {
  const said = explained(reason);
  return said.detail ? said.text.replace(/^error: /, '').split(' — ')[0] : String(reason ?? '').replace(/\s+/g, ' ').trim().slice(0, 160);
};
const retryNote = ({ attempt, limit, reason }) => `${retryWhy(reason)} · retrying (${attempt} of ${limit})`;

/**
 * Reverse video, whatever the colour: NO_COLOR asks for no colour, and chalk, told so, drops every style with it — the
 * cursor in the box, and the part of an edit that changed, would be gone. These are not colour, and are kept.
 */
const reverse = (text) => `\x1b[7m${text}\x1b[27m`;

/**
 * The lines under a call: what came back, the first of them with the mark. Folded to `columns` here, by the same count the
 * replies are folded by, so a line too long for the window goes on under itself — not under the mark, and not past the edge.
 * With `max`, at most that many rows: the last says how many lines were folded away — a line partly shown is shown.
 */
const linesUnder = (lines, columns, s = styles(false), max = null) => {
  const rows = [];
  let reached = 0;
  // Folded only as far as the budget needs: a long edit is not laid out whole to show its top.
  while (reached < lines.length && (max === null || rows.length <= max)) {
    const line = lines[reached];
    // An address in what came back opens on a click, whole, however the line is folded. The part of a diff's line that changed is in reverse video.
    const text = line.span ? withSpan(line, { ...s, inverse: reverse }) : linked(untab(line.text), s);
    // A numbered line — a diff's, a file's — and an item of a list go on under their own text, not under the number or the bullet.
    const hang = /^\s*(?:\d+(?: [-+ ] | {2,})\s*|[•*-] |\d+[.)] )/.exec(text)?.[0].length ?? 0;
    rows.push(...fold(text, Math.max(20, columns - 6), ' '.repeat(Math.min(hang, Math.floor((columns - 6) / 2)))).map((row) => ({ ...line, text: row, from: reached })));
    reached++;
  }
  let kept = rows;
  if (max !== null && (rows.length > max || reached < lines.length)) {
    kept = rows.slice(0, max - 1);
    // A line cut short is counted with the ones never reached: the fold says what is not there to read.
    const whole = (kept.at(-1)?.from ?? -1) + (rows[kept.length]?.from === kept.at(-1)?.from ? 0 : 1);
    const folded = lines.length - whole;
    kept.push({ text: `… +${folded} line${folded === 1 ? '' : 's'}`, tone: 'dim' });
  }
  return kept.map((line, i) => h(Text, { key: i, ...TONES[line.tone], wrap: 'truncate' }, `${i === 0 ? `  ${s.g.under}  ` : '     '}${line.text}`));
};

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
  // Plain, for a screen reader, it has no clock: it is drawn again for what the command prints, not for the time.
  const g = useMarks();
  const plain = g === glyphs(true);
  useAnimation({ interval: 250, isActive: !plain });
  const ran = live && !plain ? Date.now() - live.since : 0;
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: true }, `  ${g.under}  ${label}${ran >= 1000 ? ` ${elapsed(ran)}` : ''}`),
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
  // Several calls drawn as one say what they were in words, not as a call: `Read 3 files (a.js, b.js, +1)`.
  const what = view.group ? `${s.bold(view.title)} (${view.detail})` : `${s.bold(view.title)}(${view.detail})`;
  return untab(`${what}${stat}${time}`)
    .split('\n')
    .flatMap((line) => wrap(line, width).split('\n'));
}

function Tool({ view, failed = false, running = false, waiting = false, jobs = [], live = null, took = 0, columns, s = styles(false) }) {
  const g = useMarks();
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    // The mark stands apart from the words, so a command that wraps, or has lines of its own, goes on under them, not under it.
    // A failure has a mark of its own: its colour alone says nothing to someone who cannot see it.
    h(
      Box,
      null,
      h(Box, { flexShrink: 0 }, h(Text, { color: running ? undefined : failed ? 'red' : 'green', dimColor: running }, `${failed && !running ? g.fail : g.tool} `)),
      // How long it ran, once that is long enough to have been waited on.
      // A width of its own: a box in a row is never made narrower than its longest word, and a command can be one long word.
      h(Box, { flexShrink: 1, flexDirection: 'column', width: Math.max(10, columns - 2) }, ...titleRows(view, took, s, Math.max(10, columns - 2)).map((row, i) => h(Text, { key: i }, row))),
    ),
    // A question put to the user is not running anything: it waits on them, and says so.
    // A call held for the user's word runs nothing either: the panel under the work says it waits, and nothing here says it again.
    // A delegation has no job yet while the router picks the model and effort it runs on.
    running && view.title === 'Question' && !waiting ? h(Text, { dimColor: true }, `  ${g.under}  waiting for your answer`) : running && !waiting && jobs.length === 0 ? h(Running, { live, label: view.title === 'Delegate' ? 'picking the model and effort…' : 'Running…' }) : null,
    ...jobs.map(([id, job]) => h(JobAtWork, { key: id, id, job })),
    ...linesUnder(view.lines, columns, s, view.rows ?? null),
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
  // Plain, the row says what the job has done, not for how long: a clock would have it read out every second.
  const g = useMarks();
  const plain = g === glyphs(true);
  useAnimation({ interval: 1000, isActive: !plain });
  const calls = `${job.calls} tool call${job.calls === 1 ? '' : 's'}`;
  const mark = alone ? (picked ? `  ${g.pick} ` : `  ${g.tool} `) : `  ${g.under}  `;
  // Under the call that started it the title is the call's own: the row says who works on it, on what, and where to follow it.
  const who = alone ? ` ${job.agent} — ${job.title.length > TITLE_CHARS ? `${job.title.slice(0, TITLE_CHARS - 1)}…` : job.title}` : ` ${job.agent} · ${job.route}`;
  const lead = `j${id}${who} · ${plain ? '' : `${elapsed(Date.now() - job.since)} · `}${calls} · `;
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
  const g = useMarks();
  return h(Text, { wrap: 'truncate' }, h(Text, picked || shown ? { color: ACCENT } : { dimColor: true }, picked ? `  ${g.pick} ` : `  ${g.tool} `), h(Text, { dimColor: !picked }, 'main · '), h(Text, { dimColor: true }, working ? 'working' : 'idle'));
}

/** A line written with the screen's own marks — a job's record — in the marks this screen draws with. */
const inMarks = (line, g) => (g.tool === '⏺' ? line : line.replaceAll('⏺', g.tool).replaceAll('⎿', g.under).replaceAll('✗', g.fail).replaceAll('✻', g.thought));

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
  const g = useMarks();
  const all = recordLines(id);
  const seen = all.slice(-openRows(rows));
  const above = all.length - seen.length;
  return h(
    Box,
    { flexDirection: 'column', marginTop: 1 },
    h(Text, { wrap: 'truncate' }, h(Text, { color: jobColour(id) }, `${g.tool} `), h(Text, { bold: true }, `j${id}`), ` ${job.agent} · ${job.route} — ${job.title}`),
    above > 0 ? h(Text, { dimColor: true }, `  … +${above} line${above === 1 ? '' : 's'}`) : null,
    all.length === 0 ? h(Text, { dimColor: true }, '  nothing done yet') : null,
    ...seen.map((line, i) => h(Text, { key: i, dimColor: /^\s*⎿/.test(line), wrap: 'truncate' }, inMarks(untab(line), g) || ' ')),
  );
}

/** The most of a call's input the question shows in full; past it, the cut is said. A recipient or a body hidden past the cut is one the user never approved. */
const ASK_INPUT_MAX = 4_000;

/**
 * What a question shows, as plain text: no escape of any kind, colours included — a conceal code (`ESC[8m`) would hide
 * the very part of a command or a path the user is asked to judge. What draws the work keeps its colours; this does not.
 */
const asText = (text) => safeForTerminal(String(text ?? '').replace(/\x1b/g, '␛').replace(/[\x00-\x08\x0b-\x1f\x7f]/g, (c) => (c === '\x7f' ? '^?' : `^${String.fromCharCode(c.charCodeAt(0) + 64)}`)));

/**
 * A change to a file outside the project, as the question shows it: the file and the command, then what is taken out (-)
 * and put in (+). The file is where the write lands, named as the call above it names it: from the project when it is in
 * it (a guarded one can be), else whole — one file, one spelling.
 */
function editLines(ask, cwd = null) {
  const input = ask.input ?? {};
  const lines = (text, mark) => asText(text).replace(/\n$/, '').split('\n').map((l) => `${mark} ${l}`);
  // The head is the model's words and a path it chose: drawn as text, never as what the terminal would do with an escape.
  // What it does is said in words, not by the editor's own command.
  const verb = { str_replace: 'change', create: 'create', insert: 'insert into' }[input.command] ?? input.command;
  const head = asText(`${verb} ${pathFrom(ask.path, cwd)}${input.command === 'insert' ? ` after line ${input.insert_line ?? 0}` : ''}`);
  if (input.command === 'create') return [head, ...lines(input.file_text, '+')];
  if (input.command === 'insert') return [head, ...lines(input.insert_text ?? input.new_str, '+')];
  return [head, ...lines(input.old_str, '-'), ...lines(input.new_str, '+')];
}

/**
 * The keys that answer a call waiting on the user, and what each answers. A run outside the sandbox is this one run or
 * none; a guarded file is changed this once or not; a file outside the project can be opened for the session, alone or
 * with its directory; an MCP call can be allowed for good.
 */
function answersTo(ask) {
  // Every kind can be refused with the user's words: r opens a line for them, and the model reads them as what to do instead.
  if (ask.unsandboxed) return 'y yes · n no · r no, say why';
  if (ask.guarded) return 'y once · n no · r no, say why';
  // The folder by its name: the path just above it in the question is the file's, in that folder.
  if (ask.path) return `y once · a this file, session${ask.directory ? ` · d all of ${asText(basename(ask.directory))}/, session` : ''} · n no · r no, say why`;
  return 'y once · a always · n no · r no, say why';
}
const KEY_ANSWERS = { y: 'once', a: 'always', d: 'directory', n: 'no', r: 'why' };
/** The answer a key gives to a waiting call, or undefined when the key answers nothing on it. */
const answerOf = (ask, key) => (answersTo(ask).split(' · ').some((said) => said.startsWith(`${key} `)) ? KEY_ANSWERS[key] : undefined);
/** What the panel says when a key answers nothing: each key and what it does, Esc's too. */
const explainKeys = (ask, aside = false) =>
  `${answersTo(ask)
    .split(' · ')
    .map((said) => ({ 'y yes': 'y runs it once outside the sandbox', 'y once': ask.path ? 'y changes it once' : 'y allows it once', 'a always': 'a always', 'a this file, session': 'a this file, session', d: `d all of ${asText(basename(ask.directory ?? ''))}/, session`, 'n no': 'n refuses it', 'r no, say why': 'r with why' })[said.startsWith('d ') ? 'd' : said] ?? said)
    .join(' · ')} · esc ${aside ? 'refuses it' : 'interrupts the turn'}`;

/** How long a run of spaces may be before the question counts it instead of drawing it: blank rows hide what follows them. */
const SPACES_COUNTED = 16;
/** A long run of spaces or tabs in what would run, as a count the eye cannot miss: `echo ok ⟨200 spaces⟩ ; curl …`. */
const spacesCounted = (line) => line.replace(new RegExp(`[ \\t]{${SPACES_COUNTED},}`, 'g'), (run) => ` ⟨${run.length} spaces⟩ `);

/** A call waiting on the user's word: who asks, what would run with what — the whole input, not its first line — and the keys that answer. */
function Ask({ ask, aside = false, waiting = 1, why = null, explain = false, columns, cwd = null }) {
  const who = ask.job ? `j${ask.job}: ` : '';
  // A command the sandbox blocked is asked as itself: the command, to run once outside the sandbox — yes or no, never always.
  const command = ask.unsandboxed ? asText(ask.input?.command) : null;
  // A change outside the project, or to a guarded file, is asked as the change: once; outside and not guarded, this file or its directory for the session.
  const edit = ask.path ? editLines(ask, cwd) : null;
  const whole = command ?? edit?.join('\n') ?? JSON.stringify(ask.input ?? {});
  // Short enough for a line, it is the one line; longer, it is laid out, every field whole, up to the cut.
  const short = whole.length <= INPUT_SHOWN && !whole.includes('\n');
  const laid = short ? [whole] : command !== null ? command.split('\n') : edit ?? JSON.stringify(ask.input ?? {}, null, 2).split('\n');
  // Up to the cap, every character: a line longer than what is left is shown as far as it goes, and what the cap left out
  // is counted in characters — a single line can hold what matters past any count of lines.
  const kept = [];
  let size = 0;
  let unshown = 0;
  for (const line of laid) {
    const room = ASK_INPUT_MAX - size;
    if (room <= 0) unshown += line.length + 1;
    else if (line.length > room) {
      kept.push(line.slice(0, room));
      unshown += line.length - room;
      size = ASK_INPUT_MAX;
    } else {
      kept.push(line);
      size += line.length + 1;
    }
  }
  // A server names its own tools: the title draws them as text, as it draws the input.
  const title = asText(command !== null ? `${who}Run this once outside the sandbox?` : ask.guarded ? `${who}Change this guarded file? ${ask.guarded}` : edit ? `${who}Change this file outside the project?` : `${who}Allow ${ask.server} · ${ask.tool}?`);
  // Esc stops the turn the call is part of; for a job at work in the background there is no such turn, and Esc refuses the call.
  // Several jobs can ask at once: the ones behind this are counted, so none waits unseen.
  // Saying why, the keys are the line's: Enter refuses with the words, Esc goes back to the question.
  // A key that answers nothing has every key explained here, in the panel's own colour, where nothing is cut to fit.
  // Esc is named as the working line names it, wherever it stops the turn.
  const keys = why !== null ? `enter refuses with this · esc back to the question${waiting > 1 ? ` · ${waiting - 1} more waiting` : ''}` : explain ? `${explainKeys(ask, aside)}${waiting > 1 ? ` · ${waiting - 1} more waiting` : ''}` : `${answersTo(ask)} · esc ${aside ? 'no' : 'to interrupt'}${waiting > 1 ? ` · ${waiting - 1} more waiting` : ''}`;
  // A panel of its own, set apart from the work: what would run, whole, and the keys that answer. Plain, it has no frame.
  const g = useMarks();
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column', ...(g.tool === '⏺' ? { borderStyle: 'round', borderColor: 'yellow', paddingX: 1 } : {}), width: Math.max(20, columns) },
    h(Text, { color: 'yellow', bold: true }, `${g.warn} ${title}`),
    h(
      Box,
      { flexDirection: 'column', marginY: 1, paddingLeft: 2 },
      // Why a run outside is asked: what the sandbox refused, faint, above the command.
      ask.unsandboxed && ask.blocked ? h(Text, { key: 'refused', dimColor: true, wrap: 'wrap' }, asText(`the sandbox refused: ${ask.blocked}`)) : null,
      // Wrapped, never cut at the edge: what would run past the window's width is what the question is for.
      ...(whole === '{}' ? [h(Text, { key: 'none', dimColor: true }, '(no input)')] : kept.map((line, i) => h(Text, { key: i, wrap: 'wrap' }, spacesCounted(untab(line)) || ' '))),
      unshown > 0 ? h(Text, { dimColor: true }, `… ${unshown.toLocaleString('en-US')} more character${unshown === 1 ? '' : 's'} of input not shown — n, and ask the model for less`) : null,
    ),
    why !== null ? h(Box, { marginBottom: 1 }, h(Text, { color: 'yellow' }, 'why not? '), h(Text, { wrap: 'wrap' }, `${asText(why)}▌`)) : null,
    // Inside the frame and its padding, the keys go to as many rows as they need, broken only between keys — at full weight:
    // they are what the panel asks the user to read and press.
    ...keyRows(keys, Math.max(20, columns) - (g.tool === '⏺' ? 4 : 0)).map((row, i) => h(Text, { key: `keys-${i}`, ...(explain && why === null ? { color: 'yellow' } : {}), wrap: 'wrap' }, row)),
  );
}

/**
 * The keys a question takes, `y once · n no · …`, in rows that break only between them: a key never stands at the end of one
 * row with what it does on the next. A key longer than a row has it to itself.
 */
export function keyRows(said, width) {
  const rows = [];
  for (const unit of String(said).split(' · ')) {
    const last = rows.at(-1);
    if (last !== undefined && last.length + 3 + unit.length <= width) rows[rows.length - 1] = `${last} · ${unit}`;
    else rows.push(unit);
  }
  return rows;
}

/** A mark, and words that go on under themselves, never under the mark: the rows of a question and its options. */
function Hung({ mark, width, color, children }) {
  return h(Box, null, h(Box, { flexShrink: 0 }, h(Text, { color }, mark)), h(Box, { width: Math.max(10, width - mark.length) }, h(Text, { color }, ...[children].flat())));
}

/** A question of the model's: its options, the one the arrows are on, and the keys that answer — a pick, or words typed in the box. */
function Question({ ask, columns }) {
  const g = useMarks();
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    h(Hung, { mark: '? ', width: columns, color: 'yellow' }, ask.question),
    ...ask.options.map((option, i) => h(Hung, { key: i, mark: `  ${i === ask.at ? g.pick : ' '} ${i + 1}. `, width: columns, color: i === ask.at ? ACCENT : undefined }, option.label, option.detail ? h(Text, { dimColor: true }, ` — ${option.detail}`) : null)),
    // Broken only between keys, as a panel's are: never `esc` at the end of a row and `to interrupt` on the next.
    ...keyRows(`↑↓ choose · enter picks · 1–${ask.options.length} picks that one · or type your own answer · esc to interrupt`, Math.max(20, columns - 2)).map((row, i) => h(Box, { key: `keys-${i}`, paddingLeft: 2 }, h(Text, { dimColor: true }, row))),
  );
}

/** One line of a reply; the first of a block carries the mark. */
function Reply({ text, first }) {
  const g = useMarks();
  // The mark keeps its two columns: a line with a word wider than the window must not squeeze it, or every row after it shifts left.
  return h(Box, { marginTop: first ? 1 : 0 }, h(Box, { flexShrink: 0 }, h(Text, null, first ? `${g.tool} ` : '  ')), h(Text, null, text || ' '));
}

/** A folder by where it really is — `/var` is `/private/var` on macOS — or as given, when it is not there to ask. */
const realOrSame = (folder) => {
  try {
    return realpathSync(folder);
  } catch {
    return resolve(folder);
  }
};

/** Why the tools are not working in the folder the chat was opened in, and what makes them. */
const awayLine = (folder) => `${folder} is not a project: the tools work in scratch — sumo project add . there makes it one`;

/** Something finished, drawn once and left to scroll. */
/** `columns` is the window's width, handed down: every item asking the terminal for it would be a listener each, on a stream that takes ten. */
function Item({ item, columns, s }) {
  // Plain, the name is said, not drawn in blocks: a reader would spell out every one of them.
  if (item.kind === 'header' && s.plain) {
    return h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      h(Text, { wrap: 'truncate-end' }, item.route, VERSION ? h(Text, { dimColor: true }, `  sumo ${VERSION}`) : null),
      h(Text, { dimColor: true, wrap: 'truncate-middle' }, item.cwd),
      item.away ? h(Text, { dimColor: true }, wrap(awayLine(item.away), Math.max(10, columns - 1))) : null,
      item.block ? h(Box, { marginTop: 1 }, h(Text, null, item.block)) : null,
    );
  }
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
      item.away ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, wrap(awayLine(item.away), Math.max(10, columns - 1)))) : null,
      item.block ? h(Box, { marginTop: 1 }, h(Text, null, item.block)) : null,
    );
  }
  // What the user said is what a scroll back looks for: full weight, a bar of the chat's colour down its side — plain, a `>` before each line.
  if (item.kind === 'user') {
    const more = item.more ? h(Text, { dimColor: true }, `… +${item.more} line${item.more === 1 ? '' : 's'}`) : null;
    if (s.plain) return h(Box, { marginTop: 1, flexDirection: 'column' }, h(Text, null, untab(item.text).split('\n').map((line) => `${s.g.bar} ${line}`).join('\n')), more);
    return h(Box, { marginTop: 1, flexDirection: 'column', borderStyle: 'bold', borderColor: ACCENT, borderTop: false, borderRight: false, borderBottom: false, paddingLeft: 1 }, h(Text, null, untab(item.text)), more);
  }
  if (item.kind === 'text') return h(Reply, item);
  if (item.kind === 'tool') return h(Tool, { ...item, columns, s });
  if (item.kind === 'output') return h(Box, { flexDirection: 'column' }, ...linesUnder(item.lines, columns, s));
  // Its margin holds on every row it wraps to: the turn summed up stands apart from the work above it.
  if (item.kind === 'footer') return h(Box, { marginTop: 1, paddingLeft: 2 }, h(Text, { dimColor: true }, item.text));
  // The mark stands apart from the words, so a line that wraps in a narrow window goes on under them, not under it.
  if (item.kind === 'job') return h(Box, { marginTop: 1 }, h(Box, { flexShrink: 0 }, h(Text, { color: jobColour(item.id) }, `${s.g.tool} `)), h(Box, { width: Math.max(10, columns - 2) }, h(Text, null, h(Text, { bold: true }, `j${item.id}`), ` ${item.agent} · ${item.route} — ${item.title}`, h(Text, { dimColor: true }, ` · ${item.where}`))));
  // A failure has a mark of its own, as a failed call has, and goes on under its own words, not at the window's edge:
  // folded here, at the spaces. What came back stands faint beneath, at the same margin.
  if (item.kind === 'error') {
    const width = Math.max(10, columns - 2);
    return h(
      Box,
      { marginTop: 1, flexDirection: 'column' },
      h(Box, null, h(Box, { flexShrink: 0 }, h(Text, { color: 'red' }, `${s.g.fail} `)), h(Box, { width }, h(Text, { color: 'red' }, wrap(item.text, width)))),
      item.detail ? h(Box, { paddingLeft: 2 }, h(Text, { dimColor: true }, item.detail)) : null,
    );
  }
  // /help: the command or key in the chat's colour, what it does faint beside it, going on under itself in a narrow window.
  if (item.kind === 'help') {
    const wide = Math.max(...item.rows.filter(Boolean).map((row) => row.key.length)) + 2;
    const room = Math.max(10, columns - 2 - wide);
    return h(Box, { marginTop: 1, flexDirection: 'column', paddingLeft: 2 }, ...item.rows.map((row, i) => (row ? h(Box, { key: i }, h(Box, { width: wide, flexShrink: 0 }, h(Text, { color: ACCENT }, row.key)), h(Box, { width: room }, h(Text, { dimColor: true }, wrap(row.does, room)))) : h(Text, { key: i }, ' '))));
  }
  // What the model thought before it answered: how long, here; the thought itself is in the pager.
  if (item.kind === 'thought') return h(Box, { marginTop: 1 }, h(Text, { dimColor: true }, `${s.g.thought} Thought for ${elapsed(item.ms)}`));
  return h(Box, { flexDirection: 'column' }, ...linesUnder(item.text.split('\n').map((text) => ({ text, tone: 'dim' })), columns, s));
}

/** The fewest characters of its words the working line keeps before what follows them gives way as well. */
const WORDS_KEPT = 12;

/**
 * The line that says it is working: your words, the next of them every few seconds, a sunset flowing through them; how
 * long, how much, and how to stop it. Under it, while the model thinks, the last rows of what it has thought so far.
 */
function Working({ messages, first, tokens, thought = '', heard = 0, quietAfterMs = QUIET_AFTER_MS, motion = true, retry = null, plan = null, waiting = false }) {
  // With motion off the words stand in one colour and the line is drawn once a second, for its clock. While a question
  // waits on the user, nothing works: the line steps aside — the question's own rows say it waits, and how Esc stops the
  // turn — and nothing is drawn for it, so the screen holds still while the question is read. It stays in place, its
  // clock running, to come back when the question is answered. Plain, for a screen reader, there is no clock at all: a
  // row written again every second is a row read out again every second.
  const g = useMarks();
  const plain = g === glyphs(true);
  const flowing = motion && !waiting;
  const { frame } = useAnimation({ interval: flowing ? FLOW_STEP_MS : 1000, isActive: !plain && !waiting });
  // Timed from when the line appeared, not by the animation, whose clock starts again whenever its pace changes.
  const began = useRef(Date.now());
  const time = Date.now() - began.current;
  const { columns } = useWindowSize();
  if (waiting) return null;
  const said = `${messageAt(messages, first, time)}…`;
  const thinking = thoughtRows(thought, Math.max(20, columns - 6));
  // `heard` is when the model last said or did anything, while nothing of its own is running: a long silence is said, so a stream that died is told from one that thinks.
  const silent = heard > 0 ? Date.now() - heard : 0;
  // A request sent again is waited on in the open: how long until it goes, and which try it is.
  const left = retry ? retry.until - Date.now() : 0;
  const parts = {
    clock: plain ? '' : elapsed(time),
    spent: tokens > 0 ? `↓ ${thousands(tokens)} tokens` : '',
    again: retry && plain ? `retrying · attempt ${retry.attempt}/${retry.limit}` : left > 0 ? `retrying in ${Math.ceil(left / 1000)}s · attempt ${retry.attempt}/${retry.limit}` : '',
    quiet: !plain && silent >= quietAfterMs ? `quiet ${elapsed(silent)}` : '',
  };
  const status = () => `(${[parts.clock, parts.spent, parts.again, parts.quiet, 'esc to interrupt'].filter(Boolean).join(' · ')})`;
  // In a narrow window what is least needed gives way first — the tokens, the silence — then the words, to a few of their
  // own, then the clock and the try. How to stop the turn is never what is cut.
  const room = () => columns - status().length - 1;
  for (const part of ['spent', 'quiet']) if (room() < said.length) parts[part] = '';
  for (const part of ['clock', 'again']) if (room() < WORDS_KEPT) parts[part] = '';
  // Cut between words where there is one to cut at: what is left still reads.
  const fits = Math.max(WORDS_KEPT, room());
  const cut = said.slice(0, fits - 1);
  const words = said.length <= fits ? said : `${(cut.lastIndexOf(' ') >= WORDS_KEPT / 2 ? cut.slice(0, cut.lastIndexOf(' ')) : cut).trimEnd()}…`;
  return h(
    Box,
    { marginTop: 1, flexDirection: 'column' },
    // One row: the words, and what follows them cut at the edge rather than set in a column of its own beside them.
    h(
      Box,
      null,
      h(Box, { flexShrink: 0 }, flowing ? h(Text, null, ...[...words].map((ch, i) => h(Text, { key: i, color: flow(i, frame) }, ch)), ' ') : h(Text, { color: ACCENT }, `${words} `)),
      h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, status())),
    ),
    // The plan the model keeps in its reply: how far it has got, and what it says comes next.
    plan ? h(Text, { dimColor: true, wrap: 'truncate-end' }, `  plan ${plan.done}/${plan.total}${plan.next ? ` · next: ${plan.next}` : ' · all done'}`) : null,
    ...thinking.map((row, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate' }, `${i === 0 ? `  ${g.under}  ` : '     '}${row}`)),
  );
}

const CHECKLIST_ITEM = /^\s*[-*+]\s+\[([ xX])\]\s+(.+?)\s*$/;

/**
 * A checklist in what the model wrote — `- [ ]` and `- [x]` items — as a plan: how many are done, and the first that is
 * not. The latest one is the plan: a checklist written after another replaces it. Null without one.
 */
export function planOf(text) {
  const lines = String(text ?? '').split('\n');
  let end = lines.length - 1;
  while (end >= 0 && !CHECKLIST_ITEM.test(lines[end])) end--;
  if (end < 0) return null;
  let start = end;
  while (start > 0 && CHECKLIST_ITEM.test(lines[start - 1])) start--;
  const items = lines.slice(start, end + 1).map((line) => CHECKLIST_ITEM.exec(line)).map(([, mark, said]) => ({ done: mark !== ' ', said }));
  const next = items.find((item) => !item.done);
  return { done: items.filter((item) => item.done).length, total: items.length, next: next ? inline(next.said, styles(false)) : null };
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
  // Plain, the box is its prompt alone: a frame is read out as a row of lines.
  const framed = useMarks().tool === '⏺';
  return h(
    Box,
    { ...(framed ? { borderStyle: 'round', borderColor: 'gray', paddingX: 1 } : {}), width },
    h(Box, { flexShrink: 0 }, h(Text, null, '> ')),
    // An empty box says what it is for, faint behind the cursor, until something has been said.
    h(Box, { flexGrow: 1, flexShrink: 1, flexDirection: 'column' }, hidden(seen.above), h(Text, { wrap: !text && placeholder ? 'truncate-end' : 'wrap' }, untab(text.slice(0, cursor)), reverse(untab(shown)), untab(after), !text && placeholder ? h(Text, { dimColor: true }, placeholder) : null), hidden(seen.below)),
  );
}

/** The most rows of a menu drawn at once: a long one scrolls with the pick, so opening it never pushes the conversation far up. */
const MENU_ROWS = 8;

/** The commands, or the files, a half-typed word could mean: one row each, the one picked marked; past the rows there is room for, a window that follows the pick. */
/**
 * A description cut to its room where a clause ends — at `;`, `:` or ` — ` — so what is left still says something
 * whole: "the MCP servers", not "the MCP servers: connected or not, their tools, what may run u…". With no such place
 * in reach it is cut between words.
 */
function clauseFit(text, room) {
  if (text.length <= room) return text;
  let cut = -1;
  for (const mark of ['; ', ': ', ' — ']) {
    for (let at = text.indexOf(mark); at !== -1 && at <= room; at = text.indexOf(mark, at + 1)) cut = Math.max(cut, at);
  }
  if (cut > 0) return text.slice(0, cut);
  const space = text.lastIndexOf(' ', room - 2);
  return space > 0 ? `${text.slice(0, space)} …` : text.slice(0, Math.max(0, room - 1));
}

function Menu({ menu, pick, columns = 80 }) {
  const g = useMarks();
  const wide = Math.max(...menu.map((c) => c.label.length)) + 2;
  // The row's room for the description: the window less its margins, the mark and the name.
  const room = Math.max(10, columns - 4 - 2 - wide);
  const first = Math.min(Math.max(0, pick - MENU_ROWS + 1), Math.max(0, menu.length - MENU_ROWS));
  const shown = menu.slice(first, first + MENU_ROWS);
  const below = menu.length - first - shown.length;
  return h(
    Box,
    { flexDirection: 'column', paddingX: 2 },
    first > 0 ? h(Text, { dimColor: true }, `  ↑ ${first} more`) : null,
    // A hint is one row: wrapped, its second line would stand under the names, where a name is looked for.
    ...shown.map((c, i) => h(Text, { key: c.name, color: first + i === pick ? ACCENT : undefined, dimColor: first + i !== pick, wrap: 'truncate-end' }, `${first + i === pick ? `${g.pick} ` : '  '}${c.label.padEnd(wide)}`, c.hint ? clauseFit(c.hint, room) : c.hint)),
    below > 0 ? h(Text, { dimColor: true }, `  ↓ ${below} more`) : null,
  );
}

/** A sum of money for a margin: nothing until it is a cent. */
const dollars = (cost) => (cost >= 0.005 ? `$${cost.toFixed(2)}` : '');

/** The keys most reached for, as `?` shows them: the key, then what it does. /help has all of them. */
const KEYS = [
  ['enter', 'send'],
  ['\\ enter', 'a new line'],
  ['esc', 'interrupt the turn'],
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
    // Broken only between its parts, as a question's keys are.
    ...keyRows('/help has the commands too · any key closes this', columns - 4).map((row, i) => h(Text, { key: `more-${i}`, dimColor: true }, row)),
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

/** The size of the context, coloured by how far it has grown: faint while it is small, yellow once quality starts to drop, red when it is time for /handoff. */
export function contextTone(tokens) {
  const band = contextBand(tokens);
  return band === 'act' ? { color: 'red' } : band === 'watch' ? { color: 'yellow' } : { dimColor: true };
}

/**
 * Hints that fit the room they have, whole: the ones at the end give way first, so a row never ends in a key broken
 * off ("ctrl-o fu…"). One that is too long alone is cut between words, never inside one.
 */
function fitHint(hint, room) {
  if (hint.length <= room) return hint;
  const parts = hint.split(' · ');
  while (parts.length > 1 && parts.join(' · ').length > room) parts.pop();
  const left = parts.join(' · ');
  if (left.length <= room) return left;
  const space = left.lastIndexOf(' ', room - 2);
  return space > 0 ? `${left.slice(0, space)} …` : '';
}

function Status({ session, leaving, notice, jobs, aside = [], pick = null, open = null, where, spent, overBudget = false, waiting, columns }) {
  const tokens = session.contextTokens;
  const size = tokens >= 1000 ? ` · ${Math.round(tokens / 1000)}k context${contextBand(tokens) === 'act' ? ' · /handoff' : ''}` : '';
  const cost = dollars(spent) && ` · ${dollars(spent)}`;
  // Where the tools run: the project and the branch it is on. The header that says it scrolls away; this does not.
  const place = where ? `${where.name}${where.branch ? ` (${where.branch})` : ''}` : '';
  const hint = leaving ? `ctrl-c again to leave${aside.length > 0 ? ` — it stops ${aside.map((id) => `j${id}`).join(', ')}, to be picked up again later` : ''}` : notice ? notice : pick === MAIN ? 'enter shows main · ↑ back to the box' : pick !== null ? `enter opens j${pick} · ↑ back to the box` : open !== null ? `esc closes j${open} · ctrl-o all of its record · @ message talks to it` : jobs.length > 0 ? `${jobs.length === 1 ? `@ message talks to j${jobs[0]}` : '@j<id> message talks to that job'} · ${aside.length > 0 ? `↓ enter opens ${aside.length === 1 ? 'it' : 'one'} · /stop stops it` : 'ctrl-o full output'}` : waiting ? '↑ takes it back' : '/ commands · ? keys · ctrl-o full output';
  // In a narrow window the hints give way, then the place — unless the line has something to say just now, which the place
  // gives way to; the model, the size of the context and the cost never fold.
  const route = `${routeLine(session)}${size}${cost}`;
  // The route in its parts: the size coloured by how far it has grown, the cost yellow once the session has passed its budget.
  const routed = h(Text, null, h(Text, { dimColor: true }, routeLine(session)), size ? h(Text, contextTone(tokens), size) : null, cost ? h(Text, overBudget ? { color: 'yellow' } : { dimColor: true }, cost) : null);
  const room = columns - 4 - route.length - 2;
  const said = leaving || notice;
  const placed = place && place.length + 3 <= room - (said ? hint.length + 2 : 0) ? place : '';
  const hinted = room - (placed ? placed.length + 3 : 0) >= 12 ? fitHint(hint, room - (placed ? placed.length + 3 : 0)) : '';
  // With jobs at work the keys are what is needed, and they are long: they follow the jobs, from the left, and give way in a
  // narrow window; the route stands at the right with the place beside it, while the keys keep room for their first words.
  if (jobs.length > 0) {
    // The keys come first here: the place stands beside the route only when they still fit whole.
    const beside = place && columns - 4 - route.length - place.length - 3 - 2 >= hint.length;
    return h(
      Box,
      { paddingX: 2, justifyContent: 'space-between', gap: 2 },
      h(Box, { flexShrink: 1 }, h(Text, { dimColor: true, wrap: 'truncate' }, fitHint(hint, columns - 4 - route.length - 2 - (beside ? place.length + 3 : 0)))),
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

/** The keys /help lists under the commands, a row each: the ones most reached for. `?` on an empty box shows them at a glance. */
const HELP_KEYS = [
  ['enter', 'send; while the model works, it reads it next'],
  ['\\ enter', 'a new line (shift-enter and ctrl-j too)'],
  ['esc', 'interrupt the turn, or close a menu'],
  ['↑ ↓', 'what you sent before'],
  ['ctrl-r', 'search what you sent'],
  ['ctrl-c', 'clear the box; twice on an empty one to leave'],
  ['ctrl-o', 'the whole conversation in your pager'],
  ['ctrl-g', 'write the message in your editor'],
  ['ctrl-v', 'paste an image'],
  ['ctrl-z', 'suspend to the shell; fg brings it back'],
  ['@ file', 'name a file of the project'],
  ['! command', 'run a command yourself'],
  ['@j<id> message', 'talk to a job at work'],
];

/** `/help`: every command with what it takes and what it does, then the keys — a row each, to be taken in at a glance. A blank row between. */
const helpRows = (commands) => [...commands.map((c) => ({ key: `/${c.name}${c.args ? ` ${c.args}` : ''}`, does: c.hint })), null, ...HELP_KEYS.map(([key, does]) => ({ key, does }))];

/** What an empty chat suggests under its header, faint: something to try, and where the rest is. */
const STARTER = 'try "explain this project" or "add a test for @file" · /help for more';
/** The rows the suggestion takes at the top of the room, with a blank row on either side of it. */
const STARTER_ROWS = 3;

/**
 * The room between the conversation and the box: in an empty chat, a line of what to try at its top, and the logo behind it
 * — faint, in the middle of the window. Whatever takes rows from the room — a menu under the box, what was said — moves the
 * logo up while it still fits whole, and then leaves it out: it is never cut. `from` is the row of the window the live part
 * of the screen starts on.
 */
function Room({ logo, rows, from, starter = false }) {
  const ref = useRef(null);
  const { width, height, top, hasMeasured } = useBoxMetrics(ref);
  const wide = Math.max(0, ...logo.map((row) => row.length));
  const clear = starter ? STARTER_ROWS : 0;
  const at = Math.max(clear, Math.min(Math.floor((rows - logo.length) / 2) - from - top, height - logo.length));
  const seen = logo.length > 0 && hasMeasured && width >= wide && at + logo.length <= height;
  return h(
    Box,
    { ref, flexGrow: 1, flexDirection: 'column', overflow: 'hidden' },
    starter ? h(Box, { marginTop: 1 }, h(Text, { dimColor: true, wrap: 'truncate-end' }, STARTER)) : null,
    seen ? h(Box, { position: 'absolute', top: at, left: Math.floor((width - wide) / 2), flexDirection: 'column' }, ...logo.map((row, i) => h(Text, { key: i, color: 'gray', dimColor: true }, row || ' '))) : null,
  );
}

function App({ session, events, messages, cwd, block, opening, logo, clipboard, copy, notify: alerts, notifyAfterMs, quietAfterMs, run, listFiles, motion, progress, plain = false }) {
  const { exit, suspendTerminal, waitUntilRenderFlush } = useApp();
  const { stdout, write } = useStdout();
  const { columns, rows } = useWindowSize();
  const [, redraw] = useReducer((n) => n + 1, 0);
  // Addresses in a reply open on a click; the pager gets none of that, since a pager may draw its codes as text.
  const s = styles(colourEnabled(stdout), { links: true, plain });
  const paged = styles(colourEnabled(stdout), { plain });
  /**
   * The top of a session: who answers, and where the tools work — the project, which is not always the folder the chat was
   * opened in. Opened in a folder that is not a project, the work goes to scratch: the header says so, and how to change it.
   */
  const header = (text) => {
    const at = session.where().cwd;
    const away = at === scratchDir() && realOrSame(cwd) !== at ? tilde(cwd) : null;
    return { kind: 'header', route: routeLine(session), cwd: tilde(at), away, block: text };
  };
  // What the screen holds between draws. Keys and the session's events both write here, in the order they happen, and then ask for a draw.
  // `log` is what happened, as it was said; `items` is the log drawn for this window, and is drawn again when the window or the view changes.
  const st = useRef(null);
  // `live` is what each running command has printed so far and since when; `heard`, when the model last said or did anything;
  // `turn`, what the turn in hand has done; `talking`, that the model — not a `!` command — is what the screen is working on;
  // `pick`, the job under the box that Down has stepped onto; `open`, the one whose record is shown.
  st.current ??= { log: [], items: [], unmeasured: [], used: 0, next: 0, epoch: 0, raw: '', ed: editor(readHistory()), images: [], pastes: [], keys: false, notice: null, queue: [], started: new Map(), known: new Map(), working: null, talking: false, tokens: 0, thought: '', thinking: null, showThinking: true, heard: 0, running: new Map(), live: new Map(), drawSoon: null, jobs: new Map(), pick: null, open: null, asks: [], why: null, reply: null, fresh: true, leaving: null, gone: false, focused: true, title: null, turn: null, where: session.where(), spent: session.spent(), files: { cwd: null, at: 0, list: [] }, away: false };
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
   * An item is drawn apart to be counted, and that sets off a draw of the screen that is waiting, if one is: so an item leaves
   * `unmeasured` only once it is counted, and a draw it sets off keeps the room shut rather than one row too tall.
   */
  const rowsOf = (item) => renderToString(h(Marks.Provider, { value: s.g }, h(Item, { item, columns: state.columns, s })), { columns: state.columns }).split('\n').length;
  const measure = () => {
    while (state.unmeasured.length > 0) {
      if (state.used < state.rows) state.used += rowsOf(state.unmeasured[0]);
      state.unmeasured.shift();
    }
  };
  /**
   * Reads one after another are drawn as one row: they wait here, under the work, until something else comes — and
   * anything that goes on the screen first puts them there, as the row they make. The log keeps every one of them.
   */
  state.reads ??= [];
  const isRead = (entry) => entry.kind === 'tool' && entry.call.name === EDITOR_TOOL.name && entry.call.input?.command === 'view' && !entry.result.isError && !entry.started?.length;
  const readsDrawn = (reads) => {
    if (reads.length === 1) return drawn(reads[0]);
    // By the files' names: the row is a glance, and the paths, whole, are in Ctrl-O. Two of one name are told apart by their paths.
    const paths = [...new Set(reads.map((entry) => String(entry.call.input?.path ?? '')))];
    const names = paths.map((p) => basename(p));
    const seen = paths.map((p, i) => (names.indexOf(names[i]) === names.lastIndexOf(names[i]) ? names[i] : pathFrom(p, state.where.cwd)));
    const named = seen.length > 2 ? [...seen.slice(0, 2), `+${seen.length - 2}`] : seen;
    const lines = reads.reduce((sum, entry) => sum + (entry.result.content === '' ? 0 : entry.result.content.replace(/\n$/, '').split('\n').length), 0);
    const files = new Set(reads.map((entry) => entry.call.input?.path)).size;
    return [{ kind: 'tool', view: { title: `Read ${files} file${files === 1 ? '' : 's'}`, detail: named.join(', '), group: true, lines: [{ text: `${lines} lines`, tone: 'dim' }] }, failed: false, took: reads.reduce((sum, entry) => sum + (entry.took ?? 0), 0) }];
  };
  const placeReads = () => {
    if (state.reads.length > 0) place(readsDrawn(state.reads.splice(0)));
  };
  /**
   * Items for the screen, each counted before it is placed: a draw that counting one sets off sees the screen as it was —
   * never an item placed and not yet counted, which is a frame a row too tall for the window: the top scrolls away for good
   * and the box is left standing above the foot. What was placed and not counted yet is counted first.
   */
  const show = (items) => {
    measure();
    for (const item of [...(state.reads.length > 0 ? readsDrawn(state.reads.splice(0)) : []), ...items]) {
      const placed = { id: state.next++, ...item };
      if (state.used < state.rows) state.used += rowsOf(placed);
      state.items = [...state.items, placed];
    }
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
      // A question's answer is the user's: said as theirs, without what rode with it for the model.
      const answered = entry.call.name === ASK_TOOL.name && !entry.result.isError ? /^The user (chose|answered): ([^\n]*)/.exec(entry.result.content) : null;
      if (answered) view.lines = [{ text: answered[1] === 'chose' ? `you chose ${answered[2]}` : `you answered: ${answered[2]}`, tone: 'plain' }];
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
    if (!isRead(entry)) return show(drawn(entry));
    state.reads.push(entry);
    redraw();
  };
  /** The whole log placed again, reads one after another as the row they make; the last of them still waits while the turn goes on (`open`). */
  const placeLog = (open = false) => {
    state.reads = [];
    for (const entry of state.log) {
      if (isRead(entry)) state.reads.push(entry);
      else {
        placeReads();
        place(drawn(entry));
      }
    }
    if (!open) placeReads();
  };
  if (state.log.length === 0) {
    state.log.push(header(block));
    // A chat opened on a saved session shows where it stopped and says which, under the header, where a fresh one shows the block's warnings.
    if (opening) state.log.push(...replayOf(session.params.messages), { kind: 'note', text: opening });
    placeLog();
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
   * The reply in hand thrown away, as the loop throws it away: the try it came from failed and is being sent again, or
   * the model declined it. What has not been drawn is not drawn; none of it joins the log, so the pager, /copy and
   * /export never have it, and the next text starts a block of its own.
   */
  const dropReply = () => {
    state.raw = '';
    state.fresh = true;
    state.thought = '';
    state.thinking = null;
    if (state.reply) state.reply = replyTo((item) => show([item]));
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
    placeLog(Boolean(state.working));
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
    // The files by their names, as the rows above them were: each edit's row has its path.
    const files = [...new Set([...edited].map((path) => basename(path)))];
    // A turn quicker than a second has no time worth saying: `0s` reads as nothing happened.
    const parts = [took >= 1000 ? elapsed(took) : '', calls > 0 ? `${calls} call${calls === 1 ? '' : 's'}` : '', files.length > 0 ? `edited ${files.slice(0, 3).join(', ')}${files.length > 3 ? ` +${files.length - 3} more` : ''}` : '', state.tokens > 0 ? `↓ ${thousands(state.tokens)} tokens` : '', dollars(state.spent - before)];
    // The turn is over: reads still waiting for what comes after them go on the screen now.
    if (state.reads.length > 0) show([]);
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
    placeReads();
    state.closed = true;
    redraw();
    // The cleared frame is drawn before the screen lets go, however slow the machine: exit waits for it.
    waitUntilRenderFlush().then(() => exit(), () => exit());
  };

  /** The user's answer to a call waiting on it; one answered already — by Esc, say — is left alone. */
  const settle = (ask, answer) => {
    if (!state.asks.includes(ask)) return;
    state.asks = state.asks.filter((a) => a !== ask);
    if (state.why?.ask === ask) state.why = null;
    if (state.explain?.ask === ask) {
      clearTimeout(state.explain.timer);
      state.explain = null;
    }
    ask.resolve(answer);
    redraw();
  };

  /** A key that answers nothing on a waiting call: for a moment the panel says what each key does, in place of its keys. */
  const explainKeysOf = (ask) => {
    clearTimeout(state.explain?.timer);
    state.explain = {
      ask,
      timer: setTimeout(() => {
        state.explain = null;
        redraw();
      }, NOTICE_MS),
    };
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
      // A command mistyped is no failure: what was typed, and the command it was nearest to.
      if (error) {
        record({ kind: 'user', text: line });
        return record({ kind: 'note', text: error });
      }
      if (control === 'quit') return leave();
      if (control === 'new' || control === 'handoff') {
        // A hand-off is written first, by the model, while the working line says so; one that cannot be had leaves this session as it is.
        let handed = null;
        if (control === 'handoff') {
          record({ kind: 'user', text: line });
          state.working = 'writing the hand-off';
          state.talking = true;
          redraw();
          try {
            handed = await session.handoff();
          } finally {
            state.working = null;
            state.talking = false;
          }
        } else {
          session.end();
        }
        // The old session's pictures go with it; their numbers stay taken, so a marker recalled from before names nothing.
        state.images = state.images.map(() => null);
        state.pastes = state.pastes.map(() => null);
        state.overBudget = false;
        const block = handed ? handed.block : session.start('new');
        state.where = session.where();
        state.spent = session.spent();
        // The new session is in the log before the window is drawn again: one frame, measured under its header. A frame drawn
        // first for an empty window would be written after the header, still that tall, and scroll the header away.
        state.log = [header(block), ...(handed ? [{ kind: 'note', text: `handed off from ${handed.from}: the hand-off rides in with your next message\n${handed.text}` }] : [])];
        return refresh(scrolledClear(state.rows));
      }
      if (control === 'resume') {
        record({ kind: 'user', text: line });
        if (!args) {
          const saved = session.saved();
          return record({ kind: 'note', text: saved.length > 0 ? `${saved.join('\n')}\nopen one with /resume <id>` : 'no saved sessions' });
        }
        // Refused — no such session, or one open elsewhere — nothing changes, and the refusal is shown below like any other error.
        const said = session.resume(args);
        state.images = state.images.map(() => null);
        state.pastes = state.pastes.map(() => null);
        state.overBudget = false;
        state.where = session.where();
        state.spent = session.spent();
        // Where it stopped, drawn again: the last few turns, so what is picked up is in front of the user and not only the model.
        // In the log before the window is drawn again, as for /new.
        state.log = [header(''), ...replayOf(session.params.messages), { kind: 'note', text: said }];
        return refresh(scrolledClear(state.rows));
      }
      if (control === 'copy') {
        record({ kind: 'user', text: line });
        // A number goes further back: /copy 2 is the reply before the last, /copy code 2 the code block before the last.
        const asked = /^(code)?\s*(\d+)?$/.exec(args);
        // What /copy cannot take, or has nothing to take, is no failure: it is said as a note.
        if (!asked || asked[2] === '0') return record({ kind: 'note', text: `/copy takes nothing, "code", a number, or both — /copy 2 is the reply before the last — not "${args}"` });
        const [, code, n] = asked;
        const back = Number(n ?? 1);
        // The reply as the model wrote it, not as the screen drew it: no indent, no line broken to fit the window.
        const replies = state.log.filter((entry) => entry.kind === 'reply' && !entry.own);
        const blocks = replies.flatMap((entry) => [...entry.raw.matchAll(/^[ \t]*```[^\n]*\n([\s\S]*?)^[ \t]*```[ \t]*$/gm)].map((m) => m[1]));
        const text = (code ? blocks.at(-back) : replies.at(-back)?.raw)?.replace(/\n+$/, '');
        const which = code ? (back === 1 ? 'the last code block' : `code block ${back} from the end`) : back === 1 ? 'the last reply' : `reply ${back} from the end`;
        if (!text) return record({ kind: 'note', text: back > 1 ? `no ${which} — there ${(code ? blocks : replies).length === 1 ? 'is' : 'are'} ${(code ? blocks : replies).length}` : code ? 'no code block in the conversation yet' : 'no reply to copy yet' });
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
        // Named as the calls name files: from the project when it went there.
        return record({ kind: 'note', text: `the conversation is in ${pathFrom(file, state.where.cwd)}` });
      }
      // The chat's own words, not the model's: not drawn as a reply, and not what /copy takes.
      if (control === 'help') {
        record({ kind: 'user', text: line });
        return record({ kind: 'help', rows: helpRows(session.commands) });
      }
      // The route said as the status row says it, and how to change it.
      if (control === 'model') {
        record({ kind: 'user', text: line });
        session.route(args);
        return record({ kind: 'note', text: args ? `${routeLine(session)} from the next message` : `${routeLine(session)} · /model <model> <effort> changes it` });
      }
      if (control === 'memory' || control === 'mcp' || control === 'undo') {
        record({ kind: 'user', text: line });
        const text = control === 'undo' ? session.undo() : control === 'mcp' ? (await session.mcp()).join('\n') : await session.memoryPage();
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
    // A declined reply is not kept by the loop, and what streamed of it is not an answer: it leaves the screen as well.
    if (outcome?.stop === 'refusal') dropReply();
    closeReply();
    // Nothing was waiting after all: no turn was run.
    if (!outcome) return undefined;
    if (outcome.stop === 'interrupted') record({ kind: 'note', text: 'Interrupted · say what it should do instead' });
    if (outcome.stop === 'error') record({ kind: 'error', ...explained(outcome.error) });
    if (outcome.stop === 'refusal') record({ kind: 'error', text: `error: the model declined to answer${outcome.stopDetail ? ` (${outcome.stopDetail})` : ''} — rephrase the request, or /model to try another model` });
    else if (stopReason(outcome.stop, outcome.stopDetail)) record({ kind: 'note', text: stopReason(outcome.stop, outcome.stopDetail) });
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
    // The plan and a countdown were the turn's: the next one starts without them.
    state.plan = null;
    state.retry = null;
    state.retried = null;
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
    // No job to stop, or which one, is a note: nothing went wrong.
    if (ids.length === 0) return record({ kind: 'note', text: 'no job is at work in the background' });
    const id = given ? Number(/^j?(\d+)$/.exec(given)?.[1]) : ids.length === 1 ? ids[0] : NaN;
    if (!ids.includes(id)) return record({ kind: 'note', text: `which one — ${ids.map((j) => `/stop j${j}`).join(' or ')}` });
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
    if (process.platform === 'win32') return notify('ctrl-z does not suspend on Windows');
    if (state.working || session.running().length > 0) return notify('ctrl-z waits until nothing is at work — esc interrupts the turn');
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
    if (!stopped) notify('ctrl-z: there is no shell here to suspend the chat into');
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
      // A checklist in the reply is the plan the turn works to: the latest one, under the working line.
      state.plan = planOf(state.raw) ?? state.plan;
      // Text came: a request sent again has gone through.
      state.retry = null;
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
    // A request of the chat's own being sent again counts down on the working line; the scroll says why, in words — once
    // for a run of tries that fail the same way, again when the reason changes. A reply that broke off half-way is thrown
    // away, as the loop throws it away, and the scroll says so.
    const onRetry = (r) => {
      if (r.job) return record({ kind: 'note', text: `j${r.job}: ${retryNote(r)}` });
      state.retry = { until: Date.now() + r.delayMs, attempt: r.attempt, limit: r.limit };
      const broke = Boolean(state.raw);
      if (broke) dropReply();
      const why = retryWhy(r.reason);
      const said = broke ? `the reply broke off: ${why} · asking again` : retryNote(r);
      if (state.retried === `${broke}${why}`) return redraw();
      state.retried = `${broke}${why}`;
      record({ kind: 'note', text: said });
    };
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
    // The turn goes on once: what it edited, what has not checked it, and what the model is asked to do about that.
    const onCheck = ({ edited, checks }) => {
      closeReply();
      const what = edited.length === 1 ? basename(edited[0]) : `${edited.length} files`;
      const them = edited.length === 1 ? 'it' : 'them';
      record({ kind: 'note', text: checks.length > 0 ? `${what} edited, ${checks.join(' and ')} not run since · the model is asked to run ${checks.length === 1 ? 'it' : 'them'}` : `${what} edited and not checked yet · the model is asked to check ${them}` });
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
      // A reply came back: a request that fails after it is a new run of tries, and its reason is said again.
      state.retried = null;
      state.tokens = totals.outputTokens;
      state.heard = Date.now();
      state.spent = session.spent();
      redraw();
    };
    // A call waiting on the user's word: shown under the work until a key answers it; Esc stops the turn, which declines it.
    const onApprove = (ask) => {
      state.asks.push(ask);
      ask.signal?.addEventListener('abort', () => settle(ask, 'no'), { once: true });
      alert(`${state.where.name}: ${ask.unsandboxed ? 'a command waits to run outside the sandbox' : ask.path ? 'a change to a file waits for your answer' : `${ask.server} · ${ask.tool} waits for your answer`}`);
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
      clearTimeout(state.explain?.timer);
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
      // Saying why a call is refused: the keys write the line, Enter refuses with it, Esc goes back to the question. Ctrl-C still stops.
      if (state.why && state.why.ask === state.asks[0] && !(oneKey.ctrl && (one === 'c' || one === 'd'))) {
        if (oneKey.escape) state.why = null;
        else if (oneKey.return) settle(state.why.ask, state.why.text.trim() ? { no: state.why.text.trim() } : 'no');
        else if (oneKey.backspace || oneKey.delete) state.why.text = state.why.text.slice(0, -1);
        else if (!oneKey.ctrl && !oneKey.meta && one) state.why.text += one.replace(/[\r\n]+/g, ' ');
        redraw();
        continue;
      }
      // A call standing takes the key: an answer, or Esc and Ctrl-C, which go on to stop the turn; nothing lands in the box.
      if (!asked && state.asks.length > 0 && !oneKey.escape && !(oneKey.ctrl && (one === 'c' || one === 'd'))) {
        // Each kind of call takes its own keys: a run outside the sandbox is this one run or none, a guarded file this once or not.
        const answer = answerOf(state.asks[0], one);
        if (answer === 'why') {
          state.why = { ask: state.asks[0], text: '' };
          redraw();
        } else if (answer) settle(state.asks[0], answer);
        else explainKeysOf(state.asks[0]);
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
    // Saying why a call is refused, a paste is part of the reason — on one line — and never lands in the box behind it.
    if (state.why && state.why.ask === state.asks[0]) {
      state.why.text += cleanPaste(text).text.replace(/\s+/g, ' ');
      redraw();
      return;
    }
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
    // Reads that wait for what comes after them, drawn as the row they will make.
    ...(state.reads.length > 0 ? readsDrawn(state.reads).map((item, i) => h(Item, { key: `reads-${i}`, item, columns, s })) : []),
    tail ? h(Reply, { text: tail, first: state.fresh }) : null,
    // What runs now, and under a delegate call the jobs it started. In one box of their own, so the lines coming and going
    // never move what follows — the working line keeps its clock.
    h(
      Box,
      { flexDirection: 'column' },
      // A question of the model's is said once, in its own rows under the work: the call that asks it is not drawn over it.
      ...[...state.running.values()].filter((call) => !(call.name === ASK_TOOL.name && state.asks[0]?.options)).map((call) => h(Tool, { key: call.id, columns, s, view: toolView(call, null, { cwd: state.where.cwd }), running: true, waiting: state.asks.some((a) => !a.options && !a.job && (!a.name || a.name === call.name)), live: state.live.get(call.id), jobs: [...state.jobs].filter(([, job]) => job.parent === call.id) })),
      // A job no call here started — none should be — still shows that it works.
    ),
    // The silence that is said is the model's: while a command, a job or a question is in hand, the wait is not on it.
    state.working ? h(Working, { messages, first: state.working, tokens: state.tokens, thought: state.showThinking ? state.thought : '', quietAfterMs, motion, retry: state.retry, plan: state.plan, heard: state.talking && state.running.size === 0 && state.jobs.size === 0 && state.asks.length === 0 ? state.heard : 0, waiting: state.asks.length > 0 }) : null,
    state.asks.length > 0 ? (state.asks[0].options ? h(Question, { ask: state.asks[0], columns }) : h(Ask, { ask: state.asks[0], aside: session.running().includes(state.asks[0].job), waiting: state.asks.length, why: state.why?.ask === state.asks[0] ? state.why.text : null, explain: state.explain?.ask === state.asks[0], columns, cwd: state.where.cwd })) : null,
    // The record of the job that is open, under everything the turn is doing: its end, as it grows.
    state.open !== null ? h(JobOpen, { id: state.open, job: state.jobs.get(state.open), rows }) : null,
    // The logo and what to try are the empty room's: once something has been said, the room is the conversation's.
    h(Room, { logo: said ? [] : logo, rows, from: state.used, starter: !said }),
    h(
      Box,
      { flexDirection: 'column', marginTop: 1 },
      // A message for the model is read with its next request — which, while it waits on a delegated job, is when that job reports.
      ...state.queue.map(({ line, steer }, i) => h(Text, { key: i, dimColor: true, wrap: 'truncate' }, `  ${steer ? reading : 'queued'}: ${line.split('\n')[0]}${line.includes('\n') ? ' …' : ''}`)),
      // While a call waits on the user's word every key is the answer's: no box stands there to type into.
      state.asks.length > 0 && !state.asks[0].options ? null : h(Input, { state: state.ed, width: columns, rows, placeholder: said ? '' : 'Ask anything · / commands · @ files · ? keys' }),
      // The jobs at work in the background, under the box, and the chat over them: they go on whether or not there is a turn.
      ...rowsUnderBox().map((id) => (id === MAIN ? h(MainAtWork, { key: MAIN, working: Boolean(state.working), picked: state.pick === MAIN, shown: state.open === null }) : h(JobAtWork, { key: `j${id}`, id, job: state.jobs.get(id), alone: true, picked: id === state.pick, open: id === state.open }))),
      menu.length > 0 ? h(Menu, { menu, pick: state.ed.pick, columns }) : state.ed.search ? h(Search, { search: state.ed.search }) : state.keys ? h(Keys, { columns }) : h(Status, { session, leaving: Boolean(state.leaving), notice: state.notice?.text, jobs: [...state.jobs.keys()], aside: session.running(), pick: state.pick, open: state.open, where: state.where, spent: state.spent, overBudget: state.overBudget, waiting: state.queue.length > 0, columns }),
    ),
  );
}

/** Starts the session and draws it. The returned instance's `waitUntilExit()` settles when the user leaves. */
/**
 * Ink writes a changed line as: to its first column, the line, erase to the end. After a line exactly as wide as the
 * window the cursor waits on its last column, and an xterm-like terminal erases that column with it — the right edge
 * of every box, gone. The erase goes first instead: the same line drawn, nothing after it erased.
 */
const ERASE_AFTER_LINE = /\x1b\[1G((?:(?!\x1b\[1G)[^\n])*?)\x1b\[K/g;
export const eraseFirst = (chunk) => (typeof chunk === 'string' ? chunk.replace(ERASE_AFTER_LINE, (_whole, line) => `\x1b[1G\x1b[K${line}`) : chunk);
/**
 * Ink steps over a line that has not changed with "next line" (`ESC[E`), which at the foot of the window goes nowhere: a
 * frame that grows past the last row is then drawn a row short, and the next one a row too high — over the frame before
 * it, which stays. A line feed is the same step everywhere else, and at the foot it scrolls, as a frame that grows needs.
 */
export const nextLineScrolls = (chunk) => (typeof chunk === 'string' ? chunk.replaceAll('\x1b[E', '\r\n') : chunk);

export function runUi({ session, events, resume = null, stdin = process.stdin, stdout = process.stdout, messages = spinnerMessages(), cwd = process.cwd(), logo = logoLines(), clipboard = clipboardImage, copy = copyText, notify = true, notifyAfterMs = NOTIFY_AFTER_MS, quietAfterMs = QUIET_AFTER_MS, run = inTerminal, listFiles = gitFiles, motion = true, progress = showsProgress(), debug = false, plain = false }) {
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
  // Plain (`chat.screen plain`), for a screen reader: ASCII marks, no frames, no pictures, and nothing moving.
  const app = h(App, { session, events, messages, cwd, block, opening, logo: plain ? [] : logo, clipboard, copy, notify, notifyAfterMs, quietAfterMs, run, listFiles, motion: motion && !plain, progress, plain });
  // Only the lines that changed are written again: a keystroke in the box rewrites the box's line, not the logo above it,
  // and a clock that ticks rewrites its own row. Measured in a real terminal at 80×24, a keystroke went from ~2.6 KB to
  // 200 bytes; on a slow or remote terminal the whole frame drawn again on every key is what flickers. Each line is
  // erased before it is written, not after (eraseFirst), and a line stepped over steps down even at the foot (nextLineScrolls).
  const write = stdout.write.bind(stdout);
  stdout.write = (chunk, ...rest) => write(nextLineScrolls(eraseFirst(chunk)), ...rest);
  // At a terminal the screen is interactive, whatever the environment says: Ink reads a CI variable as a cue to draw only
  // the last frame, and a shell that exports one (a CI runner, some setups) would get a chat that never shows its work.
  return render(h(Marks.Provider, { value: glyphs(plain) }, app), { stdin, stdout, debug, exitOnCtrlC: false, kittyKeyboard: { mode: 'auto' }, incrementalRendering: true, interactive: Boolean(stdout.isTTY) });
}
