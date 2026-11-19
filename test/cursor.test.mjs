// Jobs on Cursor's models: Cursor runs the loop, Sumo's tools answer it through the same gate and sandbox, and the ledger,
// the budget and the stop hold as on Claude. The SDK is stood in for: what it is sent and asked is checked, nothing reaches Cursor.
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { allModels, cursorSummary, discoverCursor, effortsOf, modelStates, offLine, onModels, saveListedPrices, setModel, usableJobModels } from '../src/catalog.mjs';
import { createChat } from '../src/chat.mjs';
import { converseCursor, cursorModel, tryCursorModel } from '../src/cursor.mjs';
import { openDb } from '../src/db.mjs';
import { outsideReads, tell } from '../src/jobs.mjs';
import { runJob } from '../src/loop.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { markInjected } from '../src/sessions.mjs';
import { BASH_TOOL, EDITOR_TOOL } from '../src/tools.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const NOW = '2026-11-18T12:00:00.000Z';
/** A folder of the test's own to work in: never the temporary folder itself, which other processes share. */
const place = () => mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-'));
const KEY = { CURSOR_API_KEY: 'test-cursor-key' };

/**
 * The Cursor SDK, stood in for: each send plays the next step of `script`, an async generator given the agent's custom tools,
 * the send's onDelta and whether the run was cancelled — what it yields is the run's stream. What it was asked is in `seen`.
 */
function fakeCursor(script) {
  const seen = { created: [], resumed: [], sent: [], cancelled: 0, closed: 0 };
  const agentOf = (options) => ({
    agentId: 'agent-1',
    close: () => {
      seen.closed++;
    },
    send: async (message, { onDelta } = {}) => {
      seen.sent.push(message);
      const step = script.shift();
      let cancelled = false;
      let words = '';
      // What the run said is its result, as Cursor's is.
      async function* stream() {
        for await (const m of step({ tools: options.local.customTools, onDelta: onDelta ?? (() => {}), cancelled: () => cancelled })) {
          if (m.type === 'assistant') words += m.message.content.map((b) => b.text).join('');
          yield m;
        }
      }
      return {
        cancel: async () => {
          cancelled = true;
          seen.cancelled++;
        },
        stream,
        wait: async () => (cancelled ? { status: 'cancelled' } : { status: 'finished', result: words }),
      };
    },
  });
  const Agent = {
    create: async (options) => {
      seen.created.push(options);
      return agentOf(options);
    },
    resume: async (id, options) => {
      seen.resumed.push({ id, ...options });
      return agentOf(options);
    },
  };
  return { seen, sdk: { Agent, emptyFs: () => EMPTY_FS } };
}
const said = (text) => ({ type: 'assistant', message: { content: [{ type: 'text', text }] } });
const used = (onDelta, input, output = 50) => onDelta({ update: { type: 'model-call-completed', usage: { inputTokens: input, outputTokens: output, cacheReadTokens: 0, cacheWriteTokens: 0 } } });

function seed(db, { model = 'composer', effort = 'medium', agent = 'worker' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-'));
  writeFileSync(join(root, 'a.txt'), 'one\ntwo\nthree\n');
  const { project: { slug } } = addProject(db, root, { slug: 'demo', now: NOW });
  const { lastInsertRowid } = db
    .prepare(`INSERT INTO jobs (project, title, agent, status, session_id, created_at, updated_at, model, effort, route_reason) VALUES (?, ?, ?, 'running', 's1', ?, ?, ?, ?, 'test')`)
    .run(slug, 'demo job', agent, NOW, NOW, model, effort);
  const id = Number(lastInsertRowid);
  mkdirSync(join(paths().jobs, String(id)), { recursive: true });
  writeFileSync(join(paths().jobs, String(id), 'brief.md'), `# Job j${id} — demo job\n\n## The task\nsay hello\n`);
  return { root, id };
}

test('a Cursor model is asked for by its standard variant, with Sumo\'s effort where it takes one', () => {
  assert.deepEqual(cursorModel('composer-2.5', 'high'), { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] }, 'never Fast, its default; no effort to set');
  assert.deepEqual(cursorModel('grok-4.7', 'max'), { id: 'grok-4.7', params: [{ id: 'context', value: '256k' }, { id: 'fast', value: 'false' }, { id: 'reasoning_effort', value: 'xhigh' }] }, "max is Grok's xhigh");
  assert.throws(() => cursorModel('claude-opus-5-5', 'high'), /not a Cursor model/);
});

test('a job on a Cursor model: Cursor gets Sumo\'s tools only, the brief with the date, and Sumo\'s tools run through the guard and the jail, with a ledger row per request', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { root, id } = seed(db);
      setModel(db, 'composer', true, NOW);
      const answers = [];
      const { seen, sdk } = fakeCursor([
        async function* ({ tools, onDelta }) {
          yield said('looking');
          answers.push(await tools.bash.execute({ command: 'printf hi; printenv CURSOR_API_KEY | grep -c . ; true' }, { toolCallId: 'c1' }));
          answers.push(await tools.bash.execute({ command: 'rm -rf ~' }, { toolCallId: 'c2' }));
          answers.push(await tools.str_replace_based_edit_tool.execute({ command: 'str_replace', path: 'a.txt', old_str: 'two', new_str: '2' }, { toolCallId: 'c3' }));
          used(onDelta, 4000);
          yield said('done');
          used(onDelta, 5000);
        },
        // Told to close the job, it ends again without: the run is over.
        async function* ({ onDelta }) {
          used(onDelta, 6000);
          yield said('still open');
        },
      ]);
      const outcome = await runJob(db, id, { cursorSdk: sdk, now: () => NOW });

      const [made] = seen.created;
      assert.deepEqual(made.tools, ['mcp'], 'the path custom tools come by — none of Cursor\'s own file or shell tools, and no web search or fetch: a worker has none on Claude');
      assert.deepEqual(made.local.settingSources, [], 'no .cursor rules, hooks or MCP servers from the project');
      assert.equal(made.local.cwd, realpathSync(join(paths().home, 'cursor')), 'kept in a folder of Sumo\'s, never the project');
      assert.equal(made.local.reportedWorkspacePath, realpathSync(root), 'the model is told the project');
      assert.deepEqual(made.model, { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] });
      assert.equal(made.apiKey, 'test-cursor-key');
      assert.deepEqual(Object.keys(made.local.customTools), [BASH_TOOL.name, EDITOR_TOOL.name, 'baseline', 'verify', 'note', 'ask', 'search_memory', 'finish']);
      assert.match(seen.sent[0], /Today is 2026-11-18\./);
      assert.match(seen.sent[0], /## The task\nsay hello/);

      assert.match(answers[0].content[0].text, /^hi0/, 'the shell ran, without the Cursor key in it');
      assert.equal(answers[1].isError, true, 'the guard refused rm -rf ~');
      assert.equal(readFileSync(join(root, 'a.txt'), 'utf8'), 'one\n2\nthree\n', 'the edit landed');

      // Told once to close the job, by the same agent, resumed with its tools again: Cursor does not keep them.
      assert.equal(seen.resumed.length, 1);
      assert.deepEqual(seen.resumed[0].tools, ['mcp']);
      assert.equal(seen.resumed[0].id, 'agent-1');
      assert.match(seen.sent[1], /^You ended without closing the job\. Call `finish` now/);
      assert.equal(seen.closed, 2, 'each run closes its agent');

      assert.equal(outcome.stop, 'end_turn');
      assert.equal(outcome.totals.toolCalls, 3);
      const rows = db.prepare(`SELECT model, input_tokens, cost_usd, ok FROM model_runs WHERE job_id = ? ORDER BY id`).all(id);
      assert.deepEqual(rows.map((r) => [r.model, r.input_tokens, r.ok]), [['composer-2.5', 4000, 1], ['composer-2.5', 5000, 1], ['composer-2.5', 6000, 1]], 'a row per request');
      assert.ok(rows.every((r) => r.cost_usd > 0), 'priced at Cursor\'s rates');
      assert.deepEqual(outsideReads(db, id), [], 'given no web search, it is not taken to have read the web');
    } finally {
      db.close();
    }
  });
});

