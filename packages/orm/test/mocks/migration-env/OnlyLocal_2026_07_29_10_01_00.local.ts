import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

((globalThis as unknown as Record<string, string[]>).__migrationSideEffects__ ??= []).push('OnlyLocal_2026_07_29_10_01_00.local.ts');

export class OnlyLocal_2026_07_29_10_01_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
