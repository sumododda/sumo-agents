// What a command loads before it does anything. `sumo hook <event>` runs on every prompt when sumo is wired into a
// harness, and `--version`, `help`, `search` and `memory status` should answer at once: none of them may load the API's
// SDK, the screen's Ink and React, the chat or the agent loop before it needs them. Read from the static imports, so it
// is exact and costs nothing to run; a heavy module is reached only through a dynamic import() where it is used.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';

/** Every module a file reaches through static `import … from` and `export … from`, packages by name. */
function staticGraph(entry) {
  const seen = new Set();
  const packages = new Set();
  const walk = (file) => {
    if (seen.has(file)) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    // Static imports, and a top-level `await import('…')` — one at the start of a line, run as the module loads; an
    // import() inside a function, indented, runs only when that function does.
    const specs = [...text.matchAll(/^(?:import|export)\s[^'"]*?\sfrom\s+['"]([^'"]+)['"]/gm), ...text.matchAll(/^(?:(?:const|let|var)\s[^=\n]*=\s*)?await\s+import\(\s*['"]([^'"]+)['"]\s*\)/gm)];
    for (const [, spec] of specs) {
      if (spec.startsWith('.')) walk(resolve(dirname(file), spec));
      else if (!spec.startsWith('node:')) packages.add(spec.split('/').slice(0, spec.startsWith('@') ? 2 : 1).join('/'));
    }
  };
  walk(entry);
  return { modules: [...seen].map((f) => f.slice(REPO_ROOT.length + 1)), packages: [...packages] };
}

const HEAVY_PACKAGES = ['@anthropic-ai/sdk', 'ink', 'react'];
// The job commands' own module is light (no SDK, no screen): measured, `--version` and `hook prompt` start in ~60 ms with it.
const HEAVY_MODULES = ['src/chat.mjs', 'src/loop.mjs', 'src/ui.mjs', 'src/herdr.mjs', 'src/page.mjs'];

for (const entry of ['bin/sumo.mjs', 'src/cli.mjs', 'src/hooks.mjs']) {
  test(`${entry} loads none of the heavy modules until a command uses them: the SDK, Ink, React, the chat, the loop, the screen`, () => {
    const { modules, packages } = staticGraph(join(REPO_ROOT, entry));
    assert.deepEqual(packages.filter((p) => HEAVY_PACKAGES.includes(p)), [], `reached statically: ${packages.join(', ')}`);
    assert.deepEqual(modules.filter((m) => HEAVY_MODULES.includes(m)), [], `reached statically:\n${modules.join('\n')}`);
  });
}
