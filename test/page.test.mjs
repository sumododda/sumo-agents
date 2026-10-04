// The memory page: the store in a browser, where the user reads it, says yes or no to guesses, edits and forgets.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { request } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { openDb } from '../src/db.mjs';
import { add, get, history } from '../src/memory.mjs';
import { servePage } from '../src/page.mjs';
import { ENTRY } from '../src/paths.mjs';
import { addProject } from '../src/projects.mjs';
import { freshHome, withHome } from './fixtures/env-sandbox.mjs';

/** Exactly the request a browser or another site would send, Host and Origin included — fetch will not set those. */
function raw(url, { method = 'GET', headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const req = request(url, { method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, text }));
    });
    req.on('error', reject);
    req.end(body);
  });
}

const post = (url, data) => raw(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(data ?? {}) });

/** A home with one global preference, one project decision and one guess waiting for a yes or no. */
async function withPage(fn) {
  await withHome(freshHome(), {}, async () => {
    const db = openDb();
    const page = await servePage(db);
    try {
      const project = mkdtempSync(join(tmpdir(), 'sumo-page-project-'));
      addProject(db, project, { slug: 'simba' });
      const pref = add(db, { type: 'preference', body: 'keep pull requests small', topic: 'git' }).memory;
      const dec = add(db, { type: 'decision', body: 'simba ships on fridays', project: 'simba' }).memory;
      const guess = add(db, { type: 'preference', body: 'prefers tabs over spaces', provenance: 'inferred' }).memory;
      await fn({ db, page, pref, dec, guess });
    } finally {
      await page.close();
      db.close();
    }
  });
}

test('the page shows what is remembered, by project, and what waits for a yes or no', async () => {
  await withPage(async ({ page, pref, dec, guess }) => {
    const html = await raw(page.url);
    assert.equal(html.status, 200);
    assert.match(html.headers['content-type'], /^text\/html/);
    assert.match(html.headers['content-security-policy'], /default-src 'none'/, 'nothing the page did not bring can run in it');

    const data = JSON.parse((await raw(`${page.url}memories`)).text);
    const byId = new Map(data.memories.map((m) => [m.id, m]));
    assert.equal(byId.get(pref.id).state, 'active');
    assert.equal(byId.get(dec.id).scope, 'project:simba');
    assert.equal(byId.get(guess.id).state, 'unconfirmed');
    assert.equal(data.projects.find((p) => p.slug === 'simba').slug, 'simba');
    assert.deepEqual(data.sections.map(([type]) => type), ['preference', 'decision', 'fact', 'gotcha', 'procedure']);
  });
});

test('yes, no, an edit and forget from the page change the store as the commands do, history kept', async () => {
  await withPage(async ({ db, page, pref, dec, guess }) => {
    const yes = await post(`${page.url}memories/${guess.id}/confirm`);
    assert.equal(yes.status, 200);
    assert.equal(get(db, guess.id).state, 'active');
    assert.equal(get(db, guess.id).provenance, 'stated');

    const again = await post(`${page.url}memories/${guess.id}/confirm`);
    assert.equal(again.status, 400);
    assert.match(JSON.parse(again.text).error, /only an unconfirmed memory can be confirmed/);

    const no = add(db, { type: 'fact', body: 'uses yarn', provenance: 'inferred' }).memory;
    assert.equal((await post(`${page.url}memories/${no.id}/reject`)).status, 200);
    assert.equal(get(db, no.id).state, 'rejected');

    const edited = await post(`${page.url}memories/${dec.id}/edit`, { body: 'simba ships on thursdays' });
    assert.equal(edited.status, 200);
    const fresh = JSON.parse(edited.text).memory;
    assert.equal(fresh.body, 'simba ships on thursdays');
    assert.equal(fresh.scope, 'project:simba', 'an edit stays where the memory was');
    assert.equal(fresh.type, 'decision');
    assert.equal(fresh.provenance, 'stated');
    assert.equal(get(db, dec.id).state, 'superseded');
    assert.deepEqual(history(db, fresh.id).map((m) => m.id), [dec.id, fresh.id]);

    const steps = add(db, { type: 'procedure', title: 'Before committing', cue: 'commit', gate: 'git commit', body: '1. run the tests', pin: true }).memory;
    const workflow = JSON.parse((await post(`${page.url}memories/${steps.id}/edit`, { body: '1. run the tests\n2. read the diff' })).text).memory;
    assert.deepEqual(
      { title: workflow.title, cue: workflow.cue, gate: workflow.gate, pinned: workflow.pinned, body: workflow.body },
      { title: 'Before committing', cue: 'commit', gate: 'git commit', pinned: 1, body: '1. run the tests\n2. read the diff' },
      'a workflow keeps its name, its cue and what it gates; only the steps change',
    );

    const blank = await post(`${page.url}memories/${pref.id}/edit`, { body: '   ' });
    assert.equal(blank.status, 400);
    assert.equal(get(db, pref.id).state, 'active', 'a refused edit changes nothing');

    assert.equal((await post(`${page.url}memories/${pref.id}/forget`)).status, 200);
    assert.equal(get(db, pref.id).state, 'invalid');

    assert.equal((await post(`${page.url}memories/${pref.id}/purge`)).status, 404, 'erasing for good stays a command');
    assert.equal((await post(`${page.url}memories/999/forget`)).status, 400);
  });
});

