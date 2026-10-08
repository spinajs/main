import { InvalidArgument } from '@spinajs/exceptions';

import { FileMetadataStore, checkFileMeta, normalizeFsPath } from '../../src/index.js';
import type { FileMeta } from '../../src/index.js';

const key = (fs: string, path: string): string => `${fs}:${path}`;
const under = (path: string, root: string): boolean => path === root || path.startsWith(`${root}/`);

/** FileMetadataStore over a Map with the ORM store's semantics (`deleteTree` and `move` take a path and everything under it); records each call. */
export class MemoryFileMetadataStore extends FileMetadataStore {
  readonly rows = new Map<string, FileMeta>();
  readonly calls: string[] = [];
  /** Methods that throw, to test failures after the IO. */
  readonly failing = new Set<'get' | 'set' | 'move' | 'delete' | 'deleteTree'>();

  async get(fsName: string, path: string): Promise<FileMeta | null> {
    this.record('get', fsName, path);
    const p = normalizeFsPath(path);
    return p === '' ? null : (this.rows.get(key(fsName, p)) ?? null);
  }

  async set(fsName: string, path: string, meta: FileMeta): Promise<void> {
    this.record('set', fsName, path);
    const p = normalizeFsPath(path);
    if (p === '') throw new InvalidArgument('the filesystem root has no metadata', 'path');
    this.rows.set(key(fsName, p), checkFileMeta(meta));
  }

  async move(fromFs: string, from: string, toFs: string, to: string): Promise<void> {
    this.record('move', fromFs, from, toFs, to);
    const src = normalizeFsPath(from);
    const dst = normalizeFsPath(to);
    if (fromFs === toFs && src === dst) return;
    this.rows.delete(key(toFs, dst));
    for (const [k, meta] of [...this.rows]) {
      const at = k.indexOf(':');
      const path = k.slice(at + 1);
      if (k.slice(0, at) !== fromFs || !under(path, src)) continue;
      this.rows.delete(k);
      this.rows.set(key(toFs, dst + path.slice(src.length)), meta);
    }
  }

  async delete(fsName: string, path: string): Promise<void> {
    this.record('delete', fsName, path);
    this.rows.delete(key(fsName, normalizeFsPath(path)));
  }

  async deleteTree(fsName: string, path: string): Promise<void> {
    this.record('deleteTree', fsName, path);
    const p = normalizeFsPath(path);
    for (const k of [...this.rows.keys()]) {
      const at = k.indexOf(':');
      if (k.slice(0, at) === fsName && (p === '' || under(k.slice(at + 1), p))) this.rows.delete(k);
    }
  }

  owner(fsName: string, path: string): string | undefined {
    const owner = this.rows.get(key(fsName, path))?.owner;
    return owner ? `${owner.type}:${owner.id}` : undefined;
  }

  private record(method: 'get' | 'set' | 'move' | 'delete' | 'deleteTree', ...args: string[]): void {
    this.calls.push(`${method} ${args.join(' ')}`);
    if (this.failing.has(method)) throw new Error(`${method} failed`);
  }
}
