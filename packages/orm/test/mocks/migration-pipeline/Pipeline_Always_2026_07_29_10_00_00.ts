import { Migration } from '../../../src/decorators.js';
import { OrmDriver } from '../../../src/driver.js';
import { OrmMigration } from '../../../src/interfaces.js';

// Unsuffixed - every environment. Decorated (unlike the fixtures under `migration-env/`) so this
// fixture set can prove the pipeline end to end: `Migration.status()` only reports a migration
// whose `@Migration()` names a real connection - see `MigrationRunner.plan()`.
@Migration('sqlite')
export class Pipeline_Always_2026_07_29_10_00_00 extends OrmMigration {
  public async up(_connection: OrmDriver): Promise<void> {}
  public async down(_connection: OrmDriver): Promise<void> {}
}
