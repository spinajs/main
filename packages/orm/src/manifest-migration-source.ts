import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { effectiveManifestOf } from '@spinajs/configuration';
import { Autoinject, Class, ClassInfo, Container, IContainer, Injectable } from '@spinajs/di';
import { inScanOrder, listFromManifest, ManifestMissing } from '@spinajs/reflection';
import { OrmMigration } from './interfaces.js';
import { parseMigrationFileEnv } from './migration-environment.js';
import { DiRegistryMigrationSource, MigrationSource } from './migration-sources.js';
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
    const wanted = new Set<string>();
    const listed = await listFromManifest(this.Container, 'migrations', (entry) => {
      const fileEnv = parseMigrationFileEnv(entry.source.file);
      const included = fileEnv === undefined || fileEnv === env;
      if (included && entry.className) wanted.add(entry.className);
      return included;
    });

    const migrations = (listed ?? [])
      .map((ci) => ({ file: ci.file, name: ci.name, type: ci.type as Class<OrmMigration> }))
      .filter((ci) => ci.type.prototype instanceof OrmMigration && MIGRATION_FILE_REGEXP.test(ci.name));

    // A migration no module exports has only its @Migration registration, which ran during the listing above: after
    // DiRegistryMigrationSource read the registry, as sources run in turn and this one is registered last.
    const registered = await new DiRegistryMigrationSource().getMigrations();
    const unexported = registered.filter((m) => wanted.has(m.name) && !listed?.some((l) => l.name === m.name));

    // A name that is neither is a stale manifest; running without that migration must not pass in silence.
    const known = new Set([...(listed ?? []).map((l) => l.name), ...unexported.map((m) => m.name)]);
    const missing = [...wanted].filter((name) => !known.has(name));
    if (missing.length > 0) {
      throw new ManifestMissing(`migrations ${missing.join(', ')} are listed in the manifest, but importing their files neither exports nor registers them: rebuild the manifest ( spinajs build )`);
    }

    return inScanOrder([...migrations, ...unexported], (ci) => (parseMigrationFileEnv(ci.file) === undefined ? 0 : 1));
  }
}
