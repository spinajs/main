import { OrmMigration, OrmDriver, Migration } from '@spinajs/orm';

@Migration('default')
export class AuthnTokenRotation_2026_10_21_00_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}

  public async down(_connection: OrmDriver): Promise<void> {}
}
