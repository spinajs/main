import { runAcrossTenants, runInTenant } from '@spinajs/tenancy';

/** Awaits `fn()` inside the scope: a query builder runs when it is awaited, not when it is built. */
export const inTenant = <T>(id: string, fn: () => PromiseLike<T>): Promise<T> => runInTenant(id, async () => await fn());

export const everywhere = <T>(fn: () => PromiseLike<T>): Promise<T> => runAcrossTenants('test fixture', async () => await fn());
