// What a long job costs: tool output cleared rarely and in big chunks, a dollar cap with a warning before it, and the loops that burn money caught sooner.
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { modelId } from '../src/catalog.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { converse, jobBudget, jobParams, paramsFor, runJob, runLines, stopReason } from '../src/loop.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { costOf } from '../src/model.mjs';
import { paths } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { childEnv } from '../src/tools.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-10-25T12:00:00.000Z';

/** A project on disk, registered, with one running job routed to a model — the least a run needs. */
function seed(db, { agent = 'scout', model = 'haiku', effort = 'none' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-budget-'));
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'demo', scripts: { test: 'true' } }));
  const { project: { slug } } = addProject(db, root, { slug: 'demo', now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, ?, ?, 'running', 's1', ?, ?, ?, ?, 'test')`)
    .run(slug, 'demo job', agent, NOW, NOW, model, effort);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — demo job\n\n## The task\nsay hello\n`);
  return { root, id };
}

const reply = (stop, content, usage = { input_tokens: 100, output_tokens: 10 }) => ({ stop_reason: stop, content, usage });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
const scoutParams = () => jobParams({ job: { agent: 'scout', model: 'haiku', effort: 'none' }, text: 'look', system: 'rules' });
const sandboxCtx = () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-budget-'));
  return { root, ctx: { cwd: root, roots: [root], env: childEnv({ PATH: process.env.PATH }) } };
};
/** The text each tool result of a conversation came back with, in order, after the brief. */
const answers = (params) => params.messages.filter((m) => m.role === 'user').slice(1).flatMap((m) => m.content.filter((b) => b.type === 'tool_result').map((b) => b.content));

test('tool output is cleared rarely and in big chunks, since each clear writes the cache again; what the API cleared is on the ledger row', async () => {
  for (const params of [scoutParams(), paramsFor({ model: 'opus', effort: 'high', tools: [], text: 'hi', system: 'rules' })]) {
    assert.deepEqual(params.context_management.edits, [
      { type: 'clear_tool_uses_20250919', trigger: { type: 'input_tokens', value: 100_000 }, keep: { type: 'tool_uses', value: 5 }, clear_at_least: { type: 'input_tokens', value: 40_000 }, exclude_tools: ['ask'] },
    ]);
  }

  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { ctx } = sandboxCtx();
      const responses = [
        { ...reply('tool_use', [call('t1', 'bash', { command: 'echo one' })]), context_management: { applied_edits: [{ type: 'clear_tool_uses_20250919', cleared_tool_uses: 12, cleared_input_tokens: 41_200 }] } },
        { ...reply('tool_use', [call('t2', 'bash', { command: 'echo two' })]), context_management: { applied_edits: [] } },
        { ...reply('end_turn', [{ type: 'text', text: 'done' }]), context_management: null },
      ];
      const outcome = await converse(db, scoutParams(), { send: async () => responses.shift(), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(outcome.stop, 'end_turn');
      assert.deepEqual(db.prepare('SELECT note FROM model_runs ORDER BY id').all().map((r) => r.note), ['turn 1 tool_use cleared 12 tool uses (41k)', 'turn 2 tool_use', 'turn 3 end_turn']);
    } finally {
      db.close();
    }
  });
});

test('a job has a dollar budget from the settings: a word means the default, 0 means none', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      assert.equal(jobBudget(db), 10, 'ten dollars until it is set');
      for (const [stored, budget] of [['2.5', 2.5], ['0', null], ['lots', 10], ['', 10], ['-3', 10]]) {
        setMeta(db, 'config.jobs.budget', stored);
        assert.equal(jobBudget(db), budget, `"${stored}"`);
      }
    } finally {
      db.close();
    }
  });
});

test('a budget set with sumo config is a number of dollars, 0 or more; anything else is refused and not stored', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'jobs.budget']).out, /^jobs\.budget = 10$/m);
  for (const bad of ['lots', '-1', '1,000', '$5', '', '0x10']) {
    const run = s.sumo(['config', 'jobs.budget', bad]);
    assert.equal(run.code, 2, `"${bad}" → ${run.out}`);
    assert.match(run.err, /jobs\.budget needs a number of dollars, 0 or more/);
  }
  assert.match(s.sumo(['config', 'jobs.budget']).out, /^jobs\.budget = 10$/m, 'a refused value is not stored');
  for (const good of ['2.5', '0', '25']) assert.ok(s.sumo(['config', 'jobs.budget', good]).out.split('\n').includes(`jobs.budget = ${good}`), good);
});

