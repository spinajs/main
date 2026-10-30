import * as fs from 'fs';
import * as path from 'path';
import _ from 'lodash';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncService, Class, ClassInfo, DI, IContainer } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';
import { Log } from '@spinajs/log-common';
import { InternalLoggerProxy } from '@spinajs/internal-logger';

export * from 'typescript-mix';
export * from './manifest.js';
import { listFromManifest, MANIFEST_SECTIONS, resolveListed } from './manifest.js';
import { manifestOf, manifestSettingsOf } from '@spinajs/configuration';
import type { ListOptions } from './manifest.js';

/**
 * Exception thrown when some error during reflection occurs
 */
export class ReflectionException extends Exception {}

const NO_SETTINGS = {};

/** Imported on the first directory scan, so importing reflection or listing from the manifest does not load it. */
async function loadGlob(configPath: string): Promise<typeof import('glob')> {
  try {
    return (await import('glob')).default;
  } catch (err) {
    if ((err as { code?: string }).code === 'ERR_MODULE_NOT_FOUND' && String((err as Error).message).includes("'glob'")) {
      throw new ReflectionException(`Scanning the directories of ${configPath} needs the optional peer dependency \`glob\`: install it, or list from the manifest ( system.manifest.mode )`, err);
    }
    throw err;
  }
}

/**
 * Returns resolved instances of classes from specified files.
 * It automatically checks if should resolve promise or not, calls resolve strategy, checks if should return new or signleton etc, resolves
 * dependencies etc.
 *
 * @param filter - files to look at, uses glob pattern to search
 * @param configPath - dir paths taken from app config eg. "system.dirs.controllers". Path MUST be avaible in configuration
 * @param options - `manifest`: the manifest section to list instead of scanning. Without it, `configPath` picks the
 *   section through `MANIFEST_SECTIONS`, but only when no `typeMatcher` is given: the manifest names each class, so a
 *   matcher would be ignored.
 *
 * The scanned dirs come from the root container's Configuration; the manifest and its effective mode from the
 * decorated instance's container lineage. The result is cached per decorated property and effective manifest
 * settings, so an app booted with another mode lists again.
 */
export function ResolveFromFiles(filter: string, configPath: string, typeMatcher?: (fileName: string, exportName: string) => string, options: ListOptions = {}) {
  return _listOrResolveFromFiles(filter, configPath, false, typeMatcher, options);
}

/** Like `ResolveFromFiles`, without resolving the classes. */
export function ListFromFiles(filter: string, configPath: string, typeMatcher?: (fileName: string, exportName: string) => string, options: ListOptions = {}) {
  return _listOrResolveFromFiles(filter, configPath, true, typeMatcher, options);
}

