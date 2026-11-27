import { crc32 } from 'node:zlib';

// Hand-built archives: zip tools refuse to write the names and link entries these tests need.

export const S_IFREG = 0o100000;
export const S_IFDIR = 0o040000;
export const S_IFLNK = 0o120000;

export interface ZipEntry {
  name: string;
  data?: string | Buffer;
  /** unix mode with its file type bits, stored in the high half of the external attributes */
  mode?: number;
}

interface Header {
  name: Buffer;
  crc: number;
  size: number;
  mode: number;
  offset: number;
}

function localHeader(h: Header): Buffer {
  const b = Buffer.alloc(30);
  b.writeUInt32LE(0x04034b50, 0);
  b.writeUInt16LE(10, 4);
  b.writeUInt16LE(0x0800, 6);
  b.writeUInt16LE(0, 8);
  b.writeUInt16LE(0x0021, 12);
  b.writeUInt32LE(h.crc, 14);
  b.writeUInt32LE(h.size, 18);
  b.writeUInt32LE(h.size, 22);
  b.writeUInt16LE(h.name.length, 26);
  return Buffer.concat([b, h.name]);
}

function centralHeader(h: Header): Buffer {
  const b = Buffer.alloc(46);
  b.writeUInt32LE(0x02014b50, 0);
  // made by unix (3), so readers take the high half of the external attributes as st_mode
  b.writeUInt16LE((3 << 8) | 20, 4);
  b.writeUInt16LE(10, 6);
  b.writeUInt16LE(0x0800, 8);
  b.writeUInt16LE(0, 10);
  b.writeUInt16LE(0x0021, 14);
  b.writeUInt32LE(h.crc, 16);
  b.writeUInt32LE(h.size, 20);
  b.writeUInt32LE(h.size, 24);
  b.writeUInt16LE(h.name.length, 28);
  const dosDir = (h.mode & 0o170000) === S_IFDIR ? 0x10 : 0;
  b.writeUInt32LE(((h.mode << 16) | dosDir) >>> 0, 38);
  b.writeUInt32LE(h.offset, 42);
  return Buffer.concat([b, h.name]);
}

function endOfCentralDirectory(count: number, size: number, offset: number): Buffer {
  const b = Buffer.alloc(22);
  b.writeUInt32LE(0x06054b50, 0);
  b.writeUInt16LE(count, 8);
  b.writeUInt16LE(count, 10);
  b.writeUInt32LE(size, 12);
  b.writeUInt32LE(offset, 16);
  return b;
}

/** A stored (uncompressed) archive holding the entries in order. */
export function zipArchive(entries: ZipEntry[]): Buffer {
  const parts: Buffer[] = [];
  const headers: Header[] = [];
  let offset = 0;

  for (const entry of entries) {
    const data = Buffer.from(entry.data ?? '');
    const isDir = entry.name.endsWith('/');
    const h: Header = { name: Buffer.from(entry.name, 'utf8'), crc: crc32(data), size: data.length, mode: entry.mode ?? (isDir ? S_IFDIR | 0o755 : S_IFREG | 0o644), offset };
    const local = localHeader(h);
    parts.push(local, data);
    headers.push(h);
    offset += local.length + data.length;
  }

  const central = Buffer.concat(headers.map(centralHeader));
  return Buffer.concat([...parts, central, endOfCentralDirectory(headers.length, central.length, offset)]);
}

/** An archive with one stored entry of `chunk` repeated `times`, yielded in parts so the entry is never held in memory. */
export function* largeZip(name: string, chunk: Buffer, times: number): Generator<Buffer> {
  let crc = 0;
  for (let i = 0; i < times; i++) crc = crc32(chunk, crc);
  const h: Header = { name: Buffer.from(name, 'utf8'), crc, size: chunk.length * times, mode: S_IFREG | 0o644, offset: 0 };

  const local = localHeader(h);
  yield local;
  for (let i = 0; i < times; i++) yield chunk;
  const central = centralHeader(h);
  yield central;
  yield endOfCentralDirectory(1, central.length, local.length + h.size);
}
