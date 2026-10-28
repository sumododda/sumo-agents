// The guides that fire by themselves: which message brings which one, and the end of a turn held for an unchecked edit.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { firingGuides, guideBody, matchGuide, renderGuide, WORKER_GUIDES } from '../src/guides.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-g', cwd: '/work/home' };
const prompt = (s, text, more = {}) => s.hook('prompt', { ...SESSION, prompt: text, ...more }).out;

/**
 * Messages in the shape of the user's real ones, each with the guide it should bring. The labels are a judgment;
 * `known` marks the ones the matcher gets wrong today and we accept — the test holds them wrong, so a change
 * that fixes one is noticed and the mark taken off.
 */
const PROBES = [
  ['fix the login bug', 'fix'],
  ['the build is broken after the last merge', 'fix'],
  ['tests are failing on main', 'fix'],
  ['sumo chat crashes when I paste an image', 'fix'],
  ["this doesn't work: `sumo search foo` prints nothing", 'fix'],
  ['I get a TypeError when I run the export', 'fix', { known: 'miss' }],
  ['there is an error in the hook log every session start', 'fix'],
  ['regression: the memory block lost the open jobs line', 'fix'],
  ['why does the scribe keep filing the same memory twice? fix it', 'fix'],
  ['the router picks haiku for everything since yesterday', 'fix', { known: 'miss' }],
  ['fix the broken add button', 'fix'],
  ['add a test for the bug in paginate', 'fix'],
  ['the export stopped working after the schema change', 'fix'],
  ['it throws on an empty transcript', 'fix'],
  ['I broke the dream pass, can you look', 'fix'],

  ['add a --json flag to sumo job list', 'feature'],
  ['build a page that shows the ledger', 'feature'],
  ['implement session resume', 'feature'],
  ['I want a way to pin a model per project', 'feature', { known: 'miss' }],
  ["let's rewrite the router prompt", 'feature'],
  ['design the skills feature, how should we structure it', 'feature'],
  ['extend the guard to cover git clean', 'feature'],
  ['what approach would you take for syncing memory between machines', 'feature'],
  ['add error handling to the upload', 'feature', { known: 'wrong guide' }],

  ['review j12', 'review'],
  ['review my changes before I push', 'review'],
  ['audit the guard for gaps', 'review'],
  ['look over the diff in src/chat.mjs', 'review'],
  ['can you review this PR https://github.com/x/y/pull/3', 'review'],
  ['review my fix', 'review'],
  ['fix the issues the review found', 'review'],
  ['critique the brief before I delegate it', 'review'],

  ['how does the router pick a model?', null],
  ['what does the scheduler do', null],
  ['run the tests', null],
  ['thanks', null],
  ['commit this', null],
  ['switch to simba', null],
  ['show me the ledger for today', null],
  ['what changed in the last commit?', null],
  ['continue', null],
  ['explain the verify step', null],
  ['I prefer short answers', null],
  ['delegate the migration to a worker', null],
  ['summarize what j4 found', null],
  ['yes', null],
  ['run the build and tell me if it passes', null, { known: 'false alarm' }],
  ['add this to memory: I use pnpm', null, { known: 'false alarm' }],
  ['review the plan and ask questions', null, { known: 'false alarm' }],
];

test('the probes: each message brings the guide it should, and the known misses stay known', () => {
  const wrong = [];
  const known = [];
  for (const [text, expected, { known: accepted } = {}] of PROBES) {
    const got = matchGuide(text);
    if (accepted) {
      if (got === expected) wrong.push(`"${text}" → ${got} is right now: take off known: '${accepted}'`);
      else known.push(`"${text}" → ${got ?? 'none'} (wanted ${expected ?? 'none'})`);
    } else if (got !== expected) wrong.push(`"${text}" → ${got ?? 'none'} (wanted ${expected ?? 'none'})`);
  }
  assert.deepEqual(wrong, [], `${wrong.length} wrong of ${PROBES.length}:\n${wrong.join('\n')}`);
  assert.ok(known.length <= 7, `known misses: ${known.length}`);
});

