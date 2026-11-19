// Memory checking itself: failure is loud. Capture once stopped for 35 days and the only sign was the words "last
// heard 35d ago" inside a line marked ok — so going deaf, an index that lost what was said, events left in the spool,
// a pass that died and a harness that is not heard each fail a check, and each says what to do.
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { startOf } from '../src/scribe.mjs';
import { hooksHelp, memoryCheck, memoryHealth, memoryHealthLine, memoryStatus, notHeardLine } from '../src/check.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { emptyRun, extractorVersion, notePass } from '../src/ledger.mjs';
import { paths } from '../src/paths.mjs';
import { noteUsedFrom, prime } from '../src/prime.mjs';
import { endSession, ensureSession, recordReply, recordTurn } from '../src/sessions.mjs';
import { spoolEvent } from '../src/spool.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-11-17T12:00:00.000Z';
const ago = (days, from = NOW) => new Date(Date.parse(from) - days * 86_400_000).toISOString();
/** Filing as it stands when all is well, for a check that is about something else. */
const FILING = { paused: false, reason: null, failures: 0, quarantined: 0, junkRate: null, fallbackUsed: false, lastOkAt: null };

async function withDb(fn) {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      await fn(db);
    } finally {
      db.close();
    }
  });
}

/** One turn heard from a harness, some days ago — and, when that is over two days, read by the pass of its day: these are about hearing, and a conversation left unread that long is a fault of its own. */
function heard(db, harness, days, text = 'we deploy the billing service on fridays') {
  const id = `${harness}-${days}`;
  ensureSession(db, { id, harness, now: ago(days) });
  const turn = recordTurn(db, { sessionId: id, text, now: ago(days) });
  if (days > 2) db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES (?, 'v0', 'ok', 1, ?, ?, ?, ?)`).run(id, turn, turn, ago(days), ago(days));
  return turn;
}

const named = (checks, name) => checks.find((c) => c.name === name);

/** A sumo command was run from inside Claude Code, some days ago: the evidence the heartbeat goes by. */
const usedFromClaude = (db, days) => noteUsedFrom(db, { CLAUDECODE: '1' }, ago(days));

test('sumo commands run from Claude Code while no turn arrives from it is not ok, fails, and says what to do — it used to say "last heard 35d ago" in a line marked ok', async () => {
  await withDb(async (db) => {
    const never = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: never.ok, fail: never.fail, label: never.label }, { ok: true, fail: false, label: 'memory: nothing heard yet · nothing filed yet' }, 'a memory nothing was ever said to has not gone deaf');

    // What happened: the hook lines went, and sumo commands went on being run from Claude Code for five weeks.
    heard(db, 'claude', 35);
    usedFromClaude(db, 0);
    const deaf = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.equal(deaf.ok, false);
    assert.equal(deaf.fail, true, 'the one thing that fails a doctor run');
    assert.match(deaf.label, /^memory: last heard 35d ago/);
    assert.match(deaf.fix, /^Claude Code is not being heard: sumo commands are run from it and no turn has come from it for 35 days, so what is said there is not kept\..*sumo help hooks prints them/);

    // The cure is a turn arriving: the hooks are back.
    heard(db, 'claude', 0);
    const fine = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: fine.ok, fail: fine.fail, fix: fine.fix }, { ok: true, fail: false, fix: '' });
  });
  await withDb(async (db) => {
    usedFromClaude(db, 0);
    const line = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.equal(line.fail, true);
    assert.match(line.fix, /sumo commands are run from it and no turn has ever come from it/, 'used and never once heard');
  });
});

test('silence alone is never a failure: back after a holiday nothing is called deaf, sumo\'s own chat cannot go deaf however long it is quiet, and a Claude Code left two months ago is let be', async () => {
  await withDb(async (db) => {
    // Eight days away: the last command from Claude Code and the last turn heard from it are the same afternoon.
    heard(db, 'claude', 8);
    usedFromClaude(db, 8 - 0.1);
    const back = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: back.ok, fail: back.fail, fix: back.fix }, { ok: true, fail: false, fix: '' }, 'nothing was said in those days, so nothing was missed');
    assert.match(back.label, /^memory: last heard 8d ago/, 'how long ago is information');
    assert.doesNotMatch(prime(db, { now: NOW }), /heard/, 'and the block says nothing of it');
  });
  await withDb(async (db) => {
    heard(db, 'claude', 35);
    const quiet = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: quiet.ok, fail: quiet.fail, fix: quiet.fix }, { ok: true, fail: false, fix: '' }, 'five weeks of silence with no command run from Claude Code is the user being elsewhere');
    assert.match(quiet.label, /^memory: last heard 35d ago/);
  });
  await withDb(async (db) => {
    heard(db, 'sumo', 35);
    heard(db, 'claude', 0);
    usedFromClaude(db, 0);
    const line = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.equal(line.ok, true, 'the chat records in process: its silence is the user not using it');
    assert.match(line.label, /^memory: last heard just now \(Claude Code just now · sumo chat 35d ago\)/);
  });
  await withDb(async (db) => {
    heard(db, 'sumo', 35);
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).ok, true, 'nor when the chat is all there ever was');
  });
  await withDb(async (db) => {
    heard(db, 'claude', 90);
    usedFromClaude(db, 61);
    heard(db, 'sumo', 0);
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).ok, true, 'not heard then, and not used since: the user left it');
  });
});

test('a command run from Claude Code is noted as evidence of use, once an hour at most — never from sumo\'s own shell or a job, never outside it, and never by a hook', async () => {
  const stamp = (db) => db.prepare(`SELECT value FROM meta WHERE key = 'used.claude'`).get()?.value ?? null;
  await withDb(async (db) => {
    for (const env of [{}, { CLAUDECODE: '0' }, { CLAUDECODE: '1', SUMO_TOOL: '1' }, { CLAUDECODE: '1', SUMO_JOB: '3' }]) noteUsedFrom(db, env, NOW);
    assert.equal(stamp(db), null);
    noteUsedFrom(db, { CLAUDECODE: '1' }, NOW);
    assert.equal(stamp(db), NOW);
    noteUsedFrom(db, { CLAUDECODE: '1' }, ago(-0.04));
    assert.equal(stamp(db), NOW, 'within the hour the stamp is left as it is');
    noteUsedFrom(db, { CLAUDECODE: '1' }, ago(-0.05));
    assert.equal(stamp(db), ago(-0.05));
  });
  const s = sandbox();
  const inside = { extraEnv: { CLAUDECODE: '1' } };
  const used = () => s.sql((db) => stamp(db));
  s.hook('prompt', { session_id: 'c1', prompt: 'the billing export runs at midnight' }, inside);
  s.hook('stop', { session_id: 'c1' }, inside);
  assert.equal(used(), null, 'a hook running is the hearing itself, not evidence of use without it');
  s.sumo(['search', 'billing']);
  assert.equal(used(), null, 'outside Claude Code');
  s.sumo(['search', 'billing'], inside);
  assert.notEqual(used(), null);
});

test('the block a session starts with carries one line when Claude Code is in use and not heard, and none when it is heard or merely quiet', async () => {
  await withDb(async (db) => {
    heard(db, 'claude', 3);
    usedFromClaude(db, 2.5);
    assert.doesNotMatch(prime(db, { now: NOW }), /heard/);
  });
  await withDb(async (db) => {
    heard(db, 'claude', 35);
    assert.doesNotMatch(prime(db, { now: NOW }), /heard/, 'silence by itself is not said');
    usedFromClaude(db, 0);
    const lines = prime(db, { now: NOW }).split('\n').filter((l) => /heard/.test(l));
    assert.equal(lines.length, 1);
    assert.match(lines[0], /^Warning: Claude Code is not being heard: sumo commands are run from it and no turn has come from it for 35 days, so what is said there is not kept\..*sumo help hooks prints them.*Tell the user\.$/);
  });
});

test('filing that is paused makes the health line a warning that says why', async () => {
  await withDb(async (db) => {
    heard(db, 'sumo', 0);
    const paused = { ...FILING, paused: true, reason: 'the last 3 passes failed (llama-server did not become healthy) — sumo memory run reads again by hand', failures: 3, junkRate: 0.25, lastOkAt: ago(2) };
    const line = memoryHealthLine(memoryHealth(db, NOW, { filing: paused }), NOW);
    assert.deepEqual({ ok: line.ok, fail: line.fail }, { ok: false, fail: false });
    assert.equal(line.label, 'memory: last heard just now · last filed 2d ago, filing paused · 25% of what was filed was thrown out');
    assert.match(line.fix, /^filing is paused: the last 3 passes failed \(llama-server did not become healthy\)/);
  });
});

test('inside Claude Code with nothing heard from it in a day, a memory command is told so in one line, once a day — never when it is heard, outside it, or in sumo\'s own shell', async () => {
  await withDb(async (db) => {
    const inside = { CLAUDECODE: '1' };
    assert.equal(notHeardLine(db, { env: {}, now: NOW }), '', 'not inside Claude Code');
    assert.equal(notHeardLine(db, { env: { ...inside, SUMO_TOOL: '1' }, now: NOW }), '', "sumo's own chat started from there is not Claude Code");

    const said = notHeardLine(db, { env: inside, now: NOW });
    assert.match(said, /^sumo: this Claude Code session is not being heard by sumo's memory \(nothing has ever come from it\) — what the user says here is not kept\. Tell the user: .*sumo help hooks prints them and says where they go\.$/);
    assert.doesNotMatch(said, /\n/, 'one line');
    assert.equal(notHeardLine(db, { env: inside, now: ago(-0.5) }), '', 'said once: twelve hours on it is not said again');
    assert.match(notHeardLine(db, { env: inside, now: ago(-1.1) }), /not being heard/, 'and the next day it is');

    heard(db, 'claude', 3);
    assert.match(notHeardLine(db, { env: inside, now: ago(-2.5) }), /nothing has come from it for 5d/, 'heard once, and not since');
    heard(db, 'sumo', 0);
    assert.match(notHeardLine(db, { env: inside, now: ago(-4) }), /not being heard/, "sumo's own chat being heard says nothing about Claude Code");
  });
  await withDb(async (db) => {
    heard(db, 'claude', 0.01);
    assert.equal(notHeardLine(db, { env: { CLAUDECODE: '1' }, now: NOW }), '', 'the prompt that led to this command was heard');
  });
});

test('search, add, prime and memory status say on stderr that Claude Code is not heard, once; sumo help hooks prints the lines to add, with this home\'s launcher', () => {
  const s = sandbox();
  const inside = { extraEnv: { CLAUDECODE: '1' } };
  const first = s.sumo(['search', 'anything'], inside);
  assert.match(first.err, /^sumo: this Claude Code session is not being heard by sumo's memory .*sumo help hooks/);
  assert.equal(s.sumo(['search', 'anything'], inside).err, '', 'not on every command');
  for (const args of [['add', 'fact', 'the staging database is wiped nightly'], ['prime'], ['memory', 'status']]) {
    s.sql((db) => db.prepare(`DELETE FROM meta WHERE key = 'heard.claude_told_at'`).run());
    assert.match(s.sumo(args, inside).err, /not being heard by sumo's memory/, args.join(' '));
  }
  s.sql((db) => db.prepare(`DELETE FROM meta WHERE key = 'heard.claude_told_at'`).run());
  assert.equal(s.sumo(['search', 'anything']).err, '', 'outside Claude Code nothing is said');
  // A hook that works is the cure: a prompt heard through it, and the line is gone.
  s.hook('prompt', { session_id: 'c1', prompt: 'we deploy the billing service on fridays' });
  assert.equal(s.sumo(['search', 'billing'], inside).err, '');

  const help = s.sumo(['help', 'hooks']);
  assert.equal(help.code, 0);
  for (const [event, name] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['Stop', 'stop'], ['SessionEnd', 'session-end']]) {
    assert.ok(help.out.includes(`"${event}":`) && help.out.includes(`"command": "${join(s.home, 'bin', 'sumo')} hook ${name}"`), `${event} runs sumo hook ${name}`);
  }
  assert.match(help.out, /~\/\.claude\/settings\.json/);
  assert.match(help.out, /sumo never\nedits another tool's settings/);
  assert.equal(hooksHelp().every((l) => l.length <= 100 || l.includes('"command"')), true, 'the words fit 100 columns; a path is as long as it is');
});

test('every check passes on a memory that is well: the three indexes, the canary, the spool, the backup, the passes, the replies and the filing', async () => {
  await withDb(async (db) => {
    const turn = heard(db, 'claude', 0.1, 'the invoice exporter crashes whenever a customer has umlauts in the billing address');
    recordReply(db, { sessionId: 'claude-0.1', text: 'The exporter assumes latin-1; switching the writer to utf-8 fixes the crash.', now: ago(0.09) });
    const checks = memoryCheck(db, NOW);
    assert.deepEqual(checks.map((c) => c.name), ['index:memories_fts', 'index:user_turns_fts', 'index:replies_fts', 'canary', 'spool', 'backup', 'passes', 'replies', 'filing']);
    assert.deepEqual(checks.filter((c) => !c.ok), []);
    assert.ok(checks.every((c) => typeof c.label === 'string' && c.fix === ''), 'a check that passes names no fix');
    assert.equal(named(checks, 'canary').label, `the newest turn (t${turn}) is found by its own words`);
  });
});

test('an index that no longer holds what was said fails its check and the canary, names the rebuild, and --fix rebuilds it', async () => {
  await withDb(async (db) => {
    const turn = heard(db, 'claude', 0.1, 'the invoice exporter crashes whenever a customer has umlauts in the billing address');
    const { text } = db.prepare('SELECT text FROM user_turns WHERE id = ?').get(turn);
    // The turn is in the journal and gone from its index: what a half-written page or a restore gone wrong leaves.
    db.prepare(`INSERT INTO user_turns_fts(user_turns_fts, rowid, text) VALUES ('delete', ?, ?)`).run(turn, text);

    const broken = memoryCheck(db, NOW, { filing: FILING });
    assert.equal(named(broken, 'index:user_turns_fts').ok, false);
    assert.equal(named(broken, 'index:user_turns_fts').fix, 'rebuild it: sumo memory check --fix');
    assert.equal(named(broken, 'index:memories_fts').ok, true, 'each index is judged by itself');
    assert.equal(named(broken, 'canary').ok, false);
    assert.match(named(broken, 'canary').label, new RegExp(`^the newest turn \\(t${turn}\\) is not found by its own words \\(`));
    assert.match(named(broken, 'canary').fix, /sumo memory check --fix/);

    const mended = memoryCheck(db, NOW, { fix: true, filing: FILING });
    assert.deepEqual(mended.filter((c) => !c.ok), []);
    assert.equal(named(mended, 'index:user_turns_fts').label, 'search index user_turns_fts (rebuilt)');
    assert.deepEqual(memoryCheck(db, NOW, { filing: FILING }).filter((c) => !c.ok), [], 'and it stays mended');
  });
});

test('events left in the spool, and lines set aside as unreadable, fail the spool check with where they are', async () => {
  await withDb(async (db) => {
    spoolEvent({ v: 1, at: NOW, event: 'prompt', harness: 'claude', session_id: 's1', text: 'kept for later', full_len: 14, redacted: false });
    writeFileSync(join(paths().spool, 'events.bad.jsonl'), '{"why":"not a line of JSON","line":"x"}\n', { mode: 0o600 });
    const spool = named(memoryCheck(db, NOW, { filing: FILING }), 'spool');
    assert.equal(spool.ok, false);
    assert.equal(spool.label, `the spool (${paths().spool}): 1 event not yet in the journal, 1 line set aside as unreadable`);
    assert.match(spool.fix, /replayed by the next thing said.*events\.bad\.jsonl/);
  });
});

test('a backup that failed, or is over two weeks old with something to lose, fails its check; a new memory with none yet does not', async () => {
  await withDb(async (db) => {
    assert.equal(named(memoryCheck(db, NOW, { filing: FILING }), 'backup').ok, true, 'nothing to lose yet');
    heard(db, 'sumo', 20);
    const never = named(memoryCheck(db, NOW, { filing: FILING }), 'backup');
    assert.deepEqual({ ok: never.ok, label: never.label, fix: never.fix }, { ok: false, label: 'no backup yet, and memory goes back 20 days', fix: 'sumo backup' });

    setMeta(db, 'last_backup', ago(3));
    assert.deepEqual({ ...named(memoryCheck(db, NOW, { filing: FILING }), 'backup') }, { name: 'backup', ok: true, label: 'last backup 3d ago', fix: '' });
    setMeta(db, 'last_backup', ago(15));
    const old = named(memoryCheck(db, NOW, { filing: FILING }), 'backup');
    assert.deepEqual({ ok: old.ok, label: old.label }, { ok: false, label: 'last backup 15d ago' });
    assert.match(old.fix, /sumo backup$/);

    setMeta(db, 'last_backup', ago(1));
    setMeta(db, 'backup.failed', 'ENOSPC: no space left on device');
    const failed = named(memoryCheck(db, NOW, { filing: FILING }), 'backup');
    assert.deepEqual({ ok: failed.ok, label: failed.label }, { ok: false, label: 'the weekly backup could not be written (ENOSPC: no space left on device)' });
  });
});

test('a memory pass left running by a process that died fails its check; one that started a minute ago is still at work', async () => {
  await withDb(async (db) => {
    heard(db, 'sumo', 1);
    const run = (minutes) => db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, started_at) VALUES ('sumo-1', 'v1', 'running', 1, ?)`).run(new Date(Date.parse(NOW) - minutes * 60_000).toISOString());
    run(1);
    assert.equal(named(memoryCheck(db, NOW, { filing: FILING }), 'passes').ok, true);
    run(120);
    const dead = named(memoryCheck(db, NOW, { filing: FILING }), 'passes');
    assert.equal(dead.ok, false);
    assert.match(dead.label, /^1 memory pass left running by a process that died \(since 2026-11-17T10:00\)$/);
    assert.equal(dead.fix, 'sumo memory run reads those conversations again');
  });
});