test('a Cursor job is held to its budget and to a stop: the run is cancelled, and a call already sent is refused, not run', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const params = () => ({ model: 'grok-4.7', output_config: { effort: 'max' }, system: [{ type: 'text', text: 'You are Sumo.' }], messages: [{ role: 'user', content: [{ type: 'text', text: 'go' }] }], tools: [BASH_TOOL] });
      const ran = [];
      const beforeTool = async (call) => {
        ran.push(call.input.command);
        return { content: `ran ${call.input.command}`, isError: false };
      };
      const ctx = { cwd: place() };
      let late;
      const over = fakeCursor([
        async function* ({ tools, onDelta }) {
          await tools.bash.execute({ command: 'one' }, {});
          used(onDelta, 2_000_000, 100_000);
          late = await tools.bash.execute({ command: 'two' }, {});
          yield said('more');
        },
      ]);
      const outcome = await converseCursor(db, params(), { ctx, ledger: { kind: 'worker', jobId: null }, beforeTool, budget: { usd: 1, spent: 0 }, now: () => NOW, sdk: over.sdk });
      assert.equal(outcome.stop, 'budget');
      assert.equal(over.seen.cancelled, 1);
      assert.deepEqual(ran, ['one'], 'the call after the budget ran out did not run');
      assert.deepEqual(late, { content: [{ type: 'text', text: 'not run: the job reached its budget' }], isError: true });
      assert.deepEqual(over.seen.created[0].model.params.at(-1), { id: 'reasoning_effort', value: 'xhigh' });

      const stop = new AbortController();
      const stopped = fakeCursor([
        async function* ({ tools }) {
          stop.abort();
          late = await tools.bash.execute({ command: 'three' }, {});
          yield said('after the stop');
        },
      ]);
      const out = await converseCursor(db, params(), { ctx, ledger: { kind: 'worker' }, beforeTool, signal: stop.signal, now: () => NOW, sdk: stopped.sdk });
      assert.equal(out.stop, 'interrupted');
      assert.equal(stopped.seen.cancelled, 1);
      assert.equal(late.isError, true);
      assert.deepEqual(ran, ['one']);
    } finally {
      db.close();
    }
  });
});

test('Sumo\'s tools answer Cursor one at a time, however many it sends at once', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      let at = 0;
      let most = 0;
      const beforeTool = async (call) => {
        most = Math.max(most, ++at);
        await new Promise((r) => setTimeout(r, 5));
        at--;
        return { content: call.input.command, isError: false };
      };
      const { sdk } = fakeCursor([
        async function* ({ tools }) {
          const answers = await Promise.all(['a', 'b', 'c'].map((command) => tools.bash.execute({ command }, {})));
          yield said(answers.map((a) => a.content[0].text).join(''));
        },
      ]);
      const outcome = await converseCursor(db, { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL] }, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, beforeTool, now: () => NOW, sdk });
      assert.equal(most, 1, 'never two at once');
      assert.equal(outcome.text, 'abc');
    } finally {
      db.close();
    }
  });
});

test('without CURSOR_API_KEY, or when Cursor refuses, the job ends with the reason and a ledger row, nothing run', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL] };
      const none = await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, now: () => NOW, sdk: fakeCursor([]).sdk });
      assert.equal(none.stop, 'error');
      assert.match(none.error, /no CURSOR_API_KEY in this shell/);
    } finally {
      db.close();
    }
  });
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const refusing = { emptyFs: () => EMPTY_FS, Agent: { create: async () => { throw Object.assign(new Error('[plan_required] Cloud Agent is not available for free users.'), { name: 'UnknownAgentError' }); } } };
      const out = await converseCursor(db, { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [] }, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, now: () => NOW, sdk: refusing });
      assert.equal(out.stop, 'error');
      assert.match(out.error, /plan_required/);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_runs WHERE ok = 0').get().n, 1);
    } finally {
      db.close();
    }
  });
});

/**
 * A model as Cursor lists it (`Cursor.models.list`): a variant for every combination of `settings`, the default where
 * `isDefault` says, Max mode where `isMax` does — the shape measured on @cursor/sdk 1.4.1.
 */
function listedModel(id, displayName, settings = {}, { isDefault = () => false, isMax = () => false } = {}) {
  const combos = Object.entries(settings).reduce((all, [setting, values]) => all.flatMap((c) => values.map((value) => [...c, { id: setting, value }])), [[]]);
  return {
    id,
    displayName,
    parameters: Object.entries(settings).map(([setting, values]) => ({ id: setting, values: values.map((value) => ({ value })) })),
    variants: combos.map((params) => ({ params, displayName, isDefault: isDefault(params), isMaxMode: isMax(params) })),
  };
}
const valueOf = (params, setting) => params.find((p) => p.id === setting)?.value;
/** What Cursor listed for a key on Nov 18 2026, cut down: its Auto, Composer, GPT, Claude, GLM, and a model only Max mode runs. */
const CURSOR_LISTED = [
  listedModel('default', 'Auto', {}, { isDefault: () => true }),
  listedModel('composer-2.5', 'Composer 2.5', { fast: ['true', 'false'] }, { isDefault: (p) => valueOf(p, 'fast') === 'true' }),
  listedModel('gpt-5.5', 'GPT-5.5', { context: ['272k', '1m'], reasoning: ['none', 'low', 'medium', 'high', 'extra-high'], fast: ['false', 'true'] }, { isDefault: (p) => valueOf(p, 'context') === '272k' && valueOf(p, 'reasoning') === 'medium' && valueOf(p, 'fast') === 'true', isMax: (p) => valueOf(p, 'context') === '1m' }),
  listedModel('claude-opus-5-5', 'Claude Opus 5.5', { context: ['300k', '1m'], effort: ['low', 'medium', 'high', 'xhigh', 'max'], fast: ['false', 'true'] }, { isDefault: (p) => valueOf(p, 'context') === '300k' && valueOf(p, 'effort') === 'high' && valueOf(p, 'fast') === 'false', isMax: (p) => valueOf(p, 'context') === '1m' || valueOf(p, 'fast') === 'true' }),
  listedModel('glm-5.2', 'GLM 5.2', { reasoning: ['high', 'max'] }, { isDefault: (p) => valueOf(p, 'reasoning') === 'high' }),
  listedModel('big-max', 'Big Max', { context: ['1m'] }, { isMax: () => true }),
];
const PLAN_REFUSAL = 'GPT-5.5 is not included in your weekly usage Buy credits or switch to a Grok model to continue.';

