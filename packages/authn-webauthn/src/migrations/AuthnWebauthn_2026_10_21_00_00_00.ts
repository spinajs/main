import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

const TABLES = ['authn_webauthn_credential', 'authn_webauthn_challenge'];

/** The WebAuthn credentials and the challenges issued for them. */
@Migration('default')
export class AuthnWebauthn_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authn_webauthn_credential', (table) => {
      table.string('id_hash', 64).notNull().primaryKey();
      table.text('credential_id').notNull();
      table.string('identity', 100).notNull();
      table.text('public_key').notNull();
      table.bigint('counter').notNull();
      table.string('transports', 255);
      table.string('aaguid', 36);
      table.string('name', 255);
      table.dateTime('created_at').notNull();
      table.dateTime('last_used_at');
    });
    await connection.index().table('authn_webauthn_credential').name('authn_webauthn_credential_owner').columns(['identity']);

    await connection.schema().createTable('authn_webauthn_challenge', (table) => {
      table.string('id', 64).notNull().primaryKey();
      table.string('challenge', 128).notNull();
      table.string('purpose', 16).notNull();
      table.string('identity', 100);
      table.dateTime('expires_at').notNull();
    });
    await connection.index().table('authn_webauthn_challenge').name('authn_webauthn_challenge_expiry').columns(['expires_at']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      await connection.schema().dropTable(table);
    }
  }
}
