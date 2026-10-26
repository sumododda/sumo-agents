// What a long job is given beyond the loop's own notes: what code knows of its work after a summary, the user's answers kept
// through every clear, a limit in minutes, the same error said once it keeps coming back, and the local model's look at whether
// the last calls go round in circles.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, setMeta } from '../src/db.mjs';
import { newJob, note, verifyJob } from '../src/jobs.mjs';
import { jobTools } from '../src/jobtools.mjs';
import { CIRCLES, converse, jobMinutes, jobParams, paramsFor, runJob, runLines, stopReason } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { ASK_TOOL, childEnv } from '../src/tools.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-10-26T12:00:00.000Z';
const STAND_IN = join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs');

/** A project on disk, registered under a name of its own, with one running job routed to a model — the least a run needs. */
let seeded = 0;
function seed(db, { agent = 'scout', model = 'haiku', effort = 'none' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-extras-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true' } }));
  const { project: { slug } } = addProject(db, root, { slug: `demo-${++seeded}`, now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, ?, ?, 'running', 's1', ?, ?, ?, ?, 'test')`)
    .run(slug, 'demo job', agent, NOW, NOW, model, effort);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — demo job\n\n## The task\nsay hello\n`);
  return { root, id };
}

/** A committed repository whose one check passes while the file `status` says ok. */
function gitRepo(dir) {
  mkdirSync(dir, { recursive: true });
  for (const [file, text] of Object.entries({ Makefile: 'test:\n\t@test "$$(cat status)" = ok\n', status: 'ok\n', 'src.js': 'export const thing = 1;\n' })) writeFileSync(join(dir, file), text);
  const git = (...args) => spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8' });
  git('init', '-q', '-b', 'trunk');
  git('config', 'user.email', 'test@example.com');
  git('config', 'user.name', 'test');
  git('add', '-A');
  git('commit', '-q', '-m', 'start');
  return dir;
}

/** The envelope the stand-in prints for a local call, holding `data` as the answer. */
const envelope = (data) => JSON.stringify({ is_error: false, result: '', structured_output: data, usage: { input_tokens: 10, output_tokens: 5 }, total_cost_usd: 0 });

const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const scoutParams = () => jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' });
const sandboxCtx = () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-extras-'));
  return { root, ctx: { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) } };
};
/** The text each tool result of a conversation came back with, in order, after the brief. */
const answers = (params) => params.messages.filter((m) => m.role === 'user').slice(1).flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.content));
/** Where in a conversation's answers a note of sumo's rides, counted from one. */
const notedAt = (said) => said.flatMap((a, i) => (/\[sumo: /.test(a) ? [i + 1] : []));

test("the user's answers are never cleared: the ask tools, the chat's and a job's, are kept out of every clear of old tool results", () => {
  const jobAsk = jobTools('worker').find((t) => /only the user can decide/.test(t.description));
  assert.ok(jobAsk, "a job's ask tool");
  const worker = jobParams({ job: { agent: 'worker', model: 'sonnet', effort: 'medium' }, text: 'build', system: 'rules' });
  const chat = paramsFor({ model: 'opus', effort: 'high', tools: [ASK_TOOL], text: 'hi', system: 'rules' });
  for (const params of [scoutParams(), worker, chat]) {
    const [edit] = params.context_management.edits;
    assert.ok(edit.exclude_tools.includes(ASK_TOOL.name), "the chat's ask tool");
    assert.ok(edit.exclude_tools.includes(jobAsk.name), "a job's ask tool");
  }
});

test('the same error coming back from failing commands is said once, at the fourth time, quoted; numbers, ids and paths do not make it another; a command that passed is never counted', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { ctx } = sandboxCtx();
      const commands = [
        // Six tries that fail the same way, each with its own path, number and id: the commands differ, so no other note is said.
        ...[1, 2, 3, 4, 5, 6].map((n) => `echo "building step ${n}"; echo "Error: cannot read /tmp/run-${n}/cache-${n}.json (code ${n * 7}, id 9f8e7d${n}c)"; exit 1`),
        // The same words from commands that passed: not an error that came back.
        ...[1, 2, 3, 4, 5].map((n) => `echo "Error: cannot read /tmp/run-${n}/cache-${n}.json (code ${n}, id 9f8e7d${n}c)"`),
        // Another error, too long to quote whole: its own count, said once.
        ...[1, 2, 3, 4].map((n) => `echo "FAIL ${'x'.repeat(300)} ${n}"; exit 2`),
      ];
      const responses = [...commands.map((command, i) => reply('tool_use', [call(`t${i}`, 'bash', { command })])), reply('end_turn', [{ type: 'text', text: 'gave up' }])];
      const params = scoutParams();
      const outcome = await converse(db, params, { send: async () => responses.shift(), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(outcome.stop, 'end_turn', 'a note, never a stop');
      const said = answers(params);
      assert.deepEqual(notedAt(said), [4, 15], 'the fourth of the first error and the fourth of the second, and nothing for the commands that passed');
      assert.match(
        said[3],
        /\(exit 1\)\n\[sumo: this error has come back 4 times in this run: "Error: cannot read \/tmp\/run-4\/cache-4\.json \(code 28, id 9f8e7d4c\)" — step back and find its cause rather than trying another variation\.\]$/,
      );
      const quoted = /this error has come back 4 times in this run: "([^"]*)"/.exec(said[14])[1];
      assert.equal(quoted.length, 200, 'the quote is capped');
      assert.ok(quoted.startsWith('FAIL xxx'));
    } finally {
      db.close();
    }
  });
});

