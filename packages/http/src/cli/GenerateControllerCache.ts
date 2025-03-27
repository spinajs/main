import { CliCommand, Command } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { DefaultControllerCache } from '../cache.js';
import { Autoinject } from '@spinajs/di';
import { FileSystem, fs as fFs } from '@spinajs/fs';

@Command('http:controllers:cache', 'generate controllers cache')
export class ControllersCacheCommand extends CliCommand {
  @Logger('http')
  protected Log: Log;

  /**
   * File system for temporary files for storing controllers cache
   */
  @FileSystem('__fs_controller_cache__')
  protected CacheFS: fFs;

  @Autoinject()
  protected Cache: DefaultControllerCache;

  public async execute(): Promise<void> {
    this.Log.info('Generating controllers cache ...');
    await this.Cache.generate();
    this.Log.info('Controllers cache generated at path: ', this.CacheFS.resolvePath(''));
  }
}
