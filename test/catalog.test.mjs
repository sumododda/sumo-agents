// The models Sumo can run on: which ones the API has here, found once by `sumo setup` and again by
// API models › Discover on the settings page, and which the user has turned off — and what every command does with that.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const DATE = /\d{4}-\d{2}-\d{2}/;

test('before anything is checked every Claude model is on and says it was not checked, Cursor\'s are off, and all are listed cheapest first', () => {
  const s = sandbox();
  const run = s.sumo(['models']);
  assert.equal(run.code, 0, run.err);
  const [models, card] = run.out.trim().split('\n\n');
  const lines = models.split('\n');
  assert.equal(lines.length, 6, "one line per model Sumo knows before Discover: Claude's four and Cursor's two");
  assert.deepEqual(lines.map((l) => l.split(' ')[0]), ['haiku', 'composer', 'grok', 'sonnet', 'opus', 'fable'], 'cheapest first, by output price');
  assert.match(lines[1], /^composer\s+off\s+composer-2\.5\s+not discovered yet · through Cursor$/, "Cursor's are off until Discover finds them");
  assert.match(card, /^scorecard: none written/, 'then the scorecard, apart');
  assert.match(lines[0], /^haiku\s+on\s+claude-haiku-5-5\s+not checked$/);
  assert.match(lines[4], /^opus\s+on\s+claude-opus-5-5\s+not checked$/);
  assert.match(lines[5], /^fable\s+on\s+claude-fable-5-1\s+not checked$/);
});

test('setup asks the API which models it has, once: a model it does not have is turned off; a later setup does not ask again', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.modelsFound(['haiku', 'sonnet', 'opus']);

  const first = s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  assert.equal(first.code, 0, first.err);
  assert.match(first.out, /^models {4}found: haiku, sonnet, opus — not found, turned off: fable$/m, first.out);
  const listed = s.sumo(['models']).out;
  assert.match(listed, /^opus\s+on\s+claude-opus-5-5\s+found \d{4}-\d{2}-\d{2}$/m, listed);
  assert.match(listed, /^fable\s+off\s+claude-fable-5-1\s+not found \d{4}-\d{2}-\d{2}$/m, listed);

  // The API now says only haiku: setup leaves what was found alone, Discover does not.
  s.modelsFound(['haiku']);
  const again = s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  assert.match(again.out, /^models {4}checked \d{4}-\d{2}-\d{2} — API models › Discover, on the settings page \(sumo config\), checks again$/m, again.out);
  assert.match(s.sumo(['models']).out, /^opus\s+on\s/m, 'a second setup changed nothing');

  const discovered = s.page(['models', 'discover']);
  assert.equal(discovered.code, 0, discovered.err);
  assert.match(discovered.out, /^opus\s+off\s+claude-opus-5-5\s+not found /m, discovered.out);
  assert.match(discovered.out, /^haiku\s+on\s+claude-haiku-5-5\s+found /m, discovered.out);
});

/** What the API says a model takes (`/v1/models`): adaptive thinking, the efforts, clearing old tool results. */
const takes = ({ adaptive = true, efforts = ['low', 'medium', 'high', 'xhigh', 'max'], clearing = true } = {}) => ({
  thinking: { supported: true, types: { adaptive: { supported: adaptive } } },
  effort: { supported: efforts.length > 0, ...Object.fromEntries(['low', 'medium', 'high', 'xhigh', 'max'].map((e) => [e, { supported: efforts.includes(e) }])) },
  context_management: { supported: true, clear_tool_uses_20250919: { supported: clearing } },
});
const listedClaude = (id, name, can) => ({ type: 'model', id, display_name: name, capabilities: takes(can) });

