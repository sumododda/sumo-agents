import assert from 'node:assert/strict';
import { test } from 'node:test';
import { guardCommand, guardPath, isSecretPath } from '../src/guard.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-g', cwd: '/work/proj' };
const decision = (run) => (run.out ? JSON.parse(run.out).hookSpecificOutput : null);

test('a command that would wipe a tree, throw away history or empty a database is refused, and the refusal says why', () => {
  for (const command of [
    'rm -rf /',
    'rm -rf ~',
    'rm -rf $HOME',
    'rm -rf "${HOME}"',
    'rm -rf .',
    'rm -r ..',
    'rm -rf *',
    'rm -fr ~/proj-simba',
    'rm -rf ~/',
    'rm -rf /Users/',
    'rm -rf ./*',
    'rm -f -r .',
    'rm -rf /Users',
    'rm --recursive --force /etc',
    'sudo rm -rf /',
    'cd /tmp && rm -rf ~',
    'bash -c "rm -rf ~"',
    'git reset --hard',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'git clean --force',
    'git checkout -- .',
    'git restore .',
    'git branch -D feature/x',
    'git stash drop',
    'git stash clear',
    'psql -c "DROP TABLE users"',
    "mysql -e 'TRUNCATE TABLE orders'",
    'sqlite3 app.db "DROP DATABASE main"',
  ]) {
    const why = guardCommand(command);
    assert.ok(why, `should refuse: ${command}`);
    assert.match(why, /^Refused: /, command);
    assert.match(why, /they run it themselves/, 'the user is always the way through');
  }
});

test('ordinary deletes, soft resets, single-file restores and force-pushes go through', () => {
  for (const command of [
    'rm -rf node_modules',
    'rm -rf ./dist',
    'rm -rf /tmp/build/out',
    'rm -f file.txt',
    'rm -f ~/.zcompdump',
    'rm -rf build/*',
    'git push --force origin main',
    'git push -f',
    'git reset --soft HEAD~1',
    'git reset HEAD src/a.js',
    'git checkout -- src/a.js',
    'git restore src/a.js',
    'git branch -d done',
    'git stash pop',
    'git clean -n',
    'npm test',
    'grep -rn "DROP TABLE" src/',
  ]) {
    assert.equal(guardCommand(command), null, `should allow: ${command}`);
  }
});

test('a command that would print a secret file is refused; sourcing it, listing it or reading an example is not', () => {
  for (const command of [
    'cat .env',
    'cat ./.env.local',
    'head -n 5 ~/.ssh/id_rsa',
    'grep KEY .env',
    'cat ~/.aws/credentials',
    'less certs/server.pem',
    'cat keys/private.key',
    'bat ~/.netrc',
    'sed -n 1,5p .env.production',
    'export $(cat .env | xargs)',
  ]) {
    const why = guardCommand(command);
    assert.ok(why, `should refuse: ${command}`);
    assert.match(why, /^Refused: .*secret/i, command);
  }
  for (const command of [
    'cat .env.example',
    'cat .env.sample',
    'cat ~/.ssh/known_hosts',
    'cat ~/.ssh/id_rsa.pub',
    'source .env && npm test',
    'set -a; . ./.env; set +a; npm start',
    'ls -la',
    'cp .env.example .env',
    'cat README.md',
    'cat src/environment.ts',
  ]) {
    assert.equal(guardCommand(command), null, `should allow: ${command}`);
  }
});

test('the same secret paths are known by name, for the file tool and for a change under review', () => {
  for (const path of ['/work/proj/.env', '.env.local', '/Users/x/.ssh/id_ed25519', '/Users/x/.aws/credentials', 'certs/server.pem', 'k.key', '/Users/x/.netrc']) {
    assert.ok(isSecretPath(path), path);
    assert.match(guardPath(path), /^Refused: /);
  }
  for (const path of ['/work/proj/.env.example', '/Users/x/.ssh/known_hosts', '/Users/x/.ssh/id_ed25519.pub', 'src/env.ts', 'docs/keys.md', 'README.md']) {
    assert.equal(isSecretPath(path), false, path);
    assert.equal(guardPath(path), null, path);
  }
});

test('the hook refuses before anything else runs — for a shell command and for the file tool alike', () => {
  const s = sandbox();
  const held = decision(s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command: 'git reset --hard' } }));
  assert.equal(held.hookEventName, 'PreToolUse');
  assert.equal(held.permissionDecision, 'deny');
  assert.match(held.permissionDecisionReason, /^Refused: `git reset --hard` throws away/);

  const read = decision(s.hook('pre-tool', { ...SESSION, tool_name: 'Read', tool_input: { file_path: '/work/proj/.env' } }));
  assert.equal(read.permissionDecision, 'deny');
  assert.match(read.permissionDecisionReason, /^Refused: .*secret/i);

  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'Read', tool_input: { file_path: '/work/proj/src/index.js' } }).out, '', 'an ordinary read costs nothing');
  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command: 'npm test' } }).out, '');
});
