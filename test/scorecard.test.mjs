// The scorecard: benchmarks other people publish, read by a model and written to one file by `/scorecard`, and read by the
// router — each source turned into places among Sumo's models before anything is averaged, and the route picked by code.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { MODEL_IDS, modelId, pricesFrom, setModel } from '../src/catalog.mjs';
import { createChat } from '../src/chat.mjs';
import { openDb, setMeta } from '../src/db.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseChatRoute, chooseRoute, EFFORTS, ledgerCost, pickRoute, routePolicy } from '../src/route.mjs';
import { activeScorecard, readWritten, refreshScorecard, routeScore, savedScorecard, scorecardLines, scorecardReport, scorecardSummary, scorecardWriter } from '../src/scorecard.mjs';
import { settingsPage } from '../src/settings.mjs';
import { runUi } from '../src/ui.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { fakeTty } from './fixtures/fake-tty.mjs';
import { sandbox } from './helpers.mjs';

const STUB = join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs');
const entry = (model, effort, score, cost = null) => ({ model, effort, score, cost });

/** A scorecard as the sources had it on Nov 18 2026, cut down: CursorBench at every effort, LMArena at two, the index per model. */
const SOURCES = {
  cursorbench: {
    entries: [
      entry('haiku', 'low', 0.309, 0.08), entry('haiku', 'medium', 0.369, 0.17), entry('haiku', 'high', 0.423, 0.32),
      entry('sonnet', 'low', 0.358, 0.37), entry('sonnet', 'medium', 0.392, 0.52), entry('sonnet', 'high', 0.478, 1.2),
      entry('opus', 'low', 0.437, 1.17), entry('opus', 'medium', 0.525, 2.91), entry('opus', 'high', 0.56, 3.97),
    ],
  },
  arena: { entries: [entry('opus', 'high', 0.134, 2.12), entry('sonnet', 'high', 0.072, 0.88), entry('haiku', 'high', -0.004, 0.08)] },
  intelligence: { entries: [entry('opus', '*', 59.1), entry('sonnet', '*', 54.5), entry('haiku', '*', 36.5)] },
};

/** The scorecard file as `/scorecard` writes it, of `sources` — `{ id: { entries } }`; one with an `error` is left out. */
const cardFile = (sources, at = '2026-11-18T10:00:00.000Z') => ({
  at,
  by: 'fable/max',
  sources: Object.fromEntries(Object.entries(sources).filter(([, s]) => s.entries).map(([id, s]) => [id, { name: id, url: `https://example.com/${id}`, entries: s.entries }])),
});
/** Writes it where Sumo's home keeps it. */
const writeCard = (sources, at) => writeFileSync(paths().scorecard, JSON.stringify(cardFile(sources, at)));

/** Runs `fn` with a database in a fresh home whose scorecard file holds `sources` (none: no scorecard written). */
async function withCard(sources, fn, extra = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-scorecard-'));
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: STUB, ...extra(root) }, async () => {
    const db = openDb();
    if (sources) writeCard(sources);
    try {
      await fn(db, { root });
    } finally {
      db.close();
    }
  });
}

test('what the writer gives is checked entry by entry: each problem is said in a line it can act on, and a good entry keeps the source\'s own name and the model\'s id', () => {
  const models = ['haiku', 'sonnet', 'opus', 'cursor/glm-5p3'];
  const good = { name: 'CursorBench, via Epoch AI', url: 'https://epoch.ai/benchmarks', entries: [{ model: 'opus', effort: 'high', score: 0.56, cost: 3.97, as: 'claude-opus-5-5_high' }, { model: 'cursor/glm-5p3', effort: '*', score: 0.41, as: 'GLM-5.3' }] };
  const { sources, problems } = readWritten({ sources: [good] }, models);
  assert.deepEqual(problems, []);
  assert.deepEqual(sources, {
    'cursorbench-via-epoch-ai': {
      name: 'CursorBench, via Epoch AI',
      url: 'https://epoch.ai/benchmarks',
      entries: [
        { model: 'opus', id: 'claude-opus-5-5', effort: 'high', score: 0.56, cost: 3.97, as: 'claude-opus-5-5_high' },
        { model: 'cursor/glm-5p3', id: 'cursor/glm-5p3', effort: '*', score: 0.41, cost: null, as: 'GLM-5.3' },
      ],
    },
  }, 'a cost the source does not give is none');

  const bad = readWritten({
    sources: [
      { name: 'Arena', url: 'lmarena', entries: [
        { model: 'Claude Opus 5.5', effort: 'high', score: 1500, as: 'Claude Opus 5.5 (High)' },
        { model: 'sonnet', effort: 'minimal', score: 1400, as: 'Claude Sonnet 5.5 (Minimal)' },
        { model: 'haiku', effort: 'high', score: 'n/a', as: 'Claude Haiku 5.5' },
        { model: 'opus', effort: 'max', score: 1510, cost: -1, as: 'Claude Opus 5.5 (Max)' },
        { model: 'opus', effort: 'low', score: 1490, as: 'a' },
        { model: 'opus', effort: 'low', score: 1491, as: 'b' },
      ] },
      { name: 'arena', url: 'https://lmarena.ai', entries: [] },
      { url: 'https://example.com' },
    ],
  }, models);
  assert.deepEqual(bad.problems, [
    'Arena: the url is the page or file its numbers were read from',
    'Arena, "Claude Opus 5.5 (High)": "Claude Opus 5.5" is not one of Sumo\'s names — write the first column of the table, or leave the row out',
    'Arena, "Claude Sonnet 5.5 (Minimal)": effort "minimal" is none of low, medium, high, xhigh, max, *',
    'Arena, "Claude Haiku 5.5": the score is not a number',
    'Arena, "Claude Opus 5.5 (Max)": a cost is dollars per task, or left out',
    'Arena, "b": opus at low is given twice in Arena',
    'arena is given twice: give each source once, with all its entries',
    'arena has no entries',
    'source 3 has no name',
  ]);
  assert.deepEqual(readWritten({}, models).problems, ['no sources: give every source you read, each with its entries']);
});

