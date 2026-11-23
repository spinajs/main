import { Config, InvalidConfiguration } from '@spinajs/configuration';
import { DI, Injectable } from '@spinajs/di';
import type { ClassInfo } from '@spinajs/di';
import { MIGRATION_DESCRIPTION_SYMBOL, MIGRATION_DI_SOURCE, MigrationSource, OrmMigration } from '@spinajs/orm';
import type { IMigrationDescriptor, OrmDriver } from '@spinajs/orm';
import { outboxConfig, type IQueueOutboxConfig } from './config.js';
import { OUTBOX_MESSAGE_ID_MAX, OUTBOX_TABLE } from './row.js';
import { assertInsertOrIgnore, insertOrIgnoreProbe } from './targets.js';

const STAMP = '2026_11_16_00_00_00';

/** `connection` is the name under `db.Connections`, never `default` or an alias: the name must not change with either. */
export function outboxMigrationName(connection: string): string {
  return `QueueOutbox_${connection.replace(/[^A-Za-z0-9]/g, '_')}_${STAMP}`;
}

export class QueueOutboxMigration extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(OUTBOX_TABLE, (t) => {
      t.bigint('Id').primaryKey().autoIncrement();
      // exact: a case-insensitive collation would let two MessageIds that differ in case collide on the unique key
      t.string('MessageId', OUTBOX_MESSAGE_ID_MAX).notNull().unique().exact();
      t.string('Name', 128).notNull();
      t.string('Type', 8).notNull();
      t.longtext('Message').notNull();
      t.string('Status', 12).notNull();
      t.int('Attempts').notNull().default().value(0);
      t.bigint('AvailableAt').notNull();
      t.bigint('CreatedAt').notNull();
      t.bigint('PublishedAt');
      t.longtext('PublishedTo');
      t.longtext('LastError');
      t.string('TraceParent', 55);
      t.string('ClaimedBy', 64);
      t.bigint('ClaimedUntil');
      t.int('ClaimEpoch').notNull().default().value(0);
    });
    await connection.index().table(OUTBOX_TABLE).name('queue_outbox_due').columns(['Status', 'AvailableAt', 'Id']);
    await connection.index().table(OUTBOX_TABLE).name('queue_outbox_published').columns(['Status', 'PublishedAt']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(OUTBOX_TABLE);
  }
}

const generated = new Map<string, typeof QueueOutboxMigration>();

/**
 * One class per connection, because a migration descriptor names one connection. The descriptor is set directly:
 * `@Migration()` would also register the class in DI for the rest of the process, outbox on or off.
 */
export function outboxMigrationFor(connection: string): typeof QueueOutboxMigration {
  let type = generated.get(connection);
  if (!type) {
    type = class extends QueueOutboxMigration {};
    Object.defineProperty(type, 'name', { value: outboxMigrationName(connection) });
    const descriptor: IMigrationDescriptor = { Connection: connection };
    Reflect.set(type, MIGRATION_DESCRIPTION_SYMBOL, descriptor);
    generated.set(connection, type);
  }
  return type;
}

@Injectable(MigrationSource)
export class QueueOutboxMigrationSource extends MigrationSource {
  @Config('queue.outbox')
  protected Outbox: Partial<IQueueOutboxConfig> | undefined;

  @Config('db.DefaultConnection')
  protected DefaultConnection: string | undefined;

  @Config('db.Aliases', { defaultValue: {} })
  protected Aliases: Record<string, string>;

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const config = outboxConfig(this.Outbox);
    if (!config.enabled) return [];
    const connections = [...new Set(config.connections.map((name) => this.connectionOf(name)))];
    for (const connection of connections) this.check(connection);
    return connections.map((connection) => ({ file: MIGRATION_DI_SOURCE, name: outboxMigrationName(connection), type: outboxMigrationFor(connection) }));
  }

  /**
   * Orm.resolve() awaits this source after it opened its connections and registered their factory, so a throw here
   * fails the boot. The Orm itself is still resolving and cannot be asked for its connection map.
   */
  protected check(connection: string): void {
    const driver = DI.resolve<OrmDriver | null>('OrmConnection', [connection]);
    if (!driver) throw new InvalidConfiguration(`queue.outbox.connections: ORM connection "${connection}" does not exist`);
    assertInsertOrIgnore({ connection, driver }, (probed) => this.probe(probed));
  }

  protected probe(driver: OrmDriver): void {
    insertOrIgnoreProbe(driver);
  }

  /**
   * The `db.Connections` name behind `default` or an alias, as `Orm.createConnections` wires them. Read from configuration:
   * this runs while the Orm resolves, before its connection map can be asked.
   */
  protected connectionOf(name: string): string {
    const named = this.Aliases[name] ?? name;
    return named === 'default' && this.DefaultConnection ? this.DefaultConnection : named;
  }
}
