#!/usr/bin/env node
// A live measurement, not a test: scripted conversations go through the real hooks, the memory pass files each one and
// tidies at the end, and what memory ends up holding is judged. It answers one question — over time, does
// memory stay right: a correction replaces what it corrects, a thing said twice is one memory, two that cannot both be
// true are raised, and a request for work is never filed? On the local model it costs $0.
//   node probes/memory-quality.mjs                 → the configured memory.model, once
//   node probes/memory-quality.mjs --runs 3        → three fresh homes: pass^3 says what holds every time
//   node probes/memory-quality.mjs --model haiku   → another model for the memory pass, to compare
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { ENTRY, paths } from '../src/paths.mjs';
import { leaveNothing } from './throwaway.mjs';
import { modelFileOfUrl } from '../src/setup.mjs';
import { overlap } from '../src/text.mjs';

/** The conversations, in order: [session, what the user types]. Each scenario below judges what came of its turns. */
export const TURNS = [
  ['a', 'switching to slate now'],
  ['a', 'slate uses pnpm, never npm'],
  ['a', 'I prefer short answers, everywhere'],
  ['a', 'fix the null date bug in the renderer'],
  ['b', 'the staging server for slate runs on the mac mini in the office'],
  ['b', 'make the button blue'],
  ['b', "don't ever force-push on slate"],
  ['c', 'in slate we moved from pnpm to bun last week'],
  ['c', 'what time is it in Tokyo?'],
  ['d', 'keep your replies brief, always, in every project'],
  ['d', 'run the build and tell me if it passes'],
  ['e', 'slate staging runs on the hetzner box now, remember that'],
];

const mentions = (pattern) => (m) => pattern.test(m.body);
/** Whether two memories are tied by a notice the user will be asked to settle. */
const noticed = (notices, a, b) => notices.some((n) => (n.memory_a === a.id && n.memory_b === b.id) || (n.memory_a === b.id && n.memory_b === a.id));
/** Of two groups of memories, a pair that stands side by side, both active, with no notice tying them. */
const unraised = (state, left, right) => {
  const active = state.memories.filter((m) => m.state === 'active');
  for (const a of active.filter(left)) for (const b of active.filter(right)) if (a.id !== b.id && !noticed(state.notices, a, b)) return [a, b];
  return null;
};

/**
 * What memory should hold after the conversations, as judges of the final state: `{ memories, notices, turns }`,
 * where `turns` maps each scripted line to its turn id. Each returns null when memory got it right, else why not.
 */
export const SCENARIOS = [
  {
    name: 'a correction replaces what it corrects',
    judge(state) {
      const active = state.memories.filter((m) => m.state === 'active');
      if (!active.some(mentions(/\bbun\b/i))) return 'nothing active says slate uses bun';
      const pair = unraised(state, mentions(/\bpnpm\b/i), mentions(/\bbun\b/i));
      return pair && !/\bbun\b/i.test(pair[0].body) ? `still active beside the correction: "${pair[0].body}"` : null;
    },
  },
  {
    name: 'a thing said twice in other words is one memory',
    judge(state) {
      const pair = unraised(state, mentions(/\bshort\b/i), mentions(/\bbrief\b/i));
      return pair ? `two memories say it, neither raised: "${pair[0].body}" · "${pair[1].body}"` : null;
    },
  },
  {
    name: 'two facts that cannot both be true are raised',
    judge(state) {
      const active = state.memories.filter((m) => m.state === 'active');
      if (!active.some(mentions(/hetzner/i))) return 'nothing active says staging is on the hetzner box';
      const pair = unraised(state, mentions(/mac mini/i), mentions(/hetzner/i));
      return pair ? `both stand, nothing raised: "${pair[0].body}" · "${pair[1].body}"` : null;
    },
  },
  {
    name: 'a standing rule is kept, in its project',
    judge(state) {
      const kept = state.memories.filter((m) => m.state === 'active' && /force-push/i.test(m.body));
      if (kept.length === 0) return 'the force-push rule was not kept';
      return kept.every((m) => m.scope === 'project:slate') ? null : `kept in the wrong scope: ${kept.map((m) => m.scope).join(', ')}`;
    },
  },
  {
    name: 'a request for work is never filed',
    judge(state) {
      const work = ['fix the null date bug in the renderer', 'make the button blue', 'what time is it in Tokyo?', 'run the build and tell me if it passes'];
      const ids = new Set(work.map((text) => state.turns.get(text)).filter(Boolean));
      // Filed from the request's turn, or a guess with no turn that restates one — a workflow made of a one-off ask.
      const restates = (m) => m.source_turn == null && work.some((w) => overlap(`${m.title ?? ''} ${m.cue ?? ''}`, w) >= 0.8);
      const filed = state.memories.filter((m) => (ids.has(m.source_turn) || restates(m)) && m.state !== 'rejected');
      return filed.length > 0 ? `filed from a request: ${filed.map((m) => `"${m.title ?? m.body}"`).join(' · ')}` : null;
    },
  },
  {
    name: 'what the user said is filed as theirs, never held as a guess',
    judge(state) {
      const said = ['slate uses pnpm, never npm', "don't ever force-push on slate", 'in slate we moved from pnpm to bun last week'];
      const ids = new Set(said.map((text) => state.turns.get(text)).filter(Boolean));
      const held = state.memories.filter((m) => ids.has(m.source_turn) && m.state === 'unconfirmed');
      return held.length > 0 ? `held as a guess: ${held.map((m) => `"${m.body}"`).join(' · ')}` : null;
    },
  },
];

