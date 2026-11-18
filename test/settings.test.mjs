// The settings page: every setting on one page, changed with the keys and saved as it changes — no file to edit, and no
// setting typed by name.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelStates } from '../src/catalog.mjs';
import { createChat } from '../src/chat.mjs';
import { getMeta, openDb } from '../src/db.mjs';
import { addServer, readConfig } from '../src/mcp.mjs';
import { claudeCodeServers, nameFrom, settingsPage } from '../src/settings.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-11-18T12:00:00.000Z';
const ESC = '\x1b';
const DOWN = '\x1b[B';
const RIGHT = '\x1b[C';

/** The page as a terminal would show it, colours aside. */
const shown = (page, { columns = 100, rows = 60, plain = false } = {}) => page.lines({ columns, rows, plain }).map((l) => l.map(([t]) => t).join('')).join('\n');
const press = (page, ...keys) => keys.forEach((k) => page.key(k));
/** Down from the top until the row named is the one picked. */
function onRow(page, label) {
  press(page, ...Array(60).fill('up'));
  for (let i = 0; i < 60; i++) {
    if (new RegExp(`› ${label}\\s`).test(shown(page))) return;
    page.key('down');
  }
  assert.fail(`no row "${label}" on the page:\n${shown(page)}`);
}
const setting = (key) => {
  const db = openDb();
  try {
    return getMeta(db, `config.${key}`);
  } finally {
    db.close();
  }
};
/** What the page waits on — a server's tools, a download — answered. */
const settle = () => new Promise((r) => setTimeout(r, 20));
const page = (options = {}) => settingsPage({ toolsOf: async () => ['search', 'get_issue'], download: async () => 'model     downloaded', claude: () => [], ...options });

test('every setting is on one page, and a change made with the arrow keys is saved at once, what it was and is now said under the frame', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    const screen = shown(p);
    assert.match(screen, /^╭─ settings ─+╮$/m, 'one framed page');
    for (const row of ['Model', 'Effort', 'Spend notice', 'Notify', 'Screen', 'Smallest model', 'Budget', 'Time limit', 'Review', 'Advisor', 'Filed by', 'Local model', 'Sandbox', 'Network', 'New ones go in', 'Haiku', 'Fable', 'Discover', '\\+ add a server']) {
      assert.match(screen, new RegExp(`│ [› ] ${row}`), `${row} is on it`);
    }
    assert.match(screen, /↑↓ move · ←→ change · enter edit · ⌫ default · esc close/, 'and the keys, once');
    onRow(p, 'Effort');
    p.key('right');
    assert.equal(setting('chat.effort'), 'high', 'stored the moment it changed');
    assert.match(shown(p), /✓ saved · effort: medium → high/);
    onRow(p, 'Review');
    p.key('left');
    assert.equal(setting('jobs.review'), 'off', 'a choice goes round both ways');
    assert.match(shown(p), /✓ saved · review: risky → off · jobs from now on/, 'and says when it takes effect');
    p.key('escape');
    assert.equal(p.closed, true, 'Esc closes it');
    assert.deepEqual(p.summary(), ['effort medium → high', 'review risky → off'], 'what changed while it was open');
  });
});

test('a value the checks refuse is never stored: the reason stands in red, and the row stays open to put it right', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    onRow(p, 'Budget');
    press(p, '2', '5', 'x', 'enter');
    assert.equal(setting('jobs.budget'), null, 'nothing stored');
    assert.match(shown(p), /✗ jobs\.budget needs a number of dollars/, 'the same check `config()` has always made');
    assert.match(shown(p), /Budget\s+25x/, 'what was typed is still there to fix');
    press(p, 'backspace', 'enter');
    assert.equal(setting('jobs.budget'), '25');
    assert.match(shown(p), /✓ saved · budget: \$10\.00 → \$25\.00/);
    press(p, 'left', 'left');
    assert.equal(setting('jobs.budget'), '23', '←→ step it by a dollar');
    onRow(p, 'New ones go in');
    press(p, 'enter', 'backspace', ...'/no/such/folder', 'enter');
    assert.equal(setting('projects.home'), null);
    assert.match(shown(p), /✗ \/no\/such\/folder is not a directory/);
    press(p, 'escape');
    assert.match(shown(p), /put back as it was/);
  });
});

