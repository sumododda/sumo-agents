// What a probe leaves behind: nothing. Each live probe runs in a throwaway home of its own; when it ends — well or not —
// the llama-server it started there is stopped and the home is removed.
import { existsSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Stops the llama-server a throwaway home recorded — only when that process is still the one serving this home's
 * models (its command line names them), never one a pid now belongs to — and removes the folder the home is in.
 * `root` is the folder made for the run, holding the home at `root/home` or being the home itself.
 */
export function leaveNothing(root) {
  for (const home of [join(root, 'home'), root]) {
    const file = join(home, 'memory.db');
    if (!existsSync(file)) continue;
    let server = null;
    try {
      const db = new DatabaseSync(file, { readOnly: true });
      try {
        server = JSON.parse(db.prepare(`SELECT value FROM meta WHERE key = 'llama.server'`).get()?.value ?? 'null');
      } finally {
        db.close();
      }
    } catch {
      // No meta table yet, or no database worth reading: no server was recorded.
    }
    if (!Number.isInteger(server?.pid)) continue;
    const command = spawnSync('ps', ['-o', 'command=', '-p', String(server.pid)], { encoding: 'utf8' }).stdout ?? '';
    if (!command.includes(join(home, 'models'))) continue;
    try {
      process.kill(server.pid, 'SIGTERM');
    } catch {
      // Gone between the look and the signal.
    }
  }
  rmSync(root, { recursive: true, force: true });
}
