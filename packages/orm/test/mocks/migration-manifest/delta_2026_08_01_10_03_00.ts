import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

export class delta_2026_08_01_10_03_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
