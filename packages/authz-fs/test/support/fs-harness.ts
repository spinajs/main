import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { S3Client } from '@aws-sdk/client-s3';
import { AuthzContributor, SYSTEM, runWithPrincipal } from '@spinajs/authz';
import { MemoryAssignmentStore, MemoryRoleStore, RbacContributor, RbacModel, RbacService } from '@spinajs/authz-rbac';
import { hostHarness, testHost } from '@spinajs/authz-testing';
import type { BehaviourHarness, FsArg, FsHandle, FsProviderSpec, HostSetup } from '@spinajs/authz-testing';
import { DI } from '@spinajs/di';
import type { Class } from '@spinajs/di';
import { FILE_PROVIDER_INSTANCES, FileHasher, FileInfoService, FsBootstrapper, FsMiddleware, fsNative, fsService, fsTemp, getFs, publishedFs } from '@spinajs/fs';
import type { IProviderConfiguration, fs } from '@spinajs/fs';
import { fsS3 } from '@spinajs/fs-s3';
import type { DateTime } from 'luxon';

import { AuthzFsMiddleware, FileAclStore } from '../../src/index.js';
import { installQuietLog } from './log.js';
import { MemoryFileAclStore } from './memory-acl-store.js';
import { S3_CLIENT_CONFIG, dropBucket } from './s3.js';

/**
 * How a world provider is built: 'local' is fsNative over a fresh directory; 'temp' is fsTemp over its own fsNative
 * backend (`<name>-backend`), so the checked name is the temp fs; 's3' is fsS3 on a fresh bucket in localstack,
 * downloading through the case's own `fs-temp-s3`.
 */
export type FsProviderKind = 'local' | 'temp' | 's3';

/**
 * The kit's FsProviderSpec plus `signedUrl`: local and temp providers get a fake doSignedUrl whose URL carries
 * `expires=<epoch ms>`; S3 providers get the real `S3UrlSigner`.
 */
export type SignedFsProviderSpec = FsProviderSpec & { readonly signedUrl?: boolean };

export interface FsHarnessOptions {
  /** The test domain; default 'test'. */
  readonly domain?: string;
  readonly kind?: FsProviderKind;
  /** Adds the rbac facet: the real RbacModel, its contributor and an RbacService in the test domain, loaded from `world.rbac`. */
  readonly rbac?: boolean;
}

const KIND_CLASS: Readonly<Record<FsProviderKind, Class<fs>>> = { local: fsNative, temp: fsTemp, s3: fsS3 };

const PROVIDER_FACTORY = '__file_provider__';
/** fsS3 downloads (read, append, zip, unzip) through the provider of this name (`@FileSystem('fs-temp-s3')`). */
const S3_TEMP = 'fs-temp-s3';

