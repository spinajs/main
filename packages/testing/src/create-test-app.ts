import { DI, Bootstrapper } from '@spinajs/di';
import type { Class, IContainer, ContainerSnapshot } from '@spinajs/di';
import { Configuration } from '@spinajs/configuration';
import type { IConfigurationSchema } from '@spinajs/configuration-common';
import { configurationOf } from './configuration-of.js';

export interface TestAppOptions {
  /** Plain config object; replaces FrameworkConfiguration subclassing in tests. Exclusive with `configuration`. */
  config?: Record<string, unknown>;
  /** An existing FrameworkConfiguration subclass. Exclusive with `config`. */
  configuration?: Class<Configuration>;
  /** Extra JSON schemas registered as '__configurationSchema__' before Configuration resolves. */
  schemas?: Array<IConfigurationSchema | (IConfigurationSchema & Record<string, unknown>)>;
  /** Registrations applied before anything resolves. */
  register?: (container: IContainer) => unknown;
  /** APP_ENV for this app; default 'test'. Only used with `config`. */
  env?: string;
  /** Resolve these after Configuration (Bootstrappers run first). */
  resolve?: Array<Class<unknown> | string>;
  /** 'root': snapshot/restore the root container (default). 'child': an isolating child container. */
  scope?: 'root' | 'child';
  /** Run every registered Bootstrapper before Configuration resolves. Default true. */
  bootstrap?: boolean;
  /**
   * Root scope: milliseconds a boot may take before it is abandoned (rejected, root restored, slot freed). Default 30000;
   * 0 or Infinity disables it. Keep it below the mocha hook timeout, or the hook fails first and the stuck boot holds the slot.
   */
  bootTimeout?: number;
  /** Root scope: how this app is named in "still booting" / "already live" errors. */
  name?: string;
}

export interface TestApp {
  readonly container: IContainer;
  readonly config: Configuration;
  resolve<T>(type: Class<T> | string): Promise<T>;
  /** Root scope: restores the root snapshot. Child scope: disposes the child. Idempotent. */
  dispose(): Promise<void>;
}

const DEFAULT_BOOT_TIMEOUT = 30_000;

const open = new Set<TestApp>();

interface RootClaim {
  readonly name: string;
  readonly since: number;
  phase: 'booting' | 'live' | 'disposing';
}
let rootClaim: RootClaim | undefined;
let rootClaims = 0;

interface BootAttempt {
  abandoned: boolean;
}

class BootAbandoned extends Error {
  public constructor() {
    super('createTestApp: boot was abandoned after its bootTimeout');
  }
}

function configurationClass(options: TestAppOptions): Class<Configuration> {
  if (options.config && options.configuration) {
    throw new Error('createTestApp: pass either `config` or `configuration`, not both');
  }
  return options.configuration ?? configurationOf(options.config ?? {}, options.env);
}

async function boot(container: IContainer, options: TestAppOptions, attempt: BootAttempt): Promise<Configuration> {
  // An abandoned boot must not touch root again; checked after every await.
  const alive = (): void => {
    if (attempt.abandoned) {
      throw new BootAbandoned();
    }
  };

  container.register(configurationClass(options)).as(Configuration, { replace: true });
  for (const schema of options.schemas ?? []) {
    container.register(schema).asValue('__configurationSchema__');
  }
  await options.register?.(container);
  alive();

  if (options.bootstrap ?? true) {
    const bootstrappers = await container.resolve(Array.ofType(Bootstrapper));
    alive();
    for (const b of bootstrappers) {
      await b.bootstrap();
      alive();
    }
  }

  const configuration = await container.resolve(Configuration);
  alive();
  for (const type of options.resolve ?? []) {
    await container.resolve(type as Class<unknown>);
    alive();
  }
  return configuration;
}

function strictSizeCheck(container: IContainer, before: number): void {
  if (process.env.SPINAJS_TEST_STRICT !== '1') return;
  const stats = container.getCacheStats();
  if (stats.size !== before) {
    throw new Error(`createTestApp: root cache has ${stats.size} entries after dispose, ${before} before: ${stats.entries.join(', ')}`);
  }
}

function describeClaim(claim: RootClaim): string {
  return `"${claim.name}" (${claim.phase}, started ${Date.now() - claim.since} ms ago)`;
}