test("a written scorecard is read as places among Sumo's models, and a route's score is the mean of its places", async () => {
  await withCard(SOURCES, async () => {
    const card = savedScorecard();
    assert.equal(card.at, '2026-11-18T10:00:00.000Z');
    assert.equal(card.by, 'fable/max');
    assert.deepEqual(card.sources.intelligence.entries.map((e) => [e.model, e.place]), [['opus', 1], ['sonnet', 0.5], ['haiku', 0]], 'the best of a source is 1, the worst 0');
    const opusHigh = routeScore(card, 'opus', 'high', EFFORTS);
    assert.equal(opusHigh.sources, 3);
    assert.equal(opusHigh.score, 1, 'first in all three');
    assert.equal(opusHigh.cost, 3.97, 'the cost is the first source that prices this route');
    // LMArena lists opus only at high: opus at medium borrows that place, so a source that skips an effort never lifts it, and does not price it.
    const opusMedium = routeScore(card, 'opus', 'medium', EFFORTS);
    assert.equal(opusMedium.sources, 3);
    assert.ok(opusMedium.score < opusHigh.score, 'a lower effort scores lower');
    assert.equal(opusMedium.cost, 2.91, 'priced from its own effort, not the one it borrowed');
    assert.equal(routeScore(card, 'fable', 'high', EFFORTS), null, 'a model no source lists is not on the scorecard');
  });
});

/** The API's answer to one request: `content` blocks and why it stopped. */
const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 2000, output_tokens: 300 } });
const writeCall = (id, sources) => ({ type: 'tool_use', id, name: 'write_scorecard', input: { sources } });
/** A stand-in for the API that answers with `replies` in turn and keeps a copy of each request. */
const canned = (replies) => {
  const seen = [];
  const send = async (params) => {
    seen.push(structuredClone(params));
    return { model: params.model, ...replies.shift() };
  };
  return { send, seen };
};
const CURSORBENCH = { name: 'CursorBench, via Epoch AI', url: 'https://epoch.ai/benchmarks', entries: [
  { model: 'haiku', effort: 'low', score: 0.309, cost: 0.08, as: 'claude-haiku-5-5_low' },
  { model: 'opus', effort: 'high', score: 0.56, cost: 3.97, as: 'claude-opus-5-5_high' },
] };

test('/scorecard has the strongest Claude model on, at its highest effort, read the web and write the file with one tool; a call it cannot use is said back, and the next one writes the file whole', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: '' }, async () => {
    const db = openDb();
    try {
      assert.deepEqual(scorecardWriter(db), { model: 'fable', effort: 'max' });
      const searched = { type: 'server_tool_use', id: 's1', name: 'web_search', input: { query: 'CursorBench Epoch AI' } };
      const found = { type: 'web_search_tool_result', tool_use_id: 's1', content: [{ type: 'web_search_result', title: 'CursorBench', url: 'https://epoch.ai/benchmarks', encrypted_content: 'x' }] };
      const { send, seen } = canned([
        reply('tool_use', [searched, found, writeCall('w1', [{ ...CURSORBENCH, entries: [...CURSORBENCH.entries, { model: 'Claude Sonnet 5.5', effort: 'low', score: 0.358, as: 'claude-sonnet-5-5_low' }] }])]),
        reply('tool_use', [writeCall('w2', [CURSORBENCH])]),
        reply('end_turn', [{ type: 'text', text: 'CursorBench gave haiku and opus; nothing scores the rest.' }]),
      ]);
      const told = [];
      const result = await refreshScorecard(db, { send, now: () => '2026-11-19T10:00:00.000Z', onTool: (call) => told.push(['call', call.name]), onResult: (call, r) => told.push([call.name, r.isError]) });
      const first = seen[0];
      assert.equal(first.model, MODEL_IDS.fable);
      assert.equal(first.output_config.effort, 'max');
      assert.deepEqual(first.tools.map((t) => t.name), ['web_search', 'web_fetch', 'write_scorecard'], 'the web and the file: no shell, no editor, no memory');
      const asked = first.messages[0].content[0].text;
      assert.match(asked, /CursorBench[\s\S]*https:\/\/epoch\.ai\/benchmarks\/cursorbench[\s\S]*LMArena[\s\S]*Artificial Analysis/, 'told the three sources, in that order, where the web fetch may open them: in a message');
      assert.match(asked, /never an archive or a data dump/);
      assert.match(asked, /^Today is 2026-11-19\. Sumo's models:$/m);
      assert.match(asked, /^\| opus \| claude-opus-5-5 \| {2}\| low, medium, high, xhigh, max \|$/m, 'each model by its name, its id and its efforts');
      assert.match(asked, /^\| composer \| [^|]+, through Cursor \|/m, "Cursor's models too");
      const refused = seen[1].messages.at(-1).content.find((b) => b.type === 'tool_result');
      assert.equal(refused.is_error, true);
      assert.match(refused.content, /^nothing written — fix these, then call write_scorecard again with every source:\n- CursorBench, via Epoch AI, "claude-sonnet-5-5_low": "Claude Sonnet 5\.5" is not one of Sumo's names/);
      const written = seen[2].messages.at(-1).content.find((b) => b.type === 'tool_result');
      assert.equal(written.is_error, false);
      assert.match(written.content, /^written: 1 source\n- CursorBench, via Epoch AI: 2 entries for 2 models\nno source scores: composer, grok, sonnet, fable$/, "in the catalog's order, cheapest first");

      assert.deepEqual(told, [['call', 'web_search'], ['web_search', false], ['call', 'write_scorecard'], ['write_scorecard', true], ['call', 'write_scorecard'], ['write_scorecard', false]]);
      assert.equal(result.ok, true);
      assert.match(scorecardSummary(result), /^scorecard written by fable\/max from CursorBench, via Epoch AI — \$\d+\.\d\d$/);
      const file = JSON.parse(readFileSync(paths().scorecard, 'utf8'));
      assert.deepEqual(Object.keys(file), ['at', 'by', 'sources']);
      assert.equal(file.at, '2026-11-19T10:00:00.000Z');
      assert.deepEqual(file.sources['cursorbench-via-epoch-ai'].entries[1], { model: 'opus', id: 'claude-opus-5-5', effort: 'high', score: 0.56, cost: 3.97, as: 'claude-opus-5-5_high' }, 'the source\'s own number, kept as the source wrote it');
      assert.deepEqual(savedScorecard().sources['cursorbench-via-epoch-ai'].entries.map((e) => [e.model, e.place]), [['haiku', 0], ['opus', 1]], 'placed when it is read');
      assert.deepEqual(db.prepare(`SELECT DISTINCT kind FROM model_runs`).all().map((r) => r.kind), ['scorecard'], 'what it cost is in the ledger, as the scorecard\'s');
    } finally {
      db.close();
    }
  });
});