test('a job near its budget is told once to close, and at the budget it is stopped with its last round answered; the stop is said', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      const usage = { input_tokens: 100_000, output_tokens: 0 }; // under the size at which a job is summarized
      const each = costOf(modelId('haiku'), usage);
      assert.ok(each > 0);
      setMeta(db, 'config.jobs.budget', String(10.5 * each));
      let n = 0;
      const seen = [];
      const send = async (params) => {
        seen.push(structuredClone(params.messages.at(-1)));
        n++;
        return reply('tool_use', [call(`t${n}`, 'bash', { command: `echo ${n}` })], usage);
      };
      const outcome = await runJob(db, id, { send, now: () => NOW });
      assert.equal(outcome.stop, 'budget');
      assert.equal(outcome.turns, 11, 'past 10.5 of 10.5 after the eleventh reply: nothing more is sent');
      assert.equal(seen.length, 11);
      // The warning rides with the results of the ninth reply, the first past 80%, and with no other.
      const warned = seen.map((m) => m.content.filter((b) => b.type === 'text' && /budget/.test(b.text)).map((b) => b.text));
      assert.deepEqual(warned.map((w) => w.length), [0, 0, 0, 0, 0, 0, 0, 0, 0, 1, 0]);
      assert.match(warned[9][0], /^This job has spent \$\d+\.\d\d of its \$\d+\.\d\d budget[\s\S]*`finish` now: DONE only if the work is verified, otherwise FAILED with where it stands/);
      assert.equal(stopReason('budget'), 'stopped: the job reached its budget — sumo config jobs.budget sets it, 0 for none');
      assert.ok(runLines(outcome).includes(stopReason('budget')));
    } finally {
      await closeMcp();
      db.close();
    }
  });
});

test('what a job spent before it was told to close counts against its budget when it goes on; the chat has no budget', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      const usage = { input_tokens: 100_000, output_tokens: 0 }; // under the size at which a job is summarized
      const each = costOf(modelId('haiku'), usage);
      setMeta(db, 'config.jobs.budget', String(1.5 * each));
      const responses = [reply('end_turn', [{ type: 'text', text: 'all done' }], usage), reply('tool_use', [call('t1', 'bash', { command: 'echo closing' })], usage), reply('end_turn', [], usage)];
      let sent = 0;
      const outcome = await runJob(db, id, { send: async () => (sent++, responses.shift()), now: () => NOW });
      assert.equal(outcome.stop, 'budget');
      assert.equal(sent, 2, 'the second run starts with the first one\'s spend, and ends at the budget');

      // The chat: the same spend, and no cap at all.
      const { ctx } = sandboxCtx();
      let m = 0;
      const chat = await converse(db, paramsFor({ model: 'haiku', tools: [], text: 'hi', system: 'rules' }), {
        send: async () => (++m < 4 ? reply('tool_use', [call(`c${m}`, 'bash', { command: `echo ${m}` })], usage) : reply('end_turn', [{ type: 'text', text: 'ok' }], usage)),
        ctx,
        ledger: { kind: 'chat' },
        now: () => NOW,
      });
      assert.equal(chat.stop, 'end_turn');
      assert.equal(chat.turns, 4);
    } finally {
      await closeMcp();
      db.close();
    }
  });
});

