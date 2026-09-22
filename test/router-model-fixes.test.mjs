// The j22 review's findings, each as a check: a stale llama-server pin, a missing Content-Length,
// a credential in the source URL, a file name that escapes models/, and the harness skip that said nothing.
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, setMeta } from '../src/db.mjs';
import { callLocalModel } from '../src/model.mjs';
import { paths } from '../src/paths.mjs';
import { CONFIG_DEFAULTS, setup } from '../src/setup.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

function placeModelFile(bytes = 'gguf') {
  mkdirSync(paths().models, { recursive: true });
  const file = join(paths().models, CONFIG_DEFAULTS['model.file']);
  writeFileSync(file, bytes);
  return file;
}

/** A tiny origin that answers HEAD and GET for the model path, counting GETs; `contentLength: false` omits the header. */
function serve({ body = 'gguf', contentLength = true } = {}) {
  const hits = { get: 0 };
  const server = createServer((req, res) => {
    if (req.method === 'GET') hits.get += 1;
    const headers = contentLength ? { 'content-length': String(Buffer.byteLength(body)) } : {};
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) }));
  });
}

test('a pinned llama-server that has since vanished gives ok: false, not a crash', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      placeModelFile();
      setMeta(db, 'llama.path', join(paths().home, 'gone', 'llama-server'));
      const result = await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      assert.equal(result.ok, false);
      assert.match(result.error, /llama-server/);
      assert.match(result.error, /mem setup/);
    } finally {
      db.close();
    }
  });
});

test('setup says so when the harness marker skips the download', async () => {
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: '/nonexistent/stub' }, async () => {
    const lines = await setup({ link: false });
    assert.ok(lines.some((l) => /not downloaded/.test(l) && /SUMO_AGENTS_MODEL_CMD/.test(l)), lines.join('\n'));
  });
});

test('a HEAD without Content-Length keeps a present file instead of downloading it again', async () => {
  const origin = await serve({ contentLength: false });
  try {
    await withHome(freshHome(), {}, async () => {
      placeModelFile('gguf');
      const lines = await setup({ link: false, modelSource: origin.url });
      assert.ok(lines.some((l) => /present/.test(l)), lines.join('\n'));
      assert.equal(origin.hits.get, 0);
    });
  } finally {
    await origin.close();
  }
});

test('a credential in the source URL never reaches the output', async () => {
  const origin = await serve();
  const url = origin.url.replace('http://', 'http://user:s3cret@');
  await origin.close();
  await withHome(freshHome(), {}, async () => {
    const lines = await setup({ link: false, modelSource: url });
    const line = lines.find((l) => /could not download/.test(l));
    assert.ok(line, lines.join('\n'));
    assert.doesNotMatch(line, /s3cret/);
  });
});

test('a model file name with a path separator is refused before any request', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    setMeta(db, 'config.model.file', '../bin/mem');
    db.close();
    const lines = await setup({ link: false, modelSource: 'http://127.0.0.1:9' });
    assert.ok(lines.some((l) => /model\.file/.test(l) && /separator|refused/.test(l)), lines.join('\n'));
  });
});
