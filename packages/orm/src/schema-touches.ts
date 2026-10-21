import { AsyncLocalStorage } from 'node:async_hooks';
import type { OrmDriver } from './driver.js';

/** What a statement changed: the tables it names, or `'all'` when it cannot say. */
export type SchemaTouch = string[] | 'all';

/** Per connection: the lower-cased table names a migration run changed, or `'all'`. */
export type SchemaTouches = Map<OrmDriver, Set<string> | 'all'>;

interface ITouchScope {
  touches: SchemaTouches;
  /** The driver whose migration `up()` is running in this async context. */
  migrationOn?: OrmDriver;
  inBuilder?: boolean;
}

const storage = new AsyncLocalStorage<ITouchScope>();

function note(touches: SchemaTouches, driver: OrmDriver, touch: SchemaTouch): void {
  const current = touches.get(driver);

  if (current === 'all') {
    return;
  }

  if (touch === 'all') {
    touches.set(driver, 'all');
    return;
  }

  if (touch.length === 0) {
    return;
  }

  const set = current ?? new Set<string>();
  touch.filter((t) => typeof t === 'string' && t.length > 0).forEach((t) => set.add(t.toLowerCase()));
  touches.set(driver, set);
}

/** Runs `fn`, collecting into `touches` the tables every schema statement executed inside it names. */
export function recordSchemaTouches<R>(touches: SchemaTouches, fn: () => Promise<R>): Promise<R> {
  return storage.run({ touches }, fn);
}

/** Marks every table of `driver` as changed in the current recording, if there is one. */
export function touchAllTables(touches: SchemaTouches, driver: OrmDriver): void {
  note(touches, driver, 'all');
}

/** Called by every builder right before its driver round trip. */
export function executeRecorded<R>(driver: OrmDriver, touch: () => SchemaTouch, run: () => Promise<R>): Promise<R> {
  const scope = storage.getStore();

  if (!scope) {
    return run();
  }

  note(scope.touches, driver, touch());
  return scope.migrationOn ? storage.run({ ...scope, inBuilder: true }, run) : run();
}

/**
 * Runs a migration's `up()`. SQL it sends straight to the driver ( `executeOnDb()` ) bypasses
 * every builder and names no table, so it marks the whole connection changed. The driver method
 * lives in the dialect packages, which is why it is wrapped on the instance for the duration
 * instead of reported by the driver.
 */
export async function runMigrationUp(driver: OrmDriver, up: () => Promise<void>): Promise<void> {
  const scope = storage.getStore();
  const target = driver as unknown as { executeOnDb?: (...args: unknown[]) => unknown };
  const previous = target.executeOnDb;

  if (!scope || typeof previous !== 'function') {
    return up();
  }

  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'executeOnDb');

  target.executeOnDb = function (this: unknown, ...args: unknown[]) {
    const s = storage.getStore();

    if (s?.migrationOn === driver && !s.inBuilder) {
      note(s.touches, driver, 'all');
    }

    return previous.apply(this, args);
  };

  try {
    await storage.run({ ...scope, migrationOn: driver, inBuilder: false }, up);
  } finally {
    if (hadOwn) {
      target.executeOnDb = previous;
    } else {
      delete target.executeOnDb;
    }
  }
}
