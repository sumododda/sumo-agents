import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { SCHEMA_VERSION } from '../src/db.mjs';
import { sandbox } from './helpers.mjs';

const SESSION = { session_id: 'sess-w', cwd: '/work/home' };
const PR_STEPS = '1. run every CI check locally and make sure it passes\n2. create the tracking story first\n3. only then open the PR, with the story number in the title\n';

const teachPr = (s, extra = []) => s.sumo(['learn', 'Creating a PR', '--cue', 'create a PR', ...extra], { input: PR_STEPS });
const bash = (s, command, more = {}) => s.hook('pre-tool', { ...SESSION, tool_name: 'Bash', tool_input: { command }, ...more });
const decision = (run) => (run.out ? JSON.parse(run.out) : null);

test('an agent about to do what a workflow covers is stopped and handed the steps — once', () => {
  const s = sandbox();
  teachPr(s);

  // The real failure: deep in a task, the agent commits, pushes and reaches for `pr create` on its own.
  assert.equal(bash(s, 'git add -A && git commit -m "fix: login form"').out, '');
  assert.equal(bash(s, 'git push -u origin fix/login-form-validation').out, '');

  const held = decision(bash(s, 'gh-axi pr create --title "fix(auth): rework login form"'));
  assert.ok(held.deny);
  assert.match(held.deny, /^Not yet\. The user taught a workflow for exactly this/);
  assert.match(held.deny, /<workflow m1 "Creating a PR">\n1\. run every CI check locally[\s\S]*3\. only then open the PR/);
  assert.match(held.deny, /then run the command again\.$/);

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
  other.sumo(['learn', 'PR creation', '--cue', 'create a pull request'], { input: PR_STEPS });
  assert.match(other.hook('prompt', { ...SESSION, prompt: 'ship it: create the PR' }).out, /<workflow m1 /);
  assert.match(s.hook('prompt', { session_id: 'third', prompt: 'please create a pull request for this' }).out, /<workflow m1 /);

  // Word forms do not matter: "creating PRs" is the same request.
  assert.match(s.hook('prompt', { session_id: 'another', prompt: 'I will be creating PRs all day' }).out, /<workflow m1 /);
});

test('the gate never blocks sumo itself, other tools, or a command that only shares one ordinary word', () => {
  const s = sandbox();
  teachPr(s);
  s.sumo(['learn', 'ship it', '--cue', 'ship'], { input: '1. tag\n2. push the tag\n' });

  assert.equal(bash(s, 'sumo learn "Creating a PR v2" --cue "create a PR" --from-file steps.md').out, '');
  assert.equal(bash(s, 'cd /Users/x/sumo-agents && sumo show m1').out, '');
  assert.equal(s.hook('pre-tool', { ...SESSION, tool_name: 'Write', tool_input: { file_path: '/x/create-pr.md', command: 'create pr' } }).out, '');
  assert.equal(bash(s, 'ls shipping/ && cat ship.log').out, '', 'a one-word cue is too easy to hit by accident to gate a command');
  assert.match(s.hook('prompt', { ...SESSION, prompt: 'ok ship it' }).out, /<workflow m2 "ship it">/, 'but it still answers the user asking for it');
});

test('a sub-agent has its own context, so it is given the steps even if the main agent already was', () => {
  const s = sandbox();
  teachPr(s);
  assert.ok(decision(bash(s, 'gh pr create --fill')).deny);
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  const worker = { agent_id: 'agent-7', agent_type: 'worker' };
  assert.ok(decision(bash(s, 'gh pr create --fill', worker)).deny);
  assert.equal(bash(s, 'gh pr create --fill', worker).out, '');
});

