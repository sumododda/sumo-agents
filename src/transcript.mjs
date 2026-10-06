import { closeSync, fstatSync, openSync, readSync } from 'node:fs';
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

/** How much of a transcript's end is read first; each look that finds too little reads four times as much. */
const FIRST_LOOK_BYTES = 1024 * 1024;

/**
 * A transcript's last lines, `bytes` of them at most, and whether that was the whole file. A session's transcript
 * grows to hundreds of megabytes; what is asked of it lives at its end, and a string past ~512 MB cannot even be built.
 */
function tailOf(file, bytes) {
  const fd = openSync(file, 'r');
  try {
    const size = fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    readSync(fd, buffer, 0, buffer.length, start);
    const text = buffer.toString('utf8');
    // A window that starts mid-line drops that piece: it is not a line of JSON. One with no line end in it holds no whole line.
    if (start === 0) return { lines: text.split('\n'), whole: true };
    const cut = text.indexOf('\n');
    return { lines: cut === -1 ? [] : text.slice(cut + 1).split('\n'), whole: false };
  } finally {
    closeSync(fd);
  }
}

/**
 * The transcript read from its end, in windows that grow until `enough(lines)` says so or the whole file has been
 * read. Returns what `enough` last returned, or null for a file that cannot be read.
 */
export function readBackwards(file, enough) {
  try {
    for (let bytes = FIRST_LOOK_BYTES; ; bytes *= 4) {
      const { lines, whole } = tailOf(file, bytes);
      const answer = enough(lines, whole);
      if (answer !== undefined || whole) return answer ?? null;
    }
  } catch {
    return null;
  }
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
export function assistantReplies(file, sinceIso, wanted = Infinity) {
  // Read from the end: the last `wanted` replies since `sinceIso` are all that is ever asked for.
  return (
    readBackwards(file, (lines, whole) => {
      const replies = [];
      let reachedSince = false;
      for (const line of lines) {
        if (!line.includes('"assistant"')) continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        if (entry.type !== 'assistant' || entry.isSidechain || !Array.isArray(entry.message?.content)) continue;
        if (sinceIso && entry.timestamp && entry.timestamp < sinceIso) {
          reachedSince = true;
          continue;
        }
        const text = entry.message.content
          .filter((block) => block?.type === 'text' && typeof block.text === 'string')
          .map((block) => block.text)
          .join('\n')
          .trim();
        if (text) replies.push({ ts: entry.timestamp ?? '', text: abridge(redact(text).text) });
      }
      return whole || reachedSince || replies.length >= wanted ? replies : undefined;
    }) ?? []
  );
}
