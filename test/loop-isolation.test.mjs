import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';

test('the guarded-file test leaves the invoking user home untouched', () => {
  const home = mkdtempSync(join(tmpdir(), 'sumo-agents-invoking-home-'));
  mkdirSync(join(home, '.ssh'));
  const shell = '# my shell configuration\n';
  const keys = '# my authorized keys\n';
  writeFileSync(join(home, '.zshrc'), shell);
  writeFileSync(join(home, '.ssh', 'authorized_keys'), keys);

  const env = { ...process.env, HOME: home };
  delete env.NODE_TEST_CONTEXT;
  const output = execFileSync(process.execPath, ['--disable-warning=ExperimentalWarning', '--test', '--test-reporter=tap', '--test-name-pattern=^a guarded file', 'test/loop.test.mjs'], {
    cwd: REPO_ROOT,
    env,
    stdio: 'pipe',
    encoding: 'utf8',
  });

  assert.match(output, /^# tests 1$/m, 'the guarded-file test actually ran');
  assert.equal(readFileSync(join(home, '.zshrc'), 'utf8'), shell, 'the invoking user shell configuration must survive');
  assert.equal(readFileSync(join(home, '.ssh', 'authorized_keys'), 'utf8'), keys, 'the invoking user authorized keys must survive');
});
