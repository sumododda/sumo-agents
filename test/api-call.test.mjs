// The cheap-model call to the Messages API: what is sent, what it costs, and how a short name becomes a model id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { costOf, MODEL_IDS, modelId, requestFor } from '../src/model.mjs';

test('a short model name becomes the API id, and an id is passed through', () => {
  assert.equal(modelId('haiku'), 'claude-haiku-4-5-20251001');
  assert.equal(modelId('opus'), MODEL_IDS.opus);
  assert.equal(modelId('claude-sonnet-5-5'), 'claude-sonnet-5-5');
});

test('the request is the system prompt, one user turn, and the schema the API must answer in', () => {
  const schema = { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add'] } }, required: ['op'] } } }, required: ['ops'] };
  const request = requestFor({ system: 'You label text.', prompt: '[t1] user: always squash', schema, model: 'haiku' });
  assert.equal(request.model, 'claude-haiku-4-5-20251001');
  assert.equal(request.system, 'You label text.');
  assert.deepEqual(request.messages, [{ role: 'user', content: '[t1] user: always squash' }]);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(request.output_config.format.schema.required, ['ops']);
  assert.equal('tools' in request, false, 'the cheap model gets no tools');
  assert.equal('thinking' in request, false, 'labelling text is not a reasoning task');
});

test('cost follows the price list: cache reads at the discount, cache writes at the premium, unknown models at zero', () => {
  const haiku = costOf('haiku', { input_tokens: 1_000_000, output_tokens: 0 });
  assert.equal(haiku, 1);
  const cached = costOf('haiku', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(cached - 0.1) < 1e-9, `cache read should cost a tenth, got ${cached}`);
  const written = costOf('haiku', { input_tokens: 0, cache_creation_input_tokens: 1_000_000, output_tokens: 0 });
  assert.ok(Math.abs(written - 1.25) < 1e-9, `cache write should cost 1.25x, got ${written}`);
  const out = costOf('opus', { input_tokens: 0, output_tokens: 1_000_000 });
  assert.equal(out, 20);
  assert.equal(costOf('local:qwen', { input_tokens: 5000, output_tokens: 50 }), 0);
});