/** The pairs of memories the scenarios want raised: a notice tying one of these is asked for; any other is noise. */
const WANTED_PAIRS = [
  [/\bpnpm\b/i, /\bbun\b/i],
  [/\bshort\b/i, /\bbrief\b/i],
  [/mac mini/i, /hetzner/i],
];

/** The notices that tie memories which are not one of the scenarios' pairs: questions put to the user for nothing. */
function noise(state) {
  const body = new Map(state.memories.map((m) => [m.id, m.body]));
  const wanted = (n) => {
    const [a, b] = [body.get(n.memory_a) ?? '', body.get(n.memory_b) ?? ''];
    return WANTED_PAIRS.some(([left, right]) => (left.test(a) && right.test(b)) || (left.test(b) && right.test(a)));
  };
  return state.notices.filter((n) => !wanted(n)).map((n) => ({ ...n, a: body.get(n.memory_a), b: body.get(n.memory_b) }));
}

/**
 * The notices a run raised, and how many of them tie memories that are not one of the scenarios' pairs: a pass that
 * raises everything would hold every scenario and bury the user in questions, so the noise is counted beside them.
 */
export const noticeCounts = (state) => ({ raised: state.notices.length, spurious: noise(state).length });

/** Every scenario judged on one final state: `[{ name, why }]`, `why` null when it held. */
export const judgeAll = (state) => SCENARIOS.map(({ name, judge }) => ({ name, why: judge(state) }));

