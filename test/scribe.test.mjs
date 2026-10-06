// The writer's lock: one run at a time, and a run that is still going never loses it to another.
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { withLock } from '../src/scribe.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const ran = async () => 'ran';
const SKIPPED = { skipped: 'another run is in progress' };

/** Runs `fn` with the path of the scribe's lock file in a throwaway home. */
async function withLockFile(fn) {
  const home = freshHome();
  mkdirSync(home, { recursive: true });
  await withHome(home, {}, () => fn(join(home, 'scribe.lock')));
}

const age = (file, minutes) => {
  const then = new Date(Date.now() - minutes * 60_000);
  utimesSync(file, then, then);
};

test('a lock is held for as long as the run that took it is alive, however long that is', async () => {
  await withLockFile(async (lock) => {
    // A model call that timed out and was retried twice: well past five minutes, and still going.
    writeFileSync(lock, String(process.pid));
    age(lock, 10);
    assert.deepEqual(await withLock('scribe', ran), SKIPPED);
    assert.equal(readFileSync(lock, 'utf8'), String(process.pid));
  });
});

test('a lock left by a run that died is taken over at once', async () => {
  await withLockFile(async (lock) => {
    writeFileSync(lock, String(spawnSync(process.execPath, ['-e', '']).pid));
    assert.equal(await withLock('scribe', ran), 'ran');
    assert.equal(existsSync(lock), false);
  });
});

test('a lock that never got a pid is judged by its age', async () => {
  await withLockFile(async (lock) => {
    writeFileSync(lock, '');
    assert.deepEqual(await withLock('scribe', ran), SKIPPED, 'just taken: the pid is a moment away');
    age(lock, 10);
    assert.equal(await withLock('scribe', ran), 'ran');
  });
});

test('a run that ends removes its own lock, never one another run holds', async () => {
  await withLockFile(async (lock) => {
    const other = String(process.ppid);
    assert.equal(await withLock('scribe', async () => {
      writeFileSync(lock, other);
      return 'ran';
    }), 'ran');
    assert.equal(readFileSync(lock, 'utf8'), other);
  });
});

test('two stale-lock reclaimers never enter the writer together', { timeout: 10_000 }, async () => {
  await withLockFile(async (lock) => {
    const deadPid = 99_999_999;
    writeFileSync(lock, String(deadPid));
    const module = new URL('../src/scribe.mjs', import.meta.url).href;
    const script = `
      import { withLock } from ${JSON.stringify(module)};
      import { existsSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      const home = process.env.SUMO_AGENTS_HOME, who = process.env.LOCK_CONTENDER;
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      const kill = process.kill;
      process.kill = (pid, signal) => {
        if (pid === ${deadPid}) {
          writeFileSync(join(home, who + '.ready'), 'ready');
          const end = Date.now() + 2000;
          while (!existsSync(join(home, (who === 'A' ? 'B' : 'A') + '.ready')) && Date.now() < end) pause(5);
          if (who === 'B') pause(150);
        }
        return kill(pid, signal);
      };
      console.log(JSON.stringify(await withLock('scribe', async () => {
        await new Promise((resolve) => setTimeout(resolve, 500));
        return 'ran';
      })));
    `;
    const results = await Promise.all(['A', 'B'].map((who) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, LOCK_CONTENDER: who }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(err));
        try { resolve(JSON.parse(out)); } catch (cause) { reject(cause); }
      });
    })));
    assert.equal(results.filter((result) => result === 'ran').length, 1);
    assert.equal(results.filter((result) => result?.skipped === SKIPPED.skipped).length, 1);
  });
});

test('a writer paused before publishing its PID cannot lose its lock', { timeout: 10_000 }, async () => {
  await withLockFile(async (lock) => {
    const module = new URL('../src/scribe.mjs', import.meta.url).href;
    const script = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { join } from 'node:path';
      const home = process.env.SUMO_AGENTS_HOME, who = process.env.LOCK_CONTENDER;
      const ready = join(home, 'publication.ready');
      const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
      if (who === 'A') {
        const write = fs.writeSync;
        fs.writeSync = (...args) => {
          const then = new Date(Date.now() - 10 * 60_000);
          fs.utimesSync(join(home, 'scribe.lock'), then, then);
          fs.writeFileSync(ready, 'ready');
          pause(500);
          return write(...args);
        };
        syncBuiltinESMExports();
      } else {
        const end = Date.now() + 3000;
        while (!fs.existsSync(ready) && Date.now() < end) pause(5);
        if (!fs.existsSync(ready)) throw new Error('writer did not reach PID publication');
      }
      const { withLock } = await import(${JSON.stringify(module)});
      console.log(JSON.stringify(await withLock('scribe', async () => {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        return 'ran';
      })));
    `;
    const results = await Promise.all(['A', 'B'].map((who) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', '--input-type=module', '-e', script], { env: { ...process.env, LOCK_CONTENDER: who }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = '', err = '';
      child.stdout.on('data', (chunk) => { out += chunk; });
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code !== 0) return reject(new Error(err));
        try { resolve(JSON.parse(out)); } catch (cause) { reject(cause); }
      });
    })));
    assert.equal(results.filter((result) => result === 'ran').length, 1);
    assert.equal(results.filter((result) => result?.skipped === SKIPPED.skipped).length, 1);
    assert.equal(existsSync(lock), false);
  });
});

test('a backlog of pasted logs is read a batch at a time that fits the local model, never one batch too big to ever pass', async () => {
  const { openDb } = await import('../src/db.mjs');
  const { buildBundle } = await import('../src/scribe.mjs');
  const { ensureSession, markScribed, pendingTurns, recordTurn } = await import('../src/sessions.mjs');
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const now = '2026-10-05T00:00:00.000Z';
      ensureSession(db, { id: 's1', now });
      const trace = (i) => `turn ${i} failed:\n${'    at Object.<anonymous> (/srv/app/node_modules/x/index.js:12:34)\n'.repeat(60)}`;
      for (let i = 0; i < 40; i++) recordTurn(db, { sessionId: 's1', text: trace(i), now });
      const sizes = [];
      for (let run = 0; run < 40 && pendingTurns(db).length > 0; run++) {
        const bundle = buildBundle(db);
        sizes.push(bundle.prompt.length);
        markScribed(db, [...bundle.turns.keys()]);
      }
      assert.equal(pendingTurns(db).length, 0, 'every turn is read in the end');
      assert.ok(Math.max(...sizes) < 50_000, `largest batch ${Math.max(...sizes)} characters`);
    } finally {
      db.close();
    }
  });
});
