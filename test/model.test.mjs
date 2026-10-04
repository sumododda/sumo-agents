import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { callLocalModel, callModel, requestFor } from '../src/model.mjs';
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

test('callLocalModel with no model file returns ok: false and names sumo setup, without throwing', async () => {
  // No SUMO_AGENTS_MODEL_CMD here: this exercises the real path, up to the point it finds nothing to run.
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const result = await callLocalModel(db, { system: 'sys prompt', prompt: 'hi', schema: { type: 'object' } });
      assert.equal(result.ok, false);
      assert.match(result.error, /sumo setup/);

      const row = db.prepare('SELECT * FROM model_runs ORDER BY id DESC LIMIT 1').get();
      assert.equal(row.kind, 'local');
      assert.equal(row.ok, 0);
    } finally {
      db.close();
    }
  });
});

test('a cheap-model call leaves room for the thinking every model but haiku now does, and stays a request the SDK sends without streaming', () => {
  const request = requestFor({ system: 'You label text.', prompt: 'p', schema: { type: 'object' }, model: 'sonnet' });
  assert.ok(request.max_tokens >= 8192, `thinking counts toward the limit: ${request.max_tokens} leaves too little for it and the answer`);
  // The SDK refuses a request that does not stream once its limit implies more than ten minutes at its own pace: 128,000 tokens an hour.
  assert.ok(request.max_tokens <= Math.floor(128_000 / 6), `${request.max_tokens} would have to stream`);
});

test('a cheap-model answer cut off or refused is said as such, and what it spent still comes back', async () => {
  let answer;
  let seen;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      seen = { url: req.url, beta: req.headers['anthropic-beta'] ?? '', body: JSON.parse(body) };
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: 'msg_1', type: 'message', role: 'assistant', model: 'claude-haiku-4-5-20251001', stop_details: null, ...answer }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const standIn = process.env.SUMO_AGENTS_MODEL_CMD;
  delete process.env.SUMO_AGENTS_MODEL_CMD;
  try {
    await withHome(freshHome(), { ANTHROPIC_BASE_URL: `http://127.0.0.1:${server.address().port}`, ANTHROPIC_API_KEY: 'sk-ant-test' }, async () => {
      const db = openDb();
      try {
        const ask = () => callModel(db, { system: 's', prompt: 'p', schema: { type: 'object', properties: { ops: { type: 'array' } } }, model: 'haiku' });

        answer = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ops": [{"op": "add", "text": "half a' }], usage: { input_tokens: 1000, output_tokens: 8192 } };
        const cut = await ask();
        assert.equal(cut.ok, false);
        assert.match(cut.error, /cut off at 8192 tokens/);
        assert.equal(cut.usage.outputTokens, 8192, 'the tokens a cut-off answer spent are still counted');
        assert.ok(cut.usage.costUsd > 0);

        answer = { stop_reason: 'refusal', stop_details: { type: 'refusal', category: 'cyber', explanation: null }, content: [{ type: 'text', text: 'I can' }], usage: { input_tokens: 1000, output_tokens: 3 } };
        const refused = await ask();
        assert.equal(refused.ok, false);
        assert.match(refused.error, /declined to answer \(cyber\)/);
        assert.equal(refused.usage.inputTokens, 1000);

        answer = { stop_reason: 'end_turn', content: [{ type: 'text', text: 'not json' }], usage: { input_tokens: 1000, output_tokens: 5 } };
        const garbled = await ask();
        assert.equal(garbled.ok, false);
        assert.equal(garbled.error, 'the answer was not the JSON that was asked for');
        assert.equal(garbled.usage.outputTokens, 5);

        answer = { stop_reason: 'end_turn', content: [{ type: 'text', text: '{"ops": []}' }], usage: { input_tokens: 1000, output_tokens: 5 } };
        const fine = await ask();
        assert.equal(fine.ok, true, fine.error ?? '');
        assert.deepEqual(fine.data, { ops: [] });
        assert.equal(seen.body.output_config.format.type, 'json_schema');

        // A Claude Code token goes through the beta API, with the structured-outputs beta parse() used to send.
        process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-test';
        answer = { stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"ops": [' }], usage: { input_tokens: 10, output_tokens: 8192 } };
        assert.match((await ask()).error, /cut off/);
        assert.match(seen.url, /beta=true/);
        assert.match(seen.beta, /structured-outputs-2025-12-15/);
        assert.match(seen.beta, /oauth-2025-04-20/);
      } finally {
        db.close();
      }
    });
  } finally {
    if (standIn !== undefined) process.env.SUMO_AGENTS_MODEL_CMD = standIn;
    server.close();
  }
});
