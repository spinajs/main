import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { effectiveManifestOf } from '@spinajs/configuration';
import { Autoinject, Class, ClassInfo, Container, IContainer, Injectable } from '@spinajs/di';
import { inScanOrder, listFromManifest } from '@spinajs/reflection';
import { OrmMigration } from './interfaces.js';
import { parseMigrationFileEnv } from './migration-environment.js';
import { MigrationSource } from './migration-sources.js';
import { MIGRATION_FILE_REGEXP } from './symbols.js';

/**
 * Migrations listed in `app.manifest.json`. Empty when the effective manifest mode is `off`, or `prefer` without a
 * registered manifest; `require` without one throws.
 *
 * Like the directory scan it never imports a file suffixed for another environment: importing fires `@Migration`.
 * The remaining environment filter stays in `Orm.discoverMigrations()`.
 *
 * The list is in the directory scan's order: unsuffixed files first, then the environment's, each sorted as `glob` does.
 * `spinajs build` decided what the manifest loads; `system.dirs.migrations` narrows nothing here.
 */
@Injectable(MigrationSource)
export class ManifestMigrationSource extends MigrationSource {
  @Autoinject(Container)
  protected Container!: IContainer;

  @Autoinject()
  protected Configuration!: Configuration;

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const effective = effectiveManifestOf(this.Container);
    if (!effective || effective.settings.mode === 'off') {
      return [];
    }

    const env = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));
    const listed = await listFromManifest(this.Container, 'migrations', (entry) => {
      const fileEnv = parseMigrationFileEnv(entry.source.file);
      return fileEnv === undefined || fileEnv === env;
    });

    const migrations = (listed ?? [])
      .map((ci) => ({ file: ci.file, name: ci.name, type: ci.type as Class<OrmMigration> }))
      .filter((ci) => ci.type.prototype instanceof OrmMigration && MIGRATION_FILE_REGEXP.test(ci.name));

    return inScanOrder(migrations, (ci) => (parseMigrationFileEnv(ci.file) === undefined ? 0 : 1));
  }
}
