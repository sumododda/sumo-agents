import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, lstatSync, mkdirSync, readdirSync, readlinkSync, realpathSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { ENTRY } from '../src/paths.mjs';
import { blockedWrite } from '../src/sandbox.mjs';
import { HAS_PTY, sandbox } from './helpers.mjs';

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

test('setup in another home never takes over a sumo link that runs a home still there; a link to a home that is gone is replaced', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  const otherBin = join(s.root, 'main', '.sumo-agents', 'bin');
  mkdirSync(otherBin, { recursive: true });
  writeFileSync(join(otherBin, 'sumo'), '#!/bin/sh\n', { mode: 0o755 });
  symlinkSync(join(otherBin, 'sumo'), join(binDir, 'sumo'));
  const run = s.sumo(['setup', '--bin-dir', binDir]);
  assert.equal(run.code, 0, run.err);
  assert.match(run.out, /skipped — it runs the sumo in .*\/main\/\.sumo-agents; to point it here: ln -sf \S+\/home\/bin\/sumo \S+\/bin\/sumo/);
  assert.equal(readlinkSync(join(binDir, 'sumo')), join(otherBin, 'sumo'), 'the main home keeps its command');

  const stale = join(s.root, 'stale');
  mkdirSync(stale);
  symlinkSync(join(s.root, 'gone', '.sumo-agents', 'bin', 'sumo'), join(stale, 'sumo'));
  const relinked = s.sumo(['setup', '--bin-dir', stale]);
  assert.match(relinked.out, /\(linked\)/);
  assert.equal(readlinkSync(join(stale, 'sumo')), join(s.home, 'bin', 'sumo'));
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

  assert.match(s.sumo(['doctor'], { extraEnv: env }).out, /^ok {4}local model stand-in /m, 'a test harness answers for the local model');

  const real = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(real.code, 1);
  assert.match(real.out, /^FAIL {2}local model \(Qwen3-4B-Q4_K_M\.gguf\)/m);
});

test('doctor still reports every check when the database cannot be opened', () => {
  const s = sandbox();
  mkdirSync(s.home, { recursive: true });
  writeFileSync(join(s.home, 'memory.db'), 'not a database, only bytes '.repeat(10));

  const run = s.sumo(['doctor'], { extraEnv: { SUMO_AGENTS_MODEL_CMD: '' } });
  assert.equal(run.code, 1, run.err);
  assert.match(run.out, /^FAIL {2}database opens — file is not a database/m, run.err);
  assert.match(run.out, /^FAIL {2}local model \(Qwen3-4B-Q4_K_M\.gguf\)/m, 'the checks after the database are still made');
});

test('a home that is a file is one FAIL in doctor with the fix, and every command says the same instead of a raw error', () => {
  const s = sandbox();
  const file = join(s.root, 'afile');
  writeFileSync(file, 'not a folder\n');
  const said = `${file} is a file, not a folder — SUMO_AGENTS_HOME must name a folder`;
  for (const args of [['doctor'], ['doctor', '--fix'], ['doctor', '--report']]) {
    const run = s.sumo(args, { extraEnv: { SUMO_AGENTS_HOME: file } });
    assert.equal(run.err, '', `${args.join(' ')}: no crash`);
    assert.deepEqual(run.out.split('\n').filter((line) => /^(- )?FAIL/.test(line)).map((line) => line.replace(/^- /, '')), [`FAIL  home is a folder — ${said}`]);
  }
  assert.equal(statSync(file).mode & 0o777, 0o644 & ~process.umask(), 'a file there is not sumo\'s to change');
  for (const home of [file, join(file, 'home')]) {
    const run = s.sumo(['search', 'deploy'], { extraEnv: { SUMO_AGENTS_HOME: home } });
    assert.equal(run.code, 1);
    assert.equal(run.err, `sumo: ${said}\n`);
  }
});

