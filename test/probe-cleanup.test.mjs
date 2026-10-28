// A probe's throwaway home is left as it was found: its llama-server stopped, its folder gone — whether the run went
// well or not — and nothing else touched: a server started for another home is not this probe's to stop.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { test } from 'node:test';
import { leaveNothing } from '../probes/throwaway.mjs';

/** A stand-in for llama-server, its command line naming a models folder, as the real one's does. */
function standIn(models) {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)', '--', '--models-dir', models, '--port', '0'], { detached: true, stdio: 'ignore' });
  child.unref();
  return child.pid;
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const recordServer = (home, pid) => {
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'memory.db'));
  db.exec(`CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)`);
  db.prepare(`INSERT OR REPLACE INTO meta (key, value) VALUES ('llama.server', ?)`).run(JSON.stringify({ pid, port: 0 }));
  db.close();
};

test("a probe's throwaway home goes with its server; a server of another home is left running", async () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-probe-cleanup-'));
  const home = join(root, 'home');
  const ours = standIn(join(home, 'models'));
  const elsewhere = mkdtempSync(join(tmpdir(), 'sumo-agents-other-home-'));
  const theirs = standIn(join(elsewhere, 'models'));
  try {
    recordServer(home, ours);
    // A record that names a process of another home is not acted on.
    const other = mkdtempSync(join(tmpdir(), 'sumo-agents-probe-cleanup-'));
    recordServer(join(other, 'home'), theirs);
    leaveNothing(other);
    assert.equal(alive(theirs), true, "another home's server is not this probe's to stop");
    assert.equal(existsSync(other), false);

    leaveNothing(root);
    for (let i = 0; i < 50 && alive(ours); i++) await new Promise((r) => setTimeout(r, 20));
    assert.equal(alive(ours), false, 'the throwaway server is stopped');
    assert.equal(existsSync(root), false, 'the throwaway home is gone');
    leaveNothing(root);
  } finally {
    for (const pid of [ours, theirs]) if (alive(pid)) process.kill(pid, 'SIGKILL');
  }
});