test('a round of two to four calls gone round with the same answers is said at the third time round and stopped at the fifth; a round whose answers change is polling, never said or stopped', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { ctx } = sandboxCtx();
      // One call a reply, round three of them, each with the answer it had the time before.
      const round = ['echo a', 'echo b', 'echo c'];
      let n = 0;
      const circling = scoutParams();
      const outcome = await converse(db, circling, { send: async () => reply('tool_use', [call(`t${n}`, 'bash', { command: round[n++ % 3] })]), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(outcome.stop, 'loop');
      assert.equal(outcome.turns, 15);
      const said = answers(circling);
      const noted = said.flatMap((a, i) => (/\[sumo: /.test(a) ? [i + 1] : []));
      assert.deepEqual(noted, [9, 12], 'when the third and the fourth round come to an end');
      assert.match(said[8], /\n\[sumo: these 3 calls, with the same input and the same answers in the same order, 3 times in a row — going round them again changes nothing\./);
      assert.match(said[11], /4 times in a row/);
      assert.equal(stopReason('loop'), 'stopped: the same call, or the same round of calls, was made 5 times in a row');

      // Two calls in each reply, the same two: stopped at the fifth reply.
      let m = 0;
      const pairs = await converse(db, scoutParams(), { send: async () => (m++, reply('tool_use', [call(`p${m}a`, 'bash', { command: 'echo left' }), call(`p${m}b`, 'bash', { command: 'echo right' })])), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.deepEqual([pairs.stop, pairs.turns], ['loop', 5]);

      // A wait and a look, round and round, with what the look sees changing: polling a job, not a loop. Twelve rounds, never said, never stopped.
      writeFileSync(join(ctx.cwd, 'step'), '0');
      const look = 'n=$(cat step); echo $((n+1)) > step; echo "j3 running, step $(cat step)"';
      let r = 0;
      const waiting = scoutParams();
      const waited = await converse(db, waiting, { send: async () => (++r <= 24 ? reply('tool_use', [call(`w${r}`, 'bash', { command: r % 2 ? 'sleep 0' : look })]) : reply('end_turn', [{ type: 'text', text: 'j3 is done' }])), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(waited.stop, 'end_turn');
      assert.equal(waited.turns, 25);
      assert.equal(answers(waiting).filter((a) => /\[sumo: /.test(a)).length, 0);
      assert.equal(readFileSync(join(ctx.cwd, 'step'), 'utf8').trim(), '12');

      // One call over and over with a new answer each time is polling too.
      writeFileSync(join(ctx.cwd, 'count'), '0');
      const poll = 'n=$(cat count); echo $((n+1)) > count; cat count';
      let k = 0;
      const polling = scoutParams();
      const polled = await converse(db, polling, { send: async () => (++k <= 12 ? reply('tool_use', [call(`q${k}`, 'bash', { command: poll })]) : reply('end_turn', [{ type: 'text', text: 'ready' }])), ctx, ledger: { kind: 'scout' }, now: () => NOW });
      assert.equal(polled.stop, 'end_turn');
      assert.equal(answers(polling).filter((a) => /\[sumo: /.test(a)).length, 0);
      assert.equal(readFileSync(join(ctx.cwd, 'count'), 'utf8').trim(), '12');
    } finally {
      db.close();
    }
  });
});

test('a file changed more than ten times in a run is said once — step back, view the whole region, make one edit — and the run goes on', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const { root, ctx } = sandboxCtx();
      writeFileSync(join(root, 'a.txt'), 'v0\n');
      writeFileSync(join(root, 'b.txt'), 'w0\n');
      // Fourteen edits that land on a.txt, named one way and the other; a failed edit and ten to b.txt between them count for nothing here.
      const edits = [];
      for (let i = 0; i < 14; i++) edits.push(call(`a${i}`, 'str_replace_based_edit_tool', { command: 'str_replace', path: i % 2 ? 'a.txt' : join(root, 'a.txt'), old_str: `v${i}`, new_str: `v${i + 1}` }));
      edits.splice(3, 0, call('miss', 'str_replace_based_edit_tool', { command: 'str_replace', path: 'a.txt', old_str: 'not there', new_str: 'x' }));
      for (let i = 0; i < 10; i++) edits.splice(5 + i, 0, call(`b${i}`, 'str_replace_based_edit_tool', { command: 'str_replace', path: 'b.txt', old_str: `w${i}`, new_str: `w${i + 1}` }));
      const responses = [...edits.map((c) => reply('tool_use', [c])), reply('end_turn', [{ type: 'text', text: 'edited' }])];
      const params = jobParams({ job: { agent: 'worker', model: 'haiku', effort: 'none' }, text: 'edit', system: 'rules' });
      const outcome = await converse(db, params, { send: async () => responses.shift(), ctx, ledger: { kind: 'worker' }, now: () => NOW });
      assert.equal(outcome.stop, 'end_turn', 'the note never stops a run');
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'v14\n');
      const said = answers(params);
      const noted = said.filter((a) => /\[sumo: /.test(a));
      assert.equal(noted.length, 1, 'once for the file, and b.txt, changed ten times, not at all');
      assert.match(noted[0], /^edited .*a\.txt\n\[sumo: this is change 11 to .*a\.txt in this run — step back: view the whole region you are changing, then make it right in one edit\.\]$/);
      assert.equal(said.indexOf(noted[0]), edits.findIndex((c) => c.id === 'a10'), 'with the eleventh edit that landed on it');
    } finally {
      db.close();
    }
  });
});
