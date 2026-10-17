import { ServiceNotFound } from '@spinajs/di';
import type { Class, IContainer } from '@spinajs/di';

import { AuthzConfigError } from '../contracts/errors.js';

/** Every registration of `token` along the container chain, [] when none. Resolved per call on purpose, so a late registration counts. */
export async function resolveChain<T>(container: IContainer, token: Class<T>): Promise<T[]> {
  return [...(await container.resolve(Array.chainOf(token)))];
}

/**
 * The registration of `token` named `name` (the last one of that name wins, see `IContainer.resolveNamed`); without a
 * name, the last registration of `token`, or undefined when there is none. An unknown name is an AuthzConfigError
 * naming the config `key` and prefixed with `where`.
 */
export async function pickNamed<T>(container: IContainer, token: Class<T>, name: string, key: string, where: string): Promise<T>;
export async function pickNamed<T>(container: IContainer, token: Class<T>, name: string | undefined, key: string, where: string): Promise<T | undefined>;
export async function pickNamed<T>(container: IContainer, token: Class<T>, name: string | undefined, key: string, where: string): Promise<T | undefined> {
  if (name === undefined) return (await container.resolveOptional(token)) as T | undefined;
  try {
    return await container.resolveNamed(token, name);
  } catch (e) {
    // A ServiceNotFound from building the named class (a missing dependency) is not an unknown name.
    if (e instanceof ServiceNotFound && !container.getRegisteredNames(token).includes(name)) {
      throw new AuthzConfigError(`${where}: ${key} names ${JSON.stringify(name)}, but no ${token.name} class of that name is registered`, { cause: e });
    }
    throw e;
  }
}
