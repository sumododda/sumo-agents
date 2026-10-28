// The memory-quality probe judged before it judges anything: its verdicts on final states made by hand, so a live run's
// "FAIL" means memory went wrong, not the judge.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { judgeAll, noticeCounts, SCENARIOS, summary, TURNS } from '../probes/memory-quality.mjs';

const turns = new Map(TURNS.map(([, text], i) => [text, i + 1]));
const memory = (id, body, { state = 'active', scope = 'global', source_turn = null, title = null, cue = null } = {}) => ({ id, body, state, scope, source_turn, title, cue });
/** The state memory should be in after the conversations: every scenario holds. */
const right = () => ({
  turns,
  notices: [{ memory_a: 3, memory_b: 6, kind: 'lookalike' }],
  memories: [
    memory(1, 'slate uses pnpm, never npm', { state: 'superseded', scope: 'project:slate', source_turn: 2 }),
    memory(2, 'slate moved from pnpm to bun', { scope: 'project:slate', source_turn: 8 }),
    memory(3, 'the user prefers short answers', { source_turn: 3 }),
    memory(4, 'slate staging runs on the mac mini', { state: 'superseded', scope: 'project:slate', source_turn: 5 }),
    memory(5, 'slate staging runs on the hetzner box', { scope: 'project:slate', source_turn: 12 }),
    memory(6, 'keep replies brief in every project', { source_turn: 10 }),
    memory(7, 'never force-push on slate', { scope: 'project:slate', source_turn: 7 }),
  ],
});
const failing = (state) => judgeAll(state).filter((v) => v.why !== null).map((v) => v.name);

test('the probe judges a memory that got everything right as right', () => {
  assert.deepEqual(failing(right()), []);
});

test('each way memory can go wrong fails its own scenario, and only it', () => {
  // The correction left standing beside what it corrects, with no notice between them.
  const stale = right();
  stale.memories[0].state = 'active';
  assert.deepEqual(failing(stale), ['a correction replaces what it corrects']);
  // …unless a notice raises the pair for the user.
  stale.notices.push({ memory_a: 1, memory_b: 2, kind: 'contradiction' });
  assert.deepEqual(failing(stale), []);

  const twice = right();
  twice.notices = [];
  assert.deepEqual(failing(twice), ['a thing said twice in other words is one memory']);

  const clash = right();
  clash.memories[3].state = 'active';
  assert.deepEqual(failing(clash), ['two facts that cannot both be true are raised']);

  const lost = right();
  lost.memories[6].scope = 'global';
  assert.deepEqual(failing(lost), ['a standing rule is kept, in its project']);

  const busy = right();
  busy.memories.push(memory(8, 'the renderer has a null date bug', { scope: 'project:slate', source_turn: turns.get('fix the null date bug in the renderer') }));
  assert.deepEqual(failing(busy), ['a request for work is never filed']);
  // A guess the user already rejected is not memory.
  busy.memories.at(-1).state = 'rejected';
  assert.deepEqual(failing(busy), []);

  // A one-off ask turned into a workflow guess, with no turn to point at, is filed from a request all the same.
  const routine = right();
  routine.memories.push(memory(9, '1. open the theme\n2. set the colour', { state: 'unconfirmed', title: 'change button color', cue: 'make the button blue' }));
  assert.deepEqual(failing(routine), ['a request for work is never filed']);

  // The user's own rule, held as a guess as if they had said it the other way round.
  const doubted = right();
  doubted.memories[0].state = 'unconfirmed';
  assert.deepEqual(failing(doubted), ['what the user said is filed as theirs, never held as a guess']);
});

test('runs judged more than once say pass^k and pass@k', () => {
  const ok = judgeAll(right());
  const bad = judgeAll({ ...right(), notices: [] });
  const said = summary([ok, bad, ok]);
  assert.match(said, /^ok {3}3\/3 {2}a correction replaces what it corrects$/m);
  assert.match(said, /^FAIL 2\/3 {2}a thing said twice in other words is one memory$/m);
  assert.match(said, new RegExp(`pass\\^3: ${SCENARIOS.length - 1} of ${SCENARIOS.length} held every run · pass@3: ${SCENARIOS.length} held at least once$`));
  assert.match(summary([ok]), new RegExp(`^${SCENARIOS.length} of ${SCENARIOS.length} held$`, 'm'));
});

test('notices are counted beside the scenarios: one tying a scenario\'s pair is asked for, any other is noise, and the summary says how much', () => {
  const state = right();
  assert.deepEqual(noticeCounts(state), { raised: 1, spurious: 0 }, 'the short/brief notice is one of the pairs wanted');
  state.notices.push({ memory_a: 7, memory_b: 2, kind: 'lookalike' }, { memory_a: 5, memory_b: 4, kind: 'contradiction' });
  assert.deepEqual(noticeCounts(state), { raised: 3, spurious: 1 }, 'force-push vs bun is noise; mac mini vs hetzner is wanted');
  const said = summary([judgeAll(right()), judgeAll(state)], [noticeCounts(right()), noticeCounts(state)]);
  assert.match(said, /\nnotices: 1 raised, 0 not about a scenario's pair · 3 raised, 1 not about a scenario's pair$/);
  assert.doesNotMatch(summary([judgeAll(right())]), /notices:/, 'without counts, as before');
});
