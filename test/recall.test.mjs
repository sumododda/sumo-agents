import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentProject } from '../src/sessions.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-r', cwd: '/work/home' };
const say = (s, prompt) => s.hook('prompt', { ...SESSION, prompt });
const stop = (s, reply, more = {}) => s.hook('stop', { ...SESSION, last_assistant_message: reply, stop_hook_active: false, ...more });
const feedback = (run) => (run.out ? JSON.parse(run.out).hookSpecificOutput : null);

const ASKED = 'Need a board name — which tracker board are your tickets on?';

test('a turn that ends by asking what memory already holds is held back and handed the memory — once', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'My tickets are on the tracker board Atlas']);

  // The real failure: a request was answered with a question, memory unread.
  say(s, 'list my open tickets');
  const held = feedback(stop(s, ASKED));
  assert.equal(held.hookEventName, 'Stop');
  assert.match(held.additionalContext, /^Before the user answers that: memory already holds/);
  assert.match(held.additionalContext, /m1 \[fact·global·stated\] My tickets are on the tracker board Atlas/);

  // Claude Code is now continuing because of us; whatever it ends on this time goes to the user.
  assert.equal(stop(s, ASKED, { stop_hook_active: true }).out, '');

  // A memory is put in front of a session once. Asking again later is the agent's informed choice.
  say(s, 'and the closed ones');
  assert.equal(stop(s, ASKED).out, '');
});

test('a question memory has nothing close to goes straight to the user', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'The kanban board colours are set in theme.css']);

  // One shared word ("board") is an accident, exactly as it is for a workflow's gate.
  assert.equal(stop(s, ASKED).out, '');
  assert.equal(s.sql((db) => db.prepare('SELECT hits FROM memories WHERE id = 1').get().hits), 0, 'a memory that was not shown was not used');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM search_misses').get().n), 1, 'what the user had to be asked is what memory could not answer');
});

test('only the question a turn ends on counts', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'My tickets are on the tracker board Atlas']);

  assert.equal(stop(s, 'Pulled 14 tickets from the tracker board Atlas.').out, '', 'nothing was asked');
  assert.equal(stop(s, `Which tracker board? Found it in the config.\n\n${'Ticket 4211 is in progress and has two open tasks. '.repeat(12)}\n\nAll 14 are listed above.`).out, '', 'a question answered along the way is not a question to the user');
  assert.equal(stop(s, '').out, '', 'a turn of tool calls only has no closing message');
});

test('a project\'s memory answers only in a session where that project has come up', () => {
  const s = sandbox();
  s.addProject('simba', 'simba');
  s.mem(['add', 'fact', 'deploys go to the staging cluster first', '--project', 'simba']);
  const asking = 'Which cluster should the deploys go to?';

  assert.equal(stop(s, asking).out, '');

  say(s, 'ship the simba release');
  assert.match(feedback(stop(s, asking)).additionalContext, /m1 \[fact·simba·stated\] deploys go to the staging cluster first/);
  assert.equal(s.sql((db) => currentProject(db, SESSION.session_id)), 'simba', 'what was recalled is not mistaken for the project in hand');
});

const ask = (s, question, more = {}) =>
  s.hook('pre-tool', {
    ...SESSION,
    tool_name: 'AskUserQuestion',
    tool_input: { questions: [{ question, header: 'Board', multiSelect: false, options: [{ label: 'Pick from a list', description: 'List every board' }, { label: 'Type it', description: 'Enter the name' }] }] },
    ...more,
  });
const decision = (run) => (run.out ? JSON.parse(run.out).hookSpecificOutput : null);

test('a question put through the question tool is held back the same way — once', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'My tickets are on the tracker board Atlas']);

  const held = decision(ask(s, 'Which tracker board are your tickets on?'));
  assert.equal(held.hookEventName, 'PreToolUse');
  assert.equal(held.permissionDecision, 'deny');
  assert.match(held.permissionDecisionReason, /^Not yet: memory already holds\nm1 \[fact·global·stated\] My tickets are on the tracker board Atlas\n/);
  assert.match(held.permissionDecisionReason, /If none does, ask again\.$/);

  // The memory is in front of it now; asking anyway is its call, and ending the turn on the same question is too.
  assert.equal(ask(s, 'Which tracker board are your tickets on?').out, '');
  assert.equal(stop(s, ASKED).out, '');

  // A sub-agent has its own context: what the main agent was handed, it never saw.
  assert.equal(decision(ask(s, 'Which tracker board are your tickets on?', { agent_id: 'agent-7' })).permissionDecision, 'deny');
  assert.equal(ask(s, 'Which tracker board are your tickets on?', { agent_id: 'agent-7' }).out, '');
});

test('the question tool is left alone when memory has nothing close, or the payload is not what was expected', () => {
  const s = sandbox();
  s.mem(['add', 'fact', 'The kanban board colours are set in theme.css']);

  assert.equal(ask(s, 'Which tracker board are your tickets on?').out, '');
  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'AskUserQuestion', tool_input: {} }).out, '');
  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'AskUserQuestion', tool_input: { questions: 'which project?' } }).out, '');
});
