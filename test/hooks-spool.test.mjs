// A hook that cannot write does not lose what was said: the event waits in the spool, and the next one that gets through replays it.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs, { appendFileSync, chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { ENTRY } from '../src/paths.mjs';
import { drainSpool, spoolEvent, spoolStatus } from '../src/spool.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-a', cwd: '/Users/sumo/sumo-agents', transcript_path: null };
const SECRET = 'sk-abcdefghijklmnopqrstuvwxyz123456';
const waiting = (s) => join(s.home, 'spool', 'events.jsonl');
const linesOf = (file) => (existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
/** The spool of a sandbox's home, as this process counts it. */
function status(s) {
  const was = process.env.SUMO_AGENTS_HOME;
  process.env.SUMO_AGENTS_HOME = s.home;
  try {
    return spoolStatus();
  } finally {
    if (was === undefined) delete process.env.SUMO_AGENTS_HOME;
    else process.env.SUMO_AGENTS_HOME = was;
  }
}

/** A home whose database cannot be opened — a folder stands where the file should be — until `mend()` takes it away. */
function deaf() {
  const s = sandbox();
  mkdirSync(join(s.home, 'memory.db'), { recursive: true });
  return { ...s, mend: () => rmSync(join(s.home, 'memory.db'), { recursive: true }) };
}

test('an event the database could not take is kept in the spool, private and with no secret in it, and the hook still answers nothing and exits 0', () => {
  const s = deaf();
  const was = process.umask(0o022);
  try {
    const asked = s.hook('prompt', { ...SESSION, prompt: `always squash-merge, and my key is ${SECRET}` });
    assert.deepEqual({ code: asked.code, out: asked.out, err: asked.err }, { code: 0, out: '', err: '' });
    const ended = s.hook('stop', { ...SESSION, last_assistant_message: `Noted. I will use ${SECRET} for the deploy.`, tool_input: { command: `curl -H "x-api-key: ${SECRET}"` } });
    assert.deepEqual({ code: ended.code, out: ended.out }, { code: 0, out: '' });

    assert.equal(statSync(join(s.home, 'spool')).mode & 0o777, 0o700, 'the folder is the user\'s alone');
    assert.equal(statSync(waiting(s)).mode & 0o777, 0o600, 'and so is the file');
    const raw = readFileSync(waiting(s), 'utf8');
    assert.equal(raw.includes(SECRET), false, 'the secret is not in the spool');
    assert.equal(raw.includes('sk-abcdef'), false);
    const [turn, reply] = linesOf(waiting(s));
    assert.equal(turn.text, 'always squash-merge, and my key is [redacted]');
    assert.equal(reply.text, 'Noted. I will use [redacted] for the deploy.');
    assert.deepEqual(Object.keys(reply).sort(), ['at', 'cwd', 'event', 'full_len', 'harness', 'redacted', 'session_id', 'text', 'transcript_path', 'v'], 'only what the journal needs: never the tool\'s input');
    assert.match(readFileSync(join(s.home, 'logs', 'hook.log'), 'utf8'), /prompt: Error: unable to open database file/, 'and why is in the hook log');

    // A spool from before, readable by others, is closed before more is added.
    chmodSync(waiting(s), 0o644);
    chmodSync(join(s.home, 'spool'), 0o755);
    s.hook('prompt', { ...SESSION, prompt: 'one more' });
    assert.equal(statSync(waiting(s)).mode & 0o777, 0o600);
    assert.equal(statSync(join(s.home, 'spool')).mode & 0o777, 0o700);
    assert.deepEqual(status(s), { waiting: 3, bad: 0 });
  } finally {
    process.umask(was);
  }
});

test('what has nothing for the journal is not kept: a tool about to run, a slash command, a brief, a turn that ended on nothing, an event with no session', () => {
  const s = deaf();
  s.hook('pre-tool', { ...SESSION, tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
  s.hook('prompt', { ...SESSION, prompt: '/clear' });
  s.hook('prompt', { ...SESSION, prompt: 'JOB: run `sumo job brief 3` and follow it exactly.' });
  s.hook('stop', SESSION);
  s.hook('prompt', { prompt: 'who is speaking?' });
  s.hook('nonsense', SESSION);
  assert.equal(existsSync(waiting(s)), false);
  assert.deepEqual(status(s), { waiting: 0, bad: 0 });
});

test('the next hook that gets through replays what waited, with the time it happened, before its own event — and only into the journal', () => {
  const s = deaf();
  s.hook('session-start', { ...SESSION, session_id: 'sess-b' });
  s.hook('prompt', { ...SESSION, session_id: 'sess-b', prompt: 'always release simba through the release script' });
  s.hook('stop', { ...SESSION, session_id: 'sess-b', last_assistant_message: 'Understood: simba goes out through the release script.' });
  s.hook('session-end', { ...SESSION, session_id: 'sess-b' });
  const spooled = linesOf(waiting(s));
  assert.deepEqual(spooled.map((l) => l.event), ['session-start', 'prompt', 'stop', 'session-end']);

  s.mend();
  s.addProject('simba');
  s.sumo(['learn', 'release simba', '--cue', 'release simba'], { input: '1. run the release script\n' });
  const spawnedBefore = s.spawned().length;
  assert.equal(s.hook('prompt', { ...SESSION, prompt: 'hello again' }).code, 0);

  assert.equal(existsSync(waiting(s)), false, 'nothing waits any more');
  assert.deepEqual(readdirSync(join(s.home, 'spool')), []);
  s.sql((db) => {
    const turns = db.prepare('SELECT session_id, ts, text FROM user_turns ORDER BY ts').all();
    assert.deepEqual(turns.map((t) => `${t.session_id}: ${t.text}`), ['sess-b: always release simba through the release script', 'sess-a: hello again']);
    assert.equal(turns[0].ts, spooled[1].at, 'the time it was said, not the time it was written');
    const reply = db.prepare('SELECT ts, text FROM replies').get();
    assert.deepEqual({ ...reply }, { ts: spooled[2].at, text: 'Understood: simba goes out through the release script.' });
    const session = db.prepare('SELECT harness, started_at, last_turn_at, ended_at FROM sessions WHERE id = ?').get('sess-b');
    assert.deepEqual({ ...session }, { harness: 'claude', started_at: spooled[0].at, last_turn_at: spooled[1].at, ended_at: spooled[3].at });
    // The cards, the workflow and the gates were for a moment that has passed: nothing of them is done for a replay.
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM session_injections WHERE session_id = 'sess-b'`).get().n, 0);
    assert.equal(db.prepare(`SELECT last_touched_at FROM projects WHERE slug = 'simba'`).get().last_touched_at, null);
  });
  assert.ok(s.spawned().length - spawnedBefore <= 1, 'the memory pass is woken by the event in hand at most, never once per replayed line');
  assert.match(readFileSync(join(s.home, 'logs', 'hook.log'), 'utf8'), /spool: 4 replayed\n/);
  // What was replayed is found like anything said.
  assert.match(s.sumo(['search', 'release script', '--turns']).out, /always release simba through the release script/);
});

test('an event replayed when its words are already in the journal — the hook broke after writing them — adds nothing, however often', () => {
  const s = sandbox();
  s.hook('prompt', { ...SESSION, prompt: `deploys need the VPN, token ${SECRET}` });
  s.hook('stop', { ...SESSION, last_assistant_message: 'The VPN first, then.' });
  s.hook('session-end', SESSION);
  s.hook('prompt', { ...SESSION, prompt: 'and now this' });
  const { turn, reply, ended } = s.sql((db) => ({
    turn: db.prepare('SELECT ts, text, full_len FROM user_turns ORDER BY id LIMIT 1').get(),
    reply: db.prepare('SELECT ts, text, full_len FROM replies').get(),
    ended: db.prepare('SELECT last_turn_at FROM sessions').get().last_turn_at,
  }));
  const again = [
    { v: 1, at: turn.ts, event: 'prompt', harness: 'claude', session_id: 'sess-a', cwd: null, transcript_path: null, text: turn.text, full_len: turn.full_len, redacted: true },
    { v: 1, at: reply.ts, event: 'stop', harness: 'claude', session_id: 'sess-a', cwd: null, transcript_path: null, text: reply.text, full_len: reply.full_len, redacted: false },
    // A goodbye from before the session was spoken in again does not end it now.
    { v: 1, at: turn.ts, event: 'session-end', harness: 'claude', session_id: 'sess-a', cwd: null, transcript_path: null },
  ];
  mkdirSync(join(s.home, 'spool'), { recursive: true });
  for (let round = 0; round < 2; round++) {
    writeFileSync(waiting(s), again.map((l) => `${JSON.stringify(l)}\n`).join(''));
    s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.deepEqual(status(s), { waiting: 0, bad: 0 });
  }
  s.sql((db) => {
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM replies').get().n, 1);
    assert.deepEqual({ ...db.prepare('SELECT last_turn_at, ended_at FROM sessions').get() }, { last_turn_at: ended, ended_at: null });
  });
});

test('a line that is not an event is set aside in events.bad.jsonl and counted, and the lines around it are still replayed', () => {
  const s = sandbox();
  s.sumo(['config']);
  const good = (n) => ({ v: 1, at: `2026-11-17T10:0${n}:00.000Z`, event: 'prompt', harness: 'claude', session_id: 'sess-s', cwd: null, transcript_path: null, text: `said ${n}`, full_len: 6, redacted: false });
  mkdirSync(join(s.home, 'spool'), { recursive: true });
  writeFileSync(
    waiting(s),
    [
      JSON.stringify(good(1)),
      'not json at all {',
      JSON.stringify({ ...good(2), session_id: '' }),
      JSON.stringify({ ...good(3), event: 'pre-tool' }),
      JSON.stringify({ ...good(4), at: 'yesterday' }),
      JSON.stringify({ ...good(5), text: 42 }),
      JSON.stringify({ ...good(6), v: 2 }),
      '[1, 2]',
      JSON.stringify(good(7)),
      // A line a process died writing: no end, half a string.
      '{"v":1,"at":"2026-11-17T10:08:00.000Z","event":"prompt","session_id":"sess-s","text":"torn',
    ].join('\n'),
  );
  s.hook('session-start', SESSION);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns ORDER BY ts').all()).map((t) => t.text), ['said 1', 'said 7']);
  assert.deepEqual(status(s), { waiting: 0, bad: 8 });
  const bad = linesOf(join(s.home, 'spool', 'events.bad.jsonl'));
  assert.deepEqual(bad.map((b) => b.why).sort(), ['no session id', 'no time it happened', 'no words', 'not a line of JSON', 'not a line of JSON', 'not a line of JSON', 'not an event this version replays', 'not an event this version replays']);
  assert.ok(bad.every((b) => typeof b.line === 'string' && b.at), 'each kept as it was, with when and why');
  assert.equal(statSync(join(s.home, 'spool', 'events.bad.jsonl')).mode & 0o777, 0o600);
  assert.match(readFileSync(join(s.home, 'logs', 'hook.log'), 'utf8'), /spool: 2 replayed, 8 set aside in spool\/events\.bad\.jsonl/);

  // Set aside is set aside: the next hook does not try them again.
  s.hook('prompt', { ...SESSION, prompt: 'carry on' });
  assert.deepEqual(status(s), { waiting: 0, bad: 8 });
});

test('a line that fails to replay waits and is tried again — a failure counted once a minute at most, three in all — then set aside: never for ever, never dropped', async () => {
  await withHome(freshHome(), {}, () => {
    spoolEvent({ v: 1, event: 'prompt', text: 'stubborn' });
    spoolEvent({ v: 1, event: 'prompt', text: 'fine' });
    const seen = [];
    const replay = (entry) => {
      seen.push(entry.text);
      if (entry.text === 'stubborn') throw new Error('disk I/O error');
    };
    const T = Date.parse('2026-11-18T10:00:00.000Z');
    assert.deepEqual(drainSpool(replay, { now: T }), { replayed: 1, retried: 1, bad: 0 });
    assert.deepEqual(spoolStatus(), { waiting: 1, bad: 0 }, 'it waits');
    // Every tool call drains: tries seconds apart are one failure, not three.
    for (let i = 1; i <= 5; i++) assert.deepEqual(drainSpool(replay, { now: T + i * 1000 }), { replayed: 0, retried: 1, bad: 0 }, `try ${i} in the same minute`);
    assert.deepEqual(drainSpool(replay, { now: T + 61_000 }), { replayed: 0, retried: 1, bad: 0 }, 'the second that counts');
    assert.deepEqual(drainSpool(replay, { now: T + 122_000 }), { replayed: 0, retried: 0, bad: 1 }, 'the third: set aside');
    assert.deepEqual(spoolStatus(), { waiting: 0, bad: 1 });
    assert.equal(drainSpool(replay), null, 'nothing waits: nothing is tried');
    assert.equal(seen.filter((text) => text === 'fine').length, 1);
  });
});

test('a database that is busy is not a failed try: the lines simply wait, however often a hook finds it locked, and are replayed when it is free', async () => {
  await withHome(freshHome(), {}, () => {
    spoolEvent({ v: 1, event: 'prompt', text: 'a' });
    spoolEvent({ v: 1, event: 'prompt', text: 'b' });
    const T = Date.parse('2026-11-18T10:00:00.000Z');
    // The whole piece of work failing — the database locked at its start — and one line finding it locked: neither counts.
    const locked = () => {
      throw Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 });
    };
    for (let i = 0; i < 6; i++) assert.deepEqual(drainSpool(() => {}, { within: locked, now: T + i * 120_000 }), { replayed: 0, retried: 2, bad: 0 });
    for (let i = 6; i < 12; i++) assert.deepEqual(drainSpool(locked, { now: T + i * 120_000 }), { replayed: 0, retried: 2, bad: 0 });
    assert.deepEqual(spoolStatus(), { waiting: 2, bad: 0 }, 'twelve looks at a locked database later, nothing was set aside');
    const seen = [];
    assert.deepEqual(drainSpool((entry) => seen.push(entry.text)), { replayed: 2, retried: 0, bad: 0 });
    assert.deepEqual(seen, ['a', 'b']);
    assert.deepEqual(spoolStatus(), { waiting: 0, bad: 0 });
  });
});

test('a turn said while another process held the database for seconds is in the journal once it lets go — not set aside by the tool calls in between', () => {
  const s = sandbox();
  s.hook('prompt', { ...SESSION, prompt: 'hello there, first turn' });
  const holder = new DatabaseSync(join(s.home, 'memory.db'));
  holder.exec('BEGIN IMMEDIATE');
  try {
    s.hook('prompt', { ...SESSION, prompt: 'from now on always squash merge on github' });
    assert.deepEqual(status(s), { waiting: 1, bad: 0 });
    for (let i = 0; i < 3; i++) s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command: 'ls' } });
    assert.deepEqual(status(s), { waiting: 1, bad: 0 }, 'three tool calls found it locked: the turn still waits');
  } finally {
    holder.exec('ROLLBACK');
    holder.close();
  }
  s.hook('prompt', { ...SESSION, prompt: 'a later turn, the database is fine' });
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns ORDER BY ts').all().map((r) => r.text)), ['hello there, first turn', 'from now on always squash merge on github', 'a later turn, the database is fine']);
  assert.deepEqual(status(s), { waiting: 0, bad: 0 });
  assert.equal(existsSync(join(s.home, 'spool', 'events.bad.jsonl')), false);
});

test('a line added to a file a drain has in its hand, after its last look and before it lets the file go, is still replayed', async () => {
  await withHome(freshHome(), {}, () => {
    spoolEvent({ v: 1, event: 'prompt', text: 'first' });
    // A hook that had the file open when the drain took it writes its line late: here, right after the drain's look that found nothing new.
    const read = fs.readFileSync;
    let looks = 0;
    fs.readFileSync = (file, ...rest) => {
      const text = read(file, ...rest);
      if (/\.draining$/.test(String(file)) && ++looks === 2) appendFileSync(file, `${JSON.stringify({ v: 1, event: 'prompt', text: 'late' })}\n`);
      return text;
    };
    syncBuiltinESMExports();
    const seen = [];
    try {
      assert.deepEqual(drainSpool((entry) => seen.push(entry.text)), { replayed: 2, retried: 0, bad: 0 });
    } finally {
      fs.readFileSync = read;
      syncBuiltinESMExports();
    }
    assert.deepEqual(seen, ['first', 'late']);
    assert.deepEqual(spoolStatus(), { waiting: 0, bad: 0 });
  });
});

test('sumo memory check --fix replays what was set aside: a line that now goes in leaves events.bad.jsonl, one that still cannot stays and is counted', () => {
  const s = sandbox();
  s.hook('prompt', { ...SESSION, prompt: 'hello there, first turn' });
  const kept = { v: 1, at: '2026-11-17T10:00:00.000Z', event: 'prompt', harness: 'claude', session_id: 'sess-a', cwd: null, transcript_path: null, text: 'always squash merge on github', full_len: 29, redacted: false, tries: 2 };
  const aside = (line, why) => JSON.stringify({ at: '2026-11-17T10:05:00.000Z', why, line });
  mkdirSync(join(s.home, 'spool'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.home, 'spool', 'events.bad.jsonl'), `${aside(JSON.stringify(kept), 'database is locked')}\n${aside('not json at all {', 'not a line of JSON')}\n`, { mode: 0o600 });

  const before = s.sumo(['memory', 'check']);
  assert.equal(before.code, 1);
  assert.match(before.out, /^FAIL {2}the spool \(.*\): 2 lines set aside as unreadable — events\.bad\.jsonl holds what could not be replayed, with the reason on each line: sumo memory check --fix tries them again$/m);

  const fixed = s.sumo(['memory', 'check', '--fix']);
  assert.match(fixed.out, /^FAIL {2}the spool \(.*\): 1 line set aside as unreadable \(1 replayed\) — events\.bad\.jsonl holds what could not be replayed, with the reason on each line: read it, then delete it$/m);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text, ts FROM user_turns ORDER BY ts').all().map((r) => ({ ...r }))).at(0), { text: 'always squash merge on github', ts: '2026-11-17T10:00:00.000Z' });
  assert.deepEqual(linesOf(join(s.home, 'spool', 'events.bad.jsonl')).map((b) => b.why), ['not a line of JSON']);
  assert.equal(statSync(join(s.home, 'spool', 'events.bad.jsonl')).mode & 0o777, 0o600);
});

test('what a drain that died left in its hand is replayed by the next; one a living process holds is left to it', async () => {
  const s = sandbox();
  s.sumo(['config']);
  const dir = join(s.home, 'spool');
  mkdirSync(dir, { recursive: true });
  const line = (text) => `${JSON.stringify({ v: 1, at: '2026-11-17T10:00:00.000Z', event: 'prompt', harness: 'claude', session_id: 'sess-d', cwd: null, transcript_path: null, text })}\n`;
  // No process has this number; process 1 is always there, and its file is fresh.
  writeFileSync(join(dir, 'events.2147483646.1.draining'), line('left by a drain that died'));
  writeFileSync(join(dir, 'events.1.1.draining'), line('in a living drain\'s hand'));
  assert.deepEqual(status(s), { waiting: 2, bad: 0 }, 'both still count as waiting');
  s.hook('session-start', SESSION);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns').all()).map((t) => t.text), ['left by a drain that died']);
  assert.deepEqual(readdirSync(dir), ['events.1.1.draining']);
  // Unless it has been there far too long: the number is another process's by now.
  utimesSync(join(dir, 'events.1.1.draining'), new Date(Date.now() - 3_600_000), new Date(Date.now() - 3_600_000));
  s.hook('session-start', SESSION);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT text FROM user_turns ORDER BY id').all()).map((t) => t.text), ['left by a drain that died', 'in a living drain\'s hand']);
  assert.deepEqual(readdirSync(dir), []);
});

test('hooks draining the same spool at the same moment replay every line once: none twice, none lost, none set aside', async () => {
  const s = deaf();
  const N = 40;
  await withHome(s.home, {}, () => {
    for (let i = 0; i < N; i++) spoolEvent({ v: 1, at: new Date(Date.parse('2026-11-17T10:00:00.000Z') + i * 1000).toISOString(), event: i % 2 ? 'stop' : 'prompt', harness: 'claude', session_id: `sess-${i % 3}`, cwd: null, transcript_path: null, text: `line ${i}` });
  });
  s.mend();
  s.sumo(['config']);
  const hook = (i) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'hook', 'prompt'], { env: { ...process.env, SUMO_AGENTS_HOME: s.home, SUMO_AGENTS_SPAWN_LOG: join(s.root, 'spawned.log') }, stdio: ['pipe', 'ignore', 'ignore'] });
      child.on('close', resolve);
      child.stdin.end(JSON.stringify({ session_id: `live-${i}`, prompt: `live ${i}` }));
    });
  assert.deepEqual(await Promise.all(Array.from({ length: 6 }, (_, i) => hook(i))), [0, 0, 0, 0, 0, 0]);
  // A hook that found the database busy past its wait kept its own event: one more quiet hook brings it in.
  s.hook('session-start', SESSION);
  s.sql((db) => {
    const said = [...db.prepare('SELECT text FROM user_turns').all(), ...db.prepare('SELECT text FROM replies').all()].map((r) => r.text).sort();
    assert.deepEqual(said, [...Array.from({ length: N }, (_, i) => `line ${i}`), ...Array.from({ length: 6 }, (_, i) => `live ${i}`)].sort());
  });
  assert.deepEqual(status(s), { waiting: 0, bad: 0 });
});
