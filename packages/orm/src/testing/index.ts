// the package entry first: its module graph only initialises without a TDZ when it is the load root
import '../index.js';
import { DI, IContainer } from '@spinajs/di';
import { OrmException } from '../exceptions.js';
import { OrmMigration } from '../interfaces.js';
import { OrmMigrationGuard } from '../migration-guard.js';
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
 * runs `npx spinajs migrate-up` instead. Call it before anything else resolves the Orm or `OrmMigrationGuard` in
 * `container`, or it throws.
 */
export async function migrateTestDatabase(container: IContainer = DI.RootContainer, options: IMigrateTestDatabaseOptions = {}): Promise<IMigratedTestDatabase> {
  // the raw variables: normalizeEnvironment() reads an unset APP_ENV as prod, which every test process has
  if (process.env.NODE_ENV === 'production' || ['prod', 'production'].includes(process.env.APP_ENV ?? '')) {
    throw new OrmException('migrateTestDatabase() is a test helper and refuses to run with NODE_ENV or APP_ENV production: run "npx spinajs migrate-up" as a deploy step');
  }

  // a cached guard keeps the options it was first resolved with: an enabled one booted ( or will boot ) the Orm as an app
  if ((await container.resolve(OrmMigrationGuard, [{ Enabled: false }])).Enabled) {
    throw new OrmException(
      'migrateTestDatabase() must run before anything resolves the Orm or OrmMigrationGuard in this container ( or after Orm, OrmMigrator and OrmMigrationGuard were uncached together, or DI.clearCache() ): the boot guard here is enabled, so the Orm was booted as an application boots it',
    );
  }

  const migrator = await resolveMigrationTool(container);
  const orm = migrator.Orm;

  const executed = await migrator.migrate({ skipSeed: options.seed === false });

  // the tool Orm skipped its boot table check, so it is made here, after the tables exist
  if (orm.StrictTableCheck) {
    await orm.reloadTableInfo({ strict: true });
  }

  return { orm, migrator, executed };
}
