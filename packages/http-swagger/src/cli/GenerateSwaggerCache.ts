import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { ClassInfo, DI } from '@spinajs/di';
import { effectiveManifestOf } from '@spinajs/configuration';
import { fsService } from '@spinajs/fs';
import { ListFromFiles, SCAN_GLOB } from '@spinajs/reflection';
import { BaseController, CONTROLLED_DESCRIPTOR_SYMBOL } from '@spinajs/http';
import { SwaggerDocCache } from '../swagger-cache.js';

@Command('http:swagger:cache', 'generate swagger documentation cache from controller JSDoc comments')
export class SwaggerCacheCommand extends CliCommand {
  @Logger('http-swagger')
  protected Log!: Log;

  // @ListFromFiles installs a getter returning a Promise, so this must be
  // awaited before iterating — otherwise `for..of` over a Promise throws
  // "is not iterable" and the command always crashes.
  @ListFromFiles(SCAN_GLOB, 'system.dirs.controllers')
  protected Controllers!: Promise<Array<ClassInfo<BaseController>>>;

  public async execute(): Promise<void> {
    const effective = effectiveManifestOf(DI.RootContainer);
    if (effective?.manifest && effective.settings.mode !== 'off') {
      this.Log.warn('http:swagger:cache is deprecated: the manifest already carries controller documentation; this command is a no-op');
      return;
    }

    await DI.resolve(fsService);

    this.Log.info('Generating Swagger documentation cache...');
    const cache = await DI.resolve(SwaggerDocCache);

    const controllers = await this.Controllers;
    for (const controller of controllers) {
      // the scan lists every exported class, DTOs next to a controller included
      if (!(controller.type.prototype instanceof BaseController) && Reflect.getMetadata(CONTROLLED_DESCRIPTOR_SYMBOL, controller.type.prototype) === undefined) {
        continue;
      }

      this.Log.info({ controller: controller.name }, 'Processing controller: ${controller}');
      await cache.getCache(controller);
    }

    this.Log.info('Swagger cache generation complete.');
  }
}
