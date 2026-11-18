/**
 * What an agent reads. Terse on purpose: every character here is paid for in
 * a model's context. The readable view for people lives in export.mjs.
 */

import { clip } from './text.mjs';

const TYPE_TAG = { preference: 'pref', fact: 'fact', decision: 'dec', gotcha: 'gotcha', procedure: 'proc' };
const LINE_BODY_MAX = 160;

export function scopeLabel(scope) {
  return scope === 'global' ? 'global' : scope.slice('project:'.length);
}

function tags(m) {
  const parts = [TYPE_TAG[m.type], scopeLabel(m.scope), m.provenance];
  // Stored as invalid; said as what the user did to it.
  if (m.state !== 'active') parts.push(m.state === 'invalid' ? 'forgotten' : m.state);
  if (m.pinned) parts.push('pinned');
  return `[${parts.join('·')}]`;
}

/** One memory, one line: `m12 [pref·simba·stated] never push to main`. */
export function line(m) {
  const what = m.type === 'procedure' ? `"${m.title}"${m.cue ? ` — when: ${m.cue}` : ''}` : clip(m.body, LINE_BODY_MAX);
  return `m${m.id} ${tags(m)} ${what}`;
}

/** Everything about one memory, body in full. */
export function detail(m) {
  const out = [`m${m.id} ${tags(m)}${m.type === 'procedure' ? ` "${m.title}"` : ''}`];
  if (m.cue) out.push(`when: ${m.cue}`);
  if (m.gate) out.push(`gate: ${m.gate}   (shell commands matching this wait until these steps have been shown)`);
  if (m.topic) out.push(`topic: ${m.topic}`);
  if (m.keys) out.push(`keys: ${m.keys}   (search terms the writer added — not the user's words)`);
  out.push(`since: ${m.valid_from.slice(0, 10)}${m.invalid_at ? ` · until: ${m.invalid_at.slice(0, 10)}` : ''}`);
  if (m.superseded_by !== null) out.push(`superseded by: m${m.superseded_by}`);
  if (m.source_quote) out.push(`quote: "${m.source_quote}"`);
  out.push(`written by: ${m.written_by}`, '', m.body);
  return out.join('\n');
}

export function historyLine(m) {
  const span = `${m.valid_from.slice(0, 10)} → ${m.invalid_at ? m.invalid_at.slice(0, 10) : '          '}`;
  return `m${m.id}  ${span}  ${m.state.padEnd(11)} ${clip(m.type === 'procedure' ? m.title : m.body, LINE_BODY_MAX)}`;
}

/** A memory as a search prints it: its line, and the day it was said. */
export const foundLine = (m) => `${line(m)} · ${m.valid_from.slice(0, 10)}`;

const SAID_BY = { turn: 'you said', reply: 'sumo said' };
const AROUND_MAX = 110;
const saidTags = (e) => `[${SAID_BY[e.kind]}${e.project ? `·${e.project}` : ''}]`;

/** A turn or a reply as a search prints it: `t481 [you said·simba] …the part around the words… · 2026-11-02`. */
export const saidLine = (hit) => `${hit.ref} ${saidTags(hit)} ${hit.excerpt} · ${hit.ts.slice(0, 10)}`;

/** One turn or reply whole, then what was said around it in its conversation, the one asked for marked. */
export function saidDetail({ entry, around }) {
  const when = (e) => `${e.ts.slice(0, 10)} ${e.ts.slice(11, 16)}`;
  const cut = entry.full_len > entry.text.length ? ` · the first ${entry.text.length} of ${entry.full_len} characters, the rest was not kept` : '';
  const out = [`${entry.ref} ${saidTags(entry)} ${when(entry)} · conversation ${entry.session_id.slice(0, 8)}${cut}`, '', entry.text];
  if (around.length > 1) {
    out.push('', 'around it (sumo show <id> opens one whole):');
    for (const e of around) out.push(`${e === entry ? '>' : ' '} ${e.ref} ${saidTags(e)} ${when(e)} ${clip(e.text, AROUND_MAX)}`);
  }
  return out.join('\n');
}