/** The one MemoryFileAclStore the suite registers in root, emptied per case. */
export const caseAcl = new MemoryFileAclStore();

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function publishedProviders(): Map<string, fs> | undefined {
  const map: unknown = DI.RootContainer.Cache.has(FILE_PROVIDER_INSTANCES) ? DI.get(FILE_PROVIDER_INSTANCES) : undefined;
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
    } catch (e) {
      // Not a test failure, but a shared localstack would collect the bucket unseen.
      console.warn(`      fs harness: could not delete bucket ${instance.Options.bucket}: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      client.destroy();
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

function implementations(token: Class<unknown>): Class<unknown>[] {
  const types = (DI.RootContainer.Registry.getTypes(token, false) ?? []) as unknown[];
  return types.filter((t): t is Class<unknown> => typeof t === 'function' && t.prototype !== undefined);
}

/** What the suite adds to root (registrations and the cache entries they cause), undone in reverse order. */
class RootChanges {
  private readonly undo: (() => void)[] = [];

  apply(): void {
    const root = DI.RootContainer;
    const cachedBefore = new Set([...root.Cache].map((e) => e.key));

    if (!root.hasRegistered(PROVIDER_FACTORY)) {
      new FsBootstrapper().bootstrap();
      this.undo.push(() => {
        // Registry.unregister matches by name, which every arrow factory shares; drop the key the bootstrapper created.
        (root.Registry as unknown as { registry: Map<string, unknown[]> }).registry.delete(PROVIDER_FACTORY);
      });
    }

    // A store or a middleware chain an earlier suite resolved would bypass the case store.
    root.uncache(FileAclStore.name);
    root.uncache(Array.ofType(FsMiddleware));
    this.undo.push(testHost.registerInRoot(FileAclStore, testHost.instance<FileAclStore>(caseAcl)));

    const created = [AuthzFsMiddleware, ...implementations(FileHasher), ...implementations(FileInfoService)];
    this.undo.push(() => {
      for (const type of created) if (!cachedBefore.has(type.name)) root.uncache(type);
      root.uncache(FileAclStore.name);
      root.uncache(Array.ofType(FsMiddleware));
      if (!cachedBefore.has(FILE_PROVIDER_INSTANCES)) root.uncache(FILE_PROVIDER_INSTANCES);
    });
  }

  restore(): void {
    for (const fn of this.undo.splice(0).reverse()) fn();
  }
}

/** World entries of `authz.fs` without a domain are checked in the test domain, where the world's models live. */
function pointAtTestDomain(host: HostSetup): void {
  const entries = host.world.config?.fs;
  if (!isRecord(entries)) return;
  for (const [name, entry] of Object.entries(entries)) {
    if (isRecord(entry) && entry.domain === undefined) host.setConfig(['authz', 'fs', name, 'domain'], host.domain);
  }
}

async function buildCase(kind: FsProviderKind, specs: readonly SignedFsProviderSpec[]): Promise<{ handle: FsHandle; dispose(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), 'authz-fs-b-'));
  const caseId = randomUUID().slice(0, 8);
  caseAcl.clear();
  const providers: IProviderConfiguration[] = [];
  const seeds = new Map<string, Readonly<Record<string, string>>>();
  const instances: fs[] = [];

  const dispose = async () => {
    try {
      await disposeS3(instances);
    } finally {
      const published = publishedProviders();
      for (const p of providers) published?.delete(p.name);
      uncacheInstances(instances);
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  };

  try {
    for (const spec of specs) {
      const { configs, seed } = await materialise(kind, spec, root, caseId);
      providers.push(...configs);
      if (seed) seeds.set(spec.name, seed);
    }
    if (kind === 's3' && specs.length > 0) providers.push(...(await s3TempProviders(root)));
    if (providers.length > 0) {
      const service = new fsService();
      // The world's first provider is the default, as before the backends were added.
      Object.defineProperty(service, 'Config', { value: { defaultProvider: specs[0].name, providers }, configurable: true });
      await service.resolve();
    }
    for (const p of providers) {
      const instance = publishedFs(p.name);
      if (instance) instances.push(instance);
    }
    for (const spec of specs) {
      const instance = publishedFs(spec.name);
      if (!(instance instanceof KIND_CLASS[kind])) throw new Error(`fs harness: ${spec.name} of kind ${kind} is not a ${KIND_CLASS[kind].name}`);
      if (spec.signedUrl && kind !== 's3') {
        const name = spec.name;
        // The base class signs through doSignedUrl after the middleware narrowed `until`.
        const doSignedUrl = async (path: string, opts?: { until?: DateTime }) => `fake-signed://${name}/${path}?expires=${opts?.until?.toMillis() ?? ''}`;
        Object.defineProperty(instance, 'doSignedUrl', { value: doSignedUrl, configurable: true, writable: true });
      }
      const seed = seeds.get(spec.name);
      // Setup files belong to nobody: written as SYSTEM, which the middleware neither checks nor stamps.
      if (seed) {
        await runWithPrincipal(SYSTEM, async () => {
          for (const [path, content] of Object.entries(seed)) await instance.write(path, content);
        });
      }
    }
  } catch (e) {
    await dispose();
    throw e;
  }

  // `{ fs }` and `{ localFile }` are mapped; every other argument, plain objects such as `{ exclusive: true }` included, passes unchanged.
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
    // No wrapper exists any more: getFs(name) is always the provider itself, checked or not.
    isRaw: () => true,
  };

  return { handle, dispose };
}

/**
 * hostHarness plus the fs facet: each case gets the world's filesystems (`World.lane.fs.providers`) through a fresh
 * fsService, checked by the AuthzFsMiddleware authz-fs registers in root, over one MemoryFileAclStore. The providers
 * are built in `extend`, after the domain booted, so a world the boot checks refuse leaves no provider behind.
 *
 * Dispose deletes the case's provider names from the published map even when a provider of that name was published
 * before the case, and the suite undo reaches into the private `Registry.registry` map to drop the
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

/** The real RbacModel over in-memory stores loaded from `world.rbac`, as authz-rbac's own harness wires it. */
function registerRbac(host: HostSetup): void {
  const rbac = host.world.rbac ?? {};
  const model = new RbacModel({ roles: new MemoryRoleStore(rbac.roles ?? [], rbac.ladders ?? []), assignments: new MemoryAssignmentStore(rbac.assignments ?? []), clock: host.kit.clock });
  testHost.activate(host.container, host.domain, model);
  host.container.register(testHost.instance(new RbacContributor(model))).as(AuthzContributor);
  // FsAclRelation asks the domain's RbacService for the subject keys, as an RbacModel built by DI wires it.
  host.container.register(testHost.instance(new RbacService(model))).as(RbacService);
}