test('turning the sandbox off asks first in its own frame, a wrong key says the keys, and only y turns it off', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    onRow(p, 'Sandbox');
    p.key('left');
    assert.match(shown(p), /^╭─+╮\n│ ⚠ Turn the sandbox off\? +│/m, 'the question, framed');
    assert.equal(setting('shell.sandbox'), null, 'nothing yet');
    p.key('q');
    assert.match(shown(p), /y or n — y turn it off · n keep it on/, 'a wrong key explains the keys and does nothing');
    p.key('n');
    assert.equal(setting('shell.sandbox'), null, 'n keeps it on');
    assert.match(shown(p), /the sandbox stays on/);
    p.key('left');
    p.key('y');
    assert.equal(setting('shell.sandbox'), 'off');
    assert.match(shown(p), /! saved · sandbox off from the next chat — the model's shell can write anywhere you can/);
    p.key('backspace');
    assert.equal(setting('shell.sandbox'), 'on', 'back on, by its default, without a question');
  });
});

test('⌫ puts a setting back to its default, and a model something uses cannot be turned off under it', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    onRow(p, 'Time limit');
    p.key('right');
    assert.equal(setting('jobs.minutes'), '75', '←→ step the minutes by 15');
    press(p, 'down', 'up');
    assert.match(shown(p), /default 60 min \(⌫\)/, 'a changed row says its default');
    p.key('backspace');
    assert.equal(setting('jobs.minutes'), '60');
    p.key('backspace');
    assert.match(shown(p), /already the default \(60 min\)/);
    onRow(p, 'Opus');
    p.key('left');
    assert.match(shown(p), /✗ opus is the chat's model — pick another there first/);
    const db = openDb();
    try {
      assert.equal(modelStates(db).opus.on, true, 'still on');
    } finally {
      db.close();
    }
    onRow(p, 'Fable');
    p.key('left');
    const after = openDb();
    try {
      assert.equal(modelStates(after).fable.on, false, 'one nothing uses goes off');
    } finally {
      after.close();
    }
    onRow(p, 'Model');
    p.key('right');
    assert.equal(setting('chat.model'), 'auto', 'the chat model steps over a model that is off: after opus, fable is skipped, round to auto');
  });
});

test('in the chat the page switches the chat it was opened in too, and says so', async () => {
  await withHome(freshHome(), {}, async () => {
    const routed = [];
    const p = page({ live: { route: (to) => routed.push(to), servers: () => [], left: () => 'opus · medium   shop (main)' } });
    assert.match(shown(p), /^ {2}opus · medium {3}shop \(main\) +↑↓ move/m, 'the chat\'s status beside the keys');
    onRow(p, 'Effort');
    p.key('right');
    onRow(p, 'Model');
    p.key('left');
    assert.deepEqual(routed, ['opus high', 'sonnet high']);
    assert.match(shown(p), /✓ saved · model: opus → sonnet · this chat too/);
  });
});

test('a server is added by pasting its address and picking a login; a token typed in is refused, and never stored', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    p.paste('https://mcp.linear.app/mcp');
    let screen = shown(p);
    assert.match(screen, /settings › add a server/, 'a paste with nothing being typed is a new server\'s address');
    assert.match(screen, /Command or address\s+https:\/\/mcp\.linear\.app\/mcp/);
    assert.match(screen, /Name\s+linear/, 'its name read from the address');
    press(p, 'down', 'down', 'right', 'right');
    assert.match(shown(p), /‹ a header ›/);
    press(p, 'down');
    p.paste('Authorization: Bearer lin_api_8f2kQ9xZ2mL4pR7tY1wE');
    press(p, 'down', 'enter');
    assert.match(shown(p), /✗ a token typed here would be stored — write \$\{NAME\} and keep the token in your shell/);
    assert.equal(readConfig().mcpServers.linear, undefined, 'nothing added');
    press(p, 'up', ...Array(60).fill('backspace'));
    p.paste('Authorization: Bearer ${LINEAR_TOKEN}');
    press(p, 'down', 'enter');
    assert.deepEqual(readConfig().mcpServers.linear, { url: 'https://mcp.linear.app/mcp', headers: { Authorization: 'Bearer ${LINEAR_TOKEN}' } });
    await settle();
    screen = shown(p);
    assert.match(screen, /✓ linear: 2 tools, each asks first until you switch it here/);
    assert.match(screen, /› linear\s+http · all ask first/, 'back on the page, on the new server');
    assert.deepEqual(p.summary(), ['linear added']);
  });
});