test('a writing stopped, or ended without writing, keeps the scorecard saved before and says why; with no Claude model on, nothing is asked', async () => {
  await withCard(SOURCES, async (db) => {
    const before = readFileSync(paths().scorecard, 'utf8');
    const { send } = canned([reply('end_turn', [{ type: 'text', text: 'I could not reach the sources.' }])]);
    const ended = await refreshScorecard(db, { send });
    assert.equal(ended.ok, false);
    assert.match(scorecardSummary(ended), /^scorecard not written — fable\/max finished without writing it — \$\d+\.\d\d$/);
    assert.match(scorecardReport(db, ended, EFFORTS), /I could not reach the sources\.\n\nSaved: written 2026-11-18 by fable\/max from cursorbench; arena; intelligence\./, 'what the writer said, then the scorecard still saved');

    const stop = new AbortController();
    stop.abort();
    const stopped = await refreshScorecard(db, { send: canned([]).send, signal: stop.signal });
    assert.equal(stopped.error, 'stopped: the scorecard saved before is kept');
    assert.equal(readFileSync(paths().scorecard, 'utf8'), before, 'the file is as it was');

    setMeta(db, 'models.state', JSON.stringify({ haiku: { on: false, note: 'off' }, sonnet: { on: false, note: 'off' }, opus: { on: false, note: 'off' }, fable: { on: false, note: 'off' } }));
    assert.equal(scorecardWriter(db), null);
    assert.match((await refreshScorecard(db, { send: canned([]).send })).error, /^no Claude model is switched on to write it/);
  });
  await withCard(null, async () => {
    assert.equal(savedScorecard(), null, 'none written, none read');
    assert.equal(existsSync(paths().scorecard), false);
  });
});

test('code picks the cheapest route that clears the kind\'s bar, at the effort the surface asks for, and says why', async () => {
  await withCard(SOURCES, async (db) => {
    const card = savedScorecard();
    const usable = ['haiku', 'sonnet', 'opus'];
    const pick = (o) => pickRoute({ card, usable, highest: 'high', ...o });
    assert.deepEqual(pick({ kind: 'mechanical', surface: 'one spot' }), { model: 'haiku', effort: 'low', why: 'mechanical, one spot needs 0; haiku/low scores 0.00 at $0.08 a task on the benchmarks, the cheapest of 9 that do' });
    assert.equal(pick({ kind: 'mechanical', surface: 'a few files' }).effort, 'medium', 'the effort follows the surface');
    const routine = pick({ kind: 'routine', surface: 'one spot' });
    assert.equal(`${routine.model}/${routine.effort}`, 'sonnet/low');
    // Hard work in one spot goes to opus at low effort, the cheapest route over the bar; on a few files it needs at least that much,
    // and sonnet at high effort, which clears the bar for less, does not have it.
    const hard = pick({ kind: 'hard', surface: 'a few files' });
    assert.equal(`${hard.model}/${hard.effort}`, 'opus/medium');
    assert.match(hard.why, /^hard, a few files needs 0\.88, what opus\/low scores a step smaller; opus\/medium scores 0\.96 at \$2\.91 a task on the benchmarks, the cheapest of 2 that do$/);
    // risky: one effort up, and routine work is hard.
    const risky = pick({ kind: 'routine', surface: 'one spot', risky: true });
    assert.equal(`${risky.model}/${risky.effort}`, 'opus/medium');
    assert.match(risky.why, /^hard, risky, one spot needs 0\.88, what opus\/low scores a step smaller;/);
    const scout = pick({ kind: 'routine', surface: 'one spot', risky: true, hardens: false });
    assert.equal(`${scout.model}/${scout.effort}`, 'sonnet/medium', 'a scout\'s risky work stays routine, one effort up');
    // Nothing above `highest`, and when nothing clears the bar, the best there is.
    const novel = pick({ kind: 'novel', surface: 'many interacting parts' });
    assert.equal(`${novel.model}/${novel.effort}`, 'opus/high');
    assert.match(novel.why, /^novel, many interacting parts needs 0\.96, what opus\/medium scores a step smaller; opus\/high scores 1\.00/);
    // A route this project's record is against is passed over while another is scored.
    const avoided = pick({ kind: 'routine', surface: 'one spot', avoid: ['sonnet/low'] });
    assert.notEqual(`${avoided.model}/${avoided.effort}`, 'sonnet/low');
    assert.equal(pickRoute({ card, usable: ['fable'], kind: 'routine', surface: 'one spot' }), null, 'no route of the models that are on is scored');
  });
});

