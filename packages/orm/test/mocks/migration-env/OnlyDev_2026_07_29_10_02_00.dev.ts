import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('OnlyDev_2026_07_29_10_02_00.dev.ts');

export class OnlyDev_2026_07_29_10_02_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
