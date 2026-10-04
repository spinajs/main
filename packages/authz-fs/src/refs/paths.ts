import { InvalidArgument } from '@spinajs/exceptions';

const DRIVE = /^([A-Za-z]):/;
const UNC = /^\/\/[^/]/;

interface AbsolutePath {
  // '/', '//' (UNC) or an upper-case drive such as 'C:'
  readonly root: string;
  readonly segments: readonly string[];
}

/**
 * The path a filesystem's ref ids use (design §13, lane D3): '/' separators, no '.' or '..' segments, no
 * leading or trailing '/', '' for the root. An absolute path inside `basePath` becomes relative to it; any
 * other rooted path without a drive (`/x`, `\x`) is relative to the filesystem root, as fsNative.resolvePath
 * reads it. The guard hands this normalised path, not the caller's, to the raw provider, so the path it
 * checks is the path the provider touches, also on providers that use keys verbatim (S3: `/x` and `x`
 * would be two keys).
 *
 * @throws InvalidArgument for a path that climbs above the root, holds a NUL byte, or is a drive or UNC path
 * outside `basePath`
 */
export function normalizeFsPath(path: string, basePath?: string): string {
  if (typeof path !== 'string') {
    throw new InvalidArgument(`fs path must be a string, got ${typeof path}`, 'path');
  }
  if (path.includes('\0')) {
    throw new InvalidArgument(`fs path ${JSON.stringify(path)} contains a NUL byte`, 'path');
  }

  const slashed = path.replace(/\\/g, '/');
  const absolute = parseAbsolute(slashed, path);
  if (!absolute) {
    return walk(slashed.split('/'), path).join('/');
  }

  const base = basePath === undefined ? undefined : parseAbsolute(basePath.replace(/\\/g, '/'), basePath);
  if (base && isInside(absolute, base)) {
    return absolute.segments.slice(base.segments.length).join('/');
  }
  if (absolute.root === '/') {
    return absolute.segments.join('/');
  }

  throw new InvalidArgument(`fs path ${JSON.stringify(path)} is a drive or UNC path outside the filesystem base path`, 'path');
}

function parseAbsolute(slashed: string, original: string): AbsolutePath | undefined {
  const drive = DRIVE.exec(slashed);
  if (drive) {
    return { root: `${drive[1].toUpperCase()}:`, segments: walk(slashed.slice(2).split('/'), original) };
  }
  if (UNC.test(slashed)) {
    return { root: '//', segments: walk(slashed.split('/'), original) };
  }
  if (slashed.startsWith('/')) {
    return { root: '/', segments: walk(slashed.split('/'), original) };
  }
  return undefined;
}

function walk(parts: readonly string[], original: string): string[] {
  const out: string[] = [];
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      if (out.length === 0) {
        throw new InvalidArgument(`fs path ${JSON.stringify(original)} climbs above the filesystem root`, 'path');
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
