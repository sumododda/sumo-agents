#!/usr/bin/env node
import tls from 'node:tls';

// NO_COLOR (no-color.org) is honoured by the whole screen, not only by sumo's own lines: chalk, which ink draws with,
// reads FORCE_COLOR once, when it loads, and ignores NO_COLOR. Said to it here, before anything loads it. Empty is
// not set, and a FORCE_COLOR the user gave wins.
if (process.env.NO_COLOR && !process.env.FORCE_COLOR) process.env.FORCE_COLOR = '0';

// Node reads the environment setting at startup. Add system CAs to this process
// before loading the CLI, and enable the startup setting for its descendants.
// Bun has no setDefaultCACertificates: the binary it builds is started with
// --use-system-ca instead (scripts/build-bin.mjs).
process.env.NODE_USE_SYSTEM_CA = '1';
tls.setDefaultCACertificates?.([
  ...tls.getCACertificates('default'),
  ...tls.getCACertificates('system'),
]);

// node:sqlite still announces itself as experimental on Node 22–24. The
// launcher passes --disable-warning; this covers `node bin/sumo.mjs` run
// directly. It has to happen before the import below, which is why that
// import is dynamic.
const emitWarning = process.emitWarning;
process.emitWarning = (warning, ...rest) => {
  const name = typeof rest[0] === 'string' ? rest[0] : (rest[0]?.type ?? warning?.name);
  if (name === 'ExperimentalWarning') return;
  emitWarning.call(process, warning, ...rest);
};

// A reader that stops early (`sumo export | head`) closes the pipe: that is the
// end of the output, not a crash with a stack trace. macOS says it as EPIPE, or
// as ENOTCONN when the reader is gone before the write lands.
process.stdout.on('error', (error) => {
  if (error.code !== 'EPIPE' && error.code !== 'ENOTCONN') throw error;
  process.exit(0);
});

// A crash is written down — redacted, in logs/ — and otherwise ends as Node ends it.
const { watchForCrashes } = await import('../src/logs.mjs');
const { VERSION } = await import('../src/paths.mjs');
watchForCrashes(VERSION);

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