test('a memory pass that has held its lock for over half an hour fails the check, naming its process; one at work for minutes does not', async () => {
  await withDb(async (db) => {
    heard(db, 'sumo', 1);
    // This test's own process holds it, as a pass at work would: its pid, and when it started.
    const lock = join(paths().home, 'scribe.lock');
    writeFileSync(lock, `${process.pid} ${startOf(process.pid)}`);
    const heldFor = (minutes) => {
      const then = new Date(Date.parse(NOW) - minutes * 60_000);
      utimesSync(lock, then, then);
      return named(memoryCheck(db, NOW, { filing: FILING }), 'passes');
    };
    assert.equal(heldFor(5).ok, true);
    const stuck = heldFor(45);
    assert.equal(stuck.ok, false);
    assert.equal(stuck.label, `the memory pass has been held by process ${process.pid} for 45 minutes`);
    assert.equal(stuck.fix, `a pass takes minutes: if process ${process.pid} is stuck, end it (kill ${process.pid}) and the next pass takes over`);
  });
});

test('conversations kept without the assistant\'s replies fail a check that names the harness — counted only from when replies were kept, and never one interrupted turn', async () => {
  await withDb(async (db) => {
    // From before replies were kept: turns without a digest. They are not what this check is about.
    for (const n of [1, 2, 3, 4]) {
      ensureSession(db, { id: `old-${n}`, harness: 'claude', now: ago(40 + n) });
      db.prepare(`INSERT INTO user_turns (session_id, ts, text) VALUES (?, ?, 'from before the journal kept replies')`).run(`old-${n}`, ago(40 + n));
    }
    assert.equal(named(memoryCheck(db, NOW, { filing: FILING }), 'replies').ok, true);

    // sumo's own chat: answered every time but once.
    for (const n of [1, 2, 3]) {
      heard(db, 'sumo', n);
      if (n > 1) recordReply(db, { sessionId: `sumo-${n}`, text: `an answer, number ${n}`, now: ago(n) });
    }
    assert.equal(named(memoryCheck(db, NOW, { filing: FILING }), 'replies').ok, true, 'one turn interrupted is not a harness that is not heard');

    // Claude Code: its prompts arrive, its replies never do.
    for (const n of [1, 2, 3]) heard(db, 'claude', n);
    const missing = named(memoryCheck(db, NOW, { filing: FILING }), 'replies');
    assert.equal(missing.ok, false);
    assert.equal(missing.label, "conversations kept without the assistant's replies: 3 of the last 3 from Claude Code");
    assert.match(missing.fix, /the stop event is not reaching sumo — sumo help hooks/);

    // A conversation still going has not been answered yet.
    heard(db, 'sumo', 0.001);
    assert.doesNotMatch(named(memoryCheck(db, NOW, { filing: FILING }), 'replies').label, /sumo chat/);
  });
});

