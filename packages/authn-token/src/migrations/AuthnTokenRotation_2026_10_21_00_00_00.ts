import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

const TABLE = 'rbac_access_tokens';

/** Keeps the secret a rotation replaced until PreviousValidUntil. */
@Migration('default')
export class AuthnTokenRotation_2026_10_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().alterTable(TABLE, (table) => {
      table.string('PreviousToken', 64);
      table.dateTime('PreviousValidUntil');
    });

    await connection.index().unique().table(TABLE).name('access_token_previous_hash_idx').columns(['PreviousToken']);
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}
