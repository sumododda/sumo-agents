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
  // Not about the sandbox: where there is none, the first result of a process says so (test/sandbox.test.mjs).
  const ctx = { cwd: REPO_ROOT, roots: [REPO_ROOT], env: { PATH: process.env.PATH }, sandbox: false };
  const mixed = await runBash({ command: 'echo compiling a.c; echo "a.c:3: error" >&2; sleep 0.05; echo compiling b.c' }, ctx);
  assert.equal(mixed.content, 'compiling a.c\na.c:3: error\ncompiling b.c');

  const flood = await runCommand(`${JSON.stringify(process.execPath)} -e "process.stdout.write('S' + 'x'.repeat(2_000_000) + 'E')"`, { cwd: REPO_ROOT, env: { PATH: process.env.PATH } });
  assert.ok(flood.output.length <= 128 * 1024, `held ${flood.output.length} characters`);
  assert.equal(flood.output.length + flood.omitted, 2_000_002);
  assert.ok(flood.output.startsWith('S') && flood.output.endsWith('E'));
  const shown = await runBash({ command: `${JSON.stringify(process.execPath)} -e "process.stdout.write('x'.repeat(2_000_000))"` }, ctx);
  // One line too long to read: each end held is cut to its start, and the middle cut is what was never held.
  assert.match(shown.content, /^x{2000}\[… 63536 chars cut\]\n\[cut 1868928 characters from the middle — [^\n]+\]\nx{2000}\[… 63536 chars cut\]$/);
});

test('a command says what it prints as it prints it, to whoever is watching; what comes back at the end is the same', async () => {
  const { runCommand, runTool } = await import('../src/tools.mjs');
  const seen = [];
  const run = await runCommand('echo one; sleep 0.3; echo two >&2', { cwd: REPO_ROOT, env: { PATH: process.env.PATH }, onOutput: (chunk) => seen.push(chunk) });
  assert.equal(seen.join(''), 'one\ntwo\n');
  assert.ok(seen.length >= 2, 'as it came, not at the end');
  assert.equal(run.output, 'one\ntwo\n');

  const heard = [];
  const out = await runTool({ name: 'bash', input: { command: 'echo hi' } }, { cwd: REPO_ROOT, roots: [REPO_ROOT], env: { PATH: process.env.PATH }, sandbox: false }, { onOutput: (chunk) => heard.push(chunk) });
  assert.equal(out.content, 'hi');
  assert.equal(heard.join(''), 'hi\n', 'the shell tool passes it on');
});
