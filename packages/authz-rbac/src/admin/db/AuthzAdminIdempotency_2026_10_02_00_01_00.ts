import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

/** authz_admin_idempotency: what DbAuthzAdminBackend remembers of a committed AuthzAdmin batch, per idempotency key. */
@Migration('default')
export class AuthzAdminIdempotency_2026_10_02_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authz_admin_idempotency', (table) => {
      table.string('domain', 64).notNull().primaryKey();
      table.string('actor', 100).notNull().primaryKey();
      table.string('idem_key', 160).notNull().primaryKey();
      table.text('results').notNull();
      table.text('rows').notNull();
      table.dateTime('expires_at').notNull();
      table.dateTime('created_at').notNull();
    });
    await connection.index().table('authz_admin_idempotency').name('authz_admin_idempotency_expires').columns(['expires_at']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authz_admin_idempotency');
  }
}
