import { Migration } from '../../../src/decorators.js';
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

// `.local`-suffixed - APP_ENV=local only.
@Migration('sqlite')
export class Pipeline_OnlyLocal_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
