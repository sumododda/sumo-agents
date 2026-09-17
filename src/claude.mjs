import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { REPO_ROOT } from './paths.mjs';

/**
 * Everything that is specific to Claude Code lives in this file and in
 * hooks.mjs's payload reader. Another harness gets its own sibling.
 */

/** settings.local.json is Claude Code's own place for machine-specific settings: gitignored, never shared. */
function localSettingsPath() {
  return process.env.SUMO_AGENTS_CLAUDE_LOCAL_SETTINGS || join(REPO_ROOT, '.claude', 'settings.local.json');
}

/**
 * Lets sessions started in this repo read and edit a project that lives
 * elsewhere, without a permission prompt per file. Returns a note for the
 * caller to print, or null when nothing changed.
 */
export function allowDirectory(dir) {
  const file = localSettingsPath();
  let settings = {};
  try {
    settings = JSON.parse(readFileSync(file, 'utf8'));
  } catch (cause) {
    // A missing file is the normal first run. A file that exists but does not
    // parse is the user's to fix: overwriting it would destroy their settings.
    if (cause.code !== 'ENOENT') return `could not read ${file} — add "${dir}" to permissions.additionalDirectories yourself`;
  }

  const permissions = (settings.permissions ??= {});
  const dirs = (permissions.additionalDirectories ??= []);
  if (dirs.includes(dir)) return null;
  dirs.push(dir);

  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`);
  return `Claude Code may now work in ${dir} from the next session; for this one, run: /add-dir ${dir}`;
}
