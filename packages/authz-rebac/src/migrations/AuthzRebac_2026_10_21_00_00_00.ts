import { AUTHZ_CONNECTION } from '@spinajs/authz';
import { Migration, OrmDriver, OrmMigration } from '@spinajs/orm';

/** `authz_rebac_tuple` (design §5.2). */
@Migration(AUTHZ_CONNECTION)
export class AuthzRebac_2026_10_21_00_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {
    throw new Error('not implemented: AuthzRebac_2026_10_21_00_00_00.up');
  }

  public async down(_connection: OrmDriver): Promise<void> {
    throw new Error('not implemented: AuthzRebac_2026_10_21_00_00_00.down');
  }
}
