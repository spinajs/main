import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { S3Client } from '@aws-sdk/client-s3';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { FileHasher, FileInfoService, FsBootsrapper, FsDecorator, fs, fsNative, fsService, fsTemp, getFs } from '@spinajs/fs';
import type { IProviderConfiguration } from '@spinajs/fs';
import { S3BucketSigner, fsS3 } from '@spinajs/fs-s3';
import { AuthorizationModel, AuthzContributor } from '@spinajs/authz';
import type { ResourceRef } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel } from '@spinajs/authz-rbac';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, FsArg, FsHandle, FsProviderSpec, FsResolverSpec, HostSetup } from '@spinajs/authz-testing';
import type { DateTime } from 'luxon';

import { AuthzFsDecorator, FileMetadataStore, FsPathResolver } from '../../src/index.js';
import { installQuietLog } from './log.js';
import { MemoryFileMetadataStore } from './memory-store.js';
import { S3_CLIENT_CONFIG, dropBucket } from './s3.js';

/**
 * How a world provider is built: 'local' is fsNative over a fresh directory; 'temp' is fsTemp over its own
 * fsNative backend (`<name>-backend`), so the guarded name is the temp fs; 's3' is fsS3 on a fresh bucket in
 * localstack, downloading through the case's own `fs-temp-s3`.
 */
export type FsProviderKind = 'local' | 'temp' | 's3';

/**
 * The field RFC L7-1 proposes for the kit's FsProviderSpec: the provider signs URLs. Local and temp providers
 * get a fake `signedUrl` whose URL carries `expires=<epoch ms>`; S3 providers get the real `S3UrlSigner`.
 */
export type SignedFsProviderSpec = FsProviderSpec & { readonly signedUrl?: boolean };

export interface FsHarnessOptions {
  /** The test domain; default 'test'. */
  readonly domain?: string;
  readonly kind?: FsProviderKind;
  /** Adds the rbac facet: the real RbacModel (and its contributor) in the test domain, loaded from `world.rbac`. */
  readonly rbac?: boolean;
}

interface CaseState {
  /** Every provider the case creates: the world's and the backends its kind adds. */
  readonly names: ReadonlySet<string>;
  readonly extra: ReadonlyMap<string, readonly string[]>;
  readonly fakeSigned: ReadonlySet<string>;
  readonly raw: Map<string, fs>;
}

const KIND_CLASS: Readonly<Record<FsProviderKind, Class<fs>>> = { local: fsNative, temp: fsTemp, s3: fsS3 };

let recording: CaseState | undefined;

/** The one MemoryFileMetadataStore the suite registers in root (worlds name it in `authz.fs.<name>.metadata`), emptied per case. */
export const caseStore = new MemoryFileMetadataStore();

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
    if (state.fakeSigned.has(config.name)) {
      // As fsS3: getSignedUrl(path, until) is signedUrl(path, { until }).
      const signedUrl = async (path: string, opts?: { until?: DateTime }) => `fake-signed://${config.name}/${path}?expires=${opts?.until?.toMillis() ?? ''}`;
      Object.defineProperty(instance, 'signedUrl', { value: signedUrl, configurable: true, writable: true });
      Object.defineProperty(instance, 'getSignedUrl', { value: (path: string, until?: DateTime) => signedUrl(path, { until }), configurable: true, writable: true });
    }
    return instance;
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

const PROVIDER_MAP = '__file_provider_instance__';
const PROVIDER_FACTORY = '__file_provider__';
/** fsS3 downloads (read, append, zip, unzip) through the provider of this name (`@FileSystem('fs-temp-s3')`). */
const S3_TEMP = 'fs-temp-s3';

function publishedProviders(): Map<string, fs> | undefined {
  const map: unknown = DI.RootContainer.Cache.has(PROVIDER_MAP) ? DI.get(PROVIDER_MAP) : undefined;
  return map instanceof Map ? (map as Map<string, fs>) : undefined;
}

async function writeFiles(basePath: string, files: Readonly<Record<string, string>> = {}): Promise<void> {
  await mkdir(basePath, { recursive: true });
  for (const [path, content] of Object.entries(files)) {
    const at = join(basePath, ...path.split('/'));
    await mkdir(dirname(at), { recursive: true });
    await writeFile(at, content);
  }
}

const bucketName = (caseId: string, name: string): string => `afs-${caseId}-${name.toLowerCase().replace(/[^a-z0-9-]/g, '-')}`.slice(0, 63);