test('Discover lists every model Cursor has for the key, tries each, and turns on the ones the key runs: a model its plan leaves out, or only Max mode runs, is listed and off, saying why', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-models-'));
  const answer = join(root, 'cursor-models.json');
  writeFileSync(answer, JSON.stringify({ models: CURSOR_LISTED, refused: { 'gpt-5.5': PLAN_REFUSAL } }));
  const stub = join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs');
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: stub, STUB_CURSOR_MODELS: answer }, async () => {
    const db = openDb();
    try {
      assert.deepEqual([modelStates(db).composer, modelStates(db).grok], [{ on: false, note: 'not discovered yet' }, { on: false, note: 'not discovered yet' }], 'off until found');
      const without = await discoverCursor(db, { now: NOW });
      assert.deepEqual(without, { ok: false, error: 'no CURSOR_API_KEY in this shell — export it, then Discover again' });
      process.env.CURSOR_API_KEY = 'test-cursor-key';
      const found = await discoverCursor(db, { now: NOW });
      assert.deepEqual(found, { ok: true, found: ['cursor/default', 'composer', 'cursor/claude-opus-5-5', 'cursor/glm-5.2'], refused: ['cursor/gpt-5.5'], cannot: ['cursor/big-max'], errors: {}, missing: ['grok'] });
      assert.equal(cursorSummary(found), 'Cursor: runs cursor/default, composer, cursor/claude-opus-5-5, cursor/glm-5.2 — 1 refused for this key, off — 1 Sumo cannot run, off — not found, turned off: grok');
      const states = modelStates(db);
      assert.deepEqual(states.composer, { on: true, note: 'found 2026-11-18' });
      assert.deepEqual(states['cursor/claude-opus-5-5'], { on: true, note: 'found 2026-11-18' });
      assert.deepEqual(states['cursor/gpt-5.5'], { on: false, note: `found 2026-11-18 — Cursor refused it for this key: ${PLAN_REFUSAL}` });
      assert.deepEqual(states['cursor/big-max'], { on: false, note: 'found 2026-11-18 — Sumo cannot run it: no a standard variant' });
      assert.deepEqual(states.grok, { on: false, note: 'not found 2026-11-18' });

      // Each is asked for by its standard variant: never Fast, never Max mode, the model's own default where it has one, and
      // Sumo's effort in the setting the model names for it, at the nearest level it takes.
      assert.deepEqual(cursorModel('cursor/claude-opus-5-5', 'max'), { id: 'claude-opus-5-5', params: [{ id: 'context', value: '300k' }, { id: 'effort', value: 'max' }, { id: 'fast', value: 'false' }] });
      assert.deepEqual(cursorModel('cursor/gpt-5.5', 'xhigh'), { id: 'gpt-5.5', params: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'extra-high' }, { id: 'fast', value: 'false' }] }, "GPT's extra-high is Sumo's xhigh");
      assert.deepEqual(cursorModel('cursor/gpt-5.5', 'max'), cursorModel('cursor/gpt-5.5', 'xhigh'), 'a level it lacks is the nearest below');
      assert.deepEqual(cursorModel('cursor/glm-5.2', 'low'), { id: 'glm-5.2', params: [{ id: 'reasoning', value: 'high' }] }, 'below its lowest, its lowest');
      assert.deepEqual(cursorModel('cursor/default', 'high'), { id: 'default', params: [] }, 'one that takes no effort is asked as it is');
      assert.deepEqual(cursorModel('composer', 'high'), { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] }, 'Composer keeps its own settings');
      assert.deepEqual(effortsOf('cursor/gpt-5.5'), ['low', 'medium', 'high', 'xhigh']);

      // Every model that is on is offered by name; only the ones with a price are routed to — Cursor's other models get theirs from the scorecard.
      assert.deepEqual(usableJobModels(db), ['haiku', 'composer', 'sonnet', 'opus', 'fable'], 'the ladder: a model with no price is not weighed');
      assert.deepEqual(onModels(db), ['haiku', 'composer', 'sonnet', 'opus', 'fable', 'cursor/claude-opus-5-5', 'cursor/default', 'cursor/glm-5.2'], 'cheapest first, the unpriced after');
      saveListedPrices(db, { 'cursor/glm-5.2': { input: 0.6, output: 2.2, cacheRead: 0.2 }, 'cursor/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 } });
      assert.deepEqual(usableJobModels(db), ['haiku', 'cursor/glm-5.2', 'composer', 'sonnet', 'opus', 'cursor/claude-opus-5-5', 'fable'], 'priced, they join the ladder by their price; on a tie Claude\'s own comes before the same through Cursor');
      assert.deepEqual(allModels(db).slice(0, 3), ['haiku', 'cursor/glm-5.2', 'composer']);

      // A model turned off by hand stays off whatever Cursor answers, now and after it leaves the list and comes back.
      setModel(db, 'cursor/glm-5.2', false, NOW);
      writeFileSync(answer, JSON.stringify({ models: CURSOR_LISTED, refused: { 'glm-5.2': 'GLM 5.2 is not included in your weekly usage' } }));
      await discoverCursor(db, { now: NOW });
      assert.deepEqual(modelStates(db)['cursor/glm-5.2'], { on: false, note: 'turned off 2026-11-18' }, 'a refusal does not write over it');

      // Cursor listing a model no more takes it out of the list; Composer not listed is turned off.
      writeFileSync(answer, JSON.stringify({ models: [CURSOR_LISTED[3]] }));
      const later = await discoverCursor(db, { now: NOW });
      assert.deepEqual(later.found, ['cursor/claude-opus-5-5']);
      assert.deepEqual(later.missing, ['composer', 'grok']);
      assert.equal(allModels(db).includes('cursor/glm-5.2'), false);
      assert.match(offLine(db, 'cursor/glm-5.2'), /^cursor\/glm-5\.2 is not among the models Sumo knows now — API models › Discover/, 'one no longer listed is refused, saying why');
      writeFileSync(answer, JSON.stringify({ models: CURSOR_LISTED, refused: { 'gpt-5.5': PLAN_REFUSAL } }));
      await discoverCursor(db, { now: NOW });
      assert.deepEqual(modelStates(db)['cursor/glm-5.2'], { on: false, note: 'turned off 2026-11-18' }, 'listed again, it is as the user left it');
    } finally {
      delete process.env.CURSOR_API_KEY;
      db.close();
    }
  });
});

test('Discover tries a model on Cursor with a one-word question, none of Cursor\'s tools and an empty tree; a refusal is the reason, an answer a ledger row', async () => {
  await withHome(freshHome(), { ...KEY, SUMO_AGENTS_MODEL_CMD: '' }, async () => {
    const db = openDb();
    try {
      const made = [];
      let closed = 0;
      const fake = (ended) => ({
        emptyFs: () => EMPTY_FS,
        Agent: {
          create: async (options) => {
            made.push(options);
            return {
              close: () => closed++,
              send: async (message) => ({ message, stream: async function* () {}, wait: async () => ended }),
            };
          },
        },
      });
      // The real path: the list from Cursor, each model tried through the SDK.
      const tried = [];
      const result = await discoverCursor(db, {
        now: NOW,
        list: async () => CURSOR_LISTED.slice(1, 3),
        tryModel: async (_db, name) => {
          tried.push(name);
          return tryCursorModel(db, name, { sdk: fake(name === 'composer' ? { status: 'finished', result: 'ok', usage: { inputTokens: 3479, outputTokens: 33, cacheReadTokens: 384, cacheWriteTokens: 0 } } : { status: 'error', error: { message: PLAN_REFUSAL } }), now: () => NOW });
        },
      });
      assert.deepEqual(tried, ['composer', 'cursor/gpt-5.5']);
      assert.deepEqual([result.found, result.refused], [['composer'], ['cursor/gpt-5.5']]);
      assert.equal(made.length, 2);
      for (const options of made) {
        assert.deepEqual(options.tools, [], "none of Cursor's tools");
        assert.equal(options.local.fs, EMPTY_FS, 'an empty tree, never the disk');
        assert.equal(options.apiKey, 'test-cursor-key');
      }
      assert.deepEqual(made[1].model, { id: 'gpt-5.5', params: [{ id: 'context', value: '272k' }, { id: 'reasoning', value: 'none' }, { id: 'fast', value: 'false' }] }, 'asked at its standard variant');
      assert.equal(closed, 2, 'every agent made is closed');
      const rows = db.prepare("SELECT model, ok, input_tokens, cost_usd FROM model_runs WHERE kind = 'discover' ORDER BY id").all();
      assert.deepEqual(rows.map((r) => [r.model, r.ok]), [['composer-2.5', 1], ['cursor/gpt-5.5', 0]], 'each under the name its jobs are kept by');
      assert.ok(rows[0].cost_usd > 0, 'what the answer cost is priced');

      const thrown = await tryCursorModel(db, 'composer', { sdk: { emptyFs: () => EMPTY_FS, Agent: { create: async () => { throw Object.assign(new Error('bad key'), { name: 'AuthenticationError' }); } } } });
      assert.deepEqual(thrown, { ok: false, error: 'Cursor refused CURSOR_API_KEY: bad key' }, 'a key Cursor refuses is not a model refused');
    } finally {
      db.close();
    }
  });
});

