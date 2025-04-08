import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
//import { DefaultControllerCache } from '../cache.js';
import { DI } from '@spinajs/di';
import { fsService, fs } from '@spinajs/fs';

@Command('http:controllers:cache', 'generate controllers cache')
export class ControllersCacheCommand extends CliCommand {
  @Logger('http')
  protected Log: Log;

  public async execute(): Promise<void> {
    await DI.resolve(fsService);

    this.Log.info('Generating controllers cache ...');

    const fs = DI.resolve<fs>('__file_provider__', ['__fs_controller_cache__']);
    // TODO: fix this
  //  const cache = DI.resolve(DefaultControllerCache);
//    await cache.generate();
    this.Log.info('Controllers cache generated at path: ', fs.resolvePath(''));
  }
}
