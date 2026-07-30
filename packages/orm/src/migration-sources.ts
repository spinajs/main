import { Configuration, normalizeEnvironment } from '@spinajs/configuration-common';
import { AsyncService, Autoinject, Class, ClassInfo, DI, Injectable } from '@spinajs/di';
import { Log, Logger } from '@spinajs/log-common';
import glob from 'glob';
import _ from 'lodash';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extractMigrationDescriptor } from './descriptor.js';
import { OrmException } from './exceptions.js';
import { OrmMigration } from './interfaces.js';
import { MIGRATION_DI_SOURCE } from './migration-environment.js';
import { MIGRATION_FILE_REGEXP } from './symbols.js';

/**
 * Fallback for `system.dirs.migrations` when that key is absent or empty - see the comment on it
 * in `config/orm.ts` for why the defaults live here rather than shipping in the config value
 * itself. One entry per format-independent build layout a project might have been compiled to; a
 * migration reachable through more than one resolves to the same class name twice and is deduped
 * by `Orm`.
 *
 * `lib/migrations` alone used to stand in for "the compiled layout", but every package in this
 * repo compiles to `lib/cjs` and `lib/mjs` - there is no bare `lib/migrations` anywhere spinajs
 * itself produces, which made the filesystem source a silent no-op for a deployment built the
 * spinajs way. `build/migrations` and bare `migrations` are added alongside the original three
 * rather than replacing them, so an existing `src/lib/dist` layout keeps working unchanged.
 *
 * `lib/cjs/migrations` and `lib/mjs/migrations` are deliberately NOT in this list, even though
 * they are exactly such a build layout: they are the SAME source compiled twice into two module
 * formats, only one of which the running process can ever load - every package here ships
 * `"type": "module"` with no `package.json` written into `lib/cjs`, so Node parses `lib/cjs/*.js`
 * as ESM and a bare import of it throws (by design - see the `.js`-failure-throws comment below).
 * Scanning both unconditionally turned the sibling this runtime cannot load into a hard boot
 * failure the moment a package actually shipped both builds. `currentBuildMigrationDir()` below
 * picks the one that matches the current runtime instead, mirroring how
 * `@spinajs/configuration`'s `BaseFileSource` already picks ONE of its own dual-build config globs
 * off the same DI flag (`packages/configuration/src/sources.ts`).
 */
export const DEFAULT_MIGRATION_DIRS: string[] = ['src', 'lib', 'dist', 'build', '.'].map((d) => path.resolve(path.normalize(path.join(process.cwd(), d, 'migrations'))));

/**
 * Whether the current process is running under `@spinajs/di`'s ESM mode.
 *
 * `DI.setESMModuleSupport()` (`packages/di/src/root.ts`) registers `{ mjs: true }` - an object, not
 * a bare boolean - under `__esmMode__`, and `DI.__spinajs_require__` itself reads it back as
 * `isESM && isESM.mjs`. A consumer that never called `setESMModuleSupport()` leaves the value
 * unregistered (`DI.get` returns `null`), which this treats the same way `__spinajs_require__`
 * does: fall back to CJS.
 */
function isESMRuntime(): boolean {
  const flag = DI.get<{ mjs?: boolean } | boolean>('__esmMode__');
  return typeof flag === 'boolean' ? flag : Boolean(flag?.mjs);
}

/**
 * The one directory, of `lib/cjs/migrations` and `lib/mjs/migrations`, that the CURRENTLY RUNNING
 * process can actually import migrations from - see the comment on `DEFAULT_MIGRATION_DIRS` for
 * why the other one is never scanned at all rather than scanned-and-tolerated.
 */
export function currentBuildMigrationDir(): string {
  return path.resolve(path.normalize(path.join(process.cwd(), 'lib', isESMRuntime() ? 'mjs' : 'cjs', 'migrations')));
}

/**
 * `env` ( normalized `process.env.APP_ENV` ) is interpolated straight into a glob pattern in
 * `FilesystemMigrationSource.getMigrations()` - a plain identifier-ish token only, so it cannot
 * carry glob metacharacters (`{`, `[`, `!`, `*`, a path separator, ...) into a pattern nobody wrote.
 */
