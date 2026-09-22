import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-agent', cwd: '/work/home' };
const TASK = '## Goal\nDo the thing.\n## Check\n`make test` exits 0.\n';

function withSimba(s) {
  const dir = join(s.root, 'proj-simba');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'go.mod'), 'module simba\n');
  s.mem(['project', 'add', dir, '--alias', 'simba']);
  return dir;
}

const agentCall = (s, tool_input, extra = {}) => s.hook('pre-tool', { ...SESSION, tool_name: 'Agent', tool_input, ...extra });
const decision = (run) => (run.out ? JSON.parse(run.out).hookSpecificOutput : null);

test('an Agent call that names a job is rewritten to that job\'s route, and the call is logged', () => {
  const s = sandbox();
  withSimba(s);
  const created = s.mem(['job', 'new', '--project', 'simba', '--title', 'fix it', '--model', 'opus', '--effort', 'xhigh'], { input: TASK });
  assert.match(created.out, /^created j1 /);

  const run = agentCall(s, { description: 'run the job', prompt: 'JOB: run `mem job brief 1` and follow it exactly.', subagent_type: 'general-purpose', model: 'sonnet' });
  const held = decision(run);
  assert.equal(held.hookEventName, 'PreToolUse');
  assert.equal(held.permissionDecision, 'allow');
  assert.equal(held.updatedInput.model, 'opus');
  assert.equal(held.updatedInput.subagent_type, 'worker-xhigh');
  assert.equal(held.updatedInput.description, 'run the job', 'the rest of the call is passed through untouched');
  assert.equal(held.updatedInput.prompt, 'JOB: run `mem job brief 1` and follow it exactly.');

  const log = readFileSync(join(s.home, 'jobs', '1', 'route.log'), 'utf8');
  assert.match(log, /requested=sonnet\/general-purpose applied=opus\/worker-xhigh/);
});

test('a scout job routes to the plain "scout" sub-agent, not "scout-none"', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'look', '--agent', 'scout'], { input: TASK });
  const held = decision(agentCall(s, { prompt: 'JOB: run `mem job brief 1` and follow it exactly.', subagent_type: 'general-purpose' }));
  assert.equal(held.updatedInput.model, 'haiku');
  assert.equal(held.updatedInput.subagent_type, 'scout');
});

test('an Agent call naming no job, or an unknown one, is left untouched', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'fix it'], { input: TASK });

  assert.equal(agentCall(s, { prompt: 'Please go read the README and summarize it.', subagent_type: 'general-purpose' }).out, '');
  assert.equal(agentCall(s, { prompt: 'JOB: run `mem job brief 99` and follow it exactly.', subagent_type: 'general-purpose' }).out, '');
});

test('a job with no recorded route (from before this migration) is left untouched', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'fix it'], { input: TASK });
  s.sql((db) => db.prepare('UPDATE jobs SET model = NULL, effort = NULL WHERE id = 1').run());

  assert.equal(agentCall(s, { prompt: 'JOB: run `mem job brief 1` and follow it exactly.', subagent_type: 'general-purpose' }).out, '');
});

test('a non-Agent tool call is never rewritten, and the guard still runs first for Bash and Read', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'fix it'], { input: TASK });

  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'Write', tool_input: { file_path: '/x/y.md', prompt: 'mem job brief 1' } }).out, '');

  const blocked = decision(s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command: 'rm -rf /' } }));
  assert.equal(blocked.permissionDecision, 'deny');
});

test('a job whose effort is none routes to the plain role sub-agent, not "worker-none"', () => {
  const s = sandbox();
  withSimba(s);
  s.mem(['job', 'new', '--project', 'simba', '--title', 'fix it', '--model', 'haiku'], { input: TASK });
  const held = decision(agentCall(s, { prompt: 'JOB: run `mem job brief 1` and follow it exactly.', subagent_type: 'general-purpose' }));
  assert.equal(held.updatedInput.model, 'haiku');
  assert.equal(held.updatedInput.subagent_type, 'worker');
  assert.ok(existsSync(join(REPO_ROOT, '.claude', 'agents', `${held.updatedInput.subagent_type}.md`)), 'the sub-agent it names exists');
});
