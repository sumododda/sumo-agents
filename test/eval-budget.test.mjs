import assert from 'node:assert/strict';
import { test } from 'node:test';
import { nativeBudgetSend } from '../probes/eval-budget.mjs';
import { FALLBACK_BETA } from '../src/auth.mjs';
import { costOf } from '../src/model.mjs';

const model = 'claude-sonnet-5-5';
const request = { model, messages: [{ role: 'user', content: 'hello' }], max_tokens: 64000 };
const usage = { input_tokens: 10, output_tokens: 20, cache_creation_input_tokens: 100, cache_read_input_tokens: 300 };
const reply = { model, usage, content: [] };
const stub = (overrides) => nativeBudgetSend({ budgetUsd: 0.1, model: 'sonnet', count: async () => 500, transport: async () => reply, ...overrides });

test('admission caps output, pins the route and counts real cache usage without mutating the request', async () => {
  const original = { ...request, fallbacks: 'default', betas: [FALLBACK_BETA], tools: [{ type: 'web_search_20260318', name: 'web_search' }, { type: 'bash_20250124', name: 'bash' }] };
  let sent;
  const send = stub({ transport: async (body, options) => {
    sent = body;
    assert.equal(options.retries, 0);
    return reply;
  } });
  await send(original, { retries: 2 });
  assert.equal(original.tools.length, 2);
  assert.deepEqual(sent.tools, [original.tools[1]]);
  assert.equal(sent.fallbacks, undefined);
  assert.ok(!sent.betas.includes(FALLBACK_BETA));
  assert.equal(sent.model, model);
  assert.ok(sent.max_tokens > 0 && sent.max_tokens < original.max_tokens);
  assert.equal(send.budget().spentUsd, costOf(model, usage));
  assert.equal(send.budget().reservedUsd, 0);
});

test('unpriced requests and insufficient headroom refuse before paid transport', async () => {
  const send = stub({ transport: () => assert.fail('generation must not start') });
  for (const invalid of [
    { model: 'another-route' },
    { cache_control: { type: 'ephemeral', ttl: '1h' } },
    { messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'url', url: 'https://example.invalid/image' } }] }] },
    { tools: [{ type: 'web_search_20260318', name: 'web_search' }], tool_choice: { type: 'tool', name: 'web_search' } },
    { speed: 'fast' },
    { system: 'x'.repeat(110_000) },
  ]) await assert.rejects(send({ ...request, ...invalid }), /budget/i);
  assert.equal(send.budget().requests, 0);
});

test('unconfirmed charges freeze the account and block retries', async () => {
  for (const transport of [async () => { throw new Error('connection lost'); }, async () => ({ model, usage: {} })]) {
    const send = stub({ transport });
    await assert.rejects(send(request), /unknown|unconfirmed/i);
    assert.equal(send.budget().unknownCost, true);
    assert.ok(send.budget().reservedUsd > 0);
    assert.equal(send.budget().spentUsd, 0);
    assert.equal(send.budget().remainingUsd, 0);
    await assert.rejects(send(request));
    assert.equal(send.budget().requests, 1);
  }
});

test('concurrent admission cannot spend the same reservation twice', async () => {
  let entered, release;
  const started = new Promise((resolve) => { entered = resolve; });
  const send = stub({ transport: async () => { entered(); return new Promise((resolve) => { release = resolve; }); } });
  const first = send(request);
  await started;
  await assert.rejects(send(request), /budget/i);
  release(reply);
  await first;
  assert.equal(send.budget().requests, 1);
});

test('the count preflight uses the authenticated model body and never generates on failure', async (t) => {
  // SDK requests are intercepted here; neither the fixture credential nor the prompt leaves the process.
  const before = process.env.ANTHROPIC_API_KEY;
  const found = [];
  process.env.ANTHROPIC_API_KEY = 'sk-ant-oat-fixture';
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    found.push({ path: new URL(url).pathname, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ input_tokens: 500 }), { headers: { 'content-type': 'application/json' } });
  });
  try {
    const send = nativeBudgetSend({ budgetUsd: 1, model, transport: async () => reply });
    await send(request);
    assert.equal(found.length, 1);
    assert.match(found[0].path, /messages\/count_tokens$/);
    assert.equal(found[0].body.model, model);
    assert.match(found[0].body.system[0].text, /Claude Code/);
    assert.equal(found[0].body.max_tokens, undefined);
    assert.equal(found[0].body.service_tier, undefined);
    const fail = stub({ count: async () => { throw new Error('no count'); }, transport: () => assert.fail('no generation') });
    await assert.rejects(fail(request), /no count/);
    assert.equal(fail.budget().requests, 0);
    assert.equal(fail.budget().unknownCost, false);
  } finally {
    if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = before;
  }
});
