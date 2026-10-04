// Pictures for the chat: an image on the clipboard, or image files dropped on the terminal as their paths.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { clipboardImage, droppedImages, MAX_IMAGE_BYTES } from '../src/images.mjs';

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
const JPEG = Buffer.from('ffd8ffe000104a464946', 'hex');
const GIF = Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1');
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBPVP8 ')]);

test('the clipboard: an image on it comes back as PNG in base64; none, or a clipboard that cannot be read, is no image', async () => {
  const image = await clipboardImage(async () => `«data PNGf${PNG.toString('hex').toUpperCase()}»\n`);
  assert.deepEqual(image, { mediaType: 'image/png', data: PNG.toString('base64') });
  assert.equal(await clipboardImage(async () => { throw new Error("Can't make some data into the expected type."); }), null);
  // Bytes that only claim to be PNG are not sent as one: the API refuses a media type the bytes do not match.
  assert.equal(await clipboardImage(async () => `«data PNGf${Buffer.from('not a picture').toString('hex')}»`), null);
  await assert.rejects(clipboardImage(async () => `«data PNGf${Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]).toString('hex')}»`), /too big/);
  // One too big even to read is said to be too big, not taken for an empty clipboard.
  await assert.rejects(clipboardImage(async () => { throw Object.assign(new Error('stdout maxBuffer length exceeded'), { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' }); }), /too big/);
});

test('a paste that is only paths of image files is those images, typed by their bytes; anything else is text', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sumo-agents-images-'));
  // As macOS names a screenshot: a narrow no-break space before the AM, which no terminal escapes.
  const shot = join(dir, 'Screenshot 2026-10-04 at 10.56.56 AM.png');
  const photo = join(dir, "it's.jpg");
  writeFileSync(shot, PNG);
  writeFileSync(photo, JPEG);
  writeFileSync(join(dir, 'a.gif'), GIF);
  writeFileSync(join(dir, 'b.webp'), WEBP);
  writeFileSync(join(dir, 'fake.png'), 'just text');
  writeFileSync(join(dir, 'notes.txt'), 'just text');

  // Dropped files come as their paths: a space or quote escaped with a backslash, or the whole path quoted.
  const escaped = (path) => path.replace(/([ '"\\])/g, '\\$1');
  assert.deepEqual(droppedImages(escaped(shot)), [{ mediaType: 'image/png', data: PNG.toString('base64') }]);
  assert.deepEqual(droppedImages(` '${shot}' ${escaped(photo)}\n`).map((i) => i.mediaType), ['image/png', 'image/jpeg']);
  assert.deepEqual(droppedImages(`"${join(dir, 'a.gif')}" ${join(dir, 'b.webp')}`).map((i) => i.mediaType), ['image/gif', 'image/webp']);

  assert.equal(droppedImages('just some words'), null);
  assert.equal(droppedImages(`look at ${escaped(shot)}`), null, 'words around a path make it text');
  assert.equal(droppedImages(`${escaped(shot)} ${join(dir, 'notes.txt')}`), null, 'one file that is not an image makes it all text');
  assert.equal(droppedImages(join(dir, 'fake.png')), null, 'a name is not enough: the bytes say what it is');
  assert.equal(droppedImages(join(dir, 'gone.png')), null);
  assert.equal(droppedImages(''), null);

  const big = join(dir, 'big.png');
  writeFileSync(big, Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
  assert.throws(() => droppedImages(big), /too big/);
});
