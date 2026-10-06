// Text that is cut to fit, and text that is looked at for secrets.
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { redact, secretShape } from '../src/redact.mjs';
import { clip } from '../src/text.mjs';
import { cap, runEditor } from '../src/tools.mjs';
import { abridge } from '../src/transcript.mjs';
import { renderWorkflow } from '../src/workflows.mjs';

test('a cut never lands inside a character: an emoji at the edge goes whole, so what is sent stays well-formed', () => {
  const cut = clip(`${'x'.repeat(118)}😀 and then some more text`, 120);
  assert.equal(cut.isWellFormed(), true, JSON.stringify(cut.slice(-3)));
  assert.equal(cut, `${'x'.repeat(118)}…`);
  assert.equal(clip('short', 120), 'short');

  const long = renderWorkflow({ id: 7, title: 'Long', body: `${'y'.repeat(2999)}😀${'z'.repeat(50)}` });
  assert.equal(long.isWellFormed(), true);
  assert.match(long, /y\n… \(the rest: sumo show m7\)/);
});

test('a reply kept by both ends is well-formed, though either cut fell inside an emoji', () => {
  // Odd and even offsets: whichever way the text is aligned, one of the two cuts lands between the halves of an emoji.
  for (const text of ['😀'.repeat(1000), `a${'😀'.repeat(1000)}`]) {
    const kept = abridge(text);
    assert.equal(kept.isWellFormed(), true, JSON.stringify([kept.slice(0, 2), kept.slice(-2)]));
    assert.match(kept, / \[…\] /);
  }
});

test('a secret is counted once, though more than one shape caught it', () => {
  assert.deepEqual(redact('OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456'), { text: 'OPENAI_API_KEY=[redacted]', count: 1 });
  assert.deepEqual(redact('{ "token": "ghp_abcdefghijklmnopqrstuvwxyz0123456789" }'), { text: '{ "token": [redacted] }', count: 1 });
  assert.equal(redact('DB_PASSWORD=hunter2hunter2 and GITHUB_TOKEN=ghp_abcdefghijklmnopqrstuvwxyz0123456789').count, 2);
});

test('the first line of a private key is a key on its own: a scan that reads one line at a time still sees it', () => {
  assert.equal(secretShape('+const pem = `-----BEGIN PRIVATE KEY-----'), 'key');
  assert.equal(secretShape('-----BEGIN OPENSSH PRIVATE KEY-----'), 'key');
  assert.equal(secretShape('-----BEGIN PUBLIC KEY-----'), null);
  assert.equal(secretShape('-----BEGIN CERTIFICATE-----'), null);
});

test('what a tool hands back is well-formed, though the cut in its middle fell inside an emoji', () => {
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-cut-'));
  // The line number and its tab take two characters, so the emoji sits astride the 8,000th: exactly where the middle is cut out.
  const line = `${'x'.repeat(7997)}😀${'x'.repeat(20_000)}`;
  writeFileSync(join(root, 'one-line.txt'), line);
  assert.equal(cap(`1\t${line}`).isWellFormed(), false, 'the cut itself does leave half a character');
  const viewed = runEditor({ command: 'view', path: 'one-line.txt' }, { cwd: root, roots: [root] });
  assert.equal(viewed.isError, false);
  assert.equal(viewed.content.isWellFormed(), true);
});

