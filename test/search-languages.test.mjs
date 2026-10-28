// Search in languages written without a space between words: the index keeps a run of Chinese, Japanese or Korean
// characters as one word, so a word inside it is looked for in the text — and English is left to the index alone.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cjkTerms, ftsQuery } from '../src/text.mjs';
import { sandbox } from './helpers.mjs';

test('a Japanese, Chinese or Korean word is found inside the run it was written in, in memory and in what the user typed', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', '日本語のテスト — émoji 🚀 works']);
  s.sumo(['add', 'fact', '한국어를 배우는 중이다']);
  s.sumo(['add', 'fact', '我们用中文写文档']);
  for (const [word, found] of [['テスト', /^m1 .*日本語のテスト/], ['日本語', /^m1 /], ['한국어', /^m2 .*한국어를/], ['中文', /^m3 .*我们用中文写文档/], ['émoji', /^m1 /]]) {
    const run = s.sumo(['search', word]);
    assert.equal(run.code, 0, run.err);
    assert.match(run.out, found, word);
  }
  assert.match(s.sumo(['search', '東京']).out, /^nothing in memory for: 東京/, 'a word that is nowhere is still nothing');
  assert.match(s.sumo(['search', 'テ_ト']).out, /^nothing in memory for/, 'what the user types is matched as typed, never as a pattern');

  s.hook('prompt', { session_id: 'one', prompt: '東京のサーバーはテスト用です' });
  s.hook('prompt', { session_id: 'one', prompt: '大阪のサーバーは本番用です' });
  assert.match(s.sumo(['search', 'サーバー', '--turns']).out, /^t2 .*大阪[\s\S]*^t1 .*東京/m, 'newest first when both hold it');
  assert.match(s.sumo(['search', '東京 サーバー', '--turns']).out, /^t1 .*東京のサーバー[\s\S]*^t2 /m, 'what holds more of the words first');
  assert.match(s.sumo(['search', '名古屋', '--turns']).out, /^the user never said anything like: 名古屋/);
});

test('of memories holding the Japanese words searched for, the one holding more of them ranks first', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', '大阪のサーバーは本番用です']);
  s.sumo(['add', 'fact', '東京のサーバーはテスト用です']);
  s.sumo(['add', 'fact', '東京の天気']);
  const lines = s.sumo(['search', '東京 サーバー']).out.trim().split('\n');
  assert.match(lines[0], /^m2 .*東京のサーバー/);
  assert.equal(lines.length, 3, 'each holding either word is found');
});

test('a search in English is the index\'s alone, as it was: stems still match, a piece of a word never does', () => {
  const s = sandbox();
  s.sumo(['add', 'fact', 'the staging server runs on the mac mini']);
  assert.deepEqual(cjkTerms('staging servers'), []);
  assert.match(s.sumo(['search', 'servers running']).out, /^m1 /, 'other forms of the words, through the stemmer');
  assert.match(s.sumo(['search', 'erver']).out, /^nothing in memory for: erver/, 'never a piece of a word, as a text search would');
  s.hook('prompt', { session_id: 'one', prompt: 'the staging server runs on the mac mini' });
  assert.match(s.sumo(['search', 'erver', '--turns']).out, /^the user never said anything like: erver/);
  // What --turns is handed is the expression, not the words: the words of other scripts read back from it are the same.
  assert.deepEqual(cjkTerms(ftsQuery('東京 "サーバー" and server')), cjkTerms('東京 "サーバー" and server'));
});
