import { IOFail } from '@spinajs/exceptions';
import { isAbsolute, posix, relative, resolve, sep, win32 } from 'path';
import { normalizeFsPath } from './paths.js';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;
const S_IFLNK = 0o120000;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
const DRIVE = /^[A-Za-z]:/;

/** The central directory fields of one archive entry that decide where, and whether, it is written. */
export interface ArchiveEntry {
  path: string;
  type: 'Directory' | 'File';
  externalFileAttributes: number;
}

export interface ArchiveEntryTarget {
  target: string;
  isDirectory: boolean;
}

/**
 * Where `entry` is written when an archive is extracted into `destination`.
 *
 * @throws IOFail naming the entry when it is a link or any other non-file entry, has an absolute name, resolves outside
 * `destination`, or has a name the fs path rules refuse
 */
export function archiveEntryTarget(archive: string, destination: string, entry: ArchiveEntry): ArchiveEntryTarget {
  const refuse = (reason: string, inner?: unknown) => new IOFail(`Cannot unzip ${archive}: entry ${JSON.stringify(entry.path)} ${reason}`, inner);

  // the high half holds st_mode for archives made on unix; the low byte is the MS-DOS attribute set
  const attributes = entry.externalFileAttributes >>> 0;
  const kind = (attributes >>> 16) & S_IFMT;
  if (kind === S_IFLNK || attributes & FILE_ATTRIBUTE_REPARSE_POINT) throw refuse('is a symbolic link');
  if (kind !== 0 && kind !== S_IFREG && kind !== S_IFDIR) throw refuse('is not a regular file or directory');

  // backslashes are separators on every platform, so an archive extracts to the same tree everywhere
  const name = entry.path.replace(/\\/g, '/');
  if (posix.isAbsolute(name) || win32.isAbsolute(name) || DRIVE.test(name)) throw refuse('is an absolute path');

  const root = resolve(destination);
  const target = resolve(root, name);
  // win32 relative() compares case-insensitively, as NTFS does
  const rel = relative(root, target);
  const isDirectory = entry.type === 'Directory' || kind === S_IFDIR;
  if (rel.split(sep)[0] === '..' || isAbsolute(rel) || (rel === '' && !isDirectory)) throw refuse('resolves outside the destination');

  try {
    normalizeFsPath(name);
  } catch (err) {
    throw refuse('is not a valid fs path', err);
  }

  return { target, isDirectory };
}
