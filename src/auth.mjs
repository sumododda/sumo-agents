/**
 * The SDK, loaded the first time a request is to be made, not when this module is: it is a third of every command's
 * start, and most commands — a hook on every prompt, a search, the memory status — never call the API. The same ES
 * module the rest of the process imports, so its error classes are the ones `instanceof` is checked against.
 */
let sdk = null;
export async function loadSdk() {
  sdk ??= (await import('@anthropic-ai/sdk')).default;
  return sdk;
}
/** The SDK if a request has loaded it, else null — and with no SDK loaded, no error can be one of its. */
export const loadedSdk = () => sdk;

/** The request identity Anthropic requires when a Claude Code OAuth token calls the Messages API directly. */
const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
const CLAUDE_CODE_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];
/**
 * The beta a request's server-side fallback is under: a reply the safety classifiers declined is run again on the model
 * Anthropic names for the category, in the same call. Sent with an API key; dropped on the OAuth path, which is not known
 * to take it, and where one unknown beta would refuse every request.
 */
export const FALLBACK_BETA = 'server-side-fallback-2026-07-01';
/** The beta an effort said in the conversation is under — a system message with no content and an `output_config`; dropped on the OAuth path as the fallback is. */
export const EFFORT_MESSAGE_BETA = 'mid-conversation-output-config-2026-07-01';
/** Whether a message is an effort said in the conversation: a system message with no content, carrying only the effort. */
export const effortOnly = (m) => m.role === 'system' && Array.isArray(m.content) && m.content.length === 0 && m.output_config?.effort !== undefined;

// Pin the protocol version so authentication does not depend on a local Claude installation.
const CLAUDE_CODE_VERSION = '2.1.280';

/** The names a credential is read from — and the only names a command run for the model goes without. */
export const CREDENTIAL_NAMES = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_AUTH_TOKEN'];

/** Resolve one credential without ever copying it into a child process or output. API keys keep their documented precedence. */
export function resolveAnthropicCredential(env = process.env) {
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    return apiKey.startsWith('sk-ant-oat')
      ? { type: 'oauth', token: apiKey, source: 'ANTHROPIC_API_KEY' }
      : { type: 'api_key', token: apiKey, source: 'ANTHROPIC_API_KEY' };
  }

  const oauth = env.CLAUDE_CODE_OAUTH_TOKEN?.trim();
  if (oauth) return { type: 'oauth', token: oauth, source: 'CLAUDE_CODE_OAUTH_TOKEN' };

  const bearer = env.ANTHROPIC_AUTH_TOKEN?.trim();
  if (bearer) return { type: 'bearer', token: bearer, source: 'ANTHROPIC_AUTH_TOKEN' };
  return null;
}

/**
 * One client per credential and per way of calling: the SDK keeps a connection pool, its retry state and its logger on the
 * client, so a request made on a fresh one every time opens a new connection every time. A credential that changes — the
 * shell exported another — gets a client of its own; the old one is simply not asked again.
 */
const clients = new Map();
/** A client for the credential; the SDK is loaded first (`await loadSdk()`), by whoever is about to make the request. */
export function anthropicClient({ timeout, maxRetries = undefined } = {}, credential = resolveAnthropicCredential(), env = process.env) {
  if (!sdk) throw new Error('the Anthropic SDK is not loaded yet: await loadSdk() before asking for a client');
  // The base URL is read from the shell when a client is made: one made for another is not this one.
  const key = JSON.stringify([credential?.type ?? null, credential?.token ?? null, timeout ?? null, maxRetries ?? null, env.ANTHROPIC_BASE_URL ?? null]);
  let client = clients.get(key);
  if (!client) {
    client = new sdk({ ...anthropicClientOptions(timeout, credential), ...(maxRetries === undefined ? {} : { maxRetries }) });
    clients.set(key, client);
  }
  return client;
}

/** Anthropic SDK constructor options for an API key, generic bearer token, or Claude Code OAuth token. */
export function anthropicClientOptions(timeout, credential = resolveAnthropicCredential()) {
  if (credential?.type === 'oauth') {
    return {
      timeout,
      apiKey: null,
      authToken: credential.token,
      defaultHeaders: {
        accept: 'application/json',
        'anthropic-dangerous-direct-browser-access': 'true',
        'user-agent': `claude-cli/${CLAUDE_CODE_VERSION}`,
        'x-app': 'cli',
      },
    };
  }
  if (credential?.type === 'bearer') return { timeout, apiKey: null, authToken: credential.token };
  if (credential?.type === 'api_key') return { timeout, apiKey: credential.token, authToken: null };
  return { timeout };
}

/**
 * Add the OAuth protocol fields — Claude Code's betas and its system line first — without mutating the conversation
 * state reused on later turns. Nothing else changes: the fallback, an effort said by a message and structured output
 * are taken on that path as on an API key (probes/oauth-features.mjs, measured Oct 28 2026).
 */
export function authenticatedRequest(params, credential = resolveAnthropicCredential()) {
  if (credential?.type !== 'oauth') return params;
  const system = Array.isArray(params.system)
    ? params.system
    : typeof params.system === 'string' && params.system
      ? [{ type: 'text', text: params.system }]
      : [];
  return {
    ...params,
    betas: [...new Set([...CLAUDE_CODE_BETAS, ...(params.betas ?? [])])],
    system: [{ type: 'text', text: CLAUDE_CODE_SYSTEM }, ...system],
  };
}
