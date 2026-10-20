import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** Design §22.16 `authn_key`, plus an owner index for GET /user/keys. */
@Migration('default')
export class AuthnKeys_2026_10_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authn_key', (table) => {
      table.string('kid', 64).primaryKey();
      table.string('owner_type', 16).notNull();
      table.string('owner_id', 64).notNull();
      table.string('alg', 16).notNull();
      table.text('jwk').notNull();
      table.string('thumbprint', 64).notNull();
      table.text('scope');
      table.string('name', 128);
      table.dateTime('expires_at');
      table.dateTime('revoked_at');
      table.dateTime('last_used_at');
      table.string('created_by', 100);
      table.dateTime('created_at').notNull();
    });
    await connection.index().unique().table('authn_key').name('authn_key_thumb').columns(['thumbprint']);
    await connection.index().table('authn_key').name('authn_key_owner').columns(['owner_type', 'owner_id']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().dropTable('authn_key');
  }
}
