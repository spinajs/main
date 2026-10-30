import { Migration, OrmMigration } from '@spinajs/orm';
import type { OrmDriver } from '@spinajs/orm';

@Migration('default')
export class AppBasic_2026_10_27_00_00_00 extends OrmMigration {
  public async up(_: OrmDriver): Promise<void> {}
  public async down(_: OrmDriver): Promise<void> {}
}
