import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-w', cwd: '/work/home' };
const PR_STEPS = '1. run every CI check locally and make sure it passes\n2. create the tracking story first\n3. only then open the PR, with the story number in the title\n';

const teachPr = (s, extra = []) => s.mem(['learn', 'Creating a PR', '--cue', 'create a PR', ...extra], { input: PR_STEPS });
const bash = (s, command, more = {}) => s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command }, ...more });
const decision = (run) => (run.out ? JSON.parse(run.out).hookSpecificOutput : null);

test('an agent about to do what a workflow covers is stopped and handed the steps — once', () => {
  const s = sandbox();
  teachPr(s);

  // The real failure: deep in a task, the agent commits, pushes and reaches for `pr create` on its own.
  assert.equal(bash(s, 'git add -A && git commit -m "fix: login form"').out, '');
  assert.equal(bash(s, 'git push -u origin fix/login-form-validation').out, '');

  const held = decision(bash(s, 'gh-axi pr create --title "fix(auth): rework login form"'));
  assert.equal(held.hookEventName, 'PreToolUse');
  assert.equal(held.permissionDecision, 'deny');
  assert.match(held.permissionDecisionReason, /^Not yet\. The user taught a workflow for exactly this/);
  assert.match(held.permissionDecisionReason, /<workflow m1 "Creating a PR">\n1\. run every CI check locally[\s\S]*3\. only then open the PR/);
  assert.match(held.permissionDecisionReason, /then run the command again\.$/);

  // The steps are now in front of it, so the retry goes through. The gate informs; it does not argue.
  assert.equal(bash(s, 'gh-axi pr create --title "fix(auth): rework login form"').out, '');
  assert.equal(bash(s, 'gh pr create --fill').out, '');
});

test('the same workflow rides in with the user\'s message when they ask for the thing', () => {
  const s = sandbox();
  teachPr(s);

  assert.equal(s.hook('prompt', { ...SESSION, prompt: 'what does this test do?' }).out, '');
  const asked = s.hook('prompt', { ...SESSION, prompt: 'looks good, commit it and create the PR' }).out;
  assert.match(asked, /^The user taught a workflow for what they are asking — follow it exactly, in order:\n<workflow m1 "Creating a PR">/);
  assert.match(asked, /2\. create the tracking story first/);

  assert.equal(s.hook('prompt', { ...SESSION, prompt: 'and create a PR for the docs too' }).out, '', 'once per session is enough');
  assert.equal(bash(s, 'gh pr create --fill').out, '', 'and the gate knows the steps were already given');

  // "PR" and "pull request" are the same thing, whichever way round the cue and the message say it.
  const other = sandbox();
  other.mem(['learn', 'PR creation', '--cue', 'create a pull request'], { input: PR_STEPS });
  assert.match(other.hook('prompt', { ...SESSION, prompt: 'ship it: create the PR' }).out, /<workflow m1 /);
  assert.match(s.hook('prompt', { session_id: 'third', prompt: 'please create a pull request for this' }).out, /<workflow m1 /);

  // Word forms do not matter: "creating PRs" is the same request.
  assert.match(s.hook('prompt', { session_id: 'another', prompt: 'I will be creating PRs all day' }).out, /<workflow m1 /);
});

test('the gate never blocks mem itself, other tools, or a command that only shares one ordinary word', () => {
  const s = sandbox();
  teachPr(s);
  s.mem(['learn', 'ship it', '--cue', 'ship'], { input: '1. tag\n2. push the tag\n' });

  assert.equal(bash(s, 'mem learn "Creating a PR v2" --cue "create a PR" --from-file steps.md').out, '');
  assert.equal(bash(s, 'cd /Users/x/sumo-agents && mem show m1').out, '');
  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'Write', tool_input: { file_path: '/x/create-pr.md', command: 'create pr' } }).out, '');
  assert.equal(bash(s, 'ls shipping/ && cat ship.log').out, '', 'a one-word cue is too easy to hit by accident to gate a command');
  assert.match(s.hook('prompt', { ...SESSION, prompt: 'ok ship it' }).out, /<workflow m2 "ship it">/, 'but it still answers the user asking for it');
});

test('a sub-agent has its own context, so it is given the steps even if the main agent already was', () => {
  const s = sandbox();
  teachPr(s);
  assert.equal(decision(bash(s, 'gh pr create --fill')).permissionDecision, 'deny');
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  const worker = { agent_id: 'agent-7', agent_type: 'worker' };
  assert.equal(decision(bash(s, 'gh pr create --fill', worker)).permissionDecision, 'deny');
  assert.equal(bash(s, 'gh pr create --fill', worker).out, '');
});

test('a project\'s workflow applies only once that project has come up; after a compaction the steps can come back', () => {
  const s = sandbox();
  const dir = join(s.root, 'proj-simba');
  mkdirSync(dir);
  writeFileSync(join(dir, 'go.mod'), 'module simba\n');
  s.mem(['project', 'add', dir, '--alias', 'simba']);
  teachPr(s, ['--project', 'simba']);

  assert.equal(bash(s, 'gh pr create --fill').out, '', 'nothing in this session is about simba yet');
  s.hook('prompt', { ...SESSION, prompt: 'let us work on simba' });
  assert.equal(decision(bash(s, 'gh pr create --fill')).permissionDecision, 'deny');
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  s.hook('session-start', { ...SESSION, source: 'compact' });
  s.hook('prompt', { ...SESSION, prompt: 'back to simba' });
  assert.equal(decision(bash(s, 'gh pr create --fill')).permissionDecision, 'deny', 'the steps left the context with the compaction');
});