test('Discover lists every model the API has for the credential, cheapest first, and tries each: one this login is refused, or Sumo cannot drive, is listed and off, saying why', () => {
  const s = sandbox();
  s.modelsFound(['haiku', 'sonnet', 'opus', 'fable'], {
    listed: [
      listedClaude('claude-mythos-5-2', 'Claude Mythos 5.2'),
      listedClaude('claude-opus-4-6', 'Claude Opus 4.6', { efforts: ['low', 'medium', 'high', 'max'] }),
      listedClaude('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', { adaptive: false, efforts: [] }),
      listedClaude('claude-opus-5-5', 'Claude Opus 5.5'),
      listedClaude('claude-fable-5-2', 'Claude Fable 5.2'),
    ],
    refused: { 'claude-fable-5-2': "Claude Code 2.1.280 does not support this model; version 2.1.290 or newer is required. Run 'claude update'" },
  });
  const run = s.page(['models', 'discover']);
  assert.equal(run.code, 0, run.err);
  const names = run.out.trim().split('\n').map((l) => l.split(' ')[0]);
  assert.deepEqual(names, ['haiku', 'composer', 'grok', 'sonnet', 'opus', 'fable', 'claude-fable-5-2', 'claude-mythos-5-2', 'claude-opus-4-6', 'claude-sonnet-4-5-20250929'], "Sumo's priced ones cheapest first, then the ones with no price yet, by name");
  assert.match(run.out, /^claude-fable-5-2 +off {2}Claude Fable 5\.2 +found \d{4}-\d{2}-\d{2} — the API refused it for this login: Claude Code 2\.1\.280 does not support this model; version 2\.1\.290 or newer is required\. Run 'claude update' · no price known$/m, 'listed, tried and refused: off, with the reason');
  assert.match(run.out, /^claude-mythos-5-2 +on +Claude Mythos 5\.2 +found \d{4}-\d{2}-\d{2} · no price known$/m, run.out);
  assert.match(run.out, /^claude-sonnet-4-5-20250929 off {2}Claude Sonnet 4\.5 +found \d{4}-\d{2}-\d{2} — Sumo cannot run it: no adaptive thinking, no effort · no price known$/m, run.out);
  assert.equal(names.filter((n) => n === 'opus').length, 1, 'one of the four is not listed again under its id');

  // A model now listed is one a chat can be set to; one that is off, or not listed, is refused.
  assert.match(s.page(['config', 'chat.model', 'claude-opus-4-6']).out, /chat\.model = claude-opus-4-6/);
  assert.match(s.page(['config', 'chat.model', 'claude-sonnet-4-5-20250929']).err, /claude-sonnet-4-5-20250929 is off/);
  assert.match(s.page(['config', 'chat.model', 'claude-opus-9']).err, /no such model "claude-opus-9"/);
});

