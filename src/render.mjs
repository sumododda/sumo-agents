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
  if (m.state !== 'active') parts.push(m.state);
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
