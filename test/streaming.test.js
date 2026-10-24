import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { streamJsonArray } from '../src/util/json-stream.js';
import { listZip, openZipEntry } from '../src/util/zip.js';
import { collect, tmpDir, writeZip } from './helpers.js';

const DOC = JSON.stringify([
  { a: 1, s: 'brace } and [bracket] and "quote" and \\ backslash' },
  { nested: { deep: [1, 2, { x: 'é 日本' }] } },
  [],
  { emoji: '🙂' },
]);

test('streamJsonArray yields every element regardless of chunk boundaries', async () => {
  const expected = JSON.parse(DOC);
  const bytes = Buffer.from(DOC);
  for (const size of [1, 2, 3, 7, 64, bytes.length]) {
    const chunks = [];
    for (let i = 0; i < bytes.length; i += size) chunks.push(bytes.subarray(i, i + size));
    const got = await collect(streamJsonArray(Readable.from(chunks)));
    assert.deepEqual(got, expected, `chunk size ${size}`);
  }
});

test('streamJsonArray unwraps an object holding an array', async () => {
  const got = await collect(streamJsonArray(Readable.from([Buffer.from('{"conversations":[{"a":1},{"a":2}]}')])));
  assert.deepEqual(got, [{ a: 1 }, { a: 2 }]);
});

test('streamJsonArray handles a large file without loading it whole', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'big.json');
  const out = fs.createWriteStream(file);
  const N = 20000;
  out.write('[');
  for (let i = 0; i < N; i++) out.write((i ? ',' : '') + JSON.stringify({ i, text: 'x'.repeat(200) }));
  out.write(']');
  await new Promise((r) => out.end(r));
  let count = 0;
  for await (const item of streamJsonArray(fs.createReadStream(file, { highWaterMark: 4096 }))) {
    assert.equal(item.i, count);
    count++;
  }
  assert.equal(count, N);
});

test('zip reader lists and inflates entries', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'export.zip');
  writeZip(file, { 'conversations.json': '[{"a":1}]', 'folder/chat.html': '<html></html>' });
  const entries = await listZip(file);
  assert.deepEqual(entries.map((e) => e.name), ['conversations.json', 'folder/chat.html']);
  const got = await collect(streamJsonArray(await openZipEntry(file, entries[0])));
  assert.deepEqual(got, [{ a: 1 }]);
});
