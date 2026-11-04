import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';
import { IDEMPOTENCY_CONNECTION, IDEMPOTENCY_TABLE } from '../connection.js';

// The schema builder has no char(): the fixed-width hash and uuid columns are varchar of that width.
@Migration(IDEMPOTENCY_CONNECTION)
export class Idempotency_2026_11_12_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable(IDEMPOTENCY_TABLE, (t) => {
      t.string('Key', 64).primaryKey().notNull().exact();
      // 128: `queue:<subscriptionId>` namespaces (outbox plan A9) do not fit 64
      t.string('Namespace', 128).notNull();
      t.string('Fingerprint', 64);
      t.string('State', 8).notNull();
      t.string('Token', 36).notNull();
      t.bigint('LeaseUntil').notNull();
      t.longtext('Reply');
      t.bigint('ExpiresAt');
      t.bigint('CreatedAt').notNull();
    });
    await connection.index().table(IDEMPOTENCY_TABLE).name('__idempotency_expires').columns(['ExpiresAt']);
    // the sweep's running branch: ended leases
    await connection.index().table(IDEMPOTENCY_TABLE).name('__idempotency_lease').columns(['State', 'LeaseUntil']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable(IDEMPOTENCY_TABLE);
  }
}
