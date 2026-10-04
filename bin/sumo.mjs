#!/usr/bin/env node
import tls from 'node:tls';

// Node reads the environment setting at startup. Add system CAs to this process
// before loading the CLI, and enable the startup setting for its descendants.
process.env.NODE_USE_SYSTEM_CA = '1';
tls.setDefaultCACertificates([
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

const { main } = await import('../src/cli.mjs');
process.exitCode = await main(process.argv.slice(2));