test('where the APIs give no cost, the ledger prices a route: its own jobs\' average, else its typical job at the model\'s prices', async () => {
  await withCard(SOURCES, async (db, { root }) => {
    const card = savedScorecard();
    assert.equal(ledgerCost(db, 'worker'), null, 'no finished job: the benchmarks\' cost stands');
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    const job = (model, effort, status = 'done') => Number(db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort) VALUES (?, 'x', 'worker', ?, 'now', 'now', ?, ?)`).run(project.slug, status, model, effort).lastInsertRowid);
    const request = (id, model, cost, { input = 10_000, cached = 8_000, output = 500 } = {}) =>
      db.prepare(`INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, cache_read_tokens, cache_creation_tokens, job_id) VALUES ('now', 'worker', ?, ?, ?, ?, 1, ?, 0, ?)`).run(model, input, output, cost, cached, id);
    const a = job('sonnet', 'low');
    request(a, 'claude-sonnet-5-5', 0.02);
    request(a, 'claude-sonnet-5-5', 0.03);
    request(job('sonnet', 'low', 'failed'), 'claude-sonnet-5-5', 0.01);
    request(job('opus', 'high', 'running'), 'claude-opus-5-5', 9, { input: 1_000_000 });
    const ledger = ledgerCost(db, 'worker');
    const sonnet = ledger.own.get('sonnet/low');
    assert.equal(sonnet.jobs, 2, 'a job still running is not counted');
    assert.ok(Math.abs(sonnet.cost - 0.03) < 1e-12, 'the average of its finished jobs: ($0.05 + $0.01) / 2');
    assert.deepEqual(ledger.typical, { input: 15_000, cached: 12_000, written: 0, output: 750 }, 'the typical finished job');
    const pick = pickRoute({ card, usable: ['haiku', 'sonnet', 'opus'], kind: 'routine', surface: 'one spot', highest: 'high', ledger });
    assert.equal(`${pick.model}/${pick.effort}`, 'sonnet/low');
    assert.match(pick.why, /at \$0\.03 a job, by its 2 in the ledger, the cheapest of/);
    // A route with no jobs of its own: the benchmarks' cost, scaled by how the ledger's routes compare with them (here $0.03 against
    // $0.37), so a dearer effort stays dearer — opus at medium costs more than opus at low, though neither was run.
    const hard = pickRoute({ card, usable: ['haiku', 'sonnet', 'opus'], kind: 'hard', surface: 'a few files', highest: 'high', ledger });
    assert.equal(`${hard.model}/${hard.effort}`, 'opus/medium');
    assert.match(hard.why, /opus\/medium scores 0\.96 at \$0\.24 a job, from the benchmarks scaled to the ledger's \(×0\.081\), the cheapest of 2 that do$/);
  });
});

test('with a scorecard saved the router only sorts the job, is not shown the models or their history, and code picks the route', async () => {
  await withCard(SOURCES, async (db, { root }) => {
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    const routerAnswer = join(root, 'router-answer.json');
    writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { kind: 'hard', surface: 'a few files', risky: false, reason: 'a bug whose cause is unknown' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
    const route = await chooseRoute(db, { agent: 'worker', project, task: 'the retry ignores the time limit', title: 'retry limit' });
    assert.deepEqual({ model: route.model, effort: route.effort }, { model: 'opus', effort: 'medium' });
    assert.match(route.reason, /^router: a bug whose cause is unknown; scorecard: hard, a few files needs 0\.88, what opus\/low scores a step smaller; opus\/medium scores 0\.96 at \$2\.91 a task/);
    const saw = JSON.parse(readFileSync(join(root, 'router-saw.json'), 'utf8'));
    assert.deepEqual(Object.keys(saw.schema.properties), ['kind', 'surface', 'risky', 'reason'], 'no model or effort to name');
    assert.match(saw.system, /^You assign a coding job .* Model follows kind: haiku for mechanical/, 'the same prompt: its rule keeps the sorting to scale');
    assert.doesNotMatch(saw.prompt, /^models:|^history:/m);

    const chat = await chooseChatRoute(db, { project, text: 'why does the retry ignore the limit?' });
    // The chat may run at xhigh and max, which this cut-down CursorBench does not price: those rank after the routes it does price,
    // which are still compared by price — the same route as the job's.
    assert.deepEqual({ model: chat.model, effort: chat.effort }, { model: 'opus', effort: 'medium' });
    assert.match(chat.reason, /^a bug whose cause is unknown; scorecard: hard, a few files needs 0\.88, what opus\/low scores a step smaller; opus\/medium scores 0\.96 at \$2\.91 a task on the benchmarks, the cheapest priced of 4 that do$/);
    assert.deepEqual(Object.keys(JSON.parse(readFileSync(join(root, 'router-saw.json'), 'utf8')).schema.properties), ['kind', 'surface', 'risky', 'reason']);

    // An answer outside the sorting grammar is the router failing, as before.
    writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { kind: 'hard', surface: 'everywhere', risky: false, reason: 'x' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
    await assert.rejects(chooseRoute(db, { agent: 'worker', project, task: 'x', title: 'x' }), /the router answered outside its schema/);
  }, (root) => ({ STUB_ROUTER_ANSWER: join(root, 'router-answer.json'), STUB_CAPTURE: join(root, 'router-saw.json') }));
});

/** The router's answer as the stand-in gives it back. */
const routerSays = (file, answer) => writeFileSync(file, JSON.stringify({ is_error: false, result: '', structured_output: answer, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
const routerEnv = (root) => ({ STUB_ROUTER_ANSWER: join(root, 'router-answer.json'), STUB_CAPTURE: join(root, 'router-saw.json') });
/** A job row on a route, and one request of it in the ledger at `cost` (0: a request that failed before anything was billed). */
const jobOn = (db, project, { model, effort, status = 'done', agent = 'worker', cost = null }) => {
  const id = Number(db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort) VALUES (?, 'x', ?, ?, 'now', 'now', ?, ?)`).run(project, agent, status, model, effort).lastInsertRowid);
  if (cost !== null) db.prepare(`INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, cache_read_tokens, cache_creation_tokens, job_id) VALUES ('now', ?, ?, 10000, 500, ?, ?, 8000, 0, ?)`).run(agent, modelId(model), cost, cost > 0 ? 1 : 0, id);
  return id;
};
const ASKS = [['one spot', false], ['one spot', true], ['a few files', false], ['a few files', true], ['many interacting parts', false], ['many interacting parts', true]];

test('a harder ask of the same kind never gets a lower-scoring route: a bigger surface, or risky work, scores at least what the smaller ask got', async () => {
  await withCard(SOURCES, async (db) => {
    const card = savedScorecard();
    for (const highest of ['high', null]) {
      for (const kind of ['mechanical', 'routine', 'hard', 'novel']) {
        const picks = ASKS.map(([surface, risky]) => {
          const p = pickRoute({ card, usable: ['haiku', 'sonnet', 'opus'], kind, surface, risky, highest });
          return { ask: `${kind}, ${surface}${risky ? ', risky' : ''}`, route: `${p.model}/${p.effort}`, score: routeScore(card, p.model, p.effort, EFFORTS).score };
        });
        // Each surface against the one below it, and risky against the same surface without it.
        for (const [easier, harder] of [[0, 1], [2, 3], [4, 5], [0, 2], [2, 4], [1, 3], [3, 5]]) {
          const [e, h] = [picks[easier], picks[harder]];
          assert.ok(h.score >= e.score, `${h.ask} got ${h.route} (${h.score.toFixed(2)}), below ${e.route} (${e.score.toFixed(2)}) for ${e.ask}`);
        }
      }
    }
    const hard = pickRoute({ card, usable: ['haiku', 'sonnet', 'opus'], kind: 'hard', surface: 'a few files', highest: 'high' });
    assert.match(hard.why, /^hard, a few files needs 0\.88, what opus\/low scores a step smaller; opus\/medium scores 0\.96 at \$2\.91 a task on the benchmarks, the cheapest of 2 that do$/);
  });
});

test("only a job that did billed work prices its route, and a worker's route is priced by workers' jobs", async () => {
  await withCard(SOURCES, async (db, { root }) => {
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    // Failed at its first request, which was logged with nothing billed: it says nothing of what the route costs.
    jobOn(db, project.slug, { model: 'haiku', effort: 'low', status: 'failed', cost: 0 });
    assert.equal(ledgerCost(db, 'worker'), null, 'no job did billed work');
    jobOn(db, project.slug, { model: 'sonnet', effort: 'low', cost: 0.4 });
    jobOn(db, project.slug, { model: 'sonnet', effort: 'low', agent: 'scout', cost: 0.02 });
    const workers = ledgerCost(db, 'worker');
    assert.deepEqual([...workers.own], [['sonnet/low', { cost: 0.4, jobs: 1 }]], "a scout's reading prices a scout's route, not a worker's");
    assert.deepEqual([...ledgerCost(db, 'scout').own], [['sonnet/low', { cost: 0.02, jobs: 1 }]]);
    const pick = pickRoute({ card: savedScorecard(), usable: ['haiku', 'sonnet', 'opus'], kind: 'mechanical', surface: 'one spot', highest: 'high', ledger: workers });
    assert.equal(`${pick.model}/${pick.effort}`, 'haiku/low', 'the job that failed for nothing does not make its route free');
  });
});

