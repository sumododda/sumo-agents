// The cheap-model call to the Messages API: what is sent, what it costs, and how a short name becomes a model id.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MODEL_IDS, modelId } from '../src/catalog.mjs';
import { costOf, requestFor } from '../src/model.mjs';

test('a short model name becomes the API id, and an id is passed through', () => {
  assert.equal(modelId('haiku'), 'claude-haiku-5-5');
  assert.equal(modelId('opus'), MODEL_IDS.opus);
  assert.equal(modelId('claude-sonnet-5-5'), 'claude-sonnet-5-5');
});

test('the request is the system prompt, one user turn, and the schema the API must answer in', () => {
  const schema = { type: 'object', properties: { ops: { type: 'array', items: { type: 'object', properties: { op: { type: 'string', enum: ['add'] } }, required: ['op'] } } }, required: ['ops'] };
  const request = requestFor({ system: 'You label text.', prompt: '[t1] user: always squash', schema, model: 'haiku' });
  assert.equal(request.model, 'claude-haiku-5-5');
  assert.equal(request.system, 'You label text.');
  assert.deepEqual(request.messages, [{ role: 'user', content: '[t1] user: always squash' }]);
  assert.equal(request.output_config.format.type, 'json_schema');
  assert.deepEqual(request.output_config.format.schema.required, ['ops']);
  assert.equal('tools' in request, false, 'the cheap model gets no tools');
  assert.equal('thinking' in request, false, 'labelling text is not a reasoning task');
});

test('cost follows the price list: cache reads at the discount, cache writes at the premium, unknown models at zero', () => {
  // Haiku has two rate cards: a prompt of 100k tokens or fewer — read from the cache or not — at $0.10, a longer one at $0.50.
  const haiku = costOf('haiku', { input_tokens: 100_000, output_tokens: 0 });
  assert.ok(Math.abs(haiku - 0.01) < 1e-9, `100k tokens in at the small rate, got ${haiku}`);
  assert.ok(Math.abs(costOf('haiku', { input_tokens: 1_000_000, output_tokens: 0 }) - 0.5) < 1e-9, 'a million in at the dearer rate');
  assert.ok(Math.abs(costOf('haiku', { input_tokens: 1, cache_read_input_tokens: 100_000, output_tokens: 1_000_000 }) - (1 * 0.5 + 100_000 * 0.05 + 1_000_000 * 2.5) / 1_000_000) < 1e-9, 'what was read from the cache counts toward the size, and the output is priced on the same card');
  const cached = costOf('haiku', { input_tokens: 0, cache_read_input_tokens: 100_000, output_tokens: 0 });
  assert.ok(Math.abs(cached - 0.001) < 1e-9, `cache read should cost a tenth, got ${cached}`);
  const written = costOf('haiku', { input_tokens: 0, cache_creation_input_tokens: 100_000, output_tokens: 0 });
  assert.ok(Math.abs(written - 0.0125) < 1e-9, `cache write should cost 1.25x, got ${written}`);
  const out = costOf('opus', { input_tokens: 0, output_tokens: 1_000_000 });
  assert.equal(out, 20);
  // Sonnet 5.5 and Opus 5.5 read the cache at a twentieth of input since 2026-10-07; Fable at a fortieth.
  assert.ok(Math.abs(costOf('sonnet', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 }) - 0.1) < 1e-9, 'a sonnet cache read is $0.10 per million');
  assert.ok(Math.abs(costOf('opus', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 }) - 0.2) < 1e-9);
  assert.ok(Math.abs(costOf('fable', { input_tokens: 0, cache_read_input_tokens: 1_000_000, output_tokens: 0 }) - 0.25) < 1e-9);
  assert.equal(costOf('local:qwen', { input_tokens: 5000, output_tokens: 50 }), 0);
  assert.equal(costOf('haiku', { input_tokens: 0, output_tokens: 0, server_tool_use: { web_search_requests: 3, web_fetch_requests: 5 } }), 0.03, 'a search is a cent on top of its tokens; a fetch is its tokens');
});

test('the schema reaches the API as it was written: an enum stays an enum the API holds the answer to', () => {
  const schema = { type: 'object', additionalProperties: false, properties: { op: { type: 'string', enum: ['add', 'drop'] } }, required: ['op'] };
  const sent = requestFor({ system: 'You label text.', prompt: 'p', schema, model: 'haiku' }).output_config.format.schema;
  assert.deepEqual(sent, schema);
});
