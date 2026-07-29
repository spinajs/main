import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

// records that this module was EXECUTED - the sharpest assertion in migration-sources.test.ts is
// that a foreign-environment migration is never even imported
((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('Always_2026_07_29_10_00_00.ts');

export class Always_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
