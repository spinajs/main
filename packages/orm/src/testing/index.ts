import { DI, IContainer } from '@spinajs/di';
import { OrmException } from '../exceptions.js';
import { OrmMigration } from '../interfaces.js';
import { OrmMigrator } from '../migrator.js';
import { Orm, resolveMigrationTool } from '../orm.js';

export interface IMigrateTestDatabaseOptions {
  /** Run the applied migrations' `data()` seeds. Default true. */
  seed?: boolean;
}

export interface IMigratedTestDatabase {
  orm: Orm;
  migrator: OrmMigrator;
  executed: OrmMigration[];
}

/**
 * Explicitly migrates and seeds a test database, then checks the model tables as a strict boot would; an application
 * runs `npx spinajs migrate-up` instead. Call it before anything else resolves the Orm in `container`.
 */
export async function migrateTestDatabase(container: IContainer = DI.RootContainer, options: IMigrateTestDatabaseOptions = {}): Promise<IMigratedTestDatabase> {
  // the raw variables: normalizeEnvironment() reads an unset APP_ENV as prod, which every test process has
  if (process.env.NODE_ENV === 'production' || ['prod', 'production'].includes(process.env.APP_ENV ?? '')) {
    throw new OrmException('migrateTestDatabase() is a test helper and refuses to run with NODE_ENV or APP_ENV production: run "npx spinajs migrate-up" as a deploy step');
  }

  const migrator = await resolveMigrationTool(container);
  const orm = await container.resolve(Orm);

  // an Orm resolved before this call migrated on its own startup, and seeds after its resolve
  await migrator.ready();

  const executed = await migrator.migrate({ skipSeed: options.seed === false });

  // the tool Orm skipped its boot table check, so it is made here, after the tables exist
  if (orm.StrictTableCheck) {
    await orm.reloadTableInfo({ strict: true });
  }

  return { orm, migrator, executed };
}