/** The provider configs of one world provider (backends first) and, for S3, the files to write once it exists. */
async function materialise(kind: FsProviderKind, spec: SignedFsProviderSpec, root: string, caseId: string): Promise<{ configs: IProviderConfiguration[]; seed?: Readonly<Record<string, string>> }> {
  const basePath = join(root, 'fs', spec.name);
  switch (kind) {
    case 'local':
      await writeFiles(basePath, spec.files);
      return { configs: [{ service: 'fsNative', name: spec.name, basePath } as IProviderConfiguration] };
    case 'temp': {
      await writeFiles(basePath, spec.files);
      const backend = `${spec.name}-backend`;
      return {
        configs: [{ service: 'fsNative', name: backend, basePath } as IProviderConfiguration, { service: 'fsTemp', name: spec.name, provider: backend, cleanup: false } as IProviderConfiguration],
      };
    }
    case 's3': {
      const signer = spec.signedUrl ? { signer: { service: 'S3UrlSigner' } } : {};
      return { configs: [{ service: 'fsS3', name: spec.name, bucket: bucketName(caseId, spec.name), ...signer } as unknown as IProviderConfiguration], seed: spec.files };
    }
  }
}

async function s3TempProviders(root: string): Promise<IProviderConfiguration[]> {
  const basePath = join(root, 'fs', S3_TEMP);
  await mkdir(basePath, { recursive: true });
  return [{ service: 'fsNative', name: `${S3_TEMP}-local`, basePath } as IProviderConfiguration, { service: 'fsTemp', name: S3_TEMP, provider: `${S3_TEMP}-local`, cleanup: false } as IProviderConfiguration];
}

/** Empties and deletes the case's buckets and closes the clients (else mocha would not exit). */
async function disposeS3(instances: Iterable<fs>): Promise<void> {
  for (const instance of instances) {
    if (!(instance instanceof fsS3)) continue;
    const client = (instance as unknown as { S3?: S3Client }).S3;
    if (!client) continue;
    try {
      await dropBucket(client, instance.Options.bucket);
    } catch {
      // best effort: localstack is a throwaway container
    } finally {
      client.destroy();
    }
  }
  // S3BucketSigner is a singleton holding the first case's bucket and client.
  const root = DI.RootContainer;
  for (const key of [S3BucketSigner, 'S3UrlSigner'] as const) if (root.Cache.has(key)) root.uncache(key);
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

    this.undo.push(testHost.registerInRoot(FileMetadataStore, testHost.instance(caseStore)));

    const created = [AuthzFsDecorator, ...implementations(FileHasher), ...implementations(FileInfoService), ...implementations(FileMetadataStore)];
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

/**
 * World entries of `authz.fs` without a domain are checked in the test domain, where the world's models live. A
 * domain the fs bootstrap creates (D11) becomes a child of the test domain, so the world's models are its parent's,
 * unless the world names its parent.
 */
function pointAtTestDomain(host: HostSetup): void {
  const entries = host.world.config?.fs;
  if (!isRecord(entries)) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (!isRecord(entry)) continue;
    const domain = entry.domain;
    if (domain === undefined) host.setConfig(['authz', 'fs', name, 'domain'], host.domain);
    else if (typeof domain === 'string' && domain !== 'root' && domain !== host.domain && !host.containers.has(domain) && testHost.config().get(['authz', 'domains', domain, 'parent']) === undefined) {
      host.setConfig(['authz', 'domains', domain, 'parent'], host.domain);
    }
  }
}

/** An FsPathResolver class with the spec's name (`authz.fs.<name>.resolver` matches by class name): `<prefix><id>[/…]` has the parent `{ type, id }`. */
function resolverClass(spec: FsResolverSpec): Class<FsPathResolver> {
  const cls = class extends FsPathResolver {
    readonly fs = spec.fs;
    async parents(_fsName: string, path: string): Promise<readonly ResourceRef[] | null> {
      if (!path.startsWith(spec.prefix)) return null;
      const id = path.slice(spec.prefix.length).split('/')[0];
      return id === '' ? null : [{ type: spec.type, id }];
    }
  };
  Object.defineProperty(cls, 'name', { value: spec.name });
  return cls;
}

/** Registers the world's resolvers in root, where resolveFsParents looks them up; the returned function removes them. */
function registerResolvers(specs: readonly FsResolverSpec[]): () => void {
  const root = DI.RootContainer;
  const classes = specs.map(resolverClass);
  const uncache = () => {
    root.uncache(Array.ofType(FsPathResolver));
    for (const cls of classes) root.uncache(cls);
  };
  uncache();
  const undo = classes.map((cls) => testHost.registerInRoot(FsPathResolver, cls));
  return () => {
    for (const fn of undo.reverse()) fn();
    uncache();
  };
}