test('sumo job run asks for CURSOR_API_KEY, not an Anthropic credential, for a job routed to Cursor; sumo models says Cursor\'s run through Cursor', () => {
  const s = sandbox();
  s.addProject('demo');
  s.sql((db) => db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort, route_reason) VALUES ('demo', 'x', 'worker', 'running', ?, ?, 'composer', 'medium', 'test')`).run(NOW, NOW));
  const run = s.sumo(['job', 'run', '1']);
  assert.notEqual(run.code, 0);
  assert.match(run.err, /j1 not started — it is routed to a Cursor model and this shell has no CURSOR_API_KEY: export it first/);
  const listed = s.sumo(['models']).out;
  assert.match(listed, /^composer off {2}composer-2\.5 {15}not discovered yet · through Cursor$/m, listed);
  assert.match(listed, /^grok {5}off {2}grok-4\.7 {19}not discovered yet · through Cursor$/m, listed);
});

test('a chat turn on Composer runs through Cursor with the chat\'s tools; the reply joins the conversation, a turn on Claude reads it, and Cursor is told in words what Claude said', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      const ran = [];
      const { seen, sdk } = fakeCursor([
        async function* ({ tools, onDelta }) {
          ran.push((await tools.bash.execute({ command: 'printf ok' }, {})).content[0].text);
          used(onDelta, 3000);
          yield said('all ');
          yield said('done');
        },
        async function* ({ onDelta }) {
          used(onDelta, 4000);
          yield said('back on Composer');
        },
      ]);
      const claude = [];
      // What Claude is sent is the request alone: the API refuses a field it does not take (a live 400 once: "cursor: Extra inputs are not permitted").
      const REQUEST = new Set(['model', 'max_tokens', 'system', 'messages', 'tools', 'thinking', 'output_config', 'context_management', 'betas', 'tool_choice', 'metadata', 'stream', 'fallbacks']);
      const send = async (params) => {
        assert.deepEqual(Object.keys(params).filter((k) => !REQUEST.has(k)), [], 'no field of its own rides on the request');
        claude.push(structuredClone(params.messages));
        return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'claude says hi' }], usage: { input_tokens: 100, output_tokens: 5 }, model: 'claude-sonnet-5-5' };
      };
      const words = [];
      const session = createChat(db, { model: 'composer', effort: 'medium', cwd: place(), send, cursorSdk: sdk, out: (t) => words.push(t), now: () => NOW });
      session.start('startup');

      const first = await session.say('say hi');
      assert.equal(first.text, 'all done');
      assert.deepEqual(ran, ['ok'], "the chat's shell ran the call");
      assert.deepEqual(session.counts, { turns: 1, calls: 1 }, '/context counts a turn and a call on Cursor as on Claude');
      assert.match(words.join(''), /all done/, 'the words were drawn as they came');
      assert.deepEqual(seen.created[0].tools, ['webSearch', 'webFetch', 'mcp']);
      assert.match(seen.sent[0], /Today is 2026-11-18\.[\s\S]*say hi/);
      assert.deepEqual(session.params.messages.at(-1), { role: 'assistant', content: [{ type: 'text', text: 'all done' }] }, 'the reply joins the conversation, in words');
      assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM model_runs WHERE kind = 'chat' AND model = 'composer-2.5'`).get().n, 1, 'a ledger row for the request');

      session.route('sonnet medium');
      await session.say('and now?');
      assert.ok(claude[0].some((m) => m.role === 'assistant' && JSON.stringify(m.content).includes('all done')), "Claude reads Composer's reply");
      const call = claude[0].find((m) => m.role === 'assistant' && m.content[0]?.type === 'tool_use')?.content[0];
      assert.deepEqual([call?.name, call?.input], ['bash', { command: 'printf ok' }], 'and the call Composer made, as a call');
      assert.match(call.id, /^cursor_[0-9a-f]{32}$/, 'by an id the API takes');
      assert.ok(claude[0].some((m) => m.role === 'user' && m.content[0]?.type === 'tool_result' && m.content[0].tool_use_id === call.id && m.content[0].content === 'ok'), 'with what came back');

      session.route('composer');
      const back = await session.say('back');
      assert.equal(back.text, 'back on Composer');
      assert.equal(seen.resumed.length, 1, 'the same Cursor agent, resumed');
      assert.deepEqual(seen.resumed[0].tools, ['webSearch', 'webFetch', 'mcp']);
      assert.match(seen.sent[1], /^What was said since you last answered, in words \(the tool calls in it are not carried over\):\n\nThe user: and now\?[\s\S]*\n\nYou: claude says hi\n\nback/);
    } finally {
      db.close();
    }
  });
});

test('a Cursor model left on by an earlier Discover is not offered or routed to in a shell without CURSOR_API_KEY, and asking for it says why', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      assert.deepEqual(usableJobModels(db, {}), ['haiku', 'sonnet', 'opus', 'fable'], 'not in the pool auto routes over');
      assert.deepEqual(usableJobModels(db, KEY), ['haiku', 'composer', 'sonnet', 'opus', 'fable'], 'with the key, it is');
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: place(), send: async () => assert.fail('nothing is sent'), now: () => NOW });
      session.start('startup');
      assert.throws(() => session.route('composer'), /composer runs through Cursor, and this shell has no CURSOR_API_KEY — export it in the shell sumo starts from/);
      assert.throws(() => createChat(db, { model: 'composer', effort: 'medium', cwd: place() }), /composer runs through Cursor, and this shell has no CURSOR_API_KEY/);
    } finally {
      db.close();
    }
  });
});

test('a hand-off from a chat on Cursor is written by Sonnet, from the conversation with Cursor\'s calls in it', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      const { sdk } = fakeCursor([
        async function* ({ tools, onDelta }) {
          await tools.bash.execute({ command: 'printf ok' }, {});
          used(onDelta, 3000);
          yield said('made it');
        },
      ]);
      const sent = [];
      const send = async (params) => {
        sent.push(params);
        return { stop_reason: 'end_turn', content: [{ type: 'compaction', content: 'the hand-off' }], usage: { input_tokens: 100, output_tokens: 5 }, model: params.model };
      };
      const session = createChat(db, { model: 'composer', effort: 'medium', cwd: place(), send, cursorSdk: sdk, now: () => NOW });
      session.start('startup');
      await session.say('make it');
      const handed = await session.handoff();
      assert.equal(handed.text, 'the hand-off');
      assert.equal(sent[0].model, 'claude-sonnet-5-5', 'the API has no Cursor model: Sonnet writes it');
      assert.ok(sent[0].messages.some((m) => m.role === 'assistant' && m.content[0]?.type === 'tool_use'), "with Cursor's calls in what it reads");
    } finally {
      db.close();
    }
  });
});