test('a check that fails changes nothing: no answer, no credential, a model whose own check errored, or an API with none of them', () => {
  const s = sandbox();
  // Nothing recorded: the stand-in fails the way a network error would.
  const noAnswer = s.page(['models', 'discover']);
  assert.equal(noAnswer.code, 1, noAnswer.out);
  assert.match(noAnswer.err, /^sumo: could not check the models — .*no models answer recorded.*nothing was changed/, noAnswer.err);
  assert.match(s.sumo(['models']).out, /^fable\s+on\s+claude-fable-5-1\s+not checked$/m);

  // Without the stand-in and without a credential there is nothing to ask with.
  const noKey = s.page(['models', 'discover'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(noKey.code, 4);
  assert.match(noKey.err, /no Anthropic credential/);

  // One model's check erroring leaves that model as it was; the others are recorded.
  s.modelsFound(['haiku', 'sonnet'], { errors: { fable: 'the API answered 500: overloaded' } });
  const partial = s.page(['models', 'discover']);
  assert.equal(partial.code, 0, partial.err);
  assert.match(partial.out, /^opus\s+off\s+claude-opus-5-5\s+not found /m, partial.out);
  assert.match(partial.out, /^fable\s+on\s+claude-fable-5-1\s+not checked — the API answered 500: overloaded$/m, partial.out);

  // An API with none of Sumo's models is not an API that has turned them all off — nothing is changed, and it is said.
  s.modelsFound([]);
  const none = s.page(['models', 'discover']);
  assert.equal(none.code, 1, none.out);
  assert.match(none.err, /found none of the models Sumo knows.*nothing was changed/, none.err);
  assert.match(s.sumo(['models']).out, /^haiku\s+on\s/m, 'haiku is still on');
});

test('a model can be turned off and on by hand, by name; a name Sumo does not know is refused', () => {
  const s = sandbox();
  const off = s.page(['models', 'disable', 'opus']);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out.trim(), /^opus\s+off\s+claude-opus-5-5\s+turned off \d{4}-\d{2}-\d{2}$/, off.out);
  assert.match(s.sumo(['models']).out, /^opus\s+off\s/m, 'it stays off');

  const on = s.page(['models', 'enable', 'opus']);
  assert.match(on.out.trim(), /^opus\s+on\s+claude-opus-5-5\s+turned on \d{4}-\d{2}-\d{2}$/, on.out);

  for (const args of [['models', 'enable', 'gpt'], ['models', 'disable'], ['models', 'frobnicate']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
  }
  assert.match(s.page(['models', 'enable', 'gpt']).err, /no such model "gpt" — one of: haiku, composer, grok, sonnet, opus, fable$/m);
  assert.match(s.sumo(['models', 'frobnicate']).err, /usage: sumo models/);
});

test('config refuses a model that is off or that Sumo does not know, for the chat and for the passes', () => {
  const s = sandbox();
  s.page(['models', 'disable', 'fable']);

  const off = s.page(['config', 'chat.model', 'fable']);
  assert.equal(off.code, 2, off.out);
  assert.match(off.err, /fable is off — turn it on under API models, on the settings page \(sumo config\)/);
  assert.match(s.sumo(['config', 'chat.model']).out, /chat\.model = opus/, 'a refused value is not stored');

  const unknown = s.page(['config', 'chat.model', 'gpt']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /no such model "gpt" — one of: auto, haiku, composer, grok, sonnet, opus, fable$/m);
  assert.match(s.page(['config', 'chat.model', 'auto']).out, /chat\.model = auto/);
  assert.match(s.page(['config', 'chat.model', 'sonnet']).out, /chat\.model = sonnet/);

  const pass = s.page(['config', 'memory.model', 'fable']);
  assert.equal(pass.code, 2);
  assert.match(pass.err, /fable is off — turn it on under API models, on the settings page \(sumo config\)/);
  assert.match(s.page(['config', 'memory.model', 'gpt']).err, /no such model "gpt" — one of: local, off, haiku, sonnet, opus, fable/);
  assert.match(s.page(['config', 'memory.model', 'off']).out, /memory\.model = off/);
  assert.match(s.page(['config', 'memory.model', 'local']).out, /memory\.model = local/);
});

test('doctor says which models are on, fails when none is or when a configured one is off, and warns while nothing was checked', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  const env = { PATH: `${binDir}:${process.env.PATH}` };

  const unchecked = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(unchecked.code, 0, unchecked.out);
  assert.match(unchecked.out, /^ok {4}models on: haiku, sonnet, opus, fable$/m, unchecked.out);
  assert.match(unchecked.out, /^warn  models checked against the API — API models › Discover, on the settings page: sumo config$/m, unchecked.out);
  assert.match(unchecked.out, /^ok {4}chat\.model is on \(opus\)$/m, unchecked.out);

  s.modelsFound(['haiku', 'sonnet', 'opus']);
  s.page(['models', 'discover']);
  const checked = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /^ok {4}models on: haiku, sonnet, opus; off: fable$/m, checked.out);
  assert.match(checked.out, /^ok {4}models checked against the API \(\d{4}-\d{2}-\d{2}\)$/m, checked.out);

  s.page(['models', 'disable', 'opus']);
  const chatOff = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(chatOff.code, 1);
  assert.match(chatOff.out, /^FAIL {2}chat\.model is on \(opus\) — turn opus on under API models, or pick another model, on the settings page: sumo config$/m, chatOff.out);

  s.page(['models', 'disable', 'haiku']);
  s.page(['models', 'disable', 'sonnet']);
  const noneOn = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(noneOn.code, 1);
  assert.match(noneOn.out, /^FAIL {2}models on: none; off: haiku, sonnet, opus, fable — turn one on under API models, on the settings page: sumo config$/m, noneOn.out);
});

