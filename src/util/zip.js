// Minimal read-only ZIP reader (including ZIP64, which Google Takeout uses for
// big archives). It lists entries from the central directory and streams one
// entry at a time, so a multi-GB export is never loaded into memory.
// Supports "stored" and "deflate" entries, which covers every AI export seen.

import fs from 'node:fs';
import zlib from 'node:zlib';
import { Readable } from 'node:stream';

const EOCD = 0x06054b50;
const ZIP64_LOCATOR = 0x07064b50;
const ZIP64_EOCD = 0x06064b50;
const CENTRAL = 0x02014b50;
const LOCAL = 0x04034b50;

async function readAt(fd, position, length) {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fd.read(buf, 0, length, position);
  return buf.subarray(0, bytesRead);
}

export async function isZip(path) {
  const fd = await fs.promises.open(path, 'r');
  try {
    const head = await readAt(fd, 0, 4);
    return head.length === 4 && head.readUInt32LE(0) === LOCAL;
  } finally {
    await fd.close();
  }
}

export async function listZip(path) {
  const fd = await fs.promises.open(path, 'r');
  try {
    const { size } = await fd.stat();
    const tailLen = Math.min(size, 65557);
    const tail = await readAt(fd, size - tailLen, tailLen);
    let pos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === EOCD) { pos = i; break; }
    }
    if (pos < 0) throw new Error('Not a zip file (no end-of-central-directory record)');

    let count = tail.readUInt16LE(pos + 10);
    let cdSize = tail.readUInt32LE(pos + 12);
    let cdOffset = tail.readUInt32LE(pos + 16);

    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) {
      const loc = pos - 20;
      if (loc >= 0 && tail.readUInt32LE(loc) === ZIP64_LOCATOR) {
        const z64Offset = Number(tail.readBigUInt64LE(loc + 8));
        const rec = await readAt(fd, z64Offset, 56);
        if (rec.readUInt32LE(0) !== ZIP64_EOCD) throw new Error('Bad ZIP64 record');
        count = Number(rec.readBigUInt64LE(32));
        cdSize = Number(rec.readBigUInt64LE(40));
        cdOffset = Number(rec.readBigUInt64LE(48));
      }
    }

    const cd = await readAt(fd, cdOffset, cdSize);
    const entries = [];
    let p = 0;
    for (let n = 0; n < count && p + 46 <= cd.length; n++) {
      if (cd.readUInt32LE(p) !== CENTRAL) break;
      const method = cd.readUInt16LE(p + 10);
      let compSize = cd.readUInt32LE(p + 20);
      let uncompSize = cd.readUInt32LE(p + 24);
      const nameLen = cd.readUInt16LE(p + 28);
      const extraLen = cd.readUInt16LE(p + 30);
      const commentLen = cd.readUInt16LE(p + 32);
      let localOffset = cd.readUInt32LE(p + 42);
      const name = cd.toString('utf8', p + 46, p + 46 + nameLen);

      // ZIP64 extended info: only the fields that overflowed are present, in order.
      let e = p + 46 + nameLen;
      const extraEnd = e + extraLen;
      while (e + 4 <= extraEnd) {
        const id = cd.readUInt16LE(e);
        const len = cd.readUInt16LE(e + 2);
        if (id === 0x0001) {
          let q = e + 4;
          if (uncompSize === 0xffffffff) { uncompSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (compSize === 0xffffffff) { compSize = Number(cd.readBigUInt64LE(q)); q += 8; }
          if (localOffset === 0xffffffff) { localOffset = Number(cd.readBigUInt64LE(q)); q += 8; }
        }
        e += 4 + len;
      }

      if (!name.endsWith('/')) entries.push({ name, method, compSize, size: uncompSize, localOffset });
      p += 46 + nameLen + extraLen + commentLen;
    }
    return entries;
  } finally {
    await fd.close();
  }
}

export async function openZipEntry(path, entry) {
  const fd = await fs.promises.open(path, 'r');
  let header;
  try {
    header = await readAt(fd, entry.localOffset, 30);
  } finally {
    await fd.close();
  }
  if (header.readUInt32LE(0) !== LOCAL) throw new Error(`Bad local header for ${entry.name}`);
  const dataStart = entry.localOffset + 30 + header.readUInt16LE(26) + header.readUInt16LE(28);
  if (entry.compSize === 0) return Readable.from([]);
  const raw = fs.createReadStream(path, { start: dataStart, end: dataStart + entry.compSize - 1 });
  if (entry.method === 0) return raw;
  if (entry.method === 8) return raw.pipe(zlib.createInflateRaw());
  raw.destroy();
  throw new Error(`Unsupported zip compression method ${entry.method} for ${entry.name}`);
}