test('filing that is paused fails its check with the reason; turns set aside, the share thrown out and a fallback are said without failing it', async () => {
  await withDb(async (db) => {
    const said = named(memoryCheck(db, NOW, { filing: { ...FILING, failures: 1, quarantined: 2, junkRate: 0.125, fallbackUsed: true } }), 'filing');
    assert.deepEqual({ ...said }, { name: 'filing', ok: true, label: 'filing is on — 1 pass failed in a row, 2 turns set aside after failing three times, 13% of what was filed was thrown out, the last pass ran on the fallback model', fix: '' });

    // Through the ledger itself: three passes that failed pause it.
    for (let n = 0; n < 3; n++) notePass(db, { ok: false, error: 'llama-server did not become healthy' });
    const paused = named(memoryCheck(db, NOW), 'filing');
    assert.equal(paused.ok, false);
    assert.match(paused.label, /^filing is paused — 3 passes failed in a row/);
    assert.match(paused.fix, /llama-server did not become healthy/);
  });
});

test('sumo memory check prints every check and exits 1 when one fails; --fix rebuilds the index and it passes again', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'c1', prompt: 'the invoice exporter crashes whenever a customer has umlauts in the billing address' });
  const well = s.sumo(['memory', 'check']);
  assert.equal(well.code, 0, well.out);
  assert.match(well.out, /^ok {4}memory: last heard just now · nothing filed yet$/m);
  assert.match(well.out, /^ok {4}search index replies_fts$/m);
  assert.match(well.out, /^ok {4}the newest turn \(t1\) is found by its own words$/m);
  assert.doesNotMatch(well.out, /FAIL|warn/);

  s.sql((db) => db.exec(`INSERT INTO user_turns_fts(user_turns_fts, rowid, text) SELECT 'delete', id, text FROM user_turns`));
  const broken = s.sumo(['memory', 'check']);
  assert.equal(broken.code, 1);
  assert.match(broken.out, /^FAIL {2}search index user_turns_fts: .* — rebuild it: sumo memory check --fix$/m);
  assert.match(broken.out, /^FAIL {2}the newest turn \(t1\) is not found by its own words/m);

  const fixed = s.sumo(['memory', 'check', '--fix']);
  assert.equal(fixed.code, 0, fixed.out);
  assert.match(fixed.out, /^ok {4}search index user_turns_fts \(rebuilt\)$/m);
  assert.equal(s.sumo(['memory', 'check']).code, 0);
  assert.match(s.sumo(['memory', '--help']).out, /check \[--fix\] \| eval \[--limit N\] \[--json\]/);
});

