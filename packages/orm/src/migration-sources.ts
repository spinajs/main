import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { AsyncService, Autoinject, Class, ClassInfo, DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import glob from 'glob';
import _ from 'lodash';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IMigrationDescriptor, OrmMigration } from './interfaces.js';
import { MIGRATION_DI_SOURCE } from './migration-environment.js';
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';

/**
 * Supplies migration types to `Orm`.
 *
 * Sources only DISCOVER migrations ( type + origin file ) - they never construct or run them.
 * `Orm` merges every registered source, resolves each migration's environment, dedupes and
 * registers what is left.
 *
 * To plug in another discovery mechanism ( a plugin manifest, a remote registry ) implement this
 * class and decorate it `@Injectable(MigrationSource)`.
 */
export abstract class MigrationSource extends AsyncService {
  public abstract getMigrations(): Promise<Array<ClassInfo<OrmMigration>>>;
}

/**
 * Discovers migrations by scanning the directories configured at `system.dirs.migrations`.
 *
 * Two globs per directory: unsuffixed files, which belong to every environment, and files carrying
 * this environment's tag. Files belonging to another environment are never MATCHED, and therefore
 * never imported - which is the whole point rather than an optimization. Importing a migration
 * fires its `@Migration` decorator, which registers the class into `__migrations__`, and
 * `DiRegistryMigrationSource` would then hand it back no matter what filter ran afterwards.
 *
 * This is also why `@ListFromFiles` from `@spinajs/reflection` is not used here: it imports
 * everything it lists, and its glob is fixed at decoration time while the environment is only
 * known at runtime.
 */
@Injectable(MigrationSource)
export class FilesystemMigrationSource extends MigrationSource {
  @Logger('ORM')
  protected Log: Log;

  @Autoinject()
  protected Configuration: Configuration;

  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const dirs = this.Configuration.get<string[]>('system.dirs.migrations', []) ?? [];

    if (dirs.length === 0) {
      return [];
    }

    const env = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));

    // `!(*.*)` - a basename with no dot at all, so it also excludes `*.d.ts` for free
    const patterns = ['/**/!(*.*).{ts,js}', `/**/*.${env}.{ts,js}`];

    const files = _.uniq(dirs)
      .filter((d) => {
        if (fs.existsSync(d)) {
          return true;
        }

        this.Log.trace(`Migration directory ${d} does not exist - skipped`);
        return false;
      })
      .flatMap((d) => patterns.flatMap((p) => glob.sync(path.join(d, p).replace(/\\/g, '/'))))
      .map((f) => path.normalize(path.resolve(f)));

    const result: Array<ClassInfo<OrmMigration>> = [];

    // the same file is reachable from two configured directories ( `lib/migrations` and a path
    // that resolves to it ), and importing it twice would report the same class twice
    for (const file of _.uniq(files)) {
      this.Log.trace(`Loading migration file ${file}`);

      let module: Record<string, unknown>;

      try {
        module = (await DI.__spinajs_require__(file)) as Record<string, unknown>;
      } catch (err) {
        // reachable in normal operation: the default directories include `src/migrations`, so a
        // compiled deployment tries the `.ts` copy of every migration and fails. The `.js` copy is
        // found by the same scan, so warning and moving on is right - throwing would make a
        // shipped default take the boot down
        this.Log.warn(`Could not load migration file ${file}: ${(err as Error).message}`);
        continue;
      }

      for (const [name, exported] of Object.entries(module)) {
        if (typeof exported !== 'function' || !(exported.prototype instanceof OrmMigration)) {
          continue;
        }

        result.push({ file, name: (exported as Class<OrmMigration>).name || name, type: exported as Class<OrmMigration> });
      }
    }

    return result;
  }
}

/**
 * Discovers migrations registered in the DI container under `__migrations__` - which is what the
 * `@Migration` decorator does, so this covers every migration reached by IMPORT: a package
 * re-exporting its migrations from `index.ts`, a test declaring one inline, or a file this
 * process's `FilesystemMigrationSource` has just imported.
 *
 * The origin file is the path `@Migration` captured off the stack, and the sentinel
 * `MIGRATION_DI_SOURCE` when that capture came back empty.
 */
@Injectable(MigrationSource)
export class DiRegistryMigrationSource extends MigrationSource {
  public async getMigrations(): Promise<Array<ClassInfo<OrmMigration>>> {
    const types = (DI.getRegisteredTypes<OrmMigration>('__migrations__') ?? []) as Array<Class<OrmMigration>>;

    return types.map((type) => {
      const descriptor = (type as unknown as Record<symbol, IMigrationDescriptor | undefined>)[MIGRATION_DESCRIPTION_SYMBOL];

      return { file: descriptor?.SourceFile ?? MIGRATION_DI_SOURCE, name: type.name, type };
    });
  }
}
