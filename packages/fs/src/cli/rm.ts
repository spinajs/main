import { CliCommand, Command, Argument } from '@spinajs/cli';
import { Logger, Log } from '@spinajs/log-common';
import { _rm } from '../fp.js';
import { ensureProviders } from './fs.js';

@Command('fs-rm', 'Deletes a file or directory ( recursively ) from a filesystem')
@Argument('fs', true, 'Name of filesystem to use')
@Argument('path', true, 'Path to remove ( relative to selected fs base dir )')
export class FsRmCommand extends CliCommand {
  @Logger('fs')
  protected Log: Log;

  public async execute(fsName: string, path: string): Promise<void> {
    await ensureProviders();

    try {
      await _rm(path, fsName);
      this.Log.success(`Removed ${path} from filesystem ${fsName}`);
    } catch (err) {
      this.Log.error(`Cannot remove ${path} from ${fsName}: ${err.message}`);
    }
  }
}