test('doctor carries the memory checks and fails on any of them — and on a Claude Code in use that is not heard, never on silence alone', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir]);
  const path = { extraEnv: { PATH: `${binDir}:${process.env.PATH}` } };
  s.hook('prompt', { session_id: 'c1', prompt: 'the invoice exporter crashes whenever a customer has umlauts in the billing address' });
  // A session's start makes the weekly backup; made here, so the backup's own check is not what fails below.
  s.sumo(['backup']);

  const well = s.sumo(['doctor'], path);
  assert.equal(well.code, 0, well.out);
  assert.match(well.out, /^ok {4}memory: last heard just now · nothing filed yet$/m);
  for (const label of ['search index memories_fts', 'search index user_turns_fts', 'search index replies_fts', 'the newest turn \\(t1\\) is found by its own words', 'nothing waits in the spool', 'no memory pass was left unfinished', 'filing is on']) {
    assert.match(well.out, new RegExp(`^ok {4}memory: ${label}$`, 'm'));
  }

  // Quiet: the one turn ever heard was 35 days ago — read by the pass of that day — and no command has been run from Claude Code. Said, and no failure.
  const then = new Date(Date.now() - 35 * 86_400_000).toISOString();
  s.sql((db) => {
    db.prepare('UPDATE user_turns SET ts = ?').run(then);
    db.prepare('UPDATE sessions SET started_at = ?, last_turn_at = ?').run(then, then);
    db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('c1', 'v0', 'ok', 1, 1, 1, ?, ?)`).run(then, then);
  });
  const quiet = s.sumo(['doctor'], path);
  assert.equal(quiet.code, 0, quiet.out);
  assert.match(quiet.out, /^ok {4}memory: last heard 35d ago · last filed 35d ago$/m);
  assert.equal(s.sumo(['memory', 'status'], path).code, 0);

  // Deaf: a command run from inside Claude Code, five weeks after the last turn that came from it.
  const inside = { extraEnv: { ...path.extraEnv, CLAUDECODE: '1' } };
  s.sumo(['search', 'invoice exporter'], inside);
  const deaf = s.sumo(['doctor'], path);
  assert.equal(deaf.code, 1, 'in use and not heard for 35 days fails the run');
  assert.match(deaf.out, /^FAIL {2}memory: last heard 35d ago · last filed 35d ago — Claude Code is not being heard: sumo commands are run from it and no turn has come from it for 35 days, .*sumo help hooks prints them/m);
  const status = s.sumo(['memory', 'status'], path);
  assert.match(status.out, /^FAIL {2}memory: last heard 35d ago/, 'and the status says it first');
  assert.equal(status.code, 1, 'and fails');
  assert.equal(s.sumo(['memory', 'check'], path).code, 1);

  // Heard again, and an event left in the spool: a check of the layer fails the run by itself.
  s.hook('prompt', { session_id: 'c2', prompt: 'and the nightly export job needs the same utf-8 treatment' });
  assert.equal(s.sumo(['doctor'], path).code, 0);
  mkdirSync(join(s.home, 'spool'), { recursive: true, mode: 0o700 });
  writeFileSync(join(s.home, 'spool', 'events.bad.jsonl'), '{"why":"not a line of JSON","line":"x"}\n', { mode: 0o600 });
  const spooled = s.sumo(['doctor'], path);
  assert.equal(spooled.code, 1);
  assert.match(spooled.out, /^FAIL {2}memory: the spool \(.*\): 1 line set aside as unreadable — events\.bad\.jsonl holds what could not be replayed/m);
  assert.match(s.sumo(['doctor', '--report'], path).out, /^FAIL {2}memory: the spool/m, 'the report carries the same lines');
});

test('doctor says a month-old project scan as a warning on the memory line, with the rescan to run', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'c1', prompt: 'we ship on fridays' });
  const then = new Date(Date.now() - 40 * 86_400_000).toISOString();
  s.sql((db) => db.prepare(`INSERT INTO projects (slug, name, path, created_at, scanned_at) VALUES ('old', 'old', '/nowhere/old', ?, ?)`).run(then, then));
  assert.match(s.sumo(['doctor']).out, /^warn {2}memory: last heard just now · nothing filed yet · 1 project scan over 7 days old \(old, 40d\) — rescan: sumo project rescan old$/m);
});

test('sumo memory status is one screen that says how memory stands: who is heard, the model and the rung in use, what waits, and why filing is paused', async () => {
  await withDb(async (db) => {
    heard(db, 'claude', 2);
    heard(db, 'sumo', 0.01);
    spoolEvent({ v: 1, at: NOW, event: 'prompt', harness: 'claude', session_id: 's1', text: 'kept for later', full_len: 14, redacted: false });
    setMeta(db, 'config.memory.model', 'off');
    const off = await memoryStatus(db, NOW);
    assert.equal(off[0], 'ok    memory: last heard just now (Claude Code 2d ago · sumo chat just now) · nothing filed yet');
    assert.equal(off[1], 'heard      Claude Code 2d ago · sumo chat just now');
    assert.equal(off[2], `model      off · in use: none: the pass is off, what is said is still kept and found by search · extractor ${extractorVersion(db)}`);
    assert.equal(off[3], 'waiting    1 finished conversation to read · 1 spooled event · 0 quarantined turns');
    assert.equal(off[4], 'filing     on');
    assert.match(off[5], /^last tidy {2}never · weekly sweep: never/);
    assert.doesNotMatch(off.join('\n'), /guess|side by side|turns? to file/, 'what is gone is not said');

    setMeta(db, 'config.memory.model', 'haiku');
    notePass(db, { ok: false, error: 'rate limited' });
    assert.equal((await memoryStatus(db, NOW))[4], 'filing     on — failed 1 time in a row, pauses at three');
    notePass(db, { ok: false, error: 'rate limited' });
    notePass(db, { ok: false, error: 'rate limited' });
    const paused = await memoryStatus(db, NOW);
    assert.match(paused[0], /^warn {2}memory: .* — filing is paused: the last 3 passes failed \(rate limited\)/);
    assert.match(paused[2], /^model {6}haiku · in use: haiku, as set · extractor /);
    assert.match(paused[4], /^filing {5}paused — the last 3 passes failed \(rate limited\)/);

    notePass(db, { ok: true, fallbackUsed: true });
    setMeta(db, 'config.memory.model', 'local');
    assert.match((await memoryStatus(db, NOW))[2], /· in use: the fallback: the local model could not answer the last pass · /);
  });
});

test('the spool is the user\'s alone: doctor names one others can read and --fix closes it, and uninstall takes it away with the rest', () => {
  const s = sandbox();
  s.sumo(['config']);
  const spool = join(s.home, 'spool');
  mkdirSync(spool, { mode: 0o700 });
  writeFileSync(join(spool, 'events.jsonl'), '{"v":1}\n');
  chmodSync(join(spool, 'events.jsonl'), 0o644);
  chmodSync(spool, 0o755);

  assert.match(s.sumo(['doctor']).out, /^warn {2}2 places in the home others can read: spool, spool\/events\.jsonl — run: sumo doctor --fix$/m);
  assert.match(s.sumo(['doctor', '--fix']).out, /^fixed: made 2 places private$/m);
  assert.equal(statSync(join(spool, 'events.jsonl')).mode & 0o777, 0o600);
  assert.equal(statSync(spool).mode & 0o777, 0o700);

  const gone = s.sumo(['uninstall', '--yes']);
  assert.equal(gone.code, 0, gone.err);
  assert.equal(existsSync(spool), false, 'what was said and not yet filed does not stay behind');
});

test('finished conversations left unread for over 48 hours while the writer is on fail memory\'s health, naming how many and what to run — never with the writer off, once read, or while they are fresh', async () => {
  await withDb(async (db) => {
    // Ten that ended with their goodbye; twenty whose terminal was simply closed.
    for (let i = 0; i < 30; i++) {
      ensureSession(db, { id: `old-${i}`, harness: 'claude', now: ago(40 - i / 10) });
      recordTurn(db, { sessionId: `old-${i}`, text: `from now on always use tool number${i} for task${i}`, now: ago(40 - i / 10) });
      if (i < 10) endSession(db, `old-${i}`, ago(40 - i / 10));
    }
    heard(db, 'claude', 1.5);
    assert.equal(memoryHealth(db, NOW).unread.count, 30, 'the one heard a day and a half ago is not two days unread');
    const line = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: line.ok, fail: line.fail }, { ok: false, fail: true });
    assert.match(line.label, / · 30 finished conversations unread for over 48 hours$/);
    assert.equal(line.fix, `30 finished conversations have waited over 48 hours to be read (the oldest since ${ago(40).slice(0, 10)}): sumo memory run reads them, and sumo memory status says whether filing is paused`);

    setMeta(db, 'config.memory.model', 'off');
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).ok, true, 'nothing is owed to a writer that is off');
    setMeta(db, 'config.memory.model', 'local');
    const were = db.prepare(`SELECT id, started_at, last_turn_at, ended_at FROM sessions WHERE id LIKE 'old-%'`).all();
    db.prepare(`UPDATE sessions SET started_at = ?, last_turn_at = ?, ended_at = CASE WHEN ended_at IS NULL THEN NULL ELSE ? END WHERE id LIKE 'old-%'`).run(ago(1.9), ago(1.9), ago(1.9));
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).ok, true, 'under two days: the next pass reads them');
    for (const s of were) db.prepare('UPDATE sessions SET started_at = ?, last_turn_at = ?, ended_at = ? WHERE id = ?').run(s.started_at, s.last_turn_at, s.ended_at, s.id);
    db.exec(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at)
             SELECT session_id, 'other000', 'ok', 1, MIN(id), MAX(id), MIN(ts), MIN(ts) FROM user_turns WHERE session_id LIKE 'old-%' GROUP BY session_id`);
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).fail, false, 'read, under whatever extractor: not waiting');
  });
});

