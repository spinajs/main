import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

/** `users.EmailVerifiedAt`: when the owner proved the address reached them; null: not verified. */
@Migration('default')
export class UsersAddressVerified_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable('users', (table) => {
      table.dateTime('EmailVerifiedAt');
    });
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
