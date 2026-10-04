#!/usr/bin/env node
// Stands in for llama-server in router mode: answers /health, lists the GGUF files in --models-dir as
// models, and answers /v1/chat/completions with a recorded answer while recording what it was asked.
//   FAKE_LLAMA_LOG      where argv and pid are written when it starts
//   FAKE_LLAMA_CAPTURE  where the last completion request body is written
//   FAKE_LLAMA_ANSWER   a file holding the JSON the model "says"; absent → {"ok":true}
//   FAKE_LLAMA_CTX      pretend context size in characters: a longer prompt gets llama-server's 400
// It exits by itself after 30 s without a request, so a test that forgets it leaks nothing.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { basename } from 'node:path';

const args = process.argv.slice(2);
const arg = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const port = Number(arg('--port'));
const modelsDir = arg('--models-dir');
const models = () => (modelsDir && existsSync(modelsDir) ? readdirSync(modelsDir).filter((f) => f.endsWith('.gguf')).map((f) => basename(f, '.gguf')) : []);

if (process.env.FAKE_LLAMA_LOG) writeFileSync(process.env.FAKE_LLAMA_LOG, JSON.stringify({ pid: process.pid, args }));

let idle = setTimeout(() => process.exit(0), 30_000);
const server = createServer((req, res) => {
  clearTimeout(idle);
  idle = setTimeout(() => process.exit(0), 30_000);
  const send = (status, body) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  if (req.url === '/health') return send(200, { status: 'ok' });
  if (req.url === '/v1/models') return send(200, { data: models().map((id) => ({ id, status: { value: 'loaded' } })) });
  if (req.url !== '/v1/chat/completions' || req.method !== 'POST') return send(404, { error: { message: 'not found' } });
  let raw = '';
  req.on('data', (chunk) => { raw += chunk; });
  req.on('end', () => {
    const body = JSON.parse(raw);
    if (process.env.FAKE_LLAMA_CAPTURE) writeFileSync(process.env.FAKE_LLAMA_CAPTURE, raw);
    if (!models().includes(body.model)) return send(400, { error: { code: 400, message: `model '${body.model}' not found`, type: 'invalid_request_error' } });
    const chars = body.messages.reduce((n, m) => n + m.content.length, 0);
    const ctx = Number(process.env.FAKE_LLAMA_CTX ?? 0);
    if (ctx > 0 && chars > ctx) {
      return send(400, { error: { code: 400, message: `request (${chars} tokens) exceeds the available context size (${ctx} tokens), try increasing it`, type: 'exceed_context_size_error', n_prompt_tokens: chars, n_ctx: ctx } });
    }
    const content = process.env.FAKE_LLAMA_ANSWER && existsSync(process.env.FAKE_LLAMA_ANSWER) ? readFileSync(process.env.FAKE_LLAMA_ANSWER, 'utf8') : '{"ok":true}';
    send(200, {
      choices: [{ message: { role: 'assistant', content, reasoning_content: body.chat_template_kwargs?.enable_thinking ? 'thought about it' : undefined }, finish_reason: 'stop' }],
      usage: { prompt_tokens: Math.ceil(chars / 4), completion_tokens: Math.ceil(content.length / 4) },
    });
  });
});
server.listen(port, '127.0.0.1');