test('a project\'s workflow applies only once that project has come up; after a compaction the steps can come back', () => {
  const s = sandbox();
  const dir = join(s.root, 'proj-simba');
  mkdirSync(dir);
  writeFileSync(join(dir, 'go.mod'), 'module simba\n');
  s.sumo(['project', 'add', dir, '--alias', 'simba']);
  teachPr(s, ['--project', 'simba']);

  assert.equal(bash(s, 'gh pr create --fill').out, '', 'nothing in this session is about simba yet');
  s.hook('prompt', { ...SESSION, prompt: 'let us work on simba' });
  assert.ok(decision(bash(s, 'gh pr create --fill')).deny);
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  s.hook('session-start', { ...SESSION, source: 'compact' });
  s.hook('prompt', { ...SESSION, prompt: 'back to simba' });
  assert.ok(decision(bash(s, 'gh pr create --fill')).deny, 'the steps left the context with the compaction');
});

test('a stated gate decides exactly which commands wait — no accidental matches, no near-misses', () => {
  const s = sandbox();
  const taught = s.sumo(['learn', 'Creating a PR', '--cue', 'create a PR', '--gate', 'gh(-axi)? pr create|glab mr create'], { input: PR_STEPS });
  assert.equal(taught.code, 0, taught.err);
  assert.match(taught.out, /gates shell commands matching: gh\(-axi\)\? pr create\|glab mr create/, 'the person teaching sees what will be held back');
  assert.match(s.sumo(['show', 'm1']).out, /^gate: gh\(-axi\)\? pr create\|glab mr create {3}\(shell commands matching this wait/m);

  // Guessing from the cue's words would have held this one back; the stated gate does not.
  assert.equal(bash(s, 'grep -rn "create pr" docs/').out, '');
  assert.equal(bash(s, 'echo "remember to create the PR later"').out, '');

  // And it catches a command the cue's words would have missed entirely.
  const other = sandbox();
  other.sumo(['learn', 'Creating a PR', '--cue', 'open a pull request', '--gate', 'gh(-axi)? pr create|glab mr create'], { input: PR_STEPS });
  assert.ok(decision(bash(other, 'glab mr create --title x')).deny);

  assert.ok(decision(bash(s, 'gh-axi pr create --title "fix: login form"')).deny);
  assert.equal(bash(s, 'GH-AXI PR CREATE --fill').out, '', 'shown once; and matching ignores case');

  // The user asking for it is still matched by the cue — a gate is about commands only.
  assert.match(s.hook('prompt', { session_id: 'fresh', prompt: 'ok create the PR' }).out, /<workflow m1 /);
});

test('a gate can be put on a workflow that already exists, and taken off again', () => {
  const s = sandbox();
  teachPr(s);
  assert.ok(decision(bash(s, 'grep "create pr" notes.md', { session_id: 'a' })).deny, 'with no gate, the cue words are the guess');

  const set = s.sumo(['gate', 'm1', 'gh(-axi)? pr create']);
  assert.match(set.out, /^m1 \[proc·global·stated\] "Creating a PR" — when: create a PR\ngates shell commands matching: gh\(-axi\)\? pr create/);
  assert.equal(bash(s, 'grep "create pr" notes.md', { session_id: 'b' }).out, '');
  assert.ok(decision(bash(s, 'gh pr create --fill', { session_id: 'b' })).deny);

  assert.match(s.sumo(['gate', 'm1', 'off']).out, /no gate — its cue words are matched instead/);
  assert.ok(decision(bash(s, 'grep "create pr" notes.md', { session_id: 'c' })).deny);
});

test('a gate that is broken or would hold back everything is refused when it is written, not discovered later', () => {
  const s = sandbox();
  for (const [gate, message] of [
    ['gh pr (create', /not a valid regular expression/],
    ['.*', /too broad — it would hold back "every command"/],
    ['git', /too broad — it would hold back "git status"/],
    ['xq', /too short to mean one command/],
  ]) {
    const run = s.sumo(['learn', 'Creating a PR', '--cue', 'create a PR', '--gate', gate], { input: PR_STEPS });
    assert.equal(run.code, 2, gate);
    assert.match(run.err, message);
  }
  assert.equal(s.sql((db) => db.prepare('SELECT COUNT(*) AS n FROM memories').get().n), 0, 'a refused gate saves nothing');

  s.sumo(['add', 'preference', 'be concise']);
  assert.match(s.sumo(['gate', 'm1', 'gh pr create']).err, /m1 is not a workflow/);
});

test('a memory from before gates existed upgrades in place and keeps working', () => {
  const s = sandbox();
  teachPr(s);
  s.sumo(['add', 'preference', 'be concise']);
  // Put the database back to the shape it had in the previous release.
  s.sql((db) => {
    db.exec('ALTER TABLE memories DROP COLUMN gate');
    db.exec('PRAGMA user_version = 3');
  });

  assert.match(s.sumo(['search', 'concise']).out, /m2 .*be concise/, 'opening it migrates it; nothing is lost');
  assert.equal(s.sql((db) => db.prepare('PRAGMA user_version').get().user_version), SCHEMA_VERSION);
  assert.ok(decision(bash(s, 'gh pr create --fill')).deny, 'the old workflow still triggers by its cue');
  assert.match(s.sumo(['gate', 'm1', 'gh pr create']).out, /gates shell commands matching/);
});

test('a forgotten workflow stops triggering, and a broken memory never blocks a command', () => {
  const s = sandbox();
  teachPr(s);
  s.sumo(['forget', 'm1']);
  assert.equal(bash(s, 'gh pr create --fill').out, '');

  const broken = sandbox();
  mkdirSync(broken.home, { recursive: true });
  writeFileSync(join(broken.home, 'memory.db'), 'not a database');
  const run = bash(broken, 'gh pr create --fill');
  assert.deepEqual([run.code, run.out, run.err], [0, '', '']);
});

test('only sumo is let past the gate: a gated command chained to a sumo call still waits, and a sumo call is never judged by its own words', () => {
  const s = sandbox();
  teachPr(s, ['--gate', 'gh(-axi)? pr create']);
  const held = (command, session_id) => Boolean(decision(bash(s, command, { session_id }))?.deny);

  assert.ok(held('sumo help >/dev/null; gh pr create --fill', 'a'), 'after a semicolon');
  assert.ok(held('sumo search "pr rules" && gh pr create --fill', 'b'), 'after &&');
  assert.ok(held('sumo show m1 2>&1 | tail -3; gh pr create', 'c'), 'a redirect is not the end of a command');
  assert.ok(held('cd /work && sumo job note 3 <<EOF\nabout to open it\nEOF\ngh pr create --fill', 'd'), 'after a heredoc that has closed');
  assert.ok(held('sumo job note 3 <<"END OF NOTE"\nabout to open it\nEND OF NOTE\ngh pr create --fill', 'h'), 'after a heredoc whose quoted delimiter has a space');
  assert.ok(held("cat <<'EOF\ngh pr create --fill", 'i'), 'after an opener that is not a heredoc after all');
  assert.ok(held('sumo job note 3 $((1<<2))\ngh pr create --fill', 'k'), 'after an arithmetic shift, which opens no heredoc');
  assert.ok(held('sumo job note 3 "$(( (1<<2) + 1 ))"; gh pr create --fill', 'l'), 'arithmetic with its own parentheses');
  assert.ok(held('sumo add x # see <<EOF\ngh pr create --fill', 'm'), 'after a comment that mentions a heredoc');
  assert.ok(held('sumo add x $[1<<2]\ngh pr create --fill', 'n'), 'after the old spelling of arithmetic');
  assert.ok(held('sumo add x `echo <<EOF`\ngh pr create --fill', 'o'), 'after a backtick substitution');
  assert.ok(held('sumo add x $(echo 1<<2)\ngh pr create --fill', 'p'), 'after a substitution holding a shift');
  // The delimiter is the word after `<<` with its quotes removed, as the shell reads it.
  assert.ok(held('sumo add x <<E"O"F\nbody\nEOF\ngh pr create --fill', 'q'), 'after a heredoc whose delimiter is partly quoted');
  assert.ok(held('sumo add x <<E\\OF\nbody\nEOF\ngh pr create --fill', 'r'), 'after a heredoc whose delimiter has an escaped character');
  assert.ok(held('sumo add x <<"EOF"x\nbody\nEOFx\ngh pr create --fill', 's'), 'after a heredoc whose delimiter continues past its quotes');
  // A quote inside a substitution, and an escaped quote inside $'…', do not change where the command ends.
  assert.ok(held('sumo add x $(echo ")"); gh pr create --fill', 't'), 'after a substitution holding a closing parenthesis in quotes');
  assert.ok(held("sumo add x $'\\'' ; gh pr create --fill", 'u'), 'after an ANSI-C quoted string with an escaped quote');
  // What a sumo call substitutes in is run by the shell, so it is judged; what it merely quotes is not.
  assert.ok(held('sumo add "$(gh pr create --fill)"', 'v'), 'a gated command substituted into a sumo call');
  assert.ok(held('sumo add "`gh pr create --fill`"', 'w'), 'a gated command in backticks inside a sumo call');

  // A heredoc belongs to the call that opens it, and a separator inside quotes is only a character.
  const teaching = `sumo learn "Creating a PR v2" --cue "create a PR" <<'EOF'\n1. run gh pr create only after the checks; never before\nEOF`;
  assert.equal(bash(s, teaching, { session_id: 'e' }).out, '');
  assert.equal(bash(s, 'sumo add preference "never run gh pr create; ask first" 2>&1', { session_id: 'f' }).out, '');
  assert.equal(bash(s, 'cd /work && /usr/local/bin/sumo show m1 | tail -3', { session_id: 'g' }).out, '', 'what is chained to it is judged on its own words');
  assert.equal(bash(s, `sumo job note 3 <<"it's noted"\nnext: gh pr create once CI is green\nit's noted`, { session_id: 'j' }).out, '', "a quoted delimiter may hold the other quote, and the note it closes is the note's");
});

test('a gate that would take minutes over one command is refused when it is written, and one already stored cannot hold a turn', () => {
  const s = sandbox();
  for (const gate of ['(a+)+$', '(\\w+\\s*)+create']) {
    const run = s.sumo(['learn', 'Creating a PR', '--cue', 'create a PR', '--gate', gate], { input: PR_STEPS });
    assert.equal(run.code, 2, gate);
    assert.match(run.err, /takes too long/);
  }

  // One that was stored before this was checked: the command it runs away on is let through, promptly.
  teachPr(s, ['--gate', 'gh pr create']);
  s.sql((db) => db.prepare(`UPDATE memories SET gate = '(a+)+$' WHERE type = 'procedure'`).run());
  const started = Date.now();
  assert.equal(bash(s, `echo ${'a'.repeat(44)}!`).out, '');
  assert.ok(Date.now() - started < 3000, `the check took ${Date.now() - started} ms`);
});

test('what a sumo call has the shell run — a process substitution, or a substitution in an unquoted heredoc — is judged on its own', async () => {
  const { withoutSumoCalls } = await import('../src/workflows.mjs');
  assert.match(withoutSumoCalls('sumo show m1 > >(gh pr create --fill)'), /gh pr create --fill/);
  assert.match(withoutSumoCalls('sumo show m1 <(gh pr create --fill)'), /gh pr create --fill/);
  assert.match(withoutSumoCalls('sumo learn x <<EOF\n$(gh pr create --fill)\nEOF'), /gh pr create --fill/);
  assert.match(withoutSumoCalls('sumo learn x <<EOF\n`gh pr create --fill`\nEOF'), /gh pr create --fill/);
  // Quoted, the heredoc is only text, and an escaped substitution is not one.
  assert.equal(withoutSumoCalls("sumo learn x <<'EOF'\n$(gh pr create --fill)\nEOF"), '');
  assert.equal(withoutSumoCalls('sumo learn x <<EOF\n\\$(gh pr create --fill)\nEOF'), '');
  assert.equal(withoutSumoCalls('sumo learn "open a PR" --cue "gh pr create"'), '');
});
