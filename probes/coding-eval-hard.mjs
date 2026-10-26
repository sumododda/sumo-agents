// The harder tasks of the coding eval: `--hard` runs them instead of the first eight, which every route now passes.
// They are scored the same way (see probes/coding-eval-tasks.mjs). Each has more than one thing wrong, or a spec with
// edges, or a reading trap — so a job that fixes the first cause it finds, or the case the visible test shows, and says
// DONE is caught by the hidden tests.

import { brief, pkg } from './coding-eval-tasks.mjs';

/** A file's lines, ending with a newline: the projects here are written out line by line so they read as code. */
const lines = (...l) => `${l.join('\n')}\n`;
const testHead = (from, names) => [`import assert from 'node:assert/strict';`, `import { test } from 'node:test';`, `import { ${names} } from '${from}';`, ''];

export const HARD_TASKS = [
  {
    id: 'memo-recompute',
    agent: 'worker',
    title: 'Memoized lookups are recomputed',
    // Two causes in two files: the cache forgets what was just read, and a result of `undefined` is never kept. Fixing one passes nothing.
    brief: brief({
      goal: 'Users report that memoized lookups are computed again far more often than they should be. `memoize` is in src/memo.js and keeps results in the LRU cache in src/lru.js, which should keep the `capacity` most recently *used* entries — reading an entry counts as using it. Find every cause, fix them, and add tests that would have caught each one.',
      mustNot: 'The signatures of `memoize` and of the `LRU` class (`new LRU(capacity)`, `get`, `set`, `size`). Existing tests.',
      check: '`npm test` passes, with a new test for each cause you found.',
      report: 'Each cause, the file it was in, and the fix.',
    }),
    files: {
      'package.json': pkg('memo'),
      'src/lru.js': lines(
        '/** A cache that keeps the `capacity` most recently used entries. */',
        'export class LRU {',
        '  constructor(capacity) {',
        '    this.capacity = capacity;',
        '    this.map = new Map();',
        '  }',
        '',
        '  get(key) {',
        '    return this.map.get(key);',
        '  }',
        '',
        '  set(key, value) {',
        '    this.map.set(key, value);',
        '    if (this.map.size > this.capacity) this.map.delete(this.map.keys().next().value);',
        '  }',
        '',
        '  get size() {',
        '    return this.map.size;',
        '  }',
        '}',
      ),
      'src/memo.js': lines(
        "import { LRU } from './lru.js';",
        '',
        '/** `fn` of one argument, computed once per argument while the argument stays among the `capacity` most recently used. */',
        'export function memoize(fn, capacity = 100) {',
        '  const cache = new LRU(capacity);',
        '  return (arg) => {',
        '    const hit = cache.get(arg);',
        '    if (hit !== undefined) return hit;',
        '    const value = fn(arg);',
        '    cache.set(arg, value);',
        '    return value;',
        '  };',
        '}',
      ),
      'test/memo.test.js': lines(
        ...testHead('../src/memo.js', 'memoize'),
        'test(\'the same argument is computed once\', () => {',
        '  let calls = 0;',
        '  const square = memoize((n) => { calls++; return n * n; });',
        '  assert.equal(square(4), 16);',
        '  assert.equal(square(4), 16);',
        '  assert.equal(calls, 1);',
        '});',
      ),
    },
    unchanged: ['test/memo.test.js'],
    added: /^test\/.+\.(test\.)?m?js$/,
    hidden: {
      'memo.hidden.test.mjs': lines(
        `import assert from 'node:assert/strict';`,
        `import { test } from 'node:test';`,
        `import { LRU } from '../src/lru.js';`,
        `import { memoize } from '../src/memo.js';`,
        '',
        "test('reading an entry keeps it', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.get('a'); c.set('c', 3); assert.equal(c.get('a'), 1); assert.equal(c.get('b'), undefined); });",
        "test('setting a key again refreshes it and does not grow the cache', () => { const c = new LRU(2); c.set('a', 1); c.set('b', 2); c.set('a', 9); c.set('c', 3); assert.equal(c.size, 2); assert.equal(c.get('a'), 9); assert.equal(c.get('b'), undefined); });",
        "test('the least recently used goes first, again and again', () => { const c = new LRU(2); for (const k of ['a', 'b', 'c', 'd']) c.set(k, k); assert.equal(c.size, 2); assert.equal(c.get('c'), 'c'); assert.equal(c.get('d'), 'd'); });",
        "test('a capacity of 0 keeps nothing', () => { const c = new LRU(0); c.set('a', 1); assert.equal(c.size, 0); assert.equal(c.get('a'), undefined); });",
        "test('a result of undefined is kept', () => { let calls = 0; const f = memoize(() => { calls++; return undefined; }); f(1); f(1); f(1); assert.equal(calls, 1); });",
        "test('an argument in steady use stays cached', () => { const seen = []; const f = memoize((k) => { seen.push(k); return k.toUpperCase(); }, 2); for (const k of ['a', 'b', 'a', 'c', 'a', 'd', 'a']) f(k); assert.equal(seen.filter((k) => k === 'a').length, 1); });",
      ),
    },
  },
  {
    id: 'csv-quotes',
    agent: 'worker',
    title: 'Quoted CSV fields are broken',
    // The visible test shows one case; a split that handles a comma inside quotes still breaks on doubled quotes, CRLF and a newline inside quotes.
    brief: brief({
      goal: '`parseCsv(text)` in src/csv.js returns the rows of a CSV text, each an array of its fields as strings. Quoted fields are broken. Make it follow the usual CSV rules: a field in double quotes may hold commas, newlines and doubled double quotes (`""` is one `"`, and the surrounding quotes are not part of the value); rows end with `\\n` or `\\r\\n`; a final newline does not make an extra row; a blank line is no row; an empty field is `""`.',
      mustNot: 'The signature of `parseCsv`. Existing tests.',
      check: '`npm test` passes — test/csv.test.js has a failing case.',
    }),
    files: {
      'package.json': pkg('csv'),
      'src/csv.js': lines(
        '/** The rows of a CSV text, each an array of its fields. */',
        'export function parseCsv(text) {',
        "  return text.split('\\n').filter((line) => line !== '').map((line) => line.split(','));",
        '}',
      ),
      'test/csv.test.js': lines(
        ...testHead('../src/csv.js', 'parseCsv'),
        "test('plain rows', () => assert.deepEqual(parseCsv('a,b\\nc,d\\n'), [['a', 'b'], ['c', 'd']]));",
        "test('a comma inside quotes stays in its field', () => assert.deepEqual(parseCsv('a,\"b,c\",d\\n'), [['a', 'b,c', 'd']]));",
      ),
    },
    unchanged: ['test/csv.test.js'],
    hidden: {
      'csv.hidden.test.mjs': lines(
        ...testHead('../src/csv.js', 'parseCsv'),
        "test('a doubled quote is one quote', () => assert.deepEqual(parseCsv('\"say \"\"hi\"\"\",x\\n'), [['say \"hi\"', 'x']]));",
        "test('windows line endings', () => assert.deepEqual(parseCsv('a,b\\r\\nc,d\\r\\n'), [['a', 'b'], ['c', 'd']]));",
        "test('a newline inside quotes', () => assert.deepEqual(parseCsv('\"one\\ntwo\",z\\n'), [['one\\ntwo', 'z']]));",
        "test('empty fields', () => assert.deepEqual(parseCsv('a,,c\\n'), [['a', '', 'c']]));",
        "test('no final newline', () => assert.deepEqual(parseCsv('a,b'), [['a', 'b']]));",
        "test('a blank line is no row', () => assert.deepEqual(parseCsv('a\\n\\nb\\n'), [['a'], ['b']]));",
        "test('a comma inside quotes, again', () => assert.deepEqual(parseCsv('\"x,y\",\"\"\\n'), [['x,y', '']]));",
      ),
    },
  },
  {
    id: 'retry-backoff',
    agent: 'worker',
    title: 'retry with backoff',
    // A spec with edges: the count of calls, no wait after the last one, the cap, and the error that must not be retried.
    brief: brief({
      goal: '`retry(fn, options)` in src/retry.js only calls `fn` once. Make it retry: it calls the async `fn` until it resolves, at most `attempts` calls in all (default 3), and resolves with what `fn` resolved with. Between one call and the next it awaits `sleep(ms)` — `options.sleep`, by default a real timer — where `ms` is `baseMs * 2 ** (n - 1)` after the n-th failed call, but never more than `maxMs` (defaults 100 and 2000). An error with `retryable === false` is thrown at once, without retrying. When the last call fails, its error is thrown as it is, with no wait after it.',
      mustNot: 'The signature of `retry`. Existing tests.',
      check: '`npm test` passes, with tests for the retries you added.',
    }),
    files: {
      'package.json': pkg('retry'),
      'src/retry.js': lines(
        '/** Calls `fn`, and calls it again when it fails. */',
        'export async function retry(fn, options = {}) {',
        '  return fn();',
        '}',
      ),
      'test/retry.test.js': lines(
        ...testHead('../src/retry.js', 'retry'),
        "test('a call that works is made once', async () => {",
        '  let calls = 0;',
        "  assert.equal(await retry(async () => { calls++; return 'ok'; }, { sleep: async () => {} }), 'ok');",
        '  assert.equal(calls, 1);',
        '});',
      ),
    },
    unchanged: ['test/retry.test.js'],
    added: /^test\/.+\.(test\.)?m?js$/,
    hidden: {
      'retry.hidden.test.mjs': lines(
        ...testHead('../src/retry.js', 'retry'),
        'const failing = (times, value = \'ok\') => { let n = 0; return async () => { n++; if (n <= times) throw new Error(`fail ${n}`); return value; }; };',
        "test('it retries until a call works', async () => { const waits = []; assert.equal(await retry(failing(2), { sleep: async (ms) => waits.push(ms) }), 'ok'); assert.deepEqual(waits, [100, 200]); });",
        "test('the waits double and stop at maxMs', async () => { const waits = []; await retry(failing(5), { attempts: 6, baseMs: 300, maxMs: 1000, sleep: async (ms) => waits.push(ms) }); assert.deepEqual(waits, [300, 600, 1000, 1000, 1000]); });",
        "test('the last error is thrown as it is, with no wait after it', async () => { const waits = []; const errors = []; const fn = async () => { const e = new Error('nope'); errors.push(e); throw e; }; await assert.rejects(retry(fn, { attempts: 3, sleep: async (ms) => waits.push(ms) }), (e) => e === errors[2]); assert.equal(errors.length, 3); assert.deepEqual(waits, [100, 200]); });",
        "test('an error that must not be retried is thrown at once', async () => { let calls = 0; const fn = async () => { calls++; throw Object.assign(new Error('bad input'), { retryable: false }); }; await assert.rejects(retry(fn, { sleep: async () => assert.fail('slept') }), /bad input/); assert.equal(calls, 1); });",
        "test('one attempt means no retry', async () => { let calls = 0; await assert.rejects(retry(async () => { calls++; throw new Error('x'); }, { attempts: 1, sleep: async () => assert.fail('slept') })); assert.equal(calls, 1); });",
        "test('the defaults allow three calls', async () => { const waits = []; await assert.rejects(retry(failing(9), { sleep: async (ms) => waits.push(ms) })); assert.deepEqual(waits, [100, 200]); });",
      ),
    },
  },
  {
    id: 'dead-exports',
    agent: 'scout',
    title: 'Which exports are never used',
    // Reading with traps: a use through a namespace and a string, a name only in a comment, a use only by the tests, and a
    // function used solely by a file that is itself dead — which still counts as used, as the brief defines it.
    brief: brief({
      goal: 'Which exported functions in this project are never used? An export counts as used when any file outside test/ imports and uses it — directly, through a re-export, or through an `import * as` namespace with its name in a string — even if that file is itself unused. A use only in test/ or only in a comment does not count. Describe only.',
      mustNot: 'Everything: this is reading.',
      check: 'None: nothing is changed.',
      report: 'Each unused export with its file, and why each near miss is used after all. End the report with one line, exactly in this shape, naming every unused export and nothing else: `UNUSED: name, name`',
    }),
    files: {
      'package.json': pkg('text-tools'),
      'src/text.js': lines(
        "export const slugTitle = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-');",
        "export const shout = (s) => s.toUpperCase() + '!';",
        'export const whisper = (s) => s.toLowerCase();',
        "export const trimAll = (s) => s.replace(/\\s+/g, ' ').trim();",
      ),
      'src/index.js': lines("export { slugTitle } from './text.js';"),
      'src/format.js': lines(
        "import { trimAll } from './text.js';",
        '',
        '// format() used to call whisper() on the result; it no longer does.',
        'export function format(s) {',
        '  return trimAll(s);',
        '}',
      ),
      'bin/cli.js': lines(
        "import { slugTitle } from '../src/index.js';",
        "import * as text from '../src/text.js';",
        '',
        "const style = process.argv.includes('--loud') ? 'shout' : 'slugTitle';",
        'console.log(slugTitle(process.argv[2] ?? \'\'));',
        "console.log(text[style]('done'));",
      ),
      'test/text.test.js': lines(
        `import assert from 'node:assert/strict';`,
        `import { test } from 'node:test';`,
        `import { format } from '../src/format.js';`,
        `import { whisper } from '../src/text.js';`,
        '',
        "test('format and whisper', () => { assert.equal(format('  a  b '), 'a b'); assert.equal(whisper('A'), 'a'); });",
      ),
    },
    // Not shout (a namespace call with its name in a string), not trimAll (used by format.js, dead or not), not slugTitle (a re-export).
    answers: { UNUSED: ['whisper', 'format'] },
  },
];
