#!/usr/bin/env node
// A live measurement, not a test: it calls the real cheap model (about six calls, a few cents).
// It answers one question — is the default model good enough at deciding WHAT to remember and WHERE?
//   node probes/scope-accuracy.mjs            → runs with the configured scribe.model
//   node probes/scope-accuracy.mjs sonnet     → runs with another model, to compare
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { ENTRY } from '../src/paths.mjs';

const G = 'global';
const SIMBA = 'project:simba';
const SLATE = 'project:slate';

/** [session, what the user types, where it belongs — null when it should not be remembered at all] */
const TURNS = [
  ['a', "let's work on simba today", null],
  ['a', 'never push to main here, always open a PR', [SIMBA]],
  ['a', 'the briefing copy is always reviewed by me before it ships', [SIMBA]],
  ['a', 'fix the null date bug in the renderer', null],
  ['a', 'what does the scheduler do?', null],
  ['a', 'in general, across all my projects, I want conventional commits', [G]],

  ['b', 'switching to slate now', null],
  ['b', 'slate uses pnpm, never npm', [SLATE]],
  ['b', 'we decided slate stays a static site, no server, to keep hosting free', [SLATE]],
  ['b', 'run the build and tell me if it passes', null],
  ['b', 'I prefer short answers and no emojis, everywhere', [G]],
  ['b', 'thanks', null],

  ['c', 'from now on always ask before adding a dependency', [G]],
  ['c', 'I use a Mac with zsh, remember that', [G]],
  ['c', 'what time is it in Tokyo?', null],
  ['c', 'for simba, deploys only happen Monday to Thursday', [SIMBA]],
  ['c', 'can you summarize this article for me', null],

  ['d', 'back on simba', null],
  ['d', 'tests here need SIMBA_TZ exported or they fail', [SIMBA]],
  ['d', 'oh and in slate, images must be under 200kb', [SLATE]],
  ['d', 'ok continue with the simba fix', null],
  ['d', 'always write table-driven tests in Go', [G, SIMBA]],

  ['e', "never use the word 'delve' in anything you write for me", [G]],
  ['e', "I'm thinking about maybe trying Rust someday", null],
  ['e', 'my GitHub username is sumo-dev', [G]],
  ['e', 'make the button blue', null],
  ['e', 'actually, make it green', null],

  ['f', 'in slate we moved from pnpm to bun last week', [SLATE]],
  ['f', "don't ever force-push on this repo", [SLATE]],
  ['f', 'how many pages does the site have?', null],
];

const root = mkdtempSync(join(tmpdir(), 'sumo-agents-probe-'));
const env = { ...process.env, SUMO_AGENTS_HOME: join(root, 'home'), SUMO_AGENTS_CLAUDE_LOCAL_SETTINGS: join(root, 'claude.json'), SUMO_AGENTS_SPAWN_LOG: join(root, 'spawn.log') };
delete env.SUMO_AGENTS_SCRIBE;
delete env.SUMO_AGENTS_MODEL_CMD;
const mem = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], { env, input, encoding: 'utf8' });

for (const name of ['simba', 'slate']) {
  mkdirSync(join(root, name));
  writeFileSync(join(root, name, 'go.mod'), `module ${name}\n`);
  mem(['project', 'add', join(root, name)]);
}
if (process.argv[2]) mem(['config', 'scribe.model', process.argv[2]]);
console.log(`model: ${mem(['config', 'scribe.model']).stdout.trim()}\n`);

let session = null;
for (const [index, [id, text]] of TURNS.entries()) {
  if (session !== null && id !== session) process.stdout.write(`session ${session}: ${mem(['scribe', 'run']).stdout.split('\n')[0]}\n`);
  session = id;
  mem(['hook', 'prompt', '--harness', 'claude'], JSON.stringify({ session_id: `probe-${id}`, prompt: text }));
  void index;
}
process.stdout.write(`session ${session}: ${mem(['scribe', 'run']).stdout.split('\n')[0]}\n\n`);

const db = new DatabaseSync(join(root, 'home', 'memory.db'));
const memories = db.prepare(`SELECT id, scope, provenance, source_turn, body FROM memories WHERE written_by = 'scribe' ORDER BY id`).all();
const cost = db.prepare('SELECT SUM(cost_usd) AS usd, COUNT(*) AS runs FROM model_runs').get();
db.close();

let remembered = 0;
let rightScope = 0;
let stated = 0;
const noise = [];
const missed = [];
for (const [index, [, text, expected]] of TURNS.entries()) {
  const from = memories.filter((m) => m.source_turn === index + 1);
  if (expected === null) {
    for (const m of from) noise.push(`  t${index + 1} "${text}" → ${m.scope}: ${m.body}`);
    continue;
  }
  if (from.length === 0) {
    missed.push(`  t${index + 1} "${text}"`);
    continue;
  }
  remembered++;
  if (from.some((m) => m.provenance === 'stated')) stated++;
  const ok = from.every((m) => expected.includes(m.scope));
  if (ok) rightScope++;
  console.log(`${ok ? 'ok   ' : 'WRONG'} t${String(index + 1).padEnd(2)} ${from.map((m) => `[${m.scope}·${m.provenance}] ${m.body}`).join(' | ')}${ok ? '' : `   ← expected ${expected.join(' or ')}`}`);
}
const unlinked = memories.filter((m) => m.source_turn === null);

const durable = TURNS.filter(([, , e]) => e !== null).length;
console.log(`\nremembered what it should: ${remembered}/${durable}`);
console.log(`in the right scope:        ${rightScope}/${remembered}`);
console.log(`proven with a real quote:  ${stated}/${remembered}`);
console.log(`remembered what it should not: ${noise.length} of ${TURNS.length - durable} throwaway turns`);
if (missed.length) console.log(`\nmissed:\n${missed.join('\n')}`);
if (noise.length) console.log(`\nnoise:\n${noise.join('\n')}`);
if (unlinked.length) console.log(`\nnot tied to any turn:\n${unlinked.map((m) => `  [${m.scope}·${m.provenance}] ${m.body}`).join('\n')}`);
console.log(`\ncost: $${cost.usd.toFixed(4)} over ${cost.runs} calls`);
