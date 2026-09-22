import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { callLocalModel } from '../src/model.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

test('callLocalModel through the stand-in returns its JSON and logs a model_runs row', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-model-standin-'));
  const answerFile = join(root, 'answer.json');
  const captureFile = join(root, 'saw.json');
  writeFileSync(
    answerFile,
    JSON.stringify({
      is_error: false,
      result: '',
      structured_output: { pick: 'haiku' },
      usage: { input_tokens: 50, output_tokens: 12 },
      total_cost_usd: 0,
    }),
  );

  await withHome(
    freshHome(),
    {
      SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'),
      STUB_ANSWER: answerFile,
      STUB_CAPTURE: captureFile,
    },
    async () => {
      const db = openDb();
      try {
        const result = await callLocalModel(db, { system: 'sys prompt', prompt: 'hi', schema: { type: 'object' } });
        assert.equal(result.ok, true, result.error ?? '');
        assert.deepEqual(result.data, { pick: 'haiku' });
        assert.equal(result.usage.inputTokens, 50);
        assert.equal(result.usage.outputTokens, 12);

        const row = db.prepare('SELECT * FROM model_runs ORDER BY id DESC LIMIT 1').get();
        assert.equal(row.kind, 'local');
        assert.match(row.model, /^local:/);
        assert.equal(row.ok, 1);

        // The stand-in got exactly what a real llama-server call would have sent it.
        const shown = JSON.parse(readFileSync(captureFile, 'utf8'));
        assert.equal(shown.model, 'local');
        assert.equal(shown.system, 'sys prompt');
        assert.equal(shown.prompt, 'hi');
      } finally {
        db.close();
      }
    },
  );
});

test('callLocalModel with no model file returns ok: false and names mem setup, without throwing', async () => {
  // No SUMO_AGENTS_MODEL_CMD here: this exercises the real path, up to the point it finds nothing to run.
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const result = await callLocalModel(db, { system: 'sys prompt', prompt: 'hi', schema: { type: 'object' } });
      assert.equal(result.ok, false);
      assert.match(result.error, /mem setup/);

      const row = db.prepare('SELECT * FROM model_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(row.kind, 'local');
      assert.equal(row.ok, 0);
    } finally {
      db.close();
    }
  });
});
