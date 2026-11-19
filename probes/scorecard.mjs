// Has the scorecard written live, as /scorecard writes it, without touching yours: your database is copied into a throwaway
// home — so the writer is told the models your Discover found, and which are on — and the writer reads the web and writes
// the file there. Each call it makes is printed as it is answered, then the summary, what it said and the scores as
// `sumo models` would show them. Paid for: the writer is the strongest Claude model on, at its highest effort, held to $5.
//   set -a; source ~/.sumo-agents/eval.env; set +a; node probes/scorecard.mjs [--keep]
// --keep copies the file it wrote to yours, ~/.sumo-agents/scorecard.json, once it is written.
import { copyFileSync, existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { leaveNothing } from './throwaway.mjs';

const { paths } = await import('../src/paths.mjs');
const real = paths();
if (!existsSync(real.db)) throw new Error(`no database at ${real.db}: run sumo setup, then Discover on the settings page`);
const root = mkdtempSync(join(tmpdir(), 'sumo-agents-scorecard-'));
const home = join(root, 'home');
mkdirSync(home);
// A copy taken through SQLite, so what the WAL holds is in it too.
const source = new DatabaseSync(real.db, { readOnly: true });
source.exec(`VACUUM INTO '${join(home, 'memory.db').replaceAll("'", "''")}'`);
source.close();
process.env.SUMO_AGENTS_HOME = home;
delete process.env.SUMO_AGENTS_MODEL_CMD;

try {
  const { openDb } = await import('../src/db.mjs');
  const { EFFORTS } = await import('../src/catalog.mjs');
  const { refreshScorecard, scorecardLines, scorecardSummary, scorecardWriter } = await import('../src/scorecard.mjs');
  const db = openDb();
  try {
    const writer = scorecardWriter(db);
    console.log(`writer: ${writer ? `${writer.model}/${writer.effort}` : 'none on'}`);
    const started = Date.now();
    const since = new Map();
    const said = (call) => (call.name === 'write_scorecard' ? `${call.input?.sources?.length ?? 0} sources` : JSON.stringify(call.input).slice(0, 140));
    const result = await refreshScorecard(db, {
      onTool: (call) => since.set(call.id, Date.now()),
      onResult: (call, r) => console.log(`${r.isError ? '✗' : '⏺'} ${call.name} ${said(call)} — ${((Date.now() - (since.get(call.id) ?? Date.now())) / 1000).toFixed(1)} s\n    ${String(r.content).split('\n').slice(0, 6).join('\n    ')}`),
    });
    console.log(`\n${scorecardSummary(result)} — ${((Date.now() - started) / 1000).toFixed(0)} s\n`);
    if (result.text) console.log(`${result.text.trim()}\n`);
    console.log(scorecardLines(db, EFFORTS).join('\n'));
    if (result.ok && process.argv.includes('--keep')) {
      copyFileSync(paths().scorecard, real.scorecard);
      console.log(`\nkept: ${real.scorecard}`);
    }
  } finally {
    db.close();
  }
} finally {
  leaveNothing(root);
}
