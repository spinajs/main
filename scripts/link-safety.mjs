// Helpers for touching node_modules without following links. On Windows a recursive delete
// follows junctions and wipes the checkout behind them, so nothing here ever recurses into a link.
import fs from 'node:fs';
import path from 'node:path';

const canonical = (p) => (process.platform === 'win32' ? p.toLowerCase() : p);

/**
 * True for symlinks and junctions. Node reports only some Windows reparse points as symbolic links,
 * so a directory whose real path is not where it sits counts too, and so does one that cannot be resolved.
 */
export function isLink(entry) {
  const stat = fs.lstatSync(entry, { throwIfNoEntry: false });
  if (!stat) return false;
  if (stat.isSymbolicLink()) return true;
  if (!stat.isDirectory()) return false;
  try {
    const expected = path.join(fs.realpathSync.native(path.dirname(entry)), path.basename(entry));
    return canonical(fs.realpathSync.native(entry)) !== canonical(expected);
  } catch {
    return true;
  }
}

/** Removes the link itself, never what it points at. */
export function removeLink(entry) {
  try {
    fs.unlinkSync(entry);
  } catch (err) {
    if (err.code !== 'EPERM' && err.code !== 'EISDIR') throw err;
    // Non-recursive: removes a directory reparse point that unlink refuses, and throws on a real non-empty directory.
    fs.rmdirSync(entry);
  }
}

/** Unlinks every link directly inside a scope directory and lists the real directories it left alone. */
export function unlinkScope(scopeDir) {
  const result = { unlinked: [], real: [] };
  if (!fs.lstatSync(scopeDir, { throwIfNoEntry: false })) return result;
  if (isLink(scopeDir)) {
    removeLink(scopeDir);
    result.unlinked.push('.');
    return result;
  }
  for (const name of fs.readdirSync(scopeDir)) {
    const entry = path.join(scopeDir, name);
    if (isLink(entry)) {
      removeLink(entry);
      result.unlinked.push(name);
    } else {
      result.real.push(name);
    }
  }
  if (result.real.length === 0) fs.rmdirSync(scopeDir);
  return result;
}

/** `--root <dir>` overrides the repository root, so the scripts can be exercised on a scratch tree. */
export function rootFromArgs(defaultRoot) {
  const at = process.argv.indexOf('--root');
  if (at === -1) return defaultRoot;
  if (!process.argv[at + 1]) throw new Error('--root needs a directory');
  return path.resolve(process.argv[at + 1]);
}
