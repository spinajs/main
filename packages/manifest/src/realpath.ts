import { existsSync, lstatSync, realpathSync, type Stats } from 'node:fs';
import { basename, dirname, join } from 'node:path';

/** `realpathSync(dir)`, taken once per `realDirs`. */
export function realDirectory(dir: string, realDirs: Map<string, string>): string {
  let real = realDirs.get(dir);
  if (real === undefined) {
    real = realpathSync(dir);
    realDirs.set(dir, real);
  }
  return real;
}

const lstatOf = (path: string): Stats | undefined => {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
};

// A path that is not a link itself is its real parent plus its name, so one `lstat` replaces the `lstat` per path
// component that `realpathSync` does on Windows; a link is resolved in full.
const realpathBy = (path: string, stats: Stats, realDirs: Map<string, string>): string =>
  stats.isSymbolicLink() ? realpathSync(path) : join(realDirectory(dirname(path), realDirs), basename(path));

/** `realpathSync(path)`, same result and same errors, with the real directories taken from `realDirs`. */
export function realpathOf(path: string, realDirs: Map<string, string>): string {
  const stats = lstatOf(path);
  return stats ? realpathBy(path, stats, realDirs) : realpathSync(path);
}

/** `existsSync(path) ? realpathSync(path) : undefined`, with the real directories taken from `realDirs`. */
export function existingRealpathOf(path: string, realDirs: Map<string, string>): string | undefined {
  const stats = lstatOf(path);
  if (!stats || (stats.isSymbolicLink() && !existsSync(path))) return undefined;
  return realpathBy(path, stats, realDirs);
}
