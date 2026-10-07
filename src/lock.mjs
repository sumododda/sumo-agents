import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { UsageError } from './memory.mjs';

/**
 * One holder per thing — a job's run, a chat session. The lock names the process that holds it, so one left behind
 * by a process that died is seen for what it is and taken over. `busy(holder)` is what to say when a live process has it.
 */
export function takeLock(file, busy) {
  for (let attempt = 0; ; attempt++) {
    try {
      writeFileSync(file, String(process.pid), { flag: 'wx', mode: 0o600 });
      return file;
    } catch (cause) {
      if (cause.code !== 'EEXIST' || attempt > 0) throw cause;
      const holder = heldBy(file);
      if (holder) throw new UsageError(busy(holder));
      rmSync(file, { force: true });
    }
  }
}

/** The live process holding a lock, or null: no lock, or one a process died with in its hand. */
export function heldBy(file) {
  const pid = holderOf(file);
  return pid && alive(pid) ? pid : null;
}

/** The process a lock names; none when the run that held it ended between taking a look and reading it. */
function holderOf(file) {
  try {
    return Number(readFileSync(file, 'utf8'));
  } catch (cause) {
    if (cause.code === 'ENOENT') return 0;
    throw cause;
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (cause) {
    return cause.code === 'EPERM';
  }
}
