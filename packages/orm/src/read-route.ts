import { AsyncLocalStorage } from 'node:async_hooks';
import type { OrmDriver } from './driver.js';

const ROUTES = new AsyncLocalStorage<ReadonlyMap<OrmDriver, OrmDriver>>();

/** Runs `fn` with the selects on `primary` sent to `read`: the relation loads of rows that `read` returned. */
export function withReadRoute<R>(primary: OrmDriver, read: OrmDriver, fn: () => R): R {
  const routes = new Map<OrmDriver, OrmDriver>(ROUTES.getStore() ?? []);
  routes.set(primary, read);
  return ROUTES.run(routes, fn);
}

/** The connection that returned the rows whose relations are loading, for a select on `primary`. */
export function readRouteOf(primary: OrmDriver): OrmDriver | undefined {
  return ROUTES.getStore()?.get(primary);
}
