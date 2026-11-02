import { DI } from '@spinajs/di';
import { Migration } from '../../../src/decorators.js';
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';
import { Orm } from '../../../src/orm.js';

/** What ran, in order. The test never imports this file before the boot: only the manifest source does. */
export const SEEDED_RUNS: string[] = [];

@Migration('sqlite')
export class Seeded_2026_08_01_11_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {
    SEEDED_RUNS.push('up');
  }

  public async down(_connection: OrmDriver): Promise<void> {}

  public async data(): Promise<void> {
    SEEDED_RUNS.push(DI.get(Orm) ? 'data, Orm cached' : 'data, Orm not cached');
  }
}
