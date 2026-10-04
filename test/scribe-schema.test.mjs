// The writer's structured-output schema stays below Anthropic's grammar complexity limit by describing each operation separately.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { opsSchema } from '../src/scribe.mjs';
import { sandbox } from './helpers.mjs';

test('each memory operation has one closed branch with only its own required fields', () => {
  const s = sandbox();
  s.addProject('proj-simba');
  const schema = s.sql((db) => opsSchema(db, ['add', 'supersede', 'gotcha', 'checkpoint']));
  const branches = schema.properties.ops.items.anyOf;
  const byOp = Object.fromEntries(branches.map((branch) => [branch.properties.op.enum[0], branch]));

  assert.deepEqual(Object.keys(byOp), ['add', 'supersede', 'gotcha', 'checkpoint']);
  assert.deepEqual(Object.keys(byOp.add.properties), ['op', 'type', 'scope', 'topic', 'body', 'turn', 'quote']);
  assert.deepEqual(Object.keys(byOp.gotcha.properties), ['op', 'scope', 'body']);
  assert.deepEqual(Object.keys(byOp.checkpoint.properties), ['op', 'project', 'done', 'next']);
  for (const branch of branches) {
    assert.equal(branch.additionalProperties, false);
    assert.deepEqual(new Set(branch.required), new Set(Object.keys(branch.properties)), 'no optional-property combinations for the grammar to compile');
  }
  assert.equal(schema.additionalProperties, false);
});
