#!/usr/bin/env node
// `npm run build:bin`: a standalone `sumo` for this machine that needs no Node, compiled by Bun (needed for this
// build only, never a dependency). dist/sumo-agents/ holds the binary and, laid out as in the repo, the files it
// reads at run time (src/paths.mjs takes the binary's folder for the repo). Move the folder whole.
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const OUT = join(ROOT, 'dist', 'sumo-agents');

/** What the binary reads beside it: what the package ships other than code, the files in src/ that are not code, and package.json for the version. */
export function resources(root = ROOT) {
  const { files } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const shipped = files.filter((f) => !['bin/', 'src/'].includes(f));
  const inSrc = readdirSync(join(root, 'src')).filter((f) => !f.endsWith('.mjs')).map((f) => `src/${f}`);
  return [...shipped, ...inSrc, 'package.json'];
}

/** The bun command for this machine's binary: system CAs as the launcher's NODE_USE_SYSTEM_CA gives node, and no .env or bunfig picked up from wherever it runs. */
export function bunBuildArgs(outfile, { platform = process.platform, arch = process.arch } = {}) {
  return [
    'build', 'bin/sumo.mjs', '--compile', `--target=bun-${platform}-${arch}`, '--outfile', outfile,
    '--compile-exec-argv=--use-system-ca', '--no-compile-autoload-dotenv', '--no-compile-autoload-bunfig',
    // Ink's devtools, imported only under DEV=true with react-devtools-core installed: left out, as that package is.
    '--external', '*/devtools.js',
  ];
}

function main() {
  const version = spawnSync('bun', ['--version'], { encoding: 'utf8' });
  if (version.error || version.status !== 0) {
    console.error('bun is not on PATH. It is needed only to build the binary: install it from https://bun.sh, then run npm run build:bin again.');
    return 1;
  }
  rmSync(OUT, { recursive: true, force: true });
  mkdirSync(OUT, { recursive: true });
  const binary = join(OUT, 'sumo');
  const built = spawnSync('bun', bunBuildArgs(binary), { cwd: ROOT, stdio: 'inherit' });
  if (built.status !== 0) {
    console.error(`bun build failed (bun ${version.stdout.trim()}).`);
    return built.status ?? 1;
  }
  for (const f of resources()) cpSync(join(ROOT, f), join(OUT, f), { recursive: true });
  const mb = (statSync(binary).size / 1024 / 1024).toFixed(0);
  console.log(`${relative(process.cwd(), binary) || binary} — ${mb} MB, bun ${version.stdout.trim()}; the folder beside it holds what it reads.`);
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) process.exitCode = main();
