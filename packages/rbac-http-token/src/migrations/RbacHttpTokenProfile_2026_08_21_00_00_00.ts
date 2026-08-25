/* eslint-disable @typescript-eslint/no-unused-vars */
import { OrmMigration, OrmDriver, Migration, RawQuery } from '@spinajs/orm';

@Migration('default')
export class RbacHttpTokenProfile_2026_08_21_00_00_00 extends OrmMigration {
  public async up(connection: OrmDriver): Promise<void> {
    await connection.schema().raw(new RawQuery('ALTER TABLE rbac_access_tokens ADD COLUMN Profile VARCHAR(128) NULL'));
  }

  public async down(connection: OrmDriver): Promise<void> {
    await connection.schema().raw(new RawQuery('ALTER TABLE rbac_access_tokens DROP COLUMN Profile'));
  }
}
