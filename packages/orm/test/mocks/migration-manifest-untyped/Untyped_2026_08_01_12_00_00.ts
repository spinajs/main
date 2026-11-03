import { Autoinject } from '@spinajs/di';
import { Migration } from '../../../src/decorators.js';
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

export const UNTYPED_RUNS: string[] = [];

@Migration('sqlite')
export class Untyped_2026_08_01_12_00_00 extends OrmMigration {
  public service: unknown;

  public async up(_connection: OrmDriver): Promise<void> {
    UNTYPED_RUNS.push('up');
  }

  public async down(_connection: OrmDriver): Promise<void> {}
}

// Applied by hand: TypeScript emits `design:type` only for decorators it applies itself.
(Autoinject() as PropertyDecorator)(Untyped_2026_08_01_12_00_00.prototype, 'service');
