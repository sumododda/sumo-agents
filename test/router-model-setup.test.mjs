import assert from 'node:assert/strict';
import { existsSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { test } from 'node:test';
import { getMeta, openDb } from '../src/db.mjs';
import { fetchModel, setup } from '../src/setup.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';
import { sandbox } from './helpers.mjs';

const MODEL_PATH = '/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf';

/** Serves `body` at the router model's default resolve path, on a random free port. */
function modelServer(body) {
  const server = createServer((req, res) => {
    if (req.url !== MODEL_PATH) {
      res.writeHead(404);
      res.end();
      return;
    }
    res.writeHead(200, { 'content-length': String(body.length) });
    res.end(req.method === 'HEAD' ? undefined : body);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

test('config lists the router model\'s address, with its default', () => {
  const s = sandbox();
  const out = s.sumo(['config']).out;
  assert.match(out, /^model\.url = https:\/\/huggingface\.co\/Qwen\/Qwen3-4B-GGUF\/resolve\/main\/Qwen3-4B-Q4_K_M\.gguf$/m);
});

test('setup downloads the router model, skips it once present, and survives a download that fails', async () => {
  const body = Buffer.from('a stand-in for a gguf file, just big enough to have a size');
  const server = await modelServer(body);
  const port = server.address().port;
  const home = freshHome();

  await withHome(home, {}, async () => {
    const first = await setup({ modelSource: `http://127.0.0.1:${port}`, link: false });
    const modelPath = join(home, 'models', 'Qwen3-4B-Q4_K_M.gguf');
    assert.equal(existsSync(modelPath), true);
    assert.equal(statSync(modelPath).size, body.length);
    assert.match(first.join('\n'), /model {5}.*\(.*downloaded\)/);

    const second = await setup({ modelSource: `http://127.0.0.1:${port}`, link: false });
    assert.match(second.join('\n'), /model {5}.*\(.*present\)/);
  });

  await new Promise((resolve) => server.close(resolve));

  // Nothing is listening on this port once the server above is closed: the download fails,
  // and setup must say so as a line rather than throw.
  await withHome(freshHome(), {}, async () => {
    const lines = await setup({ modelSource: `http://127.0.0.1:${port}`, link: false });
    assert.equal(lines.some((l) => /could not download the router model/.test(l)), true, lines.join('\n'));
  });
});

test('a local model set on the page is downloaded first and only then made the one in use; one that does not come leaves the one in use', async () => {
  const body = Buffer.from('another stand-in gguf');
  const server = await modelServer(body);
  const at = `http://127.0.0.1:${server.address().port}`;
  const home = freshHome();
  try {
    await withHome(home, {}, async () => {
      mkdirSync(join(home, 'models'), { recursive: true });
      writeFileSync(join(home, 'models', 'Qwen3-4B-Q4_K_M.gguf'), 'the model in use');
      const stored = () => {
        const db = openDb();
        try {
          return getMeta(db, 'config.model.url');
        } finally {
          db.close();
        }
      };
      const missing = await fetchModel(`${at}/elsewhere/Other-8B.gguf`);
      assert.equal(missing.ok, false);
      assert.match(missing.line, /could not download the router model/);
      assert.equal(stored(), null, 'nothing stored: the model in use is still the one in use');
      const got = await fetchModel(`${at}${MODEL_PATH}`);
      assert.equal(got.ok, true, got.line);
      assert.equal(stored(), `${at}${MODEL_PATH}`, 'stored once it is here');
      await assert.rejects(() => fetchModel('ftp://example.com/x.gguf'), /is not a web address/);
    });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