export const SAFE_ENV_NAME_REGEXP = /^[A-Za-z0-9_-]+$/;

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
    // ships empty for exactly this reason, see `config/orm.ts`. The format-specific build dir is
    // computed here rather than folded into `DEFAULT_MIGRATION_DIRS` itself: which one applies
    // depends on the `__esmMode__` DI flag, which is not knowable at module-load time and can
    // change between calls in a test process that flips it.
    //
    // Whether this scan is running over a directory the OPERATOR named, or one we guessed, is
    // carried down to the `.js`-import-failure handler below rather than recomputed there: it is
    // the same "configured vs fallback" split as the line above, and re-deriving it from `dirs`
    // itself later would have to somehow tell "the operator configured exactly the default list"
    // apart from "nothing was configured" - which is not recoverable once the two are merged.
    const isConfigured = configured.length > 0;
    const dirs = isConfigured ? configured : [...DEFAULT_MIGRATION_DIRS, currentBuildMigrationDir()];

    const env = normalizeEnvironment(this.Configuration.get<string>('process.env.APP_ENV', undefined));

    // `env` is interpolated straight into the glob below - an APP_ENV containing `{`, `[`, `!`,
    // `*` or a path separator would stop being a literal tag and become pattern syntax, silently
    // matching zero files (or the wrong ones) instead of the ones this environment owns. Refused
    // rather than escaped: a deployment whose APP_ENV cannot be a plain identifier has a bigger
    // problem than this scan, and failing loudly here is what surfaces it.
    if (!SAFE_ENV_NAME_REGEXP.test(env)) {
      throw new OrmException(`APP_ENV '${env}' is not a plain identifier ( letters, digits, '_' or '-' only ) and cannot be used to build the migration discovery glob safely - refusing to scan rather than silently matching the wrong files.`);
    }

    // `!(*.*)` - a basename with no dot at all, so it also excludes `*.d.ts` for free. `cjs` and
    // `mjs` join `ts`/`js` because that is what this source's own default directories
    // ( `lib/cjs/migrations`, `lib/mjs/migrations` ) actually contain - the same extension set
    // `@spinajs/configuration`'s own config-file loader recognizes.
    const patterns = ['/**/!(*.*).{ts,js,cjs,mjs}', `/**/*.${env}.{ts,js,cjs,mjs}`];

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

        // a compiled migration ( `.js` - the only other extension the glob above ever emits ) that
        // fails to import is not the same case as a `.ts` casualty above - a syntax error, a broken
        // relative import, a module body that throws. Whether that is tolerated now depends on WHO
        // named this directory:
        //
        // - a CONFIGURED directory is one the operator wrote into `system.dirs.migrations`
        //   themselves. A file in it that will not load is their bug, in a place they told us to
        //   look - swallowing it down to a warning would let discovery report "no pending
        //   migrations" and let a deployment proceed against an unmigrated schema, so this case is
        //   not tolerated: throw, with the original error chained so the stack survives.
        // - a FALLBACK directory is one WE guessed ( `DEFAULT_MIGRATION_DIRS`, or the build dir
        //   `currentBuildMigrationDir()` picks ). Nobody asked us to scan it, so a file in it that
        //   fails to import is not our place to kill the boot over - warn loudly, naming the file
        //   and the fact that it was NOT registered, and move on to the rest of the scan.
        if (isConfigured) {
          throw new OrmException(`Could not load migration file ${file}`, undefined, undefined, undefined, err);
        }

        this.Log.warn(err as Error, `Could not load migration file ${file} from a fallback migration directory - this migration was NOT registered`);
        continue;
      }

      for (const [name, exported] of Object.entries(module)) {
        if (typeof exported !== 'function' || !(exported.prototype instanceof OrmMigration)) {
          continue;
        }

        const className = (exported as Class<OrmMigration>).name || name;

        // The same anchor `parseMigrationFileEnv` reads a file's own tag through: a class whose
        // name carries no `_yyyy_MM_dd_HH_mm_ss` timestamp is not a migration, however it got
        // harvested - a shared abstract base class living directly in a scanned directory
        // (`BaseSeedMigration.ts`), or a barrel (`index.ts`) that re-exports one from elsewhere.
        // Without this gate, `Orm.registerMigration` throws on it later, naming this FILE - the
        // barrel or the base class's own file, never a migration anyone meant to register - and
        // takes the whole boot down. Skipped here instead, at trace.
        if (!MIGRATION_FILE_REGEXP.test(className)) {
          this.Log.trace(`${file} exports ${className}, which extends OrmMigration but carries no _yyyy_MM_dd_HH_mm_ss timestamp - not a migration, skipped`);
          continue;
        }

        result.push({ file, name: className, type: exported as Class<OrmMigration> });
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
      // chain-walking is fine here without being load-bearing: every entry in `__migrations__` is
      // a class `@Migration()` was applied to directly, so "chain" and "own" always agree - see
      // the note on `extractMigrationDescriptor`.
      const descriptor = extractMigrationDescriptor(type);

      return { file: descriptor?.SourceFile ?? MIGRATION_DI_SOURCE, name: type.name, type };
    });
  }
}
