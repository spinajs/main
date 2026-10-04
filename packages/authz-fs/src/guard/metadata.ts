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

/** A checked path argument: its filesystem, normalised path and the owner to stamp (none for SYSTEM and the like). */
export interface MetadataPath {
  readonly target: MetadataTarget;
  readonly path: string;
  readonly owner?: PrincipalRef;
}

/** The file gets its previous metadata back, with the owner when stamping; `keep`: an existing file keeps its owner. */
interface Stamp {
  readonly kind: 'stamp';
  readonly arg: number;
  readonly keep?: 'exists' | 'dirExists';
  readonly stream?: true;
}

type Effect = Stamp | { readonly kind: 'delete'; readonly arg: number } | { readonly kind: 'move'; readonly from: number; readonly to: number };

const EFFECTS: Readonly<Record<string, Effect>> = Object.freeze(
  Object.assign(Object.create(null) as Record<string, Effect>, {
    write: { kind: 'stamp', arg: 0 },
    writeStream: { kind: 'stamp', arg: 0, stream: true },
    append: { kind: 'stamp', arg: 0, keep: 'exists' },
    mkdir: { kind: 'stamp', arg: 0, keep: 'dirExists' },
    upload: { kind: 'stamp', arg: 1 },
    copy: { kind: 'stamp', arg: 1 },
    zip: { kind: 'stamp', arg: 2 },
    unzip: { kind: 'stamp', arg: 1 },
    rm: { kind: 'delete', arg: 0 },
    move: { kind: 'move', from: 0, to: 1 },
    rename: { kind: 'move', from: 0, to: 1 },
  }),
);

export type AfterIo = (result: unknown) => Promise<unknown>;

/**
 * Runs before the IO (stores resolved, previous metadata read, so a misconfigured store fails before anything is
 * written) and returns what to do after a successful IO; undefined when the method keeps no metadata. A failure after
 * the IO is reported and rethrown: a lost owner row would deny the owner later, so it must not pass silently.
 */
export async function planMetadata(method: string, at: (arg: number) => MetadataPath | undefined, report: (message: string) => void): Promise<AfterIo | undefined> {
  const effect = EFFECTS[method];
  if (!effect) return undefined;
  const failed = (where: readonly MetadataPath[], e: unknown): Error => {
    report(`${method} on ${where.map((p) => `${p.target.name}:${p.path}`).join(' → ')} succeeded, but the metadata was not updated: ${e instanceof Error ? e.message : String(e)}`);
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
    return p && store ? after([p], () => store.delete(p.target.name, p.path)) : undefined;
  }

  if (effect.kind === 'move') {
    const src = at(effect.from);
    const dst = at(effect.to);
    if (!src) return undefined;
    const srcStore = await src.target.metadata();
    const dstStore = dst ? await dst.target.metadata() : undefined;
    if (!srcStore && !dstStore) return undefined;
    const where = dst ? [src, dst] : [src];
    if (dst && srcStore && srcStore === dstStore && src.target.name === dst.target.name) {
      return after(where, () => srcStore.move(src.target.name, src.path, dst.target.name, dst.path));
    }
    // Across filesystems the provider copies the bytes only, and the source may be gone after the IO: read first.
    const before = srcStore ? await srcStore.get(src.target.name, src.path) : null;
    return after(where, async () => {
      if (dst && dstStore) await put(dstStore, dst, before);
      if (srcStore) await srcStore.delete(src.target.name, src.path);
    });
  }

  const p = at(effect.arg);
  const store = p && (await p.target.metadata());
  if (!p || !store) return undefined;
  const existed = effect.keep ? (await Reflect.apply(p.target.raw[effect.keep] as (path: string) => Promise<boolean>, p.target.raw, [p.path])) === true : false;
  // Read before the IO: S3 write, upload and append replace an object's metadata, so after the IO it may be gone.
  const before = await store.get(p.target.name, p.path);
  const owner = p.target.stampOwner && !existed ? p.owner : undefined;
  const next: FileMeta | null = owner ? { ...before, owner } : before;
  const task = () => put(store, p, next);
  if (!effect.stream) return after([p], task);
  return async (result) => {
    if (!isWritable(result)) return after([p], task)(result);
    stampOnClose(result, task, (e) => failed([p], e));
    return result;
  };
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
 * Holds back the stream's 'close' until the metadata is written, so a caller that waits for 'close' and then reads
 * finds the owner. A stream that failed or was destroyed before it finished stamps nothing. A failure goes to the
 * stream's 'error' listeners (none: only the report), then 'close' follows.
 */
function stampOnClose(stream: WritableLike, task: () => Promise<void>, failed: (e: unknown) => Error): void {
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
    task().then(
      () => Reflect.apply(emit, this, [event, ...args]),
      (e: unknown) => {
        const error = failed(e);
        if (stream.listenerCount('error') > 0) Reflect.apply(emit, this, ['error', error]);
        Reflect.apply(emit, this, [event, ...args]);
      },
    );
    return listened;
  };
}
