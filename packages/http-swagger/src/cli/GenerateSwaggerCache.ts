import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { ClassInfo, DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { ListFromFiles } from '@spinajs/reflection';
import { BaseController } from '@spinajs/http';
import { SwaggerDocCache } from '../swagger-cache.js';

@Command('http:swagger:cache', 'generate swagger documentation cache from controller JSDoc comments')
export class SwaggerCacheCommand extends CliCommand {
  @Logger('http-swagger')
  protected Log!: Log;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  protected Controllers!: Array<ClassInfo<BaseController>>;

  public async execute(): Promise<void> {
    await DI.resolve(fsService);

    this.Log.info('Generating Swagger documentation cache...');
    const cache = await DI.resolve(SwaggerDocCache);

    for (const controller of this.Controllers) {
      this.Log.info(`Processing controller: ${controller.name}`);
      await cache.getCache(controller);
    }

    this.Log.info('Swagger cache generation complete.');
  }
}
