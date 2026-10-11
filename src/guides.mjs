import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { getMeta } from './db.mjs';
import { REPO_ROOT } from './paths.mjs';
import { CONFIG_DEFAULTS } from './setup.mjs';
import { stem, words } from './text.mjs';

/**
 * A guide is the written way of doing one kind of work: a short numbered list in guides/<name>.md.
 * Telling the model to go and read one does not work — the session logs show the work happening
 * daily and the guides read about never — so the three that are ways of working fire by
 * themselves. A `when:` line in a header names the phrases that mean the user is asking for that
 * work; the guide rides in with the message that says one, judged by word stems the way a taught
 * workflow is, with no model asked and no token spent until it fires. A guide with no header is a
 * reference page: read on demand, never matched.
 */

const HEADER = /^---\n([\s\S]*?)\n---\n/;
const TITLE = /^#[^\n]*\n+/;

/**
 * Which guide wins when a message says more than one: "review my fix" is a review, "fix the broken add
 * button" is a fix. Also the only guides that fire — a header on any other file is ignored.
 */
const PRECEDENCE = ['review', 'fix', 'feature'];
/** What a worker's brief may carry unasked: a job is never a review of itself. */
export const WORKER_GUIDES = ['fix', 'feature'];

const stemsOf = (text) => new Set(words(text).map(stem));

/** `a, b, "a phrase, quoted"` → the phrases, each as the stems every one of which has to be in the message. */
function phrasesOf(value) {
  return value
    .split(',')
    .map((p) => p.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((p) => [...stemsOf(p)])
    .filter((stems) => stems.length > 0);
}

function parse(text) {
  const header = HEADER.exec(text);
  const fields = Object.fromEntries((header?.[1] ?? '').split('\n').map((l) => l.split(/:\s*/, 2)).filter(([k, v]) => k && v));
  return { when: fields.when ? phrasesOf(fields.when) : [], body: text.replace(HEADER, '').replace(TITLE, '').trim() };
}

const fileOf = (name) => join(REPO_ROOT, 'guides', `${name}.md`);

/** The guide's steps, without the header and the title — the brief has its own heading for them. */
export function guideBody(name) {
  return parse(readFileSync(fileOf(name), 'utf8')).body;
}

/** Every guide that fires, in the order they are tried. */
export function firingGuides() {
  const present = new Set(readdirSync(join(REPO_ROOT, 'guides')).map((f) => f.replace(/\.md$/, '')));
  return PRECEDENCE.filter((name) => present.has(name))
    .map((name) => ({ name, ...parse(readFileSync(fileOf(name), 'utf8')) }))
    .filter((g) => g.when.length > 0);
}

/** The guide the text asks for: the first, by precedence, with a phrase all of whose stems are in it. */
export function matchGuide(text, among = PRECEDENCE) {
  const have = stemsOf(String(text ?? ''));
  const hit = firingGuides().find((g) => among.includes(g.name) && g.when.some((stems) => stems.every((s) => have.has(s))));
  return hit?.name ?? null;
}

const RECEIVING = '**Receiving a review.**';

/**
 * The block the chat is handed. A fix or a feature is done in the conversation, so its steps go in whole.
 * A review is not: code written in a session is never judged in that session, so the chat is told to
 * delegate it and given only the half about receiving the findings.
 */
export function renderGuide(name) {
  const body = guideBody(name);
  if (name === 'review') {
    return `<guide review>\nCode written in this session is never reviewed in this session: delegate it to a reviewer (agent "reviewer", the task what was asked); then this is how to treat the findings:\n${body.slice(body.indexOf(RECEIVING) + RECEIVING.length).trim()}\n</guide>`;
  }
  const asking = name === 'fix' ? 'a fix' : 'something built';
  return `<guide ${name}>\nThe user is asking for ${asking}. This is how that is done here — follow it in order:\n${body}\n</guide>`;
}

/** `guides.auto`: whether guides ride in unasked and the end of a turn is held for an unchecked edit. */
export const autoGuides = (db) => (getMeta(db, 'config.guides.auto') ?? CONFIG_DEFAULTS['guides.auto']) !== 'off';
