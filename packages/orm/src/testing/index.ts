// the package entry first: its module graph only initialises without a TDZ when it is the load root
import '../index.js';
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
 * runs `npx spinajs migrate-up` instead. Call it before anything else resolves the Orm or `OrmMigrator` in `container`,
 * or it throws.
 */
export async function migrateTestDatabase(container: IContainer = DI.RootContainer, options: IMigrateTestDatabaseOptions = {}): Promise<IMigratedTestDatabase> {
  // the raw variables: normalizeEnvironment() reads an unset APP_ENV as prod, which every test process has
  if (process.env.NODE_ENV === 'production' || ['prod', 'production'].includes(process.env.APP_ENV ?? '')) {
    throw new OrmException('migrateTestDatabase() is a test helper and refuses to run with NODE_ENV or APP_ENV production: run "npx spinajs migrate-up" as a deploy step');
  }

  const migrator = await resolveMigrationTool(container);
  const orm = await container.resolve(Orm);

  // a cached OrmMigrator keeps the options it was first resolved with, and a cached Orm the migrator it booted with
  if (migrator.MigrateOnStartup || orm.Migrator !== migrator) {
    throw new OrmException(
      'migrateTestDatabase() must run before anything resolves the Orm or OrmMigrator in this container, and a re-run needs Orm and OrmMigrator uncached together ( or DI.clearCache() ): the Orm here was booted by an OrmMigrator that migrates on startup, or by another OrmMigrator than the one this call resolved',
    );
  }

  const executed = await migrator.migrate({ skipSeed: options.seed === false });

  // the tool Orm skipped its boot table check, so it is made here, after the tables exist
  if (orm.StrictTableCheck) {
    await orm.reloadTableInfo({ strict: true });
  }

  return { orm, migrator, executed };
}
