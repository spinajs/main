import * as fs from 'fs';
import glob from 'glob';
import * as path from 'path';
import ts from 'typescript';
import _ from 'lodash';
import { Configuration } from '@spinajs/configuration-common';
import { AsyncService, Class, ClassInfo, DI } from '@spinajs/di';
import { InvalidArgument, Exception } from '@spinajs/exceptions';
import { Log } from '@spinajs/log-common';

export * from 'typescript-mix';

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
      sourceFile,
      this.walkClassNode(
        className,
        this.walkMemberNode((method: ts.MethodDeclaration) => {
          // method.name.getText() returns null ?
          // UGLY HACK FOR THIS
          // eslint-disable-next-line @typescript-eslint/no-unsafe-argument
          members.set((method.name as any).text, method);
        }),
      ),
    );

    return members;
  }

  private walkClassNode(className: string, callback: (classNode: ts.ClassDeclaration) => void) {
    return (node: ts.Node) => {
      if (node.kind === ts.SyntaxKind.ClassDeclaration) {
        const cldecl = node as ts.ClassDeclaration;
        if (cldecl.name.text === className) {
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
export function ResolveFromFiles(filter: string, configPath: string, typeMatcher?: (fileName: string) => string) {
  return _listOrResolveFromFiles(filter, configPath, typeMatcher);
}

function _listOrResolveFromFiles(
  filter: string,
  configPath: string,
  typeMatcher?: (fileName: string, type: string) => string,
) {
  return (target: any, propertyKey: string | symbol) => {
    if (!filter) {
      throw new InvalidArgument('filter parameter is null or empty');
    }

    if (!configPath) {
      throw new InvalidArgument('configPath parameter is null or empty');
    }

    let instances: Array<ClassInfo<any>> | Promise<Array<ClassInfo<any>>> = null;

    const getter = () => {
      if (!instances) {
        instances = _loadInstances();
      }

      return instances;
    };

    Object.defineProperty(target, propertyKey, {
      enumerable: true,
      get: getter,
    });

    async function _loadInstances(): Promise<Array<ClassInfo<any>>> {
      const config = DI.get(Configuration);
      const logger = DI.resolve(Log, ['reflection']);
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
            logger.warn(`Directory ${d} not exists`);
          }
          return exists;
        })
        .flatMap((d: string) => glob.sync(path.join(d, filter).replace(/\\/g, '/')))
        .flatMap((f: string) => {
          logger.trace(`Loading file ${f}`);

          return DI.__spinajs_require__(f).then((fTypes: any) => {
            for (const key of Object.keys(fTypes)) {
              const nameToResolve = typeMatcher ? typeMatcher(path.parse(f).name, key) : key;
              const type = fTypes[`${nameToResolve}`] as Class<any>;

              if (type.prototype instanceof AsyncService) {
                return (DI.resolve(type) as any).then((instance: any) => {
                  return {
                    file: f,
                    instance,
                    name: nameToResolve,
                    type,
                  };
                });
              }

              return Promise.resolve({
                file: f,
                instance: DI.resolve(type),
                name: nameToResolve,
                type,
              });
            }
          });
        });

      return Promise.all(fPromises);
    }
  };
}
