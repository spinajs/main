import { InvalidArgument } from '@spinajs/exceptions';

const DRIVE = /^([A-Za-z]):/;
const UNC = /^\/\/[^/]/;
// ':' marks a drive or an NTFS stream (x::$DATA); Win32 drops a trailing dot or space, so 'a.' and 'a ' alias 'a'.
const ALIAS_SEGMENT = /:|[. ]$/;

interface AbsolutePath {
  // '/', '//' (UNC) or an upper-case drive such as 'C:'
  readonly root: string;
  readonly segments: readonly string[];
}

/**
 * The path a filesystem's ref ids use (design §13): '/' separators, no '.' or '..' segments, no leading or
 * trailing '/', '' for the root. An absolute path inside `basePath` becomes relative to it; any other rooted
 * path without a drive (`/x`, `\x`) is relative to the filesystem root, as fsNative.resolvePath reads it. A
 * driveless rooted path is never inside a drive or UNC base path: on Windows `\data\up\x` with the base
 * `C:\data\up` gives `data/up/x`, while fsNative would read the base itself on the current drive.
 *
 * The guard hands this normalised path, not the caller's, to the raw provider, so the path it checks is the
 * path the provider touches, also on providers that use keys verbatim (S3: `/x` and `x` would be two keys).
 *
 * @throws InvalidArgument for a path that climbs above the root, holds a NUL byte, is a drive or UNC path
 * outside `basePath`, or has a segment holding ':' or ending in '.' or a space
 */
export function normalizeFsPath(path: string, basePath?: string): string {
  if (typeof path !== 'string') {
    throw new InvalidArgument(`fs path must be a string, got ${typeof path}`, 'path');
  }
  if (basePath !== undefined && typeof basePath !== 'string') {
    throw new InvalidArgument(`fs base path must be a string, got ${typeof basePath}`, 'basePath');
  }
  if (path.includes('\0')) {
    throw new InvalidArgument(`fs path ${JSON.stringify(path)} contains a NUL byte`, 'path');
  }

  const slashed = path.replace(/\\/g, '/');
  const absolute = parseAbsolute(slashed, `fs path ${JSON.stringify(path)}`);
  if (!absolute) {
    return canonical(walk(slashed.split('/'), `fs path ${JSON.stringify(path)}`), path);
  }

  const base = basePath === undefined ? undefined : parseAbsolute(basePath.replace(/\\/g, '/'), `fs base path ${JSON.stringify(basePath)}`);
  if (base && isInside(absolute, base)) {
    return canonical(absolute.segments.slice(base.segments.length), path);
  }
  if (absolute.root === '/') {
    return canonical(absolute.segments, path);
  }

  throw new InvalidArgument(`fs path ${JSON.stringify(path)} is a drive or UNC path outside the filesystem base path`, 'path');
}

// Every result passes here, so a drive that surfaces only after '.' and '..' are gone (./C:/x) is refused too.
function canonical(segments: readonly string[], original: string): string {
  const alias = segments.find((s) => ALIAS_SEGMENT.test(s));
  if (alias !== undefined) {
    throw new InvalidArgument(`fs path ${JSON.stringify(original)} has the segment ${JSON.stringify(alias)}, which holds ':' or ends in '.' or a space`, 'path');
  }
  return segments.join('/');
}

function parseAbsolute(slashed: string, label: string): AbsolutePath | undefined {
  const drive = DRIVE.exec(slashed);
  if (drive) {
    return { root: `${drive[1].toUpperCase()}:`, segments: walk(slashed.slice(2).split('/'), label) };
  }
  if (UNC.test(slashed)) {
    return { root: '//', segments: walk(slashed.split('/'), label) };
  }
  if (slashed.startsWith('/')) {
    return { root: '/', segments: walk(slashed.split('/'), label) };
  }
  return undefined;
}

function walk(parts: readonly string[], label: string): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new InvalidArgument(`${label} climbs above the filesystem root`, 'path');
      }
      out.pop();
      continue;
    }
    out.push(part);
  }
  return out;
}

// Drive and UNC paths follow win32 rules (case-insensitive, as path.win32.relative in fsNative); posix paths compare exactly.
function isInside(path: AbsolutePath, base: AbsolutePath): boolean {
  if (path.root !== base.root || path.segments.length < base.segments.length) {
    return false;
  }
  const fold = base.root === '/' ? (s: string) => s : (s: string) => s.toLowerCase();
  return base.segments.every((segment, i) => fold(segment) === fold(path.segments[i]));
}
