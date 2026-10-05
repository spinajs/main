import type { EventEmitter } from 'node:events';

import type { PrincipalRef } from '@spinajs/authz';
import type { fs } from '@spinajs/fs';

import type { FileMeta, FileMetadataStore } from '../api.js';
import { sameFileMeta } from '../metadata/meta.js';

/** A filesystem side of an operation, as the metadata step sees it. */
export interface MetadataTarget {
  readonly name: string;
  readonly raw: fs;
  readonly stampOwner: boolean;
  metadata(): Promise<FileMetadataStore | undefined>;
}

/** A checked path argument: its filesystem, normalised path and the owner to stamp (none unless a definite allow for a principal that may own). */
export interface MetadataPath {
  readonly target: MetadataTarget;
  readonly path: string;
  readonly owner?: PrincipalRef;
}

export interface MetadataOptions {
  /** A metadata update that failed after the IO. */
  readonly error: (message: string) => void;
  readonly warn: (message: string) => void;
  /** How long a stream's 'close' waits for the store. */
  readonly timeoutMs: number;
}

/**
 * First-writer ownership (design §13 owner relation): a path that existed keeps its metadata; a path the operation
 * creates starts empty, with the owner when stamping. `probe` tells which.
 */
interface Stamp {
  readonly kind: 'stamp';
  readonly arg: number;
  readonly probe: 'exists' | 'dirExists';
  readonly stream?: true;
}

type Effect = Stamp | { readonly kind: 'delete'; readonly arg: number } | { readonly kind: 'move'; readonly from: number; readonly to: number };

const EFFECTS: Readonly<Record<string, Effect>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Effect>, {
    write: { kind: 'stamp', arg: 0, probe: 'exists' },
    writeStream: { kind: 'stamp', arg: 0, probe: 'exists', stream: true },
    append: { kind: 'stamp', arg: 0, probe: 'exists' },
    // S3 has no directories: dirExists is always true there, so a directory key is never stamped.
    mkdir: { kind: 'stamp', arg: 0, probe: 'dirExists' },
    upload: { kind: 'stamp', arg: 1, probe: 'exists' },
    copy: { kind: 'stamp', arg: 1, probe: 'exists' },
    zip: { kind: 'stamp', arg: 2, probe: 'exists' },
    unzip: { kind: 'stamp', arg: 1, probe: 'dirExists' },
    rm: { kind: 'delete', arg: 0 },
    move: { kind: 'move', from: 0, to: 1 },
    rename: { kind: 'move', from: 0, to: 1 },
  }),
);

export type AfterIo = (result: unknown) => Promise<unknown>;

/** The size and shape checks a store can make without IO (OrmFileMetadataStore, S3ObjectMetadataStore). */
type CheckedStore = FileMetadataStore & { checkMeta?(fsName: string, path: string, meta: FileMeta): void };

const checkMeta = (store: FileMetadataStore, p: MetadataPath, meta: FileMeta): void => (store as CheckedStore).checkMeta?.(p.target.name, p.path, meta);

const probe = async (p: MetadataPath, method: 'exists' | 'dirExists' | 'isDir'): Promise<boolean> => (await Reflect.apply(p.target.raw[method] as (path: string) => Promise<boolean>, p.target.raw, [p.path])) === true;

/**
 * Runs before the IO (stores resolved, the path probed, metadata read and checked, so a misconfigured store or a value
 * it cannot hold fails before anything is written) and returns what to do after a successful IO; undefined when the
 * method keeps no metadata. A failure after the IO is reported and rethrown: a lost owner row would deny the owner
 * later, so it must not pass silently.
 */
