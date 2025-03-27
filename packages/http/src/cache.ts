import _ from 'lodash';
import { Autoinject, ClassInfo } from '@spinajs/di';
import { TypescriptCompiler, ListFromFiles } from '@spinajs/reflection';
import { fs as fFs, FileHasher, FileSystem } from '@spinajs/fs';
import { BaseController } from './controllers.js';
import { Logger, Log } from '@spinajs/log';

/**
 *
 * We store parameter info in cache files
 * Parsing ts files is slow.
 *
 * We do this becouse ts is not providing parameter names from functions - data is lost during runtime
 * And we need this for proper parameter assignment in controller routes
 *
 */
export class DefaultControllerCache {
  @Logger('http')
  protected Log: Log;

  /**
   * Loaded controllers
   */
  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  public Controllers: Promise<Array<ClassInfo<BaseController>>>;

  /**
   * File system for temporary files for storing controllers cache
   */
  @FileSystem('__fs_controller_cache__')
  protected CacheFS: fFs;

  @Autoinject(FileHasher)
  protected Hasher: FileHasher;

  public async getCache(controller: ClassInfo<BaseController>) {
    const file = controller.file.replace('.js', '.d.ts');
    const hash = await this.Hasher.hash(file);

    const exists = await this.CacheFS.exists(hash);
    if (!exists) {
      this.Log.warn(`Controller cache not exists for ${controller.name}, regenerating cache ...`);
      await this.generate();
    }

    return await this.CacheFS.read(hash).then((x: string) => JSON.parse(x));
  }

  public async generate() {
    const controllers = await this.Controllers;

    for (const controller of controllers) {
      const file = controller.file.replace('.js', '.d.ts');
      const hash = await this.Hasher.hash(file);
      let parameters: {
        [key: string]: string[];
      } = {};

      const exists = await this.CacheFS.exists(hash);
      if (!exists) {
        this.Log.trace(`Controller cache not exists for ${controller.name}, generating cache...`);

        const compiler = new TypescriptCompiler(file);
        const members = compiler.getClassMembers(controller.name);
        members.forEach((v, k) => {
          v.parameters.forEach((p: any) => {
            if (!parameters[k]) {
              parameters[k] = [];
            }

            parameters[k][v.parameters.indexOf(p)] = p.name.text;
          });
        });

        await this.CacheFS.write(hash, JSON.stringify(parameters));

        this.Log.trace(`Ending generating controller cache for ${controller.name}`);
      }
    }
  }
}