test('routes of equal cost, or any of unknown cost, go to the lower rung — the smaller model, then the lower effort — never to the higher score', async () => {
  const usable = ['haiku', 'sonnet', 'opus'];
  // The index alone: a score for each model and no cost for any.
  await withCard({ cursorbench: { error: 'answered 503' }, arena: { error: 'answered 503' }, intelligence: SOURCES.intelligence }, async (db) => {
    const card = savedScorecard();
    const mechanical = pickRoute({ card, usable, kind: 'mechanical', surface: 'one spot', highest: 'high' });
    assert.equal(`${mechanical.model}/${mechanical.effort}`, 'haiku/low');
    assert.match(mechanical.why, /haiku\/low scores 0\.00 at an unknown cost, the lowest of 9 that do$/);
    const routine = pickRoute({ card, usable, kind: 'routine', surface: 'one spot', highest: 'high' });
    assert.equal(`${routine.model}/${routine.effort}`, 'sonnet/low');
  });
  // The agent board alone prices only the efforts it lists: a priced route is not taken over one it does not price.
  await withCard({ cursorbench: { error: 'answered 503' }, arena: SOURCES.arena, intelligence: { error: 'answered 503' } }, async (db) => {
    const pick = pickRoute({ card: savedScorecard(), usable, kind: 'mechanical', surface: 'one spot', highest: 'high' });
    assert.equal(`${pick.model}/${pick.effort}`, 'haiku/low', 'not haiku/high, the one route of three the board prices');
  });
  // Every route at the same cost.
  const same = { entries: [entry('haiku', 'low', 0.3, 1), entry('sonnet', 'low', 0.4, 1), entry('opus', 'low', 0.5, 1)] };
  await withCard({ cursorbench: same, arena: { error: 'answered 503' }, intelligence: { error: 'answered 503' } }, async (db) => {
    const pick = pickRoute({ card: savedScorecard(), usable, kind: 'mechanical', surface: 'one spot', highest: 'low' });
    assert.equal(`${pick.model}/${pick.effort}`, 'haiku/low');
  });
});

test("with a ledger every route is priced per job — its own jobs, the benchmarks scaled to the ledger's, or the typical job at its prices — and never by a benchmark task's cost", async () => {
  await withCard({ cursorbench: { error: 'answered 503' }, arena: SOURCES.arena, intelligence: SOURCES.intelligence }, async (db, { root }) => {
    const card = savedScorecard();
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    // Routes the board does not price: no scale can be taken from them.
    jobOn(db, project.slug, { model: 'haiku', effort: 'low', cost: 0.15 });
    jobOn(db, project.slug, { model: 'sonnet', effort: 'medium', cost: 0.9 });
    const ledger = ledgerCost(db, 'worker');
    for (const kind of ['mechanical', 'routine', 'hard', 'novel']) {
      for (const [surface, risky] of ASKS) {
        const { why } = pickRoute({ card, usable: ['haiku', 'sonnet', 'opus'], kind, surface, risky, highest: 'high', ledger });
        assert.doesNotMatch(why, /a task on the benchmarks/, why);
      }
    }
  });
});

test('a retry on the scorecard runs on the cheapest route that scores above the attempt retried, not on the next model up the ladder', async () => {
  await withCard(SOURCES, async (db, { root }) => {
    // Cursor's models are on, and sit above haiku on the ladder; neither is on the scorecard.
    setMeta(db, 'models.state', JSON.stringify({ composer: { on: true, note: 'found 2026-11-18' }, grok: { on: true, note: 'found 2026-11-18' } }));
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    // No billed work in the ledger: the benchmarks price the routes.
    const failed = jobOn(db, project.slug, { model: 'haiku', effort: 'medium', status: 'failed' });
    routerSays(join(root, 'router-answer.json'), { kind: 'mechanical', surface: 'a few files', risky: false, reason: 'a rename across files' });
    const route = await chooseRoute(db, { agent: 'worker', project, task: 'rename the flag', title: 'rename', retryOf: failed });
    const scoreOf = (model, effort) => routeScore(savedScorecard(), model, effort, EFFORTS)?.score ?? -1;
    assert.ok(scoreOf(route.model, route.effort) > scoreOf('haiku', 'medium'), `${route.model}/${route.effort}: ${route.reason}`);
    assert.equal(`${route.model}/${route.effort}`, 'haiku/high', 'the cheapest route that does');
    assert.match(route.reason, /needs 0\.17, what haiku\/high scores a step smaller and more than 0\.08, what the attempt retried scores; haiku\/high scores 0\.17/);
    assert.doesNotMatch(route.reason, /policy:/, 'the ladder is not climbed as well');
  }, (root) => ({ ...routerEnv(root), CURSOR_API_KEY: 'stand-in' }));
});

test("without a scorecard the router chooses among Claude's models alone, as its rule names them, and a retry climbs Claude's ladder — whether or not Cursor's are on", async () => {
  await withCard(null, async (db, { root }) => {
    setMeta(db, 'models.state', JSON.stringify({ composer: { on: true, note: 'found 2026-11-18' }, grok: { on: true, note: 'found 2026-11-18' } }));
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    const failed = jobOn(db, project.slug, { model: 'haiku', effort: 'low', status: 'failed', cost: 0.1 });
    routerSays(join(root, 'router-answer.json'), { kind: 'mechanical', surface: 'one spot', risky: false, model: 'haiku', effort: 'low', reason: 'a rename' });
    const route = await chooseRoute(db, { agent: 'worker', project, task: 'rename the flag', title: 'rename', retryOf: failed });
    const saw = JSON.parse(readFileSync(join(root, 'router-saw.json'), 'utf8'));
    assert.deepEqual(saw.schema.properties.model.enum, ['haiku', 'sonnet', 'opus', 'fable']);
    assert.match(saw.prompt, /^models: haiku, sonnet, opus, fable$/m);
    assert.equal(`${route.model}/${route.effort}`, 'sonnet/low', "one step above haiku on Claude's ladder");
  }, (root) => ({ ...routerEnv(root), CURSOR_API_KEY: 'stand-in' }));
});

test("a source that lists only one of Sumo's models, at however many efforts, places nothing", async () => {
  await withCard({ ...SOURCES, arena: { entries: [entry('opus', 'high', 0.134, 2.12), entry('opus', 'max', 0.182, 5.65)] } }, async () => {
    assert.equal(savedScorecard().sources.arena, undefined, 'its efforts are not placed against each other as if they were models');
    assert.ok(savedScorecard().sources.cursorbench, 'the others are');
  });
});