/** Runs judged more than once: for each scenario, how many runs it held in — all of them is pass^k — and, given each run's notice counts, the noise. */
export function summary(runs, counts = []) {
  const k = runs.length;
  const lines = SCENARIOS.map(({ name }, i) => {
    const held = runs.filter((r) => r[i].why === null).length;
    return `${held === k ? 'ok  ' : 'FAIL'} ${held}/${k}  ${name}`;
  });
  const every = SCENARIOS.filter((_, i) => runs.every((r) => r[i].why === null)).length;
  const any = SCENARIOS.filter((_, i) => runs.some((r) => r[i].why === null)).length;
  const held = k > 1 ? `pass^${k}: ${every} of ${SCENARIOS.length} held every run · pass@${k}: ${any} held at least once` : `${every} of ${SCENARIOS.length} held`;
  const noise = counts.length > 0 ? [`notices: ${counts.map((c) => `${c.raised} raised, ${c.spurious} not about a scenario's pair`).join(' · ')}`] : [];
  return [...lines, '', held, ...noise].join('\n');
}

/** One fresh home: the conversations through the real hooks, the memory pass after each session, a tidy at the end. */
function runOnce(model) {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-memprobe-'));
  // Its llama-server stopped and its home removed, however the run ends.
  try {
    return runIn(root, model);
  } finally {
    leaveNothing(root);
  }
}

function runIn(root, model) {
  const env = { ...process.env, SUMO_AGENTS_HOME: join(root, 'home'), SUMO_AGENTS_SPAWN_LOG: join(root, 'spawn.log') };
  delete env.SUMO_AGENTS_SCRIBE;
  delete env.SUMO_AGENTS_MODEL_CMD;
  const sumo = (args, input) => spawnSync(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, ...args], { env, input, encoding: 'utf8' });

  // The local model and llama-server live in the real home; the throwaway one is pointed at the same files.
  const real = paths();
  if (existsSync(real.db)) {
    const realDb = new DatabaseSync(real.db, { readOnly: true });
    const llama = realDb.prepare(`SELECT value FROM meta WHERE key = 'llama.path'`).get()?.value;
    const file = modelFileOfUrl(realDb.prepare(`SELECT value FROM meta WHERE key = 'config.model.url'`).get()?.value);
    realDb.close();
    if (llama && existsSync(join(real.models, file))) {
      sumo(['config']);
      mkdirSync(join(env.SUMO_AGENTS_HOME, 'models'), { recursive: true });
      symlinkSync(join(real.models, file), join(env.SUMO_AGENTS_HOME, 'models', file));
      const db = new DatabaseSync(join(env.SUMO_AGENTS_HOME, 'memory.db'));
      db.prepare(`INSERT INTO meta (key, value) VALUES ('llama.path', ?)`).run(llama);
      db.close();
    }
  }
  mkdirSync(join(root, 'slate'));
  writeFileSync(join(root, 'slate', 'package.json'), '{"name":"slate"}\n');
  sumo(['project', 'add', join(root, 'slate')]);
  if (model) sumo(['config', 'memory.model', model]);

  const said = [];
  let session = null;
  const close = () => {
    said.push(`session ${session}: ${sumo(['memory', 'run']).stdout.split('\n')[0]}`);
    sumo(['hook', 'session-end'], JSON.stringify({ session_id: `probe-${session}` }));
  };
  for (const [id, text] of TURNS) {
    if (session !== null && id !== session) close();
    session = id;
    sumo(['hook', 'prompt'], JSON.stringify({ session_id: `probe-${id}`, prompt: text, cwd: join(root, 'slate') }));
  }
  close();
  said.push(sumo(['memory', 'run', '--tidy']).stdout.split('\n')[0]);

  const db = new DatabaseSync(join(root, 'home', 'memory.db'));
  const state = {
    memories: db.prepare('SELECT id, state, scope, title, cue, body, source_turn FROM memories ORDER BY id').all(),
    notices: db.prepare('SELECT memory_a, memory_b, kind FROM notices').all(),
    turns: new Map(db.prepare('SELECT id, text FROM user_turns').all().map((t) => [t.text, t.id])),
  };
  const cost = db.prepare('SELECT SUM(cost_usd) AS usd, COUNT(*) AS runs FROM model_runs').get();
  db.close();
  return { state, said, cost };
}

function main(argv) {
  const value = (name) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
  const runs = Number(value('runs') ?? 1);
  if (!Number.isInteger(runs) || runs < 1) throw new Error('--runs is a whole number, 1 or more');
  const judged = [];
  const counts = [];
  let usd = 0;
  let calls = 0;
  for (let run = 1; run <= runs; run++) {
    const { state, said, cost } = runOnce(value('model'));
    const verdicts = judgeAll(state);
    judged.push(verdicts);
    counts.push(noticeCounts(state));
    usd += cost.usd ?? 0;
    calls += cost.runs ?? 0;
    console.log(`run ${run}\n  ${said.join('\n  ')}`);
    for (const v of verdicts) if (v.why) console.log(`  FAIL ${v.name}: ${v.why}`);
    console.log(`  active memories: ${state.memories.filter((m) => m.state === 'active').length} · notices: ${counts.at(-1).raised}, ${counts.at(-1).spurious} not about a scenario's pair`);
    // Which, so a run that raised one says what to look at.
    for (const n of noise(state)) console.log(`    ${n.kind}: m${n.memory_a} "${n.a}" · m${n.memory_b} "${n.b}"`);
    console.log('');
  }
  console.log(summary(judged, counts));
  console.log(`\ncost: $${usd.toFixed(4)} over ${calls} calls`);
  return judged.every((r) => r.every((v) => v.why === null)) ? 0 : 1;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (cause) {
    console.error(`memory quality: ${cause.message}`);
    process.exit(2);
  }
}
