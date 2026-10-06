import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstatSync, mkdirSync, readlinkSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { ENTRY } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

const mode = (file) => statSync(file).mode & 0o777;

test('setup creates a private home, a private database and a launcher that runs', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);

  const run = s.sumo(['setup', '--bin-dir', binDir]);
  assert.equal(run.code, 0, run.err);

  assert.equal(mode(s.home), 0o700);
  assert.equal(mode(join(s.home, 'memory.db')), 0o600);
  assert.equal(readlinkSync(join(binDir, 'sumo')), join(s.home, 'bin', 'sumo'));

  // The launcher must work with nothing helpful on PATH — that is how a hook calls it.
  const viaLauncher = spawnSync(join(binDir, 'sumo'), ['help'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin' } });
  assert.equal(viaLauncher.status, 0, viaLauncher.stderr);
  assert.match(viaLauncher.stdout, /^sumo — /);
  assert.equal(viaLauncher.stderr, '', 'the experimental-SQLite warning must not leak into hook output');
});

test('setup can be run again without changing anything', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir]);
  s.sumo(['add', 'preference', 'be concise']);

  const again = s.sumo(['setup', '--bin-dir', binDir]);
  assert.equal(again.code, 0, again.err);
  assert.match(again.out, /already linked/);
  assert.match(s.sumo(['search', 'concise']).out, /be concise/);
});

test('setup never overwrites a different command called sumo', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  writeFileSync(join(binDir, 'sumo'), '#!/bin/sh\necho someone else\n', { mode: 0o755 });

  const run = s.sumo(['setup', '--bin-dir', binDir]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /skipped/);
  assert.equal(lstatSync(join(binDir, 'sumo')).isSymbolicLink(), false);
});

test('doctor passes after setup and fails once the launcher is broken', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir]);
  const path = { PATH: `${binDir}:${process.env.PATH}` };

  const healthy = s.sumo(['doctor'], { extraEnv: path });
  assert.equal(healthy.code, 0, healthy.out);
  assert.doesNotMatch(healthy.out, /FAIL/);
  assert.match(healthy.out, /^ok {4}code [0-9a-f]{7,} · \d{4}-\d{2}-\d{2} · /, 'the first line says which commit is running, so an update can be checked at a glance');

  writeFileSync(join(s.home, 'bin', 'sumo'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  const broken = s.sumo(['doctor'], { extraEnv: path });
  assert.equal(broken.code, 1);
  assert.match(broken.out, /FAIL {2}launcher/);
});

test('doctor fails without the router, since no job can be created without it', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  const env = { PATH: `${binDir}:${process.env.PATH}` };

  assert.match(s.sumo(['doctor'], { extraEnv: env }).out, /^ok {4}router stand-in /m, 'a test harness answers for the router');

  const real = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(real.code, 1);
  assert.match(real.out, /^FAIL {2}router model \(Qwen3-4B-Q4_K_M\.gguf\)/m);
});

test('doctor still reports every check when the database cannot be opened', () => {
  const s = sandbox();
  mkdirSync(s.home, { recursive: true });
  writeFileSync(join(s.home, 'memory.db'), 'not a database, only bytes '.repeat(10));

  const run = s.sumo(['doctor'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(run.code, 1, run.err);
  assert.match(run.out, /^FAIL {2}database opens — file is not a database/m, run.err);
  assert.match(run.out, /^FAIL {2}router model \(Qwen3-4B-Q4_K_M\.gguf\)/m, 'the checks after the database are still made');
});

test('a budget that is not a positive whole number is refused, never stored as no limit at all', () => {
  const s = sandbox();
  for (const args of [['config', 'prime.budget', '1,000'], ['prime', '--budget', '8OO'], ['prime', '--budget', '0']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, /needs a positive number/);
  }
  assert.match(s.sumo(['config', 'prime.budget']).out, /prime\.budget = 800/, 'a refused value is not stored');
  assert.match(s.sumo(['config', 'prime.budget', '1200']).out, /prime\.budget = 1200/);
});

test('config never prints the credentials in a model source, and keeps them for the download', () => {
  const s = sandbox();
  const source = 'https://me:hf_SECRETTOKEN@artifactory.example/hf';
  for (const args of [['config', 'model.source', source], ['config', 'model.source'], ['config']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 0, run.err);
    assert.doesNotMatch(run.out, /hf_SECRETTOKEN/);
    assert.match(run.out, /^model\.source = https:\/\/artifactory\.example\/hf$/m);
  }
  assert.equal(s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'config.model.source'`).get().value), source);
});

test('the schema is migrated once and recorded', () => {
  const s = sandbox();
  s.sumo(['config']);
  s.sumo(['config']);
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
});

test('config reads defaults, stores changes and rejects names it does not know', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'scribe.model']).out, /scribe\.model = local/);
  assert.match(s.sumo(['config', 'scribe.model', 'sonnet']).out, /scribe\.model = sonnet/);
  assert.match(s.sumo(['config']).out, /scribe\.model = sonnet/);

  const typo = s.sumo(['config', 'scribe.modle', 'sonnet']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /unknown setting/);
});

test('doctor wants ANTHROPIC_API_KEY for the cheap-model passes, unless a stand-in answers for them', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  const env = { PATH: `${binDir}:${process.env.PATH}` };

  // The sandbox sets SUMO_AGENTS_MODEL_CMD, so no key is needed and none is asked for.
  assert.match(s.sumo(['doctor'], { extraEnv: env }).out, /^ok {4}ANTHROPIC_API_KEY/m);

  const real = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } });
  assert.match(real.out, /^FAIL {2}ANTHROPIC_API_KEY is set .* — export ANTHROPIC_API_KEY/m, real.out);

  const keyed = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.match(keyed.out, /^ok {4}ANTHROPIC_API_KEY/m, keyed.out);
});

test('doctor accepts a Claude Code OAuth token, including one mistakenly exported as an API key', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  const env = { PATH: `${binDir}:${process.env.PATH}`, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '' };

  const named = s.sumo(['doctor'], { extraEnv: { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-named' } });
  assert.match(named.out, /^ok {4}ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN/m, named.out);

  const misplaced = s.sumo(['doctor'], { extraEnv: { ...env, ANTHROPIC_API_KEY: 'sk-ant-oat-misplaced', CLAUDE_CODE_OAUTH_TOKEN: '' } });
  assert.match(misplaced.out, /^ok {4}ANTHROPIC_API_KEY.*CLAUDE_CODE_OAUTH_TOKEN/m, misplaced.out);
});

test('a home given as a relative path is pinned as an absolute one, so the linked command works from anywhere', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  const run = spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'setup', '--bin-dir', binDir, '--no-model'], {
    cwd: s.root,
    env: { ...process.env, SUMO_AGENTS_HOME: 'home' },
    encoding: 'utf8',
  });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(realpathSync(join(binDir, 'sumo')), realpathSync(join(s.home, 'bin', 'sumo')), 'the link must not dangle');
});

test('a directory that shares a command name on PATH is not that command', () => {
  const s = sandbox();
  const fakeBin = join(s.root, 'fake-bin');
  mkdirSync(join(fakeBin, 'llama-server'), { recursive: true });
  const run = s.sumo(['setup', '--no-link', '--no-model'], { extraEnv: { PATH: `${fakeBin}:/usr/bin:/bin` } });
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /llama-server not found/);
  assert.equal(s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'llama.path'`).get()), undefined);
});