test('a job has a limit in minutes from the settings: a word means the default, 0 means none', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      assert.equal(jobMinutes(db), 60, 'an hour until it is set');
      for (const [stored, minutes] of [['90', 90], ['0', null], ['soon', 60], ['', 60], ['-3', 60], ['1.5', 60]]) {
        setMeta(db, 'config.jobs.minutes', stored);
        assert.equal(jobMinutes(db), minutes, `"${stored}"`);
      }
    } finally {
      db.close();
    }
  });
});

test('a limit set with sumo config is a whole number of minutes, 0 or more; anything else is refused and not stored', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'jobs.minutes']).out, /^jobs\.minutes = 60$/m);
  for (const bad of ['soon', '-1', '1.5', '', '10m']) {
    const run = s.sumo(['config', 'jobs.minutes', bad]);
    assert.equal(run.code, 2, `"${bad}" → ${run.out}`);
    assert.match(run.err, /jobs\.minutes needs a whole number of minutes, 0 or more/);
  }
  assert.match(s.sumo(['config', 'jobs.minutes']).out, /^jobs\.minutes = 60$/m, 'a refused value is not stored');
  for (const good of ['0', '90']) assert.ok(s.sumo(['config', 'jobs.minutes', good]).out.split('\n').includes(`jobs.minutes = ${good}`), good);
});

test('a job near its time is told once to close, and at its time it is stopped with its last round answered; the run told to close goes on with the same clock', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      setMeta(db, 'config.jobs.minutes', '10');
      // Each request takes three minutes of the clock.
      let clock = Date.parse(NOW);
      const now = () => new Date(clock).toISOString();
      let n = 0;
      const seen = [];
      const send = async (params) => {
        seen.push(structuredClone(params.messages.at(-1)));
        clock += 3 * 60_000;
        n++;
        return reply('tool_use', [call(`t${n}`, 'bash', { command: `echo ${n}` })]);
      };
      const outcome = await runJob(db, id, { send, now });
      assert.equal(outcome.stop, 'time');
      assert.equal(outcome.turns, 4, 'twelve minutes in after the fourth reply: nothing more is sent');
      // The warning rides with the results of the third reply, the first past eight minutes, and with no other.
      const warned = seen.map((m) => m.content.filter((b) => b.type === 'text' && /minutes/.test(b.text)).map((b) => b.text));
      assert.deepEqual(warned.map((w) => w.length), [0, 0, 0, 1]);
      assert.match(warned[3][0], /^This job has run 9 of its 10 minutes, and is stopped when it reaches them\. Close it with `finish` now: DONE only if the work is verified, otherwise FAILED/);
      assert.equal(stopReason('time'), 'stopped: the job reached its time limit — sumo config jobs.minutes sets it, 0 for none');
      assert.ok(runLines(outcome).includes(stopReason('time')));

      // A job that ended its turn past its time is told to close, and that run starts on the same clock: it sends nothing.
      const other = seed(db).id;
      clock = Date.parse(NOW);
      let sent = 0;
      const late = await runJob(db, other, { send: async () => ((clock += 11 * 60_000), sent++, reply('end_turn', [{ type: 'text', text: 'all done' }])), now });
      assert.equal(late.stop, 'time');
      assert.equal(sent, 1);

      // No limit at all: the same clock never stops it.
      setMeta(db, 'config.jobs.minutes', '0');
      const free = seed(db).id;
      clock = Date.parse(NOW);
      let k = 0;
      const unlimited = await runJob(db, free, { send: async () => ((clock += 60 * 60_000), ++k <= 3 ? reply('tool_use', [call(`f${k}`, 'bash', { command: `echo ${k}` })]) : reply('end_turn', [])), now });
      assert.notEqual(unlimited.stop, 'time');
    } finally {
      await closeMcp();
      db.close();
    }
  });
});