test('unread conversations fail sumo memory check, the status and doctor alike', () => {
  const s = sandbox();
  for (let i = 0; i < 3; i++) s.hook('prompt', { session_id: `old${i}`, prompt: `from now on always use tool number${i} for task${i}` });
  const then = new Date(Date.now() - 40 * 86_400_000).toISOString();
  s.sql((db) => {
    db.prepare('UPDATE sessions SET started_at = ?, last_turn_at = ?, ended_at = ?').run(then, then, then);
    db.prepare('UPDATE user_turns SET ts = ?').run(then);
  });
  const said = /^FAIL {2}memory: last heard 40d ago · nothing filed yet · 3 finished conversations unread for over 48 hours — 3 finished conversations have waited over 48 hours to be read \(the oldest since \d{4}-\d\d-\d\d\): sumo memory run reads them/m;
  for (const command of [['memory', 'check'], ['memory', 'status'], ['doctor']]) {
    const run = s.sumo(command);
    assert.equal(run.code, 1, command.join(' '));
    assert.match(run.out, said, command.join(' '));
  }
  // Read, they are no longer owed.
  s.modelWillSay([]);
  assert.match(s.sumo(['memory', 'run']).out, /^read 3 turns/);
  assert.match(s.sumo(['memory', 'status']).out, /^ok {4}memory: last heard 40d ago · last filed just now$/m);
});

