import type { Class, Constructor, IContainer } from '@spinajs/di';
import { InvalidOption } from '@spinajs/exceptions';

/** A service type a config key may name; abstract bases included. */
export type ServiceBase<T> = abstract new (...args: never[]) => T;

/** One resolved entry of a config key listing services. */
export interface IConfiguredType<T> {
  readonly type: Constructor<T>;
  /** The entry as configured: a `{ service, options }` entry is an object, a name a string, a class a function. */
  readonly entry: unknown;
  /** `options` of a `{ service, options }` entry. */
  readonly options?: unknown;
}

export function describeConfigEntry(entry: unknown): string {
  return typeof entry === 'function' ? entry.name || '<anonymous class>' : (JSON.stringify(entry) ?? String(entry));
}

const extendsBase = (type: unknown, base: ServiceBase<unknown>): boolean => typeof type === 'function' && type.prototype instanceof base;

// `@Injectable(Base)` registers a class under the base, `@Injectable()` only under its own name; both are nameable.
function typeNamed<T>(name: string, base: ServiceBase<T>, container: IContainer): Constructor<T> | undefined {
  const registered = (container.getRegisteredTypes(base as unknown as Class<T>) ?? []).find((t) => (t as { name?: string }).name === name);
  if (registered) {
    return registered as Constructor<T>;
  }
  const own = container.getRegisteredTypes(name) ?? [];
  for (let i = own.length - 1; i >= 0; i--) {
    if (extendsBase(own[i], base)) {
      return own[i] as Constructor<T>;
    }
  }
  return undefined;
}

function typeOf<T>(key: string, base: ServiceBase<T>, service: string | Function, container: IContainer): Constructor<T> {
  if (typeof service === 'string') {
    const type = typeNamed(service, base, container);
    if (!type) {
      throw new InvalidOption(`${key}: no ${base.name} named ${service} is registered`);
    }
    return type;
  }
  if (!extendsBase(service, base)) {
    throw new InvalidOption(`${key}: ${describeConfigEntry(service)} is not a ${base.name}`);
  }
  return service as Constructor<T>;
}

/**
 * Turns the entries of a config key listing services ( `'Name' | Class | { service, options }` ) into their types, in
 * config order. An entry that names no `base` type, or has another shape, fails with InvalidOption naming `key` and the
 * entry. Instances are left to the caller: each key passes its options in its own way.
 */
export function resolveConfiguredTypes<T>(key: string, base: ServiceBase<T>, entries: readonly unknown[], container: IContainer): IConfiguredType<T>[] {
  return entries.map((entry) => {
    if (typeof entry === 'string' || typeof entry === 'function') {
      return { type: typeOf(key, base, entry, container), entry };
    }
    if (entry !== null && typeof entry === 'object' && !Array.isArray(entry)) {
      const { service, options } = entry as { service?: unknown; options?: unknown };
      if (typeof service !== 'string' && typeof service !== 'function') {
        throw new InvalidOption(`${key}: entry ${describeConfigEntry(entry)} has no service ( a ${base.name} name or class )`);
      }
      return { type: typeOf(key, base, service, container), entry, options };
    }
    throw new InvalidOption(`${key}: entry ${describeConfigEntry(entry)} is not a ${base.name} name, a ${base.name} class or { service, options }`);
  });
}