export async function planMetadata(method: string, at: (arg: number) => MetadataPath | undefined, opts: MetadataOptions): Promise<AfterIo | undefined> {
  const effect = EFFECTS[method];
  if (!effect) return undefined;
  const failed = (where: readonly MetadataPath[], e: unknown): Error => {
    opts.error(`${method} on ${where.map((p) => `${p.target.name}:${p.path}`).join(' → ')} succeeded, but the metadata was not updated: ${e instanceof Error ? e.message : String(e)}`);
    return e as Error;
  };
  const after =
    (where: readonly MetadataPath[], task: () => Promise<void>): AfterIo =>
    async (result) => {
      try {
        await task();
      } catch (e) {
        throw failed(where, e);
      }
      return result;
    };

  if (effect.kind === 'delete') {
    const p = at(effect.arg);
    const store = p && (await p.target.metadata());
    if (!p || !store) return undefined;
    // A key store has no directories: removing a key must not take the rows of other keys under that prefix.
    const directory = await probe(p, 'isDir');
    return after([p], () => (directory ? deleteTree(store, p) : store.delete(p.target.name, p.path)));
  }

  if (effect.kind === 'move') return planMove(at(effect.from), at(effect.to), after, opts);

  const p = at(effect.arg);
  const store = p && (await p.target.metadata());
  if (!p || !store) return undefined;
  let task: (() => Promise<void>) | undefined;
  if (await probe(p, effect.probe)) {
    // Written back: S3 write, upload and append replace an object's metadata.
    const before = await store.get(p.target.name, p.path);
    task = () => put(store, p, before);
  } else {
    const next: FileMeta | null = p.target.stampOwner && p.owner ? { owner: p.owner } : null;
    if (next) checkMeta(store, p, next);
    // A copy or upload can create a directory where `exists` was false; no directory there either means its subtree
    // rows are stale. Key stores (S3) report every directory as existing, so they only lose the row.
    await clearStale(store, p, effect.probe === 'dirExists' || !(await probe(p, 'dirExists')));
    if ((store as { objectBound?: unknown }).objectBound === true) {
      // A row found there after the IO came with the object (a same-bucket copy), not from another writer.
      task = () => put(store, p, next);
    } else if (next) {
      task = () => stampIfAbsent(store, p, next);
    }
  }
  if (!task) return undefined;
  const stamp = task;
  if (!effect.stream) return after([p], stamp);
  return async (result) => {
    if (!isWritable(result)) return after([p], stamp)(result);
    stampOnClose(result, stamp, (e) => failed([p], e), opts.timeoutMs);
    return result;
  };
}

/**
 * The destination is probed like any write. When it existed, it keeps its metadata (first writer) and only the
 * source rows go. Otherwise one store on both sides moves the whole tree (`store.move`; S3 does nothing once the
 * object is gone, since the provider's copy within a bucket kept its metadata), and between two stores only the row
 * of the moved path travels, read before the IO because the source may be gone after it; the rows under a moved
 * directory are then dropped, and a warning says so. A row that appears at the destination during the IO wins.
 */
async function planMove(src: MetadataPath | undefined, dst: MetadataPath | undefined, after: (where: readonly MetadataPath[], task: () => Promise<void>) => AfterIo, opts: MetadataOptions): Promise<AfterIo | undefined> {
  if (!src) return undefined;
  const srcStore = await src.target.metadata();
  const dstStore = dst ? await dst.target.metadata() : undefined;
  if (!srcStore && !dstStore) return undefined;
  if (dst && src.target.name === dst.target.name && src.path === dst.path) return undefined;
  const where = dst ? [src, dst] : [src];
  const directory = srcStore !== undefined && (await probe(src, 'isDir'));
  const removeSource = async (): Promise<void> => {
    if (srcStore) await (directory ? deleteTree(srcStore, src) : srcStore.delete(src.target.name, src.path));
  };
  const before = srcStore ? await srcStore.get(src.target.name, src.path) : null;
  if (!dst || !dstStore) return after(where, removeSource);

  checkMeta(dstStore, dst, before ?? {});
  if (await probe(dst, 'exists')) {
    const kept = await dstStore.get(dst.target.name, dst.path);
    return after(where, async () => {
      await put(dstStore, dst, kept);
      await removeSource();
    });
  }
  await clearStale(dstStore, dst, directory);
  if (srcStore === dstStore) {
    return after(where, async () => {
      if ((await dstStore.get(dst.target.name, dst.path))?.owner) await removeSource();
      else await dstStore.move(src.target.name, src.path, dst.target.name, dst.path);
    });
  }
  return after(where, async () => {
    if (before) await stampIfAbsent(dstStore, dst, before);
    await removeSource();
    if (directory) opts.warn(`move of the directory ${src.target.name}:${src.path} to ${dst.target.name}:${dst.path} carried only its own metadata to another store; the files under it lost their owners`);
  });
}