test("after a job's summary, the line that follows carries what code recorded: the files changed since it began, the last verdict, its notes; a record changed since sumo wrote it is left out", async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-extras-'));
  const routerAnswer = join(root, 'router-answer.json');
  writeFileSync(routerAnswer, envelope({ model: 'sonnet', effort: 'low', reason: 'a stand-in' }));
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ROUTER_ANSWER: routerAnswer, SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log') }, async () => {
    const db = openDb();
    try {
      const dir = gitRepo(join(root, 'proj'));
      addProject(db, dir, { slug: 'proj', now: NOW });
      const { job } = await newJob(db, { project: 'proj', title: 'return 2', agent: 'worker', task: '## Goal\nReturn 2.\n## Check\n`make test` exits 0.\n' });
      writeFileSync(join(dir, 'src.js'), 'export const thing = 2;\n');
      assert.equal(verifyJob(db, job.id).ok, true);
      note(db, job.id, 'src.js returns 2; next: the helpers');
      note(db, job.id, 'helpers written; next: wire them in');
      // After the verdict: new files, more of them than the line has room for.
      for (let i = 1; i <= 25; i++) writeFileSync(join(dir, `helper-${String(i).padStart(2, '0')}.js`), `export const h${i} = ${i};\n`);

      const big = { input_tokens: 160_000, output_tokens: 100 };
      const summary = { stop_reason: 'compaction', content: [{ type: 'compaction', content: 'what happened so far', encrypted_content: 'opaque', signature: 'sig' }], usage: { input_tokens: 160_000, output_tokens: 600 } };
      const resumedLine = async () => {
        const responses = [reply('tool_use', [call('t1', 'bash', { command: 'echo one' })], big), summary, reply('end_turn', [{ type: 'text', text: 'paused' }]), reply('end_turn', [])];
        const seen = [];
        await runJob(db, job.id, { send: async (params) => (seen.push(structuredClone(params)), responses.shift()), now: () => NOW });
        assert.deepEqual(seen[2].messages.map((m) => m.role), ['assistant', 'user']);
        return seen[2].messages[1].content[0].text;
      };

      const text = await resumedLine();
      assert.match(text, new RegExp(`^The conversation before this point was summarized above[\\s\\S]*sumo job brief ${job.id}\\n\\n`));
      const files = /\nChanged since the job began:\n([\s\S]*?)\n\n/.exec(text)[1].split('\n');
      assert.equal(files.length, 20, 'at most twenty lines');
      assert.match(files[0], /^ src\.js \| 2 \+-$/);
      assert.match(files[1], /^ 1 file changed, 1 insertion\(\+\), 1 deletion\(-\)$/);
      assert.equal(files[2], ' new file: helper-01.js');
      assert.equal(files.at(-1), ' … and 8 more new files');
      assert.match(text, /\nThe checks last ran at \S+ and passed, on files that have changed since:\n- `make test` passed/);
      assert.match(text, /\nYour notes so far:\n- src\.js returns 2; next: the helpers\n- helpers written; next: wire them in$/);

      // The record of where the work began, changed by anyone but sumo: no files and no verdict from it, the notes still.
      const record = join(paths().jobs, String(job.id), 'verify.json');
      writeFileSync(record, readFileSync(record, 'utf8').replace('"ok": true', '"ok": false'));
      const after = await resumedLine();
      assert.doesNotMatch(after, /Changed since the job began|The checks last ran/);
      assert.match(after, /\nYour notes so far:\n- src\.js returns 2/);
    } finally {
      await closeMcp();
      db.close();
    }
  });
});

