import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

const TABLES = ['authn_identity', 'authn_throttle', 'authn_audit', 'authn_secret', 'authn_mfa', 'authn_recovery_code', 'authn_nonce'];

/**
 * The authn-orm tables of design §22.16, plus `authn_recovery_code_owner`. The schema builder has no `char`
 * type, so the `char(64)` hash columns are `varchar(64)`.
 */
@Migration('default')
export class AuthnInitial_2026_10_02_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().createTable('authn_identity', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('identity_type', 16).notNull();
      table.string('identity_id', 64).notNull();
      table.string('provider', 128).notNull();
      table.string('subject', 255).notNull();
      table.string('email', 255);
      table.boolean('email_verified').notNull().default().value(0);
      table.text('attributes');
      table.dateTime('linked_at').notNull();
      table.dateTime('last_used_at');
    });
    await connection.index().unique().table('authn_identity').name('authn_identity_subject').columns(['provider', 'subject']);
    await connection.index().table('authn_identity').name('authn_identity_owner').columns(['identity_type', 'identity_id']);

    await connection.schema().createTable('authn_throttle', (table) => {
      table.string('k', 255).notNull().primaryKey();
      table.int('attempts').notNull();
      table.dateTime('last_attempt_at').notNull();
      table.dateTime('next_allowed_at').notNull();
      table.dateTime('updated_at').notNull();
    });

    await connection.schema().createTable('authn_audit', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.dateTime('at').notNull();
      table.string('type', 32).notNull();
      table.string('outcome', 8).notNull();
      table.string('identity', 100);
      table.string('actor', 100);
      table.string('strategy', 64);
      table.string('reason', 64);
      table.string('ip', 64);
      table.string('user_agent', 255);
      table.string('session', 64);
      table.text('data');
    });
    await connection.index().table('authn_audit').name('authn_audit_at').columns(['at']);
    await connection.index().table('authn_audit').name('authn_audit_identity').columns(['identity', 'at']);

    await connection.schema().createTable('authn_secret', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('identity', 100).notNull();
      table.string('purpose', 32).notNull();
      table.string('secret_hash', 64).notNull();
      table.dateTime('expires_at').notNull();
      table.dateTime('used_at');
      table.dateTime('created_at').notNull();
    });
    await connection.index().unique().table('authn_secret').name('authn_secret_hash').columns(['secret_hash']);
    await connection.index().table('authn_secret').name('authn_secret_owner').columns(['identity', 'purpose']);

    await connection.schema().createTable('authn_mfa', (table) => {
      table.string('identity', 100).notNull().primaryKey();
      table.string('step', 32).notNull().primaryKey();
      table.text('secret_enc').notNull();
      table.string('key_id', 32).notNull();
      table.dateTime('confirmed_at');
      table.bigint('last_step');
      table.dateTime('created_at').notNull();
    });

    await connection.schema().createTable('authn_recovery_code', (table) => {
      table.string('id', 36).notNull().primaryKey();
      table.string('identity', 100).notNull();
      table.string('code_hash', 64).notNull();
      table.dateTime('used_at');
    });
    await connection.index().table('authn_recovery_code').name('authn_recovery_code_owner').columns(['identity']);

    await connection.schema().createTable('authn_nonce', (table) => {
      table.string('k', 160).notNull().primaryKey();
      table.dateTime('expires_at').notNull();
    });
  }

  public async down(connection: OrmDriver): Promise<void> {
    for (const table of [...TABLES].reverse()) {
      await connection.schema().dropTable(table);
    }
  }
}
