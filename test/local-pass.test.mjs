// The memory passes run on the local model by default, and only reach for Haiku when the local answer failed
// and a credential is there to pay for it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sandbox } from './helpers.mjs';

const NO_KEY = { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' };

test('by default the writer asks the local model, thinking on, and the ledger says so', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'scribe.model']).out, /scribe\.model = local/);
  assert.match(s.sumo(['config', 'dream.model']).out, /dream\.model = local/);

  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', topic: 'git', body: 'Always squash merge', turn: 1, quote: 'always squash merge' }]);
  const run = s.sumo(['scribe', 'run'], { extraEnv: NO_KEY });
  assert.match(run.out, /^read 1 turns/, run.out + run.err);

  const shown = s.modelWasShown();
  assert.equal(shown.model, 'local');
  assert.equal(shown.kind, 'scribe');
  assert.equal(shown.think, true);
  const rows = s.sql((db) => db.prepare('SELECT kind, model, ok FROM model_runs ORDER BY id').all().map((r) => ({ ...r })));
  assert.deepEqual(rows, [{ kind: 'scribe', model: 'local', ok: 1 }]);
  assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM memories WHERE body = 'Always squash merge'`).get().n), 1);
  assert.match(s.sumo(['scribe', 'status']).out, /^model: local/m);
});

test('when the local model fails and a credential is set, the pass is retried on haiku and both calls are in the ledger', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay([{ op: 'add', type: 'preference', scope: 'global', topic: 'git', body: 'Always squash merge', turn: 1, quote: 'always squash merge' }]);
  const run = s.sumo(['scribe', 'run'], { extraEnv: { ...NO_KEY, ANTHROPIC_API_KEY: 'sk-ant-test', STUB_LOCAL_FAILS: '1' } });
  assert.match(run.out, /^read 1 turns/, run.out + run.err);

  const rows = s.sql((db) => db.prepare('SELECT kind, model, ok, note FROM model_runs ORDER BY id').all());
  assert.equal(rows.length, 2);
  assert.deepEqual([rows[0].kind, rows[0].model, rows[0].ok], ['scribe', 'local', 0]);
  assert.match(rows[0].note, /haiku/);
  assert.deepEqual([rows[1].kind, rows[1].model, rows[1].ok], ['scribe', 'haiku', 1]);
  assert.equal(s.modelWasShown().model, 'haiku');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns WHERE scribed = 0').get().n), 0);
});

test('without a credential a failed local call is the failure: nothing is filed, the turns wait, status says why', () => {
  const s = sandbox();
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay([]);
  const run = s.sumo(['scribe', 'run'], { extraEnv: { ...NO_KEY, STUB_LOCAL_FAILS: '1' } });
  assert.match(run.out, /^failed — /, run.out + run.err);
  assert.doesNotMatch(run.out, /haiku/);

  const rows = s.sql((db) => db.prepare('SELECT kind, model, ok FROM model_runs ORDER BY id').all().map((r) => ({ ...r })));
  assert.deepEqual(rows, [{ kind: 'scribe', model: 'local', ok: 0 }]);
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM user_turns WHERE scribed = 0').get().n), 1);
  assert.match(s.sumo(['scribe', 'status'], { extraEnv: NO_KEY }).out, /failing: 1 in a row/);
});

test('a writer set to haiku still goes straight to the API model, as before', () => {
  const s = sandbox();
  s.sumo(['config', 'scribe.model', 'haiku']);
  s.hook('prompt', { session_id: 'one', prompt: 'from now on always squash merge' });
  s.modelWillSay([]);
  assert.match(s.sumo(['scribe', 'run']).out, /^read 1 turns/);
  assert.equal(s.modelWasShown().model, 'haiku');
  assert.deepEqual(s.sql((db) => db.prepare('SELECT model FROM model_runs').all().map((r) => r.model)), ['haiku']);
});
