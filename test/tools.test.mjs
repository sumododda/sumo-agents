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
