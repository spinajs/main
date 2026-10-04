import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { FileHasher, FileInfoService, FsBootsrapper, FsDecorator, fs, fsService, getFs } from '@spinajs/fs';
import type { IProviderConfiguration } from '@spinajs/fs';
import { hostHarness } from '@spinajs/authz-testing';
import type { BehaviourHarness, FsArg, FsHandle, FsProviderSpec, HostSetup } from '@spinajs/authz-testing';

import { AuthzFsDecorator } from '../../src/index.js';
import { installQuietLog } from './log.js';

/** How a world provider is built: 'local' is fsNative over a fresh directory; later tasks add fsTemp and S3. */
export type FsProviderKind = 'local';

export interface FsHarnessOptions {
  /** The test domain; default 'test'. */
  readonly domain?: string;
  readonly kind?: FsProviderKind;
}

interface CaseState {
  readonly names: ReadonlySet<string>;
  readonly extra: ReadonlyMap<string, readonly string[]>;
  readonly raw: Map<string, fs>;
}

let recording: CaseState | undefined;

/** Runs before AuthzFsDecorator (100), so it sees the instance fsService created. */
class RecordingFsDecorator extends FsDecorator {
  readonly order = 10;

  decorate(instance: fs, config: IProviderConfiguration): fs {
    const state = recording;
    if (!state?.names.has(config.name)) return instance;
    state.raw.set(config.name, instance);
    for (const method of state.extra.get(config.name) ?? []) {
      Object.defineProperty(instance, method, { value: async () => method, configurable: true, writable: true });
    }
    return instance;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const PROVIDER_MAP = '__file_provider_instance__';
const PROVIDER_FACTORY = '__file_provider__';

function publishedProviders(): Map<string, fs> | undefined {
  const map: unknown = DI.RootContainer.Cache.has(PROVIDER_MAP) ? DI.get(PROVIDER_MAP) : undefined;
  return map instanceof Map ? (map as Map<string, fs>) : undefined;
}

async function materialise(kind: FsProviderKind, spec: FsProviderSpec, root: string): Promise<IProviderConfiguration> {
  switch (kind) {
    case 'local': {
      const basePath = join(root, 'fs', spec.name);
      await mkdir(basePath, { recursive: true });
      for (const [path, content] of Object.entries(spec.files ?? {})) {
        const at = join(basePath, ...path.split('/'));
        await mkdir(dirname(at), { recursive: true });
        await writeFile(at, content);
      }
      return { service: 'fsNative', name: spec.name, basePath } as IProviderConfiguration;
    }
  }
}

// PerInstanceCheck caches provider instances by name in root; a stale 'uploads' of an earlier case would keep its old base path.
function uncacheInstances(instances: Iterable<fs>): void {
  const root = DI.RootContainer;
  for (const instance of instances) {
    const type = instance.constructor as Class<unknown>;
    if (!root.Cache.has(type)) continue;
    const cached: unknown = root.Cache.get(type);
    if (!Array.isArray(cached)) continue;
    const at = cached.indexOf(instance);
    if (at >= 0) cached.splice(at, 1);
    if (cached.length === 0) root.uncache(type);
  }
}

function closed(stream: NodeJS.EventEmitter): Promise<void> {
  return new Promise((resolve, reject) => {
    stream.once('close', () => resolve());
    stream.once('error', reject);
  });
}

/** Ends a write stream, drains a read stream; resolves once the stream closed (Windows keeps the file open until then). */
async function settleStream(value: unknown): Promise<void> {
  if (value === null || typeof value !== 'object') return;
  const s = value as NodeJS.EventEmitter & { writable?: boolean; readable?: boolean; closed?: boolean; end?: () => void; resume?: () => void };
  if (typeof s.once !== 'function') return;
  const writable = s.writable === true && typeof s.end === 'function';
  const readable = s.readable === true && typeof s.resume === 'function';
  if ((!writable && !readable) || s.closed === true) return;
  const done = closed(s);
  if (writable) s.end!();
  if (readable) s.resume!();
  await done;
}

/** What the suite adds to root (registrations and the cache entries they cause), undone in reverse order. */
class RootChanges {
  private readonly undo: (() => void)[] = [];

  apply(): void {
    const root = DI.RootContainer;
    const cachedBefore = new Set([...root.Cache].map((e) => e.key));

    if (!root.hasRegistered(PROVIDER_FACTORY)) {
      new FsBootsrapper().bootstrap();
      this.undo.push(() => {
        // Registry.unregister matches by name, which every arrow factory shares; drop the key the bootstrapper created.
        (root.Registry as unknown as { registry: Map<string, unknown[]> }).registry.delete(PROVIDER_FACTORY);
      });
    }

    // A cached FsDecorator list would not hold the recorder.
    if (root.Cache.has(Array.ofType(FsDecorator))) root.uncache(Array.ofType(FsDecorator));
    root.register(RecordingFsDecorator).as(FsDecorator);
    this.undo.push(() => {
      root.unregister(RecordingFsDecorator);
      root.uncache(RecordingFsDecorator);
      root.uncache(Array.ofType(FsDecorator));
    });

    const created = [AuthzFsDecorator, ...implementations(FileHasher), ...implementations(FileInfoService)];
    this.undo.push(() => {
      for (const type of created) if (!cachedBefore.has(type.name)) root.uncache(type);
      if (!cachedBefore.has(PROVIDER_MAP)) root.uncache(PROVIDER_MAP);
    });
  }

  restore(): void {
    for (const fn of this.undo.splice(0).reverse()) fn();
  }
}

function implementations(token: Class<unknown>): Class<unknown>[] {
  const types = (DI.RootContainer.Registry.getTypes(token, false) ?? []) as unknown[];
  return types.filter((t): t is Class<unknown> => typeof t === 'function' && t.prototype !== undefined);
}

/** World entries of `authz.fs` without a domain are checked in the test domain, where the world's models live. */
function pointAtTestDomain(host: HostSetup): void {
  const entries = host.world.config?.fs;
  if (!isRecord(entries)) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (isRecord(entry) && entry.domain === undefined) host.setConfig(['authz', 'fs', name, 'domain'], host.domain);
  }
}

async function buildCase(kind: FsProviderKind, specs: readonly FsProviderSpec[]): Promise<{ handle: FsHandle; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'authz-fs-b-'));
  const state: CaseState = { names: new Set(specs.map((s) => s.name)), extra: new Map(specs.map((s) => [s.name, s.extraMethods ?? []])), raw: new Map() };

  const dispose = async () => {
    if (recording === state) recording = undefined;
    const published = publishedProviders();
    for (const name of state.names) published?.delete(name);
    uncacheInstances(state.raw.values());
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  };

  try {
    const providers: IProviderConfiguration[] = [];
    for (const spec of specs) providers.push(await materialise(kind, spec, root));

    if (providers.length > 0) {
      const service = new fsService();
      Object.defineProperty(service, 'Config', { value: { defaultProvider: providers[0].name, providers }, configurable: true });
      recording = state;
      try {
        await service.resolve();
      } finally {
        recording = undefined;
      }
    }
  } catch (e) {
    await dispose();
    throw e;
  }

  const toArg = async (arg: FsArg): Promise<unknown> => {
    if (Array.isArray(arg)) return Promise.all(arg.map(toArg));
    if (arg !== null && typeof arg === 'object' && 'fs' in arg) return getFs(arg.fs);
    if (arg !== null && typeof arg === 'object' && 'localFile' in arg) {
      const at = join(root, 'local', randomUUID());
      await mkdir(dirname(at), { recursive: true });
      await writeFile(at, arg.localFile);
      return at;
    }
    return arg;
  };

  const handle: FsHandle = {
    async call(name, method, args) {
      const target = getFs(name) as unknown as Record<string, unknown>;
      const fn = target[method];
      if (typeof fn !== 'function') throw new Error(`fs harness: filesystem ${name} has no method ${method}`);
      const mapped = await Promise.all(args.map(toArg));
      const result: unknown = await (fn as (...a: unknown[]) => unknown).apply(target, mapped);
      await settleStream(result);
      return result;
    },
    isRaw(name) {
      const raw = state.raw.get(name);
      return raw !== undefined && getFs(name) === raw;
    },
  };

  return { handle, dispose };
}

