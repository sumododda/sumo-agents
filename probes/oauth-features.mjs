#!/usr/bin/env node
// A live measurement, not a test: which of the API features sumo uses on an API key also work on a Claude Code login
// (CLAUDE_CODE_OAUTH_TOKEN), where `authenticatedRequest` strips the ones it could not check. Four tiny requests, about
// a cent in all. Each says ok or the API's own refusal, so the stripping can follow what is true.
//   set -a; source ~/.sumo-agents/eval.env; set +a; node probes/oauth-features.mjs
import { fileURLToPath } from 'node:url';
import { anthropicClient, authenticatedRequest, EFFORT_MESSAGE_BETA, FALLBACK_BETA, loadSdk, resolveAnthropicCredential } from '../src/auth.mjs';
import { MODEL_IDS } from '../src/catalog.mjs';

const SAY_OK = [{ role: 'user', content: 'Reply with the single word: ok' }];

/** A request framed as sumo frames one for a Claude Code login, with one feature put back that the framing would strip. */
function framed(credential, params, { betas = [], fallbacks, effortMessage } = {}) {
  const shaped = authenticatedRequest(params, credential);
  return {
    ...shaped,
    betas: [...shaped.betas, ...betas],
    ...(fallbacks ? { fallbacks } : {}),
    ...(effortMessage ? { messages: [...shaped.messages, { role: 'system', content: [], output_config: { effort: effortMessage } }] } : {}),
  };
}

export const CASES = [
  { name: 'a plain request through SDK 1.x', model: 'sonnet', build: (c) => framed(c, { model: MODEL_IDS.sonnet, max_tokens: 256, messages: SAY_OK }) },
  { name: 'fallbacks: "default" on a refusal', model: 'sonnet', build: (c) => framed(c, { model: MODEL_IDS.sonnet, max_tokens: 256, messages: SAY_OK }, { betas: [FALLBACK_BETA], fallbacks: 'default' }) },
  { name: 'effort changed by a message', model: 'sonnet', build: (c) => framed(c, { model: MODEL_IDS.sonnet, max_tokens: 256, messages: SAY_OK }, { betas: [EFFORT_MESSAGE_BETA], effortMessage: 'low' }) },
  {
    name: 'structured output without the old beta',
    model: 'haiku',
    build: (c) => {
      const shaped = framed(c, { model: MODEL_IDS.haiku, max_tokens: 256, messages: SAY_OK, output_config: { format: { type: 'json_schema', schema: { type: 'object', properties: { word: { type: 'string' } }, required: ['word'], additionalProperties: false } } } });
      return { ...shaped, betas: shaped.betas.filter((b) => !b.startsWith('structured-outputs')) };
    },
  },
];

async function main() {
  const credential = resolveAnthropicCredential();
  if (credential?.type !== 'oauth') throw new Error('this probe is for a Claude Code login: CLAUDE_CODE_OAUTH_TOKEN in the environment');
  await loadSdk();
  const client = anthropicClient({ timeout: 60_000, maxRetries: 0 }, credential);
  let failed = 0;
  for (const c of CASES) {
    try {
      const reply = await client.beta.messages.create(c.build(credential));
      const text = reply.content.filter((b) => b.type === 'text').map((b) => b.text).join(' ').trim();
      console.log(`ok    ${c.name} — ${reply.model}, stop ${reply.stop_reason}${text ? `: ${text.slice(0, 40)}` : ''}`);
    } catch (cause) {
      failed++;
      console.log(`FAIL  ${c.name} — ${cause.status ?? ''} ${String(cause.error?.error?.message ?? cause.message).slice(0, 200)}`);
    }
  }
  return failed === 0 ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(
    (code) => process.exit(code),
    (cause) => {
      console.error(`oauth features: ${cause.message}`);
      process.exit(2);
    },
  );
}