test('three guides fire, in precedence order, and the header never reaches the model', () => {
  assert.deepEqual(
    firingGuides().map((g) => g.name),
    ['review', 'fix', 'feature'],
  );
  for (const name of ['fix', 'feature', 'review']) {
    assert.doesNotMatch(guideBody(name), /^---|^# /m, `${name}: the header and the title are stripped`);
    assert.match(guideBody(name), /^1\. /, `${name}: starts at step one`);
  }
  assert.doesNotMatch(guideBody('delegation'), /^---/m);
  assert.equal(matchGuide('delegate the migration', ['delegation']), null, 'a reference page never fires, header or not');
  assert.equal(matchGuide('fix the review', WORKER_GUIDES), 'fix', 'a worker is never handed review');
});

test('a fix or a feature goes in whole; a review goes in as "delegate it" plus how to receive the findings', () => {
  assert.match(renderGuide('fix'), /^<guide fix>\nThe user is asking for a fix\.[^\n]*\n1\. What changed recently\?[\s\S]*\n<\/guide>$/);
  assert.match(renderGuide('feature'), /^<guide feature>\n[^\n]*\n1\. Size it\./);
  const review = renderGuide('review');
  assert.match(review, /^<guide review>\nCode written in this session is never reviewed in this session: delegate it to a reviewer/);
  assert.match(review, /Findings are claims too/);
  assert.doesNotMatch(review, /Judge the change, not its author/, 'the reviewer\'s own steps stay with the reviewer');
});

test('the guide rides in with the message, once per session; a taught workflow wins; the switch turns it off', () => {
  const s = sandbox();
  const first = prompt(s, 'the export is broken since the schema change');
  assert.match(first, /<guide fix>\n[\s\S]*Make it fail on demand[\s\S]*<\/guide>/);
  assert.equal(prompt(s, 'still broken, the fix did not take'), '', 'given once');
  assert.match(prompt(s, 'now add a --json flag to it'), /<guide feature>/, 'another kind of work brings its own');
  assert.equal(prompt(s, 'how does the router pick a model?'), '', 'a question brings nothing');

  // After a fresh start the context is empty again, so the guide may come back.
  s.hook('session-start', { ...SESSION, source: 'new' });
  assert.match(prompt(s, 'fix the login bug'), /<guide fix>/);

  // The user's own way of doing the thing is the one that goes in.
  s.sumo(['learn', 'Fixing a bug here', '--cue', 'fix a bug'], { input: '1. ask me which bug first\n' });
  s.hook('session-start', { ...SESSION, source: 'new' });
  const taught = prompt(s, 'fix a bug in the router');
  assert.match(taught, /<workflow m\d+ "Fixing a bug here">/);
  assert.doesNotMatch(taught, /<guide/);

  // The coding eval's --no-guides: nothing fires unasked.
  const off = { SUMO_AGENTS_GUIDES: 'off' };
  s.hook('session-start', { ...SESSION, source: 'new' });
  assert.equal(s.hook('prompt', { ...SESSION, prompt: 'the login page is broken' }, off).out, '', 'off: nothing fires');
  assert.match(s.hook('prompt', { ...SESSION, prompt: 'the login bug', guide: 'fix' }, off).out, /<guide fix>/, 'off: a guide named by its command still comes');
});

test('a guide named by its command goes in even when it was given before, and an unknown name is ignored', () => {
  const s = sandbox();
  assert.match(prompt(s, 'the login bug', { guide: 'fix' }), /<guide fix>/);
  assert.match(prompt(s, 'the signup bug', { guide: 'fix' }), /<guide fix>/, 'the user asked for it by name');
  assert.equal(prompt(s, 'anything', { guide: 'delegation' }), '');
});

test('a turn that edited a file nothing checked since is held once, and told the project\'s check by name', () => {
  const s = sandbox();
  const stop = (more) => s.hook('stop', { ...SESSION, last_assistant_message: 'Done: the renderer now handles a null date.', stop_hook_active: false, ...more });
  const held = JSON.parse(stop({ edited: ['src/render.mjs', 'src/dates.mjs'], checks: ['npm test'] }).out);
  assert.match(held.context, /^<check>\nNot done yet: src\/render\.mjs and src\/dates\.mjs were edited and nothing has checked them since\. The project's check is `npm test` — run it and say what it showed, or say why it does not apply\.\n<\/check>$/);

  const bare = JSON.parse(stop({ edited: ['src/render.mjs'], checks: [] }).out);
  assert.match(bare.context, /src\/render\.mjs was edited and nothing ran after\. This project declares no check — run what proves the change/);

  const many = JSON.parse(stop({ edited: ['a.mjs', 'b.mjs', 'c.mjs', 'd.mjs', 'e.mjs'], checks: ['make check'] }).out);
  assert.match(many.context, /a\.mjs, b\.mjs, c\.mjs and 2 more were edited/);

  assert.equal(stop({ edited: [], checks: ['npm test'] }).out, '', 'nothing edited: nothing held');
  assert.equal(stop({ edited: ['src/render.mjs'], checks: ['npm test'], stop_hook_active: true }).out, '', 'already continuing: the turn ends');
  assert.equal(stop({}).out, '', 'another harness says nothing of edits: silent');

  const off = s.hook('stop', { ...SESSION, last_assistant_message: 'Done.', stop_hook_active: false, edited: ['src/render.mjs'], checks: ['npm test'] }, { SUMO_AGENTS_GUIDES: 'off' });
  assert.equal(off.out, '', 'the coding eval\'s --no-guides: the turn ends as the model ended it');
});