test('a saved entry is read only while the catalog runs the model it scored: one for another version of it is passed over', async () => {
  await withCard(SOURCES, async (db) => {
    const card = savedScorecard();
    assert.ok(Object.values(card.sources).every((s) => s.entries.every((e) => e.id === modelId(e.model))), 'each entry says which model it scored');
    const index = card.sources.intelligence;
    const moved = { ...card, sources: { ...card.sources, intelligence: { ...index, entries: index.entries.map((e) => (e.model === 'opus' ? { ...e, id: 'claude-opus-5' } : e)) } } };
    assert.equal(routeScore(moved, 'opus', 'high', EFFORTS).sources, 2, "the index scored another opus: only the two sources that scored this one count");
  });
});

/** CursorBench at every effort Cursor takes, with Composer the cheapest route over the mechanical bar. */
const WITH_CURSOR = {
  cursorbench: {
    entries: [
      entry('haiku', 'low', 0.309, 0.08), entry('haiku', 'medium', 0.369, 0.17), entry('haiku', 'high', 0.423, 0.32), entry('haiku', 'xhigh', 0.443, 0.56), entry('haiku', 'max', 0.484, 1.12),
      entry('opus', 'low', 0.437, 1.17), entry('opus', 'medium', 0.525, 2.91), entry('opus', 'high', 0.56, 3.97), entry('opus', 'xhigh', 0.56, 6.98), entry('opus', 'max', 0.578, 13.43),
      entry('composer', '*', 0.4, 0.05),
      entry('grok', 'low', 0.331, 1.58), entry('grok', 'medium', 0.416, 3.49), entry('grok', 'high', 0.439, 4.69), entry('grok', 'xhigh', 0.463, 6.01),
    ],
  },
  arena: { error: 'answered 503' },
  intelligence: { error: 'answered 503' },
};
const CURSOR_ON = JSON.stringify({ composer: { on: true, note: 'found 2026-11-18' }, grok: { on: true, note: 'found 2026-11-18' } });

test("auto routes a turn or a job to Cursor's models whenever one is the cheapest route over the bar, and the next turn back to Claude's — Grok's max, sent to Cursor as its xhigh, is not a route of its own", async () => {
  await withCard(WITH_CURSOR, async (db, { root }) => {
    setMeta(db, 'models.state', CURSOR_ON);
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    const answer = join(root, 'router-answer.json');
    routerSays(answer, { kind: 'mechanical', surface: 'one spot', risky: false, reason: 'a typo' });
    const typo = await chooseChatRoute(db, { project, text: 'fix the typo in the README' });
    assert.equal(`${typo.model}/${typo.effort}`, 'composer/low', typo.reason);
    assert.match(typo.reason, /composer\/low scores \d\.\d\d at \$0\.05 a task on the benchmarks, the cheapest of \d+ that do$/);
    routerSays(answer, { kind: 'hard', surface: 'one spot', risky: false, reason: 'a bug whose cause is unknown' });
    const bug = await chooseChatRoute(db, { project, text: 'why does the retry ignore the limit?' });
    assert.ok(['haiku', 'opus'].includes(bug.model), `the next turn goes back to Claude's: ${bug.model}/${bug.effort}`);
    routerSays(answer, { kind: 'mechanical', surface: 'a few files', risky: false, reason: 'a rename' });
    const job = await chooseRoute(db, { agent: 'worker', project, task: 'rename the flag', title: 'rename' });
    assert.equal(`${job.model}/${job.effort}`, 'composer/medium', job.reason);
  }, (root) => ({ ...routerEnv(root), CURSOR_API_KEY: 'stand-in' }));
});

test("a model that takes no effort is priced by all its jobs, whatever effort they were routed at, and Grok's max by its xhigh: the same run is one route", async () => {
  await withCard(WITH_CURSOR, async (db, { root }) => {
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    for (let i = 0; i < 2; i++) jobOn(db, project.slug, { model: 'composer', effort: 'low', cost: 0.03 });
    jobOn(db, project.slug, { model: 'haiku', effort: 'medium', cost: 0.2 });
    jobOn(db, project.slug, { model: 'grok', effort: 'max', cost: 0.5 });
    const ledger = ledgerCost(db, 'worker');
    assert.deepEqual([...ledger.own.keys()].sort(), ['composer/*', 'grok/xhigh', 'haiku/medium']);
    const pick = pickRoute({ card: savedScorecard(), usable: ['haiku', 'composer', 'grok', 'opus'], kind: 'mechanical', surface: 'a few files', ledger });
    assert.equal(`${pick.model}/${pick.effort}`, 'composer/medium', pick.why);
    assert.match(pick.why, /at \$0\.03 a job, by its 2 in the ledger/);
  });
});

test('a scorecard written for another version of a model the router may pick is set aside: the router chooses by its rule until /scorecard writes it again', async () => {
  await withCard(SOURCES, async (db, { root }) => {
    // The catalog has since moved sonnet on: what the sources said of the old one is not what they would say of this one.
    const card = savedScorecard();
    for (const source of Object.values(card.sources)) for (const e of source.entries) if (e.model === 'sonnet') e.id = 'claude-sonnet-5';
    writeFileSync(paths().scorecard, JSON.stringify(card));
    const { project } = addProject(db, root, { slug: 'simba', now: '2026-11-18T12:00:00.000Z' });
    routerSays(join(root, 'router-answer.json'), { kind: 'routine', surface: 'one spot', risky: false, model: 'sonnet', effort: 'low', reason: 'a fix' });
    const route = await chooseRoute(db, { agent: 'worker', project, task: 'fix the flag', title: 'fix' });
    assert.equal(`${route.model}/${route.effort}`, 'sonnet/low', 'sonnet is not left out of routing for want of a score');
    assert.ok(JSON.parse(readFileSync(join(root, 'router-saw.json'), 'utf8')).schema.properties.model, 'the router was asked to choose');
  }, routerEnv);
});