test('what a command prints on Cursor is streamed as it comes, as on Claude, and a picture goes back to Cursor as a picture', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-out-'));
      const chunks = [];
      let back = null;
      const { sdk } = fakeCursor([
        async function* ({ tools }) {
          await tools.bash.execute({ command: 'printf streamed' }, {});
          back = await tools.look.execute({}, {});
          yield said('done');
        },
      ]);
      const look = { name: 'look', description: 'a picture', input_schema: { type: 'object', properties: {} } };
      const beforeTool = async (call) => (call.name === 'look' ? { content: [{ type: 'text', text: 'here' }, { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }], isError: false } : null);
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL, look] };
      await converseCursor(db, params, { ctx: { cwd: root, roots: [root], env: { PATH: process.env.PATH } }, ledger: { kind: 'worker' }, beforeTool, onOutput: (call, chunk) => chunks.push([call.name, String(chunk)]), now: () => NOW, sdk });
      assert.deepEqual(chunks.map(([name]) => name), chunks.map(() => 'bash'));
      assert.match(chunks.map(([, c]) => c).join(''), /streamed/);
      assert.deepEqual(back.content, [{ type: 'text', text: 'here' }, { type: 'image', data: 'AAAA', mimeType: 'image/png' }]);
    } finally {
      db.close();
    }
  });
});

test('a Cursor job is held to the job\'s own clock, from when the job began: a send after its time is cut at once, and a deadline that fires is said as the time limit', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const params = () => ({ model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL] });
      const began = Date.parse(NOW) - 90_000;
      const late = fakeCursor([
        async function* ({ onDelta }) {
          used(onDelta, 1000);
          yield said('more');
        },
      ]);
      // A job told to close sends again a minute and a half in, on a one-minute clock: its first request ends it.
      const outcome = await converseCursor(db, params(), { ctx: { cwd: place() }, ledger: { kind: 'worker' }, clock: { ms: 60_000, from: began }, now: () => NOW, sdk: late.sdk });
      assert.equal(outcome.stop, 'time');
      assert.equal(late.seen.cancelled, 1);

      const deadline = new AbortController();
      const cut = fakeCursor([
        async function* () {
          deadline.abort();
          yield said('cut');
        },
      ]);
      const out = await converseCursor(db, params(), { ctx: { cwd: place() }, ledger: { kind: 'worker' }, signal: deadline.signal, clock: { ms: 60_000, from: began }, now: () => NOW, sdk: cut.sdk });
      assert.equal(out.stop, 'time', 'the deadline runJob arms aborts the signal; past the clock, that is the time limit');
    } finally {
      db.close();
    }
  });
});

/** What `emptyFs()` hands back in these tests: the tree Cursor's own file tools are given, recognised by identity. */
const EMPTY_FS = { tree: 'empty' };

/**
 * Cursor as the SDK keeps it: an agent is stored under the folder it was made in, and a resume from another folder finds none
 * (`sdk-state-root.ts`: the store is named by a hash of `local.cwd`). Every create, resume and send is recorded in `seen`.
 */
function cursorStore(script) {
  const seen = { created: [], resumed: [], sent: [], cancelled: 0 };
  const stores = new Map();
  let made = 0;
  const agentOf = (agentId, options) => ({
    agentId,
    close() {},
    async send(message, sendOptions = {}) {
      seen.sent.push({ agentId, message, options: sendOptions });
      const step = script.shift();
      assert.ok(step, `nothing scripted for: ${JSON.stringify(message).slice(0, 120)}`);
      let cancelled = false;
      let words = '';
      async function* stream() {
        for await (const m of step({ tools: options.local.customTools, onDelta: sendOptions.onDelta ?? (() => {}), cancelled: () => cancelled })) {
          if (m.type === 'assistant') words += m.message.content.map((b) => b.text).join('');
          yield m;
        }
      }
      return {
        cancel: async () => {
          cancelled = true;
          seen.cancelled++;
        },
        stream,
        wait: async () => (cancelled ? { status: 'cancelled' } : { status: 'finished', result: words }),
      };
    },
  });
  // The SDK's own check on the folder the model is told (filesystem/local-fs.ts): absolute, and never /tmp, its scratch space.
  const workspaceOk = ({ local }) => {
    const told = local.reportedWorkspacePath;
    if (told !== undefined && (!told.startsWith('/') || told === '/tmp' || told.startsWith('/tmp/'))) throw Object.assign(new Error(`local.reportedWorkspacePath "${told}" is not a workspace inside local.fs`), { name: 'ConfigurationError' });
  };
  const Agent = {
    async create(options) {
      workspaceOk(options);
      const agentId = `agent-${++made}`;
      if (!stores.has(options.local.cwd)) stores.set(options.local.cwd, new Set());
      stores.get(options.local.cwd).add(agentId);
      seen.created.push({ agentId, ...options });
      return agentOf(agentId, options);
    },
    async resume(agentId, options) {
      workspaceOk(options);
      seen.resumed.push({ agentId, ...options });
      if (!stores.get(options.local.cwd)?.has(agentId)) throw Object.assign(new Error(`Agent ${agentId} not found`), { name: 'AgentNotFoundError' });
      return agentOf(agentId, options);
    },
  };
  return { seen, sdk: { Agent, emptyFs: () => EMPTY_FS } };
}
const noClaude = async () => assert.fail('nothing goes to Claude here');
const textOfResult = (r) => r.content.map((b) => b.text ?? '').join('');

test('a chat on Cursor that moves into a project keeps its Cursor agent, resumed in the folder it was made in, and the model is told the folder its tools work in now', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-moved-'));
      writeFileSync(join(root, 'a.txt'), 'one\n');
      addProject(db, root, { slug: 'demo', now: NOW });
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('hi');
        },
        async function* () {
          yield said('in demo');
        },
      ]);
      const session = createChat(db, { model: 'composer', effort: 'medium', cwd: place(), send: noClaude, cursorSdk: sdk, now: () => NOW });
      session.start('startup');
      assert.equal((await session.say('hi')).stop, 'end_turn');
      markInjected(db, session.sessionId, 'demo', '2026-11-18T12:05:00.000Z');
      const moved = await session.say('now the project');
      assert.equal(moved.stop, 'end_turn', moved.error ?? '');
      assert.equal(seen.resumed[0].agentId, seen.created[0].agentId, 'the same agent');
      assert.equal(seen.resumed[0].local.cwd, seen.created[0].local.cwd, 'resumed where Cursor keeps it');
      const told = seen.resumed[0].local.reportedWorkspacePath;
      assert.equal(realpathSync(told), realpathSync(root), "the model's workspace is the project's folder");
      assert.ok(seen.sent[1].message.includes(told), 'and it is told so in words');
    } finally {
      db.close();
    }
  });
});

test("Cursor's own file and shell tools are never given the disk: every create and every resume hands them an empty tree", async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      setModel(db, 'composer', true, NOW);
      const { seen, sdk } = cursorStore([
        async function* ({ onDelta }) {
          used(onDelta, 1000);
          yield said('done');
        },
        async function* () {
          yield said('still open');
        },
      ]);
      await runJob(db, id, { cursorSdk: sdk, now: () => NOW });
      assert.equal(seen.created.length + seen.resumed.length, 2, 'made, then resumed to be told to close');
      for (const opened of [...seen.created, ...seen.resumed]) assert.equal(opened.local.fs, EMPTY_FS);
    } finally {
      db.close();
    }
  });
});

