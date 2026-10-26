const PREFIXES = [':', '$', '@'];

/**
 * The class every sumo database is opened with. Under Node it is node:sqlite's DatabaseSync itself. The binary
 * `npm run build:bin` makes runs on Bun, which has no node:sqlite: there it is bun:sqlite's Database made to answer
 * the calls sumo makes the way DatabaseSync does. Node never loads bun:sqlite, nor Bun node:sqlite.
 */
export const DatabaseSync = process.versions.bun
  ? bunDatabaseSync((await import('bun:sqlite')).Database)
  : (await import('node:sqlite')).DatabaseSync;

/**
 * The values for one statement, as bun:sqlite takes them. node:sqlite binds a named value given bare ({ id }) to
 * :id, $id or @id, and bun:sqlite only one spelled with its prefix; node:sqlite leaves a placeholder it was given no
 * value for NULL, and bun:sqlite refuses the statement.
 */
export function bunArgs(args, count) {
  const [first] = args;
  if (args.length === 1 && first !== null && typeof first === 'object' && !ArrayBuffer.isView(first)) {
    const named = {};
    for (const [key, value] of Object.entries(first)) {
      for (const name of PREFIXES.includes(key[0]) ? [key] : PREFIXES.map((p) => `${p}${key}`)) named[name] = value;
    }
    return [named];
  }
  return args.length < count ? [...args, ...Array(count - args.length).fill(null)] : args;
}

/** DatabaseSync's surface over bun:sqlite's Database, for what sumo uses: prepare().get/all/run/iterate, exec, close. */
export function bunDatabaseSync(Database) {
  const statement = (db, stmt) => {
    const bind = (args) => bunArgs(args, stmt.paramsCount);
    return {
      // No row is undefined from node:sqlite, null from bun:sqlite.
      get: (...args) => stmt.get(...bind(args)) ?? undefined,
      all: (...args) => stmt.all(...bind(args)),
      run: (...args) => {
        const { lastInsertRowid } = stmt.run(...bind(args));
        // bun:sqlite counts the rows its triggers wrote too (an index kept in step); node:sqlite, as SQLite's changes(), the statement's own.
        return { changes: db.query('SELECT changes() AS n').get().n, lastInsertRowid };
      },
      iterate: (...args) => stmt.iterate(...bind(args)),
    };
  };
  return class DatabaseSync {
    #db;

    constructor(path, { readOnly = false } = {}) {
      this.#db = new Database(path, readOnly ? { readonly: true } : { readwrite: true, create: true });
      // node:sqlite turns foreign keys on for every connection it opens; SQLite's own default is off.
      this.#db.exec('PRAGMA foreign_keys = ON');
    }

    prepare(sql) {
      return statement(this.#db, this.#db.prepare(sql));
    }

    exec(sql) {
      this.#db.exec(sql);
    }

    close() {
      this.#db.close();
    }
  };
}