test('ten conversations read in a row with nothing filed is said as a warning — nothing is the normal answer for one conversation, not for ten — until one files something', () => {
  const s = sandbox();
  const read = (from, to, ops) => {
    for (let i = from; i < to; i++) {
      s.hook('prompt', { session_id: `e${i}`, prompt: `from now on always use tool number${i} for task${i}` });
      s.hook('session-end', { session_id: `e${i}` });
    }
    s.modelWillSay(ops);
    for (let i = from; i < to; i += 5) assert.match(s.sumo(['memory', 'run', '--auto']).out, /^read \d+ turns/);
  };
  read(0, 9, []);
  assert.equal(s.sql((db) => emptyRun(db)), 9);
  assert.match(s.sumo(['memory', 'status']).out, /^ok {4}memory: /, 'nine: not yet');
  read(9, 12, []);
  assert.equal(s.sql((db) => emptyRun(db)), 12);
  const said = /^warn {2}memory: last heard just now · last filed just now · the last 12 conversations read filed nothing — nothing is the normal answer for one conversation, not for 12 in a row: sumo memory show prints what the model is sent, sumo memory eval measures what it files/m;
  const check = s.sumo(['memory', 'check']);
  assert.match(check.out, said);
  assert.match(check.out, /^ok {4}filing is on — the last 12 conversations read filed nothing$/m);
  const status = s.sumo(['memory', 'status']);
  assert.match(status.out, said);
  assert.equal(status.code, 0, 'a warning, not a failure');
  assert.match(s.sumo(['doctor']).out, said);

  read(12, 13, [{ op: 'add', type: 'preference', scope: 'global', topic: 't', body: 'Always use tool number12 for task12', turn: 13, quote: 'always use tool number12 for task12', keys: [] }]);
  assert.equal(s.sql((db) => emptyRun(db)), 0);
  assert.match(s.sumo(['memory', 'status']).out, /^ok {4}memory: /);
});