test('an assignment is a secret whatever its name is prefixed with, and whether or not the name is quoted', () => {
  assert.equal(redact('DB_PASSWORD=hunter2hunter2').text, 'DB_PASSWORD=[redacted]');
  // A key broken up by anything a reader never sees is still the key: an escape, a control character, a zero-width space, a soft hyphen, a direction mark.
  for (const breaker of ['\x1b[0m', '\x01', '\u200b', '\u00ad', '\u202e', '\x1b]0;t\x07', '\ufe0f', '\u3164', '\u034f']) {
    assert.deepEqual(redact(`key sk-ant-api03-abcdefghijk${breaker}lmnopqrstuvwxyz0123456789 ok`), { text: 'key [redacted] ok\n[1 hidden character taken out before redacting]', count: 1 }, JSON.stringify(breaker));
  }
  // With nothing secret, nothing is hidden from the reader: a direction override or an escape is shown, and a stray escape swallows nothing.
  assert.deepEqual(redact('if (isAdmin\u202e) {\x1b]8;;evil'), { text: 'if (isAdmin⟨U+202E⟩) {⟨U+001B⟩]8;;evil', count: 0 });
  assert.equal(redact('ok ❤️ and 👩‍💻').text, 'ok ❤️ and 👩‍💻', 'emoji keep their joiners and selectors');
  assert.equal(redact('line one\r\nline two\ttabbed').text, 'line one\nline two\ttabbed', 'lines and tabs stay');
  assert.equal(redact('export GITHUB_TOKEN: abcdef123456').text, 'export GITHUB_TOKEN: [redacted]');
  assert.equal(redact('{ "password": "hunter2-is-secret", "user": "sumo" }').text, '{ "password": [redacted], "user": "sumo" }');
  assert.equal(secretShape('  client_secret = "0123456789abcdef"'), 'maybe');
  // Words that only contain one of the names are left alone.
  for (const plain of ['max_tokens: 16000', 'MAX_OUTPUT_TOKENS = 16_000', 'the secretary: Johnson and partners', 'tokenize = split_on_spaces']) assert.equal(redact(plain).text, plain);
});

test('code that names a secret is shown as written, so it can be edited; a value that could be the secret itself is still taken out', () => {
  for (const code of ['  token: string;', '  password: string,', 'secret: boolean', '(token: string) => token', 'const authToken = credential.token;', 'const password = getPassword();', '  apiKey: process.env.API_KEY,']) {
    assert.equal(redact(code).text, code, code);
    assert.equal(secretShape(code), null, code);
  }
  for (const [line, shown] of [
    ['"token": "abc123xyz"', '"token": [redacted]'],
    ["password = 'hunter2abc'", 'password = [redacted]'],
    ['API_TOKEN=abc123xyz', 'API_TOKEN=[redacted]'],
    ['PASSWORD=supersecret', 'PASSWORD=[redacted]'],
    ['password: hunter2abc', 'password: [redacted]'],
    ['password: p4ss.w0rd', 'password: [redacted]'],
    ['password: "string"', 'password: [redacted]'],
    ['TOKEN=credential.token', 'TOKEN=[redacted]'],
    ['PASSWORD=string', 'PASSWORD=[redacted]'],
  ]) {
    assert.equal(redact(line).text, shown, line);
    assert.equal(secretShape(line), 'maybe', line);
  }

  // What the editor shows is what an edit has to match.
  const root = mkdtempSync(join(tmpdir(), 'sumo-agents-code-'));
  writeFileSync(join(root, 'a.ts'), 'interface Session {\n  token: string;\n}\n');
  assert.equal(runEditor({ command: 'view', path: 'a.ts' }, { cwd: root, roots: [root] }).content, '1\tinterface Session {\n2\t  token: string;\n3\t}\n4\t');
  assert.equal(runEditor({ command: 'str_replace', path: 'a.ts', old_str: '  token: string;', new_str: '  token: string | null;' }, { cwd: root, roots: [root] }).isError, false);
});

test('a password inside a URL is taken out, and the scheme, user and host stay', () => {
  assert.equal(redact('DATABASE_URL=postgres://app:Hunter2pass@db.internal:5432/app').text, 'DATABASE_URL=postgres://app:[redacted]@db.internal:5432/app');
  assert.equal(redact('clone https://sumo:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y').text, 'clone https://sumo:[redacted]@github.com/x/y');
  assert.equal(redact('clone https://sumo:ghp_abcdefghijklmnopqrstuvwxyz0123456789@github.com/x/y').count, 1);
  assert.equal(secretShape('+DATABASE_URL=postgres://app:Hunter2pass@db/app'), 'maybe');
  for (const plain of ['https://github.com/x/y', 'ssh://git@github.com/x/y', 'http://localhost:8080/a@b', 'see user@example.com']) {
    assert.equal(redact(plain).text, plain, plain);
    assert.equal(secretShape(plain), null, plain);
  }
});
