import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _exists } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-exists', 'Checks whether a path exists in a filesystem')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to check ( relative to selected fs base dir )')
export class FsExistsCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      const exists = await _exists(path, fsName)();
      this.Log.info(`${path} ${exists ? 'exists' : 'does not exist'} ( fs: ${fsName} )`);
    } catch (err) {
      this.Log.error(`Cannot check ${path} on ${fsName}: ${err.message}`);
    }
  }
}
