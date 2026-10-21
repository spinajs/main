import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

/** `ExternalKey` is sha256(provider + NUL + sid) of an external login, so a back-channel logout finds its rows by index. */
@Migration('session-provider-connection')
export class UserSessionExternalKey_2026_10_21_00_01_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('user_sessions', (table) => {
      table.string('ExternalKey', 64);
    });

    await connection.index().table('user_sessions').name('user_sessions_external_key_idx').columns(['ExternalKey']);
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