test('a stated gate decides exactly which commands wait — no accidental matches, no near-misses', () => {
  const s = sandbox();
  const taught = s.mem(['learn', 'Creating a PR', '--cue', 'create a PR', '--gate', 'gh(-axi)? pr create|glab mr create'], { input: PR_STEPS });
  assert.equal(taught.code, 0, taught.err);
  assert.match(taught.out, /gates shell commands matching: gh\(-axi\)\? pr create\|glab mr create/, 'the person teaching sees what will be held back');
  assert.match(s.mem(['show', 'm1']).out, /^gate: gh\(-axi\)\? pr create\|glab mr create {3}\(shell commands matching this wait/m);

  // Guessing from the cue's words would have held this one back; the stated gate does not.
  assert.equal(bash(s, 'grep -rn "create pr" docs/').out, '');
  assert.equal(bash(s, 'echo "remember to create the PR later"').out, '');

  // And it catches a command the cue's words would have missed entirely.
  const other = sandbox();
  other.mem(['learn', 'Creating a PR', '--cue', 'open a pull request', '--gate', 'gh(-axi)? pr create|glab mr create'], { input: PR_STEPS });
  assert.equal(decision(bash(other, 'glab mr create --title x')).permissionDecision, 'deny');

  assert.equal(decision(bash(s, 'gh-axi pr create --title "fix: login form"')).permissionDecision, 'deny');
  assert.equal(bash(s, 'GH-AXI PR CREATE --fill').out, '', 'shown once; and matching ignores case');

  // The user asking for it is still matched by the cue — a gate is about commands only.
  assert.match(s.hook('prompt', { session_id: 'fresh', prompt: 'ok create the PR' }).out, /<workflow m1 /);
});

test('a gate can be put on a workflow that already exists, and taken off again', () => {
  const s = sandbox();
  teachPr(s);
  assert.equal(decision(bash(s, 'grep "create pr" notes.md', { session_id: 'a' })).permissionDecision, 'deny', 'with no gate, the cue words are the guess');

  const set = s.mem(['gate', 'm1', 'gh(-axi)? pr create']);
  assert.match(set.out, /^m1 \[proc·global·stated\] "Creating a PR" — when: create a PR\ngates shell commands matching: gh\(-axi\)\? pr create/);
  assert.equal(bash(s, 'grep "create pr" notes.md', { session_id: 'b' }).out, '');
  assert.equal(decision(bash(s, 'gh pr create --fill', { session_id: 'b' })).permissionDecision, 'deny');

  assert.match(s.mem(['gate', 'm1', 'off']).out, /no gate — its cue words are matched instead/);
  assert.equal(decision(bash(s, 'grep "create pr" notes.md', { session_id: 'c' })).permissionDecision, 'deny');
});

test('a gate that is broken or would hold back everything is refused when it is written, not discovered later', () => {
  const s = sandbox();
  for (const [gate, message] of [
    ['gh pr (create', /not a valid regular expression/],
    ['.*', /too broad — it would hold back "every command"/],
    ['git', /too broad — it would hold back "git status"/],
    ['xq', /too short to mean one command/],
  ]) {
    const run = s.mem(['learn', 'Creating a PR', '--cue', 'create a PR', '--gate', gate], { input: PR_STEPS });
    assert.equal(run.code, 2, gate);
    assert.match(run.err, message);
  }
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), 0, 'a refused gate saves nothing');

  s.mem(['add', 'preference', 'be concise']);
  assert.match(s.mem(['gate', 'm1', 'gh pr create']).err, /m1 is not a workflow/);
});

test('a memory from before gates existed upgrades in place and keeps working', () => {
  const s = sandbox();
  teachPr(s);
  s.mem(['add', 'preference', 'be concise']);
  // Put the database back to the shape it had in the previous release.
  s.sql((db) => {
    db.exec('ALTER TABLE memories DROP COLUMN gate');
    db.exec('PRAGMA user_version = 3');
  });

  assert.match(s.mem(['search', 'concise']).out, /m2 .*be concise/, 'opening it migrates it; nothing is lost');
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  assert.equal(decision(bash(s, 'gh pr create --fill')).permissionDecision, 'deny', 'the old workflow still triggers by its cue');
  assert.match(s.mem(['gate', 'm1', 'gh pr create']).out, /gates shell commands matching/);
});

test('a forgotten workflow stops triggering, and a broken memory never blocks a command', () => {
  const s = sandbox();
  teachPr(s);
  s.mem(['forget', 'm1']);
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  const broken = sandbox();
  mkdirSync(broken.home, { recursive: true });
  writeFileSync(join(broken.home, 'memory.db'), 'not a database');
  const run = bash(broken, 'gh pr create --fill');
  assert.deepEqual([run.code, run.out, run.err], [0, '', '']);
});
