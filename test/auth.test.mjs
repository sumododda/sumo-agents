// Anthropic credentials: API keys keep their normal path; Claude Code tokens get the OAuth request shape the API requires.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anthropicClientOptions, authenticatedRequest, resolveAnthropicCredential } from '../src/auth.mjs';

test('an API key stays an API key and wins when both credential kinds are present', () => {
  const credential = resolveAnthropicCredential({ ANTHROPIC_API_KEY: 'sk-ant-api-test', CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-test' });
  assert.deepEqual(credential, { type: 'api_key', token: 'sk-ant-api-test', source: 'ANTHROPIC_API_KEY' });
  assert.deepEqual(anthropicClientOptions(123, credential), { timeout: 123, apiKey: 'sk-ant-api-test', authToken: null });
});

test('a Claude Code token works in its named variable or when it was put in ANTHROPIC_API_KEY', () => {
  const named = resolveAnthropicCredential({ CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-named' });
  const misplaced = resolveAnthropicCredential({ ANTHROPIC_API_KEY: 'sk-ant-oat-misplaced' });
  assert.deepEqual(named, { type: 'oauth', token: 'sk-ant-oat-named', source: 'CLAUDE_CODE_OAUTH_TOKEN' });
  assert.deepEqual(misplaced, { type: 'oauth', token: 'sk-ant-oat-misplaced', source: 'ANTHROPIC_API_KEY' });

  const options = anthropicClientOptions(123, named);
  assert.equal(options.apiKey, null);
  assert.equal(options.authToken, 'sk-ant-oat-named');
  assert.equal(options.defaultHeaders['x-app'], 'cli');
  assert.match(options.defaultHeaders['user-agent'], /^claude-cli\//);
});

test('an OAuth request carries the two auth betas and Claude Code identity before the caller system prompt', () => {
  const original = {
    model: 'claude-haiku-4-5-20251001',
    betas: ['context-management-2025-06-27'],
    system: [{ type: 'text', text: 'Sumo rules', cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: 'hello' }],
  };
  const request = authenticatedRequest(original, { type: 'oauth', token: 'sk-ant-oat-test', source: 'CLAUDE_CODE_OAUTH_TOKEN' });

  assert.deepEqual(request.betas, ['claude-code-20250219', 'oauth-2025-04-20', 'context-management-2025-06-27']);
  assert.equal(request.system[0].text, "You are Claude Code, Anthropic's official CLI for Claude.");
  assert.deepEqual(request.system[1], original.system[0]);
  assert.deepEqual(original.system, [{ type: 'text', text: 'Sumo rules', cache_control: { type: 'ephemeral' } }], 'the reusable request is not mutated');
});

test('API-key requests retain their exact body', () => {
  const original = { model: 'claude-haiku-4-5-20251001', system: 'rules', messages: [{ role: 'user', content: 'hello' }] };
  const request = authenticatedRequest(original, { type: 'api_key', token: 'sk-ant-api-test', source: 'ANTHROPIC_API_KEY' });
  assert.equal(request, original);
});