test('the passes: a writer set to a model that is off fails without calling it; the retry after a failed local call goes to the cheapest model that is on, or nowhere', () => {
  const s = sandbox();
  const ops = [{ op: 'add', type: 'preference', scope: 'global', topic: 'git', body: 'Always squash merge', turn: 1, quote: 'always squash merge' }];
  const keyed = { ANTHROPIC_API_KEY: 'sk-ant-test', STUB_LOCAL_FAILS: '1' };

  s.page(['config', 'memory.model', 'opus']);
  s.page(['models', 'disable', 'opus']);
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay(ops);
  const off = s.sumo(['memory', 'run'], { extraEnv: keyed });
  assert.match(off.out, /^failed — opus is off — turn it on under API models, on the settings page \(sumo config\), or set Memory › Filed by to local there/, off.out + off.err);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT model, ok FROM model_runs').all().map((r) => [r.model, r.ok])), [['opus', 0]], 'the refusal is in the ledger, no call was made');

  // Back on the local model, with haiku off: the retry goes to sonnet, the cheapest model that is on.
  s.page(['config', 'memory.model', 'local']);
  s.page(['models', 'disable', 'haiku']);
  const retried = s.sumo(['memory', 'run'], { extraEnv: keyed });
  assert.match(retried.out, /^read 1 turns/, retried.out + retried.err);
  const rows = s.sql((db) => db.prepare('SELECT model, ok, note FROM model_runs ORDER BY id').all());
  assert.deepEqual(rows.slice(1).map((r) => [r.model, r.ok]), [['local', 0], ['sonnet', 1]]);
  assert.match(rows[1].note, /retrying on sonnet/);
  assert.equal(s.modelWasShown().model, 'sonnet');

  // With no API model on there is nothing to retry on: the local failure is the failure.
  s.page(['models', 'disable', 'sonnet']);
  s.page(['models', 'disable', 'fable']);
  s.hook('prompt', { session_id: 'two', prompt: 'and always rebase first' });
  const alone = s.sumo(['memory', 'run'], { extraEnv: keyed });
  assert.match(alone.out, /^failed — /, alone.out + alone.err);
  const last = s.sql((db) => db.prepare('SELECT model, ok, note FROM model_runs ORDER BY id DESC LIMIT 1').get());
  assert.equal(last.model, 'local');
  assert.doesNotMatch(last.note, /retrying/);
});

