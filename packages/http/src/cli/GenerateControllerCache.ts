import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { ClassInfo, DI } from '@spinajs/di';
import { fsService } from '@spinajs/fs';
import { DefaultControllerCache } from '../cache.js';
import { ListFromFiles } from '@spinajs/reflection';
import { BaseController } from '../controllers.js';

@Command('http:controllers:cache', 'generate controllers cache')
export class ControllersCacheCommand extends CliCommand {
  @Logger('http')
  protected Log: Log;

  @ListFromFiles('/**/!(*.d).{ts,js}', 'system.dirs.controllers')
  protected Controllres: Array<ClassInfo<BaseController>>;

  public async execute(): Promise<void> {
    await DI.resolve(fsService);

    this.Log.info('Generating controllers cache ...');
    const cache = await DI.resolve(DefaultControllerCache);

    for (const f of this.Controllres) {
      await cache.getCache(f);
    }
  }
}
