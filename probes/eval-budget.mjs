// Native admission for one paired, text-only eval run. Use one instance per task and harness.
// The reserve uses Sumo's rate card and conservative input estimates, not a provider-side billing limit.
// The token-count endpoint is free: https://platform.claude.com/docs/en/build-with-claude/token-counting
import { ADVISOR_BETA } from '../src/advisor.mjs';
import { anthropicClient, authenticatedRequest, FALLBACK_BETA, resolveAnthropicCredential } from '../src/auth.mjs';
import { modelId } from '../src/catalog.mjs';
import { sendToApi } from '../src/loop.mjs';
import { CACHE_WRITE, costOf, priceOf } from '../src/model.mjs';

const localTool = (tool) => !tool.name?.startsWith('mcp__') && (
  tool.type === 'bash_20250124' || tool.type === 'text_editor_20250728' ||
  ((!tool.type || tool.type === 'custom') && tool.input_schema?.type === 'object')
);
const whole = (n) => Number.isSafeInteger(n) && n >= 0;
const refused = (why) => new Error(`native eval budget: ${why}`);

// The count request uses the same OAuth preamble, model, tools and context edits as generation.
// Reject on a count failure: a failed preflight never authorizes a generation.
async function countInput(params, { signal }) {
  const credential = resolveAnthropicCredential();
  if (!credential) throw refused('an Anthropic credential is required');
  const client = anthropicClient({ timeout: 30_000, maxRetries: 0 }, credential);
  const { max_tokens: _limit, service_tier: _tier, ...body } = authenticatedRequest(params, credential);
  return (await client.beta.messages.countTokens(body, { signal })).input_tokens;
}

// The paired fixtures use text, local tools and the normal five-minute cache. Encoded/referenced media
// can expand beyond their serialized size. Hosted tools, additional passes and premium modes need their own pricing.
function localRequest(params) {
  const { fallbacks: _fallbacks, tools = [], betas = [], ...body } = params;
  if (body.compaction || body.context_management?.edits?.some((edit) => !edit.type.startsWith('clear_')) || body.mcp_servers?.length || body.speed === 'fast' || body.container || body.thread || body.inference_geo || body.fallback_credit_token ||
      (body.service_tier && body.service_tier !== 'standard_only')) throw refused('unsupported hosted or premium request');
  const blocks = [...(Array.isArray(body.system) ? body.system : []), ...body.messages.flatMap((m) => Array.isArray(m.content) ? m.content : [])];
  const allowed = new Set(['text', 'thinking', 'redacted_thinking', 'tool_use', 'tool_result']);
  if (blocks.some((b) => !allowed.has(b.type) || (b.type === 'tool_result' && Array.isArray(b.content) && b.content.some((c) => c.type !== 'text')))) {
    throw refused('only text and local tool history can be priced');
  }
  const local = tools.filter(localTool);
  if ((body.tool_choice?.type === 'tool' && !local.some((t) => t.name === body.tool_choice.name)) ||
      (body.tool_choice?.type === 'any' && local.length === 0)) throw refused('the required tool is unavailable in a local eval');
  const cacheControls = [body.cache_control, ...blocks.map((b) => b.cache_control), ...local.map((t) => t.cache_control)];
  if (cacheControls.some((c) => c && (c.type !== 'ephemeral' || (c.ttl && c.ttl !== '5m')))) throw refused('unsupported cache duration');
  return { ...body, service_tier: 'standard_only', tools: local, betas: betas.filter((b) => b !== FALLBACK_BETA && b !== ADVISOR_BETA) };
}

function pricedUsage(response, id) {
  const usage = response?.usage;
  return response?.model === id && (!usage?.service_tier || usage.service_tier === 'standard') && usage?.speed !== 'fast' && whole(usage?.input_tokens) && whole(usage?.output_tokens) &&
    whole(usage.cache_read_input_tokens ?? 0) && whole(usage.cache_creation_input_tokens ?? 0) &&
    !usage.cache_creation?.ephemeral_1h_input_tokens && !Object.values(usage.server_tool_use ?? {}).some(Boolean) &&
    !(usage.iterations ?? []).some((pass) => pass.type !== 'message') &&
    !(response.content ?? []).some((b) => b.type === 'fallback' || b.type === 'server_tool_use');
}

export function nativeBudgetSend({ budgetUsd, model, count = countInput, transport = sendToApi }) {
  const id = modelId(model);
  if (!Number.isFinite(budgetUsd) || budgetUsd <= 0 || !priceOf(id)) throw refused('requires a positive dollar allowance and a priced model');
  let spentUsd = 0;
  let reservedUsd = 0;
  let unknownCost = false;
  let requests = 0;
  const remaining = () => unknownCost ? 0 : Math.max(0, budgetUsd - spentUsd - reservedUsd);

  const send = async (params, options = {}) => {
    if (modelId(params.model) !== id || !whole(params.max_tokens) || !params.max_tokens) throw refused('unexpected model or output limit');
    if (!remaining()) throw refused('no remaining allowance');
    const body = localRequest(params);
    const estimate = await count(body, options);
    if (!whole(estimate)) throw refused('token preflight returned no usable count');
    options.signal?.throwIfAborted();
    // UTF-8 bytes overestimate ordinary text tokenization. Allow room above the provider estimate for tool
    // scaffolding and OAuth overhead as well. Price every input token as a fresh cache write and use the
    // highest input tier this prompt could hit. Metered usage replaces this reservation on success.
    const input = Math.max(Buffer.byteLength(JSON.stringify(body)), Math.ceil(estimate * 1.1)) + 4096;
    const rate = priceOf(id, { input_tokens: input });
    const inputUsd = input * rate.input * CACHE_WRITE / 1_000_000;
    const output = Math.min(body.max_tokens, Math.floor((remaining() - inputUsd) * 1_000_000 / rate.output));
    if (output < 1) throw refused('insufficient allowance for the prompt and a reply');
    const reservation = inputUsd + output * rate.output / 1_000_000;
    reservedUsd += reservation;
    requests++;
    let response;
    try {
      // Do not permit SDK retries to spend the same reservation. A failed generation may have been billed.
      response = await transport({ ...body, max_tokens: output }, { ...options, retries: 0 });
      if (!pricedUsage(response, id)) throw new Error('missing usage, unexpected model or unsupported billing details');
    } catch (cause) {
      unknownCost = true;
      throw refused(`generation cost is unconfirmed; further requests stopped (${cause.message})`);
    }
    reservedUsd = Math.max(0, reservedUsd - reservation);
    spentUsd += costOf(id, response.usage);
    if (spentUsd > budgetUsd) throw refused('reported usage exceeded the allowance; further requests stopped');
    return response;
  };
  send.budget = () => ({ budgetUsd, spentUsd, reservedUsd, remainingUsd: remaining(), unknownCost, requests });
  return send;
}
