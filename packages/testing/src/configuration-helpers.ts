import { Configuration, CONFIGURATION_CONTAINER_KEY, InvalidConfiguration } from '@spinajs/configuration';
import type { IContainer } from '@spinajs/di';
import { createTestApp } from './create-test-app.js';
import type { TestAppOptions } from './create-test-app.js';

/** Boots `schemas` over `config` in a child container and returns the violation paths, [] when the boot succeeds. */
export async function configurationViolations(options: Pick<TestAppOptions, 'schemas' | 'config' | 'env'>): Promise<string[]> {
  try {
    const app = await createTestApp({ ...options, scope: 'child', bootstrap: false });
    await app.dispose();
    return [];
  } catch (e) {
    if (e instanceof InvalidConfiguration) return e.violations.map((v) => v.path);
    throw e;
  }
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
  return { Registry: { ownsRegistration: () => true }, getRegisteredTypes: () => [], get: () => configuration } as unknown as IContainer;
}

/** Writes `value` without the schema check of Configuration.set, to test what reads a value that got past the schema. */
export function setPastSchema(configuration: Configuration, path: string, value: unknown): void {
  const keys = path.split('.');
  let node = (configuration as unknown as { Config: Record<string, unknown> }).Config;
  for (const key of keys.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>;
  node[keys[keys.length - 1]] = value;
}
