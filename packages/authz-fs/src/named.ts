import type { Class, IContainer } from '@spinajs/di';

const className = (v: unknown): string => (v !== null && typeof v === 'object' ? (v.constructor?.name ?? '') : '');

/**
 * The `base` registered under `name` in the container lineage, else undefined. A class goes by its name and a
 * factory by its function name (`resolveNamed`); an anonymous factory, eg. `register(() => store)`, has none, so
 * it goes by the class of what it returns.
 */
export async function resolveByName<T>(container: IContainer, base: Class<T>, name: string): Promise<T | undefined> {
  if (container.getRegisteredNames(base).includes(name)) return container.resolveNamed(base, name);
  const all = (await container.resolve(Array.chainOf(base))) as T[];
  return all.find((s) => className(s) === name);
}

/** The names `resolveByName` finds, for an error message. */
export async function namesOf<T>(container: IContainer, base: Class<T>): Promise<string[]> {
  const all = (await container.resolve(Array.chainOf(base))) as T[];
  return [...new Set([...container.getRegisteredNames(base), ...all.map(className)])].filter((n) => n !== '');
}
