import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { X509Certificate } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import tls from 'node:tls';
import { setTimeout } from 'node:timers/promises';
import { ENTRY, REPO_ROOT } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

function probe(s, { background = false } = {}) {
  const preload = join(s.root, 'tls-probe.mjs');
  writeFileSync(preload, `
    import tls from 'node:tls';
    import { X509Certificate } from 'node:crypto';
    import { writeFileSync } from 'node:fs';
    import { spawnSync } from 'node:child_process';
    import { childEnv } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src/tools.mjs')).href)};
    import { spawnDetached } from ${JSON.stringify(pathToFileURL(join(REPO_ROOT, 'src/scribe.mjs')).href)};
    process.once('beforeExit', () => {
      if (process.argv[1] !== ${JSON.stringify(ENTRY)}) return;
      const defaults = new Set(tls.getCACertificates('default'));
      const fingerprint = (cert) => new X509Certificate(cert).fingerprint256;
      const trusted = new Set([...defaults].map(fingerprint));
      const child = spawnSync(process.execPath, ['--input-type=module', '-e',
        'import tls from "node:tls"; const defaults = new Set(tls.getCACertificates("default")); console.log(JSON.stringify({enabled: process.env.NODE_USE_SYSTEM_CA, missing: tls.getCACertificates("system").filter(c => !defaults.has(c)).length}));'
      ], { env: childEnv(), encoding: 'utf8' });
      const isBackground = process.argv.includes('scribe');
      writeFileSync(${JSON.stringify(s.root)} + (isBackground ? '/background.json' : '/tls.json'), JSON.stringify({
        enabled: process.env.NODE_USE_SYSTEM_CA,
        missing: tls.getCACertificates('system').filter(c => !defaults.has(c)).length,
        missingBundled: tls.getCACertificates('bundled').filter(c => !trusted.has(fingerprint(c))).length,
        extraTrusted: tls.getCACertificates('extra').every(c => trusted.has(fingerprint(c))),
        extra: tls.getCACertificates('extra'),
        child: { code: child.status, ...JSON.parse(child.stdout) },
      }));
      if (${background} && !isBackground) spawnDetached(['scribe', 'status']);
    });
  `);
  return preload;
}

function assertSystemTrust(file) {
  const state = JSON.parse(readFileSync(file, 'utf8'));
  assert.equal(state.enabled, '1', 'system trust is also enabled for descendants');
  assert.equal(state.missing, 0, 'every system CA is present in the active trust list');
  assert.equal(state.missingBundled, 0, 'bundled public CAs remain trusted');
  assert.equal(state.extraTrusted, true, 'extra CAs remain in the active trust list');
  assert.deepEqual(state.child, { code: 0, enabled: '1', missing: 0 }, 'tool children inherit working system trust');
  return state;
}

for (const inherited of ['', '0', '1']) {
  test(`direct CLI enables system trust with inherited setting ${JSON.stringify(inherited)}`, () => {
    const s = sandbox();
    const run = s.sumo(['help'], { extraEnv: {
      NODE_USE_SYSTEM_CA: inherited,
      NODE_OPTIONS: `--import=${pathToFileURL(probe(s)).href}`,
      NODE_EXTRA_CA_CERTS: '',
    } });
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, /^sumo — /);
    assert.equal(run.err, '');
    assertSystemTrust(join(s.root, 'tls.json'));
  });
}

test('generated launcher enables system trust with a bare hook environment', () => {
  const s = sandbox();
  const binDir = join(s.root, 'bin');
  mkdirSync(binDir);
  const setup = s.sumo(['setup', '--bin-dir', binDir]);
  assert.equal(setup.code, 0, setup.err);
  const run = spawnSync(join(binDir, 'sumo'), ['help'], { encoding: 'utf8', env: {
    PATH: '/usr/bin:/bin',
    NODE_OPTIONS: `--import=${pathToFileURL(probe(s)).href}`,
  } });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(run.stderr, '');
  assertSystemTrust(join(s.root, 'tls.json'));
});

test('enabling system trust preserves an explicit extra CA bundle', () => {
  const s = sandbox();
  const cert = tls.getCACertificates('bundled')[0];
  const bundle = join(s.root, 'extra-ca.pem');
  writeFileSync(bundle, cert);
  const run = s.sumo(['help'], { extraEnv: {
    NODE_USE_SYSTEM_CA: '',
    NODE_OPTIONS: `--import=${pathToFileURL(probe(s)).href}`,
    NODE_EXTRA_CA_CERTS: bundle,
  } });
  assert.equal(run.code, 0, run.err);
  const { extra } = assertSystemTrust(join(s.root, 'tls.json'));
  assert.equal(extra.length, 1);
  assert.equal(new X509Certificate(extra[0]).fingerprint256, new X509Certificate(cert).fingerprint256);
});

test('background Sumo processes inherit system trust', async () => {
  const s = sandbox();
  const run = s.sumo(['help'], { extraEnv: {
    NODE_USE_SYSTEM_CA: '',
    NODE_OPTIONS: `--import=${pathToFileURL(probe(s, { background: true })).href}`,
    NODE_EXTRA_CA_CERTS: '',
    SUMO_AGENTS_SPAWN_LOG: '',
  } });
  assert.equal(run.code, 0, run.err);
  const snapshot = join(s.root, 'background.json');
  const deadline = Date.now() + 5000;
  while (!existsSync(snapshot) && Date.now() < deadline) await setTimeout(20);
  assert.ok(existsSync(snapshot), 'background process completed');
  assertSystemTrust(snapshot);
});