test('a fact read from the project files is not edited on the page: the next rescan would bring it back beside the edit', async () => {
  await withPage(async ({ db, page }) => {
    const scanned = db.prepare(`SELECT * FROM memories WHERE scope = 'project:simba' AND scan_key IS NOT NULL AND state = 'active'`).get();
    const refused = await post(`${page.url}memories/${scanned.id}/edit`, { body: 'simba has tests now' });
    assert.equal(refused.status, 400);
    assert.match(JSON.parse(refused.text).error, /change it there, then: sumo project rescan simba/);
    assert.equal(get(db, scanned.id).state, 'active', 'a refused edit changes nothing');
  });
});

test('an edit that arrives in pieces keeps every character, even one split between them', async () => {
  await withPage(async ({ db, page, pref }) => {
    const body = Buffer.from(JSON.stringify({ body: 'naïve café résumé' }));
    const cut = body.indexOf(Buffer.from('ï')) + 1;
    const text = await new Promise((resolve, reject) => {
      const req = request(`${page.url}memories/${pref.id}/edit`, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': body.length } }, (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (c) => (out += c));
        res.on('end', () => resolve(out));
      });
      req.on('error', reject);
      req.write(body.subarray(0, cut));
      setTimeout(() => req.end(body.subarray(cut)), 50);
    });
    assert.equal(get(db, JSON.parse(text).memory.id).body, 'naïve café résumé');
  });
});

test('the page answers only at its own address: no token, another host, or a post from another site is refused', async () => {
  await withPage(async ({ db, page, pref }) => {
    const { origin, host } = new URL(page.url);
    assert.equal((await raw(`${origin}/`)).status, 404);
    assert.equal((await raw(`${origin}/memories`)).status, 404);
    assert.equal((await raw(page.url, { headers: { host: `attacker.example:${new URL(page.url).port}` } })).status, 403, 'a rebound DNS name is not this page');

    const form = await raw(`${page.url}memories/${pref.id}/forget`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}' });
    assert.equal(form.status, 415, 'a post another site can send without asking is refused');
    const elsewhere = await raw(`${page.url}memories/${pref.id}/forget`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://attacker.example' }, body: '{}' });
    assert.equal(elsewhere.status, 403);
    assert.equal(get(db, pref.id).state, 'active');
    assert.equal(host.startsWith('127.0.0.1:'), true, 'it listens on this machine only');
  });
});

test('sumo memory serves the page, asks for it to be opened, and stops cleanly on Ctrl-C', async () => {
  const home = freshHome();
  const spawnLog = join(mkdtempSync(join(tmpdir(), 'sumo-agents-spawn-')), 'spawned.log');
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ENTRY, 'memory'], {
    env: { ...process.env, SUMO_AGENTS_HOME: home, SUMO_AGENTS_SPAWN_LOG: spawnLog },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.setEncoding('utf8');
  const url = await new Promise((resolve, reject) => {
    child.stdout.on('data', (c) => {
      out += c;
      const m = /http:\/\/127\.0\.0\.1:\d+\/\w+\//.exec(out);
      if (m) resolve(m[0]);
    });
    child.on('exit', (code) => reject(new Error(`exited ${code} before serving: ${out}`)));
  });
  assert.equal((await raw(url)).status, 200);
  assert.equal(readFileSync(spawnLog, 'utf8'), `open ${url}\n`);
  const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  child.kill('SIGINT');
  assert.equal(await exited, 0);
});