test('setup writes no scorecard, and sumo models shows the one /scorecard wrote under the models', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  const none = s.sumo(['models']);
  assert.match(none.out, /^scorecard: none written — \/scorecard, in a chat, has the strongest Claude model on read the benchmarks and write it$/m, none.out);
  const first = s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^scorecard none written — \/scorecard, in a chat, has the strongest Claude model on write it; until then routing goes by its rule$/m, first.out);

  writeFileSync(join(s.home, 'scorecard.json'), JSON.stringify(cardFile(SOURCES)));
  const listed = s.sumo(['models']).out;
  assert.match(listed, /^scorecard: written 2026-11-18 by fable\/max from cursorbench; arena; intelligence$/m, listed);
  assert.match(listed, /^ {2}a score is where a model falls among haiku, sonnet, opus, fable, composer, grok, 0 to 1, averaged over the sources; a cost is one task's$/m);
  assert.match(listed, /^ {2}opus {3}low \d\.\d\d \$1\.17 · medium \d\.\d\d \$2\.91 · high 1\.00 \$3\.97 · xhigh 1\.00 · max 1\.00$/m, 'an effort no source prices has no cost');
  assert.match(listed, /^ {2}fable {2}not listed by any source$/m);
  assert.doesNotMatch(listed, /^ {2}composer /m, 'a model switched off — Cursor\'s, before Discover — is not on it');
  const again = s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  assert.match(again.out, /^scorecard written 2026-11-18 — \/scorecard, in a chat, writes it again$/m, again.out);
});

test('Discover on the settings page asks Anthropic and Cursor, then fetches list prices for the models they listed, and says all three — the scorecard is not touched', async () => {
  await withHome(freshHome(), {}, async () => {
    const found = { ok: true, found: ['haiku', 'sonnet', 'opus', 'fable'], missing: [], errors: {}, more: ['claude-opus-4-8'], cannot: ['claude-haiku-4-5-20251001'] };
    const order = [];
    const answered = (what, value) => async () => {
      order.push(`${what} asked`);
      await new Promise((r) => setTimeout(r, 5));
      order.push(`${what} answered`);
      return value;
    };
    const fromCursor = { ok: true, found: ['composer', 'cursor/gpt-5.5'], refused: ['cursor/gpt-5.6-sol', 'cursor/gemini-3.1-pro'], cannot: [], errors: {}, missing: ['grok'] };
    const page = settingsPage({ claude: () => [], discover: answered('anthropic', found), cursor: answered('cursor', fromCursor), prices: answered('prices', { ok: true, priced: 7 }) });
    const screen = () => page.lines({ columns: 400, rows: 60 }).map((l) => l.map(([t]) => t).join('')).join('\n');
    page.key('up');
    for (let i = 0; i < 60 && !/› Discover\s/.test(screen()); i++) page.key('down');
    page.key('enter');
    await new Promise((r) => setTimeout(r, 40));
    assert.match(screen(), /found: haiku, sonnet, opus, fable, claude-opus-4-8 — listed, but Sumo cannot run them, off: claude-haiku-4-5-20251001 — Cursor: runs composer, cursor\/gpt-5\.5 — 2 refused for this key, off — not found, turned off: grok — list prices for 7 models/);
    assert.deepEqual(order.slice(-2), ['prices asked', 'prices answered'], 'the prices are read once both lists are in');
    assert.deepEqual(order.slice(0, 2).sort(), ['anthropic asked', 'cursor asked'], 'Anthropic and Cursor are asked together');
    assert.equal(existsSync(paths().scorecard), false, 'no scorecard is written');
    page.key('escape');
  });
});

test('/scorecard in the chat draws the writer\'s calls as steps, then what it said and the saved scores as a table; the conversation is told nothing', async () => {
  await withHome(freshHome(), { TERM: 'xterm-256color', NO_COLOR: '', SUMO_AGENTS_MODEL_CMD: '' }, async () => {
    const db = openDb();
    try {
      const events = new EventEmitter();
      const { send, seen } = canned([
        reply('tool_use', [writeCall('w1', [CURSORBENCH, { name: 'Artificial Analysis Intelligence Index', url: 'https://artificialanalysis.ai', entries: [{ model: 'opus', effort: '*', score: 59.1, as: 'Claude Opus 5.5' }, { model: 'sonnet', effort: '*', score: 54.5, as: 'Claude Sonnet 5.5' }] }])]),
        reply('end_turn', [{ type: 'text', text: 'Two sources gave scores; fable has none yet.' }]),
      ]);
      const session = createChat(db, { model: 'opus', effort: 'high', cwd: tmpdir(), send, out: (t) => events.emit('text', t), watch: (e) => events.emit(e.type, e), now: () => '2026-11-18T12:00:00.000Z' });
      const tty = fakeTty({ columns: 120 });
      const ui = runUi({ session, events, stdin: tty.stdin, stdout: tty.stdout, messages: ['Working'], cwd: '/work/here', logo: [], debug: true, progress: false });
      try {
        await tty.type('/scorecard\r');
        for (const end = Date.now() + 10_000; Date.now() < end && !/Saved: written/.test(tty.screen()); ) await new Promise((r) => setTimeout(r, 10));
        const screen = tty.screen();
        assert.match(screen, /write_scorecard/, screen);
        assert.match(screen, /written: 2 sources/);
        assert.match(screen, /scorecard written by fable\/max from CursorBench, via Epoch AI; Artificial Analysis Intelligence Index — \$\d/);
        assert.match(screen, /Two sources gave scores; fable has none yet\./);
        assert.match(screen, /Saved: written 2026-11-18 by fable\/max from /);
        assert.match(screen, /opus\s+│\s+\d\.\d\d\s+│/, 'the scores as a table');
        assert.equal(seen.length, 2, 'the writer\'s two requests, and no other');
        assert.doesNotMatch(JSON.stringify(session.params.messages), /CursorBench|scorecard/, 'nothing of it went into the conversation');
        await tty.type('\x04');
      } finally {
        ui.unmount();
      }
    } finally {
      db.close();
    }
  });
});

test('when no route clears the bar and the best scored has no price, the pick is still made and says so, never a crash', () => {
  const entry = (model, score) => ({ model, effort: '*', score, cost: null, place: score, id: modelId(model) });
  const card = { sources: { intelligence: { at: 'x', entries: [entry('haiku', 0), entry('sonnet', 0.5), entry('opus', 1)] } } };
  const picked = pickRoute({ card, usable: ['haiku', 'sonnet'], kind: 'novel', surface: 'one spot' });
  assert.equal(picked.model, 'sonnet');
  assert.match(picked.why, /none does, and sonnet\/\w+ scores best/);
});

