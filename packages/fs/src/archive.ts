import { IOFail } from '@spinajs/exceptions';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'path';
import { normalizeFsPath } from './paths.js';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const FLAG_ENCRYPTED = 0x1;
const STORED = 0;
const DEFLATED = 8;
const DRIVE = /^[A-Za-z]:/;
const END_RECORD = Buffer.from([0x50, 0x4b, 0x05, 0x06]);
const END_RECORD_SIZE = 22;
const ZIP64_LOCATOR = 0x07064b50;

/** The central directory fields of one archive entry that decide where, and whether, it is written. */
export interface ArchiveEntry {
  path: string;
  type: 'Directory' | 'File';
  externalFileAttributes: number;
  flags: number;
  compressionMethod: number;
}

/** Whether `path` is `root` or lies below it; win32 relative() compares case-insensitively, as NTFS does. */
export function isWithin(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel.split(sep)[0] !== '..' && !isAbsolute(rel);
}

/**
 * The offset in `tail`, the last bytes of a zip file starting at `tailStart` in it, of the archive's end of central
 * directory record, or -1. It searches backwards, as zip readers do, for the last record that fits in the file and
 * whose central directory ends where the record starts (a zip64 one: that a zip64 locator precedes). A signature inside
 * the comment does not pass that test. Without such a record it takes the last one that fits.
 */
export function findEndRecord(tail: Buffer, tailStart: number): number {
  let fallback = -1;
  for (let i = tail.lastIndexOf(END_RECORD); i >= 0; i = i === 0 ? -1 : tail.lastIndexOf(END_RECORD, i - 1)) {
    if (i + END_RECORD_SIZE > tail.length || i + END_RECORD_SIZE + tail.readUInt16LE(i + 20) > tail.length) continue;
    if (fallback === -1) fallback = i;
    const size = tail.readUInt32LE(i + 12);
    const offset = tail.readUInt32LE(i + 16);
    const zip64 = offset === 0xffffffff || size === 0xffffffff || tail.readUInt16LE(i + 10) === 0xffff;
    if (zip64 ? i >= 20 && tail.readUInt32LE(i - 20) === ZIP64_LOCATOR : offset + size === tailStart + i) return i;
  }
  return fallback;
}

export interface ArchiveEntryTarget {
  target: string;
  isDirectory: boolean;
}

function unsupportedKind(entry: ArchiveEntry, kind: number): string | undefined {
  // the low byte of the external attributes is the MS-DOS attribute set
  if (kind === S_IFLNK || entry.externalFileAttributes & FILE_ATTRIBUTE_REPARSE_POINT) return 'is a symbolic link';
  if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) return 'is not a regular file or directory';
  if (entry.flags & FLAG_ENCRYPTED) return 'is encrypted';
  if (entry.compressionMethod !== STORED && entry.compressionMethod !== DEFLATED) return `uses compression method ${entry.compressionMethod}, which is not supported`;
  return undefined;
}

/**
 * Where `entry` is written when an archive is extracted into `destination`.
 *
 * @throws IOFail naming the entry when it is a link or any other non-file entry, has an absolute name, resolves outside
 * `destination`, or has a name the fs path rules refuse
 */
export function archiveEntryTarget(archive: string, destination: string, entry: ArchiveEntry): ArchiveEntryTarget {
  const refuse = (reason: string, inner?: unknown) => new IOFail(`Cannot unzip ${archive}: entry ${JSON.stringify(entry.path)} ${reason}`, inner);

  // the high half holds st_mode for archives made on unix
  const kind = ((entry.externalFileAttributes >>> 0) >>> 16) & S_IFMT;
  const unsupported = unsupportedKind(entry, kind);
  if (unsupported !== undefined) throw refuse(unsupported);

  // backslashes are separators on every platform, so an archive extracts to the same tree everywhere
  const name = entry.path.replace(/\\/g, '/');
  if (posix.isAbsolute(name) || win32.isAbsolute(name) || DRIVE.test(name)) throw refuse('is an absolute path');

  const root = resolve(destination);
  const target = resolve(root, name);
  const isDirectory = entry.type === 'Directory' || kind === S_IFDIR;
  if (!isWithin(root, target) || (target === root && !isDirectory)) throw refuse('resolves outside the destination');

  try {
    normalizeFsPath(name);
  } catch (err) {
    throw refuse('is not a valid fs path', err);
  }

  return { target, isDirectory };
}
