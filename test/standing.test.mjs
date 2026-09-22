import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';
import { estimateTokens } from '../src/text.mjs';
import { sandbox } from './helpers.mjs';

const read = (...parts) => readFileSync(join(REPO_ROOT, ...parts), 'utf8');

/**
 * Everything an agent is made to read before the user has typed a word.
 * These limits are the point of the project: raising one is a decision, not an accident.
 */
test('the standing prompt stays small', () => {
  // 650 rather than 600: the compact instructions have to live here, or a compaction never sees them.
  assert.ok(estimateTokens(read('AGENTS.md')) <= 650, `AGENTS.md is ${estimateTokens(read('AGENTS.md'))} tokens`);
  assert.equal(read('CLAUDE.md').trim(), '@AGENTS.md', 'CLAUDE.md only points at AGENTS.md');
  for (const guide of readdirSync(join(REPO_ROOT, 'guides'))) {
    assert.ok(estimateTokens(read('guides', guide)) <= 550, `guides/${guide} is ${estimateTokens(read('guides', guide))} tokens`);
  }
  assert.ok(sandbox().mem(['help']).out.trim().split('\n').length <= 25, 'mem help fits on one screen');
});

test('one home per rule: nothing in AGENTS.md is said again in a guide, an agent file or a model prompt', () => {
  const rules = read('AGENTS.md')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2, 62).toLowerCase());
  assert.ok(rules.length >= 10);

  const elsewhere = [
    ...readdirSync(join(REPO_ROOT, 'guides')).map((f) => ['guides', f]),
    ...readdirSync(join(REPO_ROOT, '.claude', 'agents')).map((f) => ['.claude', 'agents', f]),
    ...readdirSync(join(REPO_ROOT, 'prompts')).map((f) => ['prompts', f]),
  ];
  for (const parts of elsewhere) {
    const text = read(...parts).toLowerCase();
    for (const rule of rules) assert.equal(text.includes(rule), false, `${parts.join('/')} repeats: "${rule}…"`);
  }
});

test('Claude Code is wired to the launcher for all five events, with its own memory switched off', () => {
  const settings = JSON.parse(read('.claude', 'settings.json'));
  assert.equal(settings.autoMemoryEnabled, false);
  assert.ok(settings.permissions.allow.includes('Bash(mem *)'));
  for (const [event, name] of [['SessionStart', 'session-start'], ['UserPromptSubmit', 'prompt'], ['PreToolUse', 'pre-tool'], ['Stop', 'stop'], ['SessionEnd', 'session-end']]) {
    const command = settings.hooks[event][0].hooks[0].command;
    assert.ok(command.includes(`"$m" hook ${name} --harness claude`), event);
    assert.ok(command.includes('$HOME/.sumo-agents/bin/mem'), `${event} must not depend on PATH`);
  }
  assert.equal(settings.hooks.PreToolUse[0].matcher, 'Bash|AskUserQuestion|Read|Agent', 'shell commands for the guard and the workflow gate, questions for the memory gate, reads for secret files, agent starts for the route — no other tool pays for a hook');
  assert.match(settings.hooks.SessionStart[0].hooks[0].command, /launcher failed/, 'a broken launcher has to say so, not fail silently');
});

test('sub-agents run on cheaper models, the scout cannot edit, and neither works without a job', () => {
  const scout = read('.claude', 'agents', 'scout.md');
  const worker = read('.claude', 'agents', 'worker.md');
  assert.match(scout, /^model: haiku$/m);
  assert.match(worker, /^model: sonnet$/m);
  assert.match(scout, /^tools: Read, Grep, Glob, Bash$/m);
  for (const agent of [scout, worker]) assert.match(agent, /If it does not name a job, do no work\./);
});

test('the reviewer cannot edit, is never a weaker model than the one that writes the code, and does not work without a job', () => {
  const reviewer = read('.claude', 'agents', 'reviewer.md');
  const worker = read('.claude', 'agents', 'worker.md');
  assert.match(reviewer, /^tools: Read, Grep, Glob, Bash$/m);
  const strength = (text) => ['haiku', 'sonnet', 'opus'].indexOf(/^model: (\w+)$/m.exec(text)[1]);
  assert.ok(strength(reviewer) > strength(worker), 'a weaker judge makes the work worse, not better');
  assert.match(reviewer, /If it does not name a job, do no work\./);
  for (const name of ['fix', 'feature', 'review']) {
    assert.match(read('.claude', 'commands', `${name}.md`), new RegExp(`guides/${name}\\.md`), `/${name} points at its guide instead of repeating it`);
  }
});
