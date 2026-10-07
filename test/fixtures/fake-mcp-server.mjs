#!/usr/bin/env node
// Stands in for an MCP server on stdio: newline-delimited JSON-RPC in, the same out, logs on stderr.
// Its tools are the shapes a real server answers with — text, an error, a picture, a secret, a flood,
// the environment it was given, a call that never answers, and one that kills the server mid-session.
import { createInterface } from 'node:readline';

const say = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => say({ jsonrpc: '2.0', id, result });
const fail = (id, code, message) => say({ jsonrpc: '2.0', id, error: { code, message } });

const TOOLS = [
  { name: 'echo', description: 'Says the text back. Use it to test the connection.', inputSchema: { type: 'object', properties: { text: { type: 'string', description: 'what to say' } }, required: ['text'] } },
  { name: 'shout', description: 'Always fails, loudly.', inputSchema: { type: 'object', properties: {} } },
  { name: 'picture', description: 'A picture and a caption.', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', properties: {} } },
  { name: 'leak', description: 'Text with a key in it.', inputSchema: { type: 'object', properties: {} } },
  { name: 'flood', description: 'A hundred thousand characters.', inputSchema: { type: 'object', properties: {} } },
  { name: 'env', description: 'The named environment variables, as the server sees them.', inputSchema: { type: 'object', properties: { names: { type: 'array', items: { type: 'string' } } }, required: ['names'] } },
  { name: 'hang', description: 'Never answers.', inputSchema: { type: 'object', properties: {} } },
  { name: 'die', description: 'Kills the server.', inputSchema: { type: 'object', properties: {} } },
  { name: 'structured', description: 'Answers with structured content only.', inputSchema: { type: 'object', properties: {} } },
];
/** The list comes in two pages: a client that stops after the first never sees `env` or the rest. */
const PAGE = 4;

process.stderr.write('fake mcp server starting\n');
createInterface({ input: process.stdin }).on('line', (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch {
    return;
  }
  const { id, method, params = {} } = message;
  if (method === undefined) return; // a response to something this server asked: it asks nothing
  if (id === undefined) return; // a notification
  switch (method) {
    case 'initialize':
      return reply(id, { protocolVersion: params.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } });
    case 'ping':
      return reply(id, {});
    case 'tools/list': {
      const tools = params.cursor === 'page2' ? TOOLS.slice(PAGE) : TOOLS.slice(0, PAGE);
      return reply(id, params.cursor === 'page2' ? { tools } : { tools, nextCursor: 'page2' });
    }
    case 'tools/call': {
      const args = params.arguments ?? {};
      switch (params.name) {
        case 'echo':
          return reply(id, { content: [{ type: 'text', text: `you said: ${args.text}` }] });
        case 'shout':
          return reply(id, { content: [{ type: 'text', text: 'TOO LOUD' }], isError: true });
        case 'picture':
          return reply(id, { content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }, { type: 'text', text: 'a cat' }, { type: 'resource', resource: { uri: 'file:///notes.txt', mimeType: 'text/plain', text: 'notes' } }] });
        case 'leak':
          return reply(id, { content: [{ type: 'text', text: 'the key is sk-ant-api03-abcdefghijklmnopqrstuvwxyz0123456789 and that is all' }] });
        case 'flood':
          return reply(id, { content: [{ type: 'text', text: `S${'x'.repeat(100_000)}E` }] });
        case 'env':
          return reply(id, { content: [{ type: 'text', text: JSON.stringify(Object.fromEntries((args.names ?? []).map((n) => [n, process.env[n] ?? null]))) }] });
        case 'hang':
          return;
        case 'die':
          process.stderr.write('dying as asked\n');
          return process.exit(3);
        case 'structured':
          return reply(id, { content: [], structuredContent: { answer: 42 } });
        default:
          return fail(id, -32602, `Unknown tool: ${params.name}`);
      }
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
});
process.stdin.on('end', () => process.exit(0));
