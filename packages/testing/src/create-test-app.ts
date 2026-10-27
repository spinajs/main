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
  schemas?: Array<IConfigurationSchema & Record<string, unknown>>;
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
}

export interface TestApp {
  readonly container: IContainer;
  readonly config: Configuration;
  resolve<T>(type: Class<T> | string): Promise<T>;
  /** Root scope: restores the root snapshot. Child scope: disposes the child. Idempotent. */
  dispose(): Promise<void>;
}

const open = new Set<TestApp>();

function configurationClass(options: TestAppOptions): Class<Configuration> {
  if (options.config && options.configuration) {
    throw new Error('createTestApp: pass either `config` or `configuration`, not both');
  }
  return options.configuration ?? configurationOf(options.config ?? {}, options.env);
}

async function boot(container: IContainer, options: TestAppOptions): Promise<Configuration> {
  container.register(configurationClass(options)).as(Configuration, { replace: true });
  for (const schema of options.schemas ?? []) {
    container.register(schema).asValue('__configurationSchema__');
  }
  await options.register?.(container);

  if (options.bootstrap ?? true) {
    const bootstrappers = await container.resolve(Array.ofType(Bootstrapper));
    for (const b of bootstrappers) {
      await b.bootstrap();
    }
  }

  const configuration = await container.resolve(Configuration);
  for (const type of options.resolve ?? []) {
    await container.resolve(type as Class<unknown>);
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

async function createRootApp(options: TestAppOptions): Promise<TestApp> {
  const container = DI.RootContainer;
  const sizeBefore = container.getCacheStats().size;
  const snapshot: ContainerSnapshot = container.snapshot();

  let configuration: Configuration;
  try {
    configuration = await boot(container, options);
  } catch (err) {
    await container.restore(snapshot);
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
        await container.restore(snapshot);
        strictSizeCheck(container, sizeBefore);
      })()),
  };
  open.add(app);
  return app;
}

export async function createTestApp(options: TestAppOptions = {}): Promise<TestApp> {
  if (options.scope === 'child') {
    throw new Error("createTestApp: scope 'child' is not implemented yet");
  }
  return createRootApp(options);
}

/** Disposes every app created by createTestApp that has not been disposed yet. */
export async function disposeTestApps(): Promise<void> {
  for (const app of [...open].reverse()) {
    await app.dispose();
  }
}