test('a job routed to a model that has since been turned off is not run', () => {
  const s = sandbox();
  s.addProject('demo');
  s.routerWillSay('opus', 'high', 'hard');
  const created = s.sumo(['job', 'new', '--project', 'demo', '--title', 'x'], { input: 'do the thing' });
  assert.equal(created.code, 0, created.err);
  const id = /created j(\d+)/.exec(created.out)[1];
  s.page(['models', 'disable', 'opus']);
  const run = s.sumo(['job', 'run', id], { extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.notEqual(run.code, 0);
  assert.match(run.err, new RegExp(`j${id} cannot run: opus is off — turn it on under API models, on the settings page \\(sumo config\\), or abandon it and create it again`), run.out + run.err);
});

test('discovery that could not reach the API says so rather than blaming the credential, and an answer that is not a list is a failed check', () => {
  const s = sandbox();
  s.modelsFound([], { errors: { haiku: 'Connection error.', sonnet: 'Connection error.', opus: 'Connection error.' } });
  const unreachable = s.page(['models', 'discover']);
  assert.notEqual(unreachable.code, 0);
  assert.match(unreachable.err, /Connection error\./);
  assert.doesNotMatch(unreachable.err, /credential may not be allowed/);

  writeFileSync(join(s.root, 'models-answer.json'), 'null');
  const odd = s.page(['models', 'discover']);
  assert.notEqual(odd.code, 0);
  assert.match(odd.err, /could not check the models — .* not a list of models/);
  assert.doesNotMatch(odd.err, /Cannot read properties/);
});

test('discovery never turns back on a model the user turned off by hand: it only says what the API has', () => {
  const s = sandbox();
  s.modelsFound(['haiku', 'sonnet', 'opus', 'fable']);
  s.page(['models', 'disable', 'haiku']);
  const discovered = s.page(['models', 'discover']);
  assert.equal(discovered.code, 0, discovered.err);
  assert.match(discovered.out, /^haiku\s+off\s+claude-haiku-5-5\s+turned off \d{4}-\d{2}-\d{2}$/m, discovered.out);
  assert.match(discovered.out, /^sonnet\s+on\s/m, discovered.out);
  // Turned on again by hand, it is the API's to judge once more.
  s.page(['models', 'enable', 'haiku']);
  assert.match(s.page(['models', 'discover']).out, /^haiku\s+on\s+claude-haiku-5-5\s+found /m);
});

test('a listed Claude model is asked at the nearest effort it takes, with adaptive thinking, and without the fallback only sonnet, opus and fable are checked to take', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { freshHome, withHome } = await import('./fixtures/env-sandbox.mjs');
  const { REPO_ROOT } = await import('../src/paths.mjs');
  const { openDb } = await import('../src/db.mjs');
  const { discoverModels, effortOn } = await import('../src/catalog.mjs');
  const { paramsFor } = await import('../src/loop.mjs');
  const answer = join(mkdtempSync(join(tmpdir(), 'sumo-agents-listed-')), 'models.json');
  writeFileSync(answer, JSON.stringify({ found: ['haiku', 'sonnet', 'opus', 'fable'], listed: [listedClaude('claude-opus-4-6', 'Claude Opus 4.6', { efforts: ['low', 'medium', 'high', 'max'] })] }));
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_MODELS: answer }, async () => {
    const db = openDb();
    try {
      assert.equal((await discoverModels(db)).ok, true);
      assert.equal(effortOn('claude-opus-4-6', 'xhigh'), 'high', 'xhigh, which it lacks, is the high below it');
      assert.equal(effortOn('claude-opus-4-6', 'max'), 'max');
      const params = paramsFor({ model: 'claude-opus-4-6', effort: 'xhigh', tools: [], system: 'x', text: 'go' });
      assert.equal(params.model, 'claude-opus-4-6');
      assert.deepEqual(params.output_config, { effort: 'high' });
      assert.deepEqual(params.thinking, { type: 'adaptive', display: 'summarized' });
      assert.equal(params.fallbacks, undefined, 'no fallback where none was checked');
      assert.equal(paramsFor({ model: 'opus', effort: 'xhigh', tools: [], system: 'x', text: 'go' }).fallbacks, 'default', 'opus keeps it');
    } finally {
      db.close();
    }
  });
});

test('a model is tried with the request a chat starts with, asking for one word: an answer is a ledger row, a refusal its reason, a failed connection no verdict', async () => {
  const { freshHome, withHome } = await import('./fixtures/env-sandbox.mjs');
  const { openDb } = await import('../src/db.mjs');
  const { tryClaudeModel } = await import('../src/loop.mjs');
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const sent = [];
      const ok = await tryClaudeModel(db, 'sonnet', {
        now: () => '2026-11-18T12:00:00.000Z',
        send: async (params) => {
          sent.push(params);
          return { model: 'claude-sonnet-5-5', usage: { input_tokens: 20, output_tokens: 3 }, content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn' };
        },
      });
      assert.deepEqual(ok, { ok: true });
      assert.equal(sent[0].model, 'claude-sonnet-5-5');
      assert.deepEqual(sent[0].thinking, { type: 'adaptive', display: 'summarized' }, 'what every request of Sumo\'s carries');
      assert.ok(sent[0].output_config?.effort && sent[0].context_management, 'an effort and the context edits too');
      assert.equal(sent[0].max_tokens, 256);
      assert.deepEqual(db.prepare("SELECT kind, model, ok FROM model_runs").all().map((r) => ({ ...r })), [{ kind: 'discover', model: 'claude-sonnet-5-5', ok: 1 }]);

      const refusal = Object.assign(new Error('400'), { status: 400, error: { type: 'error', error: { type: 'invalid_request_error', message: 'Claude Code 2.1.280 does not support this model' } } });
      assert.deepEqual(await tryClaudeModel(db, 'claude-fable-5-2', { send: async () => { throw refusal; } }), { ok: false, refused: 'Claude Code 2.1.280 does not support this model' });
      const overloaded = Object.assign(new Error('Overloaded'), { status: 529 });
      const busy = await tryClaudeModel(db, 'opus', { send: async () => { throw overloaded; } });
      assert.equal(busy.ok, false);
      assert.equal(busy.refused, undefined, 'a busy API is not a refusal: the switch is left as it was');
      assert.match(busy.error, /Overloaded/);
    } finally {
      db.close();
    }
  });
});

