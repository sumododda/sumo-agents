import assert from 'node:assert/strict';
import { test } from 'node:test';
import { currentProject } from '../src/sessions.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-r', cwd: '/work/home' };
const say = (s, prompt) => s.hook('prompt', { ...SESSION, prompt });
const stop = (s, reply, more = {}) => s.hook('stop', { ...SESSION, last_assistant_message: reply, stop_hook_active: false, ...more });
const feedback = (run) => (run.out ? JSON.parse(run.out) : null);

const ASKED = 'Need a board name — which tracker board are your tickets on?';

test('a turn that ends by asking what memory already holds is held back and handed the memory — once', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'My tickets are on the tracker board Atlas']);

  // The real failure: a request was answered with a question, memory unread.
  say(s, 'list my open tickets');
  const held = feedback(stop(s, ASKED));
  assert.match(held.context, /^Before the user answers that: memory already holds/);
  assert.match(held.context, /m1 \[fact·global·stated\] My tickets are on the tracker board Atlas/);

  // Claude Code is now continuing because of us; whatever it ends on this time goes to the user.
  assert.equal(stop(s, ASKED, { stop_hook_active: true }).out, '');

  // A memory is put in front of a session once. Asking again later is the agent's informed choice.
  say(s, 'and the closed ones');
  assert.equal(stop(s, ASKED).out, '');
});

test('a question memory has nothing close to goes straight to the user', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'The kanban board colours are set in theme.css']);

  // One shared word ("board") is an accident, exactly as it is for a workflow's gate.
  assert.equal(stop(s, ASKED).out, '');
  assert.equal(s.sql((db) => db.prepare('SELECT hits FROM memories WHERE id = 1').get().hits), 0, 'a memory that was not shown was not used');
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM search_misses').get().n), 0, "the question is the assistant's words, and nothing of them is kept");
});

test('a memory handed over counts as used once, not each time the same question comes round', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'My tickets are on the tracker board Atlas']);
  for (const prompt of ['list my open tickets', 'and the closed ones', 'and the archived ones']) {
    say(s, prompt);
    stop(s, ASKED);
  }
  assert.equal(s.sql((db) => db.prepare('SELECT hits FROM memories WHERE id = 1').get().hits), 1);
});

test('only the question a turn ends on counts', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'My tickets are on the tracker board Atlas']);

  assert.equal(stop(s, 'Pulled 14 tickets from the tracker board Atlas.').out, '', 'nothing was asked');
  assert.equal(stop(s, `Which tracker board? Found it in the config.\n\n${'Ticket 4211 is in progress and has two open tasks. '.repeat(12)}\n\nAll 14 are listed above.`).out, '', 'a question answered along the way is not a question to the user');
  assert.equal(stop(s, '').out, '', 'a turn of tool calls only has no closing message');
});

test('a project\'s memory answers only in a session where that project has come up', () => {
  const s = sandbox();
  s.addProject('simba', 'simba');
  s.sumo(['add', 'fact', 'deploys go to the staging cluster first', '--project', 'simba']);
  const asking = 'Which cluster should the deploys go to?';

  assert.equal(stop(s, asking).out, '');

  say(s, 'ship the simba release');
  assert.match(feedback(stop(s, asking)).context, /m1 \[fact·simba·stated\] deploys go to the staging cluster first/);
  assert.equal(s.sql((db) => currentProject(db, SESSION.session_id)), 'simba', 'what was recalled is not mistaken for the project in hand');
});

test('a question that names a file or a version is read whole, not from its last dot', async () => {
  const { closingQuestions } = await import('../src/recall.mjs');
  assert.equal(closingQuestions('Done. Should the deploy go through staging first (see deploy.yml)?').trim(), 'Should the deploy go through staging first (see deploy.yml)?');
  assert.equal(closingQuestions('I bumped it. Pin node to v22.1?').trim(), 'Pin node to v22.1?');
  assert.equal(closingQuestions('Tests pass. Ready?\nOr wait for CI?').split('?').filter((q) => q.trim()).length, 2);
});
