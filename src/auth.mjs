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