test('a prompt that is a slash command is not kept, and still counts as heard: Claude Code used only through commands for days is not called deaf', async () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'c1', prompt: 'the invoice exporter crashes on umlauts' });
  const then = new Date(Date.now() - 3 * 86_400_000).toISOString();
  s.sql((db) => {
    db.prepare('UPDATE user_turns SET ts = ?').run(then);
    db.prepare('UPDATE sessions SET started_at = ?, last_turn_at = ?').run(then, then);
    db.prepare(`DELETE FROM meta WHERE key LIKE 'heard_at.%'`).run();
    // Read by the pass of its day: this is about hearing.
    db.prepare(`INSERT INTO extractions (session_id, extractor_version, status, attempts, first_turn, last_turn, started_at, ended_at) VALUES ('c1', 'v0', 'ok', 1, 1, 1, ?, ?)`).run(then, then);
  });
  const inside = { extraEnv: { CLAUDECODE: '1' } };
  assert.match(s.sumo(['search', 'invoice exporter'], inside).err, /this Claude Code session is not being heard/, 'three days of nothing, and a command run from it');
  assert.equal(s.sumo(['memory', 'status']).code, 1);

  // The hooks are there: the user typed a slash command, which is nothing to keep — and everything to hear.
  s.hook('prompt', { session_id: 'c2', prompt: '/compact' });
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns').get().n), 1, 'not journaled');
  s.sql((db) => db.prepare(`DELETE FROM meta WHERE key = 'heard.claude_told_at'`).run());
  assert.equal(s.sumo(['search', 'invoice exporter'], inside).err, '');
  const status = s.sumo(['memory', 'status']);
  assert.equal(status.code, 0, status.out);
  assert.match(status.out, /^ok {4}memory: last heard just now/);
  assert.match(status.out, /^heard {6}Claude Code just now · sumo chat never$/m);
});

