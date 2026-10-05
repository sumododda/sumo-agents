// The models Sumo can run on: which ones the API has here, found once by `sumo setup` and again by
// `sumo models discover`, and which the user has turned off — and what every command does with that.
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const DATE = /\d{4}-\d{2}-\d{2}/;

test('before anything is checked every model is on, and says it was not checked', () => {
  const s = sandbox();
  const run = s.sumo(['models']);
  assert.equal(run.code, 0, run.err);
  const lines = run.out.trim().split('\n');
  assert.equal(lines.length, 4, 'one line per model Sumo knows');
  assert.match(lines[0], /^haiku\s+on\s+claude-haiku-4-5-20251001\s+not checked$/);
  assert.match(lines[2], /^opus\s+on\s+claude-opus-5-5\s+not checked$/);
  assert.match(lines[3], /^fable\s+on\s+claude-fable-5-1\s+not checked$/);
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

  // The API now says only haiku: setup leaves what was found alone, `sumo models discover` does not.
  s.modelsFound(['haiku']);
  const again = s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  assert.match(again.out, /^models {4}checked \d{4}-\d{2}-\d{2} — sumo models discover to check again$/m, again.out);
  assert.match(s.sumo(['models']).out, /^opus\s+on\s/m, 'a second setup changed nothing');

  const discovered = s.sumo(['models', 'discover']);
  assert.equal(discovered.code, 0, discovered.err);
  assert.match(discovered.out, /^opus\s+off\s+claude-opus-5-5\s+not found /m, discovered.out);
  assert.match(discovered.out, /^haiku\s+on\s+claude-haiku-4-5-20251001\s+found /m, discovered.out);
});

