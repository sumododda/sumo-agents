import { readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { Box, render, Text, useApp, useInput, usePaste, useWindowSize } from 'ink';
import { createElement as h, useReducer } from 'react';
import { allModels, cursorSummary, discoverCursor, discoverModels, discoverySummary, fetchListedPrices, labelOf, laneOf, listedPrice, modelId, modelLadder, MODELS, modelStates, pricesSummary, setModel } from './catalog.mjs';
import { getMeta, openDb } from './db.mjs';
import { addServer, allowedBy, CLAUDE_CODE_TOKEN, connect, readConfig, removeServer, setAllow } from './mcp.mjs';
import { redact } from './redact.mjs';
import { CHAT_EFFORTS, CONFIG_DEFAULTS, config, fetchModel, modelUrlOrRefuse } from './setup.mjs';

/**
 * The settings page: every setting Sumo has, on one page, changed with the arrow keys and saved the moment it changes —
 * there is no file to edit and no command that sets a thing by name. `/config` opens it in the chat, in the box's place;
 * `sumo config` at a terminal opens it on its own. Each change goes through the same checks `config()` has always made,
 * the API models' switches through the catalog's, and the MCP servers and their allow lists through mcp.mjs: the page
 * is one more way in to each, never a second set of rules. It needs a person at a terminal, so the model's shell —
 * which has none — can read the settings but never change them.
 *
 * The page is a model that draws itself as lines of `[text, tone]` and takes key names; `SettingsView` puts those lines
 * on an Ink screen, so the chat and `sumo config` draw it the same way and a test can drive it without a terminal.
 */

const ACCENT = '#d77757';
const TONES = { acc: { color: ACCENT }, b: { bold: true }, d: { dimColor: true }, g: { color: 'green' }, r: { color: 'red' }, y: { color: 'yellow' }, gr: { color: 'gray' } };
/**
 * Reverse video, whatever the colour — the cursor in a field (`v`): NO_COLOR asks for no colour, and chalk, told so,
 * drops every style with it. This is not colour, and is kept, as the chat's box keeps its cursor.
 */
const reverse = (text) => `\x1b[7m${text}\x1b[27m`;
const VALUE_WIDTH = 18;
/** A value typed here with no `${NAME}` in it would be stored, and a header is where a token goes. */
const NAMED = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;
const cap = (s) => s[0].toUpperCase() + s.slice(1);
const len = (t) => [...String(t)].length;
const width = (line) => line.reduce((n, [t]) => n + len(t), 0);

/** A line cut to `w` columns, its last one an ellipsis when anything was cut. */
function fit(line, w) {
  if (width(line) <= w) return line;
  const out = [];
  let n = 0;
  for (const [t, c] of line) {
    const ch = [...String(t)];
    if (n + ch.length <= w - 1) {
      out.push([t, c]);
      n += ch.length;
      continue;
    }
    out.push([ch.slice(0, Math.max(0, w - 1 - n)).join('') + '…', c]);
    break;
  }
  return out;
}
const padLine = (line, w) => (width(line) < w ? [...line, [' '.repeat(w - width(line)), '']] : fit(line, w));
const pad = (s, n) => (len(s) >= n ? `${[...s].slice(0, n - 2).join('')}… ` : s + ' '.repeat(n - len(s)));
const trimKeys = (keys, room) => {
  let k = keys;
  while (k && len(k) > room) {
    const at = k.lastIndexOf(' · ');
    k = at > 0 ? k.slice(0, at) : '';
  }
  return k;
};

/** Words of a command line, quotes kept together: what a pasted `npx -y @scope/server --flag "a b"` runs. */
const wordsOf = (line) => [...line.matchAll(/"([^"]*)"|'([^']*)'|(\S+)/g)].map((m) => m[1] ?? m[2] ?? m[3]);

/** A server's name from what was pasted: the host of an address, or the package of a command, without its `mcp`. */
export function nameFrom(addr) {
  const a = addr.trim();
  if (!a) return '';
  if (/^https?:\/\//i.test(a)) {
    try {
      return new URL(a).hostname.split('.').filter((p) => !['mcp', 'www', 'api', 'com', 'app', 'dev', 'io', 'ai', 'org', 'net'].includes(p))[0] ?? '';
    } catch {
      return '';
    }
  }
  const pkg = wordsOf(a).find((w) => !w.startsWith('-') && !['npx', 'uvx', 'node', 'python', 'python3', 'bunx', 'docker', 'run', 'pnpm', 'dlx'].includes(w)) ?? '';
  let name = pkg.replace(/(?<=.)@[^/@]*$/, '').split('/').pop().replace(/^(server-|mcp-)/, '').replace(/(-mcp|-server)$/, '');
  if ((name === 'mcp' || name === 'server') && pkg.includes('/')) name = pkg.split('/')[0].replace(/^@/, '');
  return name.replace(/[^A-Za-z0-9_-]/g, '-');
}

/**
 * The servers Claude Code knows — its own and this project's, from its file — as Sumo would run them. Read, never
 * written. One whose header or environment holds a token itself is listed but cannot be brought in: Sumo keeps no
 * token, only a `${NAME}` filled from the shell.
 */
export function claudeCodeServers(cwd = process.cwd(), env = process.env) {
  const file = join(env.CLAUDE_CONFIG_DIR || env.HOME || homedir(), '.claude.json');
  let data;
  try {
    data = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return [];
  }
  const found = { ...(data?.mcpServers ?? {}), ...(data?.projects?.[cwd]?.mcpServers ?? {}) };
  const out = [];
  for (const [name, s] of Object.entries(found)) {
    if (!s || typeof s !== 'object') continue;
    const literal = (values) => Object.values(values ?? {}).some((v) => !NAMED.test(String(v)) && redact(String(v)).count > 0);
    if (s.url) {
      const headers = s.headers && Object.keys(s.headers).length > 0 ? s.headers : null;
      const why = s.type === 'sse' ? 'an SSE server — Sumo speaks stdio and streamable HTTP' : headers && Object.values(headers).some((v) => !NAMED.test(String(v))) ? "its header holds a token in Claude Code's file — add it here with ${NAME}" : null;
      out.push({ name, shown: s.url, transport: 'http', why, spec: { url: s.url, ...(headers ? { headers } : { token: CLAUDE_CODE_TOKEN }) } });
    } else if (s.command) {
      const envs = s.env && Object.keys(s.env).length > 0 ? s.env : null;
      out.push({ name, shown: [s.command, ...(s.args ?? [])].join(' '), transport: 'stdio', why: literal(envs) ? "its environment holds a token in Claude Code's file — add it here with ${NAME}" : null, spec: { command: s.command, args: s.args ?? [], ...(envs ? { env: envs } : {}) } });
    }
  }
  return out;
}

/** The tools a server offers, by connecting to it once. */
async function toolNames(name, spec) {
  const session = await connect(name, spec);
  try {
    return session.tools.map((t) => t.name);
  } finally {
    await session.close();
  }
}

/** The page's name for a key Ink read, or null for one it does nothing with. */
export function keyName(input, key) {
  if (key.upArrow) return 'up';
  if (key.downArrow) return 'down';
  if (key.leftArrow) return 'left';
  if (key.rightArrow) return 'right';
  if (key.return) return 'enter';
  if (key.escape) return 'escape';
  if (key.tab) return 'tab';
  if (key.backspace || key.delete) return 'backspace';
  if (key.ctrl && (input === 'c' || input === 'd')) return 'escape';
  if (key.ctrl || key.meta) return null;
  if (input === ' ') return 'space';
  return input || null;
}

/**
 * The page. `live` is what the chat lends it: `route(args)` switches the chat's model and effort as the page changes, `current()` is the route it is on,
 * them, `servers()` says how its MCP servers connected, `left()` is the status line's left side. Without it (`sumo
 * config`) a change is for the next chat. `toolsOf`, `download`, `discover`, `cursor`, `prices` and `claude` are the slow or outside parts,
 * passed in so a test can stand in for them.
 */
/** What a model's row says it is for: one of Claude's four, Composer and Grok by their lane; any other by its maker's name and price. */
function modelRowHint(m) {
  const use = laneOf(m) === 'cursor' ? 'on: offered for chats and jobs, run through Cursor with CURSOR_API_KEY · off: never used' : 'on: offered for chats, jobs and memory · off: never used';
  if (MODELS.includes(m) || !m.includes('-')) return use;
  const price = listedPrice(m);
  return `${labelOf(m) ?? m}${price ? ` · $${price.input}/$${price.output} per million tokens` : ' · no price known: run only when picked by name'} — ${use}`;
}

export function settingsPage({ live = {}, cwd = process.cwd(), toolsOf = toolNames, download = fetchModel, discover = discoverModels, cursor = discoverCursor, prices = fetchListedPrices, claude = () => claudeCodeServers(cwd), onChange = () => {} } = {}) {
  const db = openDb();
  const values = () => Object.fromEntries(Object.keys(CONFIG_DEFAULTS).map((k) => [k, getMeta(db, `config.${k}`) ?? CONFIG_DEFAULTS[k]]));
  const switches = () => Object.fromEntries(Object.entries(modelStates(db)).map(([m, state]) => [m, state.on]));
  const serversNow = () => Object.entries(readConfig().mcpServers).map(([name, spec]) => ({ name, spec }));
  const S = { v: values(), on: switches(), servers: [], view: 'page', f: 0, tf: 0, sv: 0, edit: null, msg: null, ask: null, add: null, tools: null, busy: 0, scroll: {}, log: [], closed: false, fetching: null };
  try {
    S.servers = serversNow();
  } catch (cause) {
    S.msg = { err: cause.message };
  }
  const snap = { v: { ...S.v }, on: { ...S.on } };
  const err = (text) => {
    S.msg = { err: String(text).split('\n')[0] };
  };
  // Work that takes a while answers later: if the page moved on, or closed, in the meantime the answer is dropped.
  let generation = 0;
  const busy = () => S.busy !== 0 && S.busy === generation;
  const later = (promise, done) => {
    const mine = ++generation;
    S.busy = mine;
    Promise.resolve(promise)
      .then(
        (value) => mine === generation && !S.closed && done(value, null),
        (cause) => mine === generation && !S.closed && done(null, cause),
      )
      .finally(() => {
        if (S.busy === mine) S.busy = 0;
        if (!S.closed) onChange();
      });
  };

  const sections = () => [
    ['Chat', [
      { id: 'chat.model', label: 'Model', type: 'choice', opts: () => ['auto', ...allModels(db).filter((m) => S.on[m] || m === S.v['chat.model'])], disabled: (o) => o !== 'auto' && !S.on[o], when: live.route ? 'this chat too' : 'from the next chat', hint: 'the model chats run on — auto: the router picks one each turn' },
      { id: 'chat.effort', label: 'Effort', type: 'choice', opts: () => CHAT_EFFORTS, when: live.route ? 'this chat too' : 'from the next chat', hint: 'how much the model thinks before it acts' },
      { id: 'chat.budget', label: 'Spend notice', type: 'money', step: 1, unit: 'a session', zero: 'never', when: live.route ? 'this chat too' : '', hint: 'what a chat may cost before the screen says so, once — ←→ by $1 or type it, 0 for never' },
      { id: 'chat.notify', label: 'Notify', type: 'toggle', when: 'from the next chat', hint: 'the bell and a notification when a long turn ends behind another window' },
      { id: 'chat.screen', label: 'Screen', type: 'choice', opts: () => ['full', 'still', 'plain'], when: 'from the next chat', hint: 'full: colours flow through the working line · still: nothing moves · plain: for a screen reader' },
    ]],
    ['Jobs', [
      { id: 'jobs.floor', label: 'Smallest model', type: 'choice', opts: () => modelLadder(db).filter((m) => S.on[m] || m === S.v['jobs.floor']), disabled: (o) => !S.on[o], when: 'jobs from now on', hint: 'the smallest model a job may run on — haiku holds nothing back' },
      { id: 'jobs.budget', label: 'Budget', type: 'money', step: 1, unit: 'a job', zero: 'no cap', when: 'jobs from now on', hint: 'what one job may spend before it is stopped — 0 for no cap' },
      { id: 'jobs.minutes', label: 'Time limit', type: 'minutes', step: 15, zero: 'no limit', when: 'jobs from now on', hint: 'how long one job may run before it is stopped — ←→ by 15 or type it, 0 for no limit' },
      { id: 'jobs.review', label: 'Review', type: 'choice', opts: () => ['risky', 'all', 'off'], when: 'jobs from now on', hint: 'which workers that finish DONE are reviewed unasked: the risky ones, every one, or none' },
      { id: 'jobs.advisor', label: 'Advisor', type: 'toggle', when: 'jobs from now on', hint: 'a job asking the next model up for advice, from inside its own request' },
    ]],
    ['Memory', [
      { id: 'memory.model', label: 'Filed by', type: 'choice', opts: () => ['local', ...MODELS, 'off'], disabled: (o) => MODELS.includes(o) && !S.on[o], when: 'from the next pass', hint: 'the model that files what you say and tidies memory — local runs on this Mac for $0' },
      { id: 'model.url', label: 'Local model', type: 'url', action: 'enter: change', ph: 'paste the address of a .gguf file', hint: 'the .gguf file the local model comes from — a new one is downloaded as it is set' },
    ]],
    ['Shell', [
      { id: 'shell.sandbox', label: 'Sandbox', type: 'toggle', when: 'from the next chat', hint: "the model's shell writes only in the project, the temporary folders and the tool caches" },
      { id: 'shell.network', label: 'Network', type: 'toggle', when: 'from the next chat', hint: 'the sandboxed shell reaching past this machine — off: only loopback and local sockets' },
    ]],
    ['Projects', [{ id: 'projects.home', label: 'New ones go in', type: 'path', action: 'enter: change', when: 'at once', hint: 'the folder a new project is made in' }]],
    ['API models', [
      ...allModels(db).map((m) => ({ id: `model:${m}`, label: MODELS.includes(m) || !m.includes('-') ? cap(m) : (labelOf(m) ?? m), type: 'model', m, hint: modelRowHint(m) })),
      { id: 'discover', label: 'Discover', type: 'action', text: 'ask Anthropic and Cursor which this login can use', action: 'enter', hint: 'sets the switches from the answer — one you turned off stays off — and fetches list prices; /scorecard, in a chat, writes the scorecard' },
    ]],
    ['MCP servers', [
      ...S.servers.map((s, i) => ({ id: `server:${s.name}`, label: s.name, type: 'server', s, i, action: 'enter: tools', hint: `${s.spec.url ?? [s.spec.command, ...(s.spec.args ?? [])].join(' ')} — enter: its tools, and which run without asking` })),
      { id: 'add', label: '+ add a server', type: 'action', text: '', action: 'enter', hint: 'paste a command or an address, or bring one in from Claude Code' },
    ]],
  ];
  const pageItems = () => sections().flatMap(([title, rows]) => [{ head: title }, ...rows]);
  const focusables = (items) => items.filter((x) => !x.head && !x.note);

  const toolItems = () => {
    const s = S.servers[S.sv];
    const it = [{ note: `${s.spec.url ? 'http' : 'stdio'} · ${s.spec.url ?? [s.spec.command, ...(s.spec.args ?? [])].join(' ')}${s.spec.token === CLAUDE_CODE_TOKEN ? " · login: Claude Code's" : ''}` }];
    if (S.tools === null) it.push({ note: `connecting to ${s.name}…` });
    else if (S.tools.error) it.push({ note: `✗ ${S.tools.error}`, cls: 'r' });
    else if (S.tools.names.length === 0) it.push({ note: `${s.name} offers no tools` });
    else S.tools.names.forEach((t) => it.push({ id: `tool:${t}`, label: t, type: 'tool', t, hint: allowedBy(s.spec, t) ? 'runs without asking you' : 'asks you each time — "always" in that question switches it on here too' }));
    it.push({ id: 'remove', label: 'remove this server', type: 'danger', hint: 'asks first; its allow list goes with it' });
    return it;
  };
  const logins = (http) => (http ? ['none', "Claude Code's", 'a header'] : ['none', 'env from your shell']);
  const addItems = () => {
    const a = S.add;
    const http = /^https?:\/\//i.test(a.addr.trim());
    const ls = logins(http);
    if (a.login >= ls.length) a.login = 0;
    const it = [
      { head: 'A server of your own' },
      { id: 'addr', label: 'Command or address', type: 'text', ph: 'paste npx -y @scope/server … or https://…', hint: 'a command runs as a process on this Mac; an address is reached over HTTP' },
      { id: 'name', label: 'Name', type: 'text', ph: 'filled in from the address', hint: 'what the server is called in the chat and on this page' },
      { id: 'login', label: 'Login', type: 'achoice', opts: ls, hint: http ? 'none · the login Claude Code holds for it (claude mcp login <name>) · or a header from your shell' : 'none · or variables from your shell' },
    ];
    if (a.login > 0 && !(http && a.login === 1)) it.push({ id: 'cred', label: http ? 'Header' : 'Env', type: 'text', ph: http ? 'Authorization: Bearer ${TOKEN}' : 'GITHUB_TOKEN=${GITHUB_TOKEN}', hint: '${NAME} is filled in from your shell when the server starts — the token itself is never stored' });
    it.push({ id: 'go', label: 'Add it', type: 'action', text: '', action: 'enter', hint: 'connects once to list its tools; every tool asks first' });
    if (a.claude.length > 0) {
      it.push({ head: 'Or bring one in from Claude Code' });
      for (const c of a.claude) it.push({ id: `cc:${c.name}`, label: c.name, type: 'pick', c, hint: c.why ?? `${c.transport} · read from Claude Code's list, which is never changed` });
      it.push({ id: 'bring', label: a.picked.size > 0 ? `Bring in ${a.picked.size}` : 'Bring them in', type: 'action', text: '', action: 'enter', hint: 'each tool asks first until you switch it' });
    }
    return it;
  };
  const focused = () => {
    if (S.closed || S.view === 'ask') return null;
    if (S.view === 'tools') return focusables(toolItems())[S.tf];
    if (S.view === 'add') return focusables(addItems())[S.add.f];
    return focusables(pageItems())[S.f];
  };

  // ── what a row shows ──
  const show = (r, v) => {
    if (r.type === 'money') return Number(v) === 0 ? r.zero : `$${Number(v).toFixed(2)}`;
    if (r.type === 'minutes') return Number(v) === 0 ? r.zero : `${v} min`;
    if (r.type === 'url') return String(v).split('/').pop().replace(/\.gguf$/i, '');
    return String(v);
  };
  let plain = false;
  const tog = (on, extra = '') => [[plain ? (on ? 'on' : 'off') : on ? '● on' : '○ off', (on ? 'g' : 'd') + extra]];
  const field = (text, ph, foc, room) => {
    if (!text) return foc ? [[' ', 'v'], [ph ?? '', 'd']] : [[ph ?? '', 'd']];
    const t = foc && len(text) + 1 > room ? `…${[...text].slice(-(room - 2)).join('')}` : text;
    return foc ? [[t, ''], [' ', 'v']] : [[t, '']];
  };
  const allowSummary = (s) => {
    const live_ = live.servers?.().find((x) => x.name === s.name);
    const allow = s.spec.allow === 'all' ? 'every tool runs unasked' : Array.isArray(s.spec.allow) && s.spec.allow.length > 0 ? `${s.spec.allow.length} run unasked` : 'all ask first';
    if (live_ && !live_.ok) return [[`${plain ? 'x' : '✗'} failed to connect`, 'r'], [` · ${allow}`, 'd']];
    return [[`${s.spec.url ? 'http' : 'stdio'}${live_ ? ` · ${live_.tools} tools` : ''} · ${allow}`, '']];
  };
  const valueOf = (r, foc, room) => {
    if (S.view === 'page' && S.edit && S.edit.id === r.id) return field(S.edit.text, r.ph, true, room);
    const v = S.v[r.id];
    const ch = r.id in CONFIG_DEFAULTS && v !== CONFIG_DEFAULTS[r.id] ? ' b' : '';
    switch (r.type) {
      case 'choice':
        return plain ? [[`<${v}>`, (foc ? 'acc' : '') + ch]] : [['‹ ', foc ? 'acc' : 'd'], [v, (foc ? 'acc' : '') + ch], [' ›', foc ? 'acc' : 'd']];
      case 'toggle':
        return tog(v === 'on', ch);
      case 'money':
        return [[Number(v) === 0 ? r.zero : `$${Number(v).toFixed(2)} ${r.unit}`, ch.trim()]];
      case 'minutes':
        return [[Number(v) === 0 ? r.zero : `${v} min`, ch.trim()]];
      case 'url':
      case 'path':
        return [[show(r, v), ch.trim()]];
      case 'model': {
        const t = tog(S.on[r.m]);
        t[0][0] = t[0][0].padEnd(plain ? 3 : 5);
        // The id after the switch: for a model known by its id, the name `/model` takes, whole, where the label is its maker's name for it.
        return [...t, [`   ${modelId(r.m)}`, 'd']];
      }
      case 'action':
        return r.text ? [[r.text, 'd']] : [];
      case 'server':
        return allowSummary(r.s);
      case 'tool': {
        const on = allowedBy(S.servers[S.sv].spec, r.t);
        return [[plain ? (on ? 'runs unasked' : 'asks first') : on ? '● runs unasked' : '○ asks first', on ? 'g' : 'd']];
      }
      case 'text':
        return field(S.add[r.id], r.ph, foc, room);
      case 'achoice': {
        const o = r.opts[S.add.login];
        return plain ? [[`<${o}>`, foc ? 'acc' : '']] : [['‹ ', foc ? 'acc' : 'd'], [o, foc ? 'acc' : ''], [' ›', foc ? 'acc' : 'd']];
      }
      case 'pick': {
        const here = S.servers.some((s) => s.name === r.c.name);
        const picked = S.add.picked.has(r.c.name);
        const mark = here || r.c.why ? '[–]' : picked ? '[x]' : '[ ]';
        return [[mark, here || r.c.why ? 'd' : picked ? 'acc' : ''], [`  ${r.c.transport} · ${r.c.shown}${here ? ' · already here' : ''}`, 'd']];
      }
      default:
        return [];
    }
  };
  const optionsOf = (r) => {
    const [opts, cur] = r.type === 'choice' ? [r.opts(), S.v[r.id]] : r.type === 'achoice' ? [r.opts, r.opts[S.add.login]] : [null, null];
    if (!opts) return null;
    const out = [];
    opts.forEach((o, i) => {
      if (i) out.push([' · ', 'd']);
      out.push([o + (r.disabled?.(o) ? ' (off)' : ''), o === cur ? '' : 'd']);
    });
    return out;
  };
  const line = (item, foc, inner, lw) => {
    if (item.head) return [[plain ? `${item.head}:` : item.head, 'b']];
    if (item.note) return fit([[`  ${item.note}`, item.cls ?? 'd']], inner);
    const mark = foc ? [plain ? '> ' : '› ', 'acc'] : ['  ', ''];
    const labCls = item.type === 'danger' ? 'r' : ['add', 'go', 'bring'].includes(item.id) ? 'acc' : foc ? 'b' : '';
    let l = [mark, [pad(item.label, lw), labCls], ...valueOf(item, foc, inner - 2 - lw - 1)];
    const act = foc && item.action && !(S.edit && S.edit.id === item.id) ? item.action : '';
    const opts = optionsOf(item);
    if (opts) {
      const col = 2 + lw + VALUE_WIDTH;
      const base = width(l);
      if (Math.max(base + 2, col) + width(opts) + (act ? len(act) + 2 : 0) <= inner) l = [...l, [' '.repeat(Math.max(2, col - base)), ''], ...opts];
    }
    if (act && width(l) + 2 + len(act) <= inner) l = [...l, [' '.repeat(inner - width(l) - len(act)), ''], [act, 'd']];
    return fit(l, inner);
  };
  /** As many lines as fit, the focused one always among them, with what is above and below counted. */
  const windowed = (lines, fi, max, key) => {
    if (lines.length <= max) {
      S.scroll[key] = 0;
      return lines;
    }
    let start = S.scroll[key] ?? 0;
    for (let guard = 0; guard < 400; guard++) {
      start = Math.max(0, Math.min(start, lines.length - 1));
      const up = start > 0 ? 1 : 0;
      let end = Math.min(lines.length, start + max - up);
      const down = end < lines.length ? 1 : 0;
      end = Math.min(lines.length, start + max - up - down);
      if (fi < start) {
        start = Math.max(0, fi - 1);
        continue;
      }
      if (fi >= end) {
        start += fi - end + 1;
        continue;
      }
      S.scroll[key] = start;
      return [...(up ? [[[`  ↑ ${start} more`, 'd']]] : []), ...lines.slice(start, end), ...(down ? [[[`  ↓ ${lines.length - end} more`, 'd']]] : [])];
    }
    return lines.slice(0, max);
  };
  const framed = (title, body, columns, cls = 'gr') => {
    const inner = columns - 4;
    if (plain) return [...(title ? [[[title, 'b']]] : []), ...body.map((l) => fit(l, columns))];
    const top = title ? [['╭─ ', cls], [title, 'b'], [` ${'─'.repeat(Math.max(0, columns - 5 - len(title)))}╮`, cls]] : [[`╭${'─'.repeat(columns - 2)}╮`, cls]];
    return [top, ...body.map((l) => [['│ ', cls], ...padLine(l, inner), [' │', cls]]), [[`╰${'─'.repeat(columns - 2)}╯`, cls]]];
  };
  const panel = (columns, maxLines) => {
    const spec =
      S.view === 'tools' ? { items: toolItems(), f: S.tf, title: `settings › ${S.servers[S.sv].name}`, lw: 26 }
      : S.view === 'add' ? { items: addItems(), f: S.add.f, title: 'settings › add a server', lw: 21 }
      : { items: pageItems(), f: S.f, title: 'settings', lw: 18 };
    const inner = plain ? columns : columns - 4;
    const lines = [];
    let fi = 0;
    let k = 0;
    for (const it of spec.items) {
      if (it.head || it.note) {
        lines.push(line(it, false, inner, spec.lw));
        continue;
      }
      const foc = k === spec.f;
      if (foc) fi = lines.length;
      lines.push(line(it, foc, inner, spec.lw));
      k++;
    }
    return framed(spec.title, windowed(lines, fi, Math.max(3, maxLines - (plain ? 1 : 2)), S.view), columns);
  };
  const askFrame = (columns) => {
    const a = S.ask;
    if (plain) return [[[`Question: ${a.title}`, 'b y']], [[`  ${a.why}`, 'd']], [[`  ${a.what}`, '']], [[a.keys, 'b']]];
    return framed(null, [[[`⚠ ${a.title}`, 'b y']], [], [[`  ${a.why}`, 'd']], [[`  ${a.what}`, '']], [], [[a.keys, 'b']]], columns, 'y');
  };
  const hintLine = (columns) => {
    const m = S.msg;
    if (m) {
      const cls = m.err ? 'r' : m.ok ? 'g' : m.warn ? 'y' : 'd';
      const mark = m.err ? (plain ? 'x ' : '✗ ') : m.ok ? (plain ? 'ok ' : '✓ ') : m.warn ? '! ' : '';
      return fit([[`  ${mark}${m.err ?? m.ok ?? m.warn ?? m.info}`, cls]], columns);
    }
    const r = focused();
    if (!r) return [];
    let hint = r.hint ?? '';
    if (S.view === 'page' && S.edit) hint = r.type === 'path' ? 'a folder that is there, absolute or under ~' : r.type === 'url' ? 'the whole address of a .gguf file, https://…' : `${r.type === 'money' ? 'dollars, like 5 or 2.50' : 'whole minutes'} — 0 for ${r.zero}`;
    // The default goes first: a long hint is cut at the window's edge, and this is what ⌫ would do.
    else if (r.id in CONFIG_DEFAULTS && S.v[r.id] !== CONFIG_DEFAULTS[r.id]) hint = `default ${show(r, CONFIG_DEFAULTS[r.id])} (⌫) · ${hint}`;
    return fit([[`  ${hint}`, 'd']], columns);
  };
  const keysFor = () => {
    if (S.view === 'ask') return '';
    if (S.view === 'page' && S.edit) return focused()?.type === 'path' ? 'enter keeps it · tab completes · esc puts it back' : 'enter keeps it · esc puts it back';
    if (S.view === 'tools') return '↑↓ move · ←→ switch · a all · esc back';
    if (S.view === 'add') return '↑↓ move · type or paste · ←→ login · space picks · esc back';
    return '↑↓ move · ←→ change · enter edit · ⌫ default · esc close';
  };

  // ── what a key does ──
  function set(r, value) {
    const old = S.v[r.id];
    if (old === value) return;
    if (r.id === 'model.url') return fetchFirst(r, old, value);
    try {
      config(r.id, value);
    } catch (cause) {
      return err(cause.message);
    }
    S.v[r.id] = value;
    S.msg = { ok: `saved · ${r.label.toLowerCase()}: ${show(r, old)} → ${show(r, value)}${r.when ? ` · ${r.when}` : ''}` };
    if (r.id === 'shell.sandbox' && value === 'off') S.msg = { warn: "saved · sandbox off from the next chat — the model's shell can write anywhere you can" };
    // Only what changed moves in the chat: a model picked there with /model stays when the effort changes, and the
    // effort it is on when the model does (`/model <model>` keeps it). A chat on auto has the router pick its effort.
    if ((r.id === 'chat.model' || r.id === 'chat.effort') && live.route) {
      try {
        const now = live.current();
        if (r.id === 'chat.model') live.route(value);
        else if (now.model === 'auto') S.msg = { ok: `saved · ${r.label.toLowerCase()}: ${show(r, old)} → ${show(r, value)} · this chat is on auto, which picks the effort each turn` };
        else live.route(`${now.model} ${value}`);
      } catch (cause) {
        S.msg = { warn: `saved for new chats; this one did not switch: ${cause.message}` };
      }
    }
  }
  /**
   * A new local model, downloaded first and stored only once it is here (`download` stores it then, and stops the
   * server that ran the old one): until then, and for good if it never comes, the model in use stays in use.
   */
  function fetchFirst(r, old, value) {
    try {
      modelUrlOrRefuse(value);
    } catch (cause) {
      return err(cause.message);
    }
    S.msg = { info: `downloading ${show(r, value)}… — the model in use stays until it is here` };
    const done = Promise.resolve(download(value)).then(
      (got) => {
        if (got?.ok) S.v[r.id] = value;
        S.fetching = null;
        return got;
      },
      (cause) => {
        S.fetching = null;
        throw cause;
      },
    );
    S.fetching = { from: show(r, old), to: show(r, value), done };
    later(done, (got, cause) => {
      const said = String(cause?.message ?? got?.line ?? '').replace(/^model\s+/, '');
      S.msg = got?.ok ? { ok: `saved · ${r.label.toLowerCase()}: ${show(r, old)} → ${show(r, value)} · ${said}` } : { err: said || 'the download failed' };
    });
  }
  function change(r, d) {
    if (r.type === 'choice') {
      const o = r.opts();
      let i = o.indexOf(S.v[r.id]);
      for (let n = 0; n < o.length; n++) {
        i = (i + d + o.length) % o.length;
        if (!r.disabled?.(o[i])) break;
      }
      return set(r, o[i]);
    }
    if (r.type === 'toggle') return flip(r);
    if (r.type === 'money' || r.type === 'minutes') return set(r, String(Math.max(0, Math.round((Number(S.v[r.id]) + d * r.step) * 100) / 100)));
    if (r.type === 'model') return flipModel(r.m);
    S.msg = { info: r.type === 'server' || r.type === 'action' ? 'enter opens it' : 'enter changes it' };
  }
  function flip(r) {
    if (r.id === 'shell.sandbox' && S.v[r.id] === 'on') {
      S.ask = { title: 'Turn the sandbox off?', why: "the model's shell could then write anywhere you can, from the next chat on", what: 'Sandbox   on → off', keys: 'y turn it off · n keep it on', yes: () => set(r, 'off'), no: () => (S.msg = { info: 'the sandbox stays on' }), back: 'page' };
      S.view = 'ask';
      return;
    }
    set(r, S.v[r.id] === 'on' ? 'off' : 'on');
  }
  function flipModel(m) {
    if (S.on[m]) {
      const users = [['chat.model', "the chat's model"], ['jobs.floor', "the jobs' smallest model"], ['memory.model', 'the model that files memory']].filter(([k]) => S.v[k] === m);
      if (users.length > 0) return err(`${m} is ${users[0][1]} — pick another there first`);
      // A Claude model stays on: the chat and the memory pass run on nothing else. Cursor's are for jobs, and may all be off.
      if (MODELS.includes(m) && MODELS.filter((x) => S.on[x]).length === 1) return err('one model stays on: chats and jobs need one');
    }
    setModel(db, m, !S.on[m]);
    S.on = switches();
    S.msg = { ok: S.on[m] ? `saved · ${m} on` : `saved · ${m} off · no longer offered anywhere` };
  }
  function reset(r) {
    if (!(r.id in CONFIG_DEFAULTS)) return void (S.msg = { info: r.type === 'model' ? 'a model has no default — Discover sets the switches from what this login can use' : 'nothing to put back here' });
    if (S.v[r.id] === CONFIG_DEFAULTS[r.id]) return void (S.msg = { info: `already the default (${show(r, CONFIG_DEFAULTS[r.id])})` });
    if (r.disabled?.(CONFIG_DEFAULTS[r.id])) return err(`the default, ${CONFIG_DEFAULTS[r.id]}, is off — turn it on under API models first`);
    set(r, CONFIG_DEFAULTS[r.id]);
  }
  function openTools(r) {
    S.sv = r.i;
    S.tf = 0;
    S.tools = null;
    S.view = 'tools';
    S.scroll.tools = 0;
    const { name, spec } = S.servers[r.i];
    later(toolsOf(name, spec), (names, cause) => {
      S.tools = cause ? { error: String(cause.message).split('\n')[0] } : { names };
    });
  }
  function activate(r) {
    switch (r.type) {
      case 'choice':
      case 'toggle':
      case 'model':
        return change(r, 1);
      case 'money':
      case 'minutes':
      case 'url':
        S.edit = { id: r.id, text: '' };
        return;
      case 'path':
        S.edit = { id: r.id, text: S.v[r.id] };
        return;
      case 'server':
        return openTools(r);
    }
    if (r.id === 'discover') {
      S.msg = { info: 'asking Anthropic and Cursor which models this login can use, and fetching list prices…' };
      // Each is asked on its own: Cursor needs only its key, and the prices no login at all. One that fails is said, never thrown.
      const settled = (work) => Promise.resolve().then(work).catch((cause) => ({ ok: false, error: cause.message }));
      // The prices are read for the models just listed, so they are fetched once both have answered.
      const asked = Promise.all([discover(db), settled(() => cursor(db))]);
      later(asked.then(async (both) => [...both, await settled(() => prices(db))]), (all, cause) => {
        S.on = switches();
        if (cause) {
          S.msg = { err: cause.message };
          return;
        }
        const [found, fromCursor, priced] = all;
        const said = `${found.ok ? discoverySummary(found) : found.error} — ${cursorSummary(fromCursor)} — ${pricesSummary(priced)}`;
        S.msg = found.ok ? { ok: said } : { err: said };
      });
    }
    if (r.id === 'add') {
      let known = [];
      try {
        known = claude();
      } catch {
        known = [];
      }
      S.add = { addr: '', name: '', nameTouched: false, login: 0, cred: '', picked: new Set(), f: 0, claude: known };
      S.view = 'add';
      S.scroll.add = 0;
    }
  }
  /** What was typed into a row, saved — or refused with why, the row still open to put it right. */
  function commit(r, raw) {
    const t = raw.trim();
    if (!t) return err(r.type === 'url' ? 'paste the whole address of a .gguf file, https://…/<file>.gguf' : 'nothing typed — esc puts it back as it was');
    const number = (r.type === 'money' || r.type === 'minutes') && /^\d+(\.\d+)?$/.test(t);
    set(r, r.type === 'path' && t.length > 1 ? t.replace(/\/+$/, '') : number ? String(Number(t)) : t);
    if (!S.msg?.err) S.edit = null;
  }
  /** Tab on a folder: the one folder it can only be, or as far as they all agree. */
  function complete(e) {
    const typed = e.text;
    const full = typed.replace(/^~(?=$|\/)/, homedir());
    const at = full.lastIndexOf('/');
    const dir = at === -1 ? '.' : full.slice(0, at) || '/';
    const stem = full.slice(at + 1);
    let names = [];
    try {
      // Each name on its own: a link that leads nowhere is no folder, and no reason the others are not.
      const isFolder = (n) => {
        try {
          return statSync(join(dir, n)).isDirectory();
        } catch {
          return false;
        }
      };
      names = readdirSync(dir).filter((n) => n.startsWith(stem) && (stem.startsWith('.') || !n.startsWith('.')) && isFolder(n));
    } catch {
      names = [];
    }
    if (names.length === 0) return void (S.msg = { info: `no folder starts with ${typed}` });
    let common = names[0];
    for (const n of names) while (!n.startsWith(common)) common = common.slice(0, -1);
    e.text = typed.slice(0, typed.length - stem.length) + common + (names.length === 1 ? '/' : '');
    if (names.length > 1) S.msg = { info: names.slice(0, 8).join(' · ') + (names.length > 8 ? ` · and ${names.length - 8} more` : '') };
  }
  function typeInto(r, text) {
    const a = S.add;
    a[r.id] += text;
    if (r.id === 'addr' && !a.nameTouched) a.name = nameFrom(a.addr);
    if (r.id === 'name') a.nameTouched = true;
  }
  /** What was pasted and picked on the add view, as the server Sumo would run; a token typed in is refused, never stored. */
  function specOf(a) {
    const addr = a.addr.trim();
    const http = /^https?:\/\//i.test(addr);
    if (!addr) throw new Error('paste a command or an address first');
    const cred = a.cred.trim();
    if (http) {
      if (a.login === 1) return { url: addr, token: CLAUDE_CODE_TOKEN };
      if (a.login === 2) {
        const m = /^([^:\s]+)\s*:\s*(.+)$/.exec(cred);
        if (!m) throw new Error('the header, as Name: value — with ${NAME} where the token goes');
        if (!NAMED.test(m[2])) throw new Error('a token typed here would be stored — write ${NAME} and keep the token in your shell');
        return { url: addr, headers: { [m[1]]: m[2] } };
      }
      return { url: addr };
    }
    const [command, ...args] = wordsOf(addr);
    if (a.login === 1) {
      const pairs = wordsOf(cred).map((p) => /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(p));
      if (pairs.length === 0 || pairs.some((p) => !p)) throw new Error('variables as NAME=${NAME}, one or more');
      if (pairs.some((p) => !NAMED.test(p[2]) && redact(p[2]).count > 0)) throw new Error('a token typed here would be stored — write ${NAME} and keep the token in your shell');
      return { command, args, env: Object.fromEntries(pairs.map((p) => [p[1], p[2]])) };
    }
    return { command, args };
  }
  /** A server joins: its tools listed once, each asking first. One that will not connect is kept, and why is said. */
  function joined(name, spec) {
    S.servers = serversNow();
    S.log.push(`${name} added`);
    S.view = 'page';
    S.add = null;
    S.f = focusables(pageItems()).findIndex((x) => x.id === `server:${name}`);
    S.msg = { info: `connecting to ${name}…` };
    const next = live.route ? ' · this chat connects it when it starts again' : '';
    later(toolsOf(name, spec), (names, cause) => {
      S.msg = cause ? { warn: `${name} is added, but it did not connect: ${String(cause.message).split('\n')[0]}` } : { ok: `${name}: ${names.length} tools, each asks first until you switch it here${next}` };
    });
  }
  function addOwn() {
    const a = S.add;
    let spec;
    try {
      spec = specOf(a);
      addServer(a.name.trim(), spec);
    } catch (cause) {
      return err(cause.message);
    }
    joined(a.name.trim(), spec);
  }
  function bring() {
    const picked = S.add.claude.filter((c) => S.add.picked.has(c.name));
    if (picked.length === 0) return err('pick one first: space on its row');
    const brought = [];
    for (const c of picked) {
      try {
        addServer(c.name, c.spec);
        brought.push(c.name);
        S.log.push(`${c.name} brought in`);
      } catch (cause) {
        return err(`${c.name}: ${cause.message}`);
      }
    }
    S.servers = serversNow();
    S.view = 'page';
    S.add = null;
    S.f = focusables(pageItems()).findIndex((x) => x.id === `server:${brought[0]}`);
    S.msg = { ok: `brought in from Claude Code: ${brought.join(', ')} · each tool asks first` };
  }
  function toggleTool(s, t) {
    const on = allowedBy(s.spec, t);
    // Changed elsewhere meanwhile — removed by another sumo, say — is said, like a remove or an add that fails.
    try {
      setAllow(s.name, t, !on, S.tools.names);
      S.servers = serversNow();
    } catch (cause) {
      return err(cause.message);
    }
    if (!S.log.includes(`${s.name} allow list`)) S.log.push(`${s.name} allow list`);
    S.msg = { ok: `${t} ${on ? 'asks first again' : 'runs without asking'}${live.route ? ' · from the next chat' : ''}` };
  }

  function onPage(k) {
    const its = focusables(pageItems());
    const r = its[S.f];
    switch (k) {
      case 'up':
        S.f = Math.max(0, S.f - 1);
        return;
      case 'down':
        S.f = Math.min(its.length - 1, S.f + 1);
        return;
      case 'left':
        return change(r, -1);
      case 'right':
        return change(r, 1);
      case 'enter':
      case 'space':
        return activate(r);
      case 'backspace':
        return reset(r);
      case 'escape':
        return close();
    }
    if (/^\d$/.test(k) && (r.type === 'money' || r.type === 'minutes')) {
      S.edit = { id: r.id, text: k };
      return;
    }
    S.msg = { info: `the keys: ${keysFor()}` };
  }
  function onEdit(k) {
    const r = focused();
    const e = S.edit;
    if (k === 'escape') {
      S.edit = null;
      S.msg = { info: 'put back as it was' };
    } else if (k === 'enter') commit(r, e.text);
    else if (k === 'backspace') e.text = e.text.slice(0, -1);
    else if (k === 'tab') {
      if (r.type === 'path') complete(e);
    } else if (k === 'space') e.text += ' ';
    else if (len(k) === 1) e.text += k;
  }
  function onTools(k) {
    const its = focusables(toolItems());
    const r = its[S.tf];
    const s = S.servers[S.sv];
    if (k === 'up') S.tf = Math.max(0, S.tf - 1);
    else if (k === 'down') S.tf = Math.min(its.length - 1, S.tf + 1);
    else if (k === 'escape') {
      S.view = 'page';
      generation++;
    } else if (k === 'a' || k === 'A') {
      if (!S.tools?.names?.length) return err('no tools to switch: it has not connected');
      const every = s.spec.allow === 'all' || S.tools.names.every((t) => allowedBy(s.spec, t));
      try {
        setAllow(s.name, 'all', !every);
        S.servers = serversNow();
      } catch (cause) {
        return err(cause.message);
      }
      if (!S.log.includes(`${s.name} allow list`)) S.log.push(`${s.name} allow list`);
      S.msg = every ? { ok: `every ${s.name} tool asks first again` } : { warn: `every ${s.name} tool runs without asking — new ones it adds too` };
    } else if (['left', 'right', 'enter', 'space'].includes(k) && r?.type === 'tool') toggleTool(s, r.t);
    else if ((k === 'enter' || k === 'space') && r?.type === 'danger') {
      S.ask = {
        title: `Remove ${s.name}?`,
        why: 'its allow list goes with it — added again, every tool asks first',
        what: s.spec.url ?? [s.spec.command, ...(s.spec.args ?? [])].join(' '),
        keys: 'y remove it · n keep it',
        yes: () => {
          try {
            removeServer(s.name);
          } catch (cause) {
            return err(cause.message);
          }
          S.servers = serversNow();
          S.log.push(`${s.name} removed`);
          S.view = 'page';
          S.f = Math.min(S.f, focusables(pageItems()).length - 1);
          S.msg = { ok: `${s.name} removed` };
        },
        no: () => (S.msg = { info: `${s.name} stays` }),
        back: 'tools',
      };
      S.view = 'ask';
    } else if (len(k) === 1) S.msg = { info: `the keys: ${keysFor()}` };
  }
  function onAdd(k) {
    const a = S.add;
    const its = focusables(addItems());
    const r = its[a.f];
    if (k === 'escape') {
      S.view = 'page';
      S.add = null;
      S.msg = { info: 'nothing added' };
      return;
    }
    if (k === 'up') return void (a.f = Math.max(0, a.f - 1));
    if (k === 'down' || k === 'tab') return void (a.f = Math.min(its.length - 1, a.f + 1));
    if (r.type === 'text') {
      if (k === 'enter') a.f = Math.min(its.length - 1, a.f + 1);
      else if (k === 'backspace') {
        a[r.id] = a[r.id].slice(0, -1);
        if (r.id === 'addr' && !a.nameTouched) a.name = nameFrom(a.addr);
        if (r.id === 'name') a.nameTouched = true;
      } else if (k === 'space') typeInto(r, ' ');
      else if (len(k) === 1) typeInto(r, k);
      return;
    }
    if (r.type === 'achoice' && ['left', 'right', 'enter', 'space'].includes(k)) {
      a.login = (a.login + (k === 'left' ? -1 : 1) + r.opts.length) % r.opts.length;
      return;
    }
    if (r.type === 'pick' && ['left', 'right', 'enter', 'space'].includes(k)) {
      if (S.servers.some((s) => s.name === r.c.name)) return void (S.msg = { info: `${r.c.name} is already here` });
      if (r.c.why) return err(r.c.why);
      if (a.picked.has(r.c.name)) a.picked.delete(r.c.name);
      else a.picked.add(r.c.name);
      return;
    }
    if (r.id === 'go' && (k === 'enter' || k === 'space')) return addOwn();
    if (r.id === 'bring' && (k === 'enter' || k === 'space')) return bring();
    if (len(k) === 1) S.msg = { info: `the keys: ${keysFor()}` };
  }
  function onAsk(k) {
    const a = S.ask;
    if (k === 'y' || k === 'Y' || k === 'n' || k === 'N' || k === 'escape') {
      S.view = a.back;
      S.ask = null;
      if (k === 'y' || k === 'Y') a.yes();
      else a.no();
      return;
    }
    S.msg = { info: `y or n — ${a.keys}` };
  }
  function close() {
    S.closed = true;
    generation++;
    db.close();
  }

  return {
    /** A key, by the page's name for it (`keyName`). True once the page has closed. */
    key(k) {
      if (S.closed || k === null) return S.closed;
      // While something slow is under way only Esc is taken: it goes back, and the answer, when it comes, is dropped.
      if (busy() && k !== 'escape') return false;
      if (busy() && S.view === 'page') generation++;
      S.msg = null;
      if (S.view === 'ask') onAsk(k);
      else if (S.view === 'tools') onTools(k);
      else if (S.view === 'add') onAdd(k);
      else if (S.edit) onEdit(k);
      else onPage(k);
      return S.closed;
    },
    /** Pasted text goes into the field being typed in — and with nothing being typed, into a new server's address. */
    paste(text) {
      const t = String(text).replace(/\s*\n\s*/g, ' ').trim();
      if (S.closed || busy() || !t) return;
      if (S.view === 'page' && S.edit) {
        S.edit.text += t;
        return;
      }
      if (S.view === 'page') {
        activate({ id: 'add', type: 'action' });
        S.f = focusables(pageItems()).findIndex((x) => x.id === 'add');
      }
      if (S.view !== 'add') return;
      const r = focusables(addItems())[S.add.f];
      typeInto(r.type === 'text' ? r : focusables(addItems())[0], t);
    },
    /** The page as lines of `[text, tone]`, `columns` wide and at most `rows` tall: the frame, the hint under it, the keys. */
    lines({ columns, rows, plain: bare = false }) {
      plain = bare;
      const left = live.left?.() ?? '';
      const keys = keysFor();
      const leftShown = left && len(left) + 4 + len(trimKeys(keys, columns - 4)) <= columns ? left : '';
      const k = trimKeys(keys, columns - 2 - (leftShown ? len(leftShown) + 2 : 0));
      const foot = [hintLine(columns), leftShown ? [[`  ${leftShown}`, 'd'], [' '.repeat(Math.max(2, columns - 2 - len(leftShown) - len(k))), ''], [k, 'd']] : [[`  ${k}`, 'd']]];
      const body = S.view === 'ask' ? askFrame(columns) : panel(columns, rows - foot.length);
      return [...body, ...foot].map((l) => fit(l, columns));
    },
    /** What changed while the page was open, in a line for the chat's scrollback or `sumo config`'s output. */
    summary() {
      const out = [];
      for (const [, rows] of sections()) {
        for (const r of rows) if (r.id in snap.v && snap.v[r.id] !== S.v[r.id]) out.push(`${r.label.toLowerCase()} ${show(r, snap.v[r.id])} → ${show(r, S.v[r.id])}`);
      }
      for (const m of Object.keys(S.on)) if (snap.on[m] !== S.on[m]) out.push(`${m} ${S.on[m] ? 'on' : 'off'}`);
      if (S.fetching) out.push(`local model ${S.fetching.from} → ${S.fetching.to} once it has downloaded — the one in use stays until then`);
      return [...out, ...S.log];
    },
    /** A local model still downloading — what it is, and the promise of how it went — or null. */
    get fetching() {
      return S.fetching;
    },
    get closed() {
      return S.closed;
    },
  };
}

const toneOf = (cls) => Object.assign({}, ...String(cls ?? '').split(' ').filter(Boolean).map((c) => TONES[c] ?? {}));

/** The page's lines on an Ink screen. */
export function SettingsView({ page, columns, rows, plain = false }) {
  const lines = page.lines({ columns, rows, plain });
  const drawn = (t, c) => (String(c ?? '').split(' ').includes('v') ? reverse(t) : t);
  return h(Box, { flexDirection: 'column' }, ...lines.map((l, i) => h(Text, { key: i, wrap: 'truncate' }, ...(l.length === 0 ? [' '] : l.map(([t, c], j) => h(Text, { key: j, ...toneOf(c) }, drawn(t, c)))))));
}

/**
 * `sumo config` at a terminal: the page on its own, until Esc; then what changed, said once. A local model still
 * downloading is said and waited for — Ctrl-C stops it, and the model in use stays. `options` are the page's.
 */
export async function runSettings({ stdin = process.stdin, stdout = process.stdout, plain = false, ...options } = {}) {
  let wake = () => {};
  function App() {
    const { exit } = useApp();
    const { columns, rows } = useWindowSize();
    const [, redraw] = useReducer((n) => n + 1, 0);
    wake = redraw;
    useInput((input, key) => {
      if (page.key(keyName(input, key))) return exit();
      redraw();
    });
    usePaste((text) => {
      page.paste(text);
      redraw();
    });
    // One row short of the window: Ink draws a frame that fills it as a full screen, wiping what was above.
    return h(SettingsView, { page, columns, rows: Math.max(8, rows - 1), plain });
  }
  const page = settingsPage({ ...options, onChange: () => wake() });
  const app = render(h(App), { stdin, stdout, exitOnCtrlC: false, interactive: Boolean(stdout.isTTY) });
  await app.waitUntilExit();
  const pending = page.fetching;
  let failed = null;
  if (pending) {
    stdout.write(`still downloading ${pending.to} — the model in use stays until it is here; Ctrl-C stops it and changes nothing\n`);
    const got = await pending.done.catch((cause) => ({ ok: false, line: cause.message }));
    if (!got?.ok) failed = `not saved: local model ${pending.to} — ${String(got?.line ?? '').replace(/^model\s+/, '')}`;
  }
  const changed = page.summary().map((c) => `saved: ${c}`);
  if (failed) changed.push(failed);
  return changed.length > 0 ? changed : ['nothing changed'];
}