test('a home sumo may not write is said as that, with the next step, and doctor --fix gives it back to its owner; the model\'s shell keeps the words the sandbox reads', { skip: process.getuid?.() === 0 && 'root writes whatever the modes say' }, () => {
  const s = sandbox();
  assert.equal(s.sumo(['add', 'fact', 'The deploy runs from the main branch only']).code, 0);
  chmodSync(s.home, 0o500);
  try {
    const search = s.sumo(['search', 'deploy']);
    assert.equal(search.code, 1);
    assert.equal(search.err, `sumo: the home ${s.home} is not writable — check its owner and mode, or sumo doctor --fix\n`);
    // The model's shell gets SQLite's own words, which the sandbox reads as a write it blocked, to ask the user about.
    assert.ok(blockedWrite(s.sumo(['search', 'deploy'], { extraEnv: { SUMO_TOOL: '1' } }).err));
    const doctor = s.sumo(['doctor']);
    assert.match(doctor.out, /^FAIL {2}database opens — the home .* is not writable — check its owner and mode, or sumo doctor --fix$/m);
    assert.match(doctor.out, /^FAIL {2}home directory is private \(0700\) — run: sumo doctor --fix$/m);
    assert.match(s.sumo(['doctor', '--fix']).out, /^fixed: made 1 place private$/m);
    assert.equal(mode(s.home), 0o700);
  } finally {
    chmodSync(s.home, 0o700);
  }
  assert.match(s.sumo(['search', 'deploy']).out, /main branch only/);

  // A home that cannot be made at all names the folder in the way.
  const locked = join(s.root, 'locked');
  mkdirSync(locked, { mode: 0o500 });
  const made = s.sumo(['search', 'deploy'], { extraEnv: { SUMO_AGENTS_HOME: join(locked, 'home') } });
  assert.equal(made.err, `sumo: the home ${join(locked, 'home')} cannot be made: ${locked} is not writable — check its owner and mode\n`);
});

test('doctor names the fix that works: doctor --fix for a home others can read, and where this sumo is when another comes first on PATH', () => {
  const s = sandbox();
  assert.equal(s.sumo(['add', 'fact', 'The deploy runs from the main branch only']).code, 0);
  chmodSync(s.home, 0o755);
  assert.match(s.sumo(['doctor']).out, /^FAIL {2}home directory is private \(0700\) — run: sumo doctor --fix$/m);
  s.sumo(['doctor', '--fix']);
  assert.match(s.sumo(['doctor']).out, /^ok {4}home directory is private \(0700\)$/m, 'the fix it named is the one that works');

  const other = join(s.root, 'other');
  mkdirSync(other);
  writeFileSync(join(other, 'sumo'), '#!/bin/sh\n', { mode: 0o755 });
  const shadowed = s.sumo(['doctor'], { extraEnv: { PATH: `${other}:${process.env.PATH}` } });
  assert.match(shadowed.out, /^FAIL {2}`sumo` on PATH is this one — run: sumo setup, or put \$SUMO_AGENTS_HOME\/bin first on PATH$/m);
});

test('a block budget that is not a positive whole number is refused, never taken as no limit at all', () => {
  const s = sandbox();
  for (const args of [['prime', '--budget', '8OO'], ['prime', '--budget', '0']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, /needs a positive number/);
  }
});

