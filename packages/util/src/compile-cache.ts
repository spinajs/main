import { lstatSync, mkdirSync, realpathSync, type Stats } from 'node:fs';
import nodeModule from 'node:module';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';

// enableCompileCache came in Node 22.1 and flushCompileCache in 22.10; the engines range starts at 22.0, and packages
// build against @types/node versions that know neither.
const nodeEnable = Reflect.get(nodeModule, 'enableCompileCache') as ((dir?: string) => unknown) | undefined;
const nodeFlush = Reflect.get(nodeModule, 'flushCompileCache') as (() => void) | undefined;

export interface CompileCacheHost {
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  homedir: string;
  /** The uid the cache dirs must belong to; `undefined` where the platform has none. */
  uid: number | undefined;
}

const currentHost = (): CompileCacheHost => ({ env: process.env, platform: process.platform, homedir: homedir(), uid: process.getuid?.() });

/**
 * The per-user dir the compile cache goes to, created when missing: `%LOCALAPPDATA%\spinajs\compile-cache` on Windows,
 * `$XDG_CACHE_HOME/spinajs/compile-cache` else `~/.cache/spinajs/compile-cache` elsewhere. On POSIX it is the real path,
 * with every link above the cache root resolved. `undefined` leaves the cache off: with `NODE_DISABLE_COMPILE_CACHE` set,
 * with `NODE_COMPILE_CACHE` set (Node has then turned it on in that dir at start-up), or on POSIX when
 * - a dir from the cache root down is a link, or not a dir of this uid, or writable by its group or others, or
 * - a dir above the cache root, up to `/`, does not belong to root or this uid, or is writable by its group or others.
 *   The sticky bit is no exception, so nothing below `/tmp` or `/var/tmp` is accepted.
 */
export function compileCacheDir(host: CompileCacheHost = currentHost()): string | undefined {
  const { env } = host;
  if (env.NODE_DISABLE_COMPILE_CACHE || env.NODE_COMPILE_CACHE) return undefined;

  if (host.platform === 'win32') {
    const dir = join(absolute(env.LOCALAPPDATA) ?? join(host.homedir, 'AppData', 'Local'), 'spinajs', 'compile-cache');
    mkdirSync(dir, { recursive: true });
    return dir;
  }

  // Node trusts every entry it finds, checked only against the source's length and hash, so a dir another user can
  // write to lets that user supply the bytecode of any module this process loads.
  if (host.uid === undefined) return undefined;
  return trustedCacheDir(resolve(absolute(env.XDG_CACHE_HOME) ?? join(host.homedir, '.cache')), host.uid);
}

/**
 * Turns on Node's compile cache in {@link compileCacheDir} for every module loaded after this call, so a launcher calls
 * it and then imports the app. Leaves it off without a word when the dir is refused or cannot be created, or on Node
 * 22.0. Node writes the cache at exit; a server that never exits calls {@link flushCompileCache} once it listens.
 */
export function enableCompileCache(host?: CompileCacheHost): void {
  try {
    const dir = compileCacheDir(host);
    if (dir !== undefined) nodeEnable?.(dir);
  } catch {
    // a cache that cannot be set up is no reason to fail the start
  }
}

/** Writes what the compile cache holds so far; a no-op when it is off or before Node 22.10. */
export function flushCompileCache(): void {
  nodeFlush?.();
}

function absolute(path: string | undefined): string | undefined {
  // the XDG spec makes a relative path invalid, so it is ignored
  return path && isAbsolute(path) ? path : undefined;
}

/**
 * Node opens the cache dir by path for every module it compiles, so anyone who can rename or replace a dir of that path
 * while the process runs can hand it their own entries: the owner of the dir above, or anyone who can write to it
 * (OpenSSH's `StrictModes` walk). The walk runs on the real path, which is also what Node gets, so swapping a link on
 * the way afterwards changes nothing. The sticky bit is no exception: the cleaners of a shared dir such as `/tmp` delete
 * aged entries while the process runs, and anyone can then create the same path again.
 */
function trustedCacheDir(root: string, uid: number): string | undefined {
  try {
    const above = realpathSync(dirname(root));
    if (!trustedAncestors(above, uid)) return undefined;
    const realRoot = join(above, basename(root));
    const chain = [realRoot, join(realRoot, 'spinajs'), join(realRoot, 'spinajs', 'compile-cache')];
    for (const dir of chain) {
      createPrivate(dir);
      if (!ownedPrivateDir(lstatSync(dir), uid)) return undefined;
    }
    const dir = chain[chain.length - 1];
    // everything above was checked before the chain was created; check it again now that the dirs Node will open exist
    const unchanged = realpathSync(dir) === dir && trustedAncestors(above, uid) && chain.every((d) => ownedPrivateDir(lstatSync(d), uid));
    return unchanged ? dir : undefined;
  } catch {
    return undefined;
  }
}

function trustedAncestors(dir: string, uid: number): boolean {
  for (let current = dir; ; current = dirname(current)) {
    const stat = lstatSync(current);
    if (!stat.isDirectory() || (stat.uid !== 0 && stat.uid !== uid) || (stat.mode & 0o022) !== 0) return false;
    if (dirname(current) === current) return true;
  }
}

function createPrivate(dir: string): void {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
}

const ownedPrivateDir = (stat: Stats, uid: number) => stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
