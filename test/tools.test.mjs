// The group kill reaches only the group it was given: a spawn that failed reports pid 0, and -0 is 0, the caller's own group.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/paths.mjs';

test('killing the group of a spawn that never happened leaves the caller alive', () => {
  const tools = pathToFileURL(join(REPO_ROOT, 'src', 'tools.mjs')).href;
  // In a group of its own, so a kill that did reach the caller's group ends only this child, which the exit then shows.
  const run = spawnSync(
    process.execPath,
    ['--input-type=module', '-e', `import { killGroup } from ${JSON.stringify(tools)}; killGroup(0); killGroup(undefined); killGroup(NaN); console.log('alive');`],
    { detached: true, encoding: 'utf8', timeout: 20_000 },
  );
  assert.equal(run.signal, null, `the caller was signalled: ${run.signal}`);
  assert.equal(run.stdout.trim(), 'alive');
});

test('a command\'s output comes back in the order it was printed, and a flood is held only at its ends, with the cut counted whole', async () => {
  const { runBash, runCommand } = await import('../src/tools.mjs');
  const ctx = { cwd: REPO_ROOT, roots: [REPO_ROOT], env: { PATH: process.env.PATH } };
  const mixed = await runBash({ command: 'echo compiling a.c; echo "a.c:3: error" >&2; sleep 0.05; echo compiling b.c' }, ctx);
  assert.equal(mixed.content, 'compiling a.c\na.c:3: error\ncompiling b.c');

  const flood = await runCommand(`${JSON.stringify(process.execPath)} -e "process.stdout.write('S' + 'x'.repeat(2_000_000) + 'E')"`, { cwd: REPO_ROOT, env: { PATH: process.env.PATH } });
  assert.ok(flood.output.length <= 128 * 1024, `held ${flood.output.length} characters`);
  assert.equal(flood.output.length + flood.omitted, 2_000_002);
  assert.ok(flood.output.startsWith('S') && flood.output.endsWith('E'));
  const shown = await runBash({ command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(2_000_000))"` }, ctx);
  assert.match(shown.content, /\[cut 1984000 characters from the middle/);
});
