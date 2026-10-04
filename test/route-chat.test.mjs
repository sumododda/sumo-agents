// The chat's route on auto: the local router reads the turn and names a model and effort, like it does a job.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { chooseChatRoute } from '../src/route.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const answer = (file, data) => writeFileSync(file, JSON.stringify({ is_error: false, result: '', structured_output: data, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));

test('the chat router is shown the project and the turn, answers a route, and a bad or missing answer is an error', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-route-chat-'));
  const routerAnswer = join(root, 'router-answer.json');
  const routerSaw = join(root, 'router-saw.json');
  const env = { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer, STUB_CAPTURE: routerSaw };
  await withHome(freshHome(), env, async () => {
    const db = openDb();
    try {
      const { project } = addProject(db, root, { slug: 'simba', now: '2026-09-30T12:00:00.000Z' });

      answer(routerAnswer, { kind: 'routine', surface: 'a few files', risky: false, model: 'sonnet', effort: 'medium', reason: 'an ordinary fix  with a clear spec' });
      assert.deepEqual(await chooseChatRoute(db, { project, text: 'fix the date parser in the importer' }), { model: 'sonnet', effort: 'medium', reason: 'an ordinary fix with a clear spec' });
      const saw = JSON.parse(readFileSync(routerSaw, 'utf8'));
      assert.equal(saw.model, 'local');
      assert.match(saw.system, /chat turn/);
      assert.match(saw.prompt, /project: simba/);
      assert.match(saw.prompt, /fix the date parser in the importer/);

      // No project: the turn alone.
      assert.deepEqual(await chooseChatRoute(db, { project: null, text: 'what does this repo do?' }), { model: 'sonnet', effort: 'medium', reason: 'an ordinary fix with a clear spec' });
      assert.match(JSON.parse(readFileSync(routerSaw, 'utf8')).prompt, /project: none/);

      answer(routerAnswer, { kind: 'mechanical', surface: 'one spot', risky: false, model: 'haiku', effort: 'none', reason: 'a typo' });
      assert.deepEqual(await chooseChatRoute(db, { project, text: 'typo in the readme' }), { model: 'haiku', effort: 'none', reason: 'a typo' });

      answer(routerAnswer, { model: 'haiku', effort: 'high', reason: 'off the grammar' });
      await assert.rejects(chooseChatRoute(db, { project, text: 'x' }), /the router failed: the router answered outside its schema/);

      rmSync(routerAnswer, { force: true });
      await assert.rejects(chooseChatRoute(db, { project, text: 'x' }), /the router failed: .*no router answer recorded/);
    } finally {
      db.close();
    }
  });
});
