import { readFileSync } from 'node:fs';
import { redact } from './redact.mjs';
import { head } from './text.mjs';

/**
 * Generous on purpose: the closing reply of a piece of work is where the traps it hit are mentioned,
 * usually mid-paragraph. At 400 characters a real "tests only pass with SIMBA_TZ set" was cut out.
 */
const REPLY_MAX = 1200;

/**
 * Keeps both ends of a long reply. The head says what was attempted and the
 * tail says what was done; the middle is the part worth losing.
 */
export function abridge(text, max = REPLY_MAX) {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= max) return flat;
  const half = Math.floor((max - 5) / 2);
  // Either cut can fall inside an emoji; a lone half of one makes the whole request one the API refuses.
  const tail = flat.slice(-half);
  return `${head(flat, half)} […] ${/^[\uDC00-\uDFFF]/.test(tail) ? tail.slice(1) : tail}`;
}

/**
 * The assistant's own words from a Claude Code transcript, since a given time.
 *
 * Only `text` blocks of main-thread assistant messages are read. Tool calls,
 * tool results, thinking and sub-agent traffic are skipped on purpose: they are
 * large, and tool output is exactly where instructions injected by a web page
 * or a file would arrive. Nothing from there may ever reach the memory writer.
 *
 * The format is not a stable contract, so anything unexpected is ignored rather
 * than fatal — without this file the writer still has the user's own turns.
 * A secret the assistant repeated is scrubbed like one the user typed, and before
 * the reply is cut: half a token left at the edge of the cut would still be a leak.
 */
export function assistantReplies(file, sinceIso) {
  let raw;
  try {
    raw = readFileSync(file, 'utf8');
  } catch {
    return [];
  }
  const replies = [];
  for (const line of raw.split('\n')) {
    if (!line.includes('"assistant"')) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
    if (sinceIso && entry.timestamp && entry.timestamp < sinceIso) continue;
    const text = entry.message.content
      .filter((block) => block?.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
    if (text) replies.push({ ts: entry.timestamp ?? '', text: abridge(redact(text).text) });
  }
  return replies;
}