test('one conversation left open and unread for over two days fails the check even when nothing has started since — the status said "1 finished conversation to read" beside checks that were all ok; a reply counts as the conversation going on', async () => {
  await withDb(async (db) => {
    ensureSession(db, { id: 'long', harness: 'claude', now: ago(6) });
    for (let d = 6; d >= 3; d--) recordTurn(db, { sessionId: 'long', text: `day ${d}: from now on always use tool number${d} for task${d}`, now: ago(d) });
    recordReply(db, { sessionId: 'long', text: 'Understood.', now: ago(2.01) });
    const line = memoryHealthLine(memoryHealth(db, NOW), NOW);
    assert.deepEqual({ ok: line.ok, fail: line.fail }, { ok: false, fail: true });
    assert.match(line.fix, /^1 finished conversation has waited over 48 hours to be read \(the oldest since \d{4}-\d\d-\d\d\): sumo memory run reads them/);

    // Answered an hour ago, it was still going on then.
    recordReply(db, { sessionId: 'long', text: 'One more thing.', now: ago(0.04) });
    assert.equal(memoryHealthLine(memoryHealth(db, NOW), NOW).ok, true);
  });
});

test('what was said over an hour ago and still waits in the spool is said in the block a session starts with', async () => {
  await withDb(async (db) => {
    const waiting = (at, text) => spoolEvent({ v: 1, at, event: 'prompt', harness: 'claude', session_id: 's1', text, full_len: text.length, redacted: false });
    waiting(new Date(Date.parse(NOW) - 20 * 60_000).toISOString(), 'said twenty minutes ago');
    assert.doesNotMatch(prime(db, { now: NOW }), /waiting to be written/, 'the next thing said replays it: not worth a line yet');
    waiting(new Date(Date.parse(NOW) - 3 * 3_600_000).toISOString(), 'said three hours ago');
    assert.match(prime(db, { now: NOW }), /^Warning: 2 things said in a session are still waiting to be written to memory, the oldest for 3 hours — the database could not take them\. Tell the user; sumo memory check says where they wait and why\.$/m);
  });
});
