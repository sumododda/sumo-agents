// The local model runs on one llama-server that outlives the call: started on demand, reused while it
// answers, replaced when the model or the binary it was started for changes, and stopped by setup.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { getMeta, openDb, setMeta } from '../src/db.mjs';
import { ensureLocalServer, stopLocalServer } from '../src/local-server.mjs';
import { callLocalModel } from '../src/model.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { CONFIG_DEFAULTS } from '../src/setup.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const FAKE = join(REPO_ROOT, 'test', 'fixtures', 'fake-llama-server.mjs');

const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A home with a model file and a `llama-server` that is really the fake above; returns the db and the files the fake writes. */
function arrange(home, { file = CONFIG_DEFAULTS['model.file'] } = {}) {
  mkdirSync(paths().models, { recursive: true });
  writeFileSync(join(paths().models, file), 'gguf');
  const llama = join(home, 'llama-server');
  writeFileSync(llama, `#!/bin/sh\nexec '${process.execPath}' '${FAKE}' "$@"\n`);
  chmodSync(llama, 0o755);
  const db = openDb();
  setMeta(db, 'llama.path', llama);
  if (file !== CONFIG_DEFAULTS['model.file']) setMeta(db, 'config.model.file', file);
  return { db, log: join(home, 'fake.log'), capture: join(home, 'capture.json'), answer: join(home, 'answer.json') };
}

/** Each test runs the stand-in-free path, with the fake's files named in the environment the server inherits. */
const live = (home, extra, fn) => withHome(home, { SUMO_AGENTS_MODEL_CMD: '', FAKE_LLAMA_LOG: join(home, 'fake.log'), FAKE_LLAMA_CAPTURE: join(home, 'capture.json'), FAKE_LLAMA_ANSWER: join(home, 'answer.json'), ...extra }, fn);

test('the first call starts llama-server in router mode on the models directory and asks it for the configured model', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db, log, capture, answer } = arrange(home);
    try {
      writeFileSync(answer, '{"ops":[]}');
      const result = await callLocalModel(db, { system: 'label text', prompt: 'hello', schema: { type: 'object' }, kind: 'scribe', think: true, maxTokens: 4096, log: false });
      assert.equal(result.ok, true, result.error ?? '');
      assert.deepEqual(result.data, { ops: [] });

      const started = JSON.parse(readFileSync(log, 'utf8'));
      assert.equal(started.args[started.args.indexOf('--models-dir') + 1], paths().models);
      assert.ok(started.args.includes('--sleep-idle-seconds'), 'an idle server sleeps instead of holding the model');
      const asked = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(asked.model, CONFIG_DEFAULTS['model.file'].replace(/\.gguf$/, ''), 'router mode names a model after its file');
      assert.equal(asked.chat_template_kwargs.enable_thinking, true);
      assert.equal(asked.max_tokens, 4096);
      assert.equal(asked.response_format.type, 'json_schema');
      assert.equal(asked.messages[0].content, 'label text');

      const recorded = JSON.parse(getMeta(db, 'llama.server'));
      assert.equal(recorded.pid, started.pid);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_runs').get().n, 0, 'log: false leaves the ledger to the caller');
    } finally {
      stopLocalServer(db);
      db.close();
    }
  });
});

test('the router call keeps its shape: no thinking, the short answer cap, one ledger row of kind local', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db, capture } = arrange(home);
    try {
      const result = await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      assert.equal(result.ok, true, result.error ?? '');
      const asked = JSON.parse(readFileSync(capture, 'utf8'));
      assert.equal(asked.chat_template_kwargs.enable_thinking, false);
      assert.ok(asked.max_tokens <= 400);
      const row = db.prepare('SELECT * FROM model_runs ORDER BY id DESC LIMIT 1').get();
      assert.deepEqual([row.kind, row.ok], ['local', 1]);
      assert.match(row.model, /^local:/);
    } finally {
      stopLocalServer(db);
      db.close();
    }
  });
});

