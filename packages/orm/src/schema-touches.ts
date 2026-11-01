import { AsyncLocalStorage } from 'node:async_hooks';
import type { OrmDriver } from './driver.js';

/** What a statement changed: the tables it names, or `'all'` when it cannot say. */
export type SchemaTouch = string[] | 'all';

/**
 * Per connection name ( the driver's `Options.Name`, so an alias and its target share an entry ): the lower-cased
 * table names a migration run changed, or `'all'`. Keyed by name, not driver instance: a migration may reach the
 * connection through a driver instance other than the one the Orm holds.
 */
export type SchemaTouches = Map<string, Set<string> | 'all'>;

interface ITouchScope {
  touches?: SchemaTouches;
  /** A migration's `up()` is running in this async context. */
  inUp?: boolean;
  inBuilder?: boolean;
}

const storage = new AsyncLocalStorage<ITouchScope>();

function note(touches: SchemaTouches, driver: OrmDriver, touch: SchemaTouch): void {
  const connection = driver.Options?.Name;

  if (!connection) {
    return;
  }

  const current = touches.get(connection);

  if (current === 'all') {
    return;
  }

  if (touch === 'all') {
    touches.set(connection, 'all');
    return;
  }

  if (touch.length === 0) {
    return;
  }

  const set = current ?? new Set<string>();
  touch.filter((t) => typeof t === 'string' && t.length > 0).forEach((t) => set.add(t.toLowerCase()));
  touches.set(connection, set);
}

/**
 * Runs `fn`, collecting into `touches` the tables every schema statement executed inside it names. SQL a migration's
 * `up()` sends straight to one of `drivers` ( `executeOnDb()` ) bypasses every builder and names no table, so it marks
 * that whole connection changed. The method lives in the dialect packages, which is why it is wrapped on each
 * instance for the duration instead of reported by the driver.
 */
export async function recordSchemaTouches<R>(touches: SchemaTouches, fn: () => Promise<R>, drivers: Iterable<OrmDriver> = []): Promise<R> {
  const restore = [...new Set(drivers)].map(watchRawSql);

  try {
    return await storage.run({ ...storage.getStore(), touches }, fn);
  } finally {
    restore.forEach((r) => r());
  }
}

function watchRawSql(driver: OrmDriver): () => void {
  const target = driver as unknown as { executeOnDb?: (...args: unknown[]) => unknown };
  const previous = target.executeOnDb;

  if (typeof previous !== 'function') {
    return () => undefined;
  }

  const hadOwn = Object.prototype.hasOwnProperty.call(target, 'executeOnDb');

  target.executeOnDb = function (this: unknown, ...args: unknown[]) {
    const s = storage.getStore();

    if (s?.touches && s.inUp && !s.inBuilder) {
      note(s.touches, driver, 'all');
    }

    return previous.apply(this, args);
  };

  return () => {
    if (hadOwn) {
      target.executeOnDb = previous;
    } else {
      delete target.executeOnDb;
    }
  };
}

/** Marks every table of `driver`'s connection as changed in `touches`. */
export function touchAllTables(touches: SchemaTouches, driver: OrmDriver): void {
  note(touches, driver, 'all');
}

/** Called by every builder right before its driver round trip. */
export function executeRecorded<R>(driver: OrmDriver, touch: () => SchemaTouch, run: () => Promise<R>): Promise<R> {
  const scope = storage.getStore();

  if (!scope?.touches) {
    return run();
  }

  note(scope.touches, driver, touch());
  return scope.inUp ? storage.run({ ...scope, inBuilder: true }, run) : run();
}

/** Runs a migration's `up()`, so the raw SQL it sends is told apart from the builders' and the runner's own. */
export async function runMigrationUp(up: () => Promise<void>): Promise<void> {
  const scope = storage.getStore();

  if (!scope?.touches) {
    return up();
  }

  await storage.run({ ...scope, inUp: true, inBuilder: false }, up);
}