test("a server's tools are switched one at a time or all at once, and removing it asks first", async () => {
  await withHome(freshHome(), {}, async () => {
    addServer('demo', { command: 'demo-server', args: [] });
    const p = page({ toolsOf: async () => ['echo', 'add'] });
    onRow(p, 'demo');
    p.key('enter');
    await settle();
    assert.match(shown(p), /settings › demo/);
    assert.match(shown(p), /› echo\s+○ asks first/);
    p.key('right');
    assert.deepEqual(readConfig().mcpServers.demo.allow, ['echo']);
    assert.match(shown(p), /✓ echo runs without asking/);
    p.key('a');
    assert.equal(readConfig().mcpServers.demo.allow, 'all', 'a: every tool, new ones too');
    assert.match(shown(p), /! every demo tool runs without asking — new ones it adds too/);
    p.key('space');
    assert.deepEqual(readConfig().mcpServers.demo.allow, ['add'], 'one taken off "all" leaves the others on');
    press(p, 'down', 'down', 'enter');
    assert.match(shown(p), /⚠ Remove demo\?/);
    p.key('y');
    assert.equal(readConfig().mcpServers.demo, undefined);
    assert.match(shown(p), /✓ demo removed/);
  });
});

test("servers Claude Code knows are brought in with its login; one whose file holds a token is listed but cannot be", async () => {
  await withHome(freshHome(), {}, async () => {
    const dir = mkdtempSync(join(tmpdir(), 'sumo-claude-'));
    writeFileSync(
      join(dir, '.claude.json'),
      JSON.stringify({
        mcpServers: {
          sentry: { type: 'http', url: 'https://mcp.sentry.dev/mcp' },
          github: { type: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } },
          leaky: { type: 'http', url: 'https://x.example.com/mcp', headers: { Authorization: 'Bearer sk-ant-api03-abcdefghijklmnopqrstuvwxyz' } },
        },
        projects: { '/work/here': { mcpServers: { local: { type: 'stdio', command: 'node', args: ['server.js'] } } } },
      }),
    );
    const found = claudeCodeServers('/work/here', { CLAUDE_CONFIG_DIR: dir });
    assert.deepEqual(found.map((c) => c.name), ['sentry', 'github', 'leaky', 'local'], "Claude Code's own and this project's");
    assert.deepEqual(found[0].spec, { url: 'https://mcp.sentry.dev/mcp', token: 'claude-code' }, 'an address with no header borrows its login');
    assert.deepEqual(found[1].spec, { command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: '${GITHUB_TOKEN}' } });
    assert.match(found[2].why, /holds a token/);
    assert.deepEqual(claudeCodeServers('/work/here', { CLAUDE_CONFIG_DIR: join(dir, 'none') }), [], 'no file is no servers');

    const p = page({ claude: () => found });
    onRow(p, '\\+ add a server');
    p.key('enter');
    assert.match(shown(p), /Or bring one in from Claude Code/);
    press(p, ...Array(4).fill('down'), 'space', 'down', 'down', 'space');
    assert.match(shown(p), /✗ its header holds a token in Claude Code's file/, 'refused, with why');
    press(p, 'down', 'down', 'enter');
    assert.deepEqual(Object.keys(readConfig().mcpServers), ['sentry']);
    assert.match(shown(p), /✓ brought in from Claude Code: sentry/);
  });
});

test("a server's name is read from what was pasted: the address's host, or the command's package", () => {
  assert.equal(nameFrom('https://mcp.linear.app/mcp'), 'linear');
  assert.equal(nameFrom('https://mcp.slack.com/mcp'), 'slack');
  assert.equal(nameFrom('npx -y @modelcontextprotocol/server-github'), 'github');
  assert.equal(nameFrom('npx -y @azure-devops/mcp myorg'), 'azure-devops');
  assert.equal(nameFrom('uvx mcp-server-fetch@1.2.0'), 'server-fetch');
  assert.equal(nameFrom(''), '');
});

