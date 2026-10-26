// The harder eval tasks judged before they judge anything, as test/coding-eval.test.mjs judges the first eight: each has a
// way to be done wrong that the score sees, and a stand-in that does each one right passes it through the real job.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { closeMcp } from '../src/mcp.mjs';
import { REPO_ROOT } from '../src/paths.mjs';
import { resultLine, runTask, scoreWork, seed } from '../probes/coding-eval.mjs';
import { HARD_TASKS } from '../probes/coding-eval-hard.mjs';
import { TASKS } from '../probes/coding-eval-tasks.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

const task = (id) => HARD_TASKS.find((t) => t.id === id);

/** Each task done right: the files as they should be left, or the report a scout should give. */
const RIGHT = {
  'memo-recompute': {
    'src/lru.js': task('memo-recompute').files['src/lru.js']
      .replace('  get(key) {\n    return this.map.get(key);\n  }', '  get(key) {\n    if (!this.map.has(key)) return undefined;\n    const value = this.map.get(key);\n    this.map.delete(key);\n    this.map.set(key, value);\n    return value;\n  }\n\n  has(key) {\n    return this.map.has(key);\n  }')
      .replace('  set(key, value) {\n    this.map.set(key, value);', '  set(key, value) {\n    this.map.delete(key);\n    this.map.set(key, value);'),
    'src/memo.js': task('memo-recompute').files['src/memo.js'].replace('    const hit = cache.get(arg);\n    if (hit !== undefined) return hit;\n', '    if (cache.has(arg)) return cache.get(arg);\n'),
    'test/causes.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { LRU } from '../src/lru.js';\nimport { memoize } from '../src/memo.js';\n\ntest('reading keeps an entry', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('a'), 1); });\ntest('undefined is kept', () => { let n = 0; const f = memoize(() => { n++; }); f(1); f(1); assert.equal(n, 1); });\n",
  },
  'csv-quotes': {
    'src/csv.js': [
      '/** The rows of a CSV text, each an array of its fields. */',
      'export function parseCsv(text) {',
      '  const rows = [];',
      '  let row = [];',
      "  let field = '';",
      '  let quoted = false;',
      '  const end = () => {',
      "    if (row.length > 0 || field !== '') rows.push([...row, field]);",
      '    row = [];',
      "    field = '';",
      '  };',
      '  for (let i = 0; i < text.length; i++) {',
      '    const c = text[i];',
      '    if (quoted) {',
      "      if (c === '\"' && text[i + 1] === '\"') {",
      "        field += '\"';",
      '        i++;',
      "      } else if (c === '\"') quoted = false;",
      '      else field += c;',
      "    } else if (c === '\"') quoted = true;",
      "    else if (c === ',') {",
      '      row.push(field);',
      "      field = '';",
      "    } else if (c === '\\n') end();",
      "    else if (c !== '\\r' || text[i + 1] !== '\\n') field += c;",
      '  }',
      '  end();',
      '  return rows;',
      '}',
      '',
    ].join('\n'),
  },
  'retry-backoff': {
    'src/retry.js': "const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));\n\n/** Calls `fn`, and calls it again when it fails. */\nexport async function retry(fn, { attempts = 3, baseMs = 100, maxMs = 2000, sleep = wait } = {}) {\n  for (let n = 1; ; n++) {\n    try {\n      return await fn();\n    } catch (error) {\n      if (error?.retryable === false || n >= attempts) throw error;\n      await sleep(Math.min(maxMs, baseMs * 2 ** (n - 1)));\n    }\n  }\n}\n",
    'test/retries.test.js': "import assert from 'node:assert/strict';\nimport { test } from 'node:test';\nimport { retry } from '../src/retry.js';\n\ntest('it retries', async () => { let n = 0; assert.equal(await retry(async () => { if (++n < 2) throw new Error('x'); return 'ok'; }, { sleep: async () => {} }), 'ok'); });\n",
  },
  'dead-exports': '## Summary\n`whisper` (src/text.js) is named only in a comment and used only by a test; `format` (src/format.js) is imported only by a test. `shout` is called through the `text` namespace with its name in a string, `trimAll` is used by format.js, and `slugTitle` is re-exported by src/index.js and used by bin/cli.js.\n\nUNUSED: whisper, format\n',
};

const reply = (stop, content) => ({ stop_reason: stop, content, usage: { input_tokens: 100, output_tokens: 10 }, model: 'claude-sonnet-5-5' });
const call = (id, name, input) => ({ type: 'tool_use', id, name, input });
/** A shell command that leaves `files` as given. */
const write = (files) => `node -e 'const fs = require("fs"), path = require("path"); for (const [p, c] of Object.entries(JSON.parse(Buffer.from(process.argv[1], "base64").toString()))) { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); }' ${Buffer.from(JSON.stringify(files)).toString('base64')}`;

