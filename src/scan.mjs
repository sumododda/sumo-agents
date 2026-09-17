import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Reads what a repository says about itself — deterministically, with no model.
 * Each fact has a stable key so a re-scan replaces exactly the fact it updates.
 *
 * Only pointers are taken, never content: what a repo already records stays in
 * the repo, and the agent is told where to read it.
 */

const ABOUT_MAX = 200;

const read = (file) => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return null;
  }
};

const readJson = (file) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
};

export function gitRemote(root) {
  try {
    return execFileSync('git', ['-C', root, 'remote', 'get-url', 'origin'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function nodePackageManager(root) {
  if (existsSync(join(root, 'bun.lock')) || existsSync(join(root, 'bun.lockb'))) return 'bun';
  if (existsSync(join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (existsSync(join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

function stack(root, pkg) {
  const parts = [];
  if (pkg) {
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    parts.push(existsSync(join(root, 'tsconfig.json')) || 'typescript' in deps ? 'TypeScript' : 'JavaScript');
    for (const [dep, label] of [['next', 'Next.js'], ['react', 'React'], ['vue', 'Vue'], ['svelte', 'Svelte'], ['express', 'Express']]) {
      if (dep in deps) {
        parts.push(label);
        break;
      }
    }
    parts.push(nodePackageManager(root));
  }
  if (existsSync(join(root, 'pyproject.toml')) || existsSync(join(root, 'requirements.txt'))) {
    parts.push('Python');
    if (existsSync(join(root, 'uv.lock'))) parts.push('uv');
    else if (existsSync(join(root, 'poetry.lock'))) parts.push('poetry');
  }
  if (existsSync(join(root, 'go.mod'))) parts.push('Go');
  if (existsSync(join(root, 'Cargo.toml'))) parts.push('Rust');
  if (existsSync(join(root, 'Gemfile'))) parts.push('Ruby');
  if (existsSync(join(root, 'pom.xml')) || existsSync(join(root, 'build.gradle')) || existsSync(join(root, 'build.gradle.kts'))) parts.push('JVM');
  if (existsSync(join(root, 'Package.swift'))) parts.push('Swift');
  return parts.length > 0 ? `stack: ${parts.join(', ')}` : null;
}

function commands(root, pkg) {
  const found = [];
  if (pkg?.scripts) {
    const pm = nodePackageManager(root);
    // `bun test` is bun's own runner, not the package's test script, so bun always goes through `run`.
    const run = (script) => (script === 'test' && pm !== 'bun' ? `${pm} test` : `${pm} run ${script}`);
    for (const script of ['test', 'lint', 'typecheck', 'build', 'dev']) {
      if (script in pkg.scripts) found.push(`${script} \`${run(script)}\``);
    }
  }
  const makefile = read(join(root, 'Makefile'));
  if (makefile) {
    for (const target of ['test', 'lint', 'build']) {
      if (new RegExp(`^${target}:`, 'm').test(makefile) && !found.some((f) => f.startsWith(`${target} `))) {
        found.push(`${target} \`make ${target}\``);
      }
    }
  }
  if (found.length === 0) {
    if (existsSync(join(root, 'go.mod'))) found.push('test `go test ./...`');
    if (existsSync(join(root, 'Cargo.toml'))) found.push('test `cargo test`');
    if (/\bpytest\b/.test(read(join(root, 'pyproject.toml')) ?? '')) found.push('test `pytest`');
  }
  return found.length > 0 ? `commands: ${found.join(' · ')}` : null;
}

/** The first real paragraph of the README: not a heading, badge, image, or HTML. */
function about(root) {
  const name = ['README.md', 'readme.md', 'README', 'README.rst'].find((f) => existsSync(join(root, f)));
  const text = name ? read(join(root, name)) : null;
  if (!text) return null;
  const paragraph = text
    .split(/\n\s*\n/)
    .map((p) => p.replace(/\s+/g, ' ').trim())
    .find((p) => p.length > 20 && !/^(#|!\[|\[!\[|<|```|=+$|-+$|>)/.test(p));
  if (!paragraph) return null;
  const plain = paragraph.replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').replace(/[*_`]/g, '');
  return `about: ${plain.length > ABOUT_MAX ? `${plain.slice(0, ABOUT_MAX - 1)}…` : plain}`;
}

function instructions(root) {
  const files = ['AGENTS.md', 'CLAUDE.md', join('.claude', 'CLAUDE.md')].filter((f) => existsSync(join(root, f)));
  // File names only: the card's first line already carries the project path, and a full path here gets clipped into uselessness.
  return files.length > 0 ? `has its own instructions — read ${files.join(' and ')} in the project root before editing` : null;
}

function workspaces(root, pkg) {
  const globs = Array.isArray(pkg?.workspaces) ? pkg.workspaces : pkg?.workspaces?.packages;
  if (globs?.length) return `monorepo: workspaces ${globs.join(', ')}`;
  if (existsSync(join(root, 'pnpm-workspace.yaml'))) return 'monorepo: pnpm workspaces (see pnpm-workspace.yaml)';
  return null;
}

function ci(root) {
  try {
    const count = readdirSync(join(root, '.github', 'workflows')).filter((f) => /\.ya?ml$/.test(f)).length;
    return count > 0 ? `CI: GitHub Actions, ${count} workflow${count === 1 ? '' : 's'}` : null;
  } catch {
    return null;
  }
}

/** Facts in the order the project card should show them. A key with nothing to say is simply absent. */
export function scan(root) {
  const pkg = readJson(join(root, 'package.json'));
  const facts = [
    ['instructions', instructions(root)],
    ['stack', stack(root, pkg)],
    ['commands', commands(root, pkg)],
    ['index', existsSync(join(root, '.codegraph')) ? 'indexed by CodeGraph — locate code with `codegraph explore` before grep' : null],
    ['workspaces', workspaces(root, pkg)],
    ['ci', ci(root)],
    ['about', about(root)],
  ];
  return facts.filter(([, body]) => body !== null).map(([key, body]) => ({ key, body }));
}