/**
 * hostHarness plus the fs facet: each case gets the world's filesystems (`World.lane.fs.providers`)
 * through a fresh fsService, so the real FsDecorator chain runs. The providers are built in `extend`,
 * after the domain booted, so a world the boot checks refuse leaves no provider behind.
 *
 * For the later fsTemp and S3 kinds: dispose deletes the case's provider names from the published map even
 * when a provider of that name was published before the case, and the suite undo reaches into the private
 * `Registry.registry` map to drop the `__file_provider__` key it added.
 */
export function fsHarness(opts: FsHarnessOptions = {}): BehaviourHarness {
  const kind = opts.kind ?? 'local';
  const changes = new RootChanges();
  let undoLog: (() => void) | undefined;

  const base = hostHarness({
    domain: opts.domain ?? 'test',
    facets: ['fs'],
    register: pointAtTestDomain,
    async extend(host) {
      const built = await buildCase(kind, host.world.lane?.fs?.providers ?? []);
      return { lane: { fs: built.handle }, dispose: built.dispose };
    },
  });

  return {
    ...base,
    async beforeAll() {
      await base.beforeAll?.();
      undoLog = installQuietLog();
      changes.apply();
    },
    async afterAll() {
      try {
        await base.afterAll?.();
      } finally {
        changes.restore();
        undoLog?.();
        undoLog = undefined;
      }
    },
  };
}
