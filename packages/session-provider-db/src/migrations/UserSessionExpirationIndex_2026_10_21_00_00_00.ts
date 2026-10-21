import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

/** Lets the expired-session sweep read its rows by `Expiration` instead of scanning `user_sessions`. */
@Migration('session-provider-connection')
export class UserSessionExpirationIndex_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.index().table('user_sessions').name('user_sessions_expiration_idx').columns(['Expiration']);
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.index().table('user_sessions').name('user_sessions_expiration_idx').drop();
  }
}