/** Disposes the authz domains created since `before` (the fs bootstrap's), children first. */
async function disposeNewDomains(before: ReadonlySet<string>): Promise<void> {
  const ds = await testHost.domains();
  for (const name of [...ds.names()].reverse()) {
    if (!before.has(name) && ds.names().includes(name)) await ds.container(name).dispose();
  }
}

async function buildCase(kind: FsProviderKind, specs: readonly SignedFsProviderSpec[]): Promise<{ handle: FsHandle; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'authz-fs-b-'));
  const caseId = randomUUID().slice(0, 8);
  caseStore.rows.clear();
  caseStore.calls.length = 0;

  const providers: IProviderConfiguration[] = [];
  const seeds = new Map<string, Readonly<Record<string, string>>>();
  const dispose = async () => {
    if (recording === state) recording = undefined;
    try {
      await disposeS3(state.raw.values());
    } finally {
      const published = publishedProviders();
      for (const name of state.names) published?.delete(name);
      uncacheInstances(state.raw.values());
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };

  let state: CaseState = { names: new Set(), extra: new Map(), fakeSigned: new Set(), raw: new Map() };
  try {
    for (const spec of specs) {
      const { configs, seed } = await materialise(kind, spec, root, caseId);
      providers.push(...configs);
      if (seed) seeds.set(spec.name, seed);
    }
    if (kind === 's3' && specs.length > 0) providers.push(...(await s3TempProviders(root)));
    state = {
      names: new Set(providers.map((p) => p.name)),
      extra: new Map(specs.map((s) => [s.name, s.extraMethods ?? []])),
      fakeSigned: new Set(kind === 's3' ? [] : specs.filter((s) => s.signedUrl).map((s) => s.name)),
      raw: new Map(),
    };

    if (providers.length > 0) {
      const service = new fsService();
      // The world's first provider is the default, as before the backends were added.
      Object.defineProperty(service, 'Config', { value: { defaultProvider: specs[0].name, providers }, configurable: true });
      recording = state;
      try {
        await service.resolve();
      } finally {
        recording = undefined;
      }
    }
    for (const spec of specs) {
      const raw = state.raw.get(spec.name);
      if (!(raw instanceof KIND_CLASS[kind])) throw new Error(`fs harness: ${spec.name} of kind ${kind} is not a ${KIND_CLASS[kind].name}`);
      for (const [path, content] of Object.entries(seeds.get(spec.name) ?? {})) await raw.write(path, content);
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
 * Dispose deletes the case's provider names from the published map even when a provider of that name was
 * published before the case, and the suite undo reaches into the private `Registry.registry` map to drop the
 * `__file_provider__` key it added.
 */
export function fsHarness(opts: FsHarnessOptions = {}): BehaviourHarness {
  const kind = opts.kind ?? 'local';
  const changes = new RootChanges();
  let undoLog: (() => void) | undefined;

  const base = hostHarness({
    domain: opts.domain ?? 'test',
    facets: opts.rbac ? ['fs', 'rbac'] : ['fs'],
    register(host) {
      pointAtTestDomain(host);
      if (kind === 's3') host.setConfig(['fs', 's3', 'config'], S3_CLIENT_CONFIG);
      if (opts.rbac) registerRbac(host);
    },
    async extend(host) {
      const domainsBefore = new Set((await testHost.domains()).names());
      const undoResolvers = registerResolvers(host.world.lane?.fs?.resolvers ?? []);
      const cleanup = async () => {
        try {
          await disposeNewDomains(domainsBefore);
        } finally {
          undoResolvers();
        }
      };
      let built: Awaited<ReturnType<typeof buildCase>>;
      try {
        built = await buildCase(kind, host.world.lane?.fs?.providers ?? []);
      } catch (e) {
        await cleanup();
        throw e;
      }
      const dispose = async () => {
        try {
          await built.dispose();
        } finally {
          await cleanup();
        }
      };
      return { lane: { fs: built.handle }, dispose };
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

/** The real RbacModel over in-memory stores loaded from `world.rbac`, as authz-rbac's own harness wires it. */
function registerRbac(host: HostSetup): void {
  const rbac = host.world.rbac ?? {};
  const model = new RbacModel({ roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []), assignments: new MemoryAssignmentStore(rbac.assignments ?? []), clock: host.kit.clock });
  host.container.register(testHost.instance(model)).as(AuthorizationModel);
  host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
}
