// The model_runs ledger: the cache split, the job and session a call belongs to, and the upgrade that added them.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb, SCHEMA_VERSION, schemaVersion } from '../src/db.mjs';
import { callModel, logRun } from '../src/model.mjs';
import { paths, REPO_ROOT } from '../src/paths.mjs';
import { modelStats } from '../src/scribe.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const NOW = '2026-09-30T12:00:00.000Z';
const usage = (extra = {}) => ({ inputTokens: 100, outputTokens: 10, costUsd: 0.001, ...extra });

test('a ledger from before the cache columns migrates, keeps its rows, and reads them back as NULL', async () => {
  await withHome(freshHome(), {}, async () => {
    const file = paths().db;
    let db = openDb(file);
    logRun(db, { kind: 'scribe', model: 'haiku', result: { ok: true, usage: usage() }, note: 'old row', now: NOW });
    // Put model_runs back to the shape it had in the previous release.
    for (const column of ['cache_read_tokens', 'cache_creation_tokens', 'job_id', 'session_id']) db.exec(`ALTER TABLE model_runs DROP COLUMN ${column}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();

    db = openDb(file);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      const rows = db.prepare('SELECT * FROM model_runs').all();
      assert.equal(rows.length, 1);
      assert.deepEqual(
        { ...rows[0], id: undefined },
        { id: undefined, ts: NOW, kind: 'scribe', model: 'haiku', input_tokens: 100, output_tokens: 10, cost_usd: 0.001, ok: 1, note: 'old row', cache_read_tokens: null, cache_creation_tokens: null, job_id: null, session_id: null },
      );
      assert.deepEqual(modelStats(db), ['scribe: 1 runs (1 ok) · 100 tokens in · 10 out · $0.0010 · cache 0 read · 0 written']);
    } finally {
      db.close();
    }
  });
});

test('a half-applied upgrade that already has some of the cache columns adds only the missing ones', async () => {
  await withHome(freshHome(), {}, async () => {
    const file = paths().db;
    let db = openDb(file);
    logRun(db, { kind: 'scribe', model: 'haiku', result: { ok: true, usage: usage() }, note: 'old row', now: NOW });
    for (const column of ['job_id', 'session_id']) db.exec(`ALTER TABLE model_runs DROP COLUMN ${column}`);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION - 1}`);
    db.close();

    db = openDb(file);
    try {
      assert.equal(schemaVersion(db), SCHEMA_VERSION);
      const columns = db.prepare('PRAGMA table_info(model_runs)').all().map((c) => `${c.name} ${c.type}`);
      assert.deepEqual(columns.slice(-4), ['cache_read_tokens INTEGER', 'cache_creation_tokens INTEGER', 'job_id INTEGER', 'session_id TEXT']);
      assert.equal(db.prepare('SELECT COUNT(*) AS n FROM model_runs').get().n, 1);
    } finally {
      db.close();
    }
  });
});

test('logRun writes the cache split, job and session, and NULL for whichever is not given', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      logRun(db, {
        kind: 'worker', model: 'sonnet', note: 'ok', now: NOW, jobId: 29, sessionId: 'sess-a',
        result: { ok: true, usage: usage({ cacheReadTokens: 3000, cacheCreationTokens: 200 }) },
      });
      logRun(db, { kind: 'scribe', model: 'haiku', note: 'ok', now: NOW, result: { ok: true, usage: usage() } });

      const cols = 'kind, cache_read_tokens, cache_creation_tokens, job_id, session_id';
      const rows = db.prepare(`SELECT ${cols} FROM model_runs ORDER BY id`).all().map((r) => ({ ...r }));
      assert.deepEqual(rows, [
        { kind: 'worker', cache_read_tokens: 3000, cache_creation_tokens: 200, job_id: 29, session_id: 'sess-a' },
        { kind: 'scribe', cache_read_tokens: null, cache_creation_tokens: null, job_id: null, session_id: null },
      ]);
    } finally {
      db.close();
    }
  });
});

test('the stand-in envelope keeps inputTokens as the total and carries the cache split beside it', async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-model-cache-'));
  const answerFile = join(root, 'answer.json');
  const answer = (u) => writeFileSync(answerFile, JSON.stringify({ is_error: false, result: '', structured_output: { ok: 1 }, usage: u, total_cost_usd: 0.002 }));

  await withHome(freshHome(), { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ANSWER: answerFile }, async () => {
    const db = openDb();
    try {
      const ask = () => callModel(db, { system: 's', prompt: 'p', schema: { type: 'object' }, model: 'haiku' });

      answer({ input_tokens: 10, cache_read_input_tokens: 3000, cache_creation_input_tokens: 200, output_tokens: 5 });
      const cached = await ask();
      assert.equal(cached.ok, true, cached.error ?? '');
      assert.deepEqual(Object.keys(cached).sort(), ['data', 'error', 'ok', 'usage']);
      assert.deepEqual(cached.usage, { inputTokens: 3210, outputTokens: 5, costUsd: 0.002, cacheReadTokens: 3000, cacheCreationTokens: 200 });

      answer({ input_tokens: 10, output_tokens: 5 });
      assert.deepEqual((await ask()).usage, { inputTokens: 10, outputTokens: 5, costUsd: 0.002, cacheReadTokens: null, cacheCreationTokens: null });
    } finally {
      db.close();
    }
  });
});

test('modelStats prints, per kind, the cache-read and cache-write totals beside the existing numbers', async () => {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    try {
      const run = (kind, extra) => logRun(db, { kind, model: 'm', note: 'ok', now: NOW, result: { ok: true, usage: usage(extra) } });
      run('worker', { cacheReadTokens: 3000, cacheCreationTokens: 200 });
      run('worker', { cacheReadTokens: 1000, cacheCreationTokens: 50 });
      run('worker', {}); // a backend that reports no cache adds nothing to either total
      run('local', {});

      assert.deepEqual(modelStats(db), [
        'local: 1 runs (1 ok) · 100 tokens in · 10 out · $0.0010 · cache 0 read · 0 written',
        'worker: 3 runs (3 ok) · 300 tokens in · 30 out · $0.0030 · cache 4000 read · 250 written',
      ]);
    } finally {
      db.close();
    }
  });
});