function assertRootFree(): void {
  if (!rootClaim) return;
  const who = describeClaim(rootClaim);
  switch (rootClaim.phase) {
    case 'booting':
      throw new Error(
        `createTestApp: root app ${who} is still booting, so root is half-built; raise or lower its bootTimeout, or fix what it waits for`,
      );
    case 'disposing':
      throw new Error(`createTestApp: root app ${who} is still being disposed; wait for its dispose() to finish`);
    default:
      // A second root app would share the first one's container and its cached Configuration.
      throw new Error(
        `createTestApp: a root app is already live: ${who}; dispose it first, or use scope 'child' for apps side by side`,
      );
  }
}

async function bootWithTimeout(container: IContainer, options: TestAppOptions, attempt: BootAttempt, claim: RootClaim): Promise<Configuration> {
  const booting = boot(container, options, attempt);
  const limit = options.bootTimeout ?? DEFAULT_BOOT_TIMEOUT;
  if (!Number.isFinite(limit) || limit <= 0) {
    return booting;
  }

  // The abandoned boot settles later; nobody awaits it any more.
  booting.catch(() => undefined);
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      attempt.abandoned = true;
      // Resolutions still in flight would block the restore; they are disposed when they finish instead of cached.
      container.Cache.abandonPending();
      reject(new Error(`createTestApp: root app ${describeClaim(claim)} did not finish booting within ${limit} ms; the boot was abandoned and root restored`));
    }, limit);
  });
  try {
    return await Promise.race([booting, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

async function createRootApp(options: TestAppOptions): Promise<TestApp> {
  assertRootFree();
  const container = DI.RootContainer;
  const sizeBefore = container.getCacheStats().size;
  const snapshot: ContainerSnapshot = container.snapshot();

  const claim: RootClaim = { name: options.name ?? `root app #${++rootClaims}`, since: Date.now(), phase: 'booting' };
  rootClaim = claim;
  const release = (): void => {
    if (rootClaim === claim) {
      rootClaim = undefined;
    }
  };

  let configuration: Configuration;
  try {
    configuration = await bootWithTimeout(container, options, { abandoned: false }, claim);
  } catch (err) {
    try {
      await container.restore(snapshot).catch(() => undefined);
    } finally {
      release();
    }
    throw err;
  }

  let disposed: Promise<void> | undefined;
  const app: TestApp = {
    container,
    config: configuration,
    resolve: <T>(type: Class<T> | string) => Promise.resolve(container.resolve(type as Class<T>) as T | Promise<T>),
    dispose: async () => {
      if (!disposed) {
        claim.phase = 'disposing';
        open.delete(app);
        disposed = (async () => {
          try {
            await container.restore(snapshot);
            strictSizeCheck(container, sizeBefore);
          } finally {
            release();
          }
        })();
      }
      await disposed;
    },
  };
  open.add(app);
  claim.phase = 'live';
  return app;
}

async function createChildApp(options: TestAppOptions): Promise<TestApp> {
  const container = DI.RootContainer.child({ isolateSingletons: true });

  let configuration: Configuration;
  try {
    configuration = await boot(container, options, { abandoned: false });
  } catch (err) {
    await container.dispose({ plainOwners: true }).catch(() => undefined);
    throw err;
  }

  let disposed: Promise<void> | undefined;
  const app: TestApp = {
    container,
    config: configuration,
    resolve: <T>(type: Class<T> | string) => Promise.resolve(container.resolve(type as Class<T>) as T | Promise<T>),
    dispose: () =>
      (disposed ??= (async () => {
        open.delete(app);
        await container.dispose({ plainOwners: true });
      })()),
  };
  open.add(app);
  return app;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  return options.scope === 'child' ? createChildApp(options) : createRootApp(options);
}

/** Creates the app in beforeEach and disposes it in afterEach of the enclosing describe. */
export function useTestApp(options: TestAppOptions | (() => TestAppOptions) = {}): () => TestApp {
  let current: TestApp | undefined;

  beforeEach(async () => {
    current = await createTestApp(typeof options === 'function' ? options() : options);
  });

  afterEach(async () => {
    const app = current;
    current = undefined;
    await app?.dispose();
  });

  return () => {
    if (!current) {
      throw new Error('useTestApp: no app is live; call the getter inside a test or a beforeEach that runs after useTestApp');
    }
    return current;
  };
}

/** Disposes every app created by createTestApp that has not been disposed yet, then rethrows the first dispose error. */
export async function disposeTestApps(): Promise<void> {
  const errors: unknown[] = [];
  for (const app of [...open].reverse()) {
    await app.dispose().catch((err: unknown) => errors.push(err));
  }
  if (errors.length > 0) {
    throw errors[0];
  }
}