test('a model source with a token downloads with it as a header, and offline a model already here is kept, not called missing', async () => {
  const { createServer } = await import('node:http');
  const { freshHome, withHome } = await import('./fixtures/env-sandbox.mjs');
  const { setup } = await import('../src/setup.mjs');
  const { paths } = await import('../src/paths.mjs');
  const seen = [];
  const server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, auth: req.headers.authorization ?? null });
    if (req.headers.authorization !== `Basic ${Buffer.from('me:hf_TOKEN').toString('base64')}`) {
      res.writeHead(401).end();
      return;
    }
    res.writeHead(200, { 'content-length': '4' }).end(req.method === 'HEAD' ? undefined : 'gguf');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const home = freshHome();
  const quiet = { SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '', ANTHROPIC_AUTH_TOKEN: '' };
  try {
    await withHome(home, quiet, async () => {
      const lines = await setup({ link: false, modelSource: `http://me:hf_TOKEN@127.0.0.1:${server.address().port}` });
      assert.match(lines.join('\n'), /downloaded/, lines.join('\n'));
      assert.deepEqual(seen.map((r) => r.method), ['HEAD', 'GET']);
      assert.ok(!lines.join('\n').includes('hf_TOKEN'));
      assert.equal(statSync(join(paths().models, 'Qwen3-4B-Q4_K_M.gguf')).size, 4);

      const offline = await setup({ link: false, modelSource: 'http://127.0.0.1:1' });
      assert.match(offline.join('\n'), /^model .*present; not checked against http:\/\/127\.0\.0\.1:1/m, offline.join('\n'));
    });
  } finally {
    server.close();
  }
});

test('config refuses an effort the API does not take and a model file that is a path', async () => {
  const s = sandbox();
  for (const [args, message] of [
    [['config', 'chat.effort', 'banana'], /no such effort "banana"/],
    [['config', 'model.file', '../../etc/passwd'], /model\.file is a file name/],
  ]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, message);
  }
  assert.match(s.sumo(['config', 'chat.effort', 'xhigh']).out, /chat\.effort = xhigh/);
  const { CHAT_EFFORTS } = await import('../src/setup.mjs');
  const { EFFORTS } = await import('../src/route.mjs');
  assert.deepEqual(CHAT_EFFORTS, EFFORTS);
});

test('a model source that is not a web address is refused before it is stored, and a stored one that cannot be read never stops setup', async () => {
  const s = sandbox();
  for (const args of [['config', 'model.source', 'huggingface.co'], ['setup', '--no-link', '--model-source', 'huggingface.co']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, /is not a web address/);
  }
  assert.match(s.sumo(['config', 'model.source']).out, /^model\.source = https:\/\/huggingface\.co$/m, 'nothing was stored');

  const { freshHome, withHome } = await import('./fixtures/env-sandbox.mjs');
  const { setup } = await import('../src/setup.mjs');
  const { paths } = await import('../src/paths.mjs');
  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '' }, async () => {
    const lines = await setup({ link: false, modelSource: 'https://u:%E0@127.0.0.1:9' });
    assert.match(lines.join('\n'), /could not download the router model/);
    assert.equal(statSync(paths().launcher).isFile(), true, 'the launcher is written all the same');
  });
});

test('doctor only warns without herdr: a job runs without it, only its tab is not opened', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir]);
  const run = s.sumo(['doctor'], { extraEnv: { PATH: `${binDir}:/usr/bin:/bin` } });
  assert.match(run.out, /^warn {2}herdr on PATH \(optional/m, run.out);
  assert.doesNotMatch(run.out, /FAIL {2}herdr/);
});

test('setup says what it skipped and what to run next', () => {
  const s = sandbox();
  const run = s.sumo(['setup', '--no-model', '--no-link']);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /^model {5}not fetched \(--no-model\)/m);
  assert.match(run.out, /^command {3}not linked \(--no-link\)/m);
  assert.match(run.out, /^next {6}sumo doctor$/m);
});
