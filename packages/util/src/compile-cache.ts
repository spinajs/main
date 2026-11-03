import { lstatSync, mkdirSync } from 'node:fs';
import nodeModule from 'node:module';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';

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
 * `$XDG_CACHE_HOME/spinajs/compile-cache` else `~/.cache/spinajs/compile-cache` elsewhere. `undefined` leaves the cache
 * off: with `NODE_DISABLE_COMPILE_CACHE` set, with `NODE_COMPILE_CACHE` set (Node has then turned it on in that dir at
 * start-up), or when a dir of the chain from the cache root down is not a directory of this uid that only it can write.
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
  const root = absolute(env.XDG_CACHE_HOME) ?? join(host.homedir, '.cache');
  const chain = [root, join(root, 'spinajs'), join(root, 'spinajs', 'compile-cache')];
  for (const dir of chain) {
    if (!ownedDir(dir, host.uid)) return undefined;
  }
  return chain[chain.length - 1];
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

function ownedDir(dir: string, uid: number): boolean {
  try {
    mkdirSync(dir, { mode: 0o700 });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') return false;
  }
  const stat = lstatSync(dir);
  return stat.isDirectory() && stat.uid === uid && (stat.mode & 0o022) === 0;
}
