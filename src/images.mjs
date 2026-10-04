import { execFile } from 'node:child_process';
import { readFileSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { promisify } from 'node:util';

/**
 * Pictures for the chat, as the API takes them: the media type, told from the
 * first bytes rather than the name, and the bytes in base64. They come from
 * the clipboard — macOS's, read with osascript — or from files dropped on the
 * terminal, which arrive pasted as their paths.
 */

/** The most the API takes of one image, base64 encoded. */
export const MAX_IMAGE_BYTES = 10_000_000;
const NAMES = /\.(png|jpe?g|gif|webp)$/i;

const KINDS = [
  ['image/png', (b) => b.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))],
  ['image/jpeg', (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff],
  ['image/gif', (b) => /^GIF8[79]a/.test(b.toString('latin1', 0, 6))],
  ['image/webp', (b) => b.toString('latin1', 0, 4) === 'RIFF' && b.toString('latin1', 8, 12) === 'WEBP'],
];

/** Bytes as an image to send, or null when they are none the API reads; one too big to send is said back. */
function imageOf(bytes) {
  const mediaType = KINDS.find(([, is]) => is(bytes))?.[0];
  if (!mediaType) return null;
  const data = bytes.toString('base64');
  if (data.length > MAX_IMAGE_BYTES) throw new Error(`that image is too big — ${(data.length / 1e6).toFixed(1)} MB encoded, and the API takes ${MAX_IMAGE_BYTES / 1e6} MB`);
  return { mediaType, data };
}

/** What osascript prints for the clipboard as PNG: `«data PNGf89504E47…»`. It fails when there is no image on it. */
const readMacClipboard = async () => (await promisify(execFile)('osascript', ['-e', 'the clipboard as «class PNGf»'], { maxBuffer: 4 * MAX_IMAGE_BYTES, timeout: 10_000 })).stdout;

/** The image on the clipboard, or null when there is none. `read` is swapped in tests. */
export async function clipboardImage(read = readMacClipboard) {
  let printed;
  try {
    printed = await read();
  } catch (cause) {
    // Too much to read is an image too big to send, not an empty clipboard.
    if (cause.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error(`that image is too big — the API takes ${MAX_IMAGE_BYTES / 1e6} MB encoded`);
    return null;
  }
  const hex = /«data PNGf([0-9A-Fa-f]+)»/.exec(printed)?.[1];
  return hex ? imageOf(Buffer.from(hex, 'hex')) : null;
}

/**
 * The words of a paste the way a terminal writes dropped paths: a space or quote kept with a backslash, or the whole path in quotes.
 * Only a plain space, tab or line end parts them — a screenshot's name holds a narrow no-break space that no terminal escapes.
 */
const wordsOf = (text) => (text.trim().match(/'[^']*'|"[^"]*"|(?:\\.|[^ \t\r\n\\'"])+/g) ?? []).map((w) => (/^['"]/.test(w) ? w.slice(1, -1) : w.replace(/\\(.)/g, '$1')));

/** The images a paste is, when every word of it is the path of an image file; null when it is text. */
export function droppedImages(text) {
  const paths = wordsOf(text);
  if (paths.length === 0 || !paths.every((p) => isAbsolute(p) && NAMES.test(p) && statSync(p, { throwIfNoEntry: false })?.isFile())) return null;
  const images = paths.map((p) => imageOf(readFileSync(p)));
  return images.every(Boolean) ? images : null;
}