test('nothing a Cursor run started outlives it: a call still at work when the budget stops the run is cut off, and answered in the conversation, before the run returns', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const order = [];
      const beforeTool = (_call, { signal } = {}) =>
        new Promise((resolve) => {
          order.push('started');
          const done = () => {
            order.push('cut off');
            resolve({ content: 'cut off', isError: true });
          };
          if (signal?.aborted) done();
          else signal?.addEventListener('abort', done, { once: true });
        });
      const { sdk } = cursorStore([
        async function* ({ tools, onDelta }) {
          tools.bash.execute({ command: 'npm test' }, {});
          await new Promise((r) => setTimeout(r, 5));
          used(onDelta, 3_000_000, 0);
          yield said('more');
        },
      ]);
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL] };
      const outcome = await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, beforeTool, budget: { usd: 1, spent: 0 }, now: () => NOW, sdk });
      order.push('returned');
      assert.equal(outcome.stop, 'budget');
      assert.deepEqual(order, ['started', 'cut off', 'returned']);
      const answered = params.messages.findIndex((m) => m.role === 'user' && m.content[0]?.type === 'tool_result');
      assert.ok(answered > 0 && params.messages[answered].content[0].content === 'cut off', 'its answer is in the conversation');
    } finally {
      db.close();
    }
  });
});

test('what the user says to a Cursor job while it works reaches it with its next result, from the chat and from sumo job tell', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { id } = seed(db);
      setModel(db, 'composer', true, NOW);
      tell(db, id, 'also the README', NOW);
      const inbox = ['use tabs, not spaces'];
      const answers = [];
      const { sdk } = cursorStore([
        async function* ({ tools, onDelta }) {
          answers.push(textOfResult(await tools.bash.execute({ command: 'true' }, {})));
          used(onDelta, 1000);
          yield said('done');
        },
        async function* () {
          yield said('still open');
        },
      ]);
      await runJob(db, id, { cursorSdk: sdk, now: () => NOW, inbox: () => inbox.splice(0) });
      assert.match(answers[0], /The user says, while you work: use tabs, not spaces/);
      assert.match(answers[0], /The user says, while you work: also the README/);
    } finally {
      db.close();
    }
  });
});

test('a Cursor job is warned near its budget as on Claude, told when it repeats a call, and stopped going round the same call', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const answers = [];
      const beforeTool = async () => ({ content: 'the same answer', isError: false });
      const { sdk } = cursorStore([
        async function* ({ tools, onDelta }) {
          answers.push(textOfResult(await tools.bash.execute({ command: 'make' }, {})));
          used(onDelta, 1_700_000, 0);
          for (let i = 0; i < 4; i++) answers.push(textOfResult(await tools.bash.execute({ command: 'make' }, {})));
          yield said('going round');
        },
      ]);
      const budget = { usd: 1, spent: 0, warned: false };
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL] };
      const outcome = await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, beforeTool, budget, now: () => NOW, sdk });
      assert.match(answers[1], /This job has spent \$0\.85 of its \$1\.00 budget/, 'warned once past 80%');
      assert.equal(budget.warned, true);
      assert.match(answers[2], /same call with the same answer, 3 times in a row/);
      assert.equal(outcome.stop, 'loop', 'stopped at the fifth');
    } finally {
      db.close();
    }
  });
});

test('the effort chosen for Grok is the one Grok is asked with, whatever effort Claude was told earlier in the chat', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'grok', true, NOW);
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('high');
        },
        async function* () {
          yield said('medium');
        },
      ]);
      const send = async () => ({ stop_reason: 'end_turn', content: [{ type: 'text', text: 'claude' }], usage: { input_tokens: 10, output_tokens: 2 }, model: 'claude-sonnet-5-5' });
      const session = createChat(db, { model: 'sonnet', effort: 'high', cwd: place(), send, cursorSdk: sdk, now: () => NOW });
      session.start('startup');
      await session.say('a');
      session.route('sonnet medium');
      await session.say('b');
      session.route('grok high');
      await session.say('c');
      assert.equal(session.route('grok medium'), 'grok/medium');
      await session.say('d');
      const asked = [...seen.created, ...seen.resumed].map((o) => o.model.params.find((p) => p.id === 'reasoning_effort')?.value);
      assert.deepEqual(asked, ['high', 'medium']);
    } finally {
      db.close();
    }
  });
});

test('delegated jobs asked for at once on Cursor run side by side, as on Claude, while the other calls still take their turn', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      let at = 0;
      let most = 0;
      const beforeTool = async (call) => {
        if (call.name !== 'delegate') return { content: 'ran', isError: false };
        most = Math.max(most, ++at);
        await new Promise((r) => setTimeout(r, 20));
        at--;
        return { content: `job ${call.input.n} done`, isError: false };
      };
      const delegate = { name: 'delegate', description: 'a job', input_schema: { type: 'object', properties: { n: { type: 'integer' } } } };
      const { sdk } = cursorStore([
        async function* ({ tools }) {
          await Promise.all([tools.delegate.execute({ n: 1 }, {}), tools.delegate.execute({ n: 2 }, {})]);
          yield said('both done');
        },
      ]);
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [BASH_TOOL, delegate] };
      await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'chat' }, beforeTool, concurrent: (call) => call.name === 'delegate', now: () => NOW, sdk });
      assert.equal(most, 2);
    } finally {
      db.close();
    }
  });
});

test('a picture the user pastes on a Cursor turn goes to Cursor with the words, as the SDK takes one', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('a cat');
        },
      ]);
      const session = createChat(db, { model: 'composer', effort: 'medium', cwd: place(), send: noClaude, cursorSdk: sdk, now: () => NOW });
      session.start('startup');
      await session.say('[Image #1] what is this?', undefined, [{ label: '[Image #1]', mediaType: 'image/png', data: 'iVBORw0KGgo=' }]);
      const { message } = seen.sent[0];
      assert.match(message.text, /what is this\?/);
      assert.deepEqual(message.images, [{ data: 'iVBORw0KGgo=', mimeType: 'image/png' }]);
    } finally {
      db.close();
    }
  });
});

test('a refused Cursor key is said as one whether Cursor throws it or a run ends on it, and a chat without the key is told where to export it', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [] };
      const none = await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'chat' }, now: () => NOW, sdk: cursorStore([]).sdk });
      assert.match(none.error, /no CURSOR_API_KEY in this shell — export it in the shell sumo starts from/);
    } finally {
      db.close();
    }
  });
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const refused = { emptyFs: () => EMPTY_FS, Agent: { create: async () => ({ agentId: 'a', close() {}, send: async () => ({ cancel: async () => {}, async *stream() {}, wait: async () => ({ status: 'error', error: { message: 'invalid API key', code: 'unauthenticated' } }) }) }) } };
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [] };
      const out = await converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'worker' }, now: () => NOW, sdk: refused });
      assert.match(out.error, /^Cursor refused CURSOR_API_KEY: invalid API key/);
    } finally {
      db.close();
    }
  });
});

/**
 * A request held to what the Messages API takes: only its own fields; roles it knows; a system message with words only after the
 * user's turn and before the model's (an effort-only one anywhere); every tool_use answered by a tool_result in the next turn, and
 * every tool_result answering one; each call naming a tool of the request; the thinking given earlier passed back unchanged.
 * Consecutive turns of one role are one turn, as the API reads them. The effort in force is the last effort-only message's, else
 * the request's own: it comes back for the caller to check.
 */