type TreeStore = FileMetadataStore & { deleteTree?(fsName: string, path: string): Promise<void> };

/** The row of `p` and the rows under it, where the store keeps directories (OrmFileMetadataStore); else the row alone. */
function deleteTree(store: FileMetadataStore, p: MetadataPath): Promise<void> {
  const tree = (store as TreeStore).deleteTree;
  return tree ? tree.call(store, p.target.name, p.path) : store.delete(p.target.name, p.path);
}

/**
 * Before the IO, rows at a path that did not exist are stale (an rm outside the guard, a failed update): a file path
 * loses its own row, a directory its subtree. Done before, not after, so rows that others create there while the IO
 * runs are theirs.
 */
async function clearStale(store: FileMetadataStore, p: MetadataPath, directory: boolean): Promise<void> {
  if (directory) await deleteTree(store, p);
  else if (await store.get(p.target.name, p.path)) await store.delete(p.target.name, p.path);
}

/** First stamp wins: a path that got an owner since the probe keeps it. */
async function stampIfAbsent(store: FileMetadataStore, p: MetadataPath, meta: FileMeta): Promise<void> {
  const current = await store.get(p.target.name, p.path);
  if (current?.owner) return;
  await store.set(p.target.name, p.path, { ...current, ...meta });
}

/** Makes the store hold `next` for `p`, writing only when it differs. */
async function put(store: FileMetadataStore, p: MetadataPath, next: FileMeta | null): Promise<void> {
  const current = await store.get(p.target.name, p.path);
  if (sameFileMeta(current, next)) return;
  if (next) await store.set(p.target.name, p.path, next);
  else await store.delete(p.target.name, p.path);
}

type WritableLike = EventEmitter & { readonly writableFinished?: boolean; end(...args: unknown[]): unknown };

const isWritable = (value: unknown): value is WritableLike => value !== null && typeof value === 'object' && typeof (value as WritableLike).emit === 'function' && typeof (value as WritableLike).end === 'function';

/**
 * Holds back the stream's 'close' until the metadata is written (at most `timeoutMs`), so a caller that waits for
 * 'close' and then reads finds the owner. A stream that failed or was destroyed before it finished stamps nothing.
 * A failure goes to the stream's 'error' listeners (without any, only to the report: an unhandled 'error' would end
 * the process), then 'close' follows.
 */
function stampOnClose(stream: WritableLike, task: () => Promise<void>, failed: (e: unknown) => Error, timeoutMs: number): void {
  const own = Object.hasOwn(stream, 'emit');
  const emit = stream.emit;
  let errored = false;
  stream.emit = function (this: unknown, event: string | symbol, ...args: unknown[]): boolean {
    if (event === 'error') errored = true;
    if (event !== 'close') return Reflect.apply(emit, this, [event, ...args]) as boolean;
    if (own) stream.emit = emit;
    else delete (stream as { emit?: unknown }).emit;
    if (errored || stream.writableFinished === false) return Reflect.apply(emit, this, [event, ...args]) as boolean;
    const listened = stream.listenerCount('close') > 0;
    let settled = false;
    const settle = (e?: unknown): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (e !== undefined) {
        const error = failed(e);
        if (stream.listenerCount('error') > 0) Reflect.apply(emit, this, ['error', error]);
      }
      Reflect.apply(emit, this, [event, ...args]);
    };
    const timer = setTimeout(() => settle(new Error(`the metadata store did not answer within ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    task().then(
      () => settle(),
      (e: unknown) => settle(e ?? new Error('the metadata update failed')),
    );
    return listened;
  };
}