/**
 * A stand-in for the model: it leaves `work`, then says DONE with `report` for as long as DONE is neither taken nor
 * refused (a check before DONE counts may answer the first one), and FAILED once it is refused.
 */
function agent({ work = null, report = '## Summary\nDone.\n' } = {}) {
  let step = 0;
  return async (params) => {
    step++;
    const last = params.messages.at(-1).content;
    const results = Array.isArray(last) ? last.filter((b) => b.type === 'tool_result') : [];
    const asked = results.some((b) => /is not closed yet — before DONE counts/.test(b.content));
    const refused = !asked && results.some((b) => b.is_error);
    if (step === 1 && work) return reply('tool_use', [call('w1', 'bash', { command: write(work) })]);
    if (step > 6) return reply('end_turn', [{ type: 'text', text: 'closed' }]);
    if (refused) return reply('tool_use', [call(`f${step}`, 'finish', { status: 'FAILED', report: '## Summary\nThe checks do not pass.\n' })]);
    return reply('tool_use', [call(`f${step}`, 'finish', { status: 'DONE', report })]);
  };
}

/** A home of its own with a router that answers at once. */
async function inHome(fn) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-eval-hard-'));
  const routerAnswer = join(root, 'router-answer.json');
  writeFileSync(routerAnswer, JSON.stringify({ is_error: false, result: '', structured_output: { kind: 'routine', surface: 'a few files', risky: false, model: 'sonnet', effort: 'low', reason: 'a stand-in' }, usage: { input_tokens: 0, output_tokens: 0 }, total_cost_usd: 0 }));
  const env = { SUMO_AGENTS_MODEL_CMD: join(REPO_ROOT, 'test', 'fixtures', 'model-stub.mjs'), STUB_ROUTER_ANSWER: routerAnswer, SUMO_AGENTS_SPAWN_LOG: join(root, 'spawned.log') };
  return withHome(freshHome(), env, async () => {
    const mark = process.env.NODE_TEST_CONTEXT;
    delete process.env.NODE_TEST_CONTEXT;
    const db = openDb();
    try {
      return await fn(db);
    } finally {
      if (mark !== undefined) process.env.NODE_TEST_CONTEXT = mark;
      db.close();
      await closeMcp();
    }
  });
}

test('every hard task can be run and scored, doing nothing fails it, and its id is not taken', () => {
  const ids = [...TASKS, ...HARD_TASKS].map((t) => t.id);
  assert.equal(new Set(ids).size, ids.length, 'each id once, across both sets');
  for (const t of HARD_TASKS) {
    for (const heading of ['## Goal', '## Non-goals', '## Must not change', '## Check', '## Report']) assert.ok(t.brief.includes(heading), `${t.id}: the brief has ${heading}`);
    assert.ok(t.agent === 'scout' ? t.answers : t.hidden, `${t.id}: something only the score knows`);
    for (const path of t.unchanged ?? []) assert.ok(path in t.files, `${t.id}: ${path} is one of its files`);
    assert.ok(RIGHT[t.id], `${t.id}: a right answer to test the score with`);
    const scored = scoreWork(t, seed(t, mkdtempSync(join(tmpdir(), `sumo-agents-eval-seed-${t.id}-`))), '');
    assert.ok(scored.some((c) => !c.ok), `${t.id}: doing nothing does not pass`);
    if (t.hidden) assert.notEqual(scored.find((c) => c.name === 'the hidden tests pass').detail, 'no hidden test ran', t.id);
  }
});

test('fixing one cause of two is not enough: the memo task needs both', () => {
  const t = task('memo-recompute');
  const halfway = seed(t, mkdtempSync(join(tmpdir(), 'sumo-agents-eval-half-')));
  writeFileSync(join(halfway, 'src/lru.js'), RIGHT['memo-recompute']['src/lru.js']);
  writeFileSync(join(halfway, 'test/causes.test.js'), RIGHT['memo-recompute']['test/causes.test.js']);
  const hidden = scoreWork(t, halfway, '').find((c) => c.name === 'the hidden tests pass');
  assert.equal(hidden.ok, false);
  assert.match(hidden.detail, /undefined is kept/);
});

test('a stand-in that does each hard task right passes every one, through the real job', async () => {
  await inHome(async (db) => {
    for (const t of HARD_TASKS) {
      const r = await runTask(db, t, { send: agent(t.agent === 'scout' ? { report: RIGHT[t.id] } : { work: RIGHT[t.id] }) });
      assert.deepEqual([r.id, r.passed, r.status, r.falseDone, r.failed], [r.id, true, 'done', false, []], resultLine(r));
    }
  });
});