function assertApiTakes(params, thoughts) {
  const REQUEST = new Set(['model', 'max_tokens', 'system', 'messages', 'tools', 'thinking', 'output_config', 'context_management', 'betas', 'tool_choice', 'metadata', 'stream', 'fallbacks']);
  assert.deepEqual(Object.keys(params).filter((k) => !REQUEST.has(k)), [], 'only fields the API takes');
  const { messages } = params;
  assert.equal(messages[0].role, 'user', 'the first turn is the user');
  const effortOnly = (m) => m.role === 'system' && Array.isArray(m.content) && m.content.length === 0 && m.output_config;
  for (const [i, m] of messages.entries()) {
    assert.ok(['user', 'assistant', 'system'].includes(m.role), `a role the API knows: ${m.role}`);
    assert.deepEqual(Object.keys(m).filter((k) => !['role', 'content', ...(m.role === 'system' ? ['output_config'] : [])].includes(k)), [], `message ${i} has only its own fields`);
    if (m.role !== 'system' || effortOnly(m)) continue;
    const before = messages.slice(0, i).findLast((x) => x.role !== 'system');
    const after = messages.slice(i + 1).find((x) => x.role !== 'system');
    assert.equal(before?.role, 'user', `operator text at ${i} follows the user's turn`);
    assert.ok(!after || after.role === 'assistant', `operator text at ${i} is answered next, never stranded`);
  }
  const turns = [];
  for (const m of messages.filter((x) => x.role !== 'system')) {
    const blocks = typeof m.content === 'string' ? [{ type: 'text', text: m.content }] : m.content;
    if (turns.at(-1)?.role === m.role) turns.at(-1).blocks.push(...blocks);
    else turns.push({ role: m.role, blocks: [...blocks] });
  }
  const tools = new Set(params.tools.map((t) => t.name));
  for (const [i, t] of turns.entries()) {
    const calls = t.role === 'assistant' ? t.blocks.filter((b) => b.type === 'tool_use') : [];
    for (const call of calls) {
      assert.ok(tools.has(call.name), `${call.name} is a tool of the request`);
      assert.ok(turns[i + 1]?.role === 'user' && turns[i + 1].blocks.some((b) => b.type === 'tool_result' && b.tool_use_id === call.id), `${call.id} is answered in the next turn`);
    }
    for (const result of t.role === 'user' ? t.blocks.filter((b) => b.type === 'tool_result') : []) {
      assert.ok(turns[i - 1]?.role === 'assistant' && turns[i - 1].blocks.some((b) => b.type === 'tool_use' && b.id === result.tool_use_id), `${result.tool_use_id} answers a call in the turn before`);
    }
  }
  const given = turns.filter((t) => t.role === 'assistant').flatMap((t) => t.blocks.filter((b) => b.type === 'thinking'));
  for (const thought of thoughts) assert.ok(given.some((b) => JSON.stringify(b) === JSON.stringify(thought)), 'thinking given earlier goes back unchanged');
  return messages.findLast(effortOnly)?.output_config.effort ?? params.output_config?.effort ?? null;
}

test('on auto, turns routed one by one to Claude and to Cursor and back each run on the route the screen names, every request to Claude is one the API takes, and Cursor is told exactly what happened since its last turn', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      setModel(db, 'composer', true, NOW);
      setModel(db, 'grok', true, NOW);
      const plan = [
        { model: 'sonnet', effort: 'medium', said: 'look at one' },
        { model: 'composer', effort: 'medium', said: 'now two' },
        { model: 'grok', effort: 'high', said: 'grok, think' },
        { model: 'opus', effort: 'low', said: 'opus, sum up' },
        { model: 'composer', effort: 'medium', said: 'composer again' },
      ];
      const routes = plan.map(({ model, effort }) => ({ model, effort, reason: 'stubbed' }));
      const route = async () => routes.shift();

      // Claude: each reply as scripted, each request checked as the API would check it.
      const thoughts = [];
      const asked = [];
      const replies = [
        { model: 'claude-sonnet-5-5', stop_reason: 'tool_use', content: [{ type: 'thinking', thinking: 'look first', signature: 'sig-1' }, { type: 'tool_use', id: 'toolu_1', name: 'bash', input: { command: 'printf one' } }] },
        { model: 'claude-sonnet-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: 'it said one', signature: 'sig-2' }, { type: 'text', text: 'sonnet saw one' }] },
        { model: 'claude-opus-5-5', stop_reason: 'end_turn', content: [{ type: 'thinking', thinking: '', signature: 'sig-3' }, { type: 'text', text: 'opus sums up' }] },
      ];
      const send = async (params) => {
        const reply = replies.shift();
        assert.ok(reply, 'a request Claude was not expected to get');
        assert.equal(params.model, reply.model, 'sent to the model routed to');
        asked.push({ model: params.model, effort: assertApiTakes(params, thoughts) });
        thoughts.push(...structuredClone(reply.content.filter((b) => b.type === 'thinking')));
        return { ...structuredClone(reply), usage: { input_tokens: 100, output_tokens: 10 } };
      };

      const { seen, sdk } = cursorStore([
        async function* ({ tools, onDelta }) {
          await tools.bash.execute({ command: 'printf two' }, {});
          used(onDelta, 2000);
          yield said('composer saw two');
        },
        async function* ({ onDelta }) {
          used(onDelta, 2000);
          yield said('grok thought');
        },
        async function* ({ onDelta }) {
          used(onDelta, 2000);
          yield said('composer is back');
        },
      ]);

      const screen = [];
      const session = createChat(db, { model: 'auto', cwd: place(), send, route, cursorSdk: sdk, watch: (e) => e.type === 'route' && screen.push({ model: e.model, effort: e.effort }), now: () => NOW });
      session.start('startup');
      for (const step of plan) {
        const outcome = await session.say(step.said);
        assert.equal(outcome.stop, 'end_turn', `${step.model}: ${outcome.error ?? outcome.stop}`);
        assert.equal(session.route(''), `auto → ${step.model}/${step.effort}`, 'the screen names the route');
      }
      assert.deepEqual(screen, plan.map(({ model, effort }) => ({ model, effort })), 'each turn routed as the router said');

      // Claude was sent its turns at the route's effort, each request whole.
      assert.deepEqual(asked, [
        { model: 'claude-sonnet-5-5', effort: 'medium' },
        { model: 'claude-sonnet-5-5', effort: 'medium' },
        { model: 'claude-opus-5-5', effort: 'low' },
      ]);

      // Cursor: one agent, made once and resumed in the same folder, on the model and effort routed to.
      assert.equal(seen.created.length, 1);
      assert.deepEqual(seen.resumed.map((r) => [r.agentId, r.local.cwd]), [[seen.created[0].agentId, seen.created[0].local.cwd], [seen.created[0].agentId, seen.created[0].local.cwd]]);
      assert.deepEqual([seen.created[0].model, ...seen.resumed.map((r) => r.model)], [
        { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
        { id: 'grok-4.7', params: [{ id: 'context', value: '256k' }, { id: 'fast', value: 'false' }, { id: 'reasoning_effort', value: 'high' }] },
        { id: 'composer-2.5', params: [{ id: 'fast', value: 'false' }] },
      ]);
      // Each send holds what happened since Cursor last answered: the whole conversation the first time, then only what is new.
      const [madeWith, toGrok, backWith] = seen.sent.map((s) => s.message);
      assert.match(madeWith, /The conversation so far, in words[\s\S]*The user: [^\n]*look at one[\s\S]*You: sonnet saw one[\s\S]*now two/);
      assert.doesNotMatch(madeWith, /printf one/, 'words, not the calls');
      assert.match(toGrok, /grok, think/);
      assert.doesNotMatch(toGrok, /The user:|You:|look at one|now two|sonnet saw one|composer saw two/, 'nothing it was told before');
      assert.match(backWith, /^What was said since you last answered, in words[\s\S]*The user: [^\n]*opus, sum up[\s\S]*You: opus sums up[\s\S]*composer again/);
      assert.doesNotMatch(backWith, /look at one|now two|grok, think|sonnet saw one|grok thought/, 'nothing it was told before');
    } finally {
      db.close();
    }
  });
});

