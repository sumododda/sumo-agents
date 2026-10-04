import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { getMeta } from './db.mjs';
import { SECTIONS } from './export.mjs';
import * as memory from './memory.mjs';
import { UsageError } from './memory.mjs';

const PAGE = readFileSync(new URL('./page.html', import.meta.url), 'utf8');
const MAX_BODY = 64 * 1024;

/** What the page may do. Erasing for good is not here: `sumo forget --purge` stays a command someone types. */
const ACTIONS = {
  confirm: (db, id) => ({ memory: memory.confirm(db, id) }),
  reject: (db, id) => ({ memory: memory.reject(db, id) }),
  forget: (db, id) => ({ memory: memory.forget(db, id) }),
  edit: (db, id, { body }) => edit(db, id, body),
};

/** An edit is a new memory in the old one's place, so `sumo history` still shows what it said before. */
function edit(db, id, body) {
  const old = memory.get(db, id);
  // A fact read from the project's files would come back, unedited, beside the edit at the next rescan.
  if (old.scan_key !== null) {
    throw new UsageError(`m${id} was read from the project's files — change it there, then: sumo project rescan ${old.scope.slice('project:'.length)}`);
  }
  const { memory: saved, redacted } = memory.add(db, {
    type: old.type,
    project: old.scope === 'global' ? undefined : old.scope.slice('project:'.length),
    title: old.title,
    cue: old.cue,
    gate: old.gate ?? undefined,
    topic: old.topic,
    pin: old.pinned === 1,
    body: String(body ?? ''),
    writtenBy: 'user',
    supersedes: id,
  });
  return { memory: saved, redacted };
}

function snapshot(db) {
  return {
    machine: getMeta(db, 'machine'),
    sections: SECTIONS,
    projects: db.prepare('SELECT slug, name, path FROM projects ORDER BY slug').all(),
    memories: db.prepare(`SELECT * FROM memories WHERE state IN ('active', 'unconfirmed') ORDER BY id`).all(),
  };
}

async function readJson(req) {
  let text = '';
  // Decoded across chunks: a character split between two of them still arrives whole.
  req.setEncoding('utf8');
  for await (const chunk of req) {
    text += chunk;
    if (text.length > MAX_BODY) throw new UsageError('that is more than a memory');
  }
  try {
    return text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new UsageError('the request was not JSON');
  }
}

/**
 * The memory as a page, at http://127.0.0.1:<port>/<token>/. Anything else on the
 * machine can reach the port, so the address carries a secret; a browser can be
 * pointed here by another site, so a request must name this host, and a change
 * must come as JSON from this page — which another site cannot send without asking.
 * `unref`: the page lives only as long as whatever else keeps the process alive.
 */
export function servePage(db, { unref = false } = {}) {
  const token = randomBytes(16).toString('hex');
  const nonce = randomBytes(16).toString('base64');
  const html = PAGE.replaceAll('__NONCE__', nonce);
  const csp = `default-src 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; img-src data:; connect-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`;
  let origin = '';

  const server = createServer(async (req, res) => {
    // No connection outlives its answer: a browser holding one open would keep the process from ending.
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', connection: 'close', ...headers });
      res.end(body);
    };
    const json = (status, data) => send(status, 'application/json; charset=utf-8', JSON.stringify(data));
    try {
      if (`http://${req.headers.host}` !== origin) return json(403, { error: 'not this page' });
      const { pathname } = new URL(req.url, origin);
      const prefix = `/${token}/`;
      if (!pathname.startsWith(prefix)) return json(404, { error: 'no such page' });
      const path = pathname.slice(prefix.length);
      if (req.method === 'GET' && path === '') return send(200, 'text/html; charset=utf-8', html, { 'content-security-policy': csp });
      if (req.method === 'GET' && path === 'memories') return json(200, snapshot(db));

      const action = /^memories\/(\d+)\/(\w+)$/.exec(path);
      if (req.method !== 'POST' || !action || !Object.hasOwn(ACTIONS, action[2])) return json(404, { error: 'no such page' });
      if (req.headers.origin !== undefined && req.headers.origin !== origin) return json(403, { error: 'not from this page' });
      if (!/^application\/json\b/.test(req.headers['content-type'] ?? '')) return json(415, { error: 'changes come as JSON' });
      return json(200, ACTIONS[action[2]](db, Number(action[1]), await readJson(req)));
    } catch (cause) {
      return json(cause instanceof UsageError ? 400 : 500, { error: cause.message });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      if (unref) server.unref();
      origin = `http://127.0.0.1:${server.address().port}`;
      resolve({
        url: `${origin}/${token}/`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Asks the desktop to open the page. SUMO_AGENTS_SPAWN_LOG records the request
 * instead, as spawnDetached does, so the tests never open a browser.
 */
export function openInBrowser(url) {
  if (process.env.SUMO_AGENTS_SPAWN_LOG) {
    appendFileSync(process.env.SUMO_AGENTS_SPAWN_LOG, `open ${url}\n`);
    return;
  }
  const child = spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], { detached: true, stdio: 'ignore' });
  // No opener (a server, a container): the address has been printed, and that is enough.
  child.on('error', () => {});
  child.unref();
}
