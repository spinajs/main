import { Migration, OrmMigration, OrmDriver } from '@spinajs/orm';

@Migration('default', { Env: 'test' })
export class Posts_2026_01_01_00_00_00 extends OrmMigration {
  public async up(_: OrmDriver): Promise<void> {}
  public async down(_: OrmDriver): Promise<void> {}
}
