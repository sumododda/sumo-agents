// MCP servers set up for a test whole, as the settings page leaves them one at a time.
import { addServer, readConfig, removeServer } from '../../src/mcp.mjs';

/** Keeps these servers (`{ mcpServers: { <name>: spec } }`), and only these, for the home in hand. */
export function writeConfig(config) {
  for (const name of Object.keys(readConfig().mcpServers)) removeServer(name);
  for (const [name, spec] of Object.entries(config?.mcpServers ?? {})) addServer(name, spec);
}
