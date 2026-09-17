import { readFileSync } from 'node:fs';

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
  return `${flat.slice(0, half)} […] ${flat.slice(-half)}`;
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
    if (text) replies.push({ ts: entry.timestamp ?? '', text: abridge(text) });
  }
  return replies;
}