test("the cost report splits a request on a model Discover found by that model's list price, in a process that read nothing else first", async () => {
  const { setMeta } = await import('../src/db.mjs');
  const s = sandbox();
  s.sumo(['models']);
  s.sql((db) => {
    setMeta(db, 'models.prices', JSON.stringify({ 'cursor/grok-4.6': { input: 2, output: 6, cacheRead: 0.25 } }));
    db.prepare(`INSERT INTO model_runs (ts, kind, model, input_tokens, output_tokens, cost_usd, ok, note) VALUES (?, 'worker', 'cursor/grok-4.6', 1000000, 1000000, 8, 1, 'x')`).run(new Date().toISOString());
  });
  const out = s.sumo(['cost']).out;
  assert.match(out, /^ {2}worker · cursor\/grok-4\.6: 1 request, \$8\.00 — uncached \$2\.00 · cache read \$0\.00 · cache write \$0\.00 · output \$6\.00$/m, out);
});

test('a model Discover finds is off until it has answered: one the connection failed for is listed and stays off', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { freshHome, withHome } = await import('./fixtures/env-sandbox.mjs');
  const { REPO_ROOT } = await import('../src/paths.mjs');
  const { openDb } = await import('../src/db.mjs');
  const { discoverModels, modelStates, onModels } = await import('../src/catalog.mjs');
  const answer = join(mkdtempSync(join(tmpdir(), 'sumo-agents-untried-')), 'models.json');
  writeFileSync(answer, JSON.stringify({ found: ['haiku', 'sonnet', 'opus', 'fable'], listed: [listedClaude('claude-opus-4-8', 'Claude Opus 4.8')] }));
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_MODELS: answer }, async () => {
    const db = openDb();
    try {
      const result = await discoverModels(db, { now: '2026-11-18T12:00:00.000Z', tryModel: async () => ({ ok: false, error: 'the API answered 529: Overloaded' }) });
      assert.deepEqual(result.errors, { 'claude-opus-4-8': 'the API answered 529: Overloaded' });
      assert.deepEqual(modelStates(db)['claude-opus-4-8'], { on: false, note: 'found 2026-11-18 — not tried: the API answered 529: Overloaded' });
      assert.equal(onModels(db).includes('claude-opus-4-8'), false, 'not offered');
      await discoverModels(db, { now: '2026-11-18T12:00:00.000Z', tryModel: async () => ({ ok: true }) });
      assert.deepEqual(modelStates(db)['claude-opus-4-8'], { on: true, note: 'found 2026-11-18' }, 'on once it answers');
    } finally {
      db.close();
    }
  });
});

test('a job routed to a model a later Discover no longer lists is not run: it says why and how out, as for one switched off', () => {
  const s = sandbox();
  s.addProject('demo');
  s.modelsFound(['haiku', 'sonnet', 'opus', 'fable'], { listed: [listedClaude('claude-opus-4-8', 'Claude Opus 4.8')] });
  assert.equal(s.page(['models', 'discover']).code, 0);
  const now = new Date().toISOString();
  s.sql((db) => db.prepare(`INSERT INTO jobs (project, title, agent, status, created_at, updated_at, model, effort, route_reason) VALUES ('demo', 'x', 'worker', 'running', ?, ?, 'claude-opus-4-8', 'medium', 'test')`).run(now, now));
  s.modelsFound(['haiku', 'sonnet', 'opus', 'fable']);
  assert.equal(s.page(['models', 'discover']).code, 0, 'listed no more');
  const run = s.sumo(['job', 'run', '1'], { extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.notEqual(run.code, 0);
  assert.match(run.err, /j1 cannot run: claude-opus-4-8 is not among the models Sumo knows now — API models › Discover, on the settings page \(sumo config\), lists them again, or abandon it and create it again/, run.out + run.err);
});