test("modelgrep's list prices price every name Sumo runs a model by, and the models Sumo's own list does not", () => {
  const models = ['haiku', 'opus', 'cursor/claude-opus-5-5', 'cursor/gpt-5.5'];
  const rows = [
    { id: 'anthropic/claude-opus-5.5', pricing: { input: 4, output: 20, cache_read: 0.2 } },
    { id: 'openai/gpt-5.5', pricing: { input: 1.25, output: 10 } },
    { id: 'anthropic/claude-haiku-5.5', pricing: { input: 0, output: 0 } },
  ];
  assert.deepEqual(pricesFrom(rows, models), {
    opus: { input: 4, output: 20, cacheRead: 0.05 },
    'cursor/claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.05 },
    'cursor/gpt-5.5': { input: 1.25, output: 10, cacheRead: 1 },
  }, 'a cache read as a share of input, the whole input where none is listed; no price at zero');
});

test('a route the benchmarks do not price ranks after every one they do: an unknown cost is not taken for a low one, nor does it switch the prices off', async () => {
  // Grok is the lower rung (cheaper by the token) and dearer by the task; Fable's low effort has no cost listed.
  const sources = { cursorbench: { entries: [entry('haiku', 'low', 0.5, 0.08), entry('grok', 'low', 0.6, 3.49), entry('sonnet', 'low', 0.7, 0.37), entry('fable', 'low', 0.8), entry('fable', 'high', 0.9, 9.08)] } };
  await withCard(sources, async (db) => {
    const card = savedScorecard();
    const pick = pickRoute({ card, usable: ['grok', 'sonnet', 'fable'], kind: 'mechanical', surface: 'one spot', highest: 'high' });
    assert.equal(`${pick.model}/${pick.effort}`, 'sonnet/low', 'the cheapest priced route, not the lowest rung of all');
    assert.match(pick.why, /sonnet\/low scores [\d.]+ at \$0\.37 a task on the benchmarks, the cheapest priced of 9 that do$/, 'the efforts the board lists no cost for are said to be unpriced');
    const unpricedOnly = pickRoute({ card, usable: ['fable'], kind: 'mechanical', surface: 'one spot', highest: 'low' });
    assert.match(unpricedOnly.why, /fable\/low scores [\d.]+ at an unknown cost, the lowest of 1 that do$/, 'with nothing priced, the lowest rung, said so');
  });
});

test('a model switched off leaves the scorecard: it is not shown or weighed, no other model\'s place moves, and it is back when switched on — with nothing written again', async () => {
  await withCard(SOURCES, async (db) => {
    const score = (model, effort) => routeScore(activeScorecard(db), model, effort, EFFORTS)?.score;
    const sonnetWithAll = score('sonnet', 'low');
    setModel(db, 'haiku', false, '2026-11-18T12:00:00.000Z');
    assert.equal(score('haiku', 'low'), undefined, 'haiku is not on the scorecard while it is off');
    assert.equal(score('sonnet', 'low'), sonnetWithAll, 'sonnet keeps its place');
    const lines = scorecardLines(db, EFFORTS);
    assert.equal(lines.some((l) => /^ {2}haiku /.test(l)), false, 'sumo models leaves it out');
    assert.ok(lines.some((l) => /^ {2}sonnet /.test(l)));
    const report = scorecardReport(db, { ok: true, by: 'fable/max', usd: 0.4, card: savedScorecard() }, EFFORTS);
    assert.match(report, /^\| sonnet \|/m);
    assert.doesNotMatch(report, /^\| haiku \|/m, '/scorecard leaves it out too');
    const pick = pickRoute({ card: activeScorecard(db), usable: ['haiku', 'sonnet', 'opus'], kind: 'mechanical', surface: 'one spot', highest: 'high' });
    assert.notEqual(pick.model, 'haiku', 'not weighed even when asked for');
    setModel(db, 'haiku', true, '2026-11-18T12:00:00.000Z');
    assert.equal(typeof score('haiku', 'low'), 'number', 'switched on again, it is back');
    assert.equal(savedScorecard().sources.cursorbench.entries.some((e) => e.model === 'haiku'), true, 'what was written is kept whole');
  });
});

test('every model is placed on the ruler of the six Sumo names: dozens more listed move none of their places, and one between two of them falls between their places', async () => {
  const six = [entry('haiku', 'low', 0.3, 0.08), entry('sonnet', 'low', 0.4, 0.37), entry('opus', 'low', 0.5, 1.17)];
  const older = Array.from({ length: 20 }, (_, i) => entry(`claude-old-${i}`, 'low', 0.1 + i * 0.005, 0.5));
  const placesOf = async (entries) => {
    let card;
    await withCard({ cursorbench: { entries } }, async (db) => {
      card = savedScorecard();
    });
    return (model) => routeScore(card, model, 'low', EFFORTS).score;
  };
  const alone = await placesOf(six);
  const among = await placesOf([...six, entry('claude-between', 'low', 0.45, 0.9), ...older]);
  assert.equal(among('sonnet'), alone('sonnet'), 'twenty weaker models do not lift sonnet');
  assert.equal(among('sonnet'), 0.5);
  assert.equal(among('claude-between'), 0.75, 'halfway between sonnet and opus');
  assert.equal(among('claude-old-0'), 0, 'below the ruler is its bottom');
});

test('a route of a Cursor model is avoided by its whole name, and a retry steps past the same model through the other lane', async () => {
  const sources = { cursorbench: { entries: [entry('haiku', 'low', 0.3, 0.08), entry('sonnet', 'low', 0.5, 0.37), entry('cursor/gpt-5.5', 'low', 0.45, 0.2), entry('opus', 'low', 0.6, 1.17)] } };
  await withCard(sources, async (db) => {
    const card = savedScorecard();
    const usable = ['haiku', 'sonnet', 'cursor/gpt-5.5', 'opus'];
    const first = pickRoute({ card, usable, kind: 'routine', surface: 'one spot', highest: 'low' });
    assert.equal(`${first.model}/${first.effort}`, 'cursor/gpt-5.5/low');
    const avoided = pickRoute({ card, usable, kind: 'routine', surface: 'one spot', highest: 'low', avoid: ['cursor/gpt-5.5/low'] });
    assert.equal(`${avoided.model}/${avoided.effort}`, 'sonnet/low', 'avoided by its whole name, slash and all');
  });
  const retried = routePolicy({ agent: 'worker', routed: { model: 'sonnet', effort: 'medium' }, retryOf: { id: 3, model: 'sonnet', effort: 'medium', status: 'failed' }, usable: ['haiku', 'sonnet', 'cursor/claude-sonnet-5-5', 'opus'] });
  assert.equal(retried.model, 'opus', 'the same model through Cursor is no step above it');
  const scout = routePolicy({ agent: 'scout', routed: { model: 'cursor/claude-haiku-5-5', effort: 'low' }, usable: ['cursor/claude-haiku-5-5', 'sonnet'] });
  assert.deepEqual([scout.model, scout.effort], ['sonnet', 'low'], 'the rules for a model hold for it through Cursor');
});
