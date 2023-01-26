import { OrmMigration, Migration } from '../../../src/index.js';
import { OrmDriver } from '../../../src/driver.js';

@Migration('sqlite')
// @ts-ignore
export class Migration2_2021_12_02_12_00_00 extends OrmMigration {
  // tslint:disable-next-line: no-empty
  public async up(_connection: OrmDriver): Promise<void> {}

  // tslint:disable-next-line: no-empty
  public async down(_connection: OrmDriver): Promise<void> {}
}
