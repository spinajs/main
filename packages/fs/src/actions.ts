import { AsyncLocalStorage } from 'node:async_hooks';
import type { EventEmitter } from 'node:events';

import { Configuration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';

import type { fs } from './interfaces.js';
import { normalizeFsPath } from './paths.js';

export type FsAccess = 'read' | 'stat' | 'list' | 'write' | 'delete' | 'share';
export type FsPathKind = 'file' | 'dir';

export interface FsTarget {
  readonly fs: fs;
  /** Normalised by normalizeFsPath against `fs.BasePath`; '' is the fs root. */
  readonly path: string;
  readonly kind: FsPathKind;
  readonly access: readonly FsAccess[];
  readonly role: 'source' | 'destination';
}

export interface FsTargetSpec {
  /** Default: the fs the action runs on. */
  readonly fs?: fs;
  readonly path: string;
  readonly kind: FsPathKind;
  readonly access: readonly FsAccess[];
  readonly role?: 'source' | 'destination';
}

export interface FsActionContext {
  readonly action: string;
  readonly fs: fs;
  readonly targets: readonly FsTarget[];
  /** Non-path arguments; a middleware may replace entries (signedUrl options). */
  args: unknown[];
  readonly state: Map<symbol, unknown>;
  /** Memoised per target; runs inside the action frame, so no middleware sees it. */
  exists(target: FsTarget): Promise<boolean>;
  /** Like `exists`: whether the target path is a directory now (an S3 key never is). */
  isDir(target: FsTarget): Promise<boolean>;
  /** Like `exists`: whether listing the target path yields any entry (false when the list throws). */
  hasEntries(target: FsTarget): Promise<boolean>;
}

/**
 * Runs around every public file action of every fs provider. Lower `order` runs first; ties keep registration order.
 * `before` hooks run before any IO and abort the action by throwing; `after` hooks run in the same order once the IO
 * succeeded and may replace the result (not for stream actions, whose hooks run when the stream emits 'close').
 */
export abstract class FsMiddleware {
  public order = 0;
  /** Asked for every distinct fs the action touches; the middleware runs when any answers true. Default: always. */
  isEnabled?(fs: fs): boolean;
  abstract before(ctx: FsActionContext): Promise<void>;
  after?(ctx: FsActionContext, result: unknown): Promise<unknown>;
}

interface Frame {
  active: boolean;
}

const frame = new AsyncLocalStorage<Frame>();

export function inFsAction(): boolean {
  return frame.getStore()?.active === true;
}

// Closed when the action settles: stream callbacks the action set up run later in its async context and must be checked again.
async function inFrame<R>(fn: () => Promise<R>): Promise<R> {
  const f: Frame = { active: true };
  try {
    return await frame.run(f, fn);
  } finally {
    f.active = false;
  }
}

export function fsTarget(owner: fs, spec: FsTargetSpec): FsTarget {
  const target = spec.fs ?? owner;
  return Object.freeze({
    fs: target,
    path: normalizeFsPath(spec.path, target.BasePath),
    kind: spec.kind,
    access: Object.freeze([...spec.access]),
    role: spec.role ?? 'source',
  });
}

export interface FsActionRun<R> {
  readonly action: string;
  readonly owner: fs;
  readonly targets: readonly FsTarget[];
  readonly args: unknown[];
  readonly impl: (targets: readonly FsTarget[], args: unknown[]) => Promise<R>;
  readonly stream?: boolean;
}

const DEFAULT_TIMEOUT_MS = 30_000;

async function middlewares(): Promise<FsMiddleware[]> {
  const resolved = ((await DI.resolve(Array.ofType(FsMiddleware))) ?? []) as FsMiddleware[];
  return [...resolved].sort((a, b) => a.order - b.order);
}

function timeoutMs(): number {
  const configuration = DI.get(Configuration) as Configuration | undefined;
  const value = configuration?.get<number>('fs.middlewareTimeoutMs');
  return typeof value === 'number' && value > 0 ? value : DEFAULT_TIMEOUT_MS;
}

export async function executeFsAction<R>(run: FsActionRun<R>): Promise<R> {
  if (inFsAction()) return run.impl(run.targets, run.args);

  const filesystems = [...new Set([run.owner, ...run.targets.map((t) => t.fs)])];
  const chain = (await middlewares()).filter((m) => !m.isEnabled || filesystems.some((f) => m.isEnabled!(f)));
  if (chain.length === 0) return inFrame(() => run.impl(run.targets, run.args));

  const ctx = context(run);
  for (const m of chain) await m.before(ctx);
  const result = await inFrame(() => run.impl(ctx.targets, ctx.args));

  const after = chain.filter((m) => typeof m.after === 'function');
  if (after.length === 0) return result;
  if (run.stream && isWritable(result)) {
    holdClose(result, () => afterAll(after, ctx, result).then(() => undefined), timeoutMs());
    return result;
  }
  return (await afterAll(after, ctx, result)) as R;
}

async function afterAll(chain: readonly FsMiddleware[], ctx: FsActionContext, result: unknown): Promise<unknown> {
  let out = result;
  for (const m of chain) out = await m.after!(ctx, out);
  return out;
}

function context<R>(run: FsActionRun<R>): FsActionContext {
  const probes = new Map<string, Promise<boolean>>();
  const probe = (key: string, fn: () => Promise<boolean>): Promise<boolean> => {
    let p = probes.get(key);
    if (!p) {
      p = inFrame(fn);
      probes.set(key, p);
    }
    return p;
  };
  return {
    action: run.action,
    fs: run.owner,
    targets: run.targets,
    args: run.args,
    state: new Map(),
    exists(target: FsTarget): Promise<boolean> {
      return probe(`exists\0${target.fs.Name}\0${target.kind}\0${target.path}`, () =>
        target.kind === 'dir' ? target.fs.dirExists(target.path) : target.fs.exists(target.path),
      );
    },
    isDir(target: FsTarget): Promise<boolean> {
      return probe(`isDir\0${target.fs.Name}\0${target.path}`, () => target.fs.isDir(target.path));
    },
    hasEntries(target: FsTarget): Promise<boolean> {
      return probe(`hasEntries\0${target.fs.Name}\0${target.path}`, () =>
        target.fs.list(target.path).then(
          (entries) => entries.length > 0,
          () => false,
        ),
      );
    },
  };
}

type WritableLike = EventEmitter & { readonly writableFinished?: boolean; end(...args: unknown[]): unknown };

const isWritable = (value: unknown): value is WritableLike =>
  value !== null && typeof value === 'object' && typeof (value as WritableLike).emit === 'function' && typeof (value as WritableLike).end === 'function';

/**
 * Holds back the stream's 'close' until `task` settles (at most `timeoutMs`), so a caller that waits for 'close'
 * sees what the after hooks did. A stream that errored or was destroyed before it finished runs no task. A task
 * failure goes to the stream's 'error' listeners (without any it is dropped: an unhandled 'error' would end the
 * process), then 'close' follows.
 */
function holdClose(stream: WritableLike, task: () => Promise<void>, timeoutMs: number): void {
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
      if (e !== undefined && stream.listenerCount('error') > 0) Reflect.apply(emit, this, ['error', e]);
      Reflect.apply(emit, this, [event, ...args]);
    };
    const timer = setTimeout(() => settle(new Error(`fs middlewares did not finish within ${timeoutMs} ms`)), timeoutMs);
    timer.unref();
    task().then(
      () => settle(),
      (e: unknown) => settle(e ?? new Error('an fs middleware failed after the stream finished')),
    );
    return listened;
  };
}
