// The code kept neat by the suite, not by a reviewer's memory: nothing imported that a file never uses, and nothing
// exported that no other file names. No linter is a dependency here; this reads the files as text, generously — a name
// mentioned anywhere else, a comment included, counts as used, so it only ever flags what is certainly dead.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { test } from 'node:test';
import { REPO_ROOT } from '../src/paths.mjs';

/** Every module of the repo's own: the code, the entry, the probes, the scripts and the tests. */
function modules(dir = REPO_ROOT, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.') || name === 'dist' || name === 'docs') continue;
    const path = join(dir, name);
    if (statSync(path).isDirectory()) modules(path, out);
    else if (name.endsWith('.mjs')) out.push(path);
  }
  return out;
}

const STATIC_IMPORT = /^import\s+(?:(\w+)\s*,?\s*)?(?:\{([^}]*)\}|\*\s+as\s+(\w+))?\s*from\s+['"][^'"]+['"];?\s*$/gm;
/** The names a file's static imports bring in, with the statement each came in by. */
function importedNames(text) {
  const names = [];
  for (const m of text.matchAll(STATIC_IMPORT)) {
    const [statement, deflt, braced, namespace] = m;
    if (deflt) names.push({ name: deflt, statement });
    if (namespace) names.push({ name: namespace, statement });
    for (const part of (braced ?? '').split(',').map((p) => p.trim()).filter(Boolean)) names.push({ name: part.split(/\s+as\s+/).at(-1).trim(), statement });
  }
  return names;
}

const EXPORTED = /^export\s+(?:async\s+)?(?:function\*?|const|let|class)\s+(\w+)/gm;
const count = (text, name) => (text.match(new RegExp(`(?<![\\w$.])${name.replace(/\$/g, '\\$')}(?![\\w$])`, 'g')) ?? []).length + (text.match(new RegExp(`\\.${name}\\b`, 'g')) ?? []).length;

test('no file imports a name it never uses', () => {
  const unused = [];
  for (const file of modules()) {
    const text = readFileSync(file, 'utf8');
    for (const { name, statement } of importedNames(text)) {
      const outside = text.replace(statement, '');
      if (count(outside, name) === 0) unused.push(`${relative(REPO_ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(unused, [], `imported and never used:\n${unused.join('\n')}`);
});

test('nothing in src/ is exported that no other file names: what only its own file uses is a plain declaration', () => {
  const all = modules();
  const texts = new Map(all.map((f) => [f, readFileSync(f, 'utf8')]));
  const dead = [];
  for (const file of all.filter((f) => relative(REPO_ROOT, f).startsWith('src/'))) {
    for (const [, name] of texts.get(file).matchAll(EXPORTED)) {
      const elsewhere = all.some((other) => other !== file && count(texts.get(other), name) > 0);
      if (!elsewhere) dead.push(`${relative(REPO_ROOT, file)}: ${name}`);
    }
  }
  assert.deepEqual(dead, [], `exported and named by no other file:\n${dead.join('\n')}`);
});