test('the page fits any window: rows are cut, never wrapped, and a page taller than the window scrolls with the picked row in view', async () => {
  await withHome(freshHome(), {}, async () => {
    const p = page();
    for (const columns of [60, 80, 120]) {
      const lines = shown(p, { columns, rows: 18 }).split('\n');
      assert.ok(lines.every((l) => [...l].length <= columns), `every row inside ${columns} columns`);
      assert.ok(lines.length <= 18, 'and inside the window');
    }
    assert.match(shown(p, { rows: 18 }), /↓ \d+ more/);
    press(p, ...Array(40).fill('down'));
    const bottom = shown(p, { rows: 18 });
    assert.match(bottom, /› \+ add a server/, 'the last row, brought into view');
    assert.match(bottom, /↑ \d+ more/);
    assert.doesNotMatch(shown(p, { columns: 60 }), /auto · haiku/, 'a narrow window drops the list of choices first');
  });
});

test('plain, for a screen reader: no frame, the pick marked with >, values in words', async () => {
  await withHome(freshHome(), {}, async () => {
    const screen = shown(page(), { plain: true });
    assert.doesNotMatch(screen, /[╭│╰●○‹›]/);
    assert.match(screen, /^settings\nChat:\n> Model +<opus>/m);
    assert.match(screen, /Notify +on/);
  });
});

test('/config in the chat opens the page in the box\'s place, Esc gives the box back, and one line says what changed', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    const events = new EventEmitter();
    const session = createChat(db, { model: 'opus', effort: 'medium', cwd: tmpdir(), send: async () => assert.fail('no model is asked'), out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => NOW });
    const tty = fakeTty({ columns: 100, rows: 40 });
    const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', debug: true });
    const shows = async (pattern, what) => {
      for (let i = 0; i < 300; i++) {
        if (pattern.test(tty.screen())) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      assert.fail(`the screen never showed ${what}:\n${tty.screen()}`);
    };
    try {
      await shows(/opus · medium/, 'the status row');
      await tty.type('/config', '\r');
      await shows(/╭─ settings ─+╮/, 'the page');
      assert.doesNotMatch(tty.screen(), /│ > /, 'no box to type in while it is open');
      assert.match(tty.screen(), /opus · medium {3}\S+ +↑↓ move/, "the chat's route beside the page's keys");
      await tty.type(DOWN, RIGHT);
      await shows(/✓ saved · effort: medium → high · this chat too/, 'the change saved');
      assert.equal(setting('chat.effort'), 'high');
      assert.equal(session.effort, 'high', 'and this chat switched');
      await tty.type(ESC);
      await shows(/settings: effort medium → high/, 'what changed, said once');
      assert.match(tty.screen(), /╭─+╮\n│ > /, 'the box is back');
      assert.doesNotMatch(tty.screen(), /╭─ settings/);
    } finally {
      tty.type('/exit', '\r');
      await ui.waitUntilExit().catch(() => {});
      db.close();
    }
  });
});

test('sumo config without a terminal prints the settings, --json as one object; a setting set by name is refused, and points at the page', () => {
  const s = sandbox();
  const listed = s.sumo(['config']);
  assert.equal(listed.code, 0);
  assert.match(listed.out, /^chat\.budget = 5\nchat\.effort = medium\n/);
  const json = JSON.parse(s.sumo(['config', '--json']).out);
  assert.equal(json.settings['jobs.review'], 'risky');
  assert.equal(s.sumo(['config', 'jobs.review']).out, 'jobs.review = risky\n', 'one by name, read');
  for (const [args, what] of [
    [['config', 'jobs.review', 'all'], /jobs\.review is set on the settings page now — sumo config at a terminal, or \/config in the chat/],
    [['models', 'enable', 'fable'], /which models are on \(enable\) is set on the settings page now/],
    [['models', 'discover'], /is set on the settings page now/],
    [['mcp', 'add', 'x', '--url', 'https://x.example.com/mcp'], /an MCP server \(add\) is set on the settings page now/],
    [['mcp', 'allow', 'x', 'all'], /an MCP server \(allow\) is set on the settings page now/],
    [['setup', '--no-link', '--model-source', 'https://example.com'], /the local model's address \(Memory › Local model\)/],
  ]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} is a command line that is no longer right`);
    assert.match(run.err, what);
  }
  assert.equal(s.sumo(['config']).out, listed.out, 'nothing was changed by any of them');
  const fromShell = s.sumo(['config', 'jobs.review', 'all'], { extraEnv: { SUMO_TOOL: '1' } });
  assert.match(fromShell.err, /the model's shell does not change what the user controls/);
});