test('a scout on Cursor is given its web search and fetch, as a scout on Claude is, and is taken to have read the web before it starts', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { id } = seed(db, { agent: 'scout' });
      setModel(db, 'composer', true, NOW);
      const { seen, sdk } = fakeCursor([
        async function* ({ onDelta }) {
          used(onDelta, 1000);
          yield said('looked');
        },
        async function* ({ onDelta }) {
          used(onDelta, 1000);
          yield said('still open');
        },
      ]);
      await runJob(db, id, { cursorSdk: sdk, now: () => NOW });
      assert.deepEqual(seen.created[0].tools, ['webSearch', 'webFetch', 'mcp']);
      assert.deepEqual(outsideReads(db, id), ['web_search'], 'its web search is unseen: taken as read before it starts');
    } finally {
      db.close();
    }
  });
});

test("Cursor's agents are kept in one folder of Sumo's where git finds no repository, even in a home inside one: what the SDK runs there after each run — git, then gh and `origin` off the PATH, with this process's keys — finds no branch and goes no further", async () => {
  const repo = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-repo-')));
  const git = (...args) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { stdio: 'ignore' });
  git('init', '-q');
  git('commit', '-q', '--allow-empty', '-m', 'first');
  const project = realpathSync(mkdtempSync(join(tmpdir(), 'sumo-agents-cursor-project-')));
  execFileSync('git', ['init', '-q', project]);
  await withHome(join(repo, 'home'), KEY, async () => {
    const db = openDb();
    try {
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('one');
        },
        async function* () {
          yield said('two');
        },
      ]);
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [] };
      assert.equal((await converseCursor(db, params, { ctx: { cwd: project }, ledger: { kind: 'chat' }, now: () => NOW, sdk })).stop, 'end_turn');
      params.messages.push({ role: 'user', content: 'again' });
      assert.equal((await converseCursor(db, params, { ctx: { cwd: project }, ledger: { kind: 'chat' }, now: () => NOW, sdk })).stop, 'end_turn');
      const folder = seen.created[0].local.cwd;
      assert.notEqual(folder, project, 'never the project');
      assert.equal(seen.resumed[0].local.cwd, folder, 'the same folder every time, so the agent is found again');
      assert.equal(seen.created[0].local.reportedWorkspacePath, project, 'the model is told the project');
      const branch = spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: folder, encoding: 'utf8' });
      assert.notEqual(branch.status, 0, `git finds no branch there, so no gh or origin is run: ${branch.stdout}`);
      assert.equal(spawnSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: join(repo, 'home'), encoding: 'utf8' }).stdout.trim() !== '', true, 'though the home itself is in a repository');
    } finally {
      db.close();
    }
  });
});

test('a Cursor agent that can no longer be resumed is let go: a new one is told the whole conversation in the same turn, and the turns after go on with it', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('first answer');
        },
        async function* () {
          yield said('second answer');
        },
        async function* () {
          yield said('third answer');
        },
      ]);
      // The first agent is gone from Cursor's store by the second turn: refused, as the SDK refuses one it cannot find.
      const resume = sdk.Agent.resume;
      sdk.Agent.resume = async (agentId, options) => {
        if (agentId !== 'agent-1') return resume(agentId, options);
        seen.resumed.push({ agentId, ...options });
        throw Object.assign(new Error(`Agent ${agentId} not found`), { name: 'AgentNotFoundError' });
      };
      const params = { model: 'composer-2.5', system: [{ type: 'text', text: 'You are Sumo.' }], messages: [{ role: 'user', content: 'remember the word tangerine' }], tools: [] };
      const ask = () => converseCursor(db, params, { ctx: { cwd: place() }, ledger: { kind: 'chat' }, now: () => NOW, sdk });
      assert.equal((await ask()).stop, 'end_turn');
      params.messages.push({ role: 'user', content: 'what was the word?' });
      const second = await ask();
      assert.equal(second.stop, 'end_turn', second.error ?? '');
      assert.equal(second.text, 'second answer');
      params.messages.push({ role: 'user', content: 'and now?' });
      assert.equal((await ask()).stop, 'end_turn');
      assert.deepEqual(seen.created.map((c) => c.agentId), ['agent-1', 'agent-2'], 'one new agent, made once');
      assert.deepEqual(seen.resumed.map((r) => r.agentId), ['agent-1', 'agent-2'], 'the lost one asked for once; the new one after');
      const toNew = seen.sent[1];
      assert.equal(toNew.agentId, 'agent-2');
      assert.match(toNew.message, /^You are Sumo\.\n\nToday is 2026-11-18\.[\s\S]*The user: remember the word tangerine[\s\S]*You: first answer[\s\S]*what was the word\?/, 'told the whole conversation, as at the start');
    } finally {
      db.close();
    }
  });
});

test('a project under /tmp is told to Cursor by the folder it really is, which the SDK takes, not by the /tmp it refuses', async () => {
  await withHome(freshHome(), KEY, async () => {
    const db = openDb();
    try {
      const { seen, sdk } = cursorStore([
        async function* () {
          yield said('ok');
        },
      ]);
      const params = { model: 'composer-2.5', system: [], messages: [{ role: 'user', content: 'go' }], tools: [] };
      const outcome = await converseCursor(db, params, { ctx: { cwd: '/tmp' }, ledger: { kind: 'chat' }, now: () => NOW, sdk });
      assert.equal(outcome.stop, 'end_turn', outcome.error ?? '');
      assert.equal(seen.created[0].local.reportedWorkspacePath, realpathSync.native('/tmp'));
    } finally {
      db.close();
    }
  });
});

test('a hand-off from Cursor is asked as its writer takes it: Sonnet with the server-side fallback, Haiku — when it is the only Claude model on — without', async () => {
  for (const [off, model, fallbacks] of [[[], 'claude-sonnet-5-5', 'default'], [['sonnet', 'opus', 'fable'], 'claude-haiku-5-5', undefined]]) {
    await withHome(freshHome(), KEY, async () => {
      const db = openDb();
      try {
        setModel(db, 'composer', true, NOW);
        for (const name of off) setModel(db, name, false, NOW);
        const { sdk } = fakeCursor([
          async function* ({ onDelta }) {
            used(onDelta, 1000);
            yield said('done');
          },
        ]);
        const sent = [];
        const send = async (params) => {
          sent.push(params);
          return { stop_reason: 'end_turn', content: [{ type: 'compaction', content: 'the hand-off' }], usage: { input_tokens: 10, output_tokens: 5 }, model: params.model };
        };
        const session = createChat(db, { model: 'composer', effort: 'medium', cwd: place(), send, cursorSdk: sdk, now: () => NOW });
        session.start('startup');
        await session.say('go');
        await session.handoff();
        assert.equal(sent[0].model, model);
        assert.equal(sent[0].fallbacks, fallbacks);
        assert.equal(sent[0].betas.some((b) => /fallback/.test(b)), fallbacks !== undefined);
      } finally {
        db.close();
      }
    });
  }
});
