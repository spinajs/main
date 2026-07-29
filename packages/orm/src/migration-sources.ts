import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { AsyncService, Autoinject, Class, ClassInfo, DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import glob from 'glob';
import _ from 'lodash';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { OrmException } from './exceptions.js';
import { IMigrationDescriptor, OrmMigration } from './interfaces.js';
import { MIGRATION_DI_SOURCE } from './migration-environment.js';
import { MIGRATION_DESCRIPTION_SYMBOL } from './symbols.js';

/**
 * Fallback for `system.dirs.migrations` when that key is absent or empty - see the comment on it
 * in `config/orm.ts` for why the defaults live here rather than shipping in the config value
 * itself. One entry per build layout a project might have been compiled to; a migration reachable
 * through more than one resolves to the same class name twice and is deduped by `Orm`.
 */
export const DEFAULT_MIGRATION_DIRS: string[] = ['src', 'lib', 'dist'].map((d) => path.resolve(path.normalize(path.join(process.cwd(), d, 'migrations'))));

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
    const configured = this.Configuration.get<string[]>('system.dirs.migrations', []) ?? [];

    // a configured value REPLACES the defaults rather than adding to them - the config key itself
    // ships empty for exactly this reason, see `config/orm.ts`
    const dirs = configured.length > 0 ? configured : DEFAULT_MIGRATION_DIRS;

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
        if (path.extname(file) === '.ts') {
          // reachable in normal operation: the default directories include `src/migrations`, so a
          // compiled deployment tries the `.ts` copy of every migration and fails to import under
          // a plain JS runtime. The `.js` copy is found by the same scan, so this is routine, not
          // a problem - throwing would make a shipped default take the boot down
          this.Log.trace(`Could not load migration file ${file}: ${(err as Error).message}`);
          continue;
        }

        // a compiled migration ( `.js` / `.cjs` / `.mjs` ) that fails to import is not the same
        // case - a syntax error, a broken relative import, a module body that throws. Swallowing
        // it down to a warning would let discovery report "no pending migrations" and let a
        // deployment proceed against an unmigrated schema, so this one is not tolerated: throw
        // with the original error chained so the stack survives
        throw new OrmException(`Could not load migration file ${file}`, undefined, undefined, undefined, err);
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
