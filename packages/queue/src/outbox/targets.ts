import { InvalidConfiguration } from '@spinajs/configuration';
import type { Orm, OrmDriver } from '@spinajs/orm';
import { OUTBOX_TABLE } from './row.js';

export interface OutboxTarget {
  connection: string;
  driver: OrmDriver;
}

/** Two names of one driver (an alias and its connection) are one target, named by the first. */
export function outboxTargets(orm: Orm, names: readonly string[]): OutboxTarget[] {
  const targets: OutboxTarget[] = [];
  for (const connection of names) {
    const driver = orm.Connections.get(connection);
    if (!driver) throw new InvalidConfiguration(`queue.outbox.connections: ORM connection "${connection}" does not exist`);
    if (!targets.some((t) => t.driver === driver)) targets.push({ connection, driver });
  }
  return targets;
}

/** Compiles, without running it, the insert `OutboxStore.insert` sends; a dialect without insert-or-ignore throws here. */
export function insertOrIgnoreProbe(driver: OrmDriver): void {
  driver.insert().into(OUTBOX_TABLE).values({ MessageId: 'probe' }).orIgnore().toDB();
}

/**
 * The outbox insert must leave a repeated MessageId as a no-op: a unique violation would abort the caller's transaction
 * on Postgres. The dialect is probed rather than named, so a driver that gains orIgnore() passes without a change here.
 */
export function assertInsertOrIgnore(target: OutboxTarget, probe: (driver: OrmDriver) => void = insertOrIgnoreProbe): void {
  try {
    probe(target.driver);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new InvalidConfiguration(
      `queue.outbox.connections: ORM connection "${target.connection}" (driver ${target.driver.Options.Driver}) cannot compile an insert with orIgnore(), which the outbox needs: ${reason}. ` +
        `Use a driver release that implements orIgnore() (for SQL Server: an @spinajs/orm-mssql that has it), or leave the connection out of queue.outbox.connections`,
    );
  }
}
