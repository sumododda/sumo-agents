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
  assert.ok(estimateTokens(read('prompts', 'agent.md')) <= 250, `prompts/agent.md is ${estimateTokens(read('prompts', 'agent.md'))} tokens`);
  for (const guide of readdirSync(join(REPO_ROOT, 'guides'))) {
    assert.ok(estimateTokens(read('guides', guide)) <= 550, `guides/${guide} is ${estimateTokens(read('guides', guide))} tokens`);
  }
  assert.ok(sandbox().mem(['help']).out.trim().split('\n').length <= 25, 'mem help fits on one screen');
});

test('one home per rule: nothing in AGENTS.md is said again in a guide or a model prompt', () => {
  const rules = read('AGENTS.md')
    .split('\n')
    .filter((l) => l.startsWith('- '))
    .map((l) => l.slice(2, 62).toLowerCase());
  assert.ok(rules.length >= 10);

  const elsewhere = [
    ...readdirSync(join(REPO_ROOT, 'guides')).map((f) => ['guides', f]),
    ...readdirSync(join(REPO_ROOT, 'prompts')).map((f) => ['prompts', f]),
  ];
  for (const parts of elsewhere) {
    const text = read(...parts).toLowerCase();
    for (const rule of rules) assert.equal(text.includes(rule), false, `${parts.join('/')} repeats: "${rule}…"`);
  }
});
