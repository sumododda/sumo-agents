// What the settings page does when a row changes, run from a test in a home of its own: a setting through config(), a
// model's switch through the catalog, Discover through discoverModels — said and exited as `sumo` says and exits.
import { discoverModels, modelLines, setModel } from '../../src/catalog.mjs';
import { openDb } from '../../src/db.mjs';
import { config } from '../../src/setup.mjs';

const [what, ...args] = process.argv.slice(2);
try {
  let lines;
  if (what === 'config') lines = config(args[0], args[1]);
  else {
    const db = openDb();
    try {
      if (args[0] === 'discover') {
        const result = await discoverModels(db);
        if (!result.ok) throw Object.assign(new Error(`could not check the models — ${result.error}; nothing was changed`), { code: /no Anthropic credential/.test(result.error) ? 4 : 1 });
        lines = modelLines(db);
      } else {
        setModel(db, args[1], args[0] === 'enable');
        lines = modelLines(db, [args[1]]);
      }
    } finally {
      db.close();
    }
  }
  process.stdout.write(`${lines.join('\n')}\n`);
} catch (cause) {
  process.stderr.write(`sumo: ${cause.message}\n`);
  process.exit(cause.exit ?? cause.code ?? 1);
}
