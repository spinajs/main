import { Configuration, CONFIGURATION_CONTAINER_KEY, FrameworkConfiguration, InvalidConfiguration } from '@spinajs/configuration';
import { DI } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

export function configurationOf(values: Record<string, unknown>, env = 'test'): Class<Configuration> {
  const json = JSON.stringify(values);
  return class SpecConfiguration extends FrameworkConfiguration {
    constructor() {
      super();
      this.Env = env;
    }

    protected loadSources(): void {
      this.Sources = [];
    }

    protected onLoad(): unknown {
      return JSON.parse(json) as unknown;
    }
  } as unknown as Class<Configuration>;
}

export interface Booted {
  readonly child: IContainer;
  readonly configuration: Configuration;
}

const open: IContainer[] = [];

/** A child container with these schemas and values; the Configuration is resolved, so its validation has run. */
export async function boot(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<Booted> {
  const child = DI.RootContainer.child();
  open.push(child);
  for (const schema of schemas) child.register(schema).asValue('__configurationSchema__');
  child.register(configurationOf(values, env)).as(Configuration);
  return { child, configuration: await child.resolve(Configuration) };
}

/** The full paths of the violations the boot reports; [] when it succeeds. */
export async function violationsOf(schemas: readonly object[], values: Record<string, unknown>, env?: string): Promise<string[]> {
  try {
    await boot(schemas, values, env);
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
}

export async function disposeBooted(): Promise<void> {
  for (const c of open.splice(0)) await c.dispose();
}

/** For an instance built with `new`: makes its `@Config` properties read this container's Configuration. */
export function readingFrom<T extends object>(instance: T, container: IContainer): T {
  Object.defineProperty(instance, CONFIGURATION_CONTAINER_KEY, { value: container, configurable: true, writable: true });
  return instance;
}

/** A container whose Configuration answers `values` by full path (a unit-test stand-in; the values are not validated). */
export function fakeContainer(values: Record<string, unknown>): IContainer {
  const keyOf = (path: string | string[]): string => (Array.isArray(path) ? path.join('.') : path);
  const configuration = { get: (path: string | string[], fallback?: unknown) => (keyOf(path) in values ? values[keyOf(path)] : fallback) };
  return { get: () => configuration } as unknown as IContainer;
}