test('every thirty requests a job asks the local model whether its last twelve calls go round in circles; a yes is said once with why; a no, a failure or a slow answer is not said at all', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-extras-'));
  const answer = join(dir, 'answer.json');
  const capture = join(dir, 'capture.json');
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STAND_IN, STUB_ANSWER: answer, STUB_CAPTURE: capture }, async () => {
    const db = openDb();
    try {
      // Thirty-one distinct calls, the twentieth with an input too long to show whole, and then the end.
      const run = async (id) => {
        let n = 0;
        const seen = [];
        const send = async (params) => {
          seen.push(structuredClone(params));
          n++;
          if (n > 31) return reply('end_turn', [{ type: 'text', text: 'done' }]);
          return reply('tool_use', [call(`t${n}`, 'bash', { command: n === 20 ? `echo ${'y'.repeat(400)}` : `echo ${n}` })]);
        };
        const outcome = await runJob(db, id, { send, now: () => NOW });
        return { outcome, said: answers(seen.at(-1)) };
      };

      writeFileSync(answer, envelope({ stuck: true, why: `it echoes one number after another and learns nothing new ${'z'.repeat(300)}` }));
      const stuck = await run(seed(db).id);
      assert.equal(stuck.outcome.stop, 'end_turn', 'a note, never a stop');
      assert.deepEqual(notedAt(stuck.said), [30], 'with the results of the thirtieth request, and only then');
      assert.match(stuck.said[29], /^30\n\[sumo: your last 12 calls look to be going round in circles: it echoes one number after another and learns nothing new z+ — step back and find what blocks you, or stop and say so\.\]$/);
      assert.ok(/: (it echoes[^—]*) —/.exec(stuck.said[29])[1].length <= 200, 'why is capped');
      const asked = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(asked.model, 'local');
      assert.equal(asked.kind, 'loop');
      assert.deepEqual(Object.keys(asked.schema.properties), ['stuck', 'why']);
      const shown = asked.prompt.split('\n');
      assert.equal(shown.length, 12, 'the last twelve calls');
      assert.equal(shown[0], 'bash {"command":"echo 19"}');
      assert.equal(shown.at(-1), 'bash {"command":"echo 30"}');
      assert.equal(shown[1].length, 200, 'each cut to 200 characters');

      writeFileSync(answer, envelope({ stuck: false, why: 'each echo is new' }));
      assert.deepEqual(notedAt((await run(seed(db).id)).said), []);
      writeFileSync(answer, envelope({ answer: 'not the shape asked for' }));
      assert.deepEqual(notedAt((await run(seed(db).id)).said), []);
      process.env.STUB_LOCAL_FAILS = '1';
      try {
        assert.deepEqual(notedAt((await run(seed(db).id)).said), []);
      } finally {
        delete process.env.STUB_LOCAL_FAILS;
      }

      // A check that does not answer in time, or fails outright, holds the turn no longer than its cap, and is not said.
      const { ctx } = sandboxCtx();
      for (const ask of [() => new Promise(() => {}), async () => { throw new Error('the server went away'); }]) {
        let m = 0;
        const params = scoutParams();
        const began = Date.now();
        const outcome = await converse(db, params, {
          send: async () => (++m <= 4 ? reply('tool_use', [call(`c${m}`, 'bash', { command: `echo ${m}` })]) : reply('end_turn', [])),
          ctx,
          ledger: { kind: 'scout' },
          now: () => NOW,
          circling: { ...CIRCLES, every: 2, ms: 50, ask },
        });
        assert.equal(outcome.stop, 'end_turn');
        assert.deepEqual(notedAt(answers(params)), []);
        assert.ok(Date.now() - began < 5000);
      }
    } finally {
      await closeMcp();
      db.close();
    }
  });
});
