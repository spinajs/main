import * as fs from 'fs';
import glob from 'glob';
import * as path from 'path';
import ts from 'typescript';
import _ from 'lodash';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncService, Class, ClassInfo, DI, IContainer } from '@spinajs/di';
import { Exception } from '@spinajs/exceptions';
import { _check_arg, _is_string, _non_empty } from '@spinajs/util';
import { Log } from '@spinajs/log-common';
import { InternalLoggerProxy } from '@spinajs/internal-logger';

export * from 'typescript-mix';
export * from './manifest.js';
import { listFromManifest, MANIFEST_SECTIONS, manifestMode, resolveListed } from './manifest.js';
import type { ListOptions } from './manifest.js';

/**
 * Exception thrown when some error during reflection occurs
 */
export class ReflectionException extends Exception {}

/**
 * Helper class for extracting various information from typescript source code
 */
export class TypescriptCompiler {
  private tsFile: string;

  private compiled: ts.Program;

  constructor(filename: string) {
    this.tsFile = filename;

    this.compiled = ts.createProgram([this.tsFile], {
      module: ts.ModuleKind.NodeNext,
      target: ts.ScriptTarget.Latest,
    });
  }

  /**
   *
   * Extracts all members info from typescript class eg. method name, parameters, return types etc.
   *
   * @param className - name of class to parse
   */
  public getClassMembers(className: string): Map<string, any> {
    const members: Map<string, ts.MethodDeclaration> = new Map<string, ts.MethodDeclaration>();

    const sourceFile = this.compiled.getSourceFile(this.tsFile);

    // Walk the tree to search for classes
    ts.forEachChild(
      sourceFile!,
      this.walkClassNode(
        className,
        this.walkMemberNode((method: ts.MethodDeclaration) => {
          // the program has no parent pointers, so getText() needs the source file passed in
          const name = ts.isComputedPropertyName(method.name) ? method.name.getText(sourceFile) : method.name.text;
          members.set(name, method);
        }),
      ),
    );

    return members;
  }

  private walkClassNode(className: string, callback: (classNode: ts.ClassDeclaration) => void) {
    return (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.ClassDeclaration) {
        const cldecl = node as ts.ClassDeclaration;
        if (cldecl.name?.text === className) {
          callback(cldecl);
        }
      }
    };
  }

  private walkMemberNode(callback: (methodNode: ts.MethodDeclaration) => void) {
    return (node: ts.ClassDeclaration) => {
      for (const member of node.members) {
        if (member.kind === ts.SyntaxKind.MethodDeclaration) {
          const method = member as ts.MethodDeclaration;
          callback(method);
        }
      }
    };
  }
}

/**
 * Returns resolved instances of classes from specified files.
 * It automatically checks if should resolve promise or not, calls resolve strategy, checks if should return new or signleton etc, resolves
 * dependencies etc.
 *
 * @param filter - files to look at, uses glob pattern to search
 * @param configPath - dir paths taken from app config eg. "system.dirs.controllers". Path MUST be avaible in configuration
 *
 */
export function ResolveFromFiles(filter: string, configPath: string, typeMatcher?: (fileName: string, exportName: string) => string, options: ListOptions = {}) {
  return _listOrResolveFromFiles(filter, configPath, false, typeMatcher, options);
}

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

    let instances: Array<ClassInfo<any>> | Promise<Array<ClassInfo<any>>> | null = null;

    const getter = function (this: { Container?: IContainer } | undefined) {
      if (!instances) {
        instances = _loadInstances(this?.Container);
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

      const section = options.manifest ?? MANIFEST_SECTIONS[configPath];
      if (section) {
        const container = owner ?? DI.RootContainer;
        const listed = await listFromManifest(container, section, manifestMode(container));
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
