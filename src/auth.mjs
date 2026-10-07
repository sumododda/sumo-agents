import Anthropic from '@anthropic-ai/sdk';

/** The request identity Anthropic requires when a Claude Code OAuth token calls the Messages API directly. */
export const CLAUDE_CODE_SYSTEM = "You are Claude Code, Anthropic's official CLI for Claude.";
export const CLAUDE_CODE_BETAS = ['claude-code-20250219', 'oauth-2025-04-20'];

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
export function anthropicClient({ timeout, maxRetries = undefined } = {}, credential = resolveAnthropicCredential(), env = process.env) {
  // The base URL is read from the shell when a client is made: one made for another is not this one.
  const key = JSON.stringify([credential?.type ?? null, credential?.token ?? null, timeout ?? null, maxRetries ?? null, env.ANTHROPIC_BASE_URL ?? null]);
  let client = clients.get(key);
  if (!client) {
    client = new Anthropic({ ...anthropicClientOptions(timeout, credential), ...(maxRetries === undefined ? {} : { maxRetries }) });
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

/** Add the OAuth protocol fields without mutating the conversation state reused on later turns. */
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
