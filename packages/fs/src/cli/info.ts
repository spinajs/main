import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _fs } from '../fp.js';
import { IOFail } from '@spinajs/exceptions';
import { ensureProviders } from './fs.js';

@Command('fs-info', 'Prints extended file information ( metadata, eg. image / video properties )')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to file ( relative to selected fs base dir )')
export class FsInfoCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      const provider = _fs(fsName)();

      if (!provider) {
        throw new IOFail(`Filesystem ${fsName} not found`);
      }

      const info = await provider.metadata(path);
      this.Log.info(`Info for ${path} ( fs: ${fsName} ):`);
      this.Log.info(JSON.stringify(info, null, 2));
    } catch (err) {
      this.Log.error(`Cannot read info for ${path} on ${fsName}: ${err.message}`);
    }
  }
}