test('a second call reuses the running server; a changed model file replaces it; stop ends it', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db, log } = arrange(home);
    try {
      await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      const first = JSON.parse(readFileSync(log, 'utf8')).pid;
      await callLocalModel(db, { system: 's', prompt: 'again', schema: { type: 'object' } });
      assert.equal(JSON.parse(readFileSync(log, 'utf8')).pid, first, 'the same server answered twice');
      assert.ok(alive(first));

      writeFileSync(join(paths().models, 'Other-Model.gguf'), 'gguf');
      setMeta(db, 'config.model.file', 'Other-Model.gguf');
      const result = await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      assert.equal(result.ok, true, result.error ?? '');
      const second = JSON.parse(readFileSync(log, 'utf8')).pid;
      assert.notEqual(second, first, 'a server started for another model is replaced');
      await settle(200);
      assert.equal(alive(first), false, 'the old one is gone');
      assert.ok(alive(second));

      stopLocalServer(db);
      await settle(200);
      assert.equal(alive(second), false);
      assert.equal(getMeta(db, 'llama.server'), null);
    } finally {
      stopLocalServer(db);
      db.close();
    }
  });
});

test('a server that died is started again instead of being waited for', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db, log } = arrange(home);
    try {
      await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      const first = JSON.parse(readFileSync(log, 'utf8')).pid;
      process.kill(first, 'SIGKILL');
      await settle(200);
      const result = await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      assert.equal(result.ok, true, result.error ?? '');
      assert.notEqual(JSON.parse(readFileSync(log, 'utf8')).pid, first);
    } finally {
      stopLocalServer(db);
      db.close();
    }
  });
});

test('two callers replacing one wedged server end up on one new server: the second never ends the first one\'s', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db } = arrange(home);
    const other = openDb();
    const file = CONFIG_DEFAULTS['model.file'];
    const llama = getMeta(db, 'llama.path');
    // Ours by its command line, but /health never answers, and long past its start-up grace.
    const port = 45000 + Math.floor(Math.random() * 1000);
    const wedged = spawn(process.execPath, ['-e', `require('http').createServer(()=>{}).listen(${port},'127.0.0.1')`, '--', '--port', String(port)], { stdio: 'ignore' });
    try {
      await settle(300);
      setMeta(db, 'llama.server', JSON.stringify({ pid: wedged.pid, port, file, llama, startedAt: Date.now() - 120_000 }));
      const first = ensureLocalServer(db, { llama, file }).then((s) => s, (e) => e);
      await settle(500);
      const second = await ensureLocalServer(other, { llama, file }).then((s) => s, (e) => e);
      const a = await first;
      assert.ok(!(a instanceof Error), a.message);
      assert.ok(!(second instanceof Error), second.message);
      assert.equal(second.pid, a.pid);
      assert.equal(alive(a.pid), true);
    } finally {
      stopLocalServer(db);
      wedged.kill();
      other.close();
      db.close();
    }
  });
});

test('a bundle larger than the context is a plain failure that names the size, not a crash', async () => {
  const home = freshHome();
  await live(home, { FAKE_LLAMA_CTX: '100' }, async () => {
    const { db } = arrange(home);
    try {
      const result = await callLocalModel(db, { system: 's', prompt: 'x'.repeat(500), schema: { type: 'object' }, kind: 'dream', log: false });
      assert.equal(result.ok, false);
      assert.match(result.error, /larger than the local model's context/);
      assert.match(result.error, /\d+ tokens/);
    } finally {
      stopLocalServer(db);
      db.close();
    }
  });
});

test('stopping when nothing was started is a no-op, and setup stops a recorded server', async () => {
  const home = freshHome();
  await live(home, {}, async () => {
    const { db, log } = arrange(home);
    try {
      stopLocalServer(db);
      await callLocalModel(db, { system: 's', prompt: 'p', schema: { type: 'object' } });
      const pid = JSON.parse(readFileSync(log, 'utf8')).pid;
      db.close();
      const { setup } = await import('../src/setup.mjs');
      await setup({ link: false, noModel: true });
      await settle(200);
      assert.equal(alive(pid), false, 'setup may have changed the model or the binary, so the old server goes');
      assert.equal(existsSync(join(home, 'memory.db')), true);
    } finally {
      try { db.close(); } catch { /* closed above */ }
    }
  });
});