test('config never prints the credentials in a model address, and keeps them for the download', () => {
  const s = sandbox();
  const url = 'https://me:hf_SECRETTOKEN@artifactory.example/hf/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf';
  for (const args of [['config', 'model.url', url], ['config', 'model.url'], ['config']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 0, run.err);
    assert.doesNotMatch(run.out, /hf_SECRETTOKEN/);
    assert.match(run.out, /^model\.url = https:\/\/artifactory\.example\/hf\/Qwen\/Qwen3-4B-GGUF\/resolve\/main\/Qwen3-4B-Q4_K_M\.gguf$/m);
  }
  assert.equal(s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'config.model.url'`).get().value), url);
});

test('config lists its fifteen settings by name, and an old one says what it became instead of being unknown', () => {
  const s = sandbox();
  const listed = s.sumo(['config']).out.trim().split('\n').map((line) => line.split(' = ')[0]);
  assert.deepEqual(listed, [
    'chat.budget', 'chat.effort', 'chat.model', 'chat.notify', 'chat.screen',
    'jobs.advisor', 'jobs.budget', 'jobs.floor', 'jobs.minutes', 'jobs.review',
    'memory.model', 'model.url', 'projects.home', 'shell.network', 'shell.sandbox',
  ]);
  for (const [key, said] of [
    ['chat.plain', /chat\.plain is now chat\.screen: sumo config chat\.screen plain/],
    ['chat.motion', /chat\.motion is now chat\.screen: sumo config chat\.screen still/],
    ['model.source', /model\.source is now part of model\.url/],
    ['model.repo', /model\.repo is now part of model\.url/],
    ['model.file', /model\.file is now part of model\.url/],
    ['prime.budget', /prime\.budget is no longer a setting: .*800 tokens/],
    ['scratch.days', /scratch\.days is no longer a setting: .*14 days/],
    ['jobs.escalate', /jobs\.escalate is no longer a setting: .*always retried once/],
    ['guides.auto', /guides\.auto is no longer a setting: .*always rides in/],
  ]) {
    for (const args of [['config', key], ['config', key, 'on']]) {
      const run = s.sumo(args);
      assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
      assert.match(run.err, said);
    }
  }
  assert.equal(s.sql((db) => db.prepare(`SELECT COUNT(*) AS n FROM meta WHERE key LIKE 'config.%'`).get().n), 0, 'nothing was stored under an old name');
});

test('--model-source puts another source in front of the model\'s address, and a whole .gguf address is taken as it is', () => {
  const s = sandbox();
  const stored = () => s.sql((db) => db.prepare(`SELECT value FROM meta WHERE key = 'config.model.url'`).get().value);
  const setup = (source) => s.sumo(['setup', '--no-link', '--no-model', '--model-source', source]);
  assert.equal(setup('https://jfrog.example/artifactory/api/huggingfaceml/hf/').code, 0);
  assert.equal(stored(), 'https://jfrog.example/artifactory/api/huggingfaceml/hf/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf', 'the file keeps its path there');
  assert.equal(s.sumo(['config', 'model.url', 'https://mirror.example/models/Qwen3-4B-Q8_0.gguf']).code, 0);
  setup('https://other.example/m');
  assert.equal(stored(), 'https://other.example/m/Qwen3-4B-Q8_0.gguf', 'an address in no repository keeps its file');
  setup('https://hf.example/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q5_K_M.gguf');
  assert.equal(stored(), 'https://hf.example/unsloth/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q5_K_M.gguf');
});

test('the model file is the last part of its address and never a path: an encoded separator stays in the name', async () => {
  const { dirname } = await import('node:path');
  const { modelFileOfUrl } = await import('../src/setup.mjs');
  assert.equal(modelFileOfUrl(), 'Qwen3-4B-Q4_K_M.gguf');
  for (const url of ['https://h.example/x/..%2F..%2Fbin%2Fsumo.gguf', 'https://h.example/a/b/../../../bin/sumo.gguf', 'https://h.example/x/..%5C..%5Csumo.gguf']) {
    const file = modelFileOfUrl(url);
    assert.equal(dirname(join('/models', file)), '/models', `${url} → ${file}`);
  }
});

test('the schema is migrated once and recorded', () => {
  const s = sandbox();
  s.sumo(['config']);
  s.sumo(['config']);
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
});

test('where new projects are made is a directory that is there, and the advisor is on or off', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'projects.home']).out, /projects\.home = ~$/m);
  mkdirSync(join(s.root, 'code'));
  assert.match(s.sumo(['config', 'projects.home', join(s.root, 'code')]).out, /projects\.home = .*code$/m);
  const missing = s.sumo(['config', 'projects.home', join(s.root, 'nowhere')]);
  assert.equal(missing.code, 2);
  assert.match(missing.err, /is not a directory/);
  assert.match(s.sumo(['config', 'projects.home']).out, /code$/m, 'a refused value is not stored');


  assert.match(s.sumo(['config', 'jobs.advisor']).out, /jobs\.advisor = off/);
  assert.match(s.sumo(['config', 'jobs.advisor', 'on']).out, /jobs\.advisor = on/);
  assert.match(s.sumo(['config', 'jobs.advisor', 'opus']).err, /jobs\.advisor is on or off/);
});

test('config reads defaults, stores changes and rejects names it does not know', () => {
  const s = sandbox();
  assert.match(s.sumo(['config', 'memory.model']).out, /memory\.model = local/);
  assert.match(s.sumo(['config', 'memory.model', 'sonnet']).out, /memory\.model = sonnet/);
  assert.match(s.sumo(['config']).out, /memory\.model = sonnet/);

  const typo = s.sumo(['config', 'memory.modle', 'sonnet']);
  assert.equal(typo.code, 2);
  assert.match(typo.err, /unknown setting/);
});

test('doctor wants ANTHROPIC_API_KEY for the cheap-model passes, unless a stand-in answers for them', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  // A key makes doctor count the prompt with the API: here the API is a port nothing listens on, so nothing leaves the machine.
  const env = { PATH: `${binDir}:${process.env.PATH}`, ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };

  // The sandbox sets SUMO_AGENTS_MODEL_CMD, so no key is needed and none is asked for.
  assert.match(s.sumo(['doctor'], { extraEnv: env }).out, /^ok {4}an Anthropic credential/m);

  const real = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: '' } });
  assert.match(real.out, /^FAIL {2}an Anthropic credential \(chat, jobs\) — export ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN$/m, real.out);

  const keyed = s.sumo(['doctor'], { extraEnv: { ...env, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: 'sk-ant-test' } });
  assert.match(keyed.out, /^ok {4}an Anthropic credential/m, keyed.out);
  assert.match(keyed.out, /^warn {2}prompt: not counted — /m, 'an API that cannot be reached is said, and fails nothing');
});

test('doctor accepts a Claude Code OAuth token, including one mistakenly exported as an API key', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir, '--no-model']);
  // Doctor counts the prompt with any credential: the API here is a port nothing listens on, so nothing leaves the machine.
  const env = { PATH: `${binDir}:${process.env.PATH}`, SUMO_AGENTS_MODEL_CMD: '', ANTHROPIC_API_KEY: '', ANTHROPIC_BASE_URL: 'http://127.0.0.1:9' };

  const named = s.sumo(['doctor'], { extraEnv: { ...env, CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat-named' } });
  assert.match(named.out, /^ok {4}an Anthropic credential/m, named.out);

  const misplaced = s.sumo(['doctor'], { extraEnv: { ...env, ANTHROPIC_API_KEY: 'sk-ant-oat-misplaced', CLAUDE_CODE_OAUTH_TOKEN: '' } });
  assert.match(misplaced.out, /^ok {4}an Anthropic credential/m, misplaced.out);
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

test('config refuses an effort the API does not take and a model address that is not a .gguf file', async () => {
  const s = sandbox();
  for (const [args, message] of [
    [['config', 'chat.effort', 'banana'], /no such effort "banana"/],
    [['config', 'model.url', 'https://huggingface.co/Qwen/Qwen3-4B-GGUF'], /model\.url is the model file's own address, ending in \.gguf/],
    [['config', 'model.url', 'http://mirror.example/x.gguf'], /plain http/],
    [['config', 'chat.notify', 'maybe'], /chat\.notify is on or off/],
    [['config', 'chat.screen', 'slow'], /chat\.screen is full, still or plain/],
    [['config', 'jobs.floor', 'gpt'], /jobs\.floor is haiku, sonnet, opus or fable/],
  ]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, message);
  }
  assert.match(s.sumo(['config', 'chat.effort', 'xhigh']).out, /chat\.effort = xhigh/);
  assert.match(s.sumo(['config', 'chat.notify']).out, /chat\.notify = on/, 'the bell is on until it is turned off');
  assert.match(s.sumo(['config', 'chat.notify', 'off']).out, /chat\.notify = off/);
  assert.match(s.sumo(['config', 'chat.screen']).out, /chat\.screen = full/, 'the working line moves, in frames, until told otherwise');
  assert.match(s.sumo(['config', 'chat.screen', 'still']).out, /chat\.screen = still/);
  assert.match(s.sumo(['config', 'chat.screen', 'plain']).out, /chat\.screen = plain/);
  assert.match(s.sumo(['config', 'model.url', 'http://127.0.0.1:8080/Qwen3-4B-Q8_0.gguf']).out, /model\.url = http:\/\/127\.0\.0\.1:8080\/Qwen3-4B-Q8_0\.gguf/, 'a mirror on this machine may be plain http');
  assert.match(s.sumo(['config', 'jobs.floor', 'opus']).out, /jobs\.floor = opus/);
  const { CHAT_EFFORTS } = await import('../src/setup.mjs');
  const { EFFORTS } = await import('../src/route.mjs');
  assert.deepEqual(CHAT_EFFORTS, EFFORTS);
});

test('a model source that is not a web address is refused before it is stored, and a stored one that cannot be read never stops setup', async () => {
  const s = sandbox();
  for (const args of [['config', 'model.url', 'huggingface.co/x.gguf'], ['setup', '--no-link', '--model-source', 'huggingface.co']]) {
    const run = s.sumo(args);
    assert.equal(run.code, 2, `${args.join(' ')} → ${run.out}`);
    assert.match(run.err, /is not a web address/);
  }
  assert.match(s.sumo(['config', 'model.url']).out, /^model\.url = https:\/\/huggingface\.co\/Qwen\/Qwen3-4B-GGUF\/resolve\/main\/Qwen3-4B-Q4_K_M\.gguf$/m, 'nothing was stored');

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

test('uninstall asks first, keeps a copy of the memory beside the home, stops the local model, removes its links and what it made — and nothing else', async () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  s.sumo(['setup', '--bin-dir', binDir]);
  s.sumo(['add', 'fact', 'kept across installs']);
  writeFileSync(join(s.home, 'eval.env'), 'MINE=1\n');
  mkdirSync(join(s.home, 'models'), { recursive: true });
  // A stand-in for the local model's server: a process whose command line names this home's models.
  const server = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', 'llama-server', '--models-dir', join(s.home, 'models')], { stdio: 'ignore' });
  const path = { PATH: `${binDir}${delimiter}${process.env.PATH}` };
  let copy;
  try {
    const unasked = s.sumo(['uninstall'], { extraEnv: path });
    assert.equal(unasked.code, 2);
    assert.match(unasked.err, /removing sumo cannot be undone, so it asks first — run it in a terminal, or add --yes/);
    assert.equal(existsSync(join(s.home, 'memory.db')), true, 'nothing was removed');
    assert.equal(s.sumo(['uninstall', '--yes'], { extraEnv: { ...path, SUMO_TOOL: '1' } }).code, 1, "the model's shell may not");

    const gone = s.sumo(['uninstall', '--yes'], { extraEnv: path });
    assert.equal(gone.code, 0, gone.err);
    copy = /kept your memory: (\S+\.db)/.exec(gone.out)?.[1];
    assert.ok(copy && copy.startsWith(s.root), gone.out);
    assert.match(gone.out, /stopped the local model's server/);
    assert.match(gone.out, new RegExp(`removed the sumo link at ${join(binDir, 'sumo').replace(/[.*+?^${}()|[\]\\]/g, (c) => `\\${c}`)}`));
    assert.match(gone.out, /left in place, not sumo's: eval\.env/);
    assert.match(gone.out, /last: npm uninstall -g sumo-agents/);
    assert.deepEqual(readdirSync(s.home), ['eval.env'], 'only what sumo did not make is left');
    assert.equal(existsSync(join(binDir, 'sumo')), false);
    await new Promise((resolve) => (server.exitCode !== null || server.signalCode !== null ? resolve() : server.once('exit', resolve)));
  } finally {
    server.kill('SIGKILL');
  }

  // The copy is a database a reinstall can take back.
  const again = sandbox();
  again.sumo(['config']);
  assert.equal(again.sumo(['backup', 'restore', copy, '--yes']).code, 0);
  assert.match(again.sumo(['search', 'installs']).out, /kept across installs/);
});

test('uninstall never removes a home that is your own home folder, or above it', () => {
  const s = sandbox();
  for (const home of [homedir(), dirname(homedir()), '/']) {
    const run = s.sumo(['uninstall', '--yes'], { extraEnv: { SUMO_AGENTS_HOME: home } });
    assert.equal(run.code, 1, home);
    assert.match(run.err, /is your home folder, or above it — sumo uninstall removes only a folder of its own/);
  }
});

test('at a terminal, uninstall shows what it will remove and goes ahead only when uninstall is typed', { skip: !HAS_PTY && 'no python3 pty here' }, () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'still here']);
  const declined = s.typed(['uninstall'], 'yes', ':');
  assert.match(declined.out, /^sumo uninstall removes:\n {2}from \S+: .*memory\.db/m);
  assert.match(declined.out, /Your memory is copied first, beside it, to /);
  assert.match(declined.out, /sumo: nothing was removed — the answer was not uninstall/);
  assert.equal(declined.code, 1);
  assert.match(s.sumo(['search', 'here']).out, /still here/);
});
