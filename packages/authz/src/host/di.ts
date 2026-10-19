import type { Class, IContainer } from '@spinajs/di';

/** Every registration of `token` along the container chain, [] when none. Resolved per call on purpose, so a late registration counts. */
export async function resolveChain<T>(container: IContainer, token: Class<T>): Promise<T[]> {
  return [...(await container.resolve(Array.chainOf(token)))];
}