function _listOrResolveFromFiles(
  filter: string,
  configPath: string,
  noResolve: boolean,
  typeMatcher?: (fileName: string, exportName: string) => string,
  options: ListOptions = {},
) {
  return (target: any, propertyKey: string | symbol) => {
    _check_arg(_is_string(), _non_empty())(filter, 'filter');
    _check_arg(_is_string(), _non_empty())(configPath, 'configPath');

    // Keyed by the settings' content and the loaded manifest: every app registers its own settings object, and an
    // identity key would make a second app with the same mode re-resolve what the first one already listed.
    const cache = new Map<string, WeakMap<object, Promise<Array<ClassInfo<any>>>>>();

    const getter = function (this: { Container?: IContainer } | undefined) {
      const owner = this?.Container;
      const container = owner ?? DI.RootContainer;
      const settingsKey = JSON.stringify(manifestSettingsOf(container) ?? null);
      let byManifest = cache.get(settingsKey);
      if (!byManifest) {
        byManifest = new WeakMap();
        cache.set(settingsKey, byManifest);
      }
      const manifestKey = manifestOf(container) ?? NO_SETTINGS;
      let instances = byManifest.get(manifestKey);
      if (!instances) {
        instances = _loadInstances(owner);
        byManifest.set(manifestKey, instances);
      }

      return instances;
    };

    Object.defineProperty(target, propertyKey, {
      enumerable: true,
      get: getter,
    });

    async function _loadInstances(owner: IContainer | undefined): Promise<Array<ClassInfo<any>>> {
      const config = DI.get(Configuration);
      if (!config) {
        throw new ReflectionException(`Cannot scan files for ${configPath}: Configuration is not resolved, call DI.resolve(Configuration) first`);
      }

      // resolving the abstract Log from log-common only works when some loaded
      // module has registered an implementation ( importing @spinajs/log does
      // that as a side effect ) — this package cannot import it itself due to a
      // tsconfig reference cycle, so fall back to the pre-logger proxy
      const logger = DI.check(Log) ? DI.resolve(Log, ['reflection']) : DI.resolve(InternalLoggerProxy, ['reflection']);

      const section = options.manifest ?? (typeMatcher ? undefined : MANIFEST_SECTIONS[configPath]);
      if (section) {
        const container = owner ?? DI.RootContainer;
        const listed = await listFromManifest(container, section);
        if (listed) {
          return noResolve ? listed : resolveListed(listed, (err, ci) => logger.error({ error: err, type: ci.name, file: ci.file }, 'Cannot resolve type ${type} from file ${file}'));
        }
      }

      let directories = config.get<string[]>(configPath);

      if (!directories || directories.length === 0) {
        return [];
      }

      if (!Array.isArray(directories)) {
        directories = [directories];
      }

      const glob = await loadGlob(configPath);

      // eslint-disable -next-line @typescript-eslint/await-thenable
      const fPromises = _.uniq(directories)
        .filter((d: string) => {
          /* eslint-disable */
          const exists = fs.existsSync(path.normalize(d));
          if (!exists) {
            logger.warn({ directory: d }, 'Directory ${directory} not exists');
          }
          return exists;
        })
        .flatMap((d: string) => glob.sync(path.join(d, filter).replace(/\\/g, '/')))
        .flatMap((f: string) => {
          logger.trace({ file: f }, 'Loading file ${file}');

          return DI.__spinajs_require__(f).then((loaded: any) => {
            // __spinajs_require__ unwraps a default export to the class itself
            const fTypes = typeof loaded === 'function' ? { [loaded.name]: loaded } : loaded;
            const _k = Object.keys(fTypes);
            if (_k.length === 0) {
              logger.warn({ file: f }, 'File ${file} does not contain any exported type !');
              return null;
            }

            const seen = new Set<unknown>();
            const found: Array<Promise<ClassInfo<any> | null>> = [];

            for (const key of _k) {
              const nameToResolve = typeMatcher ? typeMatcher(path.parse(f).name, key) : key;
              const type = fTypes[`${nameToResolve}`] as Class<any>;

              // constants and arrow functions cannot be classes; a class exported under
              // two names, or picked by a typeMatcher for every key, is listed once
              if (typeof type !== 'function' || !type.prototype || seen.has(type)) {
                continue;
              }
              seen.add(type);

              if (noResolve) {
                found.push(
                  Promise.resolve({
                    file: f,
                    name: nameToResolve,
                    instance: undefined,
                    type,
                  }),
                );
                continue;
              }

              try {
                if (type.prototype instanceof AsyncService) {
                  found.push(
                    (DI.resolve(type) as any).then(
                      (instance: any) => {
                        return {
                          file: f,
                          instance,
                          name: nameToResolve,
                          type,
                        };
                      },
                      (err: unknown) => {
                        logger.error({ error: err, type: nameToResolve, file: f }, 'Cannot resolve type ${type} from file ${file}');
                        return null;
                      },
                    ),
                  );
                  continue;
                }

                found.push(
                  Promise.resolve({
                    file: f,
                    instance: DI.resolve(type),
                    name: nameToResolve,
                    type,
                  }),
                );
              } catch (err) {
                logger.error({ error: err, type: nameToResolve, file: f }, 'Cannot resolve type ${type} from file ${file}');
              }
            }

            return Promise.all(found);
          });
        });

      return Promise.all(fPromises).then((x) => x.flat().filter((i) => i !== null && i !== undefined));
    }
  };
}