test('a check that fails changes nothing: no answer, no credential, a model whose own check errored, or an API with none of them', () => {
  const s = sandbox();
  // Nothing recorded: the stand-in fails the way a network error would.
  const noAnswer = s.sumo(['models', 'discover']);
  assert.equal(noAnswer.code, 1, noAnswer.out);
  assert.match(noAnswer.err, /^sumo: could not check the models — .*no models answer recorded.*nothing was changed/, noAnswer.err);
  assert.match(s.sumo(['models']).out, /^fable\s+on\s+claude-fable-5-1\s+not checked$/m);

  // Without the stand-in and without a credential there is nothing to ask with.
  const noKey = s.sumo(['models', 'discover'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(noKey.code, 1);
  assert.match(noKey.err, /no Anthropic credential/);

  // One model's check erroring leaves that model as it was; the others are recorded.
  s.modelsFound(['haiku', 'sonnet'], { errors: { fable: 'the API answered 500: overloaded' } });
  const partial = s.sumo(['models', 'discover']);
  assert.equal(partial.code, 0, partial.err);
  assert.match(partial.out, /^opus\s+off\s+claude-opus-5-5\s+not found /m, partial.out);
  assert.match(partial.out, /^fable\s+on\s+claude-fable-5-1\s+not checked — the API answered 500: overloaded$/m, partial.out);

  // An API with none of Sumo's models is not an API that has turned them all off — nothing is changed, and it is said.
  s.modelsFound([]);
  const none = s.sumo(['models', 'discover']);
  assert.equal(none.code, 1, none.out);
  assert.match(none.err, /found none of the models Sumo knows.*nothing was changed/, none.err);
  assert.match(s.sumo(['models']).out, /^haiku\s+on\s/m, 'haiku is still on');
});

test('a model can be turned off and on by hand, by name; a name Sumo does not know is refused', () => {
  const s = sandbox();
  const off = s.sumo(['models', 'disable', 'opus']);
  assert.equal(off.code, 0, off.err);
  assert.match(off.out.trim(), /^opus\s+off\s+claude-opus-5-5\s+turned off \d{4}-\d{2}-\d{2}$/, off.out);
  assert.match(s.sumo(['models']).out, /^opus\s+off\s/m, 'it stays off');

  const on = s.sumo(['models', 'enable', 'opus']);
  assert.match(on.out.trim(), /^opus\s+on\s+claude-opus-5-5\s+turned on \d{4}-\d{2}-\d{2}$/, on.out);

  for (const args of [['models', 'enable', 'gpt'], ['models', 'disable'], ['models', 'frobnicate']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
  }
  assert.match(s.sumo(['models', 'enable', 'gpt']).err, /no such model "gpt" — one of: haiku, sonnet, opus, fable/);
  assert.match(s.sumo(['models', 'frobnicate']).err, /usage: sumo models/);
});

test('config refuses a model that is off or that Sumo does not know, for the chat and for the passes', () => {
  const s = sandbox();
  s.sumo(['models', 'disable', 'fable']);

  const off = s.sumo(['config', 'chat.model', 'fable']);
  assert.equal(off.code, 2, off.out);
  assert.match(off.err, /fable is off — sumo models enable fable/);
  assert.match(s.sumo(['config', 'chat.model']).out, /chat\.model = opus/, 'a refused value is not stored');

  const unknown = s.sumo(['config', 'chat.model', 'gpt']);
  assert.equal(unknown.code, 2);
  assert.match(unknown.err, /no such model "gpt" — one of: auto, haiku, sonnet, opus, fable/);
  assert.match(s.sumo(['config', 'chat.model', 'auto']).out, /chat\.model = auto/);
  assert.match(s.sumo(['config', 'chat.model', 'sonnet']).out, /chat\.model = sonnet/);

  const pass = s.sumo(['config', 'scribe.model', 'fable']);
  assert.equal(pass.code, 2);
  assert.match(pass.err, /fable is off — sumo models enable fable/);
  assert.match(s.sumo(['config', 'dream.model', 'gpt']).err, /no such model "gpt" — one of: local, off, haiku, sonnet, opus, fable/);
  assert.match(s.sumo(['config', 'scribe.model', 'off']).out, /scribe\.model = off/);
  assert.match(s.sumo(['config', 'dream.model', 'local']).out, /dream\.model = local/);
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
  assert.match(unchecked.out, /^warn  models checked against the API — run: sumo models discover$/m, unchecked.out);
  assert.match(unchecked.out, /^ok {4}chat\.model is on \(opus\)$/m, unchecked.out);

  s.modelsFound(['haiku', 'sonnet', 'opus']);
  s.sumo(['models', 'discover']);
  const checked = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(checked.code, 0, checked.out);
  assert.match(checked.out, /^ok {4}models on: haiku, sonnet, opus; off: fable$/m, checked.out);
  assert.match(checked.out, /^ok {4}models checked against the API \(\d{4}-\d{2}-\d{2}\)$/m, checked.out);

  s.sumo(['models', 'disable', 'opus']);
  const chatOff = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(chatOff.code, 1);
  assert.match(chatOff.out, /^FAIL {2}chat\.model is on \(opus\) — sumo models enable opus, or sumo config chat\.model <name>$/m, chatOff.out);

  s.sumo(['models', 'disable', 'haiku']);
  s.sumo(['models', 'disable', 'sonnet']);
  const noneOn = s.sumo(['doctor'], { extraEnv: env });
  assert.equal(noneOn.code, 1);
  assert.match(noneOn.out, /^FAIL {2}models on: none; off: haiku, sonnet, opus, fable — sumo models enable <name>$/m, noneOn.out);
});

test('the passes: a writer set to a model that is off fails without calling it; the retry after a failed local call goes to the cheapest model that is on, or nowhere', () => {
  const s = sandbox();
  const ops = [{ op: 'add', type: 'preference', scope: 'global', topic: 'git', body: 'Always squash merge', turn: 1, quote: 'always squash merge' }];
  const keyed = { ANTHROPIC_API_KEY: 'sk-ant-test', STUB_LOCAL_FAILS: '1' };

  s.sumo(['config', 'scribe.model', 'opus']);
  s.sumo(['models', 'disable', 'opus']);
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay(ops);
  const off = s.sumo(['scribe', 'run'], { extraEnv: keyed });
  assert.match(off.out, /^failed — opus is off — sumo models enable opus, or sumo config scribe\.model local/, off.out + off.err);
  assert.deepEqual(s.sql((db) => db.prepare('SELECT model, ok FROM model_runs').all().map((r) => [r.model, r.ok])), [['opus', 0]], 'the refusal is in the ledger, no call was made');

  // Back on the local model, with haiku off: the retry goes to sonnet, the cheapest model that is on.
  s.sumo(['config', 'scribe.model', 'local']);
  s.sumo(['models', 'disable', 'haiku']);
  const retried = s.sumo(['scribe', 'run'], { extraEnv: keyed });
  assert.match(retried.out, /^read 1 turns/, retried.out + retried.err);
  const rows = s.sql((db) => db.prepare('SELECT model, ok, note FROM model_runs ORDER BY id').all());
  assert.deepEqual(rows.slice(1).map((r) => [r.model, r.ok]), [['local', 0], ['sonnet', 1]]);
  assert.match(rows[1].note, /retrying on sonnet/);
  assert.equal(s.modelWasShown().model, 'sonnet');

  // With no API model on there is nothing to retry on: the local failure is the failure.
  s.sumo(['models', 'disable', 'sonnet']);
  s.sumo(['models', 'disable', 'fable']);
  s.hook('prompt', { session_id: 'two', prompt: 'and always rebase first' });
  const alone = s.sumo(['scribe', 'run'], { extraEnv: keyed });
  assert.match(alone.out, /^failed — /, alone.out + alone.err);
  const last = s.sql((db) => db.prepare('SELECT model, ok, note FROM model_runs ORDER BY id DESC LIMIT 1').get());
  assert.equal(last.model, 'local');
  assert.doesNotMatch(last.note, /retrying/);
});

test('a job routed to a model that has since been turned off is not run', () => {
  const s = sandbox();
  s.addProject('demo');
  s.routerWillSay('fable', 'high', 'novel');
  const created = s.sumo(['job', 'new', '--project', 'demo', '--title', 'x'], { input: 'do the thing' });
  assert.equal(created.code, 0, created.err);
  const id = /created j(\d+)/.exec(created.out)[1];
  s.sumo(['models', 'disable', 'fable']);
  const run = s.sumo(['job', 'run', id], { extraEnv: { ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.notEqual(run.code, 0);
  assert.match(run.err, new RegExp(`j${id} is routed to fable, which is off — sumo models enable fable, or abandon it and create it again`), run.out + run.err);
});
